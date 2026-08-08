/**
 * Gemini API 공통 호출 클라이언트 — CS AI 서비스 4개 (analyzer / reply / tone / translator) 가 공유.
 *
 * 2026-08-08: Anthropic 크레딧 소진 대비 Gemini API 전환 (사장님 결정).
 *   기존 프로젝트에 GEMINI_API_KEY 이미 존재 (legacy /api/cs/suggest 에서 사용) — 재활용.
 *
 * 특징:
 *   - JSON 응답 강제 (responseMimeType: 'application/json') → 각 서비스의 extractJson 그대로 동작
 *   - 실 에러 메시지를 그대로 throw (Anthropic 크레딧 사고 재발 방지)
 *   - usage tokens 지원 (Gemini 는 candidatesTokenCount 필드)
 *   - 5xx 는 1회 retry, 4xx 는 즉시 실패
 */
'use strict';

const axios = require('axios');

const DEFAULT_MODEL = process.env.CS_GEMINI_DEFAULT_MODEL || 'gemini-2.5-flash';
const API_URL_TPL = 'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent';

class ProviderError extends Error {
  constructor(m, code) { super(m); this.code = code || 'gemini/provider_failed'; }
}
class ConfigError extends Error {
  constructor(m, code) { super(m); this.code = code || 'gemini/config_error'; }
}

/**
 * @param {Object} opts
 * @param {string} opts.prompt      - 프롬프트 전문 (JSON 강제 지시 포함해야 함)
 * @param {string} [opts.model]     - 기본: CS_GEMINI_DEFAULT_MODEL or 'gemini-2.5-flash'
 * @param {number} [opts.maxTokens] - 기본 2500
 * @param {number} [opts.temperature] - 기본 0.2
 * @param {string} [opts.errCodePrefix] - 각 서비스별 에러 code prefix (예: 'csAnalyzer')
 * @returns {Promise<{text, inputTokens, outputTokens, model}>}
 */
async function callGemini({ prompt, model = DEFAULT_MODEL, maxTokens = 2500, temperature = 0.2, expectJson = true, errCodePrefix = 'gemini' } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError('GEMINI_API_KEY 미설정', `${errCodePrefix}/config_error`);
  if (!prompt || !String(prompt).trim()) throw new ProviderError('빈 프롬프트', `${errCodePrefix}/validation`);

  const url = API_URL_TPL.replace('{MODEL}', model);
  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
  };
  if (expectJson) generationConfig.responseMimeType = 'application/json';
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
  };

  async function tryOnce() {
    return axios.post(`${url}?key=${apiKey}`, payload, {
      timeout: 30000,
      validateStatus: () => true,
    });
  }

  let r = await tryOnce();
  // 5xx retry 1회
  if (r.status >= 500 && r.status < 600) {
    r = await tryOnce();
  }
  if (r.status !== 200) {
    const detail = r.data?.error?.message || r.data?.error?.status || `HTTP ${r.status}`;
    throw new ProviderError(`Gemini ${r.status} — ${detail}`, `${errCodePrefix}/provider_failed`);
  }
  const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text.trim()) throw new ProviderError('Gemini 빈 응답', `${errCodePrefix}/provider_failed`);

  const usage = r.data?.usageMetadata || {};
  return {
    text: text.trim(),
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    model,
  };
}

// Gemini 2.5 Flash 단가 (2026 기준 추정) — Sonnet 대비 훨씬 저렴
function estimateCost(inputTokens, outputTokens) {
  const PRICE_PER_MTOK_INPUT  = 0.075;   // $0.075 / M input tokens
  const PRICE_PER_MTOK_OUTPUT = 0.30;    // $0.30 / M output tokens
  return Math.round(
    ((inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT +
     (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT) * 100000
  ) / 100000;
}

module.exports = {
  callGemini,
  estimateCost,
  ProviderError,
  ConfigError,
  DEFAULT_MODEL,
};
