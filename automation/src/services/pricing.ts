/**
 * 가격 계산 엔진
 *
 * KRW 매입가 → USD 판매가 변환
 * 마진율, 플랫폼 수수료, 배송비를 반영한 최종 가격 산출
 */
import { db } from '../db/index.js';
import { shippingRates, pricingSettings } from '../db/schema.js';
import { and, eq, lte, gte } from 'drizzle-orm';

// 플랫폼별 수수료율 (DB에 설정이 없을 때 폴백)
const PLATFORM_FEES: Record<string, number> = {
  ebay: 0.13,     // 13%
  shopify: 0.05,  // 5% (Shopify Payments)
  alibaba: 0.05,  // 5% (ICBU)
  shopee: 0.06,   // 6%
};

// 기본 환율 (DB에 설정이 없을 때 폴백)
const DEFAULT_KRW_TO_USD = 1400;

// 기본 배송비 (DB에 설정이 없을 때 폴백)
const DEFAULT_SHIPPING_KRW = 5500;

// 기본 재고 수량 (DB 에 설정이 없을 때 폴백)
const DEFAULT_QUANTITY = 5;

export interface PricingSettingsData {
  marginRate: number;
  exchangeRate: number;
  platformFeeRate: number;
  defaultShippingKrw: number;
  defaultQuantity: number;
}

export interface PricingResult {
  salePrice: number;      // USD 판매가
  shippingCost: number;   // USD 배송비
  costUsd: number;        // USD 환산 매입가
  marginRate: number;     // 실제 마진율
  platformFee: number;    // 플랫폼 수수료 (USD)
  shippingKrw: number;    // 배송비 (KRW)
}

export interface PricingOptions {
  marginRate?: number;       // 목표 마진율 (기본 0.30 = 30%)
  exchangeRate?: number;     // KRW→USD 환율 (기본 1400)
  platform?: string;         // 'ebay' | 'shopify'
  shippingCarrier?: string;  // 'YunExpress' | 'K-Packet'
  //   PMC-CCOREA-SHIPPING-1B shadow inputs — passed through unchanged in
  //   shadow mode; NEVER affect the returned legacy PricingResult.
  destinationCountry?: string;    // 'US' | 'DE' | ...
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  uniqueHsCodeCount?: number;
  declaredValueKrw?: number;
  eurKrwRate?: number;
  //   Correlation ids used by the shadow-result recorder (mig 115).
  listingJobId?: string;
  productRef?: string;
}

/**
 * DB에서 플랫폼별 가격 설정 조회 (없으면 하드코딩 폴백)
 */
export async function getPricingSettings(platform: string): Promise<PricingSettingsData> {
  const row = await db.query.pricingSettings.findFirst({
    where: eq(pricingSettings.platform, platform),
  });

  if (row) {
    return {
      marginRate: parseFloat(String(row.marginRate)),
      exchangeRate: parseFloat(String(row.exchangeRate)),
      platformFeeRate: parseFloat(String(row.platformFeeRate)),
      defaultShippingKrw: parseFloat(String(row.defaultShippingKrw)),
      defaultQuantity: Number((row as any).defaultQuantity) || DEFAULT_QUANTITY,
    };
  }

  return {
    marginRate: 0.30,
    exchangeRate: DEFAULT_KRW_TO_USD,
    platformFeeRate: PLATFORM_FEES[platform] || 0.13,
    defaultShippingKrw: DEFAULT_SHIPPING_KRW,
    defaultQuantity: DEFAULT_QUANTITY,
  };
}

/**
 * 모든 플랫폼의 가격 설정 조회
 */
export async function getAllPricingSettings(): Promise<Record<string, PricingSettingsData>> {
  const rows = await db.query.pricingSettings.findMany();
  const result: Record<string, PricingSettingsData> = {};

  for (const row of rows) {
    result[row.platform] = {
      marginRate: parseFloat(String(row.marginRate)),
      exchangeRate: parseFloat(String(row.exchangeRate)),
      platformFeeRate: parseFloat(String(row.platformFeeRate)),
      defaultShippingKrw: parseFloat(String(row.defaultShippingKrw)),
      defaultQuantity: Number((row as any).defaultQuantity) || DEFAULT_QUANTITY,
    };
  }

  // 없는 플랫폼은 폴백 추가
  for (const platform of ['ebay', 'shopify', 'alibaba', 'shopee']) {
    if (!result[platform]) {
      result[platform] = {
        marginRate: 0.30,
        exchangeRate: DEFAULT_KRW_TO_USD,
        platformFeeRate: PLATFORM_FEES[platform] || 0.13,
        defaultShippingKrw: DEFAULT_SHIPPING_KRW,
        defaultQuantity: DEFAULT_QUANTITY,
      };
    }
  }

  return result;
}

/**
 * DB에서 배송비 조회
 */
async function getShippingRate(weightG: number, carrier = 'YunExpress'): Promise<number> {
  const rate = await db.query.shippingRates.findFirst({
    where: and(
      eq(shippingRates.carrier, carrier),
      lte(shippingRates.minWeight, weightG),
      gte(shippingRates.maxWeight, weightG),
      eq(shippingRates.isActive, true),
    ),
  });

  return rate ? parseFloat(String(rate.rate)) : DEFAULT_SHIPPING_KRW;
}

/**
 * 가격 계산 메인 함수
 *
 * 공식: salePrice = (costKRW + shippingKRW) / exchangeRate / (1 - marginRate - platformFee)
 */
export async function calculateListingPrice(
  costKRW: number,
  weightG: number,
  options: PricingOptions = {},
): Promise<PricingResult> {
  const platform = options.platform || 'ebay';
  const settings = await getPricingSettings(platform);

  const marginRate = options.marginRate ?? settings.marginRate;
  const exchangeRate = options.exchangeRate ?? settings.exchangeRate;
  const platformFeeRate = settings.platformFeeRate;
  const shippingCarrier = options.shippingCarrier || 'YunExpress';

  // 1. 배송비 (KRW)
  const shippingKrw = await getShippingRate(weightG, shippingCarrier);

  // 2. USD 환산
  const costUsd = costKRW / exchangeRate;
  const shippingUsd = shippingKrw / exchangeRate;

  // 3. 역산: 마진 + 수수료를 보장하는 판매가
  const targetRevenue = (costUsd + shippingUsd) * (1 + marginRate);
  const totalPrice = targetRevenue / (1 - platformFeeRate);
  const salePrice = Math.ceil((totalPrice - shippingUsd) * 100) / 100;
  const platformFee = (salePrice + shippingUsd) * platformFeeRate;

  const result: PricingResult = {
    salePrice: Math.max(salePrice, 0.99),
    shippingCost: Math.ceil(shippingUsd * 100) / 100,
    costUsd: Math.round(costUsd * 100) / 100,
    marginRate,
    platformFee: Math.round(platformFee * 100) / 100,
    shippingKrw,
  };

  //
  //   PMC-CCOREA-SHIPPING-1B (2026-09-13, corrected) — SHADOW HOOK.
  //   Fire-and-forget: consult the canonical quote+bands engine on the main
  //   service and record the recomputed shipping cost alongside the legacy
  //   result. The eBay payload ALWAYS uses the legacy result in this phase.
  //
  //   Guarantees (owner directive §6):
  //     · Short timeout (2s) via AbortController — never blocks the listing.
  //     · All errors caught; unhandled rejection swallowed by outer .catch.
  //     · No token, cookie, or price in the log line (only shape metadata).
  //     · Legacy result is returned regardless of shadow outcome.
  //     · When AUTO_LISTING_SHIPPING_SHADOW_ENABLED != 'true', the request
  //       is not issued at all.
  //     · Requires SHIPPING_QUOTE_INTERNAL_TOKEN — admin cookies are refused.
  //
  fireShadowShipmentQuote({
    platform,
    costKRW,
    weightG,
    marginRate,
    platformFeeRate,
    exchangeRate,
    legacyShippingKrw: shippingKrw,
    legacySalePrice: result.salePrice,
    options,
  });

  return result;
}

//   Fire-and-forget shadow shipping-quote hook (extracted for clarity + testability).
//   Never throws. Never blocks. The returned Promise is intentionally
//   ignored — Node's unhandledRejection is guarded by the inner .catch.
function fireShadowShipmentQuote(ctx: {
  platform: string;
  costKRW: number;
  weightG: number;
  marginRate: number;
  platformFeeRate: number;
  exchangeRate: number;
  legacyShippingKrw: number;
  legacySalePrice: number;
  options: PricingOptions;
}): void {
  //   Owner directive §5: single shadow flag; default OFF.
  if (process.env.AUTO_LISTING_SHIPPING_SHADOW_ENABLED !== 'true') return;
  const token = (process.env.SHIPPING_QUOTE_INTERNAL_TOKEN || '').trim();
  if (!token) return;   //   silently skip when internal token unset

  const mainServiceUrl = process.env.MAIN_SERVICE_URL || 'http://localhost:3001';
  const quoteUrl  = `${mainServiceUrl.replace(/\/$/, '')}/api/internal/shipping/quote`;
  const recordUrl = `${mainServiceUrl.replace(/\/$/, '')}/api/internal/shipping/shadow-result`;
  const timeoutMs = 2000;

  const shadowBody = {
    marketplace: ctx.platform,
    destinationCountry: ctx.options.destinationCountry || 'US',
    productCostKrw: ctx.costKRW,
    actualWeightKg: ctx.weightG / 1000,
    lengthCm: ctx.options.lengthCm || 0,
    widthCm:  ctx.options.widthCm  || 0,
    heightCm: ctx.options.heightCm || 0,
    uniqueHsCodeCount: ctx.options.uniqueHsCodeCount || 0,
    declaredValueKrw:  ctx.options.declaredValueKrw || 0,
    platformFeeRate:   ctx.platformFeeRate,
    targetMarginRate:  ctx.marginRate,
    sellingCurrencyKrwRate: ctx.exchangeRate,
    eurKrwRate: ctx.options.eurKrwRate ?? null,
    saleType: 'B2C',
    provider: 'eGS',
  };

  const listingJobId =
    (ctx.options as any)?.listingJobId ||
    `unknown-job-${Date.now()}`;
  const productRef =
    (ctx.options as any)?.productRef || `unknown-${ctx.weightG}g-${ctx.costKRW}krw`;

  //   The outer promise is deliberately unawaited. The inner `.catch` prevents
  //   any unhandledRejection that would surface elsewhere in the process.
  Promise.resolve()
    .then(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let quoteJson: any = {};
      try {
        const r = await (globalThis as any).fetch(quoteUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(shadowBody),
          signal: ac.signal,
        });
        quoteJson = await r.json().catch(() => ({}));
      } finally {
        clearTimeout(timer);
      }
      //   Log with SHAPE only — never dollar values that could leak cost
      //   structure via stdout aggregation. `svc` and `band` are opaque codes.
      console.log(
        '[shadow:shipping-quote]',
        `platform=${ctx.platform}`,
        `weightG=${ctx.weightG}`,
        quoteJson.ok
          ? `svc=${quoteJson.serviceCode || '-'} band=${quoteJson.policyBand?.ebay_policy_id || '-'} status=ok`
          : `status=blocked reason=${quoteJson.listingBlockedReason || quoteJson.quote?.blockedReason || 'unknown'}`,
      );

      //   Best-effort persistence into shipping_quote_shadow_results.
      const ac2 = new AbortController();
      const timer2 = setTimeout(() => ac2.abort(), timeoutMs);
      try {
        await (globalThis as any).fetch(recordUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            listingJobId,
            productRef,
            marketplace: ctx.platform,
            destinationCountry: shadowBody.destinationCountry,
            legacyListingPrice: Math.round(ctx.legacySalePrice * ctx.exchangeRate),
            newListingPrice:    quoteJson.listingItemPriceKrw ?? null,
            legacyShippingCost: ctx.legacyShippingKrw,
            newShippingCost:    quoteJson.estimatedShippingCostKrw ?? null,
            chargeableWeightKg: quoteJson.quote?.chargeableWeightKg ?? null,
            serviceCode:        quoteJson.serviceCode ?? quoteJson.quote?.serviceCode ?? null,
            rateVersionId:      quoteJson.quote?.rateVersionId ?? null,
            policyBandId:       null,
            status:             quoteJson.ok ? 'ok' : 'blocked',
            blockedReason:      quoteJson.listingBlockedReason || quoteJson.quote?.blockedReason || null,
            calculationDetails: {
              bracketRule: quoteJson.quote?.calculationDetails?.bracketRule,
              bracketMatchedCountryKey: quoteJson.quote?.calculationDetails?.bracketMatchedCountryKey,
              bracketMatchedZoneKey:    quoteJson.quote?.calculationDetails?.bracketMatchedZoneKey,
              isEuDestination:          quoteJson.quote?.calculationDetails?.isEuDestination,
            },
          }),
          signal: ac2.signal,
        });
      } catch (_writeErr) {
        //   Shadow-write failure must NEVER surface — the listing already succeeded.
      } finally {
        clearTimeout(timer2);
      }
    })
    .catch(() => { /* intentional swallow — see comment above */ });
}

/**
 * 동기 가격 계산 (settings를 미리 로드한 경우 사용)
 * N+1 방지: getAllPricingSettings()로 1회 조회 후 이 함수로 반복 계산
 */
export function calculatePriceSync(
  costKRW: number,
  settings: PricingSettingsData,
): { salePrice: number; shippingCost: number } {
  const costUsd = costKRW / settings.exchangeRate;
  const shippingUsd = settings.defaultShippingKrw / settings.exchangeRate;

  const targetRevenue = (costUsd + shippingUsd) * (1 + settings.marginRate);
  const totalPrice = targetRevenue / (1 - settings.platformFeeRate);
  const salePrice = Math.ceil((totalPrice - shippingUsd) * 100) / 100;

  return {
    salePrice: Math.max(salePrice, 0.99),
    shippingCost: Math.ceil(shippingUsd * 100) / 100,
  };
}

/**
 * 간단 가격 계산 (DB 설정 기반, 배송비는 설정값 사용)
 */
export async function calculatePriceSimple(
  costKRW: number,
  options: { platform?: string } = {},
): Promise<{ salePrice: number; shippingCost: number }> {
  const platform = options.platform || 'ebay';
  const settings = await getPricingSettings(platform);
  return calculatePriceSync(costKRW, settings);
}
