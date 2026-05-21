/**
 * CSMessageAnalyzer — 고객 메시지 9-field 구조화 분석
 *
 * 사장님 spec (2026-05-21 워크스페이스 리팩토링):
 *   고객 메시지 입력 → AI 가 다음을 한 번에 분석
 *     1. original_message
 *     2. translated_message_ko    (영문이면 한국어로)
 *     3. customer_intent          (refund_request / shipping_inquiry / fraud_attempt / ...)
 *     4. risk_level               (critical | high | medium | low)
 *     5. risk_tags                (csRiskPolicies + AI 판단 추가)
 *     6. recommended_action       ("정중하지만 단호하게 ...")
 *     7. required_reply_points    답변에 반드시 포함할 내용
 *     8. forbidden_reply_points   답변에서 피할 내용
 *     9. staff_summary            직원 빠른 확인용 1~2문장
 *
 * 동작:
 *   - csRiskPolicies.detect() 로 7가지 정책 deterministic 1차 매칭
 *   - 그 결과를 Claude 프롬프트에 컨텍스트로 주입 → AI 가 정확히 채움
 *   - JSON 모드로 응답 강제, parse 실패 시 mock fallback
 *
 * 패턴은 aiToneAdjuster.js / koEnTranslator.js 와 동일
 *   · CS_ANALYZER_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정 시 mock
 *   · 5xx 1회 retry, 4xx 즉시 실패
 */
'use strict';

const riskPolicies = require('./csRiskPolicies');

const PROMPT_VERSION = 'cs-analyzer-v1.0';
const DEFAULT_MODEL = process.env.CS_ANALYZER_DEFAULT_MODEL || 'claude-sonnet-4-6';
const MOCK_MODE = process.env.CS_ANALYZER_MOCK_MODE === 'true';
const MAX_OUTPUT_TOKENS = 2500;

class ProviderError extends Error {
  constructor(message) { super(message); this.code = 'csAnalyzer/provider_failed'; }
}
class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'csAnalyzer/config_error'; }
}
class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'csAnalyzer/validation'; }
}

const RISK_LEVELS = new Set(['critical', 'high', 'medium', 'low']);

function buildPrompt(message, policyHits) {
  const policySection = policyHits.length > 0
    ? `사전 키워드 매칭으로 다음 정책이 감지됐습니다 — risk_tags 에 반드시 포함:
${policyHits.map(p => `  - ${p.tag} (${p.label}, ${p.severity}) — 매칭 키워드: ${p.matchedKeywords.join(', ')}`).join('\n')}`
    : '사전 키워드 매칭에서 감지된 정책 없음.';

  return `You are PMC's CS analyst. PMC is a Korean global e-commerce seller shipping internationally
(eBay, Shopify, Naver, Shopee, Alibaba, Coupang, Qoo10).

Analyze the customer message below and produce a strict JSON object with exactly these fields:

{
  "original_message": string,            // 원문 그대로
  "translated_message_ko": string,       // 한국어 번역 (이미 한국어면 동일하게)
  "customer_intent": string,             // 1~3 단어 영문 또는 한국어 (예: "refund_request" / "shipping_inquiry" / "fraud_attempt" / "pre_purchase_question" / "complaint" / "thank_you")
  "risk_level": "critical" | "high" | "medium" | "low",
  "risk_tags": string[],                 // 정책 태그 (아래 사전 매칭 + AI 판단 추가)
  "recommended_action": string,          // 1~2 문장 한국어. "정중하지만 단호하게 ..." 같이 톤+행동
  "required_reply_points": string[],     // 답변에 반드시 포함할 점 (한국어 bullet, 각 1줄)
  "forbidden_reply_points": string[],    // 답변에서 절대 피할 점 (한국어 bullet, 각 1줄)
  "staff_summary": string                // 1~2문장 한국어, 직원 빠른 확인용 ("~~한 상황. ~~~ 답변 권장")
}

규칙:
- JSON 외 텍스트 출력 금지 (no markdown, no explanation outside JSON)
- risk_level 은 위 4개 enum 만
- 사전 정책 매칭 결과는 risk_tags 에 그대로 포함 + AI 판단으로 추가 태그 가능
- required/forbidden 은 최소 1개 이상 (위험 없을 때도 일반 CS 매너 포함)
- 한국어 번역은 자연스러운 구어체, 의미 보존 우선

위험 정책 컨텍스트:
${policySection}

고객 메시지:
"""
${String(message).slice(0, 4000)}
"""

Return ONLY the JSON object.`;
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
      try { response = await tryOnce(); }
      catch (e2) { throw new ProviderError('Anthropic 5xx retry 실패'); }
    } else {
      throw new ProviderError(`Anthropic ${e?.status || 'error'}`);
    }
  }

  const text = response?.content?.[0]?.text || '';
  if (!text.trim()) throw new ProviderError('Anthropic 빈 응답');
  return {
    text: text.trim(),
    inputTokens: response?.usage?.input_tokens || 0,
    outputTokens: response?.usage?.output_tokens || 0,
  };
}

// JSON 추출 — Claude 가 가끔 코드펜스로 감싸기 때문
function extractJson(text) {
  // ```json ... ``` 제거
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 첫 { 부터 마지막 } 까지 추출 (안전)
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function _mockAnalyze(message, policyHits) {
  // mock — original 그대로, ko 는 prefix 만, risk 는 정책 매칭 기반
  const matched = policyHits.length > 0;
  const policyTags = policyHits.map(p => p.tag);
  const maxSev = policyHits.reduce((m, p) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    return (order[p.severity] || 0) > (order[m] || 0) ? p.severity : m;
  }, 'low');
  return {
    original_message: String(message),
    translated_message_ko: `[mock 번역] ${String(message).slice(0, 200)}`,
    customer_intent: matched ? 'risk_pattern_detected' : 'general_inquiry',
    risk_level: matched ? maxSev : 'low',
    risk_tags: policyTags,
    recommended_action: matched
      ? `${policyHits[0].label} 관련 정책에 따라 정중하지만 단호한 대응 필요`
      : '일반 CS 매너로 응대',
    required_reply_points: policyHits.length > 0
      ? riskPolicies.detect(message).forcePromptHints.required
      : ['인사 + 문의 인지 확인'],
    forbidden_reply_points: policyHits.length > 0
      ? riskPolicies.detect(message).forcePromptHints.forbidden
      : ['근거 없는 약속 금지'],
    staff_summary: matched
      ? `${policyHits.map(p => p.label).join(', ')} 관련 메시지. 정책 대응 필요.`
      : '일반 문의. 표준 응대.',
  };
}

/**
 * @param {Object} params
 * @param {string} params.message  - 고객 메시지 원문
 * @returns {Promise<{
 *   analysis: Object,
 *   policyHits: Array,
 *   provider: string,
 *   model: string,
 *   inputTokens: number,
 *   outputTokens: number,
 *   costUsd: number,
 *   mock: boolean,
 *   promptVersion: string
 * }>}
 */
async function analyze({ message } = {}) {
  if (!message || !String(message).trim()) {
    throw new ValidationError('메시지가 비어있습니다');
  }

  // 1) 사전 정책 매칭
  const policyDetect = riskPolicies.detect(message);
  const policyHits = policyDetect.matched;

  // 2) Mock 모드면 즉시 반환
  if (MOCK_MODE || !process.env.ANTHROPIC_API_KEY) {
    return {
      analysis: _mockAnalyze(message, policyHits),
      policyHits,
      provider: 'mock',
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      mock: true,
      promptVersion: PROMPT_VERSION,
    };
  }

  // 3) Claude 호출
  const prompt = buildPrompt(message, policyHits);
  const { text, inputTokens, outputTokens } = await callAnthropic({ prompt, model: DEFAULT_MODEL });

  let parsed;
  try { parsed = extractJson(text); }
  catch (e) {
    throw new ProviderError('AI 응답 JSON 파싱 실패: ' + e.message);
  }

  // 4) 응답 정합성 — 누락 필드 보정, enum 검증
  const safe = {
    original_message: parsed.original_message || String(message),
    translated_message_ko: parsed.translated_message_ko || '',
    customer_intent: parsed.customer_intent || 'unknown',
    risk_level: RISK_LEVELS.has(parsed.risk_level) ? parsed.risk_level : (policyDetect.maxSeverity || 'low'),
    risk_tags: Array.isArray(parsed.risk_tags) ? parsed.risk_tags : [],
    recommended_action: parsed.recommended_action || '표준 CS 응대',
    required_reply_points: Array.isArray(parsed.required_reply_points) ? parsed.required_reply_points : [],
    forbidden_reply_points: Array.isArray(parsed.forbidden_reply_points) ? parsed.forbidden_reply_points : [],
    staff_summary: parsed.staff_summary || '',
  };

  // 정책 매칭에서 감지된 태그는 누락 없이 보장
  for (const p of policyHits) {
    if (!safe.risk_tags.includes(p.tag)) safe.risk_tags.push(p.tag);
  }

  // 비용 계산 (sonnet-4-6 단가)
  const PRICE_PER_MTOK_INPUT = 3.00;
  const PRICE_PER_MTOK_OUTPUT = 15.00;
  const costUsd = Math.round(
    ((inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT +
     (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT) * 10000
  ) / 10000;

  return {
    analysis: safe,
    policyHits,
    provider: 'anthropic',
    model: DEFAULT_MODEL,
    inputTokens,
    outputTokens,
    costUsd,
    mock: false,
    promptVersion: PROMPT_VERSION,
  };
}

module.exports = {
  analyze,
  ProviderError, ConfigError, ValidationError,
  PROMPT_VERSION,
};
