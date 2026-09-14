/**
 * 배송비 반영 eBay 등록가 — 순수 계산 (DB/네트워크 없음)
 *
 *   shippingUsd     = ceil((shippingKrw / exchangeRate) × 100) / 100
 *   listingPriceUsd = baseSalePriceUsd + shippingUsd
 *   baseSalePriceUsd = salePriceOverrideUsd ?? salePriceUsd
 *
 * eBay Shipping Policy 구매자 배송비(buyerShippingUsd, 예 $7.90)는 차감도 가산도 하지 않는다.
 */
import { SHIPPING_DESTINATION_COUNTRY, isShippingProvider, type ShippingPricingConfig, type ShippingProvider } from '../lib/shipping-config.js';

const MAX_PRICE_USD = 100_000;

export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function centsToUsd(cents: number): number {
  return cents / 100;
}

/** 유한한 양수 + 센트 단위 + 상한 이하인 USD 금액인지 */
export function isValidUsdAmount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= MAX_PRICE_USD
    && Math.abs(value * 100 - toCents(value)) <= 1e-6;
}

/** KRW → USD 센트 (올림). 부동소수 오차로 13.20이 13.21이 되지 않도록 6자리 정규화 후 올림 */
export function shippingKrwToUsdCents(shippingKrw: number, exchangeRate: number): number {
  if (!(Number.isFinite(shippingKrw) && shippingKrw > 0)) throw new Error('shippingKrw must be positive');
  if (!(Number.isFinite(exchangeRate) && exchangeRate > 0)) throw new Error('exchangeRate must be positive');
  const rawCents = Math.round(((shippingKrw * 100) / exchangeRate) * 1e6) / 1e6;
  return Math.ceil(rawCents);
}

export function formatUsdAmount(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── 견적 snapshot ───────────────────────────────────────

export interface ShippingQuoteOk {
  ok: true;
  provider: ShippingProvider;
  serviceCode: string;
  destinationCountry: string;
  chargeableWeightG: number;
  chargeableWeightKg: number;
  bracketWeightKg: number;
  shippingKrw: number;
  rateVersionId: number | string;
  rateEffectiveFrom: string | null;
}

export interface ShippingQuoteBlocked {
  ok: false;
  blockedReason: string;
}

export type ShippingQuoteOutcome = ShippingQuoteOk | ShippingQuoteBlocked;

export interface ShippingQuoteSnapshot {
  status: 'OK' | 'BLOCKED';
  provider: ShippingProvider;
  serviceCode: string | null;
  destinationCountry: string;
  chargeableWeightG: number | null;
  bracketWeightKg: number | null;
  shippingKrw: number | null;
  exchangeRate: number | null;
  shippingUsd: number | null;
  csvSalePriceUsd: number | null;
  listingPriceUsd: number | null;
  buyerShippingUsd: number | null;
  calculatedAt: string;
  rateVersionId: number | string | null;
  rateEffectiveFrom: string | null;
  blockedReason: string | null;
}

export function buildShippingQuoteSnapshot(input: {
  provider: ShippingProvider;
  serviceCode: string | null;
  chargeableWeightG: number | null;
  csvSalePriceUsd: number | null;
  exchangeRate: number | null;
  buyerShippingUsd: number | null;
  outcome: ShippingQuoteOutcome;
  now?: Date;
}): ShippingQuoteSnapshot {
  const base = {
    provider: input.provider,
    serviceCode: input.serviceCode,
    destinationCountry: SHIPPING_DESTINATION_COUNTRY,
    chargeableWeightG: input.chargeableWeightG,
    exchangeRate: input.exchangeRate,
    csvSalePriceUsd: input.csvSalePriceUsd,
    buyerShippingUsd: input.buyerShippingUsd,
    calculatedAt: (input.now ?? new Date()).toISOString(),
  };
  const blocked = (reason: string, extra: Partial<ShippingQuoteSnapshot> = {}): ShippingQuoteSnapshot => ({
    ...base,
    status: 'BLOCKED',
    bracketWeightKg: null,
    shippingKrw: null,
    shippingUsd: null,
    listingPriceUsd: null,
    rateVersionId: null,
    rateEffectiveFrom: null,
    blockedReason: reason,
    ...extra,
  });

  if (!input.outcome.ok) return blocked(input.outcome.blockedReason);
  if (input.exchangeRate === null) return blocked('EXCHANGE_RATE_INVALID');
  if (!isValidUsdAmount(input.csvSalePriceUsd)) return blocked('SALE_PRICE_INVALID');

  const quote = input.outcome;
  const shippingCents = shippingKrwToUsdCents(quote.shippingKrw, input.exchangeRate);
  return {
    ...base,
    status: 'OK',
    bracketWeightKg: quote.bracketWeightKg,
    shippingKrw: quote.shippingKrw,
    shippingUsd: centsToUsd(shippingCents),
    listingPriceUsd: centsToUsd(toCents(input.csvSalePriceUsd) + shippingCents),
    rateVersionId: quote.rateVersionId,
    rateEffectiveFrom: quote.rateEffectiveFrom,
    blockedReason: null,
  };
}

// ── 수동 판매가 ─────────────────────────────────────────

export interface SalePriceOverrideHistoryEntry {
  previousUsd: number | null;
  newUsd: number | null;
  changedAt: string;
  changedBy: string | null;
}

/**
 * 수동 판매가 적용 (원본 salePriceUsd는 건드리지 않음). newValue null/'' = 수동가 해제
 * 잘못된 값이면 Error
 */
export function applySalePriceOverride(
  fields: Record<string, any>,
  newValue: unknown,
  meta: { changedBy?: string | null; now?: Date } = {},
): Record<string, any> {
  let next: number | null;
  if (newValue === null || newValue === undefined || newValue === '') {
    next = null;
  } else {
    const n = typeof newValue === 'number' ? newValue : Number(String(newValue).replace(/[$,\s]/g, ''));
    if (!isValidUsdAmount(n)) throw new Error('수동 판매가(USD)는 0보다 큰 센트 단위 금액이어야 합니다.');
    if (typeof fields.purchaseCostKrw === 'number' && toCents(fields.purchaseCostKrw) === toCents(n)) {
      throw new Error('수동 판매가(USD)가 매입원가(KRW)와 같습니다. 통화를 확인하세요.');
    }
    next = centsToUsd(toCents(n));
  }
  const previous = typeof fields.salePriceOverrideUsd === 'number' ? fields.salePriceOverrideUsd : null;
  const history: SalePriceOverrideHistoryEntry[] = Array.isArray(fields.salePriceOverrideHistory) ? [...fields.salePriceOverrideHistory] : [];
  history.push({ previousUsd: previous, newUsd: next, changedAt: (meta.now ?? new Date()).toISOString(), changedBy: meta.changedBy ?? null });
  return { ...fields, salePriceOverrideUsd: next, salePriceOverrideHistory: history };
}

// ── CSV 상품 등록가 평가 (resolver + 대시보드 공용) ─────────

export type CsvPriceSource = 'CSV_USD_PLUS_SHIPPING';

export interface CsvListingPriceOk {
  ok: true;
  source: CsvPriceSource;
  salePrice: number;
  csvSalePriceUsd: number;
  basePriceUsd: number;
  basePriceSource: 'CSV' | 'MANUAL';
  shippingUsd: number | null;
  shippingKrw: number | null;
  exchangeRate: number | null;
  provider: ShippingProvider | null;
  serviceCode: string | null;
  rateVersionId: number | string | null;
  buyerShippingUsd: number | null;
}

export interface CsvListingPriceBlocked {
  ok: false;
  code: string;
  message: string;
  csvSalePriceUsd: number | null;
  basePriceUsd: number | null;
  basePriceSource: 'CSV' | 'MANUAL' | null;
}

export const CSV_PRICE_MESSAGES: Record<string, string> = {
  SALE_PRICE_INVALID: '판매가(USD)가 없거나 올바르지 않아 등록하지 않았습니다.',
  SALE_PRICE_OVERRIDE_INVALID: '수동 판매가(USD)가 올바르지 않아 등록하지 않았습니다.',
  OVERRIDE_HISTORY_MISMATCH: '수동 판매가 수정 이력이 일치하지 않아 등록하지 않았습니다.',
  CHARGEABLE_WEIGHT_INVALID: '적용무게(g)가 없거나 올바르지 않아 등록하지 않았습니다.',
  SHIPPING_PROVIDER_MISSING: '배송사(KPL/eGS)가 선택되지 않아 등록하지 않았습니다.',
  SHIPPING_QUOTE_MISSING: '유효한 국제배송비 견적이 없어 등록하지 않았습니다.',
  SHIPPING_QUOTE_MISMATCH: '배송 견적이 현재 상품정보(배송사/적용무게/서비스)와 일치하지 않아 등록하지 않았습니다. 다시 견적하세요.',
  EXCHANGE_RATE_INVALID: '배송비 환율(AUTO_LISTING_SHIPPING_EXCHANGE_RATE)이 없거나 올바르지 않아 등록하지 않았습니다.',
  EXCHANGE_RATE_MISMATCH: '배송 견적의 환율이 현재 설정과 달라 등록하지 않았습니다. 다시 견적하세요.',
  SERVICE_CODE_NOT_CONFIGURED: '배송 서비스 코드 설정이 없어 등록하지 않았습니다.',
  SHIPPING_PRICING_DISABLED: '배송비 반영 기능이 비활성화되어 있어 이 상품을 eBay에 등록하지 않았습니다.',
};

function blockedResult(code: string, base: { csv: number | null; base: number | null; source: 'CSV' | 'MANUAL' | null }): CsvListingPriceBlocked {
  return { ok: false, code, message: CSV_PRICE_MESSAGES[code] ?? code, csvSalePriceUsd: base.csv, basePriceUsd: base.base, basePriceSource: base.source };
}

/** 저장된 snapshot이 현재 상품정보·설정과 일치하는 유효 견적인지 — 불일치 사유 코드 또는 null */
export function validateShippingSnapshot(
  snapshot: unknown,
  ctx: { provider: ShippingProvider; chargeableWeightG: number; serviceCode: string; exchangeRate: number },
): string | null {
  const s = snapshot as Partial<ShippingQuoteSnapshot> | null | undefined;
  if (!s || typeof s !== 'object' || s.status !== 'OK') return 'SHIPPING_QUOTE_MISSING';
  if (s.provider !== ctx.provider) return 'SHIPPING_QUOTE_MISMATCH';
  if (s.serviceCode !== ctx.serviceCode) return 'SHIPPING_QUOTE_MISMATCH';
  if (s.destinationCountry !== SHIPPING_DESTINATION_COUNTRY) return 'SHIPPING_QUOTE_MISMATCH';
  if (s.chargeableWeightG !== ctx.chargeableWeightG) return 'SHIPPING_QUOTE_MISMATCH';
  if (!(typeof s.bracketWeightKg === 'number' && s.bracketWeightKg * 1000 >= ctx.chargeableWeightG - 1e-6)) return 'SHIPPING_QUOTE_MISMATCH';
  if (!(typeof s.shippingKrw === 'number' && Number.isInteger(s.shippingKrw) && s.shippingKrw > 0)) return 'SHIPPING_QUOTE_MISSING';
  if (s.rateVersionId === null || s.rateVersionId === undefined) return 'SHIPPING_QUOTE_MISSING';
  if (s.exchangeRate !== ctx.exchangeRate) return 'EXCHANGE_RATE_MISMATCH';
  //   snapshot의 USD 배송비는 저장된 KRW·환율에서 다시 계산한 값과 같아야 한다 (변조/오변환 차단)
  if (!(typeof s.shippingUsd === 'number' && toCents(s.shippingUsd) === shippingKrwToUsdCents(s.shippingKrw, ctx.exchangeRate))) {
    return 'SHIPPING_QUOTE_MISMATCH';
  }
  return null;
}

/**
 * USD CSV(toybox) 상품의 eBay 등록가 평가 — create/retry/relist/대시보드 공용 release guard
 *
 * 확정 규칙: StartPrice = baseSalePriceUsd(수동가 ?? CSV가) + 견적 배송비 USD.
 * - 플래그 off: 배송비를 반영할 수 없으므로 등록 차단 (SHIPPING_PRICING_DISABLED). CSV가 단독 등록 경로는 없다.
 * - 플래그 on : 적용무게·배송사·서비스·환율이 모두 일치하는 유효 snapshot이 있을 때만 base + snapshot 배송비.
 * 레거시(KRW) 상품은 이 함수를 거치지 않는다.
 */
export function evaluateCsvListingPrice(
  csv: Record<string, any>,
  config: Pick<ShippingPricingConfig, 'enabled' | 'exchangeRate' | 'serviceCodes' | 'buyerShippingUsd'>,
): CsvListingPriceOk | CsvListingPriceBlocked {
  const csvSale = isValidUsdAmount(csv.salePriceUsd) ? centsToUsd(toCents(csv.salePriceUsd)) : null;
  if (csvSale === null) return blockedResult('SALE_PRICE_INVALID', { csv: null, base: null, source: null });
  if (typeof csv.purchaseCostKrw === 'number' && toCents(csv.purchaseCostKrw) === toCents(csvSale)) {
    return blockedResult('SALE_PRICE_INVALID', { csv: null, base: null, source: null });
  }

  let basePriceUsd = csvSale;
  let basePriceSource: 'CSV' | 'MANUAL' = 'CSV';
  if (csv.salePriceOverrideUsd !== null && csv.salePriceOverrideUsd !== undefined) {
    const override = csv.salePriceOverrideUsd;
    if (!isValidUsdAmount(override) || (typeof csv.purchaseCostKrw === 'number' && toCents(csv.purchaseCostKrw) === toCents(override))) {
      return blockedResult('SALE_PRICE_OVERRIDE_INVALID', { csv: csvSale, base: null, source: 'MANUAL' });
    }
    const history = Array.isArray(csv.salePriceOverrideHistory) ? csv.salePriceOverrideHistory : [];
    const last = history[history.length - 1];
    if (!last || typeof last.newUsd !== 'number' || toCents(last.newUsd) !== toCents(override)) {
      return blockedResult('OVERRIDE_HISTORY_MISMATCH', { csv: csvSale, base: null, source: 'MANUAL' });
    }
    basePriceUsd = centsToUsd(toCents(override));
    basePriceSource = 'MANUAL';
  }
  const baseInfo = { csv: csvSale, base: basePriceUsd, source: basePriceSource };

  //   Release guard: 배송비 반영 기능이 꺼져 있으면 CSV가만으로는 절대 등록하지 않는다.
  if (!config.enabled) return blockedResult('SHIPPING_PRICING_DISABLED', baseInfo);

  const chargeableWeightG = csv.chargeableWeightG;
  if (!(typeof chargeableWeightG === 'number' && Number.isFinite(chargeableWeightG) && chargeableWeightG > 0)) {
    return blockedResult('CHARGEABLE_WEIGHT_INVALID', baseInfo);
  }

  const common = { csvSalePriceUsd: csvSale, basePriceUsd, basePriceSource, buyerShippingUsd: config.buyerShippingUsd };

  const provider = csv.selectedShippingProvider;
  if (!isShippingProvider(provider)) return blockedResult('SHIPPING_PROVIDER_MISSING', baseInfo);
  if (config.exchangeRate === null) return blockedResult('EXCHANGE_RATE_INVALID', baseInfo);
  const serviceCode = config.serviceCodes[provider];
  if (!serviceCode) return blockedResult('SERVICE_CODE_NOT_CONFIGURED', baseInfo);

  const snapshotIssue = validateShippingSnapshot(csv.shippingQuote, { provider, chargeableWeightG, serviceCode, exchangeRate: config.exchangeRate });
  if (snapshotIssue) return blockedResult(snapshotIssue, baseInfo);

  const snapshot = csv.shippingQuote as ShippingQuoteSnapshot;
  const shippingCents = toCents(snapshot.shippingUsd!);
  return {
    ok: true,
    source: 'CSV_USD_PLUS_SHIPPING',
    salePrice: centsToUsd(toCents(basePriceUsd) + shippingCents),
    ...common,
    shippingUsd: centsToUsd(shippingCents),
    shippingKrw: snapshot.shippingKrw,
    exchangeRate: config.exchangeRate,
    provider,
    serviceCode,
    rateVersionId: snapshot.rateVersionId,
  };
}
