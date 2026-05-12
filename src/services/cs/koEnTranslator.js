/**
 * KoEnTranslator — CS 답변 본문 한국어→영어 번역
 *
 * 직원이 한글로 메시지 초안을 쓰면 한 번 클릭으로 영어 CS 답변으로 변환.
 * 외부 ChatGPT 우회 사용을 대체.
 *
 * aiToneAdjuster.js 구조 그대로 차용:
 *   · Anthropic Claude (claude-sonnet-4-6)
 *   · CS_TRANSLATE_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정 시 mock
 *   · 5xx 1회 retry, 4xx 즉시 실패
 *   · 비용 계산 (sonnet-4-6 단가)
 */
'use strict';

const PROMPT_VERSION = 'cs-koen-v1.0';
const DEFAULT_MODEL = process.env.CS_TRANSLATE_DEFAULT_MODEL || 'claude-sonnet-4-6';
const MOCK_MODE = process.env.CS_TRANSLATE_MOCK_MODE === 'true';
const MAX_OUTPUT_TOKENS = 1500;

class ProviderError extends Error {
  constructor(message) { super(message); this.code = 'csTranslate/provider_failed'; }
}
class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'csTranslate/config_error'; }
}
class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'csTranslate/validation'; }
}

// 번역 prompt — 의미 보존 + B2B/이커머스 CS 톤 + 숫자/주문번호 그대로.
function buildPrompt(text, targetLang) {
  const target = targetLang === 'ko' ? 'Korean' : 'English';
  const sourceHint = targetLang === 'ko' ? 'English' : 'Korean';
  return `You are a customer service translator for PMC, a Korean global e-commerce seller.

Translate the message below from ${sourceHint} to ${target}, optimized for buyer-facing CS replies.

REQUIREMENTS:
- Preserve all numbers, order numbers, tracking numbers, prices, dates, SKUs, URLs, and proper nouns EXACTLY.
- Match natural ${target} business CS register: friendly but professional, concise, no fluff.
- Empathetic for complaints, warm for thanks, neutral for shipping/refund.
- Do NOT add new promises, discounts, apologies, or commitments not in the source.
- Do NOT add greeting/sign-off if the source has none.
- Do NOT add emojis if the source has none.
- If the source is already in ${target}, return it lightly polished (do not over-edit).

Return ONLY the translated text. No explanations, no markdown, no quotes around the text.

Source:
"""
${String(text).slice(0, 3000)}
"""`;
}

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

function mockTranslate(text, targetLang) {
  const prefix = targetLang === 'ko' ? '[KO mock] ' : '[EN mock] ';
  return {
    text: prefix + String(text || ''),
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
 * @param {string} params.text         — 원문
 * @param {string} [params.targetLang] — 'en' (default) | 'ko' — 도착 언어
 * @returns {Promise<{text, provider, model, inputTokens, outputTokens, costUsd, promptVersion, mock}>}
 */
async function translate({ text, targetLang = 'en' } = {}) {
  if (!text || !String(text).trim()) {
    throw new ValidationError('번역할 본문이 비어있습니다');
  }
  if (!['en', 'ko'].includes(targetLang)) {
    throw new ValidationError(`지원하지 않는 도착 언어: ${targetLang}`);
  }

  if (MOCK_MODE || !process.env.ANTHROPIC_API_KEY) {
    return { ...mockTranslate(text, targetLang), mock: true };
  }

  const prompt = buildPrompt(text, targetLang);
  const { text: out, inputTokens, outputTokens } = await callAnthropic({
    prompt,
    model: DEFAULT_MODEL,
  });

  // claude-sonnet-4-6 단가 (aiToneAdjuster 와 동일)
  const PRICE_PER_MTOK_INPUT  = 3.00;
  const PRICE_PER_MTOK_OUTPUT = 15.00;
  const costUsd = Math.round(
    ((inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT +
     (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT) * 10000
  ) / 10000;

  return {
    text: out,
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
  translate,
  ProviderError, ConfigError, ValidationError,
  PROMPT_VERSION,
};
