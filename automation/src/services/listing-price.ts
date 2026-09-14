/**
 * 리스팅 판매가 결정 (순수 함수)
 *
 * - CSV_USD_PLUS_SHIPPING: toybox USD CSV — 판매가(수동가 ?? CSV가) + 저장된 국제배송비 견적 (배송비 플래그 on 에서만)
 * - LEGACY_CALCULATED: 기존 상품 — costPrice(KRW) 기반 calculatePriceSync (= calculatePriceSimple)
 *
 * Release guard (Phase 2.1): USD CSV 상품은 배송비 반영 플래그가 꺼져 있으면 등록하지 않는다 (CSV가 단독 등록 경로 없음).
 * USD CSV 흔적이 있는데 검증에 실패하면 fail-closed로 ListingPriceError를 던진다.
 */
import { calculatePriceSync, type PricingSettingsData } from './pricing.js';
import { parseDecimal } from '../lib/csv-parser.js';
import { evaluateCsvListingPrice, formatUsdAmount, type CsvListingPriceOk, type ShippingQuoteSnapshot, type SalePriceOverrideHistoryEntry } from './shipping-pricing.js';
import { isShippingProvider, type ShippingPricingConfig, type ShippingProvider } from '../lib/shipping-config.js';

export type SalePriceSource = 'CSV_USD_PLUS_SHIPPING' | 'LEGACY_CALCULATED';
export type DisplayPriceSource = SalePriceSource | 'CSV_USD_BLOCKED';

/**
 * TOYBOX_USD: metadata.csvImport + currency USD + salePriceUsd + 원본 crawl(importedFrom 일치)의 원본 헤더에 `환산가(USD)`
 * USD_CSV   : USD CSV metadata는 있으나 위 toybox 증거가 일부 없음 (동일하게 release guard 적용)
 * LEGACY    : metadata.csvImport 없음 (기존 KRW 경로)
 */
export type CsvProductClass = 'TOYBOX_USD' | 'USD_CSV' | 'LEGACY';

export interface ResolvedListingSalePrice {
  salePrice: number;
  /** 기존 flat 배송비 기록값 (AddItem payload에는 사용되지 않음) */
  shippingCost: number;
  currency: 'USD';
  source: SalePriceSource;
  productClass: CsvProductClass;
  /** CSV 상품 가격 구성 (레거시 상품은 없음) */
  breakdown?: Omit<CsvListingPriceOk, 'ok' | 'source' | 'salePrice'>;
}

export type ShippingResolveConfig = Pick<ShippingPricingConfig, 'enabled' | 'exchangeRate' | 'serviceCodes' | 'buyerShippingUsd'>;

const SHIPPING_DISABLED: ShippingResolveConfig = {
  enabled: false,
  exchangeRate: null,
  buyerShippingUsd: null,
  serviceCodes: { KPL: null, eGS: null },
};

/** products.metadata.csvImport — importFromCrawl에서 USD CSV 원본일 때만 저장 */
export interface ProductCsvImportMetadata {
  version: 1;
  currency: 'USD';
  salePriceUsd: number | null;
  purchaseCostKrw: number | null;
  retailPriceKrw: number | null;
  actualWeightG: number | null;
  volumetricWeightG: number | null;
  chargeableWeightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  sourceProductCode: string | null;
  sourceUrl: string | null;
  originalImageUrl: string | null;
  importedFrom: number;
  uploadId: string | null;
  sourceRowNumber: number | null;
  selectedShippingProvider: ShippingProvider | null;
  shippingQuote: ShippingQuoteSnapshot | null;
  salePriceOverrideUsd: number | null;
  salePriceOverrideHistory: SalePriceOverrideHistoryEntry[];
}

/** 판매가 검증에 쓰는 crawl_results 원본 */
export interface SourceCrawlEvidence {
  id: number;
  url?: string | null;
  currency: string | null;
  price: string | number | null;
  rawData: unknown;
}

export type ListingPriceErrorCode =
  | 'SALE_PRICE_INVALID'
  | 'SOURCE_MISMATCH'
  | 'SOURCE_MISSING'
  | 'METADATA_MISSING'
  | 'PLATFORM_UNSUPPORTED'
  | string;

export class ListingPriceError extends Error {
  constructor(readonly code: ListingPriceErrorCode, message: string) {
    super(message);
    this.name = 'ListingPriceError';
  }
}

const SALE_PRICE_INVALID_MESSAGE = '판매가(USD)가 없거나 올바르지 않아 등록하지 않았습니다.';
const MAX_SALE_PRICE_USD = 100_000;

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

/** crawl_results가 USD CSV 원본인지 (currency 또는 csvImport 필드 중 하나라도 USD) */
export function isUsdCsvCrawl(crawl: Pick<SourceCrawlEvidence, 'currency' | 'rawData'>): boolean {
  const fields = asRecord(asRecord(asRecord(crawl.rawData)?.csvImport)?.fields);
  return crawl.currency === 'USD' || fields?.priceCurrency === 'USD';
}

/** importFromCrawl용: USD CSV 원본이면 product metadata 생성, 아니면 undefined */
export function buildProductCsvMetadata(crawl: SourceCrawlEvidence): ProductCsvImportMetadata | undefined {
  if (!isUsdCsvCrawl(crawl)) return undefined;
  const csvImport = asRecord(asRecord(crawl.rawData)?.csvImport) ?? {};
  const fields = asRecord(csvImport.fields) ?? {};
  return {
    version: 1,
    currency: 'USD',
    salePriceUsd: numberOrNull(fields.salePriceUsd),
    purchaseCostKrw: numberOrNull(fields.purchaseCostKrw),
    retailPriceKrw: numberOrNull(fields.retailPriceKrw),
    actualWeightG: numberOrNull(fields.actualWeightG),
    volumetricWeightG: numberOrNull(fields.volumetricWeightG),
    chargeableWeightG: numberOrNull(fields.chargeableWeightG),
    lengthCm: numberOrNull(fields.lengthCm),
    widthCm: numberOrNull(fields.widthCm),
    heightCm: numberOrNull(fields.heightCm),
    sourceProductCode: stringOrNull(fields.sourceProductCode),
    sourceUrl: stringOrNull(fields.url) ?? stringOrNull(crawl.url),
    originalImageUrl: stringOrNull(fields.originalImageUrl),
    importedFrom: crawl.id,
    uploadId: stringOrNull(csvImport.uploadId),
    sourceRowNumber: numberOrNull(csvImport.sourceRowNumber),
    selectedShippingProvider: isShippingProvider(fields.selectedShippingProvider) ? fields.selectedShippingProvider : null,
    shippingQuote: asRecord(csvImport.shippingQuote) ? (csvImport.shippingQuote as ShippingQuoteSnapshot) : null,
    salePriceOverrideUsd: numberOrNull(fields.salePriceOverrideUsd),
    salePriceOverrideHistory: Array.isArray(fields.salePriceOverrideHistory) ? fields.salePriceOverrideHistory : [],
  };
}

/** products.metadata에서 USD CSV metadata 추출 */
export function readProductCsvMetadata(metadata: unknown): Record<string, any> | undefined {
  return asRecord(asRecord(metadata)?.csvImport);
}

/** 판매가(USD) 유효성: 유한한 양수, 센트 단위, 상한 이하 */
export function validateSalePriceUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_SALE_PRICE_USD) {
    throw new ListingPriceError('SALE_PRICE_INVALID', SALE_PRICE_INVALID_MESSAGE);
  }
  if (Math.abs(value * 100 - toCents(value)) > 1e-6) {
    throw new ListingPriceError('SALE_PRICE_INVALID', SALE_PRICE_INVALID_MESSAGE);
  }
  return toCents(value) / 100;
}

function assertMatchesSource(salePrice: number, csv: Record<string, any>, source: SourceCrawlEvidence | null | undefined): void {
  const mismatch = (detail: string) =>
    new ListingPriceError('SOURCE_MISMATCH', `판매가(USD)가 원본 CSV 데이터와 일치하지 않아 등록하지 않았습니다. (${detail})`);

  if (!source) {
    throw new ListingPriceError('SOURCE_MISSING', '원본 CSV 데이터(crawl_results)를 찾을 수 없어 판매가(USD)를 검증하지 못해 등록하지 않았습니다.');
  }
  if (source.id !== csv.importedFrom) throw mismatch('원본 ID');
  if (source.currency !== 'USD') throw mismatch('원본 통화');

  const crawlPrice = parseDecimal(source.price === null ? null : String(source.price));
  if (crawlPrice === null || toCents(crawlPrice) !== toCents(salePrice)) throw mismatch('crawl_results.price');

  const csvImport = asRecord(asRecord(source.rawData)?.csvImport);
  const fieldPrice = numberOrNull(asRecord(csvImport?.fields)?.salePriceUsd);
  if (fieldPrice === null || toCents(fieldPrice) !== toCents(salePrice)) throw mismatch('raw_data 판매가');

  // 원본 CSV 셀을 다시 파싱해 소수점 유실(25.4 → 254 등) 여부 확인
  const rawCell = asRecord(csvImport?.sourceColumns)?.['환산가(USD)'];
  if (typeof rawCell === 'string') {
    const parsedCell = parseDecimal(rawCell);
    if (parsedCell === null || toCents(parsedCell) !== toCents(salePrice)) throw mismatch('원본 환산가(USD) 셀');
  }
}

/**
 * 리스팅 판매가 결정 — createListing / retryListing / relistListing 공용
 */
export function resolveListingSalePrice(
  product: { costPrice: unknown; metadata: unknown },
  pricingSettings: PricingSettingsData,
  options: { platform: string; sourceCrawl?: SourceCrawlEvidence | null; shipping?: ShippingResolveConfig },
): ResolvedListingSalePrice {
  const costKRW = parseFloat(String(product.costPrice)) || 0;
  const legacy = calculatePriceSync(costKRW, pricingSettings);
  const csv = readProductCsvMetadata(product.metadata);

  if (!csv) {
    // USD CSV 원본인데 metadata가 없으면 KRW로 오인될 수 있으므로 차단
    if (options.sourceCrawl && isUsdCsvCrawl(options.sourceCrawl)) {
      throw new ListingPriceError('METADATA_MISSING', '판매가(USD) CSV 상품이지만 상품 metadata가 없어 등록하지 않았습니다. 상품을 다시 가져오세요.');
    }
    return { salePrice: legacy.salePrice, shippingCost: legacy.shippingCost, currency: 'USD', source: 'LEGACY_CALCULATED', productClass: 'LEGACY' };
  }

  if (options.platform !== 'ebay') {
    throw new ListingPriceError('PLATFORM_UNSUPPORTED', '판매가(USD) CSV 상품은 현재 eBay에만 등록할 수 있습니다.');
  }
  if (csv.currency !== 'USD') {
    throw new ListingPriceError('SALE_PRICE_INVALID', SALE_PRICE_INVALID_MESSAGE);
  }

  const salePrice = validateSalePriceUsd(csv.salePriceUsd);
  if (typeof csv.purchaseCostKrw === 'number' && toCents(csv.purchaseCostKrw) === toCents(salePrice)) {
    throw new ListingPriceError('SALE_PRICE_INVALID', SALE_PRICE_INVALID_MESSAGE);
  }
  assertMatchesSource(salePrice, csv, options.sourceCrawl);
  const productClass = classifyCsvProduct(csv, options.sourceCrawl);

  // Release guard + 수동 판매가 · 적용무게 · 배송 견적 snapshot 검증 후 최종 등록가
  const evaluated = evaluateCsvListingPrice(csv, options.shipping ?? SHIPPING_DISABLED);
  if (!evaluated.ok) throw new ListingPriceError(evaluated.code, evaluated.message);

  const { ok: _ok, source, salePrice: finalPrice, ...breakdown } = evaluated;
  return { salePrice: finalPrice, shippingCost: legacy.shippingCost, currency: 'USD', source, productClass, breakdown };
}

/** toybox USD CSV 상품 식별 (release guard 대상 분류) */
export function classifyCsvProduct(csv: Record<string, any> | undefined, sourceCrawl: SourceCrawlEvidence | null | undefined): CsvProductClass {
  if (!csv) return 'LEGACY';
  const sourceColumns = asRecord(asRecord(asRecord(sourceCrawl?.rawData)?.csvImport)?.sourceColumns);
  const isToybox = csv.currency === 'USD'
    && typeof csv.salePriceUsd === 'number'
    && !!sourceCrawl && sourceCrawl.id === csv.importedFrom
    && !!sourceColumns && Object.prototype.hasOwnProperty.call(sourceColumns, '환산가(USD)');
  return isToybox ? 'TOYBOX_USD' : 'USD_CSV';
}

export interface DisplayPrices {
  costKrw: number;
  ebayPrice: number;
  shopifyPrice: number;
  alibabaPrice: number;
  shopeePrice: number;
  priceSource: DisplayPriceSource;
  /** USD CSV 행: eBay 등록이 차단되는지 (서버 release guard와 같은 평가) */
  ebayListingBlocked: boolean;
  ebayBlockCode?: string;
  ebayBlockMessage?: string;
  /** USD CSV 행: 인라인 수정 기준값 = 판매가(수동가 또는 CSV가, 배송비 제외) */
  ebayEditValue?: number | null;
  /** USD CSV 행: "CSV $25.40 · 수동 $27.00 · 배송 $13.20" 또는 차단 사유 */
  priceNote?: string;
}

/**
 * 대시보드/휴지통/인라인 수정 응답용 가격
 * USD CSV 행: 원가 칸 = 매입원가 KRW, eBay 칸 = 환산가(USD), 타 플랫폼 = 미지원(0)
 * 그 외: 기존 계산 그대로 (override 우선)
 */
export function resolveDisplayPrices(input: {
  costKrw: number;
  csv?: Record<string, any>;
  overrides?: Record<string, number>;
  allSettings: Record<string, PricingSettingsData>;
  shipping?: ShippingResolveConfig;
}): DisplayPrices {
  const { costKrw, csv, allSettings } = input;
  if (csv) {
    const shipping = input.shipping ?? SHIPPING_DISABLED;
    const evaluated = evaluateCsvListingPrice(csv, shipping);
    const parts: string[] = [];
    if (evaluated.csvSalePriceUsd !== null) parts.push(`CSV ${formatUsdAmount(evaluated.csvSalePriceUsd)}`);
    if (evaluated.basePriceSource === 'MANUAL' && evaluated.basePriceUsd !== null) parts.push(`수동 ${formatUsdAmount(evaluated.basePriceUsd)}`);
    if (evaluated.ok && evaluated.shippingUsd !== null) {
      parts.push(`배송 ${formatUsdAmount(evaluated.shippingUsd)}`);
      if (evaluated.buyerShippingUsd !== null) {
        parts.push(`구매자 총 ${formatUsdAmount((Math.round(evaluated.salePrice * 100) + Math.round(evaluated.buyerShippingUsd * 100)) / 100)}`);
      }
    }
    if (!evaluated.ok) parts.push(`차단: ${evaluated.message}`);
    return {
      costKrw: numberOrNull(csv.purchaseCostKrw) ?? 0,
      ebayPrice: evaluated.ok ? evaluated.salePrice : 0,
      shopifyPrice: 0,
      alibabaPrice: 0,
      shopeePrice: 0,
      priceSource: evaluated.ok ? evaluated.source : 'CSV_USD_BLOCKED',
      ebayListingBlocked: !evaluated.ok,
      ...(evaluated.ok ? {} : { ebayBlockCode: evaluated.code, ebayBlockMessage: evaluated.message }),
      ebayEditValue: evaluated.basePriceUsd,
      priceNote: parts.join(' · '),
    };
  }

  const overrides = input.overrides || {};
  const calc = (platform: string) => (costKrw > 0 ? calculatePriceSync(costKrw, allSettings[platform]).salePrice : 0);
  return {
    costKrw,
    ebayPrice: overrides.ebay || calc('ebay'),
    shopifyPrice: overrides.shopify || calc('shopify'),
    alibabaPrice: overrides.alibaba || calc('alibaba'),
    shopeePrice: overrides.shopee || calc('shopee'),
    priceSource: 'LEGACY_CALCULATED',
    ebayListingBlocked: false,
  };
}

/** crawl_results 행 → 대시보드용 csv metadata (USD CSV 원본일 때만) */
export function crawlDisplayCsv(crawl: { id: number; url?: string | null; currency: string | null; price: string | number | null; rawData: unknown }): Record<string, any> | undefined {
  return buildProductCsvMetadata(crawl) as Record<string, any> | undefined;
}
