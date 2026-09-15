/**
 * Phase 2.3 — CSV upload별 eBay Shipping Policy 선택
 * eBay 정책 목록은 getFulfillmentPolicies / axios.get mock (READ-ONLY), AddItem은 callTradingAPI spy (실호출 없음)
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
vi.mock('../src/lib/job-store.js', () => ({
  jobStore: { get: async () => undefined, set: async () => {}, update: async () => {}, getRunning: async () => [] },
}));

const store = vi.hoisted(() => {
  const tables = new Map<unknown, any[]>();
  const nextId = new Map<unknown, number>();
  const rowsOf = (t: unknown) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t)!; };
  const state = { tables, nextId, rowsOf, schema: null as any };
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
          const row = rowsOf(state.schema[name]).find((r: any) => (where ? where(r) : true));
          return attach(name, row ? structuredClone(row) : undefined, withSpec);
        },
        findMany: async ({ where }: any = {}) => rowsOf(state.schema[name]).filter((r: any) => (where ? where(r) : true)).map((r: any) => structuredClone(r)),
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
import { parseCsvRawText, detectFixedHeaderMapping, detectMappingByKeyword, applyMapping, buildImportPreview, describeRowShipping } from '../src/lib/csv-parser.js';
import { importFromCrawl, createListing, retryListing, relistListing } from '../src/services/listing-service.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { uploadRoutes } from '../src/routes/upload.js';
import { crawlResultRoutes } from '../src/routes/crawl-results.js';
import { pageRoutes } from '../src/routes/pages.js';
import { getShippingPricingConfig, publicShippingPricingConfig } from '../src/lib/shipping-config.js';
import {
  buildShippingPolicyViews, classifyFulfillmentPolicy, getShippingPolicies, resetShippingPolicyCache, resolveCsvShippingPolicy, SHIPPING_POLICY_CACHE_TTL_MS,
} from '../src/services/ebay-shipping-policies.js';
import { formatBuyerShipping, policyOptionLabel, buyerTotalLabel, groupShippingPolicies, importButtonState } from '../public/js/import-selection.js';
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
    EBAY_SHIPPING_PROFILE_ID: LEGACY_PROFILE_ID,
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

// ── 1~8. 정책 목록 · 판정 ──────────────────────────────────
describe('1-8. eBay 배송정책 목록 조회 · 지원 판정', () => {
  it('1. GET /api/ebay/shipping-policies: 필요한 필드만, 무료 추천 최상단, 10분 캐시 · refresh', async () => {
    const app = await appWith(uploadRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/ebay/shipping-policies' });
    const again = await app.inject({ method: 'GET', url: '/api/ebay/shipping-policies' });
    const refreshed = await app.inject({ method: 'GET', url: '/api/ebay/shipping-policies?refresh=1' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, stale: false });
    expect(typeof body.fetchedAt).toBe('string');
    expect(body.policies).toHaveLength(7);
    expect(Object.keys(body.policies[0]).sort()).toEqual(['buyerShippingUsd', 'marketplace', 'name', 'policyId', 'primaryServiceCode', 'recommended', 'serviceCount', 'shippingType', 'supported', 'unsupportedMessage', 'unsupportedReason'].sort());
    expect(body.policies.map((p: any) => [p.name, p.shippingType, p.buyerShippingUsd, p.recommended])).toEqual([
      ['Free Shipping US', 'FREE', 0, true],
      ['Standard US $7.90', 'FIXED', 7.9, false],
      ['Expedited US', 'FIXED', 15, false],
      ['Calculated Shipping US', 'UNSUPPORTED', null, false],
      ['Express First US', 'UNSUPPORTED', null, false],
      ['Rate Table US', 'UNSUPPORTED', null, false],
      ['UK Standard', 'UNSUPPORTED', null, false],
    ]);
    expect(again.json().fetchedAt).toBe(body.fetchedAt);
    expect(policyFetches).toBe(2);   // 최초 1 + refresh 1 (두 번째 GET은 캐시)
    expect(SHIPPING_POLICY_CACHE_TTL_MS).toBe(600_000);
  });

  it('1b. 캐시 만료 후 조회 실패 → 마지막 정상 캐시를 stale=true로, 캐시 없으면 502 + 다시 불러오기 안내', async () => {
    let now = 1_000_000;
    let fail = false;
    const fetcher = async () => { if (fail) throw new Error('eBay down'); return FULFILLMENT_POLICIES; };
    expect((await getShippingPolicies({ fetcher, now: () => now })).stale).toBe(false);
    fail = true;
    now += SHIPPING_POLICY_CACHE_TTL_MS + 1;
    expect(await getShippingPolicies({ fetcher, now: () => now })).toMatchObject({ stale: true });
    resetShippingPolicyCache();
    await expect(getShippingPolicies({ fetcher, now: () => now })).rejects.toThrow('eBay 배송정책을 불러오지 못했습니다.');

    vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockRejectedValue(new Error('HTTP 500'));
    const app = await appWith(uploadRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/ebay/shipping-policies' });
    await app.close();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ ok: false, error: 'SHIPPING_POLICIES_UNAVAILABLE', message: 'eBay 배송정책을 불러오지 못했습니다.' });
    const html = (seedUpload(), renderStep2());
    expect(html).toContain('eBay 배송정책을 불러오지 못했습니다.');
    expect(html).toContain('id="policy-reload-btn">다시 불러오기</button>');
  });

  it('2,26. 실제 client는 GET만 사용, 토큰은 서버 헤더에만 — API 응답·로그에 토큰/원본 필드 없음', async () => {
    vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockRestore();
    const withSecretField = structuredClone(FULFILLMENT_POLICIES) as any;
    withSecretField.fulfillmentPolicies[0].description = 'internal note Bearer should-not-leak';
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: withSecretField });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('REAL NETWORK CALL'));
    const put = vi.spyOn(axios, 'put').mockRejectedValue(new Error('REAL NETWORK CALL'));
    const del = vi.spyOn(axios, 'delete').mockRejectedValue(new Error('REAL NETWORK CALL'));

    const app = await appWith(uploadRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/ebay/shipping-policies' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US');
    expect(config.headers.Authorization).toBe(`Bearer ${EBAY_OAUTH_TOKEN}`);
    expect([post, put, del].every(s => s.mock.calls.length === 0)).toBe(true);
    for (const leak of [EBAY_OAUTH_TOKEN, 'refresh-secret', 'cert', 'Bearer', 'shippingOptions', 'categoryTypes', 'should-not-leak', 'fulfillmentPolicyId']) {
      expect(res.body).not.toContain(leak);
    }
    expect(logs.join('\n')).not.toContain(EBAY_OAUTH_TOKEN);
  });

  it('3-7. 무료 $0 · 고정 $7.90 · calculated/rate table/미국 외/기본 서비스 최저가 아님은 선택 불가 (추정 금지)', () => {
    const byName = Object.fromEntries(buildShippingPolicyViews(FULFILLMENT_POLICIES).map(v => [v.name, v]));
    expect(byName['Free Shipping US']).toMatchObject({ supported: true, shippingType: 'FREE', buyerShippingUsd: 0, recommended: true, primaryServiceCode: 'EconomyShippingFromOutsideUS' });
    expect(byName['Standard US $7.90']).toMatchObject({ supported: true, shippingType: 'FIXED', buyerShippingUsd: 7.9 });
    expect(byName['Calculated Shipping US']).toMatchObject({ supported: false, buyerShippingUsd: null, unsupportedReason: 'CALCULATED', unsupportedMessage: '비용이 주소에 따라 달라 자동 리스팅에서 사용할 수 없습니다.' });
    expect(byName['Rate Table US']).toMatchObject({ supported: false, buyerShippingUsd: null, unsupportedReason: 'RATE_TABLE' });
    expect(byName['UK Standard']).toMatchObject({ supported: false, unsupportedReason: 'MARKETPLACE_NOT_US' });
    expect(byName['Express First US']).toMatchObject({ supported: false, unsupportedReason: 'PRIMARY_NOT_CHEAPEST' });
    expect(classifyFulfillmentPolicy({ fulfillmentPolicyId: 'x', marketplaceId: 'EBAY_US', categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }], shippingOptions: [{ optionType: 'DOMESTIC', costType: 'FLAT_RATE', shippingServices: [{ sortOrder: 1, shippingCost: { currency: 'USD' } }] }] }))
      .toMatchObject({ supported: false, unsupportedReason: 'COST_UNKNOWN', buyerShippingUsd: null });
  });

  it('8,9. 드롭다운: 무료 정책 "추천" 표시, 정책 자동 선택 없음 (미선택 안내)', async () => {
    const views = buildShippingPolicyViews(FULFILLMENT_POLICIES);
    expect(policyOptionLabel(views[0])).toBe('추천 · Free Shipping US — 무료배송');
    expect(policyOptionLabel(views[1])).toBe('Standard US $7.90 — $7.90');
    expect(policyOptionLabel(views[3])).toBe('Calculated Shipping US — 선택 불가: 비용이 주소에 따라 달라 자동 리스팅에서 사용할 수 없습니다.');

    seedUpload();
    const app = await appWith(uploadRoutes);
    await quoteRows(app);
    await app.inject({ method: 'GET', url: '/api/ebay/shipping-policies' });
    await app.close();
    expect(uploadRow().parsedRows.every((r: any) => !r.shippingPolicy)).toBe(true);   // 조회·견적만으로 선택되지 않음
    const html = renderStep2();
    expect(html).toContain('<option value="" selected>정책을 선택하세요</option>');
    expect(html).toContain('배송정책을 선택해주세요. 상품 검수와 배송비 계산은 가능하지만 eBay 등록은 할 수 없습니다.');
    const script = html.split('<script type="module">')[1];
    expect(script).not.toMatch(/policies\[0\][^;]*selected|autoSelect/);
    expect(html).toMatch(/<td class="text-right tabular-nums nowrap text-muted"><span class="cell-policy-shipping">정책 미선택<\/span><div class="import-quote-msg cell-buyer-total"><\/div><\/td>/);
  });
});

// ── 10~15. 선택 저장 · 표시 ─────────────────────────────────
describe('10-15. upload별 정책 저장 · 구매자 총 결제', () => {
  it('10,11. 선택 snapshot을 upload USD 행 전체에 저장, 새로고침(/import 재렌더) 후에도 선택 유지', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes);
    const res = await selectPolicy(app, POLICY_IDS.free);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().policy).toMatchObject({ policyId: POLICY_IDS.free, policyName: 'Free Shipping US', marketplace: 'EBAY_US', shippingType: 'FREE', buyerShippingUsd: 0 });
    expect(Object.keys(res.json().policy).sort()).toEqual(['buyerShippingUsd', 'fetchedAt', 'marketplace', 'policyId', 'policyName', 'primaryServiceCode', 'selectedAt', 'shippingType', 'source'].sort());
    expect(uploadRow().parsedRows.map((r: any) => r.shippingPolicy?.policyId)).toEqual([POLICY_IDS.free, POLICY_IDS.free]);

    const pages = Fastify();
    await pages.register(fastifyView, { engine: { eta: new Eta({ views: path.join(process.cwd(), 'views') }) }, root: path.join(process.cwd(), 'views'), viewExt: 'eta' });
    await pages.register(pageRoutes);
    const page = await pages.inject({ method: 'GET', url: '/import?uploadId=upload-p' });
    await pages.close();
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`<option value="${POLICY_IDS.free}" selected>추천 · Free Shipping US — 무료배송</option>`);
    expect(page.body).toContain('선택 배송정책: <strong>Free Shipping US</strong> · 구매자 배송비: <strong>무료</strong>');
    expect(page.body).toContain(`let currentPolicy = {"policyId":"${POLICY_IDS.free}"`);
  });

  it('선택 불가·없는 정책은 저장 거부', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes);
    const calc = await selectPolicy(app, POLICY_IDS.calculated);
    const missing = await selectPolicy(app, '000000000000');
    await app.close();
    expect(calc.statusCode).toBe(400);
    expect(calc.json().error).toBe('비용이 주소에 따라 달라 자동 리스팅에서 사용할 수 없습니다.');
    expect(missing.statusCode).toBe(404);
    expect(uploadRow().parsedRows.every((r: any) => !r.shippingPolicy)).toBe(true);
  });

  it('12. upload마다 다른 정책 저장', async () => {
    seedUpload('upload-a', 1);
    seedUpload('upload-b', 2);
    const app = await appWith(uploadRoutes);
    await selectPolicy(app, POLICY_IDS.free, 'upload-a');
    await selectPolicy(app, POLICY_IDS.fixed790, 'upload-b');
    await app.close();
    expect(uploadRow('upload-a').parsedRows[0].shippingPolicy.policyId).toBe(POLICY_IDS.free);
    expect(uploadRow('upload-b').parsedRows[0].shippingPolicy.policyId).toBe(POLICY_IDS.fixed790);
  });

  it('13,14,15. 정책 변경 시 견적 재호출 0 · 무료 총 결제 $36.10 · $7.90 정책 총 결제 $44.00', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes);
    await quoteRows(app);
    const quotedSnapshots = structuredClone(uploadRow().parsedRows.map((r: any) => r.shippingQuote));
    const quoteRequests = fetchCalls.length;

    await selectPolicy(app, POLICY_IDS.free);
    const free = describeRowShipping(uploadRow().parsedRows[0]);
    expect(free).toMatchObject({ listingPriceLabel: '$36.10', policyShippingLabel: '무료', buyerTotalLabel: '$36.10', listingPriceUsd: 36.1 });

    await selectPolicy(app, POLICY_IDS.fixed790);
    await app.close();
    const fixed = describeRowShipping(uploadRow().parsedRows[0]);
    expect(fixed).toMatchObject({ listingPriceLabel: '$36.10', policyShippingLabel: '$7.90', buyerTotalLabel: '$44.00' });

    expect(fetchCalls.length).toBe(quoteRequests);   // 정책 변경은 국제배송비 견적을 다시 요청하지 않음
    expect(uploadRow().parsedRows.map((r: any) => r.shippingQuote)).toEqual(quotedSnapshots);

    // 브라우저 즉시 갱신 계산 (서버와 같은 결과)
    expect(buyerTotalLabel('36.1', policySnapshot('free'))).toBe('$36.10');
    expect(buyerTotalLabel('36.1', policySnapshot('fixed790'))).toBe('$44.00');
    expect(buyerTotalLabel('', policySnapshot('fixed790'))).toBe('');
    expect([formatBuyerShipping(0), formatBuyerShipping(7.9)]).toEqual(['무료', '$7.90']);

    const html = renderStep2();
    expect(html).toContain('data-listing-usd="36.1"');
    expect(html).toContain('<span class="cell-policy-shipping">$7.90</span><div class="import-quote-msg cell-buyer-total">구매자 총 결제 $44.00</div>');
    expect(html).toContain('선택 배송정책: <strong>Standard US $7.90</strong> · 구매자 배송비: <strong>$7.90</strong>');
  });

  it('계산 중에는 정책 변경 409, 계산 결과 저장은 최신 선택 정책을 덮어쓰지 않음', async () => {
    const { mergeRowsByIndex } = await import('../src/services/shipping-quote-service.js');
    seedUpload('upload-busy', 9);
    const app = await appWith(uploadRoutes);
    let unblock!: () => void;
    const gate = new Promise<void>(r => { unblock = r; });
    fakeFetch.mockImplementationOnce(async (url: string, init: any) => {
      await gate;
      const body = JSON.parse(init.body);
      const quote = { ok: true, provider: body.provider, serviceCode: body.serviceCode, destinationCountry: 'US', chargeableWeightKg: body.actualWeightKg, appliedWeightBracketKg: 0.5, totalShippingCostKrw: 13900, euVatKrw: 0, euHsFeeKrw: 0, rateVersionId: 4 };
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, mode: 'raw', quote, blockedReason: null }) };
    });
    const job = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes/jobs', payload: { uploadId: 'upload-busy', selections: [{ index: 0, provider: 'KPL' }] } });
    const busy = await selectPolicy(app, POLICY_IDS.free, 'upload-busy');
    expect(busy.statusCode).toBe(409);
    unblock();
    for (let i = 0; i < 100; i++) {
      const j = (await app.inject({ method: 'GET', url: `/api/upload/shipping-quotes/jobs/${job.json().jobId}` })).json();
      if (j.status !== 'running') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect((await selectPolicy(app, POLICY_IDS.free, 'upload-busy')).statusCode).toBe(200);
    await app.close();

    const rows = seedUpload();
    const latest = rows.map((r: any) => ({ ...r, shippingPolicy: policySnapshot('free') }));
    const merged = mergeRowsByIndex(latest, rows.map((r: any) => ({ ...r, shippingQuote: { status: 'OK' } as any })), [0]);
    expect(merged[0]).toMatchObject({ shippingPolicy: { policyId: POLICY_IDS.free }, shippingQuote: { status: 'OK' } });
  });
});

// ── 16~24. 등록 적용 ──────────────────────────────────────
describe('16-24. AddItem ShippingProfileID · 차단 · 레거시 분기', () => {
  it('16. 정책 미선택 CSV 상품 → SHIPPING_POLICY_NOT_SELECTED, AddItem 0', async () => {
    //   import에는 정책이 필수라, 정책 필수화 이전에 가져온 상품(metadata에 정책 없음)을 재현
    const [productId] = await preparedProducts('fixed790');
    delete store.rowsOf(schema.products).find((p: any) => p.id === productId).metadata.csvImport.shippingPolicy;
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_SELECTED' });
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)).toHaveLength(0);
  });

  it('17. 삭제된 정책 / 내용 변경 / 선택 불가로 바뀐 정책 / 조회 실패 → 등록 차단', async () => {
    const [productId] = await preparedProducts('fixed790');
    const without = structuredClone(FULFILLMENT_POLICIES);
    without.fulfillmentPolicies = without.fulfillmentPolicies.filter((p: any) => p.fulfillmentPolicyId !== POLICY_IDS.fixed790);
    vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockResolvedValue(without);
    resetShippingPolicyCache();
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_AVAILABLE' });

    const changed = structuredClone(FULFILLMENT_POLICIES) as any;
    changed.fulfillmentPolicies.find((p: any) => p.fulfillmentPolicyId === POLICY_IDS.fixed790).shippingOptions[0].shippingServices[0].shippingCost.value = '9.9';
    changed.fulfillmentPolicies.find((p: any) => p.fulfillmentPolicyId === POLICY_IDS.fixed790).shippingOptions[0].shippingServices[1].shippingCost.value = '10.9';
    vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockResolvedValue(changed);
    resetShippingPolicyCache();
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_CHANGED' });

    const rateTabled = structuredClone(FULFILLMENT_POLICIES) as any;
    rateTabled.fulfillmentPolicies.find((p: any) => p.fulfillmentPolicyId === POLICY_IDS.fixed790).shippingOptions[0].rateTableId = '5000000009';
    vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockResolvedValue(rateTabled);
    resetShippingPolicyCache();
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_UNSUPPORTED' });

    vi.mocked(EbayClient.prototype.getFulfillmentPolicies).mockRejectedValue(new Error('HTTP 503'));
    resetShippingPolicyCache();
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_AVAILABLE' });

    await expect(resolveCsvShippingPolicy({ shippingPolicy: { ...policySnapshot('fixed790'), marketplace: 'EBAY_GB' } })).rejects.toMatchObject({ code: 'SHIPPING_POLICY_UNSUPPORTED' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('18,21. 신규 CSV AddItem ShippingProfileID = 선택 정책 ID (전역 env 정책 fallback 없음), 가격 원칙 유지', async () => {
    const [p0, p1] = await preparedProducts('free');
    await createListing(p0, 'ebay');
    await createListing(p1, 'ebay');
    expect(addItemBodies.map(profileOf)).toEqual([POLICY_IDS.free, POLICY_IDS.free]);
    expect(addItemBodies.map(profileOf)).not.toContain(LEGACY_PROFILE_ID);
    expect(addItemBodies.map(startPriceOf)).toEqual(['36.10', '79.26']);   // CSV + 국제배송비, 정책 배송비 가감 없음
    expect(store.rowsOf(schema.platformListings)[0].platformData.pricing).toMatchObject({
      source: 'CSV_USD_PLUS_SHIPPING', salePrice: 36.1, buyerShippingUsd: 0, buyerTotalUsd: 36.1,
      shippingPolicy: { policyId: POLICY_IDS.free, shippingType: 'FREE', buyerShippingUsd: 0 },
    });
    expect(store.rowsOf(schema.products).find((p: any) => p.id === p0).metadata.csvImport.shippingPolicy).toMatchObject({ policyId: POLICY_IDS.free });
  });

  it('15b. $7.90 정책 등록: StartPrice 36.10 그대로, 기록된 구매자 총 결제 $44.00', async () => {
    const [p0] = await preparedProducts('fixed790');
    await createListing(p0, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('36.10');
    expect(profileOf(addItemBodies[0])).toBe(POLICY_IDS.fixed790);
    expect(store.rowsOf(schema.platformListings)[0].platformData.pricing).toMatchObject({ buyerShippingUsd: 7.9, buyerTotalUsd: 44 });
  });

  it('19. 레거시 상품은 전역 EBAY_SHIPPING_PROFILE_ID 그대로, 정책 조회·견적 호출 없음', async () => {
    store.rowsOf(schema.products).push({ id: 5000, sku: 'PMC-05000', title: 'Old', costPrice: '30000.00', metadata: null, condition: 'new', brand: '', productType: '' });
    const expected = await calculatePriceSimple(30000, { platform: 'ebay' });
    await createListing(5000, 'ebay');
    expect(profileOf(addItemBodies[0])).toBe(LEGACY_PROFILE_ID);
    expect(startPriceOf(addItemBodies[0])).toBe(expected.salePrice.toFixed(2));
    expect(policyFetches).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it('20. create / retry / relist 모두 같은 policy resolver (선택 ID 사용, 미선택이면 모두 차단)', async () => {
    const [p0, p1] = await preparedProducts('fixed790');
    store.rowsOf(schema.platformListings).push(
      { id: 8001, productId: p1, platform: 'ebay', status: 'error', price: '1', quantity: 5 },
    );
    await createListing(p0, 'ebay');
    await retryListing(8001);
    store.rowsOf(schema.platformListings).find((l: any) => l.id === 8001).status = 'ended';
    await relistListing(8001);
    expect(addItemBodies.map(profileOf)).toEqual([POLICY_IDS.fixed790, POLICY_IDS.fixed790, POLICY_IDS.fixed790]);

    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/listing-service.ts'), 'utf-8');
    expect(src.match(/resolveCsvShippingPolicy\(/g)).toHaveLength(1);
    expect(src.match(/await resolveProductSalePrice\(/g)).toHaveLength(3);
    expect(src.match(/shippingProfileId: pricing\.shippingProfileId/g)).toHaveLength(3);

    for (const p of store.rowsOf(schema.products)) delete p.metadata.csvImport.shippingPolicy;
    store.rowsOf(schema.platformListings).push(
      { id: 8002, productId: p0, platform: 'ebay', status: 'error', price: '1', quantity: 5 },
      { id: 8003, productId: p1, platform: 'ebay', status: 'ended', price: '1', quantity: 5 },
    );
    const before = addItemBodies.length;
    await expect(createListing(p1, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_SELECTED' });
    await expect(retryListing(8002)).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_SELECTED' });
    await expect(relistListing(8003)).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_SELECTED' });
    expect(addItemBodies).toHaveLength(before);
  });

  it('22,23. 정책 선택은 기존 리스팅을 수정하지 않고, eBay 수정/정책 변경 API 호출 0', async () => {
    const put = vi.spyOn(axios, 'put').mockRejectedValue(new Error('REAL NETWORK CALL'));
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('REAL NETWORK CALL'));
    const del = vi.spyOn(axios, 'delete').mockRejectedValue(new Error('REAL NETWORK CALL'));
    seedUpload();
    store.rowsOf(schema.platformListings).push({ id: 9001, productId: 1, platform: 'ebay', status: 'active', platformItemId: '123', price: '20', quantity: 5, platformData: { pricing: { source: 'LEGACY_CALCULATED' } } });
    const before = structuredClone(store.rowsOf(schema.platformListings));
    const app = await appWith(uploadRoutes);
    await quoteRows(app);
    await selectPolicy(app, POLICY_IDS.free);
    await selectPolicy(app, POLICY_IDS.fixed790);
    await app.close();
    expect(store.rowsOf(schema.platformListings)).toEqual(before);
    expect(tradingCalls).toEqual([]);
    expect([put, post, del].every(s => s.mock.calls.length === 0)).toBe(true);
    const client = fs.readFileSync(path.join(process.cwd(), 'src/platforms/ebay/EbayClient.ts'), 'utf-8');
    expect(client).not.toMatch(/axios\.(put|delete)\(|fulfillment_policy[^'"`]*['"`],\s*\{[^}]*method:\s*['"](POST|PUT|DELETE)/);
  });

  it('24. pricing=false면 정책이 선택돼도 toybox 등록 차단 유지 (정책 조회 전에 차단)', async () => {
    const [p0] = await preparedProducts('free');
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false' });
    policyFetches = 0;
    resetShippingPolicyCache();
    await expect(createListing(p0, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
    expect(policyFetches).toBe(0);
  });
});

// ── Finalization: 정책 선택 전 import 차단 · 이미 가져온 미등록 상품 반영 · 검색 ─────────────
describe('FINAL. 정책 필수 import · 기존 미등록 상품 반영 · 검색 UI', () => {
  const COUPANG = ['이미지,상품URL,상품명,가격', 'https://thumbnail.coupangcdn.com/a.jpg,https://www.coupang.com/vp/products/123,포켓몬 카드 151,"19,900원"'].join('\n');
  const importBatch = async (uploadId = 'upload-p', indices = [0, 1]) => {
    const app = await appWith(crawlResultRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId, selectedIndices: indices, shippingProviders: Object.fromEntries(indices.map(i => [i, 'KPL'])) } });
    await app.close();
    return res;
  };
  const productOf = (crawlId: number) => store.rowsOf(schema.products).find((p: any) => p.metadata?.importedFrom === crawlId);
  async function importedWith(policy: 'free' | 'fixed790', uploadId = 'upload-p', id = 1) {
    seedUpload(uploadId, id);
    const app = await appWith(uploadRoutes);
    await quoteRows(app, uploadId);
    expect((await selectPolicy(app, POLICY_IDS[policy], uploadId)).statusCode).toBe(200);
    await app.close();
    const res = await importBatch(uploadId);
    expect(res.statusCode).toBe(200);
    const productIds: number[] = [];
    for (const crawlId of res.json().crawlResultIds) productIds.push(await importFromCrawl(crawlId));
    return { crawlIds: res.json().crawlResultIds as number[], productIds };
  }

  it('정책 미선택: import 버튼 비활성 + 안내, 정책 선택 후 활성 (레거시 KRW CSV는 정책 없이 활성)', () => {
    seedUpload();
    const blocked = renderStep2();
    expect(blocked).toMatch(/<button id="import-btn" class="btn btn-primary btn-lg" disabled>/);
    expect(blocked).toContain('eBay 배송정책을 선택하면 상품을 가져올 수 있습니다.');
    expect(importButtonState({ selectedCount: 2, policyRequired: true, hasPolicy: false })).toEqual({ disabled: true, reason: 'eBay 배송정책을 선택하면 상품을 가져올 수 있습니다.' });
    expect(importButtonState({ selectedCount: 2, policyRequired: true, hasPolicy: true })).toEqual({ disabled: false, reason: '' });
    expect(importButtonState({ selectedCount: 1, policyRequired: false, hasPolicy: false })).toEqual({ disabled: false, reason: '' });

    uploadRow().parsedRows.forEach((r: any) => { r.shippingPolicy = policySnapshot('free'); });
    const allowed = renderStep2();
    expect(allowed).toMatch(/<button id="import-btn" class="btn btn-primary btn-lg">/);
    expect(allowed).toMatch(/id="policy-import-notice" data-testid="policy-import-notice" hidden>/);
    const script = allowed.split('<script type="module">')[1];
    expect(script).toContain('refreshImportButton();');   // 정책 선택 성공 시 즉시 활성화

    const raw = parseCsvRawText(COUPANG);
    const legacyRows = applyMapping(raw, detectMappingByKeyword(raw));
    store.rowsOf(schema.csvUploads).push({ id: 50, uploadId: 'legacy', filename: 'c.csv', rowCount: 1, status: 'mapped', parsedRows: legacyRows });
    const legacy = renderStep2('legacy');
    expect(legacy).toMatch(/<button id="import-btn" class="btn btn-primary btn-lg">/);
    expect(legacy).not.toContain('eBay 배송정책을 선택하면 상품을 가져올 수 있습니다.');
  });

  it('서버 직접 호출 우회도 400 SHIPPING_POLICY_NOT_SELECTED, 정책 선택 후 import 가능 · 행별 crawl id 기록', async () => {
    seedUpload();
    const bypass = await importBatch();
    expect(bypass.statusCode).toBe(400);
    expect(bypass.json()).toEqual({ error: 'eBay 배송정책을 선택하면 상품을 가져올 수 있습니다.', code: 'SHIPPING_POLICY_NOT_SELECTED' });
    expect(store.rowsOf(schema.crawlResults)).toHaveLength(0);

    const app = await appWith(uploadRoutes);
    await selectPolicy(app, POLICY_IDS.fixed790);
    await app.close();
    const ok = await importBatch();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ imported: 2, errors: 0 });
    expect(uploadRow().parsedRows.map((r: any) => r.importedCrawlResultId)).toEqual(ok.json().crawlResultIds);
    expect(store.rowsOf(schema.crawlResults).map((c: any) => c.rawData.csvImport.shippingPolicy.policyId)).toEqual([POLICY_IDS.fixed790, POLICY_IDS.fixed790]);
  });

  it('레거시 KRW CSV는 정책 없이 import 가능', async () => {
    const raw = parseCsvRawText(COUPANG);
    const legacyRows = applyMapping(raw, detectMappingByKeyword(raw));
    store.rowsOf(schema.csvUploads).push({ id: 50, uploadId: 'legacy', filename: 'c.csv', rowCount: 1, status: 'mapped', parsedRows: legacyRows });
    const res = await importBatch('legacy', [0]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imported: 1, errors: 0 });
  });

  it('정책 변경 → 이미 가져온 미등록 상품(crawl·product)에 반영, 견적 재호출 0, 등록 시 새 정책 사용 · 총 결제 $44.00', async () => {
    const { crawlIds, productIds } = await importedWith('free');
    const quoteRequests = fetchCalls.length;
    const app = await appWith(uploadRoutes);
    const res = await selectPolicy(app, POLICY_IDS.fixed790);
    await app.close();
    expect(res.json().applied).toEqual({ crawlRowsUpdated: 2, productsUpdated: 2, skippedRegistered: 0, skippedOtherUpload: 0, skippedManual: 0 });
    expect(fetchCalls.length).toBe(quoteRequests);
    for (const [i, crawlId] of crawlIds.entries()) {
      expect(store.rowsOf(schema.crawlResults).find((c: any) => c.id === crawlId).rawData.csvImport.shippingPolicy.policyId).toBe(POLICY_IDS.fixed790);
      expect(store.rowsOf(schema.products).find((p: any) => p.id === productIds[i]).metadata.csvImport.shippingPolicy).toMatchObject({ policyId: POLICY_IDS.fixed790, buyerShippingUsd: 7.9, source: 'UPLOAD' });
    }
    await createListing(productIds[0], 'ebay');
    expect(profileOf(addItemBodies[0])).toBe(POLICY_IDS.fixed790);
    expect(startPriceOf(addItemBodies[0])).toBe('36.10');
    expect(store.rowsOf(schema.platformListings)[0].platformData.pricing).toMatchObject({ buyerShippingUsd: 7.9, buyerTotalUsd: 44 });
  });

  it('crawl id 기록 이전에 가져온 상품(정책 없음)도 같은 upload면 반영 (external_id + uploadId 확인)', async () => {
    const { productIds } = await importedWith('free');
    uploadRow().parsedRows.forEach((r: any) => { delete r.importedCrawlResultId; delete r.shippingPolicy; });
    store.rowsOf(schema.crawlResults).forEach((c: any) => { delete c.rawData.csvImport.shippingPolicy; });
    store.rowsOf(schema.products).forEach((p: any) => { delete p.metadata.csvImport.shippingPolicy; });
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_POLICY_NOT_SELECTED' });
    const app = await appWith(uploadRoutes);
    const res = await selectPolicy(app, POLICY_IDS.free);
    await app.close();
    expect(res.json().applied).toMatchObject({ productsUpdated: 2, crawlRowsUpdated: 2 });
    await createListing(productIds[0], 'ebay');
    expect(profileOf(addItemBodies[0])).toBe(POLICY_IDS.free);
  });

  it('eBay Item ID 있거나 active/ended/pending 리스팅 상품은 정책 변경 안 함 (error·draft 미등록은 반영)', async () => {
    seedUpload();
    const raw = parseCsvRawText(CSV + '\n' + `Extra A,10,300,16,12,8,307,307,${R2}/X/a.jpg,https://toybox.kr/a,` + '\n' + `Extra B,11,300,16,12,8,307,307,${R2}/X/b.jpg,https://toybox.kr/b,`);
    uploadRow().parsedRows = applyMapping(raw, detectFixedHeaderMapping(raw[0])!);
    uploadRow().rowCount = 4;
    const app = await appWith(uploadRoutes);
    await selectPolicy(app, POLICY_IDS.free);
    const imported = await (async () => { const r = await importBatch('upload-p', [0, 1, 2, 3]); return r.json().crawlResultIds as number[]; })();
    const ids: number[] = [];
    for (const c of imported) ids.push(await importFromCrawl(c));
    store.rowsOf(schema.platformListings).push(
      { id: 1, productId: ids[0], platform: 'ebay', status: 'active', platformItemId: '400000000001', price: '36.1', quantity: 5 },
      { id: 2, productId: ids[1], platform: 'ebay', status: 'error', platformItemId: null, price: '1', quantity: 5 },
      { id: 3, productId: ids[2], platform: 'ebay', status: 'pending', platformItemId: null, price: '1', quantity: 5 },
      { id: 4, productId: ids[3], platform: 'ebay', status: 'draft', platformItemId: null, price: '1', quantity: 5 },
    );
    const listingsBefore = structuredClone(store.rowsOf(schema.platformListings));
    const res = await selectPolicy(app, POLICY_IDS.fixed790);
    await app.close();
    expect(res.json().applied).toEqual({ crawlRowsUpdated: 2, productsUpdated: 2, skippedRegistered: 2, skippedOtherUpload: 0, skippedManual: 0 });
    const policyOf = (id: number) => store.rowsOf(schema.products).find((p: any) => p.id === id).metadata.csvImport.shippingPolicy.policyId;
    expect(ids.map(policyOf)).toEqual([POLICY_IDS.free, POLICY_IDS.fixed790, POLICY_IDS.free, POLICY_IDS.fixed790]);
    expect(store.rowsOf(schema.crawlResults).find((c: any) => c.id === imported[0]).rawData.csvImport.shippingPolicy.policyId).toBe(POLICY_IDS.free);
    expect(store.rowsOf(schema.platformListings)).toEqual(listingsBefore);   // 기존 리스팅 행 변경 없음
    expect(tradingCalls).toEqual([]);
  });

  it('다른 upload 상품 변경 없음 (같은 상품을 다른 upload가 다시 가져간 경우 포함)', async () => {
    const a = await importedWith('free', 'upload-a', 1);
    seedUpload('upload-b', 2);
    const app = await appWith(uploadRoutes);
    await selectPolicy(app, POLICY_IDS.fixed790, 'upload-b');
    await app.close();
    // upload-b가 같은 CSV(같은 external_id)를 다시 가져감 → crawl 행은 upload-b 소유, 기존 product는 upload-a 소유
    const rb = await importBatch('upload-b');
    expect(rb.json().crawlResultIds).toEqual(a.crawlIds);

    const app2 = await appWith(uploadRoutes);
    const onA = await selectPolicy(app2, POLICY_IDS.expedited, 'upload-a');
    const onB = await selectPolicy(app2, POLICY_IDS.free, 'upload-b');
    await app2.close();
    expect(onA.json().applied).toMatchObject({ productsUpdated: 0, crawlRowsUpdated: 0, skippedOtherUpload: 2 });
    expect(onB.json().applied).toMatchObject({ productsUpdated: 0, skippedOtherUpload: 2 });
    for (const id of a.productIds) {
      expect(store.rowsOf(schema.products).find((p: any) => p.id === id).metadata.csvImport).toMatchObject({ uploadId: 'upload-a', shippingPolicy: { policyId: POLICY_IDS.free } });
    }
  });

  it('상품별 수동 정책(source MANUAL) 보존', async () => {
    const { productIds } = await importedWith('free');
    const manual = { ...policySnapshot('free'), source: 'MANUAL' };
    store.rowsOf(schema.products).find((p: any) => p.id === productIds[0]).metadata.csvImport.shippingPolicy = manual;
    const app = await appWith(uploadRoutes);
    const res = await selectPolicy(app, POLICY_IDS.fixed790);
    await app.close();
    expect(res.json().applied).toMatchObject({ productsUpdated: 1, skippedManual: 1 });
    expect(store.rowsOf(schema.products).find((p: any) => p.id === productIds[0]).metadata.csvImport.shippingPolicy).toEqual(manual);
    expect(store.rowsOf(schema.products).find((p: any) => p.id === productIds[1]).metadata.csvImport.shippingPolicy.policyId).toBe(POLICY_IDS.fixed790);
  });

  it('정책 검색 · 무료배송(추천) 우선 그룹 · 유료배송 "정책명 — $7.90" · 선택 불가 하단 분리 · 자동 선택 없음', () => {
    const views = buildShippingPolicyViews(FULFILLMENT_POLICIES);
    const groups = groupShippingPolicies(views);
    expect(groups.map(g => [g.key, g.label, g.policies.map(p => policyOptionLabel(p))])).toEqual([
      ['free', '무료배송', ['추천 · Free Shipping US — 무료배송']],
      ['fixed', '유료배송 (고정 배송비)', ['Standard US $7.90 — $7.90', 'Expedited US — $15.00']],
      ['unsupported', '선택 불가', [
        'Calculated Shipping US — 선택 불가: 비용이 주소에 따라 달라 자동 리스팅에서 사용할 수 없습니다.',
        'Express First US — 선택 불가: 기본 배송서비스가 최저가가 아니어서 구매자 배송비를 확정할 수 없습니다.',
        'Rate Table US — 선택 불가: 지역별 배송비표(rate table)로 비용이 달라 자동 리스팅에서 사용할 수 없습니다.',
        'UK Standard — 선택 불가: 미국 eBay(EBAY_US) 정책이 아니어서 자동 리스팅에서 사용할 수 없습니다.',
      ]],
    ]);
    expect(groupShippingPolicies(views, 'STANDARD').map(g => g.policies.map(p => p.name))).toEqual([[], ['Standard US $7.90'], ['UK Standard']]);
    expect(groupShippingPolicies(views, 'zzz', POLICY_IDS.expedited).map(g => g.policies.map(p => p.name))).toEqual([[], ['Expedited US'], []]);   // 선택값 유지

    seedUpload();
    const html = renderStep2();
    expect(html).toContain('<input type="search" id="policy-search" class="import-select import-policy-search" placeholder="정책명 검색"');
    expect(html).toContain('<option value="" selected>정책을 선택하세요</option>');
    const script = html.split('<script type="module">')[1];
    expect(script).toContain("window.confirm('아직 eBay에 등록되지 않은 이 CSV 상품에도 새 정책을 적용합니다.')");
    expect(script).toContain("document.createElement('optgroup')");
  });

  it('EBAY_POLICY_BUYER_SHIPPING_USD 는 코드·설정에서 사용하지 않음', () => {
    const files = ['src/lib/config.ts', 'src/lib/shipping-config.ts', 'src/services/shipping-pricing.ts', 'src/services/listing-price.ts', 'src/services/shipping-quote-service.ts', 'views/step2-import.eta', '.env.example'];
    for (const f of files) expect(fs.readFileSync(path.join(process.cwd(), f), 'utf-8')).not.toContain('EBAY_POLICY_BUYER_SHIPPING_USD');
    expect(Object.keys(getShippingPricingConfig())).not.toContain('buyerShippingUsd');
  });
});
