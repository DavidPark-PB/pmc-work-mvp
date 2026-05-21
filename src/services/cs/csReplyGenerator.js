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

// ════════════════════════════════════════════════════════════════
// 선제 연락 (Outbound / Proactive) — 사장님 보강 요청 2026-05-21
// 고객이 메시지 안 보낸 상황에서도 PMC 가 먼저 영어 메시지 작성.
// (예: 품절 통보, 패키징 변경, 배송 지연, 통관 사전 안내, 세금번호 사전 요청 등)
// ════════════════════════════════════════════════════════════════

// 선제 연락 시나리오 종류 — UI 의 첫 번째 selectbox 옵션
const OUTBOUND_SITUATIONS = {
  out_of_stock:       { label: '품절 통보',         defaultTone: 'professional', defaultPurpose: 'shipping_delay' },
  packaging_change:   { label: '패키징 변경 안내',  defaultTone: 'friendly',     defaultPurpose: null },
  shipping_delay:     { label: '배송 지연 통보',    defaultTone: 'professional', defaultPurpose: 'shipping_delay' },
  customs_warning:    { label: '통관 사전 안내',    defaultTone: 'professional', defaultPurpose: 'customs_notice' },
  tax_id_request:     { label: '세금번호 사전 요청', defaultTone: 'professional', defaultPurpose: 'request_tax_id' },
  partial_shipment:   { label: '부분 발송 안내',    defaultTone: 'friendly',     defaultPurpose: null },
  price_change:       { label: '가격 변경 안내',    defaultTone: 'professional', defaultPurpose: null },
  cancellation:       { label: '주문 취소 요청',    defaultTone: 'professional', defaultPurpose: 'refuse_transaction' },
  b2b_proposal:       { label: 'B2B 제안·견적 발송', defaultTone: 'professional', defaultPurpose: 'b2b_quote' },
  general:            { label: '일반 안내',         defaultTone: 'friendly',     defaultPurpose: null },
};

function buildOutboundPrompt({ situationType, situationDetail, koreanIntent, tone, purpose }) {
  const sit = OUTBOUND_SITUATIONS[situationType] || OUTBOUND_SITUATIONS.general;
  const purposeLabel = purpose && PURPOSES[purpose]?.label || sit.label;

  return `You are PMC's senior CS writer. PMC is a Korean global e-commerce seller.
This is a PROACTIVE OUTBOUND message — the customer has NOT contacted us. PMC is initiating contact.

═══ SITUATION ═══
- Situation type: ${sit.label}
- Detail (Korean staff notes): ${situationDetail || '(상세 정보 없음)'}

═══ STAFF KOREAN INTENT ═══
${koreanIntent || '(직원 한국어 지시 없음 — situation type 기반 표준 안내)'}

═══ TONE / PURPOSE ═══
- Tone: ${tone}   (friendly = warm, professional = neutral business, firm = polite but unyielding)
- Purpose: ${purposeLabel}

═══ RULES ═══
1. Output ONLY a JSON object with this exact shape:
   {
     "reply_text": "the English outbound message, ready to copy-paste",
     "safety_flags": ["flag_key", ...],
     "anticipated_customer_concerns": ["concern1", ...],
     "suggested_followups": ["followup1", ...]
   }
2. reply_text rules:
   - English only, natural CS tone matching the requested 'tone'
   - OPEN with brief context (why PMC is reaching out)
   - Be honest and clear about the issue — don't be vague or evasive
   - Give the customer 1-2 clear OPTIONS where possible (continue / refund / switch / wait)
   - For 품절/지연: include realistic timeline if known, otherwise apologize and offer alternatives
   - For 패키징 변경: emphasize product content is identical
   - For 통관/세금번호 안내: clear what customer must provide, why, and consequence of not providing
   - Preserve any specific numbers, dates, order/tracking IDs from the staff intent or situation detail
   - DO NOT promise things PMC can't control (carrier ETAs as facts, free shipping unless stated, etc.)
   - Length: 2-5 short paragraphs, no emojis unless Korean intent uses them
   - End with appropriate sign-off ("Best regards, PMC Team")
3. safety_flags values for OUTBOUND messages:
   - "missing_timeline"       — situation needs date but staff didn't provide
   - "missing_alternative"    — issue needs options offered but only describes problem
   - "overpromise_risk"       — staff intent contained promise PMC might not deliver
   - "tone_too_apologetic"    — excessive sorry can sound like fault admission
   - "missing_action_request" — customer needs to do something but message doesn't say what
   - empty array if all good
4. anticipated_customer_concerns: 1-3 short Korean phrases describing what the customer
   might worry about or push back on after reading this message. (직원이 미리 대비할 수 있게)
5. suggested_followups: 1-3 short Korean phrases of follow-up actions the customer might
   take (예: '환불 요구', '다른 상품 추천 요청', '클레임 가능성').

NO markdown. NO explanation outside JSON. Just the JSON object.`;
}

function _mockOutbound({ situationType, situationDetail, koreanIntent, tone, purpose }) {
  const sit = OUTBOUND_SITUATIONS[situationType] || OUTBOUND_SITUATIONS.general;
  return {
    reply_text: `[MOCK ${tone} outbound - ${sit.label}]\n\nDear customer,\n\nWe are reaching out regarding ${sit.label}.\n\n${koreanIntent ? '[Staff intent reflected here]' : '[Standard ' + sit.label + ' notice here]'}\n\n${situationDetail ? '[Situation detail incorporated]' : ''}\n\nPlease let us know how you would like to proceed.\n\nBest regards,\nPMC Team`,
    safety_flags: [],
    anticipated_customer_concerns: ['환불 요구 가능성', '대체 상품 문의 가능성'],
    suggested_followups: ['상황 확인 메시지', '환불/대체 선택 답변 대기'],
  };
}

/**
 * 선제 연락 영어 메시지 생성.
 * 분석(analysis) 불필요 — situation + koreanIntent + tone + purpose 만으로 작성.
 *
 * @param {Object} params
 * @param {string} params.situationType    - OUTBOUND_SITUATIONS 의 key (필수)
 * @param {string} [params.situationDetail] - 한국어 상세 (상품명, 주문번호, 날짜 등)
 * @param {string} [params.koreanIntent]   - 직원 한국어 지시문
 * @param {string} [params.tone]
 * @param {string} [params.purpose]
 */
async function generateOutbound({ situationType, situationDetail, koreanIntent, tone, purpose } = {}) {
  if (!situationType || !OUTBOUND_SITUATIONS[situationType]) {
    throw new ValidationError(`situationType 필수 (${Object.keys(OUTBOUND_SITUATIONS).join('|')})`);
  }
  if (purpose && !PURPOSES[purpose]) {
    throw new ValidationError(`알 수 없는 purpose: ${purpose}`);
  }
  const sit = OUTBOUND_SITUATIONS[situationType];
  // tone 결정 — explicit > situation default
  const resolvedTone = TONES.has(tone) ? tone : sit.defaultTone;
  // purpose 결정 — explicit > situation default > null
  const resolvedPurpose = purpose || sit.defaultPurpose || null;

  if (MOCK_MODE || !process.env.ANTHROPIC_API_KEY) {
    const mock = _mockOutbound({ situationType, situationDetail, koreanIntent, tone: resolvedTone, purpose: resolvedPurpose });
    return {
      ...mock,
      situationType,
      tone: resolvedTone,
      purpose: resolvedPurpose,
      provider: 'mock', model: 'mock',
      inputTokens: 0, outputTokens: 0, costUsd: 0,
      mock: true, promptVersion: PROMPT_VERSION,
    };
  }

  const prompt = buildOutboundPrompt({ situationType, situationDetail, koreanIntent, tone: resolvedTone, purpose: resolvedPurpose });
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
    anticipated_customer_concerns: Array.isArray(parsed.anticipated_customer_concerns) ? parsed.anticipated_customer_concerns : [],
    suggested_followups: Array.isArray(parsed.suggested_followups) ? parsed.suggested_followups : [],
    situationType,
    tone: resolvedTone,
    purpose: resolvedPurpose,
    provider: 'anthropic',
    model: DEFAULT_MODEL,
    inputTokens, outputTokens, costUsd,
    mock: false,
    promptVersion: PROMPT_VERSION,
  };
}

module.exports = {
  generateReply,
  generateOutbound,
  preflightCheck,
  PURPOSES,
  OUTBOUND_SITUATIONS,
  TONES: [...TONES],
  ProviderError, ConfigError, ValidationError,
  PROMPT_VERSION,
};
