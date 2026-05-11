/**
 * retry — async function 재시도 helper (PR catalog-fix)
 *
 * 사장님 spec:
 *   - 실패 시 1초 후 재시도, 최대 3회
 *   - exponential backoff (1s, 2s, 4s) 옵션
 *   - 재시도 가능한 에러만 (4xx 는 즉시 실패, 5xx/network 만 재시도)
 */
'use strict';

function _isRetryable(err) {
  if (!err) return false;
  // axios / fetch network error
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  // googleapis: error.code 또는 error.response.status
  const status = err.response?.status || err.status || err.code;
  if (typeof status === 'number') {
    if (status >= 500 && status <= 599) return true;     // server error
    if (status === 429) return true;                      // rate limit — 재시도 권장
    return false;                                         // 4xx 등 → 즉시 실패
  }
  // 메시지 패턴 (googleapis 가 throw 하는 일반 Error)
  const msg = String(err.message || '');
  if (/timeout|timed out|ECONNRESET|socket hang up|rate limit|quota/i.test(msg)) return true;
  return false;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * @param {Function} fn — async () => result
 * @param {Object} [opts]
 * @param {number} [opts.maxAttempts=3]      — 1차 시도 포함 총 시도 횟수
 * @param {number} [opts.baseDelayMs=1000]   — 첫 재시도 대기 (사장님 spec: 1초)
 * @param {boolean} [opts.exponential=false] — true 면 1s/2s/4s, false 면 1s/1s
 * @returns Promise<result>
 */
async function withRetry(fn, opts = {}) {
  const maxAttempts = Math.max(1, opts.maxAttempts || 3);
  const baseDelay = opts.baseDelayMs ?? 1000;
  const exp = !!opts.exponential;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= maxAttempts || !_isRetryable(e)) throw e;
      const delay = exp ? baseDelay * Math.pow(2, attempt - 1) : baseDelay;
      await _sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
