/**
 * Phase 2.2 — 배송 견적 복구 UX
 * 제한 동시성 · 자동 재시도 · 적용무게 복구 · 대체 배송사 · 한국어 사유 · 요약/진행상태
 * DB·설정·번역 mock, main service는 production 운임 구간을 흉내 낸 fake fetch, eBay는 callTradingAPI spy (실호출 없음)
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
  const state = { tables, nextId, rowsOf, schema: null as any, writes: 0 };
  const attach = (tableName: string, row: any, withSpec: any) => {
    if (!row || !withSpec) return row;
    const s = state.schema;
    const out = { ...row };
    if (tableName === 'products' && withSpec.images) out.images = rowsOf(s.productImages).filter((i: any) => i.productId === row.id);
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
      set: (v: any) => ({
        where: (pred: (r: any) => boolean) => {
          state.writes++;
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
import { Eta } from 'eta';
import { parseCsvRawText, detectFixedHeaderMapping, detectMappingByKeyword, applyMapping, buildImportPreview, describeRowShipping, summarizeQuoteCategories } from '../src/lib/csv-parser.js';
import { importFromCrawl, createListing } from '../src/services/listing-service.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { uploadRoutes } from '../src/routes/upload.js';
import { crawlResultRoutes } from '../src/routes/crawl-results.js';
import { getShippingPricingConfig, publicShippingPricingConfig } from '../src/lib/shipping-config.js';
import { requestShippingQuote, requestShippingQuotesDeduped, QUOTE_CONCURRENCY, QUOTE_MAX_RETRIES, QUOTE_RETRY_DELAYS_MS, QUOTE_TIMEOUT_MS } from '../src/lib/shipping-quote-client.js';
import { quoteUploadRows, applyShippingAlternatives } from '../src/services/shipping-quote-service.js';
import { describeQuoteReason, resolveChargeableWeight } from '../src/lib/shipping-quote-status.js';
import { formatQuoteSummary, formatQuoteProgress, createSingleFlight, failedQuoteSelections, countQuoteCategories, createProviderState } from '../public/js/import-selection.js';

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.crawlSources, schema.platformListings, schema.pricingSettings, schema.csvUploads]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;

// ── fixtures ────────────────────────────────────────────
const TOKEN = 'recovery-internal-token-0123456789abcdef';
const MAIN = 'https://main.recovery.test';
const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';
const HEADER = '상품명,환산가(USD),실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지';
const line = (name: string, usd: string, actual: string, vol: string, charge: string, code: string) =>
  `${name},${usd},${actual},10,10,10,${vol},${charge},${R2}/TOYBOX-${code}/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=${code},`;
/** production upload 138 에서 차단됐던 무게 + 복구/초과 행 */
const CSV = [
  HEADER,
  line('A 307g', '25.4', '300', '307', '307', '1'),          // 0  KPL 0.5kg 13,900
  line('B 752g', '27.9', '600', '752', '752', '2'),          // 1  KPL 1kg 18,900
  line('C 1023g', '60.1', '"1,000"', '"1,023"', '"1,023"', '3'), // 2  KPL 1.5kg 24,900
  line('D 1500g', '30', '"1,500"', '"1,200"', '"1,500"', '4'),  // 3  KPL 1.5kg 24,900
  line('E REF', '10.2', '300', '307', '#REF!', '5'),        // 4  #REF! → 307g
  line('F blank', '5.5', '200', '', '', '6'),               // 5  빈칸 → 200g (실측만)
  line('G none', '8', '', '', '#REF!', '7'),                // 6  복구 불가
  line('H 20kg', '120', '"20,000"', '"17,875"', '"20,000"', '8'), // 7  KPL 초과 → eGS 20kg
  line('I 40kg', '300', '"40,000"', '"32,000"', '"40,000"', '9'), // 8  KPL·eGS 모두 초과
  line('J 307g dup', '25.4', '300', '307', '307', '10'),    // 9  0과 같은 key
].join('\n');

/** production 운임 구간 (감사: shipping_rate_brackets KPL_SF_US v4 0.5~19.5kg, EGS_STD_US v3 ~30kg) */
const BRACKETS: Record<string, [number, number][]> = {
  KPL: [[0.5, 13900], [1, 18900], [1.5, 24900], [2, 52290], [3, 61050], [12, 137530], [19.5, 200850]],
  eGS: [[0.5, 17100], [1, 23900], [1.5, 31400], [20, 418600], [30, 560000]],
};

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, {
    DATABASE_URL: 'postgres://mock', EBAY_ENVIRONMENT: 'SANDBOX',
    MAIN_SERVICE_URL: MAIN, SHIPPING_QUOTE_INTERNAL_TOKEN: TOKEN,
    AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false', AUTO_LISTING_SHIPPING_SHADOW_ENABLED: 'false', AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '1300',
    EBAY_POLICY_BUYER_SHIPPING_USD: '7.90', AUTO_LISTING_KPL_US_SERVICE_CODE: 'KPL_SF_US', AUTO_LISTING_EGS_SERVICE_CODE: 'EGS_STD_US',
    ...overrides,
  });
}

type Scripted = { status: number; body?: unknown } | 'timeout' | 'network';
let fetchCalls: { url: string; body: any; headers: Record<string, string> }[] = [];
let script: ((body: any, attempt: number) => Scripted | null) | null = null;
let inflight = 0;
let maxInflight = 0;

function mainResponse(body: any): Scripted {
  const table = BRACKETS[body.provider] ?? [];
  const hit = table.find(([kg]) => kg >= body.actualWeightKg - 1e-9);
  if (!hit) {
    return { status: 200, body: { ok: false, mode: 'raw', quote: { ok: false, blockedReason: 'WEIGHT_OVER_MAX_BRACKET' }, blockedReason: 'WEIGHT_OVER_MAX_BRACKET' } };
  }
  const quote = {
    ok: true, provider: body.provider, serviceCode: body.serviceCode, destinationCountry: 'US', chargeableWeightKg: body.actualWeightKg,
    appliedWeightBracketKg: hit[0], totalShippingCostKrw: hit[1], euVatKrw: 0, euHsFeeKrw: 0,
    rateVersionId: body.provider === 'KPL' ? 4 : 3, rateEffectiveFrom: '2026-09-13', warnings: [],
  };
  return { status: 200, body: { ok: true, mode: 'raw', quote, blockedReason: null } };
}

const fakeFetch = vi.fn(async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, body, headers: init.headers });
  const attempt = fetchCalls.filter(c => JSON.stringify(c.body) === init.body).length;
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
  try {
    await new Promise(r => setTimeout(r, 2));
    const res = (script && script(body, attempt)) || mainResponse(body);
    if (res === 'network') throw new TypeError('fetch failed');
    if (res === 'timeout') {
      return await new Promise<any>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => JSON.stringify(res.body) };
  } finally {
    inflight--;
  }
});

let addItemBodies: string[] = [];
let logs: string[] = [];
const startPriceOf = (b: string) => b.match(/<StartPrice currencyID="USD">([^<]+)<\/StartPrice>/)?.[1];
const noSleep = { sleep: async () => {} };

beforeEach(() => {
  store.tables.clear();
  store.nextId.clear();
  store.writes = 0;
  store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
  setEnv();
  fetchCalls = [];
  script = null;
  inflight = 0;
  maxInflight = 0;
  addItemBodies = [];
  logs = [];
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', fakeFetch);
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
  vi.spyOn(EbayClient.prototype as any, 'suggestCategoryId').mockResolvedValue('261068');
  vi.spyOn(EbayClient.prototype as any, 'callTradingAPI').mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    addItemBodies.push(body);
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${500000 + addItemBodies.length}</ItemID></AddItemResponse>`;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function parsedRows() {
  const raw = parseCsvRawText(CSV);
  return applyMapping(raw, detectFixedHeaderMapping(raw[0])!);
}

function seedUpload(uploadId = 'upload-r') {
  const rows = parsedRows();
  store.rowsOf(schema.csvUploads).push({ id: 1, uploadId, filename: 'r.csv', rowCount: rows.length, status: 'mapped', parsedRows: rows });
  return rows;
}

const uploadRow = () => store.rowsOf(schema.csvUploads)[0];
const quoteDeps = (extra: Record<string, unknown> = {}) => ({ config: getShippingPricingConfig(), fetchImpl: fakeFetch as any, ...noSleep, ...extra });
const kpl = (...indices: number[]) => indices.map(index => ({ index, provider: 'KPL' as const }));

async function appWith(...routes: any[]) {
  const app = Fastify();
  for (const r of routes) await app.register(r, { prefix: '/api' });
  return app;
}

async function runJob(app: any, selections: { index: number; provider: 'KPL' | 'eGS' }[], uploadId = 'upload-r') {
  const start = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes/jobs', payload: { uploadId, selections } });
  expect(start.statusCode).toBe(200);
  const snapshots: any[] = [];
  let job = start.json();
  for (let i = 0; i < 400 && job.status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 10));
    job = (await app.inject({ method: 'GET', url: `/api/upload/shipping-quotes/jobs/${start.json().jobId}` })).json();
    snapshots.push(job.progress);
  }
  return { start: start.json(), job, snapshots };
}

async function importIndices(indices: number[], providers: Record<number, string>) {
  const app = await appWith(crawlResultRoutes);
  const res = await app.inject({ method: 'POST', url: '/api/import/batch', payload: { uploadId: 'upload-r', selectedIndices: indices, shippingProviders: providers } });
  await app.close();
  const ids: number[] = [];
  for (const id of res.json().crawlResultIds) ids.push(await importFromCrawl(id));
  return ids;
}

// ── 1~5. 대량 견적 요청 제어 ───────────────────────────────
describe('1-5. 제한 동시성 큐 · 재시도 · 중복 제거', () => {
  it('1. 고유 56개 요청은 동시 최대 5개로만 실행 (Promise.all 일괄 발사 없음)', async () => {
    const inputs = Array.from({ length: 56 }, (_, i) => ({ provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 100 + i }));
    const results = await requestShippingQuotesDeduped([...inputs, ...inputs], { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any, ...noSleep });
    expect(QUOTE_CONCURRENCY).toBe(5);
    expect(results.size).toBe(56);
    expect(fetchCalls).toHaveLength(56);
    expect(maxInflight).toBe(5);
  });

  it('2. timeout은 300 → 800 → 1500ms 간격으로 3회 자동 재시도 후 QUOTE_TIMEOUT (기본 timeout 8초)', async () => {
    expect([QUOTE_TIMEOUT_MS, QUOTE_MAX_RETRIES, [...QUOTE_RETRY_DELAYS_MS]]).toEqual([8000, 3, [300, 800, 1500]]);
    script = () => 'timeout';
    const delays: number[] = [];
    const retries: number[] = [];
    const outcome = await requestShippingQuote({ provider: 'KPL', serviceCode: 'KPL_SF_US', chargeableWeightG: 307 }, {
      config: getShippingPricingConfig(), fetchImpl: fakeFetch as any, timeoutMs: 5,
      sleep: async (ms) => { delays.push(ms); }, onRetry: (n) => retries.push(n),
    });
    expect(outcome).toEqual({ ok: false, blockedReason: 'QUOTE_TIMEOUT', retries: 3 });
    expect(fetchCalls).toHaveLength(4);
    expect(delays).toEqual([300, 800, 1500]);
    expect(retries).toEqual([1, 2, 3]);

    fetchCalls = [];
    script = (_b, attempt) => (attempt <= 2 ? 'timeout' : null);
    expect(await requestShippingQuote({ provider: 'KPL', serviceCode: 'KPL_SF_US', chargeableWeightG: 307 }, { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any, timeoutMs: 5, ...noSleep }))
      .toMatchObject({ ok: true, shippingKrw: 13900, retries: 2 });
  });

  it('3. HTTP 429/502/503/504 · network error는 재시도 (복구되면 정상, 계속 실패하면 3회 후 차단)', async () => {
    const input = { provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 307 };
    for (const status of [429, 502, 503, 504]) {
      fetchCalls = [];
      script = (_b, attempt) => (attempt <= 3 ? { status, body: { ok: false, error: 'busy' } } : null);
      expect(await requestShippingQuote(input, quoteDeps())).toMatchObject({ ok: true, shippingKrw: 13900, retries: 3 });
      expect(fetchCalls).toHaveLength(4);

      fetchCalls = [];
      script = () => ({ status, body: { ok: false } });
      expect(await requestShippingQuote(input, quoteDeps())).toEqual({ ok: false, blockedReason: `QUOTE_HTTP_${status}`, retries: 3, httpStatus: status });
      expect(fetchCalls).toHaveLength(4);
    }
    fetchCalls = [];
    script = (_b, attempt) => (attempt === 1 ? 'network' : null);
    expect(await requestShippingQuote(input, quoteDeps())).toMatchObject({ ok: true, retries: 1 });
  });

  it('3b. HTTP 500 internal_quote_failed는 1회만 재시도 (일시적 DB 오류 복구), 다른 500은 재시도 없음', async () => {
    const input = { provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 307 };
    script = (_b, attempt) => (attempt === 1 ? { status: 500, body: { ok: false, error: 'internal_quote_failed' } } : null);
    expect(await requestShippingQuote(input, quoteDeps())).toMatchObject({ ok: true, shippingKrw: 13900, retries: 1 });
    expect(fetchCalls).toHaveLength(2);

    fetchCalls = [];
    script = () => ({ status: 500, body: { ok: false, error: 'internal_quote_failed' } });
    expect(await requestShippingQuote(input, quoteDeps())).toEqual({ ok: false, blockedReason: 'QUOTE_HTTP_500', retries: 1, httpStatus: 500 });
    expect(fetchCalls).toHaveLength(2);

    fetchCalls = [];
    script = (_b, attempt) => (attempt === 1 ? { status: 503, body: {} } : { status: 500, body: { ok: false, error: 'internal_quote_failed' } });
    expect(await requestShippingQuote(input, quoteDeps())).toMatchObject({ ok: false, blockedReason: 'QUOTE_HTTP_500', retries: 2 });
    expect(fetchCalls).toHaveLength(3);   // 503 재시도 1 + 500 재시도 1 → 최종 500

    fetchCalls = [];
    script = () => ({ status: 500, body: { ok: false, error: 'something_else' } });
    expect(await requestShippingQuote(input, quoteDeps())).toEqual({ ok: false, blockedReason: 'QUOTE_HTTP_500', httpStatus: 500 });
    expect(fetchCalls).toHaveLength(1);
  });

  it('4. 401·토큰 미설정·운임/국가/중량/계약 오류는 재시도하지 않음', async () => {
    const input = { provider: 'KPL' as const, serviceCode: 'KPL_SF_US', chargeableWeightG: 307 };
    const once = async (res: Scripted, expected: string) => {
      fetchCalls = [];
      script = () => res;
      expect(await requestShippingQuote(input, quoteDeps())).toMatchObject({ ok: false, blockedReason: expected });
      expect(fetchCalls).toHaveLength(1);
    };
    await once({ status: 401, body: { ok: false, error: 'INVALID_INTERNAL_TOKEN' } }, 'AUTH_ERROR');
    await once({ status: 503, body: { ok: false, error: 'INTERNAL_TOKEN_NOT_CONFIGURED' } }, 'AUTH_ERROR');
    for (const reason of ['COUNTRY_NOT_IN_MASTER', 'RATE_NOT_LOADED', 'WEIGHT_OVER_MAX_BRACKET', 'INVALID_WEIGHT']) {
      await once({ status: 200, body: { ok: false, mode: 'raw', quote: { ok: false, blockedReason: reason }, blockedReason: reason } }, reason);
    }
    await once({ status: 200, body: { ok: true, mode: 'shadow', quote: {} } }, 'QUOTE_CONTRACT_MISMATCH');
    fetchCalls = [];
    expect(await requestShippingQuote(input, { config: { mainServiceUrl: MAIN, internalToken: null }, fetchImpl: fakeFetch as any })).toEqual({ ok: false, blockedReason: 'SHIPPING_QUOTE_NOT_CONFIGURED' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('5. provider+serviceCode+US+무게 key는 1회만 요청하고 같은 key 상품 전체에 재사용', async () => {
    const rows = parsedRows();
    const result = await quoteUploadRows(rows, kpl(0, 9, 4), quoteDeps());   // 0·9 307g, 4 #REF!→307g
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({ provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', actualWeightKg: 0.307 });
    expect([0, 9, 4].map(i => result.snapshots.get(i)?.shippingKrw)).toEqual([13900, 13900, 13900]);
    expect(result.uniqueRequests).toBe(1);
  });
});

// ── 6~9. KPL 정상 구간 ────────────────────────────────────
describe('6-9. production에서 timeout으로 차단됐던 KPL 정상 중량', () => {
  it('307g 13,900원 / 752g 1kg 구간 / 1,023g 1.5kg 구간 / 1,500g 정상', async () => {
    const result = await quoteUploadRows(parsedRows(), kpl(0, 1, 2, 3), quoteDeps());
    const view = (i: number) => result.snapshots.get(i)!;
    expect(view(0)).toMatchObject({ status: 'OK', bracketWeightKg: 0.5, shippingKrw: 13900, shippingUsd: 10.7, listingPriceUsd: 36.1 });
    expect(view(1)).toMatchObject({ status: 'OK', bracketWeightKg: 1, shippingKrw: 18900, shippingUsd: 14.54, listingPriceUsd: 42.44 });
    expect(view(2)).toMatchObject({ status: 'OK', bracketWeightKg: 1.5, shippingKrw: 24900, shippingUsd: 19.16, listingPriceUsd: 79.26 });
    expect(view(3)).toMatchObject({ status: 'OK', bracketWeightKg: 1.5, shippingKrw: 24900, shippingUsd: 19.16, listingPriceUsd: 49.16 });
    expect([...result.alternatives.values()].every(a => a === null)).toBe(true);   // 정상이면 대체 견적 안 함
  });
});

// ── 10~12. 무게 자동 복구 ──────────────────────────────────
describe('10-12. 적용무게 자동 복구', () => {
  it('10. 적용무게 누락: 실측·부피 모두 있으면 MAX, 하나만 있으면 그 값', async () => {
    expect(resolveChargeableWeight({ chargeableWeightG: null, actualWeightG: 1000, volumetricWeightG: 1023 })).toEqual({ weightG: 1023, source: 'MAX_ACTUAL_VOLUMETRIC', recovered: true, originalChargeableWeightG: null });
    expect(resolveChargeableWeight({ chargeableWeightG: null, actualWeightG: null, volumetricWeightG: 752 })).toMatchObject({ weightG: 752, source: 'VOLUMETRIC_WEIGHT' });
    expect(resolveChargeableWeight({ chargeableWeightG: 500, actualWeightG: 900, volumetricWeightG: 900 })).toMatchObject({ weightG: 500, source: 'CSV', recovered: false });

    const rows = parsedRows();
    expect(rows[5]).toMatchObject({ chargeableWeightG: null, actualWeightG: 200 });
    const result = await quoteUploadRows(rows, kpl(5), quoteDeps());
    expect(result.snapshots.get(5)).toMatchObject({ status: 'OK', chargeableWeightG: 200, originalChargeableWeightG: null, recoveredChargeableWeightG: 200, recoverySource: 'ACTUAL_WEIGHT', shippingKrw: 13900 });
    expect(result.rows[5].chargeableWeightG).toBeNull();   // 원본 CSV 값 덮어쓰지 않음
    expect(describeRowShipping(result.rows[5])).toMatchObject({ quoteCategory: 'RECOVERED', weightRecoveryLabel: '적용무게 자동복구: 200g' });
  });

  it('11. #REF! 적용무게도 실측·부피무게가 정상이면 복구 (원본 셀 보존)', async () => {
    const rows = parsedRows();
    expect(rows[4].sourceColumns!['적용무게(g)']).toBe('#REF!');
    expect(rows[4].issues).toContainEqual({ code: 'chargeable_weight_recovered', level: 'warning', message: '적용무게 자동복구: 307g' });
    const preview = buildImportPreview(rows);
    expect(preview.rows[4]).toMatchObject({ defaultSelected: true, weightLabel: '307g', weightRecoveryLabel: '적용무게 자동복구: 307g' });

    const result = await quoteUploadRows(rows, kpl(4), quoteDeps());
    expect(result.snapshots.get(4)).toMatchObject({ status: 'OK', chargeableWeightG: 307, recoveredChargeableWeightG: 307, recoverySource: 'MAX_ACTUAL_VOLUMETRIC', listingPriceUsd: 20.9 });
    expect(result.rows[4].sourceColumns!['적용무게(g)']).toBe('#REF!');
  });

  it('12. 복구 불가능하면 INVALID_WEIGHT + "계산 가능한 무게가 없음", 견적 요청·대체 견적 없음', async () => {
    const rows = parsedRows();
    expect(rows[6].issues!.map(i => [i.code, i.level])).toContainEqual(['chargeable_weight_invalid', 'error']);
    expect(buildImportPreview(rows).rows[6].defaultSelected).toBe(false);
    const result = await quoteUploadRows(rows, kpl(6), quoteDeps());
    expect(fetchCalls).toHaveLength(0);
    expect(result.snapshots.get(6)).toMatchObject({ status: 'BLOCKED', blockedReason: 'INVALID_WEIGHT' });
    expect(result.alternatives.get(6)).toBeNull();
    expect(describeRowShipping(result.rows[6])).toMatchObject({ quoteStatus: 'WEIGHT_INVALID', quoteCategory: 'REVIEW', shippingLabel: '계산 실패', reasonCode: 'INVALID_WEIGHT', reasonLabel: '계산 가능한 무게가 없음' });
  });
});

// ── 13~16. 대체 배송사 ────────────────────────────────────
describe('13-16. 대체 배송사 견적 · 적용', () => {
  it('13. KPL 최대중량 초과 → eGS 대체 견적 표시 / eGS도 초과면 최종 사유', async () => {
    const result = await quoteUploadRows(parsedRows(), kpl(7, 8), quoteDeps());
    expect(result.snapshots.get(7)).toMatchObject({ status: 'BLOCKED', provider: 'KPL', blockedReason: 'WEIGHT_OVER_MAX_BRACKET' });
    expect(result.alternatives.get(7)).toMatchObject({ status: 'OK', provider: 'eGS', serviceCode: 'EGS_STD_US', bracketWeightKg: 20, shippingKrw: 418600 });
    const v7 = describeRowShipping(result.rows[7]);
    expect(v7).toMatchObject({
      quoteCategory: 'ALTERNATIVE', shippingLabel: '계산 실패', reasonLabel: '선택 배송사의 최대 허용중량 초과',
      alternative: { provider: 'eGS', label: 'eGS 20kg 구간 가능 · 배송비 418,600원', listingPriceLabel: '$442.00', warning: 'eGS는 브랜드 상품에 사용하지 않습니다' },
    });
    expect(v7.quoteTitle).toBe('예상 국제배송비: 계산 실패\n원인: 선택 배송사의 최대 허용중량 초과\n대체: eGS 20kg 구간 가능 · 배송비 418,600원 (eGS는 브랜드 상품에 사용하지 않습니다)');

    const v8 = describeRowShipping(result.rows[8]);
    expect(v8).toMatchObject({ quoteCategory: 'REVIEW', alternative: null, alternativeFailureLabel: 'eGS도 불가 · eGS의 최대 허용중량 초과' });
  });

  it('13b. 선택 배송사가 자동 재시도 후에도 timeout이면 그때 대체 배송사 견적 (재시도 기록 표시)', async () => {
    script = (body) => (body.provider === 'KPL' ? 'timeout' : null);
    const result = await quoteUploadRows(parsedRows(), kpl(0), quoteDeps({ timeoutMs: 5 }));
    expect(fetchCalls.map(c => c.body.provider)).toEqual(['KPL', 'KPL', 'KPL', 'KPL', 'eGS']);
    expect(result.snapshots.get(0)).toMatchObject({ status: 'BLOCKED', blockedReason: 'QUOTE_TIMEOUT', retries: 3 });
    expect(describeRowShipping(result.rows[0])).toMatchObject({
      quoteCategory: 'ALTERNATIVE', reasonLabel: '배송비 서버 응답 지연 · 자동 재시도 실패', retryNote: '3회 자동 재시도 완료',
      alternative: { provider: 'eGS', label: 'eGS 0.5kg 구간 가능 · 배송비 17,100원' },
    });
  });

  it('14. 대체 견적이 성공해도 배송사를 자동 변경하지 않음 → 그대로 import하면 등록 차단', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes);
    const { job } = await runJob(app, kpl(7));
    await app.close();
    const row = uploadRow().parsedRows[7];
    expect(row.selectedShippingProvider).toBe('KPL');
    expect(row.shippingQuote).toMatchObject({ provider: 'KPL', status: 'BLOCKED' });
    expect(row.shippingQuoteAlternative).toMatchObject({ provider: 'eGS', status: 'OK' });
    expect(job.result.rows[0]).toMatchObject({ shippingProvider: 'KPL', quoteCategory: 'ALTERNATIVE' });

    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const [productId] = await importIndices([7], { 7: 'KPL' });
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('15. 개별 [대체 적용] → 해당 행 provider·snapshot 교체 (다른 행 불변)', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes);
    await runJob(app, [...kpl(0, 7, 8)]);
    const before0 = structuredClone(uploadRow().parsedRows[0]);
    const res = await app.inject({ method: 'POST', url: '/api/upload/shipping-alternatives/apply', payload: { uploadId: 'upload-r', indices: [7] } });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: [7], skipped: [], rows: [{ index: 7, shippingProvider: 'eGS', quoteStatus: 'OK', quoteCategory: 'OK', listingPriceLabel: '$442.00' }] });
    const row7 = uploadRow().parsedRows[7];
    expect(row7).toMatchObject({ selectedShippingProvider: 'eGS', shippingQuote: { provider: 'eGS', status: 'OK', shippingKrw: 418600 }, shippingQuoteAlternative: null });
    expect(uploadRow().parsedRows[0]).toEqual(before0);

    // 적용 후 eGS로 import → 플래그 true면 대체 견적가로 등록 가능 (현재 production은 false)
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const [productId] = await importIndices([7], { 7: 'eGS' });
    await createListing(productId, 'ebay');
    expect(addItemBodies.map(startPriceOf)).toEqual(['442.00']);   // $120 + 418,600/1,300 = $322.00
  });

  it('16. [대체 가능 전체 적용] → 대체 가능 행만 한 번에 적용, 확인 필요 행은 그대로', async () => {
    seedUpload();
    script = (body) => (body.provider === 'KPL' && body.actualWeightKg === 0.752 ? { status: 200, body: { ok: false, mode: 'raw', quote: { ok: false, blockedReason: 'RATE_NOT_LOADED' }, blockedReason: 'RATE_NOT_LOADED' } } : null);
    const app = await appWith(uploadRoutes);
    const { job } = await runJob(app, kpl(0, 1, 7, 8));
    //   요약은 upload 전체 기준: 계산하지 않은 복구 불가 행(6)도 확인 필요로 집계
    expect(job.result.summary).toMatchObject({ ok: 1, alternative: 2, review: 2 });
    const res = await app.inject({ method: 'POST', url: '/api/upload/shipping-alternatives/apply', payload: { uploadId: 'upload-r', all: true } });
    await app.close();
    expect(res.json().applied).toEqual([1, 7]);
    expect(res.json().summary).toMatchObject({ ok: 3, alternative: 0, review: 2 });
    expect(uploadRow().parsedRows.map((r: any) => r.selectedShippingProvider ?? null).slice(0, 9)).toEqual(['KPL', 'eGS', null, null, null, null, null, 'eGS', 'KPL']);

    const pure = applyShippingAlternatives(uploadRow().parsedRows, [8, 0]);
    expect(pure.applied).toEqual([]);
    expect(pure.skipped).toEqual([{ index: 0, reason: 'NO_ALTERNATIVE' }, { index: 8, reason: 'NO_ALTERNATIVE' }]);
  });
});

// ── 17~20. 사유 · 요약 · 진행 · 중복 실행 ─────────────────
describe('17-20. 화면 사유 · 요약 · 진행상태 · 중복 실행', () => {
  it('17. 한국어 차단 사유 (코드표 10개) + 행 상세 문구와 title tooltip 둘 다 제공', async () => {
    expect(Object.fromEntries(['QUOTE_TIMEOUT', 'QUOTE_NETWORK_ERROR', 'RATE_NOT_LOADED', 'COUNTRY_NOT_IN_MASTER', 'WEIGHT_OVER_MAX_BRACKET', 'INVALID_WEIGHT', 'AUTH_ERROR', 'QUOTE_CONTRACT_MISMATCH', 'EXCHANGE_RATE_MISSING', 'SERVICE_CODE_MISSING'].map(c => [c, describeQuoteReason(c)]))).toEqual({
      QUOTE_TIMEOUT: '배송비 서버 응답 지연 · 자동 재시도 실패',
      QUOTE_NETWORK_ERROR: '배송비 서버 연결 실패',
      RATE_NOT_LOADED: '선택 배송사의 운임이 등록되지 않음',
      COUNTRY_NOT_IN_MASTER: '선택 배송사가 미국 배송을 지원하지 않음',
      WEIGHT_OVER_MAX_BRACKET: '선택 배송사의 최대 허용중량 초과',
      INVALID_WEIGHT: '계산 가능한 무게가 없음',
      AUTH_ERROR: '배송비 서버 인증 설정 오류',
      QUOTE_CONTRACT_MISMATCH: '배송비 응답 형식 오류',
      EXCHANGE_RATE_MISSING: '적용 환율이 설정되지 않음',
      SERVICE_CODE_MISSING: '배송 서비스 설정이 없음',
    });
    expect(describeQuoteReason('CHARGEABLE_WEIGHT_INVALID')).toBe('계산 가능한 무게가 없음');   // 이전 snapshot 코드
    expect(describeQuoteReason('QUOTE_PROVIDER_MISMATCH')).toBe('배송비 응답 형식 오류');

    seedUpload();
    script = (body) => (body.provider === 'KPL' && body.actualWeightKg === 0.307 ? 'timeout' : null);
    const result = await quoteUploadRows(uploadRow().parsedRows, kpl(0, 6, 7, 8), quoteDeps({ timeoutMs: 5 }));
    uploadRow().parsedRows = result.rows;
    const preview = buildImportPreview(result.rows);
    const html = renderStep2(preview);
    const rowHtml = (i: number) => html.match(new RegExp(`<tr class="import-row[^"]*" data-index="${i}"[\\s\\S]*?</tr>`))![0];
    expect(rowHtml(0)).toContain('title="예상 국제배송비: 계산 실패');
    expect(rowHtml(0)).toContain('원인: 배송비 서버 응답 지연 · 자동 재시도 실패');
    expect(rowHtml(0)).toContain('처리: 3회 자동 재시도 완료');
    expect(rowHtml(0)).toContain('대체: eGS 0.5kg 구간 가능 · 배송비 17,100원');
    expect(rowHtml(0)).toContain('class="btn btn-secondary btn-xs apply-alt-btn" data-index="0">대체 적용</button>');
    expect(rowHtml(6)).toContain('원인: 계산 가능한 무게가 없음');
    expect(rowHtml(8)).toContain('대체: eGS도 불가 · eGS의 최대 허용중량 초과');
    for (const i of [0, 6, 7, 8]) expect(rowHtml(i)).not.toMatch(/>\s*차단\s*</);   // "차단" 한 단어 표시 없음
  });

  it('18. 상단 요약 정상/자동복구/대체 가능/확인 필요 집계 (서버·화면·브라우저 JS 동일)', async () => {
    script = (body) => (body.provider === 'KPL' && body.actualWeightKg === 1.5 ? { status: 200, body: { ok: false, mode: 'raw', quote: { ok: false, blockedReason: 'RATE_NOT_LOADED' }, blockedReason: 'RATE_NOT_LOADED' } } : null);
    const result = await quoteUploadRows(parsedRows(), kpl(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), quoteDeps());
    const views = result.rows.map(describeRowShipping);
    const summary = summarizeQuoteCategories(views);
    // 정상 0·1·2·9 / 복구 4·5 / 대체 3(1,500g→eGS)·7 / 확인 6·8
    expect(summary).toEqual({ ok: 4, recovered: 2, alternative: 2, review: 2, pending: 0 });
    expect(countQuoteCategories(views.map(v => v.quoteCategory))).toEqual(summary);
    expect(formatQuoteSummary(summary)).toBe('정상 4개 · 자동복구 2개 · 대체 가능 2개 · 확인 필요 2개');

    const html = renderStep2(buildImportPreview(result.rows));
    expect(html).toContain('정상 4개 · 자동복구 2개 · 대체 가능 2개 · 확인 필요 2개');
    for (const label of ['실패 항목 자동 재계산', '대체 가능 전체 적용', '확인 필요만 보기', '전체 보기']) expect(html).toContain(label);
    expect(html).toMatch(/id="quote-summary" data-testid="quote-summary">/);   // 결과가 있으면 표시

    const providers = createProviderState(views.map((v, index) => ({ index, provider: v.shippingProvider })));
    expect(failedQuoteSelections(views.map((v, index) => ({ index, quoteCategory: v.quoteCategory })), providers).map((s: any) => s.index)).toEqual([3, 6, 7, 8]);
  });

  it('19. 진행상태: job 폴링으로 "배송비 계산 중 n / total · 정상 · 재시도 · 실패" 제공', async () => {
    seedUpload();
    script = (body, attempt) => (body.actualWeightKg === 0.752 && attempt === 1 ? { status: 503, body: { ok: false, error: 'busy' } } : null);
    const events: any[] = [];
    await quoteUploadRows(parsedRows(), kpl(0, 1, 2, 3), quoteDeps({ onProgress: (p: any) => events.push(p) }));
    const last = events[events.length - 1];
    expect(last).toMatchObject({ total: 4, done: 4, ok: 4, failed: 0, retried: 1, phase: 'done' });
    expect(events.map(e => e.done)).toEqual([...events.map(e => e.done)].sort((a, b) => a - b));   // 단조 증가
    expect(formatQuoteProgress({ total: 56, done: 18, ok: 15, retried: 2, failed: 1 })).toEqual({ main: '배송비 계산 중 18 / 56', detail: '정상 15 · 재시도 2 · 실패 1' });

    const app = await appWith(uploadRoutes);
    const { start, job, snapshots } = await runJob(app, kpl(0, 1, 2, 3, 7));
    await app.close();
    expect(start).toMatchObject({ alreadyRunning: false, status: 'running' });
    expect(job.status).toBe('done');
    expect(job.progress).toMatchObject({ total: 6, done: 6, phase: 'done' });   // KPL 5 key + eGS 대체 1 key (20kg)
    expect(snapshots.length).toBeGreaterThan(0);
    expect(job.result.rows.map((r: any) => r.index)).toEqual([0, 1, 2, 3, 7]);
  });

  it('20. 버튼 연타 방지 · 같은 upload 중복 실행 방지 · 재실행 시 정상 결과 유지(upsert)', async () => {
    const flight = createSingleFlight();
    let calls = 0;
    let release!: () => void;
    const first = flight.run(() => new Promise<void>(r => { calls++; release = r; }));
    expect(flight.run(async () => { calls++; })).toBeNull();
    expect(flight.isRunning()).toBe(true);
    await Promise.resolve();
    release();
    await first;
    expect(calls).toBe(1);
    expect(flight.isRunning()).toBe(false);

    seedUpload();
    const app = await appWith(uploadRoutes);
    let unblock!: () => void;
    const gate = new Promise<void>(r => { unblock = r; });
    script = null;
    fakeFetch.mockImplementationOnce(async (url: string, init: any) => { await gate; return { ok: true, status: 200, text: async () => JSON.stringify((mainResponse(JSON.parse(init.body)) as any).body) }; });
    const a = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes/jobs', payload: { uploadId: 'upload-r', selections: kpl(0) } });
    const b = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes/jobs', payload: { uploadId: 'upload-r', selections: kpl(0) } });
    const sync = await app.inject({ method: 'POST', url: '/api/upload/shipping-quotes', payload: { uploadId: 'upload-r', selections: kpl(0) } });
    expect(b.json()).toMatchObject({ jobId: a.json().jobId, alreadyRunning: true });
    expect(sync.statusCode).toBe(409);
    unblock();
    for (let i = 0; i < 100; i++) {
      const j = (await app.inject({ method: 'GET', url: `/api/upload/shipping-quotes/jobs/${a.json().jobId}` })).json();
      if (j.status !== 'running') break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(uploadRow().parsedRows[0].shippingQuote).toMatchObject({ status: 'OK', shippingKrw: 13900 });

    // 재실행: 이전 정상 행은 재요청·삭제 없이 유지, 실패 행만 다시 계산
    await runJob(app, kpl(7));
    fetchCalls = [];
    script = () => ({ status: 500, body: { ok: false, error: 'down' } });
    const again = await runJob(app, kpl(0, 7));
    await app.close();
    expect(again.job.progress).toMatchObject({ reused: 1 });
    expect(fetchCalls.map(c => c.body.provider)).toEqual(['KPL', 'eGS']);   // 7번 KPL + 대체 eGS 만
    expect(uploadRow().parsedRows[0].shippingQuote).toMatchObject({ status: 'OK', shippingKrw: 13900 });
  });
});

// ── 21~24. 안전 ───────────────────────────────────────────
describe('21-24. 등록 차단 · 레거시 · eBay 0 · 토큰 비노출', () => {
  it('21. pricing false면 정상·복구·대체 적용 상품 모두 eBay 등록 차단 유지', async () => {
    seedUpload();
    const app = await appWith(uploadRoutes);
    await runJob(app, kpl(0, 4, 7));
    await app.inject({ method: 'POST', url: '/api/upload/shipping-alternatives/apply', payload: { uploadId: 'upload-r', all: true } });
    await app.close();
    expect(getShippingPricingConfig().enabled).toBe(false);
    const ids = await importIndices([0, 4, 7], { 0: 'KPL', 4: 'KPL', 7: 'eGS' });
    for (const id of ids) await expect(createListing(id, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('22. 레거시 KRW 상품·CSV 회귀 없음 (가격 계산 경로, 견적 호출 0, 무게 표시)', async () => {
    const legacyCsv = ['이미지,상품URL,상품명,가격,무게', 'https://thumbnail.coupangcdn.com/a.jpg,https://www.coupang.com/vp/products/123,포켓몬 카드 151,"19,900원",500'].join('\n');
    const raw = parseCsvRawText(legacyCsv);
    const rows = applyMapping(raw, detectMappingByKeyword(raw));
    const preview = buildImportPreview(rows);
    expect(preview.showShipping).toBe(false);
    expect(preview.rows[0]).toMatchObject({ weightLabel: '500g', shippingProvider: null, quoteCategory: 'NONE', defaultSelected: true });

    store.rowsOf(schema.products).push({ id: 5000, sku: 'PMC-05000', title: 'Old', costPrice: '30000.00', metadata: null, condition: 'new', brand: '', productType: '' });
    const expected = await calculatePriceSimple(30000, { platform: 'ebay' });
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    await createListing(5000, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe(expected.salePrice.toFixed(2));
    expect(fetchCalls).toHaveLength(0);
  });

  it('23. 실제 eBay 호출 0 (callTradingAPI spy만, axios 네트워크 미사용)', async () => {
    const axios = (await import('axios')).default;
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('REAL NETWORK CALL'));
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('REAL NETWORK CALL'));
    seedUpload();
    const app = await appWith(uploadRoutes);
    await runJob(app, kpl(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
    await app.close();
    const [id] = await importIndices([0], { 0: 'KPL' });
    await expect(createListing(id, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(fetchCalls.every(c => c.url === `${MAIN}/api/internal/shipping/quote`)).toBe(true);
  });

  it('24. 토큰·main 내부 URL은 화면 HTML·브라우저 JS·job/적용 API 응답·로그에 없음', async () => {
    seedUpload();
    script = (body) => (body.actualWeightKg === 0.307 ? { status: 401, body: { ok: false, error: 'INVALID_INTERNAL_TOKEN' } } : null);
    const app = await appWith(uploadRoutes);
    const { job } = await runJob(app, kpl(0, 7));
    const apply = await app.inject({ method: 'POST', url: '/api/upload/shipping-alternatives/apply', payload: { uploadId: 'upload-r', all: true } });
    await app.close();
    expect(job.result.rows[0]).toMatchObject({ reasonCode: 'AUTH_ERROR', reasonLabel: '배송비 서버 인증 설정 오류', alternative: null });
    expect(fetchCalls.every(c => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);   // 서버 간 요청에만 사용

    const html = renderStep2(buildImportPreview(uploadRow().parsedRows));
    const browserJs = fs.readFileSync(path.join(process.cwd(), 'public/js/import-selection.js'), 'utf-8');
    for (const haystack of [html, browserJs, JSON.stringify(job), apply.body, logs.join('\n'), JSON.stringify(uploadRow().parsedRows)]) {
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain(MAIN);
    }
  });
});

function renderStep2(preview: ReturnType<typeof buildImportPreview>) {
  return new Eta({ views: path.join(process.cwd(), 'views') }).render('./step2-import', {
    uploadId: 'upload-r', rows: preview.rows, rowCount: preview.rows.length, priceHeader: preview.priceHeader,
    defaultSelectedCount: preview.defaultSelectedCount, errorRowCount: preview.errorRowCount,
    showShipping: preview.showShipping, shipping: publicShippingPricingConfig(getShippingPricingConfig()),
  });
}
