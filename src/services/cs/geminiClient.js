/**
 * Gemini API 공통 호출 클라이언트 — CS AI 서비스 4개가 공유.
 *
 * 2026-08-08: Anthropic → Gemini 전환 (사장님 결정).
 *   기존 GEMINI_API_KEY 재활용 (legacy /api/cs/suggest 에서 사용 중이던 것).
 *
 * 특징:
 *   - 모델 fallback 리스트: 첫 모델이 429/404 반환 시 다음 모델 자동 시도
 *     (신규 API key 는 특정 모델 무료 티어 접근 못 하는 케이스 대응)
 *   - JSON 응답 강제 (expectJson=true 시)
 *   - 실 에러 메시지 그대로 throw (Anthropic 크레딧 사고 재발 방지)
 *   - usage tokens 지원
 *   - 5xx 는 1회 retry, 4xx (재시도 무의미) 는 즉시 fallback
 */
'use strict';

const axios = require('axios');

// 2026-08-08: 신규 API key 는 특정 모델 접근 못 하는 케이스 대응 fallback.
//   - 2.0-flash-lite: 2025 출시, 신규 무료 티어 폭넓게 지원 (일부 계정에서 유일하게 됨)
//   - 2.0-flash: 최신 안정, 대부분 계정 지원
//   - 2.5-flash-lite: 새로운 저가 모델
//   - flash-latest: alias (Google 이 최신으로 라우팅)
//   - 1.5-* 는 2026 년 v1beta 에서 완전 폐기됨 → 제거.
// CS_GEMINI_MODEL_FALLBACK env 로 override 가능 (콤마 구분).
const DEFAULT_MODELS = (process.env.CS_GEMINI_MODEL_FALLBACK ||
  'gemini-2.0-flash-lite,gemini-2.0-flash,gemini-2.5-flash-lite,gemini-flash-latest')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_MODEL = process.env.CS_GEMINI_DEFAULT_MODEL || DEFAULT_MODELS[0];

const API_URL_TPL = 'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent';

// 이 status 는 다음 모델로 자동 fallback (재시도 무의미):
//   404 = 모델 없음 · 429 = quota/rate · 400 = 모델 미지원 (특정 메시지)
const FALLBACK_STATUSES = new Set([400, 404, 429]);

class ProviderError extends Error {
  constructor(m, code) { super(m); this.code = code || 'gemini/provider_failed'; }
}
class ConfigError extends Error {
  constructor(m, code) { super(m); this.code = code || 'gemini/config_error'; }
}

async function _postOnce({ apiKey, model, payload }) {
  const url = API_URL_TPL.replace('{MODEL}', model);
  return axios.post(`${url}?key=${apiKey}`, payload, {
    timeout: 30000,
    validateStatus: () => true,
  });
}

/**
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.model]       - 명시하면 fallback 리스트 맨 앞에 삽입
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.expectJson] - true 시 responseMimeType='application/json'
 * @param {string} [opts.errCodePrefix]
 * @returns {Promise<{text, inputTokens, outputTokens, model}>}
 */
async function callGemini({ prompt, model, maxTokens = 2500, temperature = 0.2, expectJson = true, errCodePrefix = 'gemini' } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError('GEMINI_API_KEY 미설정', `${errCodePrefix}/config_error`);
  if (!prompt || !String(prompt).trim()) throw new ProviderError('빈 프롬프트', `${errCodePrefix}/validation`);

  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (expectJson) generationConfig.responseMimeType = 'application/json';
  const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig };

  // 시도 순서 = [명시 model] + DEFAULT_MODELS (중복 제거)
  const seen = new Set();
  const attempts = [];
  if (model) { attempts.push(model); seen.add(model); }
  for (const m of DEFAULT_MODELS) if (!seen.has(m)) { attempts.push(m); seen.add(m); }

  const failures = [];  // 각 모델별 실패 이유 (모두 실패 시 종합 리포트)

  for (const attemptModel of attempts) {
    let r = await _postOnce({ apiKey, model: attemptModel, payload });
    // 5xx 는 같은 모델에서 1회 retry
    if (r.status >= 500 && r.status < 600) {
      r = await _postOnce({ apiKey, model: attemptModel, payload });
    }

    if (r.status === 200) {
      const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text.trim()) {
        failures.push(`${attemptModel}: 빈 응답`);
        continue;  // 다음 모델 시도
      }
      const usage = r.data?.usageMetadata || {};
      return {
        text: text.trim(),
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        model: attemptModel,
      };
    }

    const detail = r.data?.error?.message || r.data?.error?.status || `HTTP ${r.status}`;
    failures.push(`${attemptModel} [${r.status}]: ${String(detail).slice(0, 200)}`);

    // fallback 대상이 아니면 즉시 실패 (401/403 등 credential 문제 → 재시도 무의미하지만 fallback 도 안 됨)
    if (!FALLBACK_STATUSES.has(r.status)) {
      throw new ProviderError(`Gemini ${r.status} — ${detail}`, `${errCodePrefix}/provider_failed`);
    }
    // 그 외 (400/404/429) 는 다음 모델로 자동 fallback
  }

  // 모든 모델 실패
  throw new ProviderError(
    `모든 Gemini 모델 실패. 시도: ${attempts.join(', ')} | ${failures.join(' || ')}`,
    `${errCodePrefix}/provider_failed`
  );
}

// gemini-2.0-flash / 1.5-flash 무료 티어 or 저가. 대략 추정.
function estimateCost(inputTokens, outputTokens) {
  const PRICE_PER_MTOK_INPUT  = 0.075;
  const PRICE_PER_MTOK_OUTPUT = 0.30;
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
  DEFAULT_MODELS,
};
