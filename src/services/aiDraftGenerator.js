/**
 * src/services/aiDraftGenerator.js — AI Draft Generator (PR R1)
 *
 * 역할:
 *   opportunity_inbox 1건 + (platform, language) → AI 가 title/description/hashtags
 *   를 JSON 으로 생성. 결과를 opportunity_drafts 1행으로 저장.
 *
 * Provider:
 *   - Anthropic Claude (default: claude-sonnet-4-6)
 *   - AI_DRAFT_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정 시 mock placeholder 반환
 *     (운영 적용 전 staging / dependency 미설치 환경 안전 가드)
 *
 * 비용 통제:
 *   - AI_DRAFT_DAILY_USD_CAP (default $5/day) — 오늘 누적 cost 가 cap 초과 시
 *     UsageCapError throw → 라우트가 429 응답
 *   - 호출 직전 daily 누적 query (opportunity_drafts.cost_usd)
 *
 * Safety Foundation 통합:
 *   - safetyExec.runAction({ actionName: 'ai_draft_generate', ... }) → audit row
 *   - 실 AI 호출 후 updateRun(succeeded/failed)
 *   - 모든 AI 호출이 📜 실행 로그에서 추적 가능
 *
 * 안전 정책:
 *   - API key / response token / raw response 절대 응답/로그 출력 X
 *   - prompt 의 안전 구문 (가격/성능 보장 금지, 저작권 금지) 강제
 *   - 외부 API 5xx 시 1회 retry. 4xx 즉시 실패.
 *   - mock mode 응답은 cost_usd=0 + ai_provider='mock' + ai_model='mock' 명시
 */
'use strict';

const { getClient } = require('../db/supabaseClient');
const safetyExec = require('./safetyExec');

const PROMPT_VERSION = 'v1.0';
const DEFAULT_MODEL = process.env.AI_DRAFT_DEFAULT_MODEL || 'claude-sonnet-4-6';
const DAILY_USD_CAP = parseFloat(process.env.AI_DRAFT_DAILY_USD_CAP || '5.00');
const MOCK_MODE = process.env.AI_DRAFT_MOCK_MODE === 'true';
const MAX_OUTPUT_TOKENS = 1000;

// Anthropic price (claude-sonnet-4-6 기준 — 2026-05 시점 추정).
// 운영에서 변하면 본 상수만 갱신.
const PRICE_PER_MTOK_INPUT  = 3.00;   // $3 per 1M input tokens
const PRICE_PER_MTOK_OUTPUT = 15.00;  // $15 per 1M output tokens

class UsageCapError extends Error {
  constructor(message) { super(message); this.code = 'aiDraft/usage_cap_exceeded'; }
}
class ProviderError extends Error {
  constructor(message) { super(message); this.code = 'aiDraft/provider_failed'; }
}
class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'aiDraft/config_error'; }
}
class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'aiDraft/validation'; }
}

// ──────────────────────────────────────────────────────────────────────────
// 내부 helpers
// ──────────────────────────────────────────────────────────────────────────

function calcCostUsd(inputTokens, outputTokens) {
  const inCost  = (inputTokens  / 1_000_000) * PRICE_PER_MTOK_INPUT;
  const outCost = (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT;
  return Math.round((inCost + outCost) * 10000) / 10000;  // 4자리
}

async function getDailyUsageUsd(supabase) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
  const { data, error } = await supabase
    .from('opportunity_drafts')
    .select('cost_usd')
    .gte('generated_at', todayStart)
    .neq('ai_provider', 'mock')
    .limit(1000);
  if (error) throw error;
  return (data || []).reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
}

// platform 별 prompt template
const PLATFORM_HINTS = {
  ebay:             '영문 eBay listing 형식. 정확한 spec / condition / HS code 강조. 280자 이내 title.',
  shopify:          'Shopify 상품 description HTML. 제품 특징 + 사용 시나리오 3~5문장.',
  qoo10:            'Qoo10 일본어 listing 형식. 일본 검색 키워드 자연 포함. 80자 이내 title.',
  shopee:           'Shopee 동남아 영문 listing. 가격 매력 + 무료배송 강조. 100자 이내.',
  alibaba:          'Alibaba B2B 영문 description. MOQ / lead time / certification 가능 명시.',
  naver_smartstore: '네이버 스마트스토어 한국어. 검색 키워드 자연 포함. SEO 친화. 50자 이내 title.',
  coupang:          '쿠팡 한국어. 빠른 배송 강조. 30자 이내 title.',
  x:                'X (Twitter) 280자 한 줄 카피. 후크 + URL 위치.',
  instagram:        'Instagram caption 200자 + hashtag 5~10개.',
  tiktok:           'TikTok 15초 후크 + caption 100자 + hashtag.',
  youtube_shorts:   'YouTube Shorts title 100자 + description 200자.',
  xiaohongshu:      '小红书 중국어 caption + hashtag. 200자.',
  wechat:           '微信 정장 톤 description. 300자.',
  discord:          'Discord 커뮤니티 안내 톤. 200자.',
  naver_blog:       '네이버 블로그 친근 톤. 도입 + 본문 + CTA. 500자.',
};

function buildPrompt({ opportunity, platform, language }) {
  const platformHint = PLATFORM_HINTS[platform] || '일반 마켓 listing 형식.';
  const sourceTitle = opportunity.title_ko || opportunity.title || opportunity.title_en || '';
  const brand = opportunity.brand || '';
  const category = opportunity.category || '';
  const sellUsd = opportunity.expected_sell_price_usd ?? null;
  const sellKrw = opportunity.expected_sell_price_krw ?? null;
  const notes = opportunity.notes || '';

  return `You are a marketplace listing copywriter for a Korean cross-border seller.
Generate listing copy in language: "${language}".
Target platform: "${platform}". ${platformHint}

INPUT:
- Source title (Korean reference): ${sourceTitle}
- Brand: ${brand}
- Category: ${category}
- Expected sell price USD: ${sellUsd ?? 'N/A'}
- Expected sell price KRW: ${sellKrw ?? 'N/A'}
- Operator notes: ${notes}

SAFETY RULES:
- Do NOT make pricing/performance guarantees.
- Do NOT mention competitors by name.
- Do NOT use copyrighted brand slogans verbatim.
- Stay within platform character limits.

OUTPUT (return JSON only, no other text):
{
  "title": "<title in language ${language}, within platform limits>",
  "description": "<description suitable for ${platform}>",
  "hashtags": ["<tag1>", "<tag2>", ...]
}`;
}

// mock placeholder — 외부 API 호출 0
function mockGenerate({ platform, language }) {
  return {
    title:       `[MOCK ${platform} ${language}] Title placeholder`,
    description: `[MOCK ${platform}] Description placeholder. AI_DRAFT_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정.`,
    hashtags:    ['mock', platform, language],
    inputTokens: 0,
    outputTokens: 0,
    aiProvider:  'mock',
    aiModel:     'mock',
  };
}

async function callAnthropic({ prompt, model }) {
  // dependency 동적 require — package 미설치 시 명확한 에러
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    throw new ConfigError('@anthropic-ai/sdk dependency 미설치 — npm install @anthropic-ai/sdk 필요');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError('ANTHROPIC_API_KEY 미설정 — config/.env 확인');
  }

  const client = new Anthropic({ apiKey });
  const tryOnce = async () => client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  let response;
  try {
    response = await tryOnce();
  } catch (e) {
    // 5xx 만 1회 retry. 4xx (rate limit / invalid request) 즉시 실패.
    if (e?.status >= 500) {
      try { response = await tryOnce(); }
      catch (e2) { throw new ProviderError(`Anthropic 5xx retry 실패: ${e2.message}`); }
    } else {
      throw new ProviderError(`Anthropic ${e?.status || ''}: ${e.message}`);
    }
  }

  const text = response?.content?.[0]?.text || '';
  let parsed;
  try {
    // JSON 추출 (model 이 ```json ... ``` 으로 감쌀 수도)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON object not found in response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new ProviderError(`Anthropic JSON 파싱 실패: ${e.message}`);
  }

  return {
    title:       String(parsed.title || ''),
    description: String(parsed.description || ''),
    hashtags:    Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String) : [],
    inputTokens:  response?.usage?.input_tokens  || 0,
    outputTokens: response?.usage?.output_tokens || 0,
    aiProvider:  'anthropic',
    aiModel:     model,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Draft 1건 생성 + DB 저장 + Safety audit chain.
 *
 * @param {Object} opts
 * @param {Object} opts.user       req.user (admin only — route 단 가드)
 * @param {number} opts.opportunityId
 * @param {string} opts.platform   PLATFORMS allowlist 외는 검증 fail
 * @param {string} opts.language   'ko' | 'en' | 'ja' | 'zh'
 * @returns {Promise<{ draft, costUsd, mock }>}
 */
async function generateDraft({ user, opportunityId, platform, language }) {
  if (!user || !Number.isFinite(user.id)) {
    throw new ValidationError('인증된 사용자가 아닙니다');
  }
  if (!Number.isFinite(opportunityId)) {
    throw new ValidationError('opportunityId 필수');
  }
  if (!platform) throw new ValidationError('platform 필수');
  if (!language || !['ko','en','ja','zh'].includes(language)) {
    throw new ValidationError(`language 부적합: ${language} (허용: ko/en/ja/zh)`);
  }

  const supabase = getClient();

  // opportunity 존재 확인
  const { data: opp, error: oppErr } = await supabase
    .from('opportunity_inbox').select('*').eq('id', opportunityId).maybeSingle();
  if (oppErr) throw oppErr;
  if (!opp) throw new ValidationError(`opportunity id=${opportunityId} 가 존재하지 않습니다`);

  // daily cap 검증 (mock 제외)
  if (!MOCK_MODE) {
    const dailyUsed = await getDailyUsageUsd(supabase);
    if (dailyUsed >= DAILY_USD_CAP) {
      throw new UsageCapError(`오늘의 AI 호출 한도 초과 (used $${dailyUsed.toFixed(4)} / cap $${DAILY_USD_CAP.toFixed(2)})`);
    }
  }

  const model = DEFAULT_MODEL;
  const useMock = MOCK_MODE || !process.env.ANTHROPIC_API_KEY;

  // Safety Foundation audit — pre-action (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'ai_draft_generate',
      executedBy:       user.id,
      isLegacyExecutor: user.isLegacy === true,
      targetTable:      'opportunity_drafts',
      targetId:         null,  // post 에 채움
      beforeSnapshot: {
        opportunity_id: opportunityId,
        platform, language, ai_model: model,
        mode: useMock ? 'mock' : 'live',
      },
      rollbackMethod: 'manual',
      rollbackHint:
        'DELETE FROM opportunity_drafts WHERE id=<target_id>; -- AI 콘텐츠 자체는 외부 publishing 안 됐으면 단순 삭제 안전.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[aiDraft] runAction failed:', {
      actionName: 'ai_draft_generate',
      executedBy: user.id,
      message: auditErr.message,
    });
    throw new Error('audit 시스템 일시 장애 — 잠시 후 재시도');
  }

  try {
    // AI 호출 (live 또는 mock)
    const prompt = buildPrompt({ opportunity: opp, platform, language });
    const aiResult = useMock
      ? mockGenerate({ platform, language })
      : await callAnthropic({ prompt, model });

    const cost = useMock ? 0 : calcCostUsd(aiResult.inputTokens, aiResult.outputTokens);

    // DB insert
    const draftRow = {
      opportunity_id: opportunityId,
      platform,
      language,
      title:         aiResult.title,
      description:   aiResult.description,
      hashtags:      aiResult.hashtags,
      prompt_version: PROMPT_VERSION,
      ai_provider:   aiResult.aiProvider,
      ai_model:      aiResult.aiModel,
      input_tokens:  aiResult.inputTokens,
      output_tokens: aiResult.outputTokens,
      cost_usd:      cost,
      generated_by:  user.id,
      status:        'generated',
    };

    const { data: draft, error: insErr } = await supabase
      .from('opportunity_drafts').insert(draftRow).select().single();
    if (insErr) throw insErr;

    // Safety audit — post (best-effort)
    safetyExec.updateRun(run.id, {
      status: 'succeeded',
      targetId: draft.id,
      afterSnapshot: {
        draft_id: draft.id,
        platform, language,
        input_tokens: draft.input_tokens,
        output_tokens: draft.output_tokens,
        cost_usd: draft.cost_usd,
        ai_provider: draft.ai_provider,
      },
    });

    return { draft, costUsd: cost, mock: useMock };
  } catch (e) {
    // post-audit best-effort
    safetyExec.updateRun(run.id, {
      status: 'failed',
      errorCode: e.code || 'unknown',
      errorMessage: e.message,
    });
    throw e;
  }
}

/**
 * opportunity_id 의 모든 draft 조회.
 */
async function listDrafts({ user, opportunityId }) {
  if (!user || !Number.isFinite(user.id)) {
    throw new ValidationError('인증된 사용자가 아닙니다');
  }
  if (!Number.isFinite(opportunityId)) {
    throw new ValidationError('opportunityId 필수');
  }
  const supabase = getClient();
  const { data, error } = await supabase
    .from('opportunity_drafts')
    .select('*')
    .eq('opportunity_id', opportunityId)
    .order('id', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * draft 단건 조회.
 */
async function getDraft({ user, id }) {
  if (!user || !Number.isFinite(user.id)) throw new ValidationError('인증된 사용자가 아닙니다');
  if (!Number.isFinite(id)) throw new ValidationError('invalid id');
  const supabase = getClient();
  const { data, error } = await supabase.from('opportunity_drafts').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError(`draft id=${id} not found`);
  return data;
}

/**
 * draft approve (admin only — route 가드).
 */
async function approveDraft({ user, id }) {
  if (!Number.isFinite(id)) throw new ValidationError('invalid id');
  const supabase = getClient();
  const { data, error } = await supabase
    .from('opportunity_drafts')
    .update({
      status: 'approved',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError(`draft id=${id} not found`);
  return data;
}

module.exports = {
  generateDraft,
  listDrafts,
  getDraft,
  approveDraft,
  // 상수
  PROMPT_VERSION, DEFAULT_MODEL, DAILY_USD_CAP, MOCK_MODE,
  // 에러
  UsageCapError, ProviderError, ConfigError, ValidationError,
};
