/**
 * eBay Shipping(Fulfillment) Policy — CSV 업로드별 선택 (READ-ONLY 조회)
 *
 * 조회: Sell Account API GET /sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US
 *   fulfillmentPolicyId == Trading AddItem SellerShippingProfile.ShippingProfileID (production 264/264 동일 확인)
 *
 * 구매자 배송비 판정 (추정 금지 — 응답으로 확정 가능한 정책만 지원):
 *   - 상품 위치 KR · ebay.com 등록 → 미국 구매자는 DOMESTIC 옵션(…FromOutsideUS 서비스) 적용
 *   - DOMESTIC 옵션 1개, costType FLAT_RATE, rate table 없음, USD
 *   - 구매자 배송비 = sortOrder 1 서비스 금액 (eBay 기본 표시 서비스). freeShipping 이면 0
 *   - sortOrder 1 서비스가 최저가가 아니면 구매자 기본 배송비를 확정할 수 없어 선택 불가
 *
 * 가격 원칙: StartPrice = CSV 판매가 + 국제배송비 (정책 배송비는 빼거나 더하지 않음)
 *           구매자 총 결제 = StartPrice + 선택 정책 구매자 배송비 (표시 전용)
 */
import { eq } from 'drizzle-orm';
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { db } from '../db/index.js';
import { crawlResults, platformListings, products } from '../db/schema.js';
import { importExternalId, type CsvRow } from '../lib/csv-parser.js';

export const SHIPPING_POLICY_MARKETPLACE = 'EBAY_US';
export const SHIPPING_POLICY_CACHE_TTL_MS = 10 * 60 * 1000;

export type ShippingPolicyType = 'FREE' | 'FIXED' | 'UNSUPPORTED';

export interface ShippingPolicyView {
  policyId: string;
  name: string;
  marketplace: string;
  shippingType: ShippingPolicyType;
  buyerShippingUsd: number | null;
  supported: boolean;
  recommended: boolean;
  unsupportedReason: string | null;
  unsupportedMessage: string | null;
  /** 미국 구매자 기본 배송서비스 코드 (sortOrder 1) */
  primaryServiceCode: string | null;
  serviceCount: number;
}

/** upload(parsed_rows) → raw_data.csvImport → products.metadata.csvImport → platform_data.pricing 에 저장하는 선택 당시 snapshot */
export interface ShippingPolicySnapshot {
  policyId: string;
  policyName: string;
  marketplace: string;
  shippingType: 'FREE' | 'FIXED';
  buyerShippingUsd: number;
  primaryServiceCode: string | null;
  selectedAt: string;
  fetchedAt: string;
  /** UPLOAD: CSV upload 선택값을 적용 / MANUAL: 상품별 수동 지정 (upload 정책 변경으로 덮어쓰지 않음). 없으면 UPLOAD */
  source?: 'UPLOAD' | 'MANUAL';
}

export const SHIPPING_POLICY_IMPORT_REQUIRED_MESSAGE = 'eBay 배송정책을 선택하면 상품을 가져올 수 있습니다.';

export const SHIPPING_POLICY_UNSUPPORTED_MESSAGES: Record<string, string> = {
  MARKETPLACE_NOT_US: '미국 eBay(EBAY_US) 정책이 아니어서 자동 리스팅에서 사용할 수 없습니다.',
  CATEGORY_TYPE: '일반 상품용 정책이 아니어서 자동 리스팅에서 사용할 수 없습니다.',
  NO_DOMESTIC_OPTION: '미국 구매자 배송 옵션이 없어 자동 리스팅에서 사용할 수 없습니다.',
  CALCULATED: '비용이 주소에 따라 달라 자동 리스팅에서 사용할 수 없습니다.',
  RATE_TABLE: '지역별 배송비표(rate table)로 비용이 달라 자동 리스팅에서 사용할 수 없습니다.',
  COST_UNKNOWN: '구매자 배송비를 확인할 수 없어 자동 리스팅에서 사용할 수 없습니다.',
  PRIMARY_NOT_CHEAPEST: '기본 배송서비스가 최저가가 아니어서 구매자 배송비를 확정할 수 없습니다.',
};

const asRecord = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);

function serviceCost(service: Record<string, any>): number | null {
  if (service.freeShipping === true) return 0;
  const cost = asRecord(service.shippingCost);
  if (!cost || cost.currency !== 'USD') return null;
  const value = Number(cost.value);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

/** eBay fulfillment policy 원본 1건 → 화면/검증용 view (원본의 나머지 필드는 버림) */
export function classifyFulfillmentPolicy(raw: unknown): ShippingPolicyView | null {
  const policy = asRecord(raw);
  if (!policy || typeof policy.fulfillmentPolicyId !== 'string' || !policy.fulfillmentPolicyId) return null;
  const base = {
    policyId: policy.fulfillmentPolicyId,
    name: typeof policy.name === 'string' ? policy.name : policy.fulfillmentPolicyId,
    marketplace: typeof policy.marketplaceId === 'string' ? policy.marketplaceId : '',
    primaryServiceCode: null as string | null,
    serviceCount: 0,
  };
  const unsupported = (reason: string, extra: Partial<ShippingPolicyView> = {}): ShippingPolicyView => ({
    ...base, shippingType: 'UNSUPPORTED', buyerShippingUsd: null, supported: false, recommended: false,
    unsupportedReason: reason, unsupportedMessage: SHIPPING_POLICY_UNSUPPORTED_MESSAGES[reason], ...extra,
  });

  if (base.marketplace !== SHIPPING_POLICY_MARKETPLACE) return unsupported('MARKETPLACE_NOT_US');
  const categoryTypes = Array.isArray(policy.categoryTypes) ? policy.categoryTypes.map((c: any) => c?.name) : [];
  if (!categoryTypes.includes('ALL_EXCLUDING_MOTORS_VEHICLES')) return unsupported('CATEGORY_TYPE');

  const options = Array.isArray(policy.shippingOptions) ? policy.shippingOptions.map(asRecord).filter(Boolean) as Record<string, any>[] : [];
  const domestic = options.filter(o => o.optionType === 'DOMESTIC');
  if (domestic.length !== 1) return unsupported('NO_DOMESTIC_OPTION');
  const option = domestic[0];
  if (option.costType === 'CALCULATED') return unsupported('CALCULATED');
  if (option.costType !== 'FLAT_RATE') return unsupported('COST_UNKNOWN');
  if (option.rateTableId) return unsupported('RATE_TABLE');

  const services = (Array.isArray(option.shippingServices) ? option.shippingServices.map(asRecord).filter(Boolean) as Record<string, any>[] : [])
    .sort((a, b) => (Number(a.sortOrder) || 99) - (Number(b.sortOrder) || 99));
  const withMeta = { primaryServiceCode: services[0]?.shippingServiceCode ?? null, serviceCount: services.length };
  if (services.length === 0) return unsupported('COST_UNKNOWN', withMeta);
  const costs = services.map(serviceCost);
  if (costs.some(c => c === null)) return unsupported('COST_UNKNOWN', withMeta);
  const primary = costs[0]!;
  if (primary > Math.min(...(costs as number[]))) return unsupported('PRIMARY_NOT_CHEAPEST', withMeta);

  return {
    ...base,
    ...withMeta,
    shippingType: primary === 0 ? 'FREE' : 'FIXED',
    buyerShippingUsd: primary,
    supported: true,
    recommended: primary === 0,
    unsupportedReason: null,
    unsupportedMessage: null,
  };
}

/** 드롭다운 순서: 무료(추천) → 고정 금액 오름차순 → 선택 불가 */
export function sortShippingPolicies(views: ShippingPolicyView[]): ShippingPolicyView[] {
  const rank = (v: ShippingPolicyView) => (v.shippingType === 'FREE' ? 0 : v.shippingType === 'FIXED' ? 1 : 2);
  return [...views].sort((a, b) => rank(a) - rank(b)
    || (a.buyerShippingUsd ?? 0) - (b.buyerShippingUsd ?? 0)
    || a.name.localeCompare(b.name));
}

export function buildShippingPolicyViews(raw: unknown): ShippingPolicyView[] {
  const list = asRecord(raw)?.fulfillmentPolicies;
  if (!Array.isArray(list)) throw new Error('eBay fulfillment_policy 응답 형식 오류');
  return sortShippingPolicies(list.map(classifyFulfillmentPolicy).filter((v): v is ShippingPolicyView => v !== null));
}

// ── 서버 메모리 캐시 (10분) ──────────────────────────────────

export interface ShippingPolicyList {
  policies: ShippingPolicyView[];
  fetchedAt: string;
  stale: boolean;
}

type Fetcher = () => Promise<unknown>;
let cache: { policies: ShippingPolicyView[]; fetchedAt: number } | null = null;
let inflight: Promise<ShippingPolicyList> | null = null;

const defaultFetcher: Fetcher = () => new EbayClient().getFulfillmentPolicies(SHIPPING_POLICY_MARKETPLACE);

export function resetShippingPolicyCache(): void {
  cache = null;
  inflight = null;
}

/**
 * 정책 목록 — 10분 캐시. 조회 실패 시 마지막 정상 캐시가 있으면 stale=true 로 반환, 없으면 Error
 */
export async function getShippingPolicies(options: { refresh?: boolean; fetcher?: Fetcher; now?: () => number } = {}): Promise<ShippingPolicyList> {
  const now = options.now ?? Date.now;
  if (!options.refresh && cache && now() - cache.fetchedAt < SHIPPING_POLICY_CACHE_TTL_MS) {
    return { policies: cache.policies, fetchedAt: new Date(cache.fetchedAt).toISOString(), stale: false };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const policies = buildShippingPolicyViews(await (options.fetcher ?? defaultFetcher)());
      cache = { policies, fetchedAt: now() };
      return { policies, fetchedAt: new Date(cache.fetchedAt).toISOString(), stale: false };
    } catch (e) {
      console.warn(`[shipping-policy] 목록 조회 실패: ${(e as Error).message}`);
      if (cache) return { policies: cache.policies, fetchedAt: new Date(cache.fetchedAt).toISOString(), stale: true };
      throw new Error('eBay 배송정책을 불러오지 못했습니다.');
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function buildShippingPolicySnapshot(view: ShippingPolicyView, fetchedAt: string, selectedAt = new Date()): ShippingPolicySnapshot {
  if (!view.supported || view.buyerShippingUsd === null || view.shippingType === 'UNSUPPORTED') {
    throw new Error(view.unsupportedMessage || '자동 리스팅에서 사용할 수 없는 배송정책입니다.');
  }
  return {
    policyId: view.policyId,
    policyName: view.name,
    marketplace: view.marketplace,
    shippingType: view.shippingType,
    buyerShippingUsd: view.buyerShippingUsd,
    primaryServiceCode: view.primaryServiceCode,
    selectedAt: selectedAt.toISOString(),
    fetchedAt,
    source: 'UPLOAD',
  };
}

export function isManualShippingPolicy(value: unknown): boolean {
  return !!asRecord(value) && (value as Record<string, unknown>).source === 'MANUAL';
}

// ── upload 정책 변경 → 이미 가져온 미등록 상품에 반영 ─────────────

/** 등록되었거나 등록 진행 중인 리스팅 — 정책을 바꾸지 않는다 */
const PROTECTED_LISTING_STATUSES = new Set(['active', 'ended', 'pending']);

export interface ShippingPolicyApplyResult {
  crawlRowsUpdated: number;
  productsUpdated: number;
  /** eBay Item ID가 있거나 등록 성공/진행 중인 상품 — 변경 안 함 */
  skippedRegistered: number;
  /** 다른 upload로 다시 가져왔거나 다른 upload 상품 — 변경 안 함 */
  skippedOtherUpload: number;
  /** 상품별 수동 정책 — 변경 안 함 */
  skippedManual: number;
}

/**
 * 같은 upload에서 이미 DB로 가져온 상품(crawl_results / products)에 선택 정책 snapshot 반영
 * 대상: parsed_rows[*].importedCrawlResultId (없으면 import batch와 같은 external_id 규칙) 중
 *       raw_data.csvImport.uploadId === uploadId 인 crawl 행과, 그 행에서 만든(importedFrom) 같은 upload 상품
 * 제외: eBay Item ID 있음 · active/ended/pending 리스팅 · 수동 정책 · 다른 upload
 */
export async function applyShippingPolicyToImportedRows(
  uploadId: string,
  rows: CsvRow[],
  snapshot: ShippingPolicySnapshot,
): Promise<ShippingPolicyApplyResult> {
  const result: ShippingPolicyApplyResult = { crawlRowsUpdated: 0, productsUpdated: 0, skippedRegistered: 0, skippedOtherUpload: 0, skippedManual: 0 };
  const crawlIds = new Set<number>();
  for (const row of rows) {
    if (!row || row.priceCurrency !== 'USD') continue;
    if (typeof row.importedCrawlResultId === 'number') {
      crawlIds.add(row.importedCrawlResultId);
      continue;
    }
    //   crawl id 기록 이전에 가져온 행: 같은 external_id + 같은 uploadId 인 crawl 행
    const candidates = await db.query.crawlResults.findMany({ where: eq(crawlResults.externalId, importExternalId(row)) });
    for (const c of candidates) {
      if (asRecord(asRecord(c.rawData)?.csvImport)?.uploadId === uploadId) crawlIds.add(c.id);
    }
  }

  for (const crawlId of [...crawlIds].sort((a, b) => a - b)) {
    const crawl = await db.query.crawlResults.findFirst({ where: eq(crawlResults.id, crawlId) });
    const rawData = asRecord(crawl?.rawData);
    const crawlCsv = asRecord(rawData?.csvImport);
    if (!crawl || !rawData || !crawlCsv) continue;
    if (crawlCsv.uploadId !== uploadId) { result.skippedOtherUpload++; continue; }

    if (crawl.productId) {
      const product = await db.query.products.findFirst({ where: eq(products.id, crawl.productId) });
      const metadata = asRecord(product?.metadata);
      const productCsv = asRecord(metadata?.csvImport);
      if (!product || !metadata || !productCsv || metadata.importedFrom !== crawl.id || productCsv.uploadId !== uploadId) {
        result.skippedOtherUpload++;
        continue;
      }
      if (isManualShippingPolicy(productCsv.shippingPolicy)) { result.skippedManual++; continue; }
      const listings = await db.query.platformListings.findMany({ where: eq(platformListings.productId, product.id) });
      if (listings.some(l => !!l.platformItemId || PROTECTED_LISTING_STATUSES.has(l.status))) { result.skippedRegistered++; continue; }

      await db.update(products)
        .set({ metadata: { ...metadata, csvImport: { ...productCsv, shippingPolicy: snapshot } } })
        .where(eq(products.id, product.id));
      result.productsUpdated++;
    } else if (isManualShippingPolicy(crawlCsv.shippingPolicy)) {
      result.skippedManual++;
      continue;
    }

    await db.update(crawlResults)
      .set({ rawData: { ...rawData, csvImport: { ...crawlCsv, shippingPolicy: snapshot } } })
      .where(eq(crawlResults.id, crawl.id));
    result.crawlRowsUpdated++;
  }
  return result;
}

/** 저장된 snapshot 형식 검증 (없거나 깨졌으면 null) */
export function readShippingPolicySnapshot(value: unknown): ShippingPolicySnapshot | null {
  const s = asRecord(value);
  if (!s || typeof s.policyId !== 'string' || !s.policyId) return null;
  if (s.shippingType !== 'FREE' && s.shippingType !== 'FIXED') return null;
  if (typeof s.buyerShippingUsd !== 'number' || !Number.isFinite(s.buyerShippingUsd) || s.buyerShippingUsd < 0) return null;
  return s as unknown as ShippingPolicySnapshot;
}

// ── 등록 직전 검증 (create / retry / relist 공용) ───────────────

export const SHIPPING_POLICY_BLOCK_MESSAGES: Record<string, string> = {
  SHIPPING_POLICY_NOT_SELECTED: 'eBay 배송정책이 선택되지 않아 등록하지 않았습니다. CSV 가져오기 화면에서 배송정책을 선택하세요.',
  SHIPPING_POLICY_NOT_AVAILABLE: '선택한 eBay 배송정책을 확인할 수 없어(삭제되었거나 조회 실패) 등록하지 않았습니다.',
  SHIPPING_POLICY_UNSUPPORTED: '선택한 eBay 배송정책은 구매자 배송비를 확정할 수 없어 자동 리스팅에 사용할 수 없습니다.',
  SHIPPING_POLICY_CHANGED: 'eBay 배송정책 내용이 선택 당시와 달라 등록하지 않았습니다. 배송정책을 다시 선택하세요.',
};

export class ShippingPolicyError extends Error {
  constructor(readonly code: keyof typeof SHIPPING_POLICY_BLOCK_MESSAGES | string, message?: string) {
    super(message ?? SHIPPING_POLICY_BLOCK_MESSAGES[code] ?? code);
    this.name = 'ShippingPolicyError';
  }
}

/**
 * CSV 상품의 선택 정책을 eBay 현재 목록으로 재검증 → AddItem ShippingProfileID
 * 전역 EBAY_SHIPPING_PROFILE_ID 로 fallback 하지 않는다.
 */
export async function resolveCsvShippingPolicy(
  csv: Record<string, any>,
  deps: { fetcher?: Fetcher } = {},
): Promise<{ shippingProfileId: string; snapshot: ShippingPolicySnapshot }> {
  const snapshot = readShippingPolicySnapshot(csv.shippingPolicy);
  if (!snapshot) throw new ShippingPolicyError('SHIPPING_POLICY_NOT_SELECTED');
  if (snapshot.marketplace !== SHIPPING_POLICY_MARKETPLACE) throw new ShippingPolicyError('SHIPPING_POLICY_UNSUPPORTED');

  let list: ShippingPolicyList;
  try {
    list = await getShippingPolicies({ fetcher: deps.fetcher });
  } catch {
    throw new ShippingPolicyError('SHIPPING_POLICY_NOT_AVAILABLE');
  }
  if (list.stale) throw new ShippingPolicyError('SHIPPING_POLICY_NOT_AVAILABLE');   // 등록 직전 검증은 최신 목록으로만
  const current = list.policies.find(p => p.policyId === snapshot.policyId);
  if (!current) throw new ShippingPolicyError('SHIPPING_POLICY_NOT_AVAILABLE');
  if (!current.supported) throw new ShippingPolicyError('SHIPPING_POLICY_UNSUPPORTED');
  if (current.marketplace !== snapshot.marketplace || current.shippingType !== snapshot.shippingType
    || Math.round((current.buyerShippingUsd ?? -1) * 100) !== Math.round(snapshot.buyerShippingUsd * 100)) {
    throw new ShippingPolicyError('SHIPPING_POLICY_CHANGED');
  }
  return { shippingProfileId: current.policyId, snapshot };
}
