/**
 * Main service 배송 견적 client (서버 전용)
 *
 * 계약 (main pmc-work-mvp src/web/routes/shippingInternal.js — raw quote, production b972e09):
 *
 *   POST {MAIN_SERVICE_URL}/api/internal/shipping/quote
 *   Authorization: Bearer {SHIPPING_QUOTE_INTERNAL_TOKEN}
 *   body: { destinationCountry, marketplace, provider, serviceCode, saleType,
 *           actualWeightKg, lengthCm, widthCm, heightCm }
 *   200 : { ok, mode: 'raw', quote: { ok, provider, serviceCode, destinationCountry, chargeableWeightKg,
 *           appliedWeightBracketKg, totalShippingCostKrw, rateVersionId, rateEffectiveFrom, euVatKrw, euHsFeeKrw, blockedReason? },
 *           blockedReason }
 *         ok === quote.ok — policy band / listing price / margin are not consulted.
 *   503 : INTERNAL_TOKEN_NOT_CONFIGURED / 401 : INVALID_INTERNAL_TOKEN / 500 : internal_quote_failed
 *
 * The shadow hook in services/pricing.ts uses /api/internal/shipping/listing-preview instead —
 * the two calls are independent (different flags, different endpoints).
 *
 * 적용무게 전달: 엔진에 청구중량 입력 필드가 없고 chargeable = MAX(actualWeightKg, LWH/divisor)를 직접 계산한다.
 * 사장님이 이미 MAX(실측, 부피)를 적용무게로 확정했으므로 actualWeightKg = 적용무게/1000, 치수 = 0 으로 보내
 * 엔진의 부피중량 재계산을 막는다 (volumetric = 0 → chargeable = 적용무게).
 *
 * raw 계약(mode 'raw', ok true, quote.ok true)이 아닌 응답은 모두 차단 (fallback 배송비 없음).
 *
 * 대량 견적 (693행 ≈ 56 key): main 단건 응답 1.3~1.9초 → timeout 8초, 동시 최대 5개 worker 큐.
 * 일시적 오류(timeout / network / HTTP 429·502·503·504)만 300 → 800 → 1500ms 간격으로 최대 3회 재시도.
 * HTTP 500 `internal_quote_failed`(main에서 catch된 예외 — 주로 DB 조회 오류)는 최대 1회만 재시도,
 * 그 밖의 500 응답은 재시도하지 않는다 (main의 validation/운임 오류는 HTTP 200 blockedReason으로 온다).
 * 401·토큰 미설정은 AUTH_ERROR, 운임/국가/중량/계약 오류는 재시도하지 않는다.
 *
 * 로그에는 토큰/가격을 남기지 않는다 (사유 코드만).
 */
import { SHIPPING_DESTINATION_COUNTRY, type ShippingPricingConfig, type ShippingProvider } from './shipping-config.js';
import type { ShippingQuoteOutcome } from '../services/shipping-pricing.js';

export const QUOTE_TIMEOUT_MS = 8000;
export const QUOTE_MAX_RETRIES = 3;
export const QUOTE_RETRY_DELAYS_MS = [300, 800, 1500] as const;
export const QUOTE_CONCURRENCY = 5;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface QuoteRequestInput {
  provider: ShippingProvider;
  serviceCode: string;
  chargeableWeightG: number;
}

export function quoteCacheKey(input: QuoteRequestInput): string {
  return `${input.provider}|${input.serviceCode}|${SHIPPING_DESTINATION_COUNTRY}|${input.chargeableWeightG}`;
}

/** 실제 계약 필드만 사용한 요청 본문 */
export function buildQuoteRequestBody(input: QuoteRequestInput) {
  return {
    destinationCountry: SHIPPING_DESTINATION_COUNTRY,
    marketplace: 'ebay',
    provider: input.provider,
    serviceCode: input.serviceCode,
    saleType: 'B2C',
    actualWeightKg: input.chargeableWeightG / 1000,
    lengthCm: 0,
    widthCm: 0,
    heightCm: 0,
  };
}

function blocked(reason: string, extra: { retries?: number; httpStatus?: number } = {}): ShippingQuoteOutcome {
  return {
    ok: false,
    blockedReason: reason,
    retries: extra.retries ? extra.retries : undefined,
    httpStatus: extra.httpStatus,
  };
}

/** 응답 본문 → 검증된 견적 결과 */
export function parseQuoteResponse(body: unknown, input: QuoteRequestInput): ShippingQuoteOutcome {
  if (!body || typeof body !== 'object') return blocked('QUOTE_INVALID_RESPONSE');
  const top = body as Record<string, any>;
  const quote = top.quote && typeof top.quote === 'object' ? (top.quote as Record<string, any>) : null;

  if (top.mode !== 'raw') return blocked('QUOTE_CONTRACT_MISMATCH');
  if (!quote) return blocked(String(top.blockedReason || top.error || 'QUOTE_INVALID_RESPONSE'));
  if (top.ok !== true || quote.ok !== true) {
    return blocked(String(quote.blockedReason || top.blockedReason || 'QUOTE_BLOCKED'));
  }

  const requestedKg = input.chargeableWeightG / 1000;
  if (quote.provider !== input.provider) return blocked('QUOTE_PROVIDER_MISMATCH');
  if (quote.serviceCode !== input.serviceCode) return blocked('QUOTE_SERVICE_MISMATCH');
  if (quote.destinationCountry !== SHIPPING_DESTINATION_COUNTRY) return blocked('QUOTE_COUNTRY_MISMATCH');

  const chargeableKg = Number(quote.chargeableWeightKg);
  const bracketKg = Number(quote.appliedWeightBracketKg);
  const shippingKrw = Number(quote.totalShippingCostKrw);
  if (!(Number.isFinite(chargeableKg) && chargeableKg >= requestedKg - 1e-9)) return blocked('QUOTE_WEIGHT_BELOW_CHARGEABLE');
  if (!(Number.isFinite(bracketKg) && bracketKg >= chargeableKg - 1e-9)) return blocked('QUOTE_BRACKET_BELOW_CHARGEABLE');
  if (!(Number.isFinite(shippingKrw) && Number.isInteger(shippingKrw) && shippingKrw > 0)) return blocked('QUOTE_AMOUNT_INVALID');
  if ((Number(quote.euVatKrw) || 0) !== 0 || (Number(quote.euHsFeeKrw) || 0) !== 0) return blocked('QUOTE_UNEXPECTED_EU_FEES');
  if (quote.rateVersionId === null || quote.rateVersionId === undefined) return blocked('QUOTE_RATE_VERSION_MISSING');

  return {
    ok: true,
    provider: input.provider,
    serviceCode: input.serviceCode,
    destinationCountry: SHIPPING_DESTINATION_COUNTRY,
    chargeableWeightG: input.chargeableWeightG,
    chargeableWeightKg: chargeableKg,
    bracketWeightKg: bracketKg,
    shippingKrw,
    rateVersionId: quote.rateVersionId,
    rateEffectiveFrom: quote.rateEffectiveFrom ?? null,
  };
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const INTERNAL_ERROR_RETRY_CODE = 'internal_quote_failed';
export const QUOTE_MAX_INTERNAL_ERROR_RETRIES = 1;
const AUTH_ERRORS = new Set(['INVALID_INTERNAL_TOKEN', 'INTERNAL_TOKEN_NOT_CONFIGURED', 'INTERNAL_TOKEN_TOO_SHORT']);

export interface QuoteRequestDeps {
  config: Pick<ShippingPricingConfig, 'mainServiceUrl' | 'internalToken'>;
  fetchImpl?: FetchLike;
  logger?: Pick<Console, 'warn'>;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** 요청 timeout 예약 — 반환 함수로 취소 (기본: setTimeout으로 controller.abort) */
  startTimeout?: (controller: AbortController, ms: number) => () => void;
  /** 재시도 직전 호출 (진행상태 표시용) */
  onRetry?: (retryNumber: number, reason: string) => void;
}

/**
 * 재시도 대기 · 요청 timeout 타이머 (기본값은 실제 시간).
 * 테스트는 이 객체를 교체해 실제 시간을 기다리지 않는다 — route 안에서 만들어지는 견적 job도 같은 기본값을 쓴다.
 */
export const quoteTimers = {
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  startTimeout: (controller: AbortController, ms: number): (() => void) => {
    const timer = setTimeout(() => controller.abort(), ms);
    return () => clearTimeout(timer);
  },
};

/** 단건 견적 — timeout 8초, 일시적 오류에 한해 최대 3회 재시도 */
export async function requestShippingQuote(input: QuoteRequestInput, deps: QuoteRequestDeps): Promise<ShippingQuoteOutcome> {
  const { mainServiceUrl, internalToken } = deps.config;
  if (!mainServiceUrl || !internalToken) return blocked('SHIPPING_QUOTE_NOT_CONFIGURED');
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const logger = deps.logger ?? console;
  const timeoutMs = deps.timeoutMs ?? QUOTE_TIMEOUT_MS;
  const delays = deps.retryDelaysMs ?? QUOTE_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? quoteTimers.sleep;
  const startTimeout = deps.startTimeout ?? quoteTimers.startTimeout;
  const url = `${mainServiceUrl.replace(/\/+$/, '')}/api/internal/shipping/quote`;
  const body = JSON.stringify(buildQuoteRequestBody(input));

  let internalErrorRetries = 0;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const cancelTimeout = startTimeout(controller, timeoutMs);
    let retryable = false;
    let reason = 'QUOTE_REQUEST_FAILED';
    let httpStatus: number | undefined;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        httpStatus = res.status;
        let errorCode: string | null = null;
        try {
          const errBody = JSON.parse(text);
          if (errBody && typeof errBody.error === 'string') errorCode = errBody.error;
        } catch { /* keep status reason */ }
        if (res.status === 401 || (errorCode !== null && AUTH_ERRORS.has(errorCode))) {
          reason = 'AUTH_ERROR';
        } else {
          retryable = RETRYABLE_STATUS.has(res.status)
            || (res.status === 500 && errorCode === INTERNAL_ERROR_RETRY_CODE && internalErrorRetries < QUOTE_MAX_INTERNAL_ERROR_RETRIES);
          if (res.status === 500 && retryable) internalErrorRetries++;
          reason = `QUOTE_HTTP_${res.status}`;
        }
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return blocked('QUOTE_INVALID_JSON', { retries: attempt });
        }
        const outcome = parseQuoteResponse(parsed, input);
        return attempt > 0 ? { ...outcome, retries: attempt } : outcome;
      }
    } catch (e) {
      retryable = true;
      reason = (e as Error).name === 'AbortError' ? 'QUOTE_TIMEOUT' : 'QUOTE_NETWORK_ERROR';
    } finally {
      cancelTimeout();
    }
    if (!retryable || attempt >= QUOTE_MAX_RETRIES) {
      logger.warn(`[shipping-quote] blocked: ${reason} (${input.provider}, retries ${attempt})`);
      return blocked(reason, { retries: attempt, httpStatus });
    }
    deps.onRetry?.(attempt + 1, reason);
    await sleep(delays[Math.min(attempt, delays.length - 1)]);
  }
}

export interface QuoteQueueProgress {
  /** 고유 견적 key 수 */
  total: number;
  done: number;
  ok: number;
  failed: number;
  /** 재시도가 한 번 이상 발생한 key 수 */
  retried: number;
}

/**
 * 여러 견적 요청 — provider+serviceCode+US+chargeableWeightG 키로 중복 제거 후 동시 최대 5개 worker 큐
 * (전체 요청을 한꺼번에 던지지 않는다). 반환: 키 → 결과
 */
export async function requestShippingQuotesDeduped(
  inputs: QuoteRequestInput[],
  deps: QuoteRequestDeps & { concurrency?: number; onProgress?: (progress: QuoteQueueProgress) => void },
): Promise<Map<string, ShippingQuoteOutcome>> {
  const unique = new Map<string, QuoteRequestInput>();
  for (const input of inputs) {
    const key = quoteCacheKey(input);
    if (!unique.has(key)) unique.set(key, input);
  }
  const entries = [...unique.entries()];
  const results = new Map<string, ShippingQuoteOutcome>();
  const progress: QuoteQueueProgress = { total: entries.length, done: 0, ok: 0, failed: 0, retried: 0 };
  const emit = () => deps.onProgress?.({ ...progress });
  const concurrency = Math.max(1, deps.concurrency ?? QUOTE_CONCURRENCY);
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [key, input] = entries[cursor++];
      let retriedThisKey = false;
      const outcome = await requestShippingQuote(input, {
        ...deps,
        onRetry: (n, reason) => {
          if (!retriedThisKey) { retriedThisKey = true; progress.retried++; emit(); }
          deps.onRetry?.(n, reason);
        },
      });
      results.set(key, outcome);
      progress.done++;
      if (outcome.ok) progress.ok++; else progress.failed++;
      emit();
    }
  };
  emit();
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}
