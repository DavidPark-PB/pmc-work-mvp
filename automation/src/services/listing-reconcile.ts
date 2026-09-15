/**
 * 실제 플랫폼 등록 상태 동기화 (READ-ONLY 조회 → 내부 DB 연결만 보정)
 *
 * eBay(Trading GetMyeBaySelling ActiveList)와 Shopify(REST GET /products.json)의 실제 상품을 읽어
 * platform_listings의 외부 ID·URL·status(active)·동기화 시각·실제 등록가 snapshot만 복구한다.
 *
 * 절대 하지 않는 것: AddItem, Shopify 상품 생성/수정/삭제, 플랫폼 가격 수정, 상품 재등록 job 실행.
 * 불확실한 매칭(SKU 없음·중복·다른 상품에 이미 연결·가격 범위 밖)은 자동 연결하지 않고 MATCH_REQUIRED로 남긴다.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, platformListings, products } from '../db/schema.js';
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { ShopifyClient } from '../platforms/shopify/ShopifyClient.js';
import { readProductCsvMetadata, resolveListingSalePrice } from './listing-price.js';
import { getPricingSettings } from './pricing.js';
import { getShippingPricingConfig } from '../lib/shipping-config.js';

export type ReconcilePlatform = 'ebay' | 'shopify';

/** 플랫폼에서 읽은 실제 상품 */
export interface ExternalListing {
  platform: ReconcilePlatform;
  externalId: string;
  sku: string;
  title: string;
  price: number | null;
  currency: string;
  url: string;
}

export interface InternalListingRow {
  id: number;
  platform: string;
  status: string;
  platformItemId: string | null;
  listingUrl: string | null;
  price: string | number | null;
  quantity: number | null;
}

export interface InternalProduct {
  id: number;
  sku: string;
  title: string;
  /** CSV 원본 식별자 (상품코드 / uploadId+행) */
  productCode: string | null;
  uploadKey: string | null;
  /** 기대 등록가 (없으면 가격 검증 생략하지 않고 MATCH_REQUIRED) */
  expected: { ebay: number | null; shopify: number | null };
  listings: InternalListingRow[];
}

export type PlatformAction =
  | 'ALREADY_LINKED'   // 이미 active + 같은 외부 ID (변경 없음)
  | 'LINK'             // 외부 상품 1개로 확정 → 내부 연결 보정
  | 'NOT_LISTED'       // 플랫폼에 없음
  | 'MATCH_REQUIRED';  // 불확실 — 수동 확인

export interface PlatformDecision {
  platform: ReconcilePlatform;
  action: PlatformAction;
  externalId?: string;
  url?: string;
  actualPrice?: number | null;
  matchedBy?: 'INTERNAL_ID' | 'SKU' | 'PRODUCT_CODE' | 'UPLOAD_ROW';
  reason?: string;
}

export type ProductStatus = 'BOTH' | 'EBAY_ONLY' | 'SHOPIFY_ONLY' | 'NONE' | 'MATCH_REQUIRED';

export interface ProductPlan {
  productId: number;
  sku: string;
  title: string;
  status: ProductStatus;
  ebay: PlatformDecision;
  shopify: PlatformDecision;
  /** 내부 DB 연결이 빠져 있어 보정 대상인 상품 */
  needsRepair: boolean;
}

export interface ReconcileSummary {
  products: number;
  both: number;
  ebayOnly: number;
  shopifyOnly: number;
  none: number;
  /** 플랫폼에는 있는데 내부 연결이 빠진 고유 상품 수 */
  missingLink: number;
  matchRequired: number;
  /** 보정할 listing 행 수 */
  plannedUpdates: number;
}

export interface ReconcilePlan {
  summary: ReconcileSummary;
  rows: ProductPlan[];
  external: { ebay: number; shopify: number };
}

/** 실제 등록가가 기대가와 이 비율 이상 다르면 자동 연결하지 않는다 */
export const PRICE_TOLERANCE = 0.2;

function priceWithinExpected(actual: number | null, expected: number | null): boolean {
  if (actual === null || !Number.isFinite(actual) || actual <= 0) return false;
  if (expected === null) return false;
  if (Math.round(actual * 100) === Math.round(expected * 100)) return true;
  return Math.abs(actual - expected) <= expected * PRICE_TOLERANCE;
}

function indexByKey(items: ExternalListing[]): { unique: Map<string, ExternalListing>; duplicated: Set<string> } {
  const seen = new Map<string, ExternalListing[]>();
  for (const item of items) {
    const key = item.sku.trim();
    if (!key) continue;
    seen.set(key, [...(seen.get(key) ?? []), item]);
  }
  const unique = new Map<string, ExternalListing>();
  const duplicated = new Set<string>();
  for (const [key, list] of seen) {
    const ids = [...new Set(list.map(i => i.externalId))];
    if (ids.length === 1) unique.set(key, list[0]);
    else duplicated.add(key);
  }
  return { unique, duplicated };
}

function decide(
  platform: ReconcilePlatform,
  product: InternalProduct,
  external: ExternalListing[],
  claims: Map<string, number[]>,
): PlatformDecision {
  const listing = product.listings.find(l => l.platform === platform);
  const byId = new Map(external.map(e => [e.externalId, e]));
  const { unique, duplicated } = indexByKey(external);

  //   1순위: 내부에 저장된 외부 ID
  if (listing?.platformItemId) {
    const found = byId.get(listing.platformItemId);
    if (found) {
      const linked = listing.status === 'active' && listing.listingUrl === found.url;
      return {
        platform,
        action: linked ? 'ALREADY_LINKED' : 'LINK',
        externalId: found.externalId,
        url: found.url,
        actualPrice: found.price,
        matchedBy: 'INTERNAL_ID',
      };
    }
    return { platform, action: 'MATCH_REQUIRED', reason: `내부에 저장된 ${platform} ID(${listing.platformItemId})가 실제 목록에 없습니다` };
  }

  //   2~4순위: SKU → CSV 상품코드 → uploadId+행 (상품명 매칭 금지)
  const keys: { key: string; by: PlatformDecision['matchedBy'] }[] = [
    { key: product.sku ?? '', by: 'SKU' },
    { key: product.productCode ?? '', by: 'PRODUCT_CODE' },
    { key: product.uploadKey ?? '', by: 'UPLOAD_ROW' },
  ];
  for (const { key, by } of keys) {
    const trimmed = (key ?? '').trim();
    if (!trimmed) continue;
    if (duplicated.has(trimmed)) {
      return { platform, action: 'MATCH_REQUIRED', reason: `${platform}에 같은 식별자(${trimmed}) 상품이 2개 이상입니다` };
    }
    const found = unique.get(trimmed);
    if (!found) continue;
    const claimedBy = (claims.get(`${platform}:${found.externalId}`) ?? []).filter(id => id !== product.id);
    if (claimedBy.length > 0) {
      return { platform, action: 'MATCH_REQUIRED', reason: `${platform} 상품(${found.externalId})이 다른 내부 상품(#${claimedBy[0]})에 연결돼 있습니다` };
    }
    if (found.currency && found.currency !== 'USD') {
      return { platform, action: 'MATCH_REQUIRED', reason: `${platform} 상품 통화가 USD가 아닙니다 (${found.currency})` };
    }
    const expected = product.expected[platform];
    if (!priceWithinExpected(found.price, expected)) {
      return {
        platform, action: 'MATCH_REQUIRED', externalId: found.externalId, url: found.url, actualPrice: found.price, matchedBy: by,
        reason: expected === null
          ? `기대 등록가를 계산할 수 없어 ${platform} 가격을 확인할 수 없습니다`
          : `${platform} 실제 가격($${found.price ?? 0})이 기대 등록가($${expected.toFixed(2)}) 범위를 벗어납니다`,
      };
    }
    return { platform, action: 'LINK', externalId: found.externalId, url: found.url, actualPrice: found.price, matchedBy: by };
  }

  if (!product.sku?.trim()) {
    return { platform, action: 'MATCH_REQUIRED', reason: 'SKU가 없어 자동 연결할 수 없습니다' };
  }
  return { platform, action: 'NOT_LISTED' };
}

/** 내부 상품 + 실제 플랫폼 상품 → 보정 계획 (순수 함수, DB·API 접근 없음) */
export function planReconciliation(productsIn: InternalProduct[], external: { ebay: ExternalListing[]; shopify: ExternalListing[] }): ReconcilePlan {
  //   외부 상품이 여러 내부 상품과 매칭되는지 먼저 확인 (교차 연결 방지)
  const claims = new Map<string, number[]>();
  for (const platform of ['ebay', 'shopify'] as const) {
    const { unique } = indexByKey(external[platform]);
    for (const product of productsIn) {
      const stored = product.listings.find(l => l.platform === platform)?.platformItemId;
      const keys = [stored, product.sku, product.productCode, product.uploadKey].filter((k): k is string => !!k && !!k.trim());
      const hits = new Set<string>();
      for (const key of keys) {
        const found = unique.get(key.trim());
        if (found) hits.add(found.externalId);
        if (external[platform].some(e => e.externalId === key.trim())) hits.add(key.trim());
      }
      for (const externalId of hits) {
        const mapKey = `${platform}:${externalId}`;
        claims.set(mapKey, [...(claims.get(mapKey) ?? []), product.id]);
      }
    }
  }

  const rows: ProductPlan[] = productsIn.map(product => {
    const ebay = decide('ebay', product, external.ebay, claims);
    const shopify = decide('shopify', product, external.shopify, claims);
    const listed = (d: PlatformDecision) => d.action === 'LINK' || d.action === 'ALREADY_LINKED';
    const status: ProductStatus = ebay.action === 'MATCH_REQUIRED' || shopify.action === 'MATCH_REQUIRED'
      ? 'MATCH_REQUIRED'
      : listed(ebay) && listed(shopify) ? 'BOTH'
      : listed(ebay) ? 'EBAY_ONLY'
      : listed(shopify) ? 'SHOPIFY_ONLY'
      : 'NONE';
    return { productId: product.id, sku: product.sku, title: product.title, status, ebay, shopify, needsRepair: ebay.action === 'LINK' || shopify.action === 'LINK' };
  });

  const summary: ReconcileSummary = {
    products: rows.length,
    both: rows.filter(r => r.status === 'BOTH').length,
    ebayOnly: rows.filter(r => r.status === 'EBAY_ONLY').length,
    shopifyOnly: rows.filter(r => r.status === 'SHOPIFY_ONLY').length,
    none: rows.filter(r => r.status === 'NONE').length,
    missingLink: rows.filter(r => r.needsRepair).length,
    matchRequired: rows.filter(r => r.status === 'MATCH_REQUIRED').length,
    plannedUpdates: rows.reduce((n, r) => n + (r.ebay.action === 'LINK' ? 1 : 0) + (r.shopify.action === 'LINK' ? 1 : 0), 0),
  };
  return { summary, rows, external: { ebay: external.ebay.length, shopify: external.shopify.length } };
}

// ── 실제 플랫폼 조회 (READ-ONLY) ────────────────────────────

export async function fetchEbayListings(client = new EbayClient()): Promise<ExternalListing[]> {
  const items = await client.getActiveListings();
  return items.map(item => ({
    platform: 'ebay' as const,
    externalId: item.itemId,
    sku: item.sku ?? '',
    title: item.title ?? '',
    price: item.price ? Number(item.price) : null,
    currency: 'USD',
    url: `https://www.ebay.com/itm/${item.itemId}`,
  }));
}

export async function fetchShopifyListings(client = new ShopifyClient()): Promise<ExternalListing[]> {
  const items = await client.getAllProducts();
  const out: ExternalListing[] = [];
  for (const product of items) {
    for (const variant of product.variants ?? []) {
      out.push({
        platform: 'shopify',
        externalId: String(product.id),
        sku: variant.sku ?? '',
        title: product.title ?? '',
        price: variant.price === undefined || variant.price === null ? null : Number(variant.price),
        currency: 'USD',
        url: `https://${process.env.SHOPIFY_STORE_URL}/products/${product.handle}`,
      });
    }
  }
  return out;
}

// ── 내부 상품 로드 ──────────────────────────────────────────

/** 신규 USD CSV 상품 + 그 listing 행 (기대 등록가 포함) */
export async function loadCsvProducts(productIds?: number[]): Promise<InternalProduct[]> {
  const rows = await db.query.products.findMany({
    where: productIds && productIds.length > 0 ? inArray(products.id, productIds) : undefined,
    with: { listings: true },
  });
  const shipping = getShippingPricingConfig();
  const ebaySettings = await getPricingSettings('ebay');
  const shopifySettings = await getPricingSettings('shopify');
  const out: InternalProduct[] = [];
  for (const product of rows as any[]) {
    const csv = readProductCsvMetadata(product.metadata);
    if (!csv) continue;
    const sourceCrawl = typeof csv.importedFrom === 'number'
      ? await db.query.crawlResults.findFirst({ where: eq(crawlResults.id, csv.importedFrom) })
      : undefined;
    const expectedFor = (platform: ReconcilePlatform, settings: any) => {
      try {
        return resolveListingSalePrice(product, settings, { platform, sourceCrawl: sourceCrawl ?? null, shipping }).salePrice;
      } catch {
        return null;
      }
    };
    out.push({
      id: product.id,
      sku: product.sku,
      title: product.title,
      productCode: typeof csv.sourceProductCode === 'string' && csv.sourceProductCode.trim() ? csv.sourceProductCode.trim() : null,
      uploadKey: csv.uploadId && csv.sourceRowNumber !== null && csv.sourceRowNumber !== undefined ? `${csv.uploadId}#${csv.sourceRowNumber}` : null,
      expected: { ebay: expectedFor('ebay', ebaySettings), shopify: expectedFor('shopify', shopifySettings) },
      listings: (product.listings ?? []).map((l: any) => ({
        id: l.id, platform: l.platform, status: l.status, platformItemId: l.platformItemId, listingUrl: l.listingUrl, price: l.price, quantity: l.quantity,
      })),
    });
  }
  return out;
}

// ── 보정 적용 (내부 DB만) ───────────────────────────────────

export interface ReconcileResult extends ReconcilePlan {
  applied: boolean;
  updated: number;
  inserted: number;
}

/**
 * LINK 결정만 내부 DB에 반영. 이미 연결된 행(ALREADY_LINKED)·불확실(MATCH_REQUIRED)·미등록(NOT_LISTED)은 쓰기 없음.
 * 같은 동기화를 다시 실행하면 모두 ALREADY_LINKED가 되어 write 0.
 */
export async function applyReconcilePlan(plan: ReconcilePlan, productsIn: InternalProduct[]): Promise<{ updated: number; inserted: number }> {
  let updated = 0;
  let inserted = 0;
  const byId = new Map(productsIn.map(p => [p.id, p]));
  const now = new Date();
  for (const row of plan.rows) {
    const product = byId.get(row.productId);
    if (!product) continue;
    for (const decision of [row.ebay, row.shopify]) {
      if (decision.action !== 'LINK' || !decision.externalId) continue;
      const existing = product.listings.find(l => l.platform === decision.platform);
      const reconciled = {
        source: 'PLATFORM_RECONCILE',
        at: now.toISOString(),
        matchedBy: decision.matchedBy,
        externalId: decision.externalId,
        actualPrice: decision.actualPrice ?? null,
      };
      if (existing) {
        const currentData = await db.query.platformListings.findFirst({ where: eq(platformListings.id, existing.id) });
        await db.update(platformListings).set({
          status: 'active',
          platformItemId: decision.externalId,
          listingUrl: decision.url,
          lastSyncedAt: now,
          platformData: { ...((currentData?.platformData as Record<string, unknown>) ?? {}), reconciled },
        }).where(eq(platformListings.id, existing.id));
        updated++;
      } else {
        await db.insert(platformListings).values({
          productId: product.id,
          platform: decision.platform,
          platformSku: product.sku,
          platformItemId: decision.externalId,
          title: product.title,
          status: 'active',
          price: String(decision.actualPrice ?? 0),
          currency: 'USD',
          quantity: 5,
          listingUrl: decision.url,
          lastSyncedAt: now,
          platformData: { reconciled },
        });
        inserted++;
      }
    }
  }
  return { updated, inserted };
}

export interface ReconcileDeps {
  loadProducts?: () => Promise<InternalProduct[]>;
  fetchEbay?: () => Promise<ExternalListing[]>;
  fetchShopify?: () => Promise<ExternalListing[]>;
}

/** 감사(dryRun=true) 또는 보정(dryRun=false). 어떤 경우에도 플랫폼 쓰기 호출은 없다. */
export async function reconcileListings(options: { dryRun?: boolean; productIds?: number[] } = {}, deps: ReconcileDeps = {}): Promise<ReconcileResult> {
  const dryRun = options.dryRun ?? true;
  const internal = await (deps.loadProducts ?? (() => loadCsvProducts(options.productIds)))();
  const [ebay, shopify] = await Promise.all([
    (deps.fetchEbay ?? (() => fetchEbayListings()))(),
    (deps.fetchShopify ?? (() => fetchShopifyListings()))(),
  ]);
  const plan = planReconciliation(internal, { ebay, shopify });
  if (dryRun) return { ...plan, applied: false, updated: 0, inserted: 0 };
  const { updated, inserted } = await applyReconcilePlan(plan, internal);
  console.log(`[동기화] 실제 플랫폼 상태 반영: 갱신 ${updated} · 추가 ${inserted} · 확인 필요 ${plan.summary.matchRequired}`);
  return { ...plan, applied: true, updated, inserted };
}
