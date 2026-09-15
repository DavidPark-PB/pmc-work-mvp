/**
 * tests/port-production-integration.test.ts
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
    lte: (col: unknown, val: any) => (row: Record<string, any>) => row[keyOf(col)] <= val,
    gte: (col: unknown, val: any) => (row: Record<string, any>) => row[keyOf(col)] >= val,
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
vi.mock('../src/lib/csv-mapping-ai.js', () => ({ detectMappingWithAI: vi.fn(async () => (globalThis as any).__aiMapping ?? null) }));
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
import os from 'os';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { Eta } from 'eta';
import { parseCsvRawText, detectFixedHeaderMapping, detectMappingByKeyword, applyMapping, buildImportPreview, buildImportRawData } from '../src/lib/csv-parser.js';
import { detectMappingWithAI } from '../src/lib/csv-mapping-ai.js';
import { importFromCrawl, createListing, retryListing } from '../src/services/listing-service.js';
import { calculatePriceSimple, calculateListingPrice } from '../src/services/pricing.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { crawlResultRoutes } from '../src/routes/crawl-results.js';
import { requestShippingQuote } from '../src/lib/shipping-quote-client.js';
import { getShippingPricingConfig } from '../src/lib/shipping-config.js';
import { EMPTY_ACTIVE_LIST } from './fixtures/ebay-trading.js';

/**
 * PMC AUTO Phase 1–2 → production source (pmc-work-mvp/automation) integration.
 * Locks in behaviours the target had BEFORE the port so Phase 1–2 cannot regress them:
 *   · multi-image '|||' import, AI-mapping background overwrite, SSE-independent upload flow
 *   · legacy cost<=0 listing block messages, default_quantity, 'ungraded' condition, itemSpecifics
 *   · shipping shadow hook (/listing-preview) independent of the new raw /quote pricing path
 */

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.crawlSources, schema.platformListings, schema.pricingSettings, schema.csvUploads, schema.shippingRates]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;

const TOKEN = 'port-test-internal-token-0123456789';
const MAIN = 'https://main.port.test';
const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';
const FULL_HEADER = '페이지,상품코드,상품명,Product Name (EN),입수량(박스),원가(toybox 판매가),판매가(toybox 정가),환산가(USD),마진(원),마진율,실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지';
const FULL_CSV = [
  FULL_HEADER,
  `1,43037,유희왕 시너지팩3탄-히어로즈 유니버스,Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,64,"19,500","30,000",25.4,"10,500",35.0%,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,https://toybox.kr/shopimages/toybox119/0011220000822.jpg`,
  `1,77589,토미카 프라레일 JR 마리오 트레인,Tomica Plarail JR Mario Train,6,"42,600","71,000",60.1,"28,400",40.0%,"1,000",43,17,7,"1,023","1,023",${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,https://toybox.kr/shopimages/toybox119/0010610007332.jpg`,
].join('\n');
const LEGACY_MULTI_IMAGE_CSV = [
  '상품명,가격,상품URL,이미지,추가이미지',
  '포켓몬 카드 151,"19,900원",https://www.coupang.com/vp/products/123,https://thumbnail.coupangcdn.com/a.jpg,https://thumbnail.coupangcdn.com/b.jpg',
].join('\n');

function setEnv(overrides: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, {
    DATABASE_URL: 'postgres://mock', EBAY_ENVIRONMENT: 'SANDBOX',
    MAIN_SERVICE_URL: MAIN, SHIPPING_QUOTE_INTERNAL_TOKEN: TOKEN,
    AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'false', AUTO_LISTING_SHIPPING_EXCHANGE_RATE: '1300',
    AUTO_LISTING_KPL_US_SERVICE_CODE: 'KPL_SF_US', AUTO_LISTING_EGS_SERVICE_CODE: 'EGS_STD_US',
    ...overrides,
  });
}

let fetchCalls: { url: string; body: any }[] = [];
const fakeFetch = vi.fn(async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, body });
  if (url.endsWith('/api/internal/shipping/quote')) {
    const quote = { ok: true, provider: body.provider, serviceCode: body.serviceCode, destinationCountry: 'US', chargeableWeightKg: body.actualWeightKg, appliedWeightBracketKg: 0.5, totalShippingCostKrw: 13900, euVatKrw: 0, euHsFeeKrw: 0, rateVersionId: 4, rateEffectiveFrom: '2026-09-13' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, mode: 'raw', quote, blockedReason: null }), json: async () => ({ ok: true, mode: 'raw', quote }) };
  }
  return { ok: true, status: 200, text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
});

let addItemBodies: string[] = [];
const startPriceOf = (b: string) => b.match(/<StartPrice currencyID="USD">([^<]+)<\/StartPrice>/)?.[1];
let logs: string[] = [];
const flush = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => {
  store.tables.clear();
  store.nextId.clear();
  store.rowsOf(schema.pricingSettings).push({ id: 1, platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000', defaultQuantity: 3 });
  setEnv();
  delete process.env.AUTO_LISTING_SHIPPING_SHADOW_ENABLED;
  delete process.env.SHIPPING_QUOTE_INTERNAL_TOKEN;
  delete process.env.MAIN_SERVICE_URL;
  (globalThis as any).__aiMapping = null;
  fetchCalls = [];
  addItemBodies = [];
  logs = [];
  vi.restoreAllMocks();
  vi.mocked(detectMappingWithAI).mockClear();
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
    //   신규 CSV eBay 등록 전 READ-ONLY 중복 확인 — 같은 SKU 활성 상품 없음
    if (callName === 'GetMyeBaySelling') return EMPTY_ACTIVE_LIST;
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    addItemBodies.push(body);
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${300000 + addItemBodies.length}</ItemID></AddItemResponse>`;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function seedCrawl(csv: string, rowIndex: number, id: number, fixed = true) {
  const raw = parseCsvRawText(csv);
  const mapping = fixed ? detectFixedHeaderMapping(raw[0])! : detectMappingByKeyword(raw);
  const row = applyMapping(raw, mapping)[rowIndex];
  store.rowsOf(schema.crawlResults).push({
    id, sourceId: 1, externalId: row.url, title: row.name, titleEn: null, price: row.price.toFixed(2),
    currency: row.priceCurrency === 'USD' ? 'USD' : 'KRW', url: row.url, imageUrl: row.image.split('|||')[0],
    rawData: buildImportRawData(row, { uploadId: 'u', rowIndex }), status: 'new', productId: null, ownerId: 'admin', ownerName: 'Admin',
  });
  return row;
}

describe('target 기존 동작 보존 — CSV 이미지·매핑', () => {
  it('레거시 CSV 다중 이미지 "|||" 병합은 그대로, toybox는 R2만 (원본 이미지 컬럼 제외)', () => {
    const legacyRaw = parseCsvRawText(LEGACY_MULTI_IMAGE_CSV);
    const legacy = applyMapping(legacyRaw, detectMappingByKeyword(legacyRaw))[0];
    expect(legacy.image).toBe('https://thumbnail.coupangcdn.com/a.jpg|||https://thumbnail.coupangcdn.com/b.jpg');
    expect(buildImportRawData(legacy, { uploadId: 'u', rowIndex: 0 }).images).toEqual(['https://thumbnail.coupangcdn.com/a.jpg', 'https://thumbnail.coupangcdn.com/b.jpg']);
    expect(buildImportPreview([legacy]).rows[0].image).toBe('https://thumbnail.coupangcdn.com/a.jpg');

    const fullRaw = parseCsvRawText(FULL_CSV);
    const toybox = applyMapping(fullRaw, detectFixedHeaderMapping(fullRaw[0])!)[0];
    expect(toybox.image).toBe(`${R2}/TOYBOX-43037/main-1.jpg`);
    expect(toybox.originalImageUrl).toBe('https://toybox.kr/shopimages/toybox119/0011220000822.jpg');
    expect(buildImportRawData(toybox, { uploadId: 'u', rowIndex: 0 }).images).toEqual([`${R2}/TOYBOX-43037/main-1.jpg`]);
  });

  it('업로드: 고정 헤더 CSV는 결정적 매핑 저장 + 백그라운드 AI 미실행, 일반 CSV는 기존대로 AI가 갱신', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'port-upload-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    vi.resetModules();
    const { uploadRoutes } = await import('../src/routes/upload.js');
    const { csvUploads } = await import('../src/db/schema.js');
    store.schema = await import('../src/db/schema.js');
    for (const [key, col] of Object.entries(store.schema.csvUploads)) {
      if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
    }
    const app = Fastify();
    try {
    await app.register(fastifyMultipart);
    await app.register(uploadRoutes, { prefix: '/api' });

    const send = async (filename: string, content: string) => {
      const boundary = '----port-boundary';
      const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
      const res = await app.inject({ method: 'POST', url: '/api/upload/csv', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
      expect(res.statusCode).toBe(200);
      await flush();
      return res.json().uploadId as string;
    };

    (globalThis as any).__aiMapping = { name: 3, price: 1 };
    const fixedId = await send('toybox.csv', FULL_CSV);
    const fixedRow = store.rowsOf(csvUploads).find((r: any) => r.uploadId === fixedId);
    expect(fixedRow.columnMapping).toEqual(detectFixedHeaderMapping(parseCsvRawText(FULL_CSV)[0]));
    expect(detectMappingWithAI).not.toHaveBeenCalled();

    const legacyId = await send('coupang.csv', LEGACY_MULTI_IMAGE_CSV);
    const legacyRow = store.rowsOf(csvUploads).find((r: any) => r.uploadId === legacyId);
    expect(detectMappingWithAI).toHaveBeenCalledTimes(1);
    expect(legacyRow.columnMapping).toEqual({ name: 3, price: 1 });
    expect(fs.readdirSync(path.join(tmp, 'data', 'uploads'))).toEqual([]);   // 임시 CSV 삭제 유지
    } finally {
      await app.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      store.schema = schema;
      vi.resetModules();
    }
  });

  it('매핑 화면: 고정 헤더면 AI 폴링 대신 고정 매핑 안내, 아니면 기존 폴링', () => {
    const eta = new Eta({ views: path.join(process.cwd(), 'views') });
    const base = { uploadId: 'u', headerRow: ['a'], sampleRows: [['x']], autoMapping: {}, totalRows: 1, filename: 'f.csv' };
    const fixed = eta.render('./step1b-mapping', { ...base, fixedHeaderMapping: true });
    const generic = eta.render('./step1b-mapping', { ...base, fixedHeaderMapping: false });
    expect(fixed).toContain('if (true)');
    expect(fixed).toContain('고정 헤더 CSV — 자동 매핑 적용됨');
    expect(generic).toContain('if (false)');
    expect(generic).toContain('startAiMappingPoll();');
  });
});

describe('target 기존 동작 보존 — 레거시 리스팅 (플래그 false = production 기본)', () => {
  it('레거시 KRW 상품: StartPrice = calculatePriceSimple, 수량 = default_quantity, condition ungraded, itemSpecifics 전달', async () => {
    store.rowsOf(schema.products).push({ id: 5000, sku: 'PMC-05000', title: 'Old', costPrice: '30000.00', metadata: null, condition: null, brand: 'Pokemon', productType: 'Toy', itemSpecifics: { Brand: 'Pokemon', Set: 'Base' } });
    const expected = await calculatePriceSimple(30000, { platform: 'ebay' });
    await createListing(5000, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe(expected.salePrice.toFixed(2));
    expect(addItemBodies[0]).toContain('<Quantity>3</Quantity>');
    expect(addItemBodies[0]).toMatch(/<Name>Set<\/Name>\s*<Value>Base<\/Value>/);
    expect(store.rowsOf(schema.platformListings)[0]).toMatchObject({ quantity: 3, platformData: { pricing: { source: 'LEGACY_CALCULATED' } } });
    expect(fetchCalls).toHaveLength(0);
  });

  it('레거시 매입가 0 차단 메시지 유지 (create: 재등록 / retry·relist: 재시도)', async () => {
    store.rowsOf(schema.products).push({ id: 5001, sku: 'PMC-05001', title: 'NoCost', costPrice: '0', metadata: { importedFrom: 99 }, condition: 'new' });
    await expect(createListing(5001, 'ebay')).rejects.toThrow('매입가 (cost price) 가 설정되지 않았습니다. 상품 관리에서 가격을 입력 후 재등록하세요. (SKU: PMC-05001)');
    store.rowsOf(schema.platformListings).push({ id: 9001, productId: 5001, platform: 'ebay', status: 'error', price: '1', quantity: 5 });
    await expect(retryListing(9001)).rejects.toThrow('상품 관리에서 가격을 입력 후 재시도하세요. (SKU: PMC-05001)');
    expect(addItemBodies).toHaveLength(0);
  });

  it('USD CSV 상품은 매입원가가 없어도(축약 CSV) 레거시 매입가 차단이 아니라 release guard로 차단, AddItem·main 호출 0건', async () => {
    const short = ['상품명,환산가(USD),실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지',
      `Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,25.4,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,`].join('\n');
    seedCrawl(short, 0, 101);
    const productId = await importFromCrawl(101);
    expect(store.rowsOf(schema.products).find(p => p.id === productId).costPrice).toBeNull();
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('9. 플래그 true + KPL 13,900원 + 환율 1,300', () => {
  it('$25.40 + ceil(13,900/1,300)=$10.70 → StartPrice 36.10 ($7.90 차감·가산 없음)', async () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    seedCrawl(FULL_CSV, 0, 101);
    const quote = await requestShippingQuote({ provider: 'KPL', serviceCode: 'KPL_SF_US', chargeableWeightG: 307 }, { config: getShippingPricingConfig(), fetchImpl: fakeFetch as any });
    expect(quote).toMatchObject({ ok: true, shippingKrw: 13900 });
    const { buildShippingQuoteSnapshot } = await import('../src/services/shipping-pricing.js');
    const crawl = store.rowsOf(schema.crawlResults)[0];
    crawl.rawData.csvImport.fields.selectedShippingProvider = 'KPL';
    crawl.rawData.csvImport.shippingPolicy = policySnapshot('fixed790');
    crawl.rawData.csvImport.shippingQuote = buildShippingQuoteSnapshot({ provider: 'KPL', serviceCode: 'KPL_SF_US', chargeableWeightG: 307, csvSalePriceUsd: 25.4, exchangeRate: 1300, buyerShippingUsd: 7.9, outcome: quote as any });
    expect(crawl.rawData.csvImport.shippingQuote).toMatchObject({ shippingUsd: 10.7, listingPriceUsd: 36.1 });
    const productId = await importFromCrawl(101);
    await createListing(productId, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe('36.10');
    expect(addItemBodies[0]).not.toContain('>28.20<');
    expect(addItemBodies[0]).not.toContain('>44.00<');
  });
});

describe('23. shipping shadow hook 회귀 없음 (/listing-preview, 독립 플래그)', () => {
  it('SHADOW=true → calculateListingPrice가 /listing-preview + /shadow-result 호출, 레거시 가격은 그대로', async () => {
    process.env.AUTO_LISTING_SHIPPING_SHADOW_ENABLED = 'true';
    process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = TOKEN;
    process.env.MAIN_SERVICE_URL = MAIN;
    const withShadow = await calculateListingPrice(19900, 500, { platform: 'ebay' });
    for (let i = 0; i < 10 && fetchCalls.length < 2; i++) await flush();
    expect(fetchCalls.map(c => c.url)).toEqual([`${MAIN}/api/internal/shipping/listing-preview`, `${MAIN}/api/internal/shipping/shadow-result`]);
    expect(fetchCalls.some(c => c.url.endsWith('/api/internal/shipping/quote'))).toBe(false);

    delete process.env.AUTO_LISTING_SHIPPING_SHADOW_ENABLED;
    fetchCalls = [];
    const withoutShadow = await calculateListingPrice(19900, 500, { platform: 'ebay' });
    await flush();
    expect(withoutShadow.salePrice).toBe(withShadow.salePrice);
    expect(fetchCalls).toHaveLength(0);
  });

  it('PRICING=true 여도 SHADOW 미설정이면 shadow 호출 없음; 리스팅 경로는 calculateListingPrice(shadow)를 호출하지 않음', async () => {
    setEnv({ AUTO_LISTING_SHIPPING_PRICING_ENABLED: 'true' });
    process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = TOKEN;
    process.env.MAIN_SERVICE_URL = MAIN;
    await calculateListingPrice(19900, 500, { platform: 'ebay' });
    store.rowsOf(schema.products).push({ id: 5002, sku: 'PMC-05002', title: 'Legacy', costPrice: '19900', metadata: null, condition: 'new' });
    await createListing(5002, 'ebay');
    await flush();
    expect(fetchCalls.filter(c => c.url.includes('/listing-preview') || c.url.includes('/shadow-result'))).toHaveLength(0);
  });

  it('shadow hook 소스는 /listing-preview 를 유지하고 raw client는 /quote 만 사용', () => {
    const pricingSrc = fs.readFileSync(path.join(process.cwd(), 'src/services/pricing.ts'), 'utf-8');
    const clientSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/shipping-quote-client.ts'), 'utf-8');
    expect(pricingSrc).toContain('/api/internal/shipping/listing-preview');
    expect(pricingSrc).toContain("process.env.AUTO_LISTING_SHIPPING_SHADOW_ENABLED !== 'true'");
    expect(clientSrc).toMatch(/\/api\/internal\/shipping\/quote`/);
    expect(clientSrc).not.toContain('listing-preview`');
  });
});

describe('20·21. 토큰 비노출 · eBay 실호출 0건', () => {
  it('AddItem은 spy로만, 실제 네트워크 client(axios) 사용 없음; 로그에 토큰 없음', async () => {
    const axios = (await import('axios')).default;
    const axiosPost = vi.spyOn(axios, 'post').mockRejectedValue(new Error('REAL NETWORK CALL'));
    store.rowsOf(schema.products).push({ id: 5003, sku: 'PMC-05003', title: 'Legacy', costPrice: '19900', metadata: null, condition: 'new' });
    await createListing(5003, 'ebay');
    expect(addItemBodies).toHaveLength(1);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});
