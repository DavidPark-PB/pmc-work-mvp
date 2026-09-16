/**
 * Phase 2.4 — 신규 USD CSV: eBay 중복 등록 방지 → eBay 성공 후 Shopify 순차 등록
 * 가격: eBay = CSV 판매가 + 국제배송비 / Shopify = CSV 판매가 그대로 (Shopify checkout 배송비 별도, eBay 정책 배송비 미반영)
 * eBay 정책 목록은 getFulfillmentPolicies mock, GetMyeBaySelling/AddItem은 callTradingAPI spy, Shopify는 callGraphQL/postWithRetry spy (실호출 없음)
 * DB·설정·번역 mock, main service 견적은 fake fetch
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('../src/services/translate.js', () => ({
  translateProduct: vi.fn(async () => ({ title: 'GEMINI REWRITTEN TITLE', description: '<p>desc</p>', productType: 'Toy', tags: [] })),
}));
vi.mock('../src/services/description.js', () => ({
  getDescriptionTemplate: vi.fn(async () => ''),
  buildPlatformDescription: (d: string) => d,
}));
vi.mock('../src/lib/csv-mapping-ai.js', () => ({ detectMappingWithAI: vi.fn(async () => null) }));
vi.mock('../src/lib/audit-log.js', () => ({ logAction: vi.fn(), logBatchAction: vi.fn(), logError: vi.fn() }));
vi.mock('../src/lib/user-session.js', () => ({ getUser: () => ({ id: 'admin', name: 'Admin', isAdmin: true }) }));
vi.mock('../src/lib/ownership.js', () => ({
  assertCrawlResultOwnership: vi.fn(async () => {}),
  assertProductOwnership: vi.fn(async () => {}),
  OwnershipError: class extends Error {},
}));
vi.mock('../src/services/inventory-sync.js', () => ({ syncAllInventory: vi.fn(async () => []) }));
vi.mock('../src/lib/job-store.js', () => {
  const jobs = new Map<string, any>();
  (globalThis as any).__jobs = jobs;
  return { jobStore: {
    get: async (id: string) => (jobs.has(id) ? structuredClone(jobs.get(id)) : undefined),
    set: async (id: string, job: any) => { jobs.set(id, structuredClone(job)); },
    update: async (id: string, patch: any) => { jobs.set(id, { ...jobs.get(id), ...structuredClone(patch) }); },
    getRunning: async () => [],
  } };
});

const store = vi.hoisted(() => {
  const tables = new Map<unknown, any[]>();
  const nextId = new Map<unknown, number>();
  const rowsOf = (t: unknown) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t)!; };
  const state = { tables, nextId, rowsOf, schema: null as any, queries: [] as string[] };
  const attach = (tableName: string, row: any, withSpec: any) => {
    if (!row || !withSpec) return row;
    const s = state.schema;
    const out = { ...row };
    if (tableName === 'products' && withSpec.images) out.images = rowsOf(s.productImages).filter((i: any) => i.productId === row.id);
    if (tableName === 'platformListings' && withSpec.product) {
      out.product = attach('products', rowsOf(s.products).find((x: any) => x.id === row.productId), withSpec.product.with);
    }
    return out;
  };
  (globalThis as any).__fakeDb = {
    query: new Proxy({}, {
      get: (_t, name: string) => ({
        findFirst: async ({ where, with: withSpec }: any = {}) => {
          state.queries.push(`${name}.findFirst`);
          const row = rowsOf(state.schema[name]).find((r: any) => (where ? where(r) : true));
          return attach(name, row ? structuredClone(row) : undefined, withSpec);
        },
        findMany: async ({ where, with: withSpec }: any = {}) => { state.queries.push(`${name}.findMany`); return rowsOf(state.schema[name]).filter((r: any) => (where ? where(r) : true)).map((r: any) => attach(name, structuredClone(r), withSpec)); },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: any) => {
        const id = (nextId.get(table) ?? 1000) + 1;
        nextId.set(table, id);
        const row = { id, ...structuredClone(v) };
        rowsOf(table).push(row);
        const done = Promise.resolve(undefined);
        return { returning: async () => [structuredClone(row)], onConflictDoUpdate: async () => {}, then: done.then.bind(done) };
      },
    }),
    update: (table: unknown) => ({
      set: (v: any) => ({
        where: (pred: (r: any) => boolean) => {
          const hit = rowsOf(table).filter(pred);
          hit.forEach(r => Object.assign(r, structuredClone(v)));
          const done = Promise.resolve(undefined);
          return { returning: async () => structuredClone(hit), then: done.then.bind(done) };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (pred: (r: any) => boolean) => {
        const rows = rowsOf(table);
        for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) rows.splice(i, 1);
      },
    }),
    execute: async () => ({ rows: [{ max_id: rowsOf(state.schema?.products).length }] }),
  };
  return state;
});

import * as schema from '../src/db/schema.js';
import Fastify from 'fastify';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import axios from 'axios';
import { parseCsvRawText, detectFixedHeaderMapping, detectMappingByKeyword, applyMapping, buildImportPreview, describeRowShipping, findDuplicateCsvRows } from '../src/lib/csv-parser.js';
import { importFromCrawl, createListing, retryListing, relistListing, EBAY_SUBMISSION_SETTLE_MS } from '../src/services/listing-service.js';
import { createEbayDuplicateChecker } from '../src/services/ebay-duplicate-check.js';
import { resolveDisplayPrices, readProductCsvMetadata } from '../src/services/listing-price.js';
import { activeListResponse, FAILED_ACTIVE_LIST } from './fixtures/ebay-trading.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { uploadRoutes } from '../src/routes/upload.js';
import { crawlResultRoutes } from '../src/routes/crawl-results.js';
import { pageRoutes } from '../src/routes/pages.js';
import { listingRoutes, listingJobTimers } from '../src/routes/listings.js';
import { ShopifyClient } from '../src/platforms/shopify/ShopifyClient.js';
import { buildCsvListingPlan, defaultCsvPlatforms, summarizeProductResults, countResults, resultLabel, resultStatus } from '../public/js/listing-plan.js';
import { getShippingPricingConfig, publicShippingPricingConfig } from '../src/lib/shipping-config.js';
import {
  buildShippingPolicyViews, classifyFulfillmentPolicy, getShippingPolicies, resetShippingPolicyCache, resolveCsvShippingPolicy, SHIPPING_POLICY_CACHE_TTL_MS,
} from '../src/services/ebay-shipping-policies.js';
import { formatBuyerShipping, policyOptionLabel, buyerTotalLabel, groupShippingPolicies, importButtonState, createPolicySelection, isPersistedPolicy, POLICY_PLACEHOLDER_LABEL, POLICY_SAVING_LABEL } from '../public/js/import-selection.js';
import { FULFILLMENT_POLICIES, POLICY_IDS, policySnapshot } from './fixtures/ebay-policies.js';

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.crawlSources, schema.platformListings, schema.pricingSettings, schema.csvUploads, schema.platformTokens]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;

// ── fixtures ────────────────────────────────────────────
const QUOTE_TOKEN = 'policy-internal-token-0123456789abcdef';
const EBAY_OAUTH_TOKEN = 'v^1.1#i^1#SECRET-EBAY-OAUTH-' + 'z'.repeat(260);
const MAIN = 'https://main.policy.test';
const LEGACY_PROFILE_ID = '999999990014';
const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';
const HEADER = '상품명,환산가(USD),실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지';
const CSV = [HEADER,
  `Yu-Gi-Oh! Synergy Pack,25.4,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,`,
  `Tomica Plarail,60.1,1000,43,17,7,1023,1023,${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,`,
].join('\n');

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, {
    DATABASE_URL: 'postgres://mock', EBAY_ENVIRONMENT: 'PRODUCTION', EBAY_APP_ID: 'app', EBAY_CERT_ID: 'cert', EBAY_DEV_ID: 'dev',
    EBAY_SHIPPING_PROFILE_ID: LEGACY_PROFILE_ID, SHOPIFY_STORE_URL: 'diag-store.myshopify.com', SHOPIFY_ACCESS_TOKEN: 'shpat_diag_mock',
    MAIN_SERVICE_URL: MAIN, SHIPPING_QUOTE_INTERNAL_TOKEN: QUOTE_TOKEN,
    AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true', AUTO_LISTING_SHIPPING_SHADOW_ENABLED: 'false', AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '1300',
    AUTO_LISTING_KPL_US_SERVICE_CODE: 'KPL_SF_US', AUTO_LISTING_EGS_SERVICE_CODE: 'EGS_STD_US',
    ...overrides,
  });
}

const BRACKETS: Record<string, [number, number][]> = { KPL: [[0.5, 13900], [1, 18900], [1.5, 24900]], eGS: [[0.5, 17100], [1.5, 31400]] };
let fetchCalls: any[] = [];
const fakeFetch = vi.fn(async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, body });
  const hit = BRACKETS[body.provider].find(([kg]) => kg >= body.actualWeightKg - 1e-9)!;
  const quote = { ok: true, provider: body.provider, serviceCode: body.serviceCode, destinationCountry: 'US', chargeableWeightKg: body.actualWeightKg, appliedWeightBracketKg: hit[0], totalShippingCostKrw: hit[1], euVatKrw: 0, euHsFeeKrw: 0, rateVersionId: 4, rateEffectiveFrom: '2026-09-13' };
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, mode: 'raw', quote, blockedReason: null }) };
});

let addItemBodies: string[] = [];
let tradingCalls: string[] = [];
let policyFetches = 0;
let logs: string[] = [];
const startPriceOf = (b: string) => b.match(/<StartPrice currencyID="USD">([^<]+)<\/StartPrice>/)?.[1];
const profileOf = (b: string) => b.match(/<ShippingProfileID>([^<]+)<\/ShippingProfileID>/)?.[1];

beforeEach(() => {
  store.tables.clear();
  store.nextId.clear();
  store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
  store.rowsOf(schema.platformTokens).push({ id: 1, platform: 'ebay', accessToken: EBAY_OAUTH_TOKEN, refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() + 3600_000), metadata: null });
  setEnv();
  fetchCalls = [];
  addItemBodies = [];
  tradingCalls = [];
  policyFetches = 0;
  logs = [];
  vi.restoreAllMocks();
  resetShippingPolicyCache();
  vi.stubGlobal('fetch', fakeFetch);
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(EbayClient.prototype as any, 'suggestCategoryId').mockResolvedValue('261068');
  vi.spyOn(EbayClient.prototype, 'getFulfillmentPolicies').mockImplementation(async () => { policyFetches++; return structuredClone(FULFILLMENT_POLICIES); });
  vi.spyOn(EbayClient.prototype as any, 'callTradingAPI').mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    tradingCalls.push(callName);
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    addItemBodies.push(body);
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${700000 + addItemBodies.length}</ItemID></AddItemResponse>`;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function appWith(...routes: any[]) {
  const app = Fastify();
  for (const r of routes) await app.register(r, { prefix: '/api' });
  return app;
}

function seedUpload(uploadId = 'upload-p', id = 1) {
  const raw = parseCsvRawText(CSV);
  const rows = applyMapping(raw, detectFixedHeaderMapping(raw[0])!);
  store.rowsOf(schema.csvUploads).push({ id, uploadId, filename: `${uploadId}.csv`, rowCount: rows.length, status: 'mapped', parsedRows: rows });
  return rows;
}
const uploadRow = (uploadId = 'upload-p') => store.rowsOf(schema.csvUploads).find((u: any) => u.uploadId === uploadId);

async function quoteRows(app: any, uploadId = 'upload-p') {
  const res = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes', payload: { uploadId, selections: [{ index: 0, provider: 'KPL' }, { index: 1, provider: 'KPL' }] } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function selectPolicy(app: any, policyId: string, uploadId = 'upload-p') {
  return app.inject({ method: 'POST', url: '/api/upload/shipping-policy', payload: { uploadId, policyId } });
}

async function importRows(indices: number[], uploadId = 'upload-p') {
  const app = await appWith(crawlResultRoutes);
  const res = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId, selectedIndices: indices, shippingProviders: Object.fromEntries(indices.map(i => [i, 'KPL'])) } });
  await app.close();
  const ids: number[] = [];
  for (const id of res.json().crawlResultIds) ids.push(await importFromCrawl(id));
  return ids;
}

/** 견적 → 정책 선택 → import → product id */
async function preparedProducts(policy: 'free' | 'fixed790' | null) {
  seedUpload();
  const app = await appWith(uploadRoutes);
  await quoteRows(app);
  if (policy) expect((await selectPolicy(app, POLICY_IDS[policy])).statusCode).toBe(200);
  await app.close();
  return importRows([0, 1]);
}

function renderStep2(uploadId = 'upload-p') {
  const rows = uploadRow(uploadId).parsedRows;
  const preview = buildImportPreview(rows);
  return new Eta({ views: path.join(process.cwd(), 'views') }).render('./step2-import', {
    uploadId, rows: preview.rows, rowCount: preview.rows.length, priceHeader: preview.priceHeader,
    defaultSelectedCount: preview.defaultSelectedCount, errorRowCount: preview.errorRowCount,
    showShipping: preview.showShipping, shipping: publicShippingPricingConfig(getShippingPricingConfig()),
    shippingPolicy: rows.find((r: any) => r.priceCurrency === 'USD')?.shippingPolicy ?? null,
  });
}



// ── 신규 USD CSV: eBay 중복 방지 → Shopify 순차 등록 (mock only) ─────────────────
const calls: string[] = [];
const shopifyPayloads: any[] = [];
/** mock eBay 스토어의 활성 상품 (GetMyeBaySelling ActiveList가 반환) */
let ebayActive: { itemId: string; sku: string }[] = [];
let ebayMode: 'ok' | 'reject' | 'unknown' = 'ok';
let ebayLookup: 'ok' | 'fail' = 'ok';
let shopifyStore: { id: number; sku: string; handle: string }[] = [];
let shopifyFail = false;
let shopifyLookup: 'ok' | 'fail' = 'ok';
let failEbaySaves = 0;
let nextEbayItemId = 700001;
const POLICY_390_ID = '282283642014';
const fakeDb = (globalThis as any).__fakeDb;
const realUpdate = fakeDb.update;

beforeEach(() => {
  calls.length = 0; shopifyPayloads.length = 0;
  ebayActive = []; ebayMode = 'ok'; ebayLookup = 'ok';
  shopifyStore = []; shopifyFail = false; shopifyLookup = 'ok';
  failEbaySaves = 0; nextEbayItemId = 700001;
  listingJobTimers.sleep = async () => {};
  EbayClient.activeListPageDelayMs = 0;
  store.rowsOf(schema.pricingSettings).push({ id: 2, platform: 'shopify', marginRate: '0.25', exchangeRate: '1350.00', platformFeeRate: '0.05', defaultShippingKrw: '8000' });

  const withPolicy390 = structuredClone(FULFILLMENT_POLICIES) as any;
  const p390 = structuredClone(withPolicy390.fulfillmentPolicies.find((p: any) => p.fulfillmentPolicyId === POLICY_IDS.fixed790));
  p390.fulfillmentPolicyId = POLICY_390_ID;
  p390.name = '2026 shipping All Item 3.9 Copy';
  p390.shippingOptions[0].shippingServices = [{ ...p390.shippingOptions[0].shippingServices[0], shippingCost: { value: '3.9', currency: 'USD' } }];
  withPolicy390.fulfillmentPolicies.push(p390);
  vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockImplementation(async () => { policyFetches++; return structuredClone(withPolicy390); });

  vi.mocked((EbayClient.prototype as any).callTradingAPI).mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    tradingCalls.push(callName);
    calls.push('ebay:' + callName);
    if (callName === 'GetMyeBaySelling') return ebayLookup === 'fail' ? FAILED_ACTIVE_LIST : activeListResponse(ebayActive);
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    if (ebayMode === 'unknown') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    if (ebayMode === 'reject') return '<AddItemResponse><Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><LongMessage>mock eBay error</LongMessage></Errors></AddItemResponse>';
    addItemBodies.push(body);
    const itemId = String(nextEbayItemId++);
    ebayActive.push({ itemId, sku: body.match(/<SKU>([^<]+)<\/SKU>/)![1] });
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${itemId}</ItemID></AddItemResponse>`;
  });

  vi.spyOn(ShopifyClient.prototype as any, 'callGraphQL').mockImplementation(async (...args: unknown[]) => {
    const [query, variables] = args as [string, any];
    if (!query.includes('productVariants')) throw new Error('unexpected Shopify GraphQL ' + query.slice(0, 40));
    const sku = JSON.parse(variables.q.slice(4));
    calls.push('shopify:lookup:' + sku);
    if (shopifyLookup === 'fail') return { errors: [{ message: 'Throttled' }] };
    return { data: { productVariants: { edges: shopifyStore.filter(p => p.sku.includes(sku)).map(p => ({ node: { sku: p.sku, product: { legacyResourceId: p.id, handle: p.handle } } })) } } };
  });
  vi.spyOn(ShopifyClient.prototype as any, 'postWithRetry').mockImplementation(async (url: unknown, data: any) => {
    calls.push('shopify:create');
    if (shopifyFail) throw new Error('Shopify 422 mock failure');
    shopifyPayloads.push({ url, data: structuredClone(data) });
    const product = { id: 880000 + shopifyPayloads.length, handle: 'mock-' + shopifyPayloads.length };
    shopifyStore.push({ ...product, sku: data.product.variants[0].sku });
    return { data: { product } };
  });
  vi.spyOn(ShopifyClient.prototype as any, 'suggestCategoryId').mockResolvedValue(null);

  //   DB 저장 추적 + eBay Item ID 저장 실패 주입
  fakeDb.update = (table: unknown) => {
    const builder = realUpdate(table);
    return {
      set: (values: any) => {
        if (table === schema.platformListings && values.status === 'active' && values.platformItemId) {
          if (failEbaySaves > 0 && values.platformData?.ebaySubmission?.state === 'LISTED') {
            failEbaySaves--;
            calls.push('db:save-failed:' + values.platformItemId);
            return { where: () => Promise.reject(new Error('DB connection lost')) };
          }
          calls.push('db:active:' + values.platformItemId);
        }
        return builder.set(values);
      },
    };
  };
});
afterEach(() => {
  fakeDb.update = realUpdate;
});

async function runJob(url: string, payload: any) {
  const app = await appWith(listingRoutes);
  const res = await app.inject({ method: 'POST', url, payload });
  const jobs = (globalThis as any).__jobs as Map<string, any>;
  let job: any;
  //   실제 시간 대기 없이 background job 완료까지 이벤트 루프만 양보
  for (let i = 0; i < 20000; i++) { job = jobs.get(res.json().jobId); if (job?.status === 'done') break; await new Promise(r => setImmediate(r)); }
  await app.close();
  expect(job?.status).toBe('done');
  return { job, response: res.json() };
}
const create = (productIds: number[], platforms: string[], csvPlatforms?: string[]) =>
  runJob('/api/listings/create', { productIds, platforms, ...(csvPlatforms ? { csvPlatforms } : {}) }).then(r => r.job);

function legacyProduct(id = 5000) {
  store.rowsOf(schema.products).push({ id, sku: 'PMC-0' + id, title: 'Legacy Pokemon Box', costPrice: '30000.00', metadata: null, condition: 'new', brand: 'Pokemon', productType: 'Toy' });
  store.rowsOf(schema.productImages).push({ id: id + 1, productId: id, url: 'https://thumbnail.coupangcdn.com/legacy.jpg' });
  return id;
}

const statuses = (job: any) => job.results.map((r: any) => [r.productId ?? r.crawlResultId, r.platform, r.status, r.code ?? null]);
const listingOf = (productId: number, platform: string) => store.rowsOf(schema.platformListings).find((l: any) => l.productId === productId && l.platform === platform);
const skuOf = (productId: number) => store.rowsOf(schema.products).find((p: any) => p.id === productId).sku;
const count = (prefix: string) => calls.filter(c => c.startsWith(prefix)).length;
const shopifyCalls = () => calls.filter(c => c.startsWith('shopify:'));

describe('1. 신규 CSV 플랫폼 기본 선택 · 확인창', () => {
  function renderDashboard(pricingEnabled: boolean) {
    const eta = new Eta({ views: path.join(process.cwd(), 'views') });
    const data = { marginRate: 0.2, exchangeRate: 1300, platformFeeRate: 0.18, defaultShippingKrw: 12000 };
    const allSettings = { ebay: data, shopify: data, alibaba: data, shopee: data };
    const shipping = { enabled: pricingEnabled, exchangeRate: 1300, serviceCodes: { KPL: 'KPL_SF_US', eGS: 'EGS_STD_US' } };
    const items = store.rowsOf(schema.products).map((p: any) => {
      const { costKrw, priceSource, ...prices } = resolveDisplayPrices({ costKrw: parseFloat(p.costPrice) || 0, csv: readProductCsvMetadata(p.metadata), allSettings, shipping });
      return { type: 'product', id: p.id, sku: p.sku, title: p.title, titleEn: p.title, titleKo: p.title, imageUrl: '', sourceUrl: '', sourceLabel: 'CSV', listings: '[]', status: 'draft', costKrw, priceSource, createdAt: new Date(), ...prices };
    });
    return eta.render('./dashboard', {
      step: 0, user: { id: 'admin', name: 'Admin', isAdmin: true },
      stats: { totalProducts: items.length, productsByStatus: {}, totalListings: 0, listingsByPlatform: {}, listingsByStatus: {}, crawlByStatus: {}, completedCount: 0, endedCount: 0 },
      allItems: items, recentCrawlResults: [], activeJobs: [],
      releaseGuard: { shippingPricingEnabled: pricingEnabled, pricingDisabledCount: 0 },
      view: 'all', filters: { status: 'ALL', uploadId: 'ALL', view: 'all' }, pipeline: { total: 2 }, pipelineTabs: [], uploadBatches: [], uploadFilters: [], filteredProductIds: [], crawlWaiting: 0, staleJobs: 0,
    });
  }

  it('신규 USD CSV 행은 eBay + Shopify 기본 체크, 레거시 행·상단 일괄 선택은 기존 그대로 (eBay만)', async () => {
    const [p0] = await preparedProducts('fixed790');
    legacyProduct();
    const html = renderDashboard(true);
    const menu = (id: number) => html.match(new RegExp(`id="ms-all-product-${id}"[\\s\\S]*?</div>\\s*</div>`))![0];
    const checked = (m: string) => [...m.matchAll(/<input type="checkbox" value="(\w+)"([^>]*)>/g)].filter(x => / checked/.test(x[2])).map(x => x[1]);
    expect(checked(menu(p0))).toEqual(['ebay', 'shopify']);
    expect(menu(p0)).toContain('<span class="ms-label">eBay+Shopify</span>');
    expect(checked(menu(5000))).toEqual(['ebay']);
    const toolbar = html.match(/id="all-platform-checks">[\s\S]*?<\/div>/)![0];
    expect(checked(toolbar)).toEqual(['ebay']);
    //   확인창: 신규 CSV 플랫폼 체크박스 (Shopify 해제 가능), 선택 변경 시 계획 재계산
    expect(html).toContain('<input type="checkbox" id="csv-plan-ebay-check" checked> eBay');
    expect(html).toContain('<input type="checkbox" id="csv-plan-shopify-check" checked> Shopify (eBay 성공 후)');
    expect(html).toContain('shopifyCheck.onchange = refresh;');
    expect(html).toContain('if (plan.csvPlatforms) body.csvPlatforms = plan.csvPlatforms;');
    expect(html).not.toMatch(/SHOPIFY_CSV_SHIPPING_MODE|shopifyShippingMode/);
  });

  it('확인창 계획: 선택 N · eBay 예정 N · Shopify 예정 N · 안내 / Shopify 해제 가능 / Shopify 단독 차단 / pricing=false 시작 불가', () => {
    const items = [{ csv: true, ebayReady: true, ebayListed: false }, { csv: true, ebayReady: true, ebayListed: false }, { csv: false, ebayReady: true, ebayListed: false }];
    expect(defaultCsvPlatforms()).toEqual(['ebay', 'shopify']);
    const both = buildCsvListingPlan({ items, csvPlatforms: ['ebay', 'shopify'], pricingEnabled: true });
    expect(both).toMatchObject({ show: true, selectedCount: 3, csvCount: 2, legacyCount: 1, ebayCount: 2, shopifyCount: 2, canStart: true, disabledReason: '', csvPlatforms: ['ebay', 'shopify'] });
    expect(both.notes).toEqual(['eBay 등록가에는 CSV 판매가와 국제배송비가 포함됩니다. eBay 배송정책 배송비는 등록가에 더하지 않습니다.', 'Shopify는 eBay 등록에 성공한 상품만 등록됩니다.', 'Shopify 상품가격은 CSV 판매가 그대로이며, 배송비는 Shopify checkout 설정으로 별도 청구됩니다.']);

    const ebayOnly = buildCsvListingPlan({ items, csvPlatforms: ['ebay'], pricingEnabled: true });
    expect(ebayOnly).toMatchObject({ ebayCount: 2, shopifyCount: 0, canStart: true, csvPlatforms: ['ebay'] });

    const shopifyOnly = buildCsvListingPlan({ items, csvPlatforms: ['shopify'], pricingEnabled: true });
    expect(shopifyOnly).toMatchObject({ shopifyCount: 0, canStart: false, disabledReason: '신규 CSV 상품은 eBay 등록 성공 후 Shopify에 등록할 수 있습니다.' });

    const off = buildCsvListingPlan({ items, csvPlatforms: ['ebay', 'shopify'], pricingEnabled: false });
    expect(off).toMatchObject({ canStart: false, disabledReason: '국제배송비 계산은 완료됐지만 실제 등록가 반영 기능이 비활성화되어 있습니다.' });

    expect(buildCsvListingPlan({ items: [items[2]], csvPlatforms: ['ebay', 'shopify'], pricingEnabled: false })).toMatchObject({ show: false, canStart: true });
  });

  it('서버: csvPlatforms로 Shopify 해제 → Shopify 호출 0 / Shopify 단독 → 미실행 (eBay 미등록) / 레거시는 platforms 그대로', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    legacyProduct();
    const job = await create([p0, 5000], ['ebay', 'shopify'], ['ebay']);
    expect(statuses(job)).toEqual([[p0, 'ebay', 'SUCCESS', null], [5000, 'ebay', 'SUCCESS', null], [5000, 'shopify', 'SUCCESS', null]]);
    expect(job.total).toBe(3);
    expect(calls.filter(c => c.startsWith('shopify:lookup'))).toEqual([]);   // 레거시 Shopify는 SKU 조회 없이 기존 생성

    calls.length = 0;
    const alone = await create([p1], ['shopify'], ['shopify']);
    expect(statuses(alone)).toEqual([[p1, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED']]);
    expect(calls).toEqual([]);
    expect(listingOf(p1, 'shopify')).toBeUndefined();
    const app = await appWith(listingRoutes);
    const bad = await app.inject({ method: 'POST', url: '/api/listings/create', payload: { productIds: [p1], platforms: ['ebay'], csvPlatforms: ['amazon'] } });
    await app.close();
    expect([bad.statusCode, bad.json().jobId]).toEqual([400, undefined]);
  });
});

describe('2-3. eBay → Shopify 실행 조건', () => {
  it('pricing=false: eBay 0회(조회 포함) · Shopify 0회 · Shopify listing 행 0', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false' });
    const job = await create([p0, p1], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(calls).toEqual([]);
    expect(statuses(job)).toEqual([
      [p0, 'ebay', 'FAILED', 'SHIPPING_PRICING_DISABLED'], [p0, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED'],
      [p1, 'ebay', 'FAILED', 'SHIPPING_PRICING_DISABLED'], [p1, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED'],
    ]);
    expect([job.completed, job.failed, countResults(job.results).skipped]).toEqual([0, 2, 2]);
    expect(store.rowsOf(schema.platformListings)).toEqual([]);   // price 0 draft 포함 어떤 행도 만들지 않음
    expect(summarizeProductResults(job.results)[0].text).toBe('eBay 실패: 배송비 가격 반영 기능 비활성 · Shopify 미실행 · eBay 등록 필요');
  });

  it('정상: eBay 중복 조회 → AddItem → Item ID DB 저장 → Shopify SKU 조회 → Shopify 생성 (선택 순서와 무관), eBay $36.10 · Shopify $25.40', async () => {
    const [p0] = await preparedProducts('fixed790');
    const job = await create([p0], ['shopify', 'ebay'], ['shopify', 'ebay']);
    const sku = skuOf(p0);
    expect(calls).toEqual(['ebay:GetMyeBaySelling', 'ebay:AddItem', 'db:active:700001', `shopify:lookup:${sku}`, 'shopify:create', 'db:active:880001']);
    expect(statuses(job)).toEqual([[p0, 'ebay', 'SUCCESS', null], [p0, 'shopify', 'SUCCESS', null]]);
    expect(summarizeProductResults(job.results)[0].text).toBe('eBay 성공 · Shopify 성공');
    expect(startPriceOf(addItemBodies[0])).toBe('36.10');
    expect(addItemBodies[0]).toContain(`<SKU>${sku}</SKU>`);
    expect(shopifyPayloads[0].data.product.variants[0].price).toBe('25.40');
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'active', platformItemId: '700001', price: '36.1', platformData: { ebaySubmission: { state: 'LISTED', sku, attempt: 1, itemId: '700001' } } });
    expect(listingOf(p0, 'shopify')).toMatchObject({ status: 'active', platformItemId: '880001', price: '25.4' });
  });

  it('eBay 정책 $3.90 / $7.90 / 무료 모두 eBay $36.10 · Shopify $25.40 (정책 배송비 가산·차감 없음)', async () => {
    for (const policyId of [POLICY_390_ID, POLICY_IDS.fixed790, POLICY_IDS.free]) {
      store.tables.clear(); store.nextId.clear(); calls.length = 0; addItemBodies.length = 0; shopifyPayloads.length = 0; ebayActive = []; shopifyStore = [];
      store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
      store.rowsOf(schema.platformTokens).push({ id: 1, platform: 'ebay', accessToken: EBAY_OAUTH_TOKEN, refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() + 3600_000), metadata: null });
      resetShippingPolicyCache();
      seedUpload();
      const app = await appWith(uploadRoutes);
      await quoteRows(app);
      expect((await selectPolicy(app, policyId)).statusCode).toBe(200);
      await app.close();
      const [p0] = await importRows([0]);
      await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
      expect([startPriceOf(addItemBodies[0]), profileOf(addItemBodies[0]), shopifyPayloads[0].data.product.variants[0].price]).toEqual(['36.10', policyId, '25.40']);
    }
  });

  it('eBay AddItem 실패: Shopify 0회, Shopify listing 행 0, eBay 행 error(FAILED)', async () => {
    const [p0] = await preparedProducts('fixed790');
    ebayMode = 'reject';
    const job = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(calls).toEqual(['ebay:GetMyeBaySelling', 'ebay:AddItem']);
    expect(statuses(job)).toEqual([[p0, 'ebay', 'FAILED', null], [p0, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED']]);
    expect(listingOf(p0, 'shopify')).toBeUndefined();
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'error', platformData: { ebaySubmission: { state: 'FAILED' } } });
    expect(summarizeProductResults(job.results)[0].text).toBe('eBay 실패: eBay API 오류 · Shopify 미실행 · eBay 등록 필요');
  });

  it('eBay Item ID 저장 실패: Shopify 0회 → 재시도는 AddItem 0회 + 기존 Item ID 연결(ADOPTED_EXISTING) 후 Shopify', async () => {
    const [p0] = await preparedProducts('fixed790');
    failEbaySaves = 1;
    const first = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(calls).toEqual(['ebay:GetMyeBaySelling', 'ebay:AddItem', 'db:save-failed:700001']);
    expect(statuses(first)).toEqual([[p0, 'ebay', 'FAILED', 'EBAY_ITEM_SAVE_FAILED'], [p0, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED']]);
    expect(first.results[0].error).toContain('Item ID 700001');
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'pending', platformData: { ebaySubmission: { state: 'SAVE_FAILED', itemId: '700001' } } });
    expect(listingOf(p0, 'shopify')).toBeUndefined();

    //   retry 버튼 (pending 행)
    calls.length = 0;
    const retry = await runJob('/api/listings/retry', { listingIds: [listingOf(p0, 'ebay').id] }).then(r => r.job);
    expect(calls).toEqual(['ebay:GetMyeBaySelling', 'db:active:700001']);
    expect(addItemBodies).toHaveLength(1);
    expect(statuses(retry)).toEqual([[p0, 'ebay', 'SUCCESS', 'ADOPTED_EXISTING']]);
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'active', platformItemId: '700001', platformData: { ebaySubmission: { state: 'ADOPTED', itemId: '700001' } } });

    //   새 job: eBay는 DB active → 호출 없이 기존 등록, Shopify만 실행
    calls.length = 0;
    const next = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(next)).toEqual([[p0, 'ebay', 'ALREADY_LISTED', null], [p0, 'shopify', 'SUCCESS', null]]);
    expect(count('ebay:')).toBe(0);
    expect(shopifyCalls()).toEqual([`shopify:lookup:${skuOf(p0)}`, 'shopify:create']);
  });

  it('create 재요청도 같은 규칙: 저장 실패 후 새 create job → AddItem 0 · 연결 · 같은 job에서 Shopify 진행', async () => {
    const [p0] = await preparedProducts('fixed790');
    failEbaySaves = 1;
    await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    calls.length = 0;
    const again = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(again)).toEqual([[p0, 'ebay', 'SUCCESS', 'ADOPTED_EXISTING'], [p0, 'shopify', 'SUCCESS', null]]);
    expect(count('ebay:AddItem')).toBe(0);
    expect(addItemBodies).toHaveLength(1);
    expect(summarizeProductResults(again.results)[0].text).toBe('eBay 성공 (기존 상품 연결) · Shopify 성공');
  });

  it('AddItem 응답 불명(네트워크 오류): 활성 목록에 아직 없으면 30분 동안 재등록 차단, 이후에만 AddItem', async () => {
    const [p0] = await preparedProducts('fixed790');
    ebayMode = 'unknown';
    const first = await create([p0], ['ebay'], ['ebay']);
    expect(statuses(first)).toEqual([[p0, 'ebay', 'FAILED', 'EBAY_ADDITEM_UNCONFIRMED']]);
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'error', platformData: { ebaySubmission: { state: 'UNCONFIRMED' } } });

    ebayMode = 'ok';
    calls.length = 0;
    const blocked = await runJob('/api/listings/retry', { listingIds: [listingOf(p0, 'ebay').id] }).then(r => r.job);
    expect(statuses(blocked)).toEqual([[p0, 'ebay', 'FAILED', 'EBAY_DUPLICATE_CHECK_FAILED']]);
    expect(calls).toEqual(['ebay:GetMyeBaySelling']);

    //   취소해도 시도 기록은 남음
    const cancelApp = await appWith(listingRoutes);
    await cancelApp.inject({ method: 'POST', url: '/api/listings/cancel', payload: { listingIds: [listingOf(p0, 'ebay').id] } });
    await cancelApp.close();
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'draft', platformData: { ebaySubmission: { state: 'UNCONFIRMED' } } });

    listingOf(p0, 'ebay').platformData.ebaySubmission.startedAt = new Date(Date.now() - EBAY_SUBMISSION_SETTLE_MS - 1000).toISOString();
    calls.length = 0;
    const later = await create([p0], ['ebay'], ['ebay']);
    expect(statuses(later)).toEqual([[p0, 'ebay', 'SUCCESS', null]]);
    expect(calls).toEqual(['ebay:GetMyeBaySelling', 'ebay:AddItem', 'db:active:700001']);
    expect(listingOf(p0, 'ebay').platformData.ebaySubmission).toMatchObject({ state: 'LISTED', attempt: 2 });
  });

  it('eBay 중복 조회 실패 / 같은 SKU 활성 상품 2개: AddItem 0, Shopify 0, 조회는 job당 1회 (N+1 없음)', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    ebayLookup = 'fail';
    const job = await create([p0, p1], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(calls).toEqual(['ebay:GetMyeBaySelling']);
    expect(statuses(job)).toEqual([
      [p0, 'ebay', 'FAILED', 'EBAY_DUPLICATE_CHECK_FAILED'], [p0, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED'],
      [p1, 'ebay', 'FAILED', 'EBAY_DUPLICATE_CHECK_FAILED'], [p1, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED'],
    ]);
    expect(store.rowsOf(schema.platformListings)).toEqual([]);
    expect(summarizeProductResults(job.results)[0].text).toBe('eBay 실패: eBay 기존 상품 확인 실패 (중복 방지) · Shopify 미실행 · eBay 등록 필요');

    ebayLookup = 'ok';
    ebayActive = [{ itemId: '600001', sku: skuOf(p0) }, { itemId: '600002', sku: skuOf(p0) }];
    calls.length = 0;
    const dup = await create([p0, p1], ['ebay'], ['ebay']);
    expect(statuses(dup)).toEqual([[p0, 'ebay', 'FAILED', 'EBAY_DUPLICATE_CHECK_FAILED'], [p1, 'ebay', 'SUCCESS', null]]);
    expect(calls.filter(c => c === 'ebay:GetMyeBaySelling')).toHaveLength(1);   // 두 상품이 한 번의 조회 결과 공유
    expect(dup.results[0].error).toContain('활성 상품이 2개');
  });

  it('eBay 활성 목록 응답이 불완전(건수 불일치·ActiveList 없음)하면 불확실로 차단', async () => {
    const client = new EbayClient();
    vi.mocked((EbayClient.prototype as any).callTradingAPI).mockResolvedValueOnce(activeListResponse([{ itemId: '1', sku: 'A' }], { totalEntries: 2 }));
    await expect(client.getActiveSkuIndex()).rejects.toThrow('활성 리스팅 수 불일치');
    vi.mocked((EbayClient.prototype as any).callTradingAPI).mockResolvedValueOnce('<GetMyeBaySellingResponse><Ack>Success</Ack></GetMyeBaySellingResponse>');
    await expect(client.getActiveSkuIndex()).rejects.toThrow('ActiveList가 없습니다');
    vi.mocked((EbayClient.prototype as any).callTradingAPI)
      .mockResolvedValueOnce(activeListResponse([{ itemId: '1', sku: 'A' }], { totalPages: 2, totalEntries: 2 }))
      .mockResolvedValueOnce(activeListResponse([{ itemId: '2', sku: 'B' }, { itemId: '3' }], { totalPages: 2, totalEntries: 3 }));
    await expect(client.getActiveSkuIndex()).rejects.toThrow('리스팅 수가 바뀌었습니다');
    vi.mocked((EbayClient.prototype as any).callTradingAPI)
      .mockResolvedValueOnce(activeListResponse([{ itemId: '1', sku: 'A' }], { totalPages: 2, totalEntries: 3 }))
      .mockResolvedValueOnce(activeListResponse([{ itemId: '2', sku: 'B' }, { itemId: '3' }], { totalPages: 2, totalEntries: 3 }));
    expect([...(await client.getActiveSkuIndex()).entries()]).toEqual([['A', ['1']], ['B', ['2']]]);
    const checker = createEbayDuplicateChecker(async () => { throw new Error('boom'); });
    await expect(checker.find('X')).rejects.toMatchObject({ code: 'EBAY_DUPLICATE_CHECK_FAILED' });
    await expect(checker.find('Y')).rejects.toMatchObject({ code: 'EBAY_DUPLICATE_CHECK_FAILED' });
    expect(checker.loadCount()).toBe(1);
  });

  it('eBay 기존 active (DB): eBay 호출 없이 Shopify 진행 / ended·error·draft·pending eBay는 Shopify 0회', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    await create([p0, p1], ['ebay'], ['ebay']);
    calls.length = 0;
    const job = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(job)).toEqual([[p0, 'ebay', 'ALREADY_LISTED', null], [p0, 'shopify', 'SUCCESS', null]]);
    expect(count('ebay:')).toBe(0);

    for (const status of ['ended', 'error', 'draft', 'pending']) {
      listingOf(p1, 'ebay').status = status;
      calls.length = 0;
      const alone = await create([p1], ['shopify'], ['shopify']);
      expect([status, statuses(alone)]).toEqual([status, [[p1, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED']]]);
      expect(calls).toEqual([]);
      await expect(createListing(p1, 'shopify')).rejects.toMatchObject({ code: 'EBAY_REQUIRED' });
    }
    expect(listingOf(p1, 'shopify')).toBeUndefined();
  });

  it('eBay ended → relist 성공한 뒤에만 Shopify: relist 실패면 Shopify 미실행, 성공하면 새 job에서 Shopify만', async () => {
    const [p0] = await preparedProducts('fixed790');
    await create([p0], ['ebay'], ['ebay']);
    listingOf(p0, 'ebay').status = 'ended';
    ebayActive = [];   // eBay에서 종료된 상품은 활성 목록에 없음

    ebayMode = 'reject';
    calls.length = 0;
    const relistFail = await runJob('/api/listings/relist', { listingIds: [listingOf(p0, 'ebay').id] }).then(r => r.job);
    expect(statuses(relistFail)).toEqual([[p0, 'ebay', 'FAILED', null]]);
    const skipped = await create([p0], ['shopify'], ['shopify']);
    expect(statuses(skipped)).toEqual([[p0, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED']]);
    expect(shopifyCalls()).toEqual([]);

    listingOf(p0, 'ebay').status = 'ended';
    ebayMode = 'ok';
    calls.length = 0;
    const relist = await runJob('/api/listings/relist', { listingIds: [listingOf(p0, 'ebay').id] }).then(r => r.job);
    expect(statuses(relist)).toEqual([[p0, 'ebay', 'SUCCESS', null]]);
    expect(calls).toEqual(['ebay:GetMyeBaySelling', 'ebay:AddItem', 'db:active:700002']);
    calls.length = 0;
    const shopifyOnly = await create([p0], ['shopify'], ['shopify']);
    expect(statuses(shopifyOnly)).toEqual([[p0, 'shopify', 'SUCCESS', null]]);
    expect(count('ebay:')).toBe(0);
  });

  it('Shopify 기존 SKU: 생성 0회, 기존 상품 연결(ADOPTED_EXISTING) / Shopify 조회 실패: 생성 0회', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    shopifyStore = [{ id: 8812345, sku: skuOf(p0), handle: 'existing' }, { id: 8899999, sku: skuOf(p0) + '-B', handle: 'similar' }];
    const job = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(job)).toEqual([[p0, 'ebay', 'SUCCESS', null], [p0, 'shopify', 'SUCCESS', 'ADOPTED_EXISTING']]);
    expect(count('shopify:create')).toBe(0);
    expect(listingOf(p0, 'shopify')).toMatchObject({ status: 'active', platformItemId: '8812345', listingUrl: 'https://diag-store.myshopify.com/products/existing' });

    shopifyLookup = 'fail';
    const failed = await create([p1], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(failed)).toEqual([[p1, 'ebay', 'SUCCESS', null], [p1, 'shopify', 'FAILED', 'SHOPIFY_DUPLICATE_CHECK_FAILED']]);
    expect(count('shopify:create')).toBe(0);
  });

  it('Shopify 실패 후 재시도: eBay 재호출·재등록 없이 Shopify만 / 이미 둘 다 등록이면 API 0', async () => {
    const [p0] = await preparedProducts('fixed790');
    shopifyFail = true;
    const first = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(first)).toEqual([[p0, 'ebay', 'SUCCESS', null], [p0, 'shopify', 'FAILED', null]]);
    expect(summarizeProductResults(first.results)[0].text).toBe('eBay 성공 · Shopify 실패: Shopify API 오류');
    expect(listingOf(p0, 'ebay')).toMatchObject({ status: 'active', platformItemId: '700001' });

    shopifyFail = false;
    calls.length = 0;
    const retry = await runJob('/api/listings/retry', { listingIds: [listingOf(p0, 'shopify').id] }).then(r => r.job);
    expect(statuses(retry)).toEqual([[p0, 'shopify', 'SUCCESS', null]]);
    expect(calls).toEqual([`shopify:lookup:${skuOf(p0)}`, 'shopify:create', 'db:active:880001']);

    calls.length = 0;
    const dup = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(calls).toEqual([]);
    expect(statuses(dup).map((s: any[]) => s[2])).toEqual(['ALREADY_LISTED', 'ALREADY_LISTED']);
  });

  it('retry 버튼으로 [eBay error, Shopify 없음] 처리 시에도 eBay 먼저 · eBay 실패면 Shopify 실행 안 함', async () => {
    const [p0] = await preparedProducts('fixed790');
    ebayMode = 'reject';
    await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    ebayMode = 'reject';
    calls.length = 0;
    const again = await runJob('/api/listings/retry', { listingIds: [listingOf(p0, 'ebay').id] }).then(r => r.job);
    expect(statuses(again)).toEqual([[p0, 'ebay', 'FAILED', null]]);
    expect(shopifyCalls()).toEqual([]);
    //   eBay가 나중에 성공하면 새 job(결과 화면 "Shopify만 다시 실행")에서 Shopify 단계만
    ebayMode = 'ok';
    await runJob('/api/listings/retry', { listingIds: [listingOf(p0, 'ebay').id] });
    calls.length = 0;
    const shopifyOnly = await create([p0], ['shopify'], ['shopify']);
    expect(statuses(shopifyOnly)).toEqual([[p0, 'shopify', 'SUCCESS', null]]);
    expect(count('ebay:')).toBe(0);
  });

  it('혼합 batch: 상품 단위로 계속 진행, 레거시는 기존 독립 동작 (eBay 실패해도 Shopify, 중복 조회 없음)', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    delete store.rowsOf(schema.products).find((p: any) => p.id === p0).metadata.csvImport.shippingQuote;
    const legacy = legacyProduct();
    const job = await create([p0, legacy, p1], ['shopify', 'ebay'], ['ebay', 'shopify']);
    expect(statuses(job)).toEqual([
      [p0, 'ebay', 'FAILED', 'SHIPPING_QUOTE_MISSING'], [p0, 'shopify', 'SKIPPED_EBAY_REQUIRED', 'SKIPPED_EBAY_REQUIRED'],
      [legacy, 'shopify', 'SUCCESS', null], [legacy, 'ebay', 'SUCCESS', null],
      [p1, 'ebay', 'SUCCESS', null], [p1, 'shopify', 'SUCCESS', null],
    ]);
    expect(shopifyPayloads.find(p => p.data.product.variants[0].sku === 'PMC-05000').data.product.variants[0]).toMatchObject({ price: '31.12', weight: 500 });

    store.tables.clear();
    calls.length = 0;
    store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' }, { id: 2, platform: 'shopify', marginRate: '0.25', exchangeRate: '1350.00', platformFeeRate: '0.05', defaultShippingKrw: '8000' });
    store.rowsOf(schema.platformTokens).push({ id: 1, platform: 'ebay', accessToken: EBAY_OAUTH_TOKEN, refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() + 3600_000), metadata: null });
    legacyProduct();
    ebayMode = 'reject';
    const legacyJob = await create([5000], ['ebay', 'shopify'], ['ebay']);
    expect(statuses(legacyJob)).toEqual([[5000, 'ebay', 'FAILED', null], [5000, 'shopify', 'SUCCESS', null]]);
    expect(calls.slice(0, 2)).toEqual(['ebay:AddItem', 'shopify:create']);   // GetMyeBaySelling·Shopify SKU 조회 없음
    expect(calls.slice(2)).toEqual([expect.stringMatching(/^db:active:88/)]);
  });
});

describe('4. 결과 표시 · 미실행 기록', () => {
  it('SUCCESS / FAILED / SKIPPED 구분, 미실행은 "미실행 · eBay 등록 필요" + Shopify만 다시 실행 버튼, price 0 draft 없음', async () => {
    const [p0] = await preparedProducts('fixed790');
    ebayMode = 'reject';
    const job = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(job.results.map((r: any) => resultLabel(r))).toEqual(['실패: eBay API 오류', '미실행 · eBay 등록 필요']);
    expect(countResults(job.results)).toEqual({ success: 0, alreadyListed: 0, failed: 1, skipped: 1 });
    expect(store.rowsOf(schema.platformListings).filter((l: any) => l.platform === 'shopify' || l.price === '0')).toEqual([]);
    expect(resultStatus({ success: true })).toBe('SUCCESS');   // 이전 job(status 없음)

    const html = new Eta({ views: path.join(process.cwd(), 'views') }).render('./step5-results', { step: 5, job: { ...job, createdAt: new Date(), finishedAt: new Date() }, jobId: 'j' });
    expect(html.match(/data-result-status="(\w+)"/g)).toEqual(['data-result-status="FAILED"', 'data-result-status="SKIPPED_EBAY_REQUIRED"']);
    expect(html).toContain('미실행 · eBay 등록 필요');
    expect(html).toContain(`class="btn btn-secondary btn-xs retry-shopify-btn" data-product-id="${p0}"`);
    expect(html).toContain("csvPlatforms: ['shopify']");
    expect(html).toMatch(/<div class="number">1<\/div>\s*<div class="label">미실행<\/div>/);
    const progress = fs.readFileSync(path.join(process.cwd(), 'views/step4-progress.eta'), 'utf-8');
    expect(progress).toContain('LP.resultLabel(r)');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/listing-service.ts'), 'utf-8');
    expect(src).not.toContain('recordSkippedPlatform');
  });

  it('기존 job은 자동 재실행·삭제·성공 처리하지 않음 (서버 시작 시 job 재개 코드 없음)', () => {
    const routes = fs.readFileSync(path.join(process.cwd(), 'src/routes/listings.ts'), 'utf-8');
    const index = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
    expect(routes).not.toMatch(/getRunning\(/);
    expect(index).not.toMatch(/runListingJob|runRetryJob|runRelistJob|getRunning\(/);
  });
});

describe('5-6. Shopify 가격 · 배송비 이중청구 방지 · payload', () => {
  it('확정 가격 규칙: eBay = CSV $25.40 + 13,900원/1,300 = $36.10, Shopify = CSV $25.40 (국제배송비·정책 배송비 미포함) / 수동 판매가가 있어도 Shopify는 salePriceUsd', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    const job = await create([p0, p1], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(job).map((s: any[]) => s[2])).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
    expect(addItemBodies.map(startPriceOf)).toEqual(['36.10', '79.26']);
    expect(shopifyPayloads.map(p => p.data.product.variants[0].price)).toEqual(['25.40', '60.10']);
    //   eBay 최종가(국제배송비 포함)를 Shopify에 복사하지 않음
    for (const p of shopifyPayloads) expect(JSON.stringify(p)).not.toMatch(/36\.10|79\.26|10\.70|19\.16/);
    expect(listingOf(p0, 'shopify').platformData.pricing).toEqual({ source: 'CSV_USD_SALE_PRICE', salePrice: 25.4, ebayItemId: '700001' });
    expect(job.results.map((r: any) => r.code)).not.toContain('SHOPIFY_SHIPPING_POLICY_UNVERIFIED');

    //   수동 판매가 $27.00: eBay = 27.00 + 10.70 = 37.70 (기존 규칙), Shopify = CSV salePriceUsd 25.40
    store.tables.clear(); store.nextId.clear(); calls.length = 0; addItemBodies.length = 0; shopifyPayloads.length = 0; ebayActive = []; shopifyStore = [];
    store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' }, { id: 2, platform: 'shopify', marginRate: '0.25', exchangeRate: '1350.00', platformFeeRate: '0.05', defaultShippingKrw: '8000' });
    store.rowsOf(schema.platformTokens).push({ id: 1, platform: 'ebay', accessToken: EBAY_OAUTH_TOKEN, refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() + 3600_000), metadata: null });
    const [m0] = await preparedProducts('fixed790');
    Object.assign(store.rowsOf(schema.products).find((p: any) => p.id === m0).metadata.csvImport, {
      salePriceOverrideUsd: 27, salePriceOverrideHistory: [{ previousUsd: null, newUsd: 27, changedBy: 'Admin', changedAt: new Date().toISOString() }],
    });
    await create([m0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect([startPriceOf(addItemBodies[0]), shopifyPayloads[0].data.product.variants[0].price]).toEqual(['37.70', '25.40']);
  });

  it('Shopify 무료배송 확인·가격 일치 차단 없음: eBay 등록가가 달라도 Shopify는 CSV 판매가로 진행, 배송 프로필 지정·요율 변경 API 없음 (기본 프로필 사용)', async () => {
    const [p0] = await preparedProducts('fixed790');
    await create([p0], ['ebay'], ['ebay']);
    listingOf(p0, 'ebay').price = '99';   // 이전 규칙이면 SHOPIFY_PRICE_MISMATCH
    calls.length = 0;
    const job = await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    expect(statuses(job)).toEqual([[p0, 'ebay', 'ALREADY_LISTED', null], [p0, 'shopify', 'SUCCESS', null]]);
    expect(shopifyCalls()).toEqual([`shopify:lookup:${skuOf(p0)}`, 'shopify:create']);
    const payload = shopifyPayloads[0];
    expect(payload.url).toBe('/products.json');
    expect(JSON.stringify(payload)).not.toMatch(/delivery|profile|shipping_zone|shipping_rate|ShippingProfile/i);
    const src = ['src/services/listing-service.ts', 'src/platforms/shopify/ShopifyClient.ts', 'public/js/listing-plan.js', 'src/routes/pages.ts', 'views/dashboard.eta']
      .map(f => fs.readFileSync(path.join(process.cwd(), f), 'utf-8')).join('\n');
    expect(src).not.toMatch(/SHOPIFY_SHIPPING_POLICY_UNVERIFIED|SHOPIFY_SHIPPING_DOUBLE_CHARGE_RISK|SHOPIFY_PRICE_MISMATCH|FREE_SHIPPING_VERIFIED|deliveryProfile|shipping_zones/);
    expect(fs.existsSync(path.join(process.cwd(), 'src/services/shopify-shipping-audit.ts'))).toBe(false);
  });

  it('Shopify payload: 영문명 · R2 이미지 · SKU · 기존 재고 규칙 · 적용무게 · requiresShipping — eBay 정책/토큰/내부 URL 없음', async () => {
    const [p0] = await preparedProducts('fixed790');
    await create([p0], ['ebay', 'shopify'], ['ebay', 'shopify']);
    const product = shopifyPayloads[0].data.product;
    expect(product.title).toBe('Yu-Gi-Oh! Synergy Pack');
    expect(product.images).toEqual([{ src: `${R2}/TOYBOX-43037/main-1.jpg` }]);
    expect(product.variants).toEqual([{ price: '25.40', sku: skuOf(p0), inventory_quantity: 5, weight: 307, weight_unit: 'g', requires_shipping: true }]);
    const json = JSON.stringify(shopifyPayloads[0]);
    for (const leak of [POLICY_IDS.fixed790, 'ShippingProfile', 'shippingProfileId', 'shippingPolicy', 'Standard US $7.90', '"7.9', 'buyerShipping', '33.30', '44.00', QUOTE_TOKEN, MAIN, EBAY_OAUTH_TOKEN, 'refresh-secret']) {
      expect([leak, json.includes(leak)]).toEqual([leak, false]);
    }
    expect(listingOf(p0, 'shopify').platformData.pricing).toMatchObject({ source: 'CSV_USD_SALE_PRICE', salePrice: 25.4, ebayItemId: '700001' });
    expect(listingOf(p0, 'shopify').platformData.pricing.shippingPolicy).toBeUndefined();
  });
});

describe('2. CSV 안 SKU 중복 차단', () => {
  it('같은 상품코드 또는 같은 상품 URL 행은 미리보기에서 선택 불가, import batch는 400 CSV_DUPLICATE_SKU', async () => {
    const rows = seedUpload();
    const upload = uploadRow();
    const policy = policySnapshot('fixed790');
    const dupRows = [
      { ...rows[0], sourceProductCode: 'TOYBOX-43037', sourceRowNumber: 1 },
      { ...rows[1], sourceProductCode: 'TOYBOX-77589', sourceRowNumber: 2 },
      { ...rows[0], name: 'Yu-Gi-Oh! Synergy Pack (dup)', sourceProductCode: ' toybox-43037 ', sourceRowNumber: 3 },
      { ...rows[1], sourceProductCode: '', url: 'https://toybox.kr/shop/shopdetail.html?branduid=555', sourceRowNumber: 4 },
      { ...rows[1], sourceProductCode: '', url: 'https://toybox.kr/shop/shopdetail.html?branduid=555', sourceRowNumber: 5 },
    ];
    upload.parsedRows = dupRows.map(r => ({ ...r, shippingPolicy: policy }));
    expect([...findDuplicateCsvRows(dupRows).entries()].map(([i, d]) => [i, d.rowNumbers])).toEqual([[0, [1, 3]], [2, [1, 3]], [3, [4, 5]], [4, [4, 5]]]);

    const preview = buildImportPreview(dupRows);
    expect(preview.rows.map(r => [r.duplicateSku, r.defaultSelected])).toEqual([[true, false], [false, true], [true, false], [true, false], [true, false]]);
    expect(preview.rows[0].issues.at(-1)).toEqual({ code: 'CSV_DUPLICATE_SKU', level: 'error', message: 'CSV 안에 같은 상품코드(SKU) TOYBOX-43037가 2개 행(1, 3행)에 있어 가져올 수 없습니다. 중복 행을 정리한 뒤 다시 업로드하세요.' });
    const html = renderStep2();
    expect(html.match(/data-duplicate-sku="true"/g)).toHaveLength(4);
    expect(html).toContain("checkboxes.filter(cb => !cb.dataset.duplicateSku).map(indexOf)");

    const app = await appWith(crawlResultRoutes);
    const blocked = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId: 'upload-p', selectedIndices: [0, 1], shippingProviders: { 0: 'KPL', 1: 'KPL' } } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toMatchObject({ code: 'CSV_DUPLICATE_SKU', rows: [0] });
    expect(store.rowsOf(schema.crawlResults)).toEqual([]);
    const ok = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId: 'upload-p', selectedIndices: [1], shippingProviders: { 1: 'KPL' } } });
    await app.close();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().crawlResultIds).toHaveLength(1);
  });
});

describe('실제 외부 쓰기 0 · 공개 응답 비밀값 없음', () => {
  it('eBay/Shopify는 prototype mock만, axios 실제 네트워크 0 · 공개 HTML/JS/API 응답에 토큰·내부 URL 없음', async () => {
    const spies = (['post', 'put', 'delete', 'patch', 'get'] as const).map(m => vi.spyOn(axios, m).mockRejectedValue(new Error('REAL NETWORK CALL')));
    const [p0] = await preparedProducts('fixed790');
    const { job, response } = await runJob('/api/listings/create', { productIds: [p0], platforms: ['ebay', 'shopify'], csvPlatforms: ['ebay', 'shopify'] });
    expect(statuses(job).map((s: any[]) => s[2])).toEqual(['SUCCESS', 'SUCCESS']);
    expect(spies.every(s => s.mock.calls.length === 0)).toBe(true);
    expect(tradingCalls).toEqual(['GetMyeBaySelling', 'AddItem']);

    const views = new Eta({ views: path.join(process.cwd(), 'views') });
    const publicTexts = [
      JSON.stringify(response), JSON.stringify(job),
      views.render('./step5-results', { step: 5, job: { ...job, createdAt: new Date(), finishedAt: new Date() }, jobId: 'j' }),
      fs.readFileSync(path.join(process.cwd(), 'public/js/listing-plan.js'), 'utf-8'),
      fs.readFileSync(path.join(process.cwd(), 'views/dashboard.eta'), 'utf-8'),
      renderStep2(),
    ];
    for (const secret of [QUOTE_TOKEN, EBAY_OAUTH_TOKEN, 'refresh-secret', 'shpat_diag_mock', MAIN, 'SHIPPING_QUOTE_INTERNAL_TOKEN', 'SHOPIFY_ACCESS_TOKEN']) {
      expect([secret, publicTexts.some(t => t.includes(secret))]).toEqual([secret, false]);
    }
  });
});
