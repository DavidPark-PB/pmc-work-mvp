/**
 * Phase 2.1 — toybox USD CSV listing release guard
 *
 * 확정 규칙: StartPrice = CSV 판매가(USD) + 국제배송비(USD). 배송비 반영 플래그가 꺼져 있으면 toybox 상품은 AddItem 하지 않는다.
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
        findMany: async ({ where, with: withSpec }: any = {}) => rowsOf(state.schema[name])
          .filter((r: any) => (where ? where(r) : true))
          .map((r: any) => attach(name, structuredClone(r), withSpec)),
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
import { parseCsvRawText, detectFixedHeaderMapping, detectMappingByKeyword, applyMapping, buildImportRawData, buildImportPreview } from '../src/lib/csv-parser.js';
import { importFromCrawl, createListing, retryListing, relistListing } from '../src/services/listing-service.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { listingRoutes } from '../src/routes/listings.js';
import { getShippingPricingConfig, publicShippingPricingConfig } from '../src/lib/shipping-config.js';
import { requestShippingQuote } from '../src/lib/shipping-quote-client.js';
import { buildShippingQuoteSnapshot, CSV_PRICE_MESSAGES } from '../src/services/shipping-pricing.js';
import { classifyCsvProduct, crawlDisplayCsv, readProductCsvMetadata, resolveDisplayPrices, ListingPriceError } from '../src/services/listing-price.js';

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.platformListings, schema.pricingSettings, schema.csvUploads]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;

// ── fixtures ────────────────────────────────────────────
const TOKEN = 'release-guard-internal-token-0123456789';
const MAIN = 'https://main.release-guard.test';
const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';
const DISABLED_MESSAGE = '배송비 반영 기능이 비활성화되어 있어 이 상품을 eBay에 등록하지 않았습니다.';
const FULL_CSV = [
  '페이지,상품코드,상품명,Product Name (EN),입수량(박스),원가(toybox 판매가),판매가(toybox 정가),환산가(USD),마진(원),마진율,실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지',
  `1,43037,유희왕 시너지팩3탄-히어로즈 유니버스,Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,64,"19,500","30,000",25.4,"10,500",35.0%,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,https://toybox.kr/shopimages/toybox119/0011220000822.jpg`,
  `1,77589,토미카 프라레일 JR 마리오 트레인,Tomica Plarail JR Mario Train,6,"42,600","71,000",60.1,"28,400",40.0%,"1,000",43,17,7,"1,023","1,023",${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,https://toybox.kr/shopimages/toybox119/0010610007332.jpg`,
].join('\n');
const COUPANG_CSV = [
  '이미지,상품URL,상품명,가격',
  'https://thumbnail.coupangcdn.com/a.jpg,https://www.coupang.com/vp/products/123,포켓몬 카드 151,"19,900원"',
].join('\n');

/** 적용무게(kg) → [구간kg, KRW] — production 기대값 KPL US 0.5kg 13,900원 */
const RATE_TABLE: Record<string, Record<number, [number, number]>> = {
  KPL: { 0.307: [0.5, 13900], 1.023: [1.5, 24900] },
  eGS: { 0.307: [0.5, 17100], 1.023: [1.1, 26646] },
};

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, {
    DATABASE_URL: 'postgres://mock', EBAY_ENVIRONMENT: 'SANDBOX',
    MAIN_SERVICE_URL: MAIN, SHIPPING_QUOTE_INTERNAL_TOKEN: TOKEN,
    AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false', AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '1300',
    EBAY_POLICY_BUYER_SHIPPING_USD: '7.90', AUTO_LISTING_KPL_US_SERVICE_CODE: 'KPL_SF_US', AUTO_LISTING_EGS_SERVICE_CODE: 'EGS_STD_US',
    ...overrides,
  });
}

let fetchCalls: { url: string; body: any }[] = [];
const fakeFetch = vi.fn(async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, body });
  const hit = RATE_TABLE[body.provider]?.[body.actualWeightKg];
  const quote = hit
    ? { ok: true, provider: body.provider, serviceCode: body.serviceCode, destinationCountry: 'US', chargeableWeightKg: body.actualWeightKg, appliedWeightBracketKg: hit[0], totalShippingCostKrw: hit[1], euVatKrw: 0, euHsFeeKrw: 0, rateVersionId: body.provider === 'KPL' ? 4 : 3, rateEffectiveFrom: '2026-09-13' }
    : { ok: false, blockedReason: 'WEIGHT_OVER_MAX_BRACKET' };
  const payload = { ok: quote.ok, mode: 'raw', quote, blockedReason: quote.ok ? null : quote.blockedReason };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
});

let addItemBodies: string[] = [];
let tradingCalls: string[] = [];
const startPriceOf = (b: string) => b.match(/<StartPrice currencyID="USD">([^<]+)<\/StartPrice>/)?.[1];

beforeEach(() => {
  store.tables.clear();
  store.nextId.clear();
  store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' });
  setEnv();
  fetchCalls = [];
  addItemBodies = [];
  tradingCalls = [];
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', fakeFetch);
  for (const level of ['log', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.spyOn(EbayClient.prototype as any, 'suggestCategoryId').mockResolvedValue('261068');
  vi.spyOn(EbayClient.prototype as any, 'callTradingAPI').mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    tradingCalls.push(callName);
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    addItemBodies.push(body);
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${400000 + addItemBodies.length}</ItemID></AddItemResponse>`;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** CSV 행 → Phase 1 import(batch)와 동일한 crawl_results 행 */
function seedCrawl(csv: string, rowIndex: number, id: number, fixed = true) {
  const raw = parseCsvRawText(csv);
  const mapping = fixed ? detectFixedHeaderMapping(raw[0])! : detectMappingByKeyword(raw);
  const row = applyMapping(raw, mapping)[rowIndex];
  const crawl = {
    id, sourceId: 1, externalId: row.url, title: row.name, titleEn: null, price: row.price.toFixed(2),
    currency: row.priceCurrency === 'USD' ? 'USD' : 'KRW', url: row.url, imageUrl: row.image.split('|||')[0],
    rawData: buildImportRawData(row, { uploadId: 'u', rowIndex }), status: 'new', productId: null, ownerId: 'admin', ownerName: 'Admin',
    crawledAt: new Date('2026-09-14T00:00:00Z'),
  };
  store.rowsOf(schema.crawlResults).push(crawl);
  return crawl;
}

/** toybox 행 + (선택) raw /quote 견적 snapshot → product */
async function toyboxProduct(rowIndex: number, id: number, opts: { provider?: 'KPL' | 'eGS'; quote?: boolean } = {}) {
  const crawl = seedCrawl(FULL_CSV, rowIndex, id);
  const fields = crawl.rawData.csvImport.fields;
  if (opts.provider) {
    fields.selectedShippingProvider = opts.provider;
    if (opts.quote !== false) {
      const config = getShippingPricingConfig();
      const serviceCode = config.serviceCodes[opts.provider]!;
      const outcome = await requestShippingQuote({ provider: opts.provider, serviceCode, chargeableWeightG: fields.chargeableWeightG }, { config, fetchImpl: fakeFetch as any });
      crawl.rawData.csvImport.shippingQuote = buildShippingQuoteSnapshot({
        provider: opts.provider, serviceCode, chargeableWeightG: fields.chargeableWeightG, csvSalePriceUsd: fields.salePriceUsd,
        exchangeRate: config.exchangeRate, buyerShippingUsd: config.buyerShippingUsd, outcome,
      });
    }
  }
  return importFromCrawl(id);
}

async function legacyProduct(id = 201) {
  return importFromCrawl(seedCrawl(COUPANG_CSV, 0, id, false).id);
}

async function waitJob(jobId: string) {
  const jobs = (globalThis as any).__jobs as Map<string, any>;
  for (let i = 0; i < 80 && jobs.get(jobId)?.status !== 'done'; i++) await new Promise(r => setTimeout(r, 100));
  return jobs.get(jobId);
}

async function listingApp() {
  const app = Fastify();
  await app.register(listingRoutes, { prefix: '/api' });
  return app;
}

// ── §1 toybox 식별 ──────────────────────────────────────
describe('toybox USD CSV 식별', () => {
  it('csvImport + USD + salePriceUsd + importedFrom 원본 일치 + 원본 헤더 환산가(USD) → TOYBOX_USD', async () => {
    const crawl = seedCrawl(FULL_CSV, 0, 101);
    const csv = crawlDisplayCsv(crawl);
    expect(classifyCsvProduct(csv, crawl)).toBe('TOYBOX_USD');
    expect(classifyCsvProduct(undefined, null)).toBe('LEGACY');
    expect(classifyCsvProduct(csv, null)).toBe('USD_CSV');                                  // 원본 없음
    expect(classifyCsvProduct(csv, { ...crawl, id: 999 })).toBe('USD_CSV');                // importedFrom 불일치
    const noHeader = structuredClone(crawl);
    delete noHeader.rawData.csvImport.sourceColumns['환산가(USD)'];
    expect(classifyCsvProduct(csv, noHeader)).toBe('USD_CSV');                             // 헤더 증거 없음

    const productId = await importFromCrawl(101);
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    await expect(createListing(productId, 'ebay')).rejects.toBeInstanceOf(ListingPriceError); // 견적 없음
  });

  it('레거시 KRW CSV / metadata 없는 상품은 csvImport가 없어 LEGACY', async () => {
    const productId = await legacyProduct();
    const product = store.rowsOf(schema.products).find(p => p.id === productId);
    expect(readProductCsvMetadata(product.metadata)).toBeUndefined();
    expect(classifyCsvProduct(readProductCsvMetadata(product.metadata), store.rowsOf(schema.crawlResults)[0])).toBe('LEGACY');
  });
});

// ── §5 테스트 1~12 ─────────────────────────────────────
describe('1. 플래그 false — toybox USD 상품 AddItem 0건', () => {
  it('견적 snapshot이 있어도 CSV 판매가 단독 등록 없이 차단, listing 행 없음', async () => {
    const p1 = await toyboxProduct(0, 101, { provider: 'KPL' });
    const p2 = await toyboxProduct(1, 102);
    for (const id of [p1, p2]) {
      await expect(createListing(id, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED', message: DISABLED_MESSAGE });
      await expect(createListing(id, 'ebay', { dryRun: true })).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    }
    expect(CSV_PRICE_MESSAGES.SHIPPING_PRICING_DISABLED).toBe(DISABLED_MESSAGE);
    expect(addItemBodies).toHaveLength(0);
    expect(tradingCalls).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)).toHaveLength(0);
  });
});

describe('2. 플래그 false — 레거시 KRW 상품은 기존 StartPrice', () => {
  it('KRW CSV / metadata 없는 기존 상품 모두 calculatePriceSimple 그대로 등록', async () => {
    const productId = await legacyProduct();
    const expected = await calculatePriceSimple(19900, { platform: 'ebay' });
    await createListing(productId, 'ebay');
    store.rowsOf(schema.products).push({ id: 5000, sku: 'PMC-05000', title: 'Old', costPrice: '30000.00', metadata: null, condition: 'new', brand: '', productType: '' });
    const expectedOld = await calculatePriceSimple(30000, { platform: 'ebay' });
    await createListing(5000, 'ebay');
    expect(addItemBodies.map(startPriceOf)).toEqual([expected.salePrice.toFixed(2), expectedOld.salePrice.toFixed(2)]);
    expect(store.rowsOf(schema.platformListings).map(l => l.platformData.pricing.source)).toEqual(['LEGACY_CALCULATED', 'LEGACY_CALCULATED']);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('3·10. 플래그 true + 유효 snapshot — StartPrice = CSV USD + 배송비 USD ($7.90 차감·가산 없음)', () => {
  it('KPL: $25.40 + ceil(13,900/1,300)=$10.70 → 36.10 / $60.10 + ceil(24,900/1,300)=$19.16 → 79.26', async () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const p1 = await toyboxProduct(0, 101, { provider: 'KPL' });
    const p2 = await toyboxProduct(1, 102, { provider: 'KPL' });
    const quoteCalls = fetchCalls.length;
    await createListing(p1, 'ebay');
    await createListing(p2, 'ebay');
    expect(addItemBodies.map(startPriceOf)).toEqual(['36.10', '79.26']);
    expect(fetchCalls).toHaveLength(quoteCalls);   // 등록 시 재견적 없음 (snapshot 사용)

    // 10. $7.90 은 차감·가산하지 않는다
    expect(addItemBodies.map(startPriceOf)).not.toContain('28.20');   // 36.10 - 7.90
    expect(addItemBodies.map(startPriceOf)).not.toContain('44.00');   // 36.10 + 7.90
    for (const body of addItemBodies) expect(body).not.toContain('7.90');
    expect(store.rowsOf(schema.platformListings)[0].platformData.pricing).toMatchObject({
      source: 'CSV_USD_PLUS_SHIPPING', salePrice: 36.1, csvSalePriceUsd: 25.4, basePriceUsd: 25.4, shippingUsd: 10.7, shippingKrw: 13900,
      exchangeRate: 1300, provider: 'KPL', serviceCode: 'KPL_SF_US', buyerShippingUsd: 7.9,
    });
  });

  it('eGS 0.5kg 17,100원 → $13.16, StartPrice 38.56', async () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const productId = await toyboxProduct(0, 101, { provider: 'eGS' });
    await createListing(productId, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('38.56');
  });
});

describe('4. 플래그 true + snapshot 없음 → 차단', () => {
  it('배송사 미선택 / 견적 없음 / BLOCKED 견적은 AddItem 0건', async () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const noProvider = await toyboxProduct(0, 101);
    const noQuote = await toyboxProduct(1, 102, { provider: 'KPL', quote: false });
    await expect(createListing(noProvider, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PROVIDER_MISSING' });
    await expect(createListing(noQuote, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });

    const blockedProduct = await toyboxProduct(0, 103, { provider: 'KPL' });
    store.rowsOf(schema.products).find(p => p.id === blockedProduct).metadata.csvImport.shippingQuote.status = 'BLOCKED';
    await expect(createListing(blockedProduct, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISSING' });
    expect(addItemBodies).toHaveLength(0);
  });
});

describe('5. snapshot 불일치 → 차단', () => {
  async function quoted() {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const productId = await toyboxProduct(0, 101, { provider: 'KPL' });
    return { productId, csv: store.rowsOf(schema.products).find(p => p.id === productId).metadata.csvImport };
  }

  it('적용무게 불일치 → SHIPPING_QUOTE_MISMATCH', async () => {
    const { productId, csv } = await quoted();
    csv.chargeableWeightG = 1023;
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISMATCH' });
  });

  it('배송사 변경(provider 불일치) / 서비스 코드 변경 → SHIPPING_QUOTE_MISMATCH', async () => {
    const { productId, csv } = await quoted();
    csv.selectedShippingProvider = 'eGS';
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISMATCH' });
    csv.selectedShippingProvider = 'KPL';
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true', AUTO_LISTING_KPL_US_SERVICE_CODE: 'KPL_OTHER_US' });
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISMATCH' });
  });

  it('환율 변경 → EXCHANGE_RATE_MISMATCH, 환율 없음 → EXCHANGE_RATE_INVALID', async () => {
    const { productId } = await quoted();
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true', AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '1400' });
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'EXCHANGE_RATE_MISMATCH' });
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true', AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '' });
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'EXCHANGE_RATE_INVALID' });
  });

  it('snapshot USD 배송비 변조(저장 KRW·환율과 불일치) → SHIPPING_QUOTE_MISMATCH', async () => {
    const { productId, csv } = await quoted();
    csv.shippingQuote.shippingUsd = 1.0;
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_QUOTE_MISMATCH' });
    expect(addItemBodies).toHaveLength(0);
  });
});

describe('6. create / retry / relist 동일 guard', () => {
  it('플래그 false: 세 경로 모두 SHIPPING_PRICING_DISABLED, 리스팅 상태·가격 불변', async () => {
    const productId = await toyboxProduct(0, 101, { provider: 'KPL' });
    store.rowsOf(schema.platformListings).push(
      { id: 7001, productId, platform: 'ebay', status: 'error', price: '25.40', quantity: 5 },
      { id: 7002, productId, platform: 'ebay', status: 'ended', price: '25.40', quantity: 5 },
    );
    const results = await Promise.allSettled([createListing(productId, 'ebay'), retryListing(7001), relistListing(7002)]);
    expect(results.map(r => r.status === 'rejected' && (r.reason as ListingPriceError).code)).toEqual(
      ['SHIPPING_PRICING_DISABLED', 'SHIPPING_PRICING_DISABLED', 'SHIPPING_PRICING_DISABLED'],
    );
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings).map(l => [l.id, l.status, l.price])).toEqual([[7001, 'error', '25.40'], [7002, 'ended', '25.40']]);
  });

  it('플래그 true: 세 경로 모두 같은 StartPrice 36.10', async () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const created = await toyboxProduct(0, 101, { provider: 'KPL' });
    const retried = await toyboxProduct(0, 103, { provider: 'KPL' });
    const relisted = await toyboxProduct(0, 104, { provider: 'KPL' });
    store.rowsOf(schema.platformListings).push(
      { id: 7001, productId: retried, platform: 'ebay', status: 'error', price: '25.40', quantity: 5 },
      { id: 7002, productId: relisted, platform: 'ebay', status: 'ended', price: '25.40', quantity: 5 },
    );
    await createListing(created, 'ebay');
    await retryListing(7001);
    await relistListing(7002);
    expect(addItemBodies.map(startPriceOf)).toEqual(['36.10', '36.10', '36.10']);
  });

  it('소스: 세 경로가 하나의 resolver만 호출하고 CSV가 단독 경로가 남아 있지 않다', () => {
    const service = fs.readFileSync(path.join(process.cwd(), 'src/services/listing-service.ts'), 'utf-8');
    expect(service.match(/await resolveProductSalePrice\(/g)).toHaveLength(3);
    expect(service).not.toMatch(/evaluateCsvListingPrice|salePriceUsd/);
    const srcFiles = ['src/services/listing-price.ts', 'src/services/shipping-pricing.ts', 'src/services/listing-service.ts', 'src/routes/listings.ts'];
    for (const f of srcFiles) expect(fs.readFileSync(path.join(process.cwd(), f), 'utf-8')).not.toContain('CSV_USD_FIXED');
  });
});

describe('7. 혼합 batch — toybox만 실패, 레거시 계속, batch 중단 없음', () => {
  it('POST /api/listings/create (productIds): [toybox, legacy, toybox]', async () => {
    const t1 = await toyboxProduct(0, 101, { provider: 'KPL' });
    const legacy = await legacyProduct();
    const t2 = await toyboxProduct(1, 102);
    const expected = await calculatePriceSimple(19900, { platform: 'ebay' });

    const app = await listingApp();
    const res = await app.inject({ method: 'POST', url: '/api/listings/create', payload: { productIds: [t1, legacy, t2], platforms: ['ebay'] } });
    const job = await waitJob(res.json().jobId);
    await app.close();

    expect(job).toMatchObject({ status: 'done', total: 3, completed: 1, failed: 2 });
    expect(job.results.map((r: any) => [r.success, r.error ?? null])).toEqual([
      [false, DISABLED_MESSAGE],
      [true, null],
      [false, DISABLED_MESSAGE],
    ]);
    expect(addItemBodies.map(startPriceOf)).toEqual([expected.salePrice.toFixed(2)]);
  }, 15000);
});

describe('8. UI 안내', () => {
  const eta = new Eta({ views: path.join(process.cwd(), 'views') });
  const NOTICE_LINES = ['배송비 계산 준비 중', '현재는 상품 검수와 가져오기만 가능합니다.', '배송비 반영 전에는 eBay 등록이 차단됩니다.'];

  function renderStep2() {
    const raw = parseCsvRawText(FULL_CSV);
    const preview = buildImportPreview(applyMapping(raw, detectFixedHeaderMapping(raw[0])!));
    return eta.render('./step2-import', {
      uploadId: 'u', rows: preview.rows, rowCount: preview.rows.length, priceHeader: preview.priceHeader,
      defaultSelectedCount: preview.defaultSelectedCount, errorRowCount: preview.errorRowCount,
      showShipping: preview.showShipping, shipping: publicShippingPricingConfig(getShippingPricingConfig()),
    });
  }

  function renderDashboard() {
    const data = { marginRate: 0.2, exchangeRate: 1300, platformFeeRate: 0.18, defaultShippingKrw: 12000 };
    const allSettings = { ebay: data, shopify: data, alibaba: data, shopee: data };
    const shipping = getShippingPricingConfig();
    const crawls = store.rowsOf(schema.crawlResults);
    const items = crawls.map(c => {
      const { costKrw, priceSource, ...prices } = resolveDisplayPrices({ costKrw: parseFloat(String(c.price)) || 0, csv: crawlDisplayCsv(c), allSettings, shipping });
      return {
        type: 'crawl', id: c.id, sku: null, title: c.title, titleEn: null, titleKo: c.title, imageUrl: c.imageUrl, sourceUrl: c.url,
        sourceLabel: 'CSV', costKrw, priceSource, listings: '[]', status: 'new', createdAt: c.crawledAt, ownerId: 'admin', ownerName: 'Admin', ...prices,
      };
    });
    return eta.render('./dashboard', {
      step: 0, user: { id: 'admin', name: 'Admin', isAdmin: true },
      stats: { totalProducts: 0, productsByStatus: {}, totalListings: 0, listingsByPlatform: {}, listingsByStatus: {}, crawlByStatus: { new: items.length }, completedCount: 0, endedCount: 0 },
      allItems: items, recentCrawlResults: items, activeJobs: [],
      releaseGuard: { shippingPricingEnabled: shipping.enabled, pricingDisabledCount: items.filter(i => i.ebayBlockCode === 'SHIPPING_PRICING_DISABLED').length },
    });
  }

  it('가져오기 화면: 플래그 false면 안내 문구 표시 (가져오기 버튼은 유지), true면 없음', () => {
    const off = renderStep2();
    for (const line of NOTICE_LINES) expect(off).toContain(line);
    expect(off).toContain('data-testid="release-guard-notice"');
    expect(off).toMatch(/<button id="import-btn" class="btn btn-primary btn-lg">/);   // import 허용

    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const on = renderStep2();
    expect(on).not.toContain('배송비 계산 준비 중');
  });

  it('대시보드: 플래그 false면 toybox 행 eBay 체크박스·업로드 버튼 비활성 + 안내, 레거시 행은 그대로', () => {
    seedCrawl(FULL_CSV, 0, 101);
    seedCrawl(COUPANG_CSV, 0, 201, false);
    const off = renderDashboard();
    for (const line of NOTICE_LINES) expect(off).toContain(line);
    expect(off.match(/data-testid="release-guard-notice"/g)!.length).toBe(2);             // 업로드 대기 / 전체 탭 툴바
    expect(off.match(/value="ebay" disabled/g)!.length).toBe(2);                            // toybox 행 (대기·전체)
    expect(off.match(/eBay \(차단\)/g)!.length).toBe(2);
    expect(off.match(/data-release-guard="blocked"/g)!.length).toBe(2);
    expect(off).toContain(`title="${DISABLED_MESSAGE}"`);
    expect(off.match(/value="ebay" checked onchange/g)!.length).toBe(2);                    // 레거시 행 (대기·전체)

    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const on = renderDashboard();
    expect(on).not.toContain('data-testid="release-guard-notice"');
  });
});

describe('9. UI 우회 직접 서버 호출도 차단', () => {
  it('create(productIds·crawlResultIds) / retry / relist API 직접 호출 → AddItem 0건, 상품별 사유', async () => {
    const productId = await toyboxProduct(0, 101, { provider: 'KPL' });
    seedCrawl(FULL_CSV, 1, 102);   // 아직 import 안 된 crawl 행
    store.rowsOf(schema.platformListings).push(
      { id: 7001, productId, platform: 'ebay', status: 'error', price: '25.40', quantity: 5 },
      { id: 7002, productId, platform: 'ebay', status: 'ended', price: '25.40', quantity: 5 },
    );
    const app = await listingApp();
    const calls = [
      { url: '/api/listings/create', payload: { productIds: [productId], platforms: ['ebay'] } },
      { url: '/api/listings/create', payload: { crawlResultIds: [102], platforms: ['ebay'] } },
      { url: '/api/listings/create', payload: { productIds: [productId], platforms: ['ebay'], dryRun: true } },
      { url: '/api/listings/retry', payload: { listingIds: [7001] } },
      { url: '/api/listings/relist', payload: { listingIds: [7002] } },
    ];
    const jobs = [];
    for (const call of calls) {
      const res = await app.inject({ method: 'POST', ...call });
      jobs.push(await waitJob(res.json().jobId));
    }
    await app.close();
    for (const job of jobs) {
      expect(job).toMatchObject({ status: 'done', completed: 0, failed: 1 });
      expect(job.results[0]).toMatchObject({ success: false, error: DISABLED_MESSAGE });
    }
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings).map(l => l.status)).toEqual(['error', 'ended']);
  }, 20000);
});

describe('11. 실제 eBay 호출 0건', () => {
  it('eBay는 callTradingAPI spy로만, axios 실제 네트워크 사용 없음, fetch는 fake main quote만', async () => {
    const axios = (await import('axios')).default;
    const axiosPost = vi.spyOn(axios, 'post').mockRejectedValue(new Error('REAL NETWORK CALL'));
    const axiosGet = vi.spyOn(axios, 'get').mockRejectedValue(new Error('REAL NETWORK CALL'));
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    const toybox = await toyboxProduct(0, 101, { provider: 'KPL' });
    const legacy = await legacyProduct();
    await createListing(toybox, 'ebay');
    await createListing(legacy, 'ebay');
    setEnv();
    await expect(createListing(toybox, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(tradingCalls).toEqual(['AddItem', 'AddItem']);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
    expect(fetchCalls.every(c => c.url === `${MAIN}/api/internal/shipping/quote`)).toBe(true);
  });
});
