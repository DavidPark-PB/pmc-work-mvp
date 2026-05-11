/**
 * AIToneAdjuster — CS 답변 본문 톤 다듬기 (PR CS-G3-B)
 *
 * 사장님 spec:
 *   - 1차 mock — 인터페이스만 분리, 실제 호출은 환경변수 토글 시
 *   - aiDraftGenerator (PR R1) 패턴 차용:
 *     · Anthropic Claude (default: claude-sonnet-4-6)
 *     · CS_TONE_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정 시 mock 반환
 *     · cost cap (CS_TONE_DAILY_USD_CAP, default $3/day)
 *     · 5xx 1회 retry, 4xx 즉시 실패
 *   - 본 PR 의 1차 mock 동작:
 *     · 원본 텍스트 그대로 반환 + ai_tone_adjusted=true 만 set
 *     · cost_usd=0, ai_provider='mock'
 *     · 환경 변수로 실제 호출 토글 가능 (운영 적용 전 staging 안전 가드)
 *
 * 비용 통제:
 *   - cs_responses 테이블에 cost_usd 컬럼이 없어서, 본 1차 PR 은 daily cap query 생략.
 *     실제 호출 활성 시 컬럼 추가 + cap query 작성 필요 (후속 PR).
 *   - 1차 mock 모드는 비용 0 이라 cap 불필요.
 */
'use strict';

const PROMPT_VERSION = 'cs-tone-v1.0';
const DEFAULT_MODEL = process.env.CS_TONE_DEFAULT_MODEL || 'claude-sonnet-4-6';
const MOCK_MODE = process.env.CS_TONE_MOCK_MODE === 'true';
const MAX_OUTPUT_TOKENS = 1500;

class UsageCapError extends Error {
  constructor(message) { super(message); this.code = 'csTone/usage_cap_exceeded'; }
}
class ProviderError extends Error {
  constructor(message) { super(message); this.code = 'csTone/provider_failed'; }
}
class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'csTone/config_error'; }
}
class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'csTone/validation'; }
}

// 안전 prompt — 본문 의미 변경 X, 톤만 조정.
function buildPrompt(text, language) {
  const langLabel = ({ en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' })[language] || 'the original language';
  return `You are a customer service tone editor for PMC, a Korean global e-commerce seller.

Your job: take the draft response below and polish its tone to be:
- friendly but professional
- concise (do not pad with extra fluff)
- empathetic for complaints, warm for thanks, neutral for shipping/refund

DO NOT:
- change facts, prices, dates, order numbers, tracking numbers, or any specific values
- add new promises, discounts, or commitments not in the draft
- translate to a different language (keep ${langLabel})
- add greeting/sign-off if the draft already has them
- use emojis if the draft has none

Return ONLY the polished text, no explanations, no markdown, no quotes around the text.

Draft response:
"""
${String(text).slice(0, 3000)}
"""`;
}

/**
 * Anthropic Claude API 호출. 1차 PR 에서는 MOCK_MODE 또는 미설정 시 호출 안 함.
 * 실 호출 활성화 시 cs_responses.cost_usd 컬럼 + cap query 추가 필요.
 */
async function callAnthropic({ prompt, model }) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    throw new ConfigError('@anthropic-ai/sdk dependency 미설치');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ConfigError('ANTHROPIC_API_KEY 미설정');

  const client = new Anthropic({ apiKey });
  const messages = [{ role: 'user', content: prompt }];

  async function tryOnce() {
    return client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages,
    });
  }

  let response;
  try {
    response = await tryOnce();
  } catch (e) {
    if (e?.status >= 500) {
      try { response = await tryOnce(); }
      catch (e2) { throw new ProviderError(`Anthropic 5xx retry 실패`); }
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

/**
 * Mock fallback — 원본 그대로 반환 + flag 만 set.
 * 1차 PR 의 기본 동작.
 */
function mockAdjust(text) {
  return {
    text: String(text || ''),
    provider: 'mock',
    model: 'mock',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * @param {Object} params
 * @param {string} params.text       — 다듬을 본문
 * @param {string} [params.language] — en/ko/ja/zh — 언어 변경 금지 (prompt 강제)
 * @returns {Promise<{text, provider, model, inputTokens, outputTokens, costUsd, promptVersion, mock}>}
 */
async function adjustTone({ text, language } = {}) {
  if (!text || !String(text).trim()) {
    throw new ValidationError('다듬을 본문이 비어있습니다');
  }

  // MOCK_MODE 또는 ANTHROPIC_API_KEY 미설정 시 mock 반환 (안전 fallback)
  if (MOCK_MODE || !process.env.ANTHROPIC_API_KEY) {
    return { ...mockAdjust(text), mock: true };
  }

  // 실제 호출 (환경 변수 활성 + key 존재 시)
  const prompt = buildPrompt(text, language);
  const { text: polished, inputTokens, outputTokens } = await callAnthropic({
    prompt,
    model: DEFAULT_MODEL,
  });

  // cost 계산 (aiDraftGenerator 와 동일 단가 — claude-sonnet-4-6 기준)
  const PRICE_PER_MTOK_INPUT  = 3.00;
  const PRICE_PER_MTOK_OUTPUT = 15.00;
  const costUsd = Math.round(
    ((inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT +
     (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT) * 10000
  ) / 10000;

  return {
    text: polished,
    provider: 'anthropic',
    model: DEFAULT_MODEL,
    inputTokens,
    outputTokens,
    costUsd,
    promptVersion: PROMPT_VERSION,
    mock: false,
  };
}

module.exports = {
  adjustTone,
  UsageCapError, ProviderError, ConfigError, ValidationError,
  PROMPT_VERSION,
};
