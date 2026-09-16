/**
 * 실제 플랫폼 등록 상태 동기화 — 매칭 규칙 · 보정 대상 · 화면 표시
 * eBay/Shopify는 읽기 mock만 사용 (생성·수정·삭제 호출 0), DB는 fake
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const envState = vi.hoisted(() => {
  const env: Record<string, string | undefined> = {};
  (globalThis as any).__env = env;
  return env;
});
vi.mock('../src/lib/config.js', () => ({ env: (globalThis as any).__env }));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const keyOf = (col: unknown) => (globalThis as any).__columnKeys.get(col);
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => (row: Record<string, unknown>) => row[keyOf(col)] === val,
    and: (...preds: ((row: any) => boolean)[]) => (row: any) => preds.every(p => p(row)),
    inArray: (col: unknown, vals: unknown[]) => (row: Record<string, unknown>) => vals.includes(row[keyOf(col)]),
  };
});
vi.mock('../src/db/index.js', () => ({ db: (globalThis as any).__fakeDb }));
vi.mock('../src/lib/audit-log.js', () => ({ logAction: vi.fn(), logBatchAction: vi.fn(), logError: vi.fn() }));
vi.mock('../src/lib/user-session.js', () => ({ getUser: () => (globalThis as any).__user }));
vi.mock('../src/lib/ownership.js', () => ({
  assertCrawlResultOwnership: vi.fn(async () => {}),
  assertProductOwnership: vi.fn(async () => {}),
  OwnershipError: class extends Error {},
}));
vi.mock('../src/services/inventory-sync.js', () => ({ syncAllInventory: vi.fn(async () => []) }));
vi.mock('../src/lib/job-store.js', () => ({
  jobStore: { get: async () => undefined, set: async () => {}, update: async () => {}, getRunning: async () => [] },
}));

const store = vi.hoisted(() => {
  const tables = new Map<unknown, any[]>();
  const nextId = new Map<unknown, number>();
  const rowsOf = (t: unknown) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t)!; };
  const state = { tables, nextId, rowsOf, schema: null as any, writes: [] as string[] };
  const attach = (name: string, row: any, withSpec: any) => {
    if (!row || !withSpec) return row;
    const out = { ...row };
    if (name === 'products' && withSpec.listings) out.listings = rowsOf(state.schema.platformListings).filter((l: any) => l.productId === row.id).map((l: any) => ({ ...l }));
    return out;
  };
  (globalThis as any).__fakeDb = {
    query: new Proxy({}, {
      get: (_t, name: string) => ({
        findFirst: async ({ where, with: w }: any = {}) => {
          const row = rowsOf(state.schema[name]).find((r: any) => (where ? where(r) : true));
          return attach(name, row ? structuredClone(row) : undefined, w);
        },
        findMany: async ({ where, with: w }: any = {}) =>
          rowsOf(state.schema[name]).filter((r: any) => (where ? where(r) : true)).map((r: any) => attach(name, structuredClone(r), w)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: any) => {
        state.writes.push('insert');
        const id = (nextId.get(table) ?? 9000) + 1;
        nextId.set(table, id);
        rowsOf(table).push({ id, ...structuredClone(v) });
        const done = Promise.resolve(undefined);
        return { returning: async () => [structuredClone(rowsOf(table).at(-1))], then: done.then.bind(done) };
      },
    }),
    update: (table: unknown) => ({
      set: (v: any) => ({
        where: (pred: (r: any) => boolean) => {
          state.writes.push('update');
          rowsOf(table).filter(pred).forEach(r => Object.assign(r, structuredClone(v)));
          const done = Promise.resolve(undefined);
          return { returning: async () => [], then: done.then.bind(done) };
        },
      }),
    }),
    delete: () => ({ where: async () => { state.writes.push('delete'); } }),
    execute: async () => ({ rows: [{ max_id: 0 }] }),
  };
  return state;
});

import * as schema from '../src/db/schema.js';
import Fastify from 'fastify';
import { Eta } from 'eta';
import axios from 'axios';
import {
  planReconciliation, applyReconcilePlan, reconcileListings, loadCsvProducts, PRICE_TOLERANCE,
  type ExternalListing, type InternalProduct,
} from '../src/services/listing-reconcile.js';
import { listingRoutes } from '../src/routes/listings.js';
import { PIPELINE_TABS } from '../src/services/product-pipeline.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { ShopifyClient } from '../src/platforms/shopify/ShopifyClient.js';

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.platformListings, schema.pricingSettings, schema.platformTokens]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;
(globalThis as any).__user = { id: 'admin', name: 'Admin', isAdmin: true };

const ebayItem = (externalId: string, sku: string, price: number): ExternalListing =>
  ({ platform: 'ebay', externalId, sku, title: 't', price, currency: 'USD', url: `https://www.ebay.com/itm/${externalId}` });
const shopifyItem = (externalId: string, sku: string, price: number): ExternalListing =>
  ({ platform: 'shopify', externalId, sku, title: 't', price, currency: 'USD', url: `https://shop.test/products/${externalId}` });

function internal(overrides: Partial<InternalProduct> = {}): InternalProduct {
  return {
    id: 1, sku: 'PMC-00001', title: 'CSV product', productCode: 'TOYBOX-1', uploadKey: 'upload-1#3',
    expected: { ebay: 36.1, shopify: 25.4 }, listings: [], ...overrides,
  };
}

beforeEach(() => {
  store.tables.clear();
  store.nextId.clear();
  store.writes = [];
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, { DATABASE_URL: 'postgres://mock', SHOPIFY_STORE_URL: 'shop.test', SHOPIFY_ACCESS_TOKEN: 'shpat_mock', EBAY_ENVIRONMENT: 'PRODUCTION' });
  (globalThis as any).__user = { id: 'admin', name: 'Admin', isAdmin: true };
  vi.restoreAllMocks();
});

describe('1. READ-ONLY 감사 · 매칭 우선순위', () => {
  it('내부 ID → SKU → CSV 상품코드 → uploadId+행 순서로만 매칭하고 상품명으로는 매칭하지 않음', () => {
    const products: InternalProduct[] = [
      internal({ id: 1, sku: 'PMC-1', listings: [{ id: 11, platform: 'ebay', status: 'error', platformItemId: 'E-STORED', listingUrl: null, price: '36.1', quantity: 5 }] }),
      internal({ id: 2, sku: 'PMC-2', productCode: 'CODE-2' }),
      internal({ id: 3, sku: 'PMC-3', productCode: 'CODE-3', uploadKey: 'upload-1#7' }),
      internal({ id: 4, sku: 'PMC-4', productCode: null, uploadKey: null }),
    ];
    const plan = planReconciliation(products, {
      ebay: [ebayItem('E-STORED', 'OTHER-SKU', 36.1), ebayItem('E2', 'CODE-2', 36.1), ebayItem('E3', 'upload-1#7', 36.1), ebayItem('E9', '동일 상품명', 36.1)],
      shopify: [shopifyItem('S1', 'PMC-1', 25.4)],
    });
    const row = (id: number) => plan.rows.find(r => r.productId === id)!;
    expect(row(1).ebay).toMatchObject({ action: 'LINK', externalId: 'E-STORED', matchedBy: 'INTERNAL_ID' });
    expect(row(1).shopify).toMatchObject({ action: 'LINK', externalId: 'S1', matchedBy: 'SKU' });
    expect(row(2).ebay).toMatchObject({ action: 'LINK', externalId: 'E2', matchedBy: 'PRODUCT_CODE' });
    expect(row(3).ebay).toMatchObject({ action: 'LINK', externalId: 'E3', matchedBy: 'UPLOAD_ROW' });
    expect(row(4).ebay.action).toBe('NOT_LISTED');   // 상품명이 같아도 자동 매칭 없음
    expect(row(4).status).toBe('NONE');
  });

  it('SKU 없음 · 같은 SKU 2개 · 다른 상품에 이미 연결 · 저장된 ID가 실제 목록에 없음 → MATCH_REQUIRED (write 대상 아님)', () => {
    const plan = planReconciliation([
      internal({ id: 1, sku: '', productCode: null, uploadKey: null }),
      internal({ id: 2, sku: 'DUP' }),
      internal({ id: 3, sku: 'PMC-3' }),
      internal({ id: 4, sku: 'PMC-3-B', productCode: 'PMC-3', uploadKey: null }),
      internal({ id: 5, sku: 'PMC-5', listings: [{ id: 15, platform: 'ebay', status: 'active', platformItemId: 'GONE', listingUrl: 'u', price: '36.1', quantity: 5 }] }),
    ], {
      ebay: [ebayItem('D1', 'DUP', 36.1), ebayItem('D2', 'DUP', 36.1), ebayItem('E3', 'PMC-3', 36.1)],
      shopify: [],
    });
    const row = (id: number) => plan.rows.find(r => r.productId === id)!;
    expect(row(1).ebay).toMatchObject({ action: 'MATCH_REQUIRED', reason: 'SKU가 없어 자동 연결할 수 없습니다' });
    expect(row(2).ebay.reason).toContain('같은 식별자(DUP) 상품이 2개 이상');
    expect([row(3).ebay.action, row(4).ebay.action]).toEqual(['MATCH_REQUIRED', 'MATCH_REQUIRED']);   // 한 외부 상품에 내부 2개
    expect(row(4).ebay.reason).toContain('다른 내부 상품');
    expect(row(5).ebay.reason).toContain('실제 목록에 없습니다');
    expect(plan.summary.matchRequired).toBe(5);
    expect(plan.summary.plannedUpdates).toBe(0);
  });

  it('가격이 기대 등록가 범위 밖이거나 통화가 USD가 아니면 자동 연결하지 않음', () => {
    const plan = planReconciliation([
      internal({ id: 1, sku: 'PMC-1' }),
      internal({ id: 2, sku: 'PMC-2' }),
      internal({ id: 3, sku: 'PMC-3', expected: { ebay: null, shopify: null } }),
    ], {
      ebay: [ebayItem('E1', 'PMC-1', 36.1 * (1 + PRICE_TOLERANCE / 2)), ebayItem('E2', 'PMC-2', 99), { ...ebayItem('E3', 'PMC-3', 36.1) }],
      shopify: [{ ...shopifyItem('S2', 'PMC-2', 25.4), currency: 'KRW' }],
    });
    const row = (id: number) => plan.rows.find(r => r.productId === id)!;
    expect(row(1).ebay.action).toBe('LINK');                       // 허용 오차 안
    expect(row(2).ebay.reason).toContain('기대 등록가');            // 범위 밖
    expect(row(2).shopify.reason).toContain('통화가 USD가 아닙니다');
    expect(row(3).ebay.reason).toContain('기대 등록가를 계산할 수 없어');
  });

  it('고유 상품 기준 집계: 양쪽 · eBay만 · Shopify만 · 양쪽 없음 · 연결 누락 · 확인 필요', () => {
    const active = (platform: string, itemId: string, url: string) => ({ id: Math.random(), platform, status: 'active', platformItemId: itemId, listingUrl: url, price: '36.1', quantity: 5 });
    const plan = planReconciliation([
      internal({ id: 1, sku: 'A', listings: [active('ebay', 'E1', 'https://www.ebay.com/itm/E1'), active('shopify', 'S1', 'https://shop.test/products/S1')] }),
      internal({ id: 2, sku: 'B' }),
      internal({ id: 3, sku: 'C' }),
      internal({ id: 4, sku: 'D' }),
      internal({ id: 5, sku: '' , productCode: null, uploadKey: null }),
    ], {
      ebay: [ebayItem('E1', 'A', 36.1), ebayItem('E2', 'B', 36.1)],
      shopify: [shopifyItem('S1', 'A', 25.4), shopifyItem('S3', 'C', 25.4)],
    });
    expect(plan.summary).toEqual({ products: 5, both: 1, ebayOnly: 1, shopifyOnly: 1, none: 1, missingLink: 2, matchRequired: 1, plannedUpdates: 2 });
    expect(plan.external).toEqual({ ebay: 2, shopify: 2 });
    expect(plan.rows.map(r => r.status)).toEqual(['BOTH', 'EBAY_ONLY', 'SHOPIFY_ONLY', 'NONE', 'MATCH_REQUIRED']);
  });
});

describe('2. 보정 적용 (내부 DB만)', () => {
  const seedProduct = (id: number, sku: string, listings: any[] = []) => {
    store.rowsOf(schema.products).push({ id, sku, title: 'CSV ' + sku, metadata: { csvImport: { currency: 'USD', salePriceUsd: 25.4 } } });
    listings.forEach(l => store.rowsOf(schema.platformListings).push({ productId: id, ...l }));
  };

  it('확정 매칭만 반영: 기존 행은 active·외부 ID·URL·동기화 시각·실제가 snapshot 갱신, 행이 없으면 추가', async () => {
    seedProduct(1, 'PMC-1', [{ id: 11, platform: 'ebay', status: 'error', platformItemId: null, listingUrl: null, price: '36.1', quantity: 5, platformData: { pricing: { source: 'CSV_USD_PLUS_SHIPPING' } } }]);
    const products = [internal({ id: 1, sku: 'PMC-1', listings: [{ id: 11, platform: 'ebay', status: 'error', platformItemId: null, listingUrl: null, price: '36.1', quantity: 5 }] })];
    const plan = planReconciliation(products, { ebay: [ebayItem('E1', 'PMC-1', 36.1)], shopify: [shopifyItem('S1', 'PMC-1', 25.4)] });
    const result = await applyReconcilePlan(plan, products);

    expect(result).toEqual({ updated: 1, inserted: 1 });
    const ebayRow = store.rowsOf(schema.platformListings).find((l: any) => l.platform === 'ebay');
    expect(ebayRow).toMatchObject({ status: 'active', platformItemId: 'E1', listingUrl: 'https://www.ebay.com/itm/E1' });
    expect(ebayRow.lastSyncedAt).toBeInstanceOf(Date);
    expect(ebayRow.platformData).toMatchObject({
      pricing: { source: 'CSV_USD_PLUS_SHIPPING' },   // 기존 가격 기록 보존
      reconciled: { source: 'PLATFORM_RECONCILE', matchedBy: 'SKU', externalId: 'E1', actualPrice: 36.1 },
    });
    expect(ebayRow.price).toBe('36.1');   // 내부 가격은 수정하지 않음
    const shopifyRow = store.rowsOf(schema.platformListings).find((l: any) => l.platform === 'shopify');
    expect(shopifyRow).toMatchObject({ status: 'active', platformItemId: 'S1', price: '25.4', platformSku: 'PMC-1', quantity: 5 });
  });

  it('같은 동기화를 두 번 실행해도 결과 동일 · 이미 정상인 상품은 write 0 · 불확실 매칭 write 0', async () => {
    const fetchEbay = async () => [ebayItem('E1', 'PMC-1', 36.1), ebayItem('D1', 'DUP', 36.1), ebayItem('D2', 'DUP', 36.1)];
    const fetchShopify = async () => [shopifyItem('S1', 'PMC-1', 25.4)];
    const rows = [
      internal({ id: 1, sku: 'PMC-1' }),
      internal({ id: 2, sku: 'DUP' }),
    ];
    const loadProducts = async () => rows.map(r => ({
      ...r,
      listings: store.rowsOf(schema.platformListings).filter((l: any) => l.productId === r.id).map((l: any) => ({ ...l })),
    }));
    seedProduct(1, 'PMC-1');
    seedProduct(2, 'DUP');

    const first = await reconcileListings({ dryRun: false }, { loadProducts, fetchEbay, fetchShopify });
    expect([first.updated, first.inserted, first.summary.matchRequired]).toEqual([0, 2, 1]);
    const afterFirst = structuredClone(store.rowsOf(schema.platformListings));

    store.writes = [];
    const second = await reconcileListings({ dryRun: false }, { loadProducts, fetchEbay, fetchShopify });
    expect([second.updated, second.inserted]).toEqual([0, 0]);
    expect(store.writes).toEqual([]);   // 이미 정상 → DB write 0
    //   상품 상태 집계는 동일, 보정 대상만 0으로 줄어든다
    const statusOnly = (x: any) => ({ products: x.products, both: x.both, ebayOnly: x.ebayOnly, shopifyOnly: x.shopifyOnly, none: x.none, matchRequired: x.matchRequired });
    expect(statusOnly(second.summary)).toEqual(statusOnly(first.summary));
    expect([second.summary.missingLink, second.summary.plannedUpdates]).toEqual([0, 0]);
    expect(second.rows.map(r => r.status)).toEqual(first.rows.map(r => r.status));
    expect(store.rowsOf(schema.platformListings)).toEqual(afterFirst);
    expect(store.rowsOf(schema.platformListings).some((l: any) => l.productId === 2)).toBe(false);   // 불확실은 연결하지 않음
  });

  it('dryRun(기본)은 DB write 0', async () => {
    seedProduct(1, 'PMC-1');
    const result = await reconcileListings({}, {
      loadProducts: async () => [internal({ id: 1, sku: 'PMC-1' })],
      fetchEbay: async () => [ebayItem('E1', 'PMC-1', 36.1)],
      fetchShopify: async () => [shopifyItem('S1', 'PMC-1', 25.4)],
    });
    expect([result.applied, result.summary.plannedUpdates, store.writes.length]).toEqual([false, 2, 0]);
  });

  it('loadCsvProducts는 신규 USD CSV 상품만 (레거시 제외)', async () => {
    store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
    seedProduct(1, 'PMC-1');
    store.rowsOf(schema.products).push({ id: 2, sku: 'PMC-2', title: 'legacy', costPrice: '30000', metadata: null });
    const loaded = await loadCsvProducts();
    expect(loaded.map(p => p.id)).toEqual([1]);
  });
});

describe('3. API · 플랫폼 쓰기 0', () => {
  async function app() {
    const instance = Fastify();
    await instance.register(listingRoutes, { prefix: '/api' });
    return instance;
  }

  it('POST /api/listings/reconcile: 관리자만, dryRun 기본, 플랫폼 조회는 읽기 호출만', async () => {
    const getActive = vi.spyOn(EbayClient.prototype, 'getActiveListings').mockResolvedValue([{ itemId: 'E1', sku: 'PMC-1', title: 't', price: '36.10', quantity: '5' }]);
    const getAll = vi.spyOn(ShopifyClient.prototype, 'getAllProducts').mockResolvedValue([{ id: 'S1', handle: 'h', title: 't', variants: [{ sku: 'PMC-1', price: '25.40' }] }]);
    const writeSpies = (['post', 'put', 'patch', 'delete'] as const).map(m => vi.spyOn(axios, m).mockRejectedValue(new Error('REAL WRITE')));
    const addItem = vi.spyOn(EbayClient.prototype, 'createListing').mockRejectedValue(new Error('AddItem 금지'));
    const shopifyCreate = vi.spyOn(ShopifyClient.prototype, 'createListing').mockRejectedValue(new Error('생성 금지'));
    store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
    store.rowsOf(schema.products).push({ id: 1, sku: 'PMC-1', title: 'CSV', metadata: { csvImport: { currency: 'USD', salePriceUsd: 25.4 } } });

    const server = await app();
    const dry = await server.inject({ method: 'POST', url: '/api/listings/reconcile', payload: {} });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ applied: false, updated: 0, inserted: 0, external: { ebay: 1, shopify: 1 } });
    expect(store.writes).toEqual([]);

    (globalThis as any).__user = { id: 'staff', name: 'Staff', isAdmin: false };
    expect((await server.inject({ method: 'POST', url: '/api/listings/reconcile', payload: {} })).statusCode).toBe(403);
    (globalThis as any).__user = null;
    expect((await server.inject({ method: 'POST', url: '/api/listings/reconcile', payload: {} })).statusCode).toBe(401);
    await server.close();

    expect([getActive.mock.calls.length, getAll.mock.calls.length]).toEqual([1, 1]);
    expect(writeSpies.every(s => s.mock.calls.length === 0)).toBe(true);
    expect([addItem.mock.calls.length, shopifyCreate.mock.calls.length]).toEqual([0, 0]);
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/listing-reconcile.ts'), 'utf-8');
    expect(src).not.toMatch(/\.createListing\(|\.updateListing\(|\.deleteListing\(|\.updateInventory\(|'AddItem'/);
    expect(src).toMatch(/getActiveListings\(\)[\s\S]*getAllProducts\(\)/);   // 읽기 API만 사용
  });
});

describe('4. 화면: 동기화 버튼 (상태 badge·탭 집계는 product-pipeline 테스트에서 검증)', () => {
  it('상품 관리 화면에 실제 플랫폼 상태 동기화 버튼과 dry run 미리보기가 있다', () => {
    const counts = { LISTED_BOTH: 2, EBAY_ONLY: 1, SHOPIFY_ONLY: 0, READY: 1, FAILED: 0, PROCESSING: 0, CANCELLED: 0, total: 4 };
    const html = new Eta({ views: path.join(process.cwd(), 'views') }).render('./dashboard', {
      step: 0, user: { id: 'admin', name: 'Admin', isAdmin: true },
      stats: { totalProducts: 4, productsByStatus: {}, totalListings: 0, listingsByPlatform: {}, listingsByStatus: {}, crawlByStatus: {} },
      allItems: [], recentCrawlResults: [], activeJobs: [], staleJobs: 0,
      pipeline: counts, pipelineTabs: PIPELINE_TABS, uploadFilters: [], crawlWaiting: 0,
      filters: { status: 'ALL', uploadId: 'ALL' },
      releaseGuard: { shippingPricingEnabled: true, pricingDisabledCount: 0 },
    });
    expect(html).toContain('id="btn-reconcile"');
    expect(html).toContain("fetch('/api/listings/reconcile'");
    expect(html).toContain('body: JSON.stringify({ dryRun: true })');
    expect(html).toContain('내부 DB 연결 보정 예정: ');
  });

  it('이미 가져온 crawl 행은 업로드 대기 목록·재가져오기 상태 되돌림에서 제외', () => {
    const pages = fs.readFileSync(path.join(process.cwd(), 'src/routes/pages.ts'), 'utf-8');
    expect(pages).toContain("and(eq(crawlResults.status, 'new'), isNull(crawlResults.productId))");
    const importRoute = fs.readFileSync(path.join(process.cwd(), 'src/routes/crawl-results.ts'), 'utf-8');
    expect(importRoute).toContain("status: existing.productId ? existing.status : 'new'");
  });
});
