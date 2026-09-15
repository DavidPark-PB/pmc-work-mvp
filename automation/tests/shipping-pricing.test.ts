/**
 * Phase 2 — 국제배송비 반영 eBay 등록가
 * DB·설정·번역 mock, main service는 fake fetch, eBay는 callTradingAPI spy (실호출 없음)
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
vi.mock('../src/lib/job-store.js', () => {
  const jobs = new Map<string, any>();
  (globalThis as any).__jobs = jobs;
  return {
    jobStore: {
      get: async (id: string) => (jobs.has(id) ? structuredClone(jobs.get(id)) : undefined),
      set: async (id: string, job: any) => { jobs.set(id, structuredClone(job)); },
      update: async (id: string, patch: any) => { jobs.set(id, { ...jobs.get(id), ...structuredClone(patch) }); },
      getRunning: async () => [],
    },
  };
});

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
        return { returning: async () => [structuredClone(row)], then: done.then.bind(done) };
      },
    }),
    update: (table: unknown) => ({
      set: (v: any) => {
        const apply = (pred: (r: any) => boolean) => {
          const hit = rowsOf(table).filter(pred);
          hit.forEach(r => Object.assign(r, structuredClone(v)));
          return hit;
        };
        return {
          where: (pred: (r: any) => boolean) => {
            const hit = apply(pred);
            const done = Promise.resolve(undefined);
            return { returning: async () => structuredClone(hit), then: done.then.bind(done) };
          },
        };
      },
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
import { resetShippingPolicyCache } from '../src/services/ebay-shipping-policies.js';
import { FULFILLMENT_POLICIES, policySnapshot } from './fixtures/ebay-policies.js';
import Fastify from 'fastify';
import { Eta } from 'eta';
import { parseCsvRawText, detectFixedHeaderMapping, applyMapping, buildImportPreview } from '../src/lib/csv-parser.js';
import { importFromCrawl, createListing, retryListing, relistListing } from '../src/services/listing-service.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { uploadRoutes } from '../src/routes/upload.js';
import { crawlResultRoutes } from '../src/routes/crawl-results.js';
import { productRoutes } from '../src/routes/products.js';
import { listingRoutes } from '../src/routes/listings.js';
import { getShippingPricingConfig, publicShippingPricingConfig } from '../src/lib/shipping-config.js';
import { buildQuoteRequestBody, requestShippingQuote, parseQuoteResponse, QUOTE_TIMEOUT_MS } from '../src/lib/shipping-quote-client.js';
import { quoteUploadRows } from '../src/services/shipping-quote-service.js';
import { shippingKrwToUsdCents, evaluateCsvListingPrice, applySalePriceOverride } from '../src/services/shipping-pricing.js';
import { resolveDisplayPrices, readProductCsvMetadata } from '../src/services/listing-price.js';

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.crawlSources, schema.platformListings, schema.pricingSettings, schema.csvUploads]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;

// ── fixtures ────────────────────────────────────────────
const TOKEN = 'secret-internal-token-0123456789';
const MAIN = 'https://main.test';
const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';
/** 실제 제공 CSV 1·3번째 상품과 동일 + 적용무게 #REF!/빈칸 오류 2행 */
const SHORT_CSV = [
  '상품명,환산가(USD),실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지',
  `Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,25.4,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,`,
  `Baby rattle gift set,27.9,600,22,19,9,752,752,${R2}/TOYBOX-86235/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940986,`,
  `Tomica Plarail JR Mario Train,60.1,"1,000",43,17,7,"1,023","1,023",${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,`,
  `Season 6 Princess Teenieping Baby Chair Series Random Figure - Random Shipment,10.2,300,16,12,8,307,#REF!,${R2}/TOYBOX-33043/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10934609,`,
  `Princess Teenieping Big Rainbow Sticker - Legendping,5.5,200,,,,,,${R2}/TOYBOX-21026/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10937919,`,
  `Yu-Gi-Oh! Vol. 91 / Legacy of Destruction 1000,25.4,300,16,12,8,307,307,${R2}/TOYBOX-65161/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940409,`,
].join('\n');

const SERVICE = { KPL: 'KPL_SF_US', eGS: 'EGS_STD_US' } as const;

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, {
    DATABASE_URL: 'postgres://mock',
    EBAY_ENVIRONMENT: 'SANDBOX',
    MAIN_SERVICE_URL: MAIN,
    SHIPPING_QUOTE_INTERNAL_TOKEN: TOKEN,
    AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true',
    AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '1300',
    AUTO_LISTING_KPL_US_SERVICE_CODE: SERVICE.KPL,
    AUTO_LISTING_EGS_SERVICE_CODE: SERVICE.eGS,
    ...overrides,
  });
}

/** main service raw quote 응답 (production 계약: { ok, mode:'raw', quote, blockedReason }) */
function mainBody(o: { provider: string; serviceCode: string; kg: number; bracketKg: number; krw: number }) {
  const quote = {
    ok: true, provider: o.provider, serviceCode: o.serviceCode, destinationCountry: 'US',
    volumetricDivisor: 6000, actualWeightKg: o.kg, volumetricWeightKg: 0, chargeableWeightKg: o.kg,
    appliedWeightBracketKg: o.bracketKg, baseRateKrw: o.krw, fuelSurchargeKrw: 0, demandSurchargeKrw: 0,
    euVatKrw: 0, euHsFeeKrw: 0, otherMandatoryFeeKrw: 0, totalShippingCostKrw: o.krw,
    rateVersionId: o.provider === 'KPL' ? 4 : 3, rateEffectiveFrom: o.provider === 'KPL' ? '2026-09-13' : '2026-09-01', warnings: [],
  };
  return { ok: true, mode: 'raw', quote, blockedReason: null };
}

/** raw quote 실패 응답 (HTTP 200, top-level ok:false) */
function rawBlocked(reason: string) {
  return { ok: false, mode: 'raw', quote: { ok: false, blockedReason: reason }, blockedReason: reason };
}

/** 적용무게(kg) → [구간kg, KRW]. 17,160원 / 1300 = $13.20 */
const RATE_TABLE: Record<string, Record<number, [number, number]>> = {
  KPL: { 0.307: [0.5, 17160], 1.023: [1.5, 24900], 0.752: [1, 18900] },
  eGS: { 0.307: [0.4, 14114], 1.023: [1.1, 26646], 0.752: [0.8, 21604] },
};

type FakeResponse = { status: number; body?: unknown; raw?: string } | 'timeout' | 'network';
let fetchCalls: { url: string; headers: Record<string, string>; body: any }[] = [];
let fetchOverride: ((body: any, attempt: number) => FakeResponse) | null = null;

const fakeFetch = vi.fn(async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, headers: init.headers, body });
  const attempt = fetchCalls.filter(c => JSON.stringify(c.body) === init.body).length;
  let res: FakeResponse;
  if (fetchOverride) {
    res = fetchOverride(body, attempt);
  } else {
    const hit = RATE_TABLE[body.provider]?.[body.actualWeightKg];
    res = hit
      ? { status: 200, body: mainBody({ provider: body.provider, serviceCode: body.serviceCode, kg: body.actualWeightKg, bracketKg: hit[0], krw: hit[1] }) }
      : { status: 200, body: rawBlocked('WEIGHT_OVER_MAX_BRACKET') };
  }
  if (res === 'network') throw new TypeError('fetch failed');
  if (res === 'timeout') {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  const r = res;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.raw ?? JSON.stringify(r.body) };
});

let addItemBodies: string[] = [];
const startPriceOf = (body: string) => body.match(/<StartPrice currencyID="USD">([^<]+)<\/StartPrice>/)?.[1];
let logs: string[] = [];

beforeEach(() => {
  store.tables.clear();
  store.nextId.clear();
  store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
  setEnv();
  fetchCalls = [];
  fetchOverride = null;
  addItemBodies = [];
  logs = [];
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', fakeFetch);
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
  vi.spyOn(EbayClient.prototype as any, 'suggestCategoryId').mockResolvedValue('261068');
  //   eBay 배송정책 목록 (READ-ONLY 조회 mock) — 캐시 초기화
  resetShippingPolicyCache();
  vi.spyOn(EbayClient.prototype, 'getFulfillmentPolicies').mockResolvedValue(FULFILLMENT_POLICIES);
  vi.spyOn(EbayClient.prototype as any, 'callTradingAPI').mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    addItemBodies.push(body);
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${200000 + addItemBodies.length}</ItemID></AddItemResponse>`;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// ── 전체 경로 헬퍼: 업로드 → 견적 → import batch → product ──
async function appWith(...routes: any[]) {
  const app = Fastify();
  for (const r of routes) await app.register(r, { prefix: '/api' });
  return app;
}

function seedUpload(csv = SHORT_CSV, uploadId = 'upload-1') {
  const raw = parseCsvRawText(csv);
  //   Phase 2.3: upload에서 $7.90 eBay 배송정책을 선택한 상태 (신규 CSV 등록 필수)
  const rows = applyMapping(raw, detectFixedHeaderMapping(raw[0])!).map(r => ({ ...r, shippingPolicy: policySnapshot('fixed790') }));
  store.rowsOf(schema.csvUploads).push({ id: 1, uploadId, filename: 't.csv', rowCount: rows.length, status: 'mapped', parsedRows: rows });
  return rows;
}

async function quoteAndImport(selections: { index: number; provider: 'KPL' | 'eGS' }[], opts: { importProviders?: Record<string, string> } = {}) {
  const app = await appWith(uploadRoutes, crawlResultRoutes);
  const quoteRes = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes', payload: { uploadId: 'upload-1', selections } });
  const batchRes = await app.inject({
    method: 'POST', url: '/api/import/batch',
    payload: {
      uploadId: 'upload-1',
      selectedIndices: selections.map(s => s.index),
      shippingProviders: opts.importProviders ?? Object.fromEntries(selections.map(s => [s.index, s.provider])),
    },
  });
  await app.close();
  const crawlIds: number[] = batchRes.json().crawlResultIds;
  const productIds: number[] = [];
  for (const id of crawlIds) productIds.push(await importFromCrawl(id));
  return { quote: quoteRes.json(), batch: batchRes.json(), productIds };
}

describe('견적 client — 실제 main service 계약', () => {
  it('5,7,8. 적용무게 1,023g → actualWeightKg 1.023, 치수 0 (부피 재계산 방지), KPL/eGS 실제 서비스 코드', () => {
    expect(buildQuoteRequestBody({ provider: 'KPL', serviceCode: 'KPL_SF_US', chargeableWeightG: 1023 })).toEqual({
      destinationCountry: 'US', marketplace: 'ebay', provider: 'KPL', serviceCode: 'KPL_SF_US', saleType: 'B2C',
      actualWeightKg: 1.023, lengthCm: 0, widthCm: 0, heightCm: 0,
    });
    expect(buildQuoteRequestBody({ provider: 'eGS', serviceCode: 'EGS_STD_US', chargeableWeightG: 307 })).toMatchObject({ provider: 'eGS', serviceCode: 'EGS_STD_US', actualWeightKg: 0.307 });
  });

  it('raw 계약만 채택: adapter(listing-preview) 형태 응답은 quote.ok여도 QUOTE_CONTRACT_MISMATCH로 차단', () => {
    const input = { provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 500 };
    const quote = mainBody({ provider: 'KPL', serviceCode: 'KPL_SF_US', kg: 0.5, bracketKg: 0.5, krw: 13900 }).quote;
    expect(parseQuoteResponse({ ok: false, mode: 'shadow', quote, listingBlockedReason: 'NO_SHIPPING_POLICY' }, input)).toEqual({ ok: false, blockedReason: 'QUOTE_CONTRACT_MISMATCH' });
    expect(parseQuoteResponse({ ok: true, quote }, input)).toEqual({ ok: false, blockedReason: 'QUOTE_CONTRACT_MISMATCH' });
    expect(parseQuoteResponse({ ok: false, mode: 'raw', quote: { ...quote }, blockedReason: 'X' }, input)).toEqual({ ok: false, blockedReason: 'X' });
    expect(parseQuoteResponse({ ok: true, mode: 'raw', quote, blockedReason: null }, input)).toMatchObject({ ok: true, shippingKrw: 13900, bracketWeightKg: 0.5 });
  });

  it('Bearer 토큰 + 내부 raw /quote URL, 응답의 상위 구간 사용', async () => {
    const out = await requestShippingQuote({ provider: 'KPL', serviceCode: 'KPL_SF_US', chargeableWeightG: 1023 }, { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(fetchCalls[0].url).toBe('https://main.test/api/internal/shipping/quote');
    expect(fetchCalls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(out).toMatchObject({ ok: true, chargeableWeightG: 1023, bracketWeightKg: 1.5, shippingKrw: 24900, rateVersionId: 4 });
  });

  it('6. 적용무게보다 낮은 중량/구간 견적은 차단', () => {
    const input = { provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 1023 };
    expect(parseQuoteResponse(mainBody({ provider: 'KPL', serviceCode: 'KPL_SF_US', kg: 1.0, bracketKg: 1.0, krw: 18900 }), input)).toEqual({ ok: false, blockedReason: 'QUOTE_WEIGHT_BELOW_CHARGEABLE' });
    expect(parseQuoteResponse(mainBody({ provider: 'KPL', serviceCode: 'KPL_SF_US', kg: 1.023, bracketKg: 1.0, krw: 18900 }), input)).toEqual({ ok: false, blockedReason: 'QUOTE_BRACKET_BELOW_CHARGEABLE' });
    expect(parseQuoteResponse(mainBody({ provider: 'eGS', serviceCode: 'EGS_STD_US', kg: 1.023, bracketKg: 1.1, krw: 1 }), input)).toEqual({ ok: false, blockedReason: 'QUOTE_PROVIDER_MISMATCH' });
  });

  it('13. RATE_NOT_LOADED / COUNTRY_NOT_IN_MASTER 는 차단 (현재 KPL 버전에 US 국가행 없음)', () => {
    const input = { provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 307 };
    expect(parseQuoteResponse(rawBlocked('RATE_NOT_LOADED'), input))
      .toEqual({ ok: false, blockedReason: 'RATE_NOT_LOADED' });
    expect(parseQuoteResponse(rawBlocked('COUNTRY_NOT_IN_MASTER'), input))
      .toEqual({ ok: false, blockedReason: 'COUNTRY_NOT_IN_MASTER' });
  });

  it('12. 실패 처리: 일시적 오류(timeout/network/429·502·503·504)만 최대 3회 재시도, 500·401·invalid JSON 즉시 차단, timeout 8초, 미설정 시 호출 안 함', async () => {
    const input = { provider: 'eGS' as const, serviceCode: 'EGS_STD_US', chargeableWeightG: 307 };
    const deps = { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any, sleep: async () => {} };

    //   Phase 2.2: 500 internal_quote_failed는 최대 1회만 재시도 (기존 코드: QUOTE_HTTP_500_internal_quote_failed), 그 밖의 500은 즉시 차단
    fetchOverride = () => ({ status: 500, body: { ok: false, error: 'internal_quote_failed' } });
    expect(await requestShippingQuote(input, deps)).toEqual({ ok: false, blockedReason: 'QUOTE_HTTP_500', retries: 1, httpStatus: 500 });
    expect(fetchCalls).toHaveLength(2);
    fetchCalls = [];
    fetchOverride = () => ({ status: 500, body: { ok: false, error: 'validation_failed' } });
    expect(await requestShippingQuote(input, deps)).toEqual({ ok: false, blockedReason: 'QUOTE_HTTP_500', httpStatus: 500 });
    expect(fetchCalls).toHaveLength(1);

    fetchCalls = [];
    fetchOverride = (_b, attempt) => (attempt === 1 ? 'network' : { status: 200, body: mainBody({ provider: 'eGS', serviceCode: 'EGS_STD_US', kg: 0.307, bracketKg: 0.4, krw: 14114 }) });
    expect(await requestShippingQuote(input, deps)).toMatchObject({ ok: true, shippingKrw: 14114, retries: 1 });
    expect(fetchCalls).toHaveLength(2);

    //   Phase 2.2: 401은 AUTH_ERROR (기존 코드: QUOTE_HTTP_401_INVALID_INTERNAL_TOKEN), 재시도 없음
    fetchCalls = [];
    fetchOverride = () => ({ status: 401, body: { ok: false, error: 'INVALID_INTERNAL_TOKEN' } });
    expect(await requestShippingQuote(input, deps)).toEqual({ ok: false, blockedReason: 'AUTH_ERROR', httpStatus: 401 });
    expect(fetchCalls).toHaveLength(1);

    fetchCalls = [];
    fetchOverride = () => ({ status: 200, raw: '<html>not json' });
    expect(await requestShippingQuote(input, deps)).toEqual({ ok: false, blockedReason: 'QUOTE_INVALID_JSON' });

    fetchCalls = [];
    expect(QUOTE_TIMEOUT_MS).toBe(8000);
    vi.useFakeTimers();
    fetchOverride = () => 'timeout';
    const pending = requestShippingQuote(input, { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    await vi.advanceTimersByTimeAsync(QUOTE_TIMEOUT_MS * 4 + 300 + 800 + 1500 + 10);
    expect(await pending).toEqual({ ok: false, blockedReason: 'QUOTE_TIMEOUT', retries: 3 });
    expect(fetchCalls).toHaveLength(4);
    vi.useRealTimers();

    fetchCalls = [];
    fetchOverride = null;
    expect(await requestShippingQuote(input, { config: { mainServiceUrl: null, internalToken: TOKEN }, fetchImpl: fakeFetch as any }))
      .toEqual({ ok: false, blockedReason: 'SHIPPING_QUOTE_NOT_CONFIGURED' });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('견적 캐시 · 차단', () => {
  it('9,10. 같은 provider+weight는 1회, 다른 provider는 별도 견적', async () => {
    const rows = seedUpload();
    // 행 0, 5: 둘 다 307g KPL → 1회 / 행 0 eGS 307g → 별도 / 행 2 KPL 1,023g → 별도
    const result = await quoteUploadRows(rows, [
      { index: 0, provider: 'KPL' }, { index: 5, provider: 'KPL' }, { index: 2, provider: 'KPL' }, { index: 1, provider: 'eGS' },
    ], { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(result.uniqueRequests).toBe(3);
    expect(fetchCalls.map(c => `${c.body.provider}:${c.body.actualWeightKg}`).sort()).toEqual(['KPL:0.307', 'KPL:1.023', 'eGS:0.752']);
    expect(result.snapshots.get(0)).toMatchObject({ status: 'OK', shippingUsd: 13.2, listingPriceUsd: 38.6 });
    expect(result.snapshots.get(5)).toMatchObject({ status: 'OK', shippingUsd: 13.2 });

    fetchCalls = [];
    const again = await quoteUploadRows(rows, [{ index: 0, provider: 'KPL' }, { index: 0, provider: 'eGS' }].slice(1).concat([{ index: 5, provider: 'KPL' }]), { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(again.uniqueRequests).toBe(2); // eGS 307g 와 KPL 307g는 서로 다른 키
  });

  it('11,14. 무게 복구 불가/환율 누락은 요청하지 않고 BLOCKED, 서비스코드 누락은 대체 배송사만 견적', async () => {
    const rows = seedUpload();
    //   Phase 2.2: #REF!(실측 300·부피 307) → 307g 복구 견적, 빈칸(실측 200) → 200g 복구 / 복구 불가만 INVALID_WEIGHT
    const r1 = await quoteUploadRows(rows, [{ index: 3, provider: 'KPL' }], { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(r1.snapshots.get(3)).toMatchObject({ status: 'OK', chargeableWeightG: 307, originalChargeableWeightG: null, recoveredChargeableWeightG: 307, recoverySource: 'MAX_ACTUAL_VOLUMETRIC' });
    const unrecoverable = rows.map((r, i) => (i === 4 ? { ...r, actualWeightG: null, volumetricWeightG: null } : r));
    fetchCalls = [];
    const r1b = await quoteUploadRows(unrecoverable, [{ index: 4, provider: 'KPL' }], { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(r1b.snapshots.get(4)?.blockedReason).toBe('INVALID_WEIGHT');
    expect(r1b.alternatives.get(4)).toBeNull();

    setEnv({ AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '' });
    const r2 = await quoteUploadRows(rows, [{ index: 0, provider: 'KPL' }], { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(r2.snapshots.get(0)?.blockedReason).toBe('EXCHANGE_RATE_MISSING');
    expect(fetchCalls).toHaveLength(0);

    setEnv({ AUTO_LISTING_KPL_US_SERVICE_CODE: undefined });
    const r3 = await quoteUploadRows(rows, [{ index: 0, provider: 'KPL' }], { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(r3.snapshots.get(0)?.blockedReason).toBe('SERVICE_CODE_MISSING');
    expect(r3.alternatives.get(0)).toMatchObject({ status: 'OK', provider: 'eGS', serviceCode: 'EGS_STD_US' });
    expect(fetchCalls.map(c => c.body.provider)).toEqual(['eGS']);
  });

  it('shippingUsd 올림: 17,160원/1300 = $13.20 (13.21 아님), 14,114원/1300 = $10.86', () => {
    expect(shippingKrwToUsdCents(17160, 1300)).toBe(1320);
    expect(shippingKrwToUsdCents(14114, 1300)).toBe(1086);
  });
});

describe('eBay StartPrice (AddItem mock)', () => {
  it('1,2,3,16. CSV $25.40 + 배송 $13.20 → StartPrice 38.60 ($7.90 차감·가산 없음)', async () => {
    seedUpload();
    const { quote, productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    expect(quote.rows[0]).toMatchObject({ quoteStatus: 'OK', shippingLabel: '$13.20', listingPriceLabel: '$38.60', buyerTotalLabel: '$46.50' });

    await createListing(productIds[0], 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('38.60');
    expect(startPriceOf(addItemBodies[0])).not.toBe('30.70');   // 38.60 - 7.90 아님
    expect(startPriceOf(addItemBodies[0])).not.toBe('46.50');   // 38.60 + 7.90 아님
    expect(addItemBodies[0]).not.toContain('7.90');
    expect(addItemBodies[0]).toContain('<ShippingProfileID>');     // 기존 Shipping Policy ID 그대로

    const listing = store.rowsOf(schema.platformListings)[0];
    expect(listing.platformData.pricing).toMatchObject({
      source: 'CSV_USD_PLUS_SHIPPING', salePrice: 38.6, csvSalePriceUsd: 25.4, basePriceSource: 'CSV',
      shippingUsd: 13.2, shippingKrw: 17160, exchangeRate: 1300, provider: 'KPL', serviceCode: 'KPL_SF_US', rateVersionId: 4, buyerShippingUsd: 7.9,
    });
  });

  it('4. 구매자 총 결제 표시 $46.50 (대시보드 메모)', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    const product = store.rowsOf(schema.products).find(p => p.id === productIds[0]);
    const display = resolveDisplayPrices({ costKrw: 0, csv: readProductCsvMetadata(product.metadata), allSettings: {}, shipping: getShippingPricingConfig() });
    expect(display.ebayPrice).toBe(38.6);
    expect(display.priceNote).toBe('CSV $25.40 · 배송 $13.20 · 구매자 총 $46.50');
    expect(display.ebayEditValue).toBe(25.4);
  });

  it('15. 플래그 false면 유효 견적이 있어도 CSV 판매가 단독 등록 없이 차단 (Phase 2.1 release guard)', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false' });
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({
      code: 'SHIPPING_PRICING_DISABLED',
      message: '배송비 반영 기능이 비활성화되어 있어 이 상품을 eBay에 등록하지 않았습니다.',
    });
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)).toHaveLength(0);
  });

  it('기능 플래그 기본값은 false', () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: undefined });
    delete envState.AUTO_LISTING_SHIPPING_PRICING_ENABLED;
    expect(getShippingPricingConfig().enabled).toBe(false);
    const example = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf-8');
    expect(example).toMatch(/^AUTO_LISTING_SHIPPING_PRICING_ENABLED=false$/m);
  });

  it('eGS 선택 → EGS_STD_US 견적으로 등록 (1,023g → 1.1kg 구간 26,646원 = $20.50)', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 2, provider: 'eGS' }]);
    expect(fetchCalls[0].body).toMatchObject({ provider: 'eGS', serviceCode: 'EGS_STD_US', actualWeightKg: 1.023 });
    await createListing(productIds[0], 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('80.60');
  });

  it('17. 레거시 상품은 플래그 true에서도 calculatePriceSimple 그대로', async () => {
    store.rowsOf(schema.products).push({ id: 5000, sku: 'PMC-05000', title: 'Old', costPrice: '30000.00', metadata: null, condition: 'new', brand: '', productType: '' });
    const expected = await calculatePriceSimple(30000, { platform: 'ebay' });
    await createListing(5000, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe(expected.salePrice.toFixed(2));
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('등록 차단 (fail-closed, fallback 없음)', () => {
  it('12. 견적 실패 상품은 등록 차단', async () => {
    seedUpload();
    fetchOverride = () => ({ status: 500, body: { ok: false, error: 'internal_quote_failed' } });
    const { quote, productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    expect(quote.rows[0]).toMatchObject({ quoteStatus: 'BLOCKED', shippingLabel: '계산 실패', listingPriceLabel: '—', reasonLabel: '배송비 서버 오류 (HTTP 500)' });
    await expect(createListing(productIds[0], 'ebay')).rejects.toThrow('유효한 국제배송비 견적이 없어 등록하지 않았습니다.');
    expect(addItemBodies).toHaveLength(0);
  });

  it('13. RATE_NOT_LOADED 견적은 등록 차단', async () => {
    seedUpload();
    fetchOverride = () => ({ status: 200, body: rawBlocked('RATE_NOT_LOADED') });
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    const product = store.rowsOf(schema.products).find(p => p.id === productIds[0]);
    expect(product.metadata.csvImport.shippingQuote).toMatchObject({ status: 'BLOCKED', blockedReason: 'RATE_NOT_LOADED' });
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });
  });

  it('14. 등록 시점 환율 누락 → 차단', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    setEnv({ AUTO_LISTING_SHIPPING_EXCHANGE_RATE: 'abc' });
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({ code: 'EXCHANGE_RATE_INVALID' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('배송사 변경 후 재견적 없이 import → 견적 폐기 → 등록 차단', async () => {
    seedUpload();
    const { batch, productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }], { importProviders: { 0: 'eGS' } });
    expect(batch.imported).toBe(1);
    const product = store.rowsOf(schema.products).find(p => p.id === productIds[0]);
    expect(product.metadata.csvImport).toMatchObject({ selectedShippingProvider: 'eGS', shippingQuote: null });
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });
  });

  it('snapshot과 현재 상품 적용무게 불일치 → 차단', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    const product = store.rowsOf(schema.products).find(p => p.id === productIds[0]);
    product.metadata.csvImport.chargeableWeightG = 900;
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISMATCH' });
  });

  it('23. 적용무게 #REF! 행은 복구 무게(307g)로 견적·등록가 계산, 복구 불가 행은 등록 차단 (플래그 on/off 모두)', async () => {
    seedUpload();
    const upload = store.rowsOf(schema.csvUploads)[0];
    upload.parsedRows[4] = { ...upload.parsedRows[4], actualWeightG: null, volumetricWeightG: null };   // 복구 불가
    const { quote, productIds } = await quoteAndImport([{ index: 3, provider: 'KPL' }, { index: 4, provider: 'KPL' }]);
    expect(productIds).toHaveLength(2);
    expect(quote.rows[0]).toMatchObject({ quoteCategory: 'RECOVERED', weightRecoveryLabel: '적용무게 자동복구: 307g', listingPriceLabel: '$23.40' });
    expect(quote.rows[1]).toMatchObject({ quoteStatus: 'WEIGHT_INVALID', quoteCategory: 'REVIEW', reasonLabel: '계산 가능한 무게가 없음' });

    //   Phase 2.1: 플래그 off는 release guard가 무게 검사보다 먼저 차단
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false' });
    for (const id of productIds) await expect(createListing(id, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);

    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    await expect(createListing(productIds[1], 'ebay')).rejects.toMatchObject({ code: 'CHARGEABLE_WEIGHT_INVALID' });
    await createListing(productIds[0], 'ebay');
    expect(addItemBodies.map(startPriceOf)).toEqual(['23.40']);   // $10.20 + $13.20 (307g KPL)
  });

  it('24. 일괄등록: 견적 없는 상품만 실패, 나머지 등록 계속', async () => {
    seedUpload();
    const good = await quoteAndImport([{ index: 0, provider: 'KPL' }, { index: 2, provider: 'KPL' }]);
    const bad = await importFromCrawl((await (async () => {
      const app = await appWith(crawlResultRoutes);
      const res = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId: 'upload-1', selectedIndices: [1], shippingProviders: { 1: 'KPL' } } });
      await app.close();
      return res.json().crawlResultIds[0];
    })()));

    const app = await appWith(listingRoutes);
    const res = await app.inject({ method: 'POST', url: '/api/listings/create', payload: { productIds: [good.productIds[0], bad, good.productIds[1]], platforms: ['ebay'] } });
    const { jobId } = res.json();
    const jobs = (globalThis as any).__jobs as Map<string, any>;
    for (let i = 0; i < 60 && jobs.get(jobId)?.status !== 'done'; i++) await new Promise(r => setTimeout(r, 100));
    await app.close();
    const job = jobs.get(jobId);
    expect(job).toMatchObject({ status: 'done', completed: 2, failed: 1 });
    expect(job.results[1]).toMatchObject({ success: false, error: '유효한 국제배송비 견적이 없어 등록하지 않았습니다.' });
    expect(addItemBodies.map(startPriceOf)).toEqual(['38.60', '79.26']);
  }, 15000);
});

describe('수동 판매가', () => {
  it('18. 수동 $27.00 + 배송 $13.20 → $40.20, 원본 CSV 판매가 보존, 이력 기록', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    const app = await appWith(productRoutes);
    const res = await app.inject({ method: 'PATCH', url: `/api/products/${productIds[0]}`, payload: { ebayPrice: '27.00' } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().prices).toMatchObject({ ebayPrice: 40.2, ebayEditValue: 27, priceNote: 'CSV $25.40 · 수동 $27.00 · 배송 $13.20 · 구매자 총 $48.10' });

    const csv = store.rowsOf(schema.products).find(p => p.id === productIds[0]).metadata.csvImport;
    expect(csv.salePriceUsd).toBe(25.4);
    expect(csv.salePriceOverrideUsd).toBe(27);
    expect(csv.salePriceOverrideHistory).toHaveLength(1);
    expect(csv.salePriceOverrideHistory[0]).toMatchObject({ previousUsd: null, newUsd: 27, changedBy: 'Admin' });
    expect(typeof csv.salePriceOverrideHistory[0].changedAt).toBe('string');

    await createListing(productIds[0], 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('40.20');
    expect(store.rowsOf(schema.platformListings)[0].platformData.pricing).toMatchObject({ basePriceSource: 'MANUAL', basePriceUsd: 27, csvSalePriceUsd: 25.4 });
  });

  it('잘못된 수동 판매가는 저장 거부, 이력 불일치 수동가는 등록 차단, 해제 시 CSV가 복귀', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    const app = await appWith(productRoutes);
    for (const bad of ['0', '-3', 'abc', '12.345']) {
      const res = await app.inject({ method: 'PATCH', url: `/api/products/${productIds[0]}`, payload: { ebayPrice: bad } });
      expect(res.statusCode).toBe(400);
    }
    const resShopify = await app.inject({ method: 'PATCH', url: `/api/products/${productIds[0]}`, payload: { shopifyPrice: '10' } });
    expect(resShopify.statusCode).toBe(400);

    const product = store.rowsOf(schema.products).find(p => p.id === productIds[0]);
    product.metadata.csvImport.salePriceOverrideUsd = 99;  // 이력 없이 직접 변조
    await expect(createListing(productIds[0], 'ebay')).rejects.toMatchObject({ code: 'OVERRIDE_HISTORY_MISMATCH' });

    product.metadata.csvImport.salePriceOverrideUsd = null;
    const cleared = await app.inject({ method: 'PATCH', url: `/api/products/${productIds[0]}`, payload: { ebayPrice: '' } });
    await app.close();
    expect(cleared.json().prices.ebayPrice).toBe(38.6);
  });

  it('crawl 행 수동 판매가도 원본 보존 후 import 시 product로 전달', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes, crawlResultRoutes);
    await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes', payload: { uploadId: 'upload-1', selections: [{ index: 0, provider: 'KPL' }] } });
    const batch = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId: 'upload-1', selectedIndices: [0], shippingProviders: { 0: 'KPL' } } });
    const crawlId = batch.json().crawlResultIds[0];
    const patch = await app.inject({ method: 'PATCH', url: `/api/crawl-results/${crawlId}`, payload: { ebayPrice: '30' } });
    const rejectPrice = await app.inject({ method: 'PATCH', url: `/api/crawl-results/${crawlId}`, payload: { price: '19500' } });
    await app.close();
    expect(patch.statusCode).toBe(200);
    expect(rejectPrice.statusCode).toBe(400);
    const crawl = store.rowsOf(schema.crawlResults).find(c => c.id === crawlId);
    expect(Number(crawl.price)).toBe(25.4);   // 원본 판매가 불변 (fake DB는 numeric 자리수 정규화 없음)
    expect(crawl.rawData.csvImport.fields).toMatchObject({ salePriceUsd: 25.4, salePriceOverrideUsd: 30 });

    const productId = await importFromCrawl(crawlId);
    await createListing(productId, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('43.20');
  });

  it('applySalePriceOverride는 원본을 변경하지 않는다', () => {
    const fields = { salePriceUsd: 25.4, purchaseCostKrw: 19500 };
    const next = applySalePriceOverride(fields, '27', { now: new Date('2026-09-14T00:00:00Z') });
    expect(fields).toEqual({ salePriceUsd: 25.4, purchaseCostKrw: 19500 });
    expect(next.salePriceOverrideHistory).toEqual([{ previousUsd: null, newUsd: 27, changedAt: '2026-09-14T00:00:00.000Z', changedBy: null }]);
    expect(() => applySalePriceOverride(fields, '19500')).toThrow(/매입원가/);
    //   Phase 2.1: 플래그 off면 수동가도 CSV가 단독 등록 없이 차단 (수동가 자체는 base로 인식)
    expect(evaluateCsvListingPrice({ ...next, chargeableWeightG: 307 }, { enabled: false, exchangeRate: null, serviceCodes: { KPL: null, eGS: null } }))
      .toMatchObject({ ok: false, code: 'SHIPPING_PRICING_DISABLED', basePriceUsd: 27, basePriceSource: 'MANUAL' });
  });
});

describe('19. retry / relist 동일 snapshot · resolver', () => {
  it('retry → 38.60, relist → 79.26 (1,023g KPL 1.5kg 구간 24,900원/1300 = $19.16 + $60.10)', async () => {
    seedUpload();
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }, { index: 2, provider: 'KPL' }]);
    store.rowsOf(schema.platformListings).push(
      { id: 7001, productId: productIds[0], platform: 'ebay', status: 'error', price: '25.40', quantity: 5 },
      { id: 7002, productId: productIds[1], platform: 'ebay', status: 'ended', price: '60.10', quantity: 5 },
    );
    await retryListing(7001);
    await relistListing(7002);
    expect(addItemBodies.map(startPriceOf)).toEqual(['38.60', '79.26']);
    expect(store.rowsOf(schema.platformListings).map(l => l.platformData.pricing.source)).toEqual(['CSV_USD_PLUS_SHIPPING', 'CSV_USD_PLUS_SHIPPING']);
    expect(fetchCalls).toHaveLength(2); // 등록 단계에서는 재견적 호출 없음 (snapshot 사용)
  });

  it('retry/relist도 견적 없으면 차단, 상태 불변', async () => {
    seedUpload();
    fetchOverride = () => ({ status: 200, body: rawBlocked('COUNTRY_NOT_IN_MASTER') });
    const { productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }]);
    store.rowsOf(schema.platformListings).push(
      { id: 7003, productId: productIds[0], platform: 'ebay', status: 'error', price: '1', quantity: 5 },
      { id: 7004, productId: productIds[0], platform: 'ebay', status: 'ended', price: '1', quantity: 5 },
    );
    await expect(retryListing(7003)).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });
    await expect(relistListing(7004)).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });
    expect(store.rowsOf(schema.platformListings).map(l => l.status)).toEqual(['error', 'ended']);
    expect(addItemBodies).toHaveLength(0);
  });
});

describe('20. 토큰 비노출', () => {
  it('검수 화면 HTML·브라우저 JS·로그·API 응답에 토큰 없음', async () => {
    const rows = seedUpload();
    const app = await appWith(uploadRoutes);
    const quoteRes = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes', payload: { uploadId: 'upload-1', selections: [{ index: 0, provider: 'KPL' }, { index: 2, provider: 'eGS' }] } });
    fetchOverride = () => ({ status: 401, body: { ok: false, error: 'INVALID_INTERNAL_TOKEN' } });
    await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes', payload: { uploadId: 'upload-1', selections: [{ index: 5, provider: 'eGS' }] } });
    await app.close();

    const updated = store.rowsOf(schema.csvUploads)[0].parsedRows;
    const preview = buildImportPreview(updated);
    const html = new Eta({ views: path.join(process.cwd(), 'views') }).render('./step2-import', {
      uploadId: 'upload-1', rows: preview.rows, rowCount: preview.rows.length, priceHeader: preview.priceHeader,
      defaultSelectedCount: preview.defaultSelectedCount, errorRowCount: preview.errorRowCount,
      showShipping: preview.showShipping, shipping: publicShippingPricingConfig(getShippingPricingConfig()),
    });
    const browserJs = fs.readFileSync(path.join(process.cwd(), 'public/js/import-selection.js'), 'utf-8');

    for (const haystack of [html, browserJs, logs.join('\n'), quoteRes.body, JSON.stringify(updated)]) {
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain(MAIN);
    }
    expect(logs.join('\n')).not.toMatch(/17160|14114|26646|24900/);   // 견적 금액 로그 없음
    expect(rows.length).toBe(6);
  });
});

describe('22. 실제 제공 CSV 첫·세 번째 상품', () => {
  it('KPL: $25.40+$13.20=$38.60 (307g→0.5kg) / $60.10+$19.16=$79.26 (1,023g→1.5kg), R2 이미지·선택 유지', async () => {
    const rows = seedUpload();
    const { quote, productIds } = await quoteAndImport([{ index: 0, provider: 'KPL' }, { index: 2, provider: 'KPL' }]);
    expect(quote.rows.map((r: any) => [r.index, r.shippingLabel, r.listingPriceLabel])).toEqual([[0, '$13.20', '$38.60'], [2, '$19.16', '$79.26']]);
    await createListing(productIds[0], 'ebay');
    await createListing(productIds[1], 'ebay');
    expect(addItemBodies.map(startPriceOf)).toEqual(['38.60', '79.26']);
    expect(addItemBodies[0]).toContain(`<PictureURL>${R2}/TOYBOX-43037/main-1.jpg</PictureURL>`);
    const preview = buildImportPreview(store.rowsOf(schema.csvUploads)[0].parsedRows);
    //   Phase 2.2: 적용무게 #REF!/빈칸 행(3, 4)은 실측·부피무게로 복구 가능 → 기본 선택 (기존: [0, 1, 2, 5])
    expect(preview.rows.filter(r => r.defaultSelected).map(r => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(preview.rows[0]).toMatchObject({ priceLabel: '$25.40', weightLabel: '307g', shippingProvider: 'KPL' });
    expect(preview.rows[2]).toMatchObject({ priceLabel: '$60.10', weightLabel: '1,023g' });
    expect(preview.rows[3]).toMatchObject({ quoteStatus: 'NONE', weightLabel: '307g', weightRecoveryLabel: '적용무게 자동복구: 307g' });
    expect(rows[0].sourceColumns!['R2 이미지']).toBe(`${R2}/TOYBOX-43037/main-1.jpg`);
  });

  it('검수 화면: 기본 배송사 KPL, eGS 경고, $7.90 별도 표시', () => {
    seedUpload();
    const preview = buildImportPreview(store.rowsOf(schema.csvUploads)[0].parsedRows);
    const html = new Eta({ views: path.join(process.cwd(), 'views') }).render('./step2-import', {
      uploadId: 'upload-1', rows: preview.rows, rowCount: preview.rows.length, priceHeader: preview.priceHeader,
      defaultSelectedCount: preview.defaultSelectedCount, errorRowCount: preview.errorRowCount,
      showShipping: preview.showShipping, shipping: publicShippingPricingConfig(getShippingPricingConfig()),
      shippingPolicy: policySnapshot('fixed790'),
    });
    expect(html.match(/<option value="KPL" selected>KPL<\/option>/g)!.length).toBe(1 + 6);  // 일괄 + 행 6개
    expect(html).toContain('선택 배송정책: <strong>Standard US $7.90</strong> · 구매자 배송비: <strong>$7.90</strong>');
    expect(html).toContain('eGS는 브랜드 상품에 사용하지 않습니다.');
    expect(html).toContain('정책 배송비 · 구매자 총 결제');   // Phase 2.3: 전역 env $7.90 대신 선택 정책 금액
    expect(html.match(/\$7\.90/g)!.length).toBeGreaterThanOrEqual(7);
    expect(html).toContain('예상 국제배송비');
    expect(html).toContain('eBay 등록 상품가격');
    expect(html).toContain('KPL은 미국 서비스만 사용');
  });
});
