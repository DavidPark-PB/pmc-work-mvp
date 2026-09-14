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
 * 로그에는 토큰/가격을 남기지 않는다 (사유 코드만).
 */
import { SHIPPING_DESTINATION_COUNTRY, type ShippingPricingConfig, type ShippingProvider } from './shipping-config.js';
import type { ShippingQuoteOutcome } from '../services/shipping-pricing.js';

export const QUOTE_TIMEOUT_MS = 2000;
export const QUOTE_MAX_RETRIES = 1;

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

function blocked(reason: string): ShippingQuoteOutcome {
  return { ok: false, blockedReason: reason };
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

const RETRYABLE_STATUS = new Set([500, 502, 504]);

/** 단건 견적 — timeout 2초, 네트워크/timeout/5xx에 한해 최대 1회 재시도 */
export async function requestShippingQuote(
  input: QuoteRequestInput,
  deps: { config: Pick<ShippingPricingConfig, 'mainServiceUrl' | 'internalToken'>; fetchImpl?: FetchLike; logger?: Pick<Console, 'warn'> },
): Promise<ShippingQuoteOutcome> {
  const { mainServiceUrl, internalToken } = deps.config;
  if (!mainServiceUrl || !internalToken) return blocked('SHIPPING_QUOTE_NOT_CONFIGURED');
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const logger = deps.logger ?? console;
  const url = `${mainServiceUrl.replace(/\/+$/, '')}/api/internal/shipping/quote`;
  const body = JSON.stringify(buildQuoteRequestBody(input));

  for (let attempt = 0; attempt <= QUOTE_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
    let retryable = false;
    let reason = 'QUOTE_REQUEST_FAILED';
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        retryable = RETRYABLE_STATUS.has(res.status);
        reason = `QUOTE_HTTP_${res.status}`;
        try {
          const errBody = JSON.parse(text);
          if (errBody && typeof errBody.error === 'string') reason = `QUOTE_HTTP_${res.status}_${errBody.error}`;
        } catch { /* keep status reason */ }
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return blocked('QUOTE_INVALID_JSON');
        }
        return parseQuoteResponse(parsed, input);
      }
    } catch (e) {
      retryable = true;
      reason = (e as Error).name === 'AbortError' ? 'QUOTE_TIMEOUT' : 'QUOTE_NETWORK_ERROR';
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === QUOTE_MAX_RETRIES) {
      logger.warn(`[shipping-quote] blocked: ${reason} (${input.provider})`);
      return blocked(reason);
    }
  }
  return blocked('QUOTE_REQUEST_FAILED');
}

/**
 * 여러 견적 요청 — provider+serviceCode+US+chargeableWeightG 키로 중복 제거 후 동시 4개씩 호출
 * 반환: 키 → 결과
 */
export async function requestShippingQuotesDeduped(
  inputs: QuoteRequestInput[],
  deps: Parameters<typeof requestShippingQuote>[1] & { concurrency?: number },
): Promise<Map<string, ShippingQuoteOutcome>> {
  const unique = new Map<string, QuoteRequestInput>();
  for (const input of inputs) {
    const key = quoteCacheKey(input);
    if (!unique.has(key)) unique.set(key, input);
  }
  const entries = [...unique.entries()];
  const results = new Map<string, ShippingQuoteOutcome>();
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [key, input] = entries[cursor++];
      results.set(key, await requestShippingQuote(input, deps));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}
