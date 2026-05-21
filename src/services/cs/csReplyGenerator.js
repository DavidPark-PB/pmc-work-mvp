/**
 * CSReplyGenerator — 상호 참조형 영어 답변 생성
 *
 * 사장님 spec (2026-05-21 워크스페이스 리팩토링):
 *   한국어 답변 지시문을 단독으로 영어 번역하지 말고, 반드시 고객 메시지 분석
 *   결과(csMessageAnalyzer)를 참조해서 영어 답변 생성.
 *
 * 입력:
 *   - analysis (csMessageAnalyzer 결과: original_message, translated_message_ko,
 *     customer_intent, risk_level, risk_tags, recommended_action,
 *     required_reply_points, forbidden_reply_points, staff_summary)
 *   - koreanDraft  - 사용자 한국어 답변 지시문
 *   - tone         - friendly|professional|firm (없으면 risk_level 따라 자동)
 *   - purpose      - customs_notice | request_tax_id | shipping_delay | stock_check |
 *                   reject_discount | refuse_transaction | b2b_quote | dispute_protection
 *
 * 출력:
 *   - reply_text (영어 답변)
 *   - safety_flags (생성된 답변에서 발견된 위험 패턴 — admit_fault, undefined_promise 등)
 *   - uncovered_policies (한국어 지시문이 정책 대응 누락된 경우 사전 경고용)
 *
 * 호출자 (라우트) 가 uncovered_policies 보고 사용자에게 확인 받아야 함.
 * (사장님 spec 4: "한국어 지시문이 고객 메시지 리스크를 충분히 방어하지 못하면 답변 생성 전에 경고")
 */
'use strict';

const riskPolicies = require('./csRiskPolicies');

const PROMPT_VERSION = 'cs-reply-gen-v1.0';
const DEFAULT_MODEL = process.env.CS_REPLY_DEFAULT_MODEL || 'claude-sonnet-4-6';
const MOCK_MODE = process.env.CS_REPLY_MOCK_MODE === 'true';
const MAX_OUTPUT_TOKENS = 1500;

const PURPOSES = {
  customs_notice:      { label: '통관/세관 안내',   defaultTone: 'professional' },
  request_tax_id:      { label: '세금번호 요청',    defaultTone: 'professional' },
  shipping_delay:      { label: '배송 지연 안내',   defaultTone: 'friendly' },
  stock_check:         { label: '재고 확인 답변',   defaultTone: 'friendly' },
  reject_discount:     { label: '할인 거절',        defaultTone: 'firm' },
  refuse_transaction:  { label: '거래 거절',        defaultTone: 'firm' },
  b2b_quote:           { label: 'B2B 견적 안내',    defaultTone: 'professional' },
  dispute_protection:  { label: '클레임/분쟁 방어', defaultTone: 'firm' },
};
const TONES = new Set(['friendly', 'professional', 'firm']);

class ProviderError extends Error { constructor(m){super(m);this.code='csReplyGen/provider_failed';} }
class ConfigError extends Error   { constructor(m){super(m);this.code='csReplyGen/config_error';} }
class ValidationError extends Error{constructor(m){super(m);this.code='csReplyGen/validation';} }

function _resolveTone(tone, purpose, riskLevel) {
  if (TONES.has(tone)) return tone;
  if (purpose && PURPOSES[purpose]?.defaultTone) return PURPOSES[purpose].defaultTone;
  // risk_level → tone fallback
  if (riskLevel === 'critical' || riskLevel === 'high') return 'firm';
  if (riskLevel === 'medium') return 'professional';
  return 'friendly';
}

function buildPrompt({ analysis, koreanDraft, tone, purpose }) {
  const purposeLabel = purpose && PURPOSES[purpose]?.label || '일반 답변';
  const requiredBullets = (analysis.required_reply_points || []).map(p => `  - ${p}`).join('\n') || '  (없음)';
  const forbiddenBullets = (analysis.forbidden_reply_points || []).map(p => `  - ${p}`).join('\n') || '  (없음)';
  const riskTagsStr = (analysis.risk_tags || []).join(', ') || '(없음)';

  return `You are PMC's senior CS writer. PMC is a Korean global e-commerce seller.
Your job: write a polished ENGLISH reply that strictly satisfies the analysis below,
using the Korean staff intent as the desired direction.

═══ CUSTOMER MESSAGE (original) ═══
${analysis.original_message}

═══ ANALYSIS (must be honored) ═══
- Customer intent: ${analysis.customer_intent}
- Risk level: ${analysis.risk_level}
- Risk tags: ${riskTagsStr}
- Recommended action: ${analysis.recommended_action}

═══ REQUIRED reply points (MUST be covered explicitly) ═══
${requiredBullets}

═══ FORBIDDEN reply points (MUST NOT appear) ═══
${forbiddenBullets}

═══ STAFF KOREAN INTENT (the human's draft direction) ═══
${koreanDraft || '(직원 한국어 지시 없음 — 분석 결과만 보고 표준 응대)'}

═══ TONE / PURPOSE ═══
- Tone: ${tone}   (friendly = warm, professional = neutral business, firm = polite but unyielding)
- Purpose: ${purposeLabel}

═══ RULES ═══
1. Output ONLY a JSON object with this exact shape:
   {
     "reply_text": "the English reply, ready to copy-paste",
     "safety_flags": ["flag_key", ...]
   }
2. reply_text rules:
   - English only, natural CS tone matching the requested 'tone'
   - DO NOT translate Korean intent literally — REWRITE in CS-appropriate English
   - Preserve any specific numbers, dates, order/tracking IDs, currency from the original or Korean intent
   - Each REQUIRED point must appear in some form (paraphrased OK)
   - NEVER include any FORBIDDEN content
   - If Korean intent contradicts a REQUIRED/FORBIDDEN, OVERRIDE the Korean intent silently
     (do not mention the override to the customer)
   - Length: 2-6 short paragraphs, no emojis unless Korean intent uses them
   - End with appropriate sign-off ("Best regards, PMC Team" or similar)
3. safety_flags values (mark each that applies to YOUR generated reply):
   - "missing_required"     — couldn't fully cover a REQUIRED point
   - "contradicts_korean"   — overrode Korean intent due to policy
   - "no_specific_action"   — reply is generic, lacks specific next step
   - "tone_mismatch"        — couldn't honor requested tone given constraints
   - empty array if all good

NO markdown. NO explanation outside JSON. Just the JSON object.`;
}

async function callAnthropic({ prompt, model }) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch (e) { throw new ConfigError('@anthropic-ai/sdk dependency 미설치'); }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ConfigError('ANTHROPIC_API_KEY 미설정');

  const client = new Anthropic({ apiKey });
  async function tryOnce() {
    return client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
  }
  let response;
  try { response = await tryOnce(); }
  catch (e) {
    if (e?.status >= 500) {
      try { response = await tryOnce(); } catch (e2) { throw new ProviderError('Anthropic 5xx retry 실패'); }
    } else { throw new ProviderError(`Anthropic ${e?.status || 'error'}`); }
  }
  const text = response?.content?.[0]?.text || '';
  if (!text.trim()) throw new ProviderError('Anthropic 빈 응답');
  return {
    text: text.trim(),
    inputTokens: response?.usage?.input_tokens || 0,
    outputTokens: response?.usage?.output_tokens || 0,
  };
}

function extractJson(text) {
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function _mockReply({ analysis, koreanDraft, tone, purpose }) {
  const intentNote = analysis.customer_intent || 'inquiry';
  const purposeLabel = (purpose && PURPOSES[purpose]?.label) || 'general';
  return {
    reply_text: `[MOCK ${tone} ${purposeLabel}]\n\nHello,\n\nThank you for your message regarding ${intentNote}.\n\n` +
      (analysis.required_reply_points || []).slice(0, 3).map((_, i) => `[Required point ${i + 1} covered here]`).join('\n') +
      `\n\nBest regards,\nPMC Team`,
    safety_flags: [],
  };
}

/**
 * 사전 가드 — 한국어 지시문이 분석의 required_reply_points / 정책 매칭을 충분히
 * 커버하는지 빠르게 검사. 결과는 라우트가 사용자에게 경고로 노출.
 *
 * @param {string} koreanDraft
 * @param {Object} analysis  - csMessageAnalyzer 결과 .analysis
 * @returns {Array<{tag, label, message}>}
 */
function preflightCheck(koreanDraft, analysis) {
  // 정책 매칭 다시 — analysis.risk_tags 와 별개로 원문에서 직접
  const detected = riskPolicies.detect(analysis.original_message || '');
  return riskPolicies.findUncoveredPolicies(koreanDraft, detected.matched);
}

/**
 * @param {Object} params
 * @param {Object} params.analysis     - csMessageAnalyzer 결과 .analysis (필수)
 * @param {string} params.koreanDraft  - 사용자 한국어 답변 지시문 (선택, 없어도 동작)
 * @param {string} [params.tone]       - friendly | professional | firm
 * @param {string} [params.purpose]    - 8개 enum 중 하나
 */
async function generateReply({ analysis, koreanDraft, tone, purpose } = {}) {
  if (!analysis || !analysis.original_message) {
    throw new ValidationError('analysis (csMessageAnalyzer 결과) 가 필요합니다');
  }
  if (purpose && !PURPOSES[purpose]) {
    throw new ValidationError(`알 수 없는 purpose: ${purpose}`);
  }
  const resolvedTone = _resolveTone(tone, purpose, analysis.risk_level);

  // 사전 가드 — uncovered_policies 도 반환 (라우트가 경고 표시)
  const uncoveredPolicies = preflightCheck(koreanDraft, analysis);

  if (MOCK_MODE || !process.env.ANTHROPIC_API_KEY) {
    const mock = _mockReply({ analysis, koreanDraft, tone: resolvedTone, purpose });
    return {
      ...mock,
      uncoveredPolicies,
      tone: resolvedTone,
      purpose: purpose || null,
      provider: 'mock', model: 'mock',
      inputTokens: 0, outputTokens: 0, costUsd: 0,
      mock: true, promptVersion: PROMPT_VERSION,
    };
  }

  const prompt = buildPrompt({ analysis, koreanDraft, tone: resolvedTone, purpose });
  const { text, inputTokens, outputTokens } = await callAnthropic({ prompt, model: DEFAULT_MODEL });

  let parsed;
  try { parsed = extractJson(text); }
  catch (e) { throw new ProviderError('AI 응답 JSON 파싱 실패: ' + e.message); }

  const PRICE_PER_MTOK_INPUT = 3.00;
  const PRICE_PER_MTOK_OUTPUT = 15.00;
  const costUsd = Math.round(
    ((inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT +
     (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT) * 10000
  ) / 10000;

  return {
    reply_text: parsed.reply_text || '',
    safety_flags: Array.isArray(parsed.safety_flags) ? parsed.safety_flags : [],
    uncoveredPolicies,
    tone: resolvedTone,
    purpose: purpose || null,
    provider: 'anthropic',
    model: DEFAULT_MODEL,
    inputTokens, outputTokens, costUsd,
    mock: false,
    promptVersion: PROMPT_VERSION,
  };
}

module.exports = {
  generateReply,
  preflightCheck,
  PURPOSES,
  TONES: [...TONES],
  ProviderError, ConfigError, ValidationError,
  PROMPT_VERSION,
};
