/**
 * Phase 1.5 가격 안전 — CSV 환산가(USD) 검증 / 레거시 계산 / fail-closed (Phase 2.1: 배송비 플래그 off면 USD CSV 등록 차단)
 * DB·설정·번역은 mock, eBay는 callTradingAPI spy로 AddItem payload만 캡처 (실호출 없음)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks ──────────────────────────────────────────────
vi.mock('../src/lib/config.js', () => ({
  env: {
    DATABASE_URL: 'postgres://mock',
    EBAY_ENVIRONMENT: 'SANDBOX',
    EBAY_APP_ID: 'mock', EBAY_CERT_ID: 'mock', EBAY_DEV_ID: 'mock',
    EBAY_USER_TOKEN: 'mock', EBAY_REFRESH_TOKEN: 'mock',
  },
}));

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

// ── fake DB (hoisted before module imports) ────────────
const store = vi.hoisted(() => {
  const tables = new Map<unknown, any[]>();
  const nextId = new Map<unknown, number>();
  const rowsOf = (t: unknown) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t)!; };
  const state = { tables, nextId, rowsOf, schema: null as any };

  const attach = (tableName: string, row: any, withSpec: any) => {
    if (!row || !withSpec) return row;
    const s = state.schema;
    const out = { ...row };
    if (tableName === 'products' && withSpec.images) {
      out.images = rowsOf(s.productImages).filter((i: any) => i.productId === row.id);
    }
    if (tableName === 'platformListings' && withSpec.product) {
      const p = rowsOf(s.products).find((x: any) => x.id === row.productId);
      out.product = attach('products', p, withSpec.product.with);
    }
    return out;
  };
  const queryTable = (name: string) => ({
    findFirst: async ({ where, with: withSpec }: any = {}) => {
      const row = rowsOf(state.schema[name]).find((r: any) => (where ? where(r) : true));
      return attach(name, row ? structuredClone(row) : undefined, withSpec);
    },
  });

  (globalThis as any).__fakeDb = {
    query: new Proxy({}, { get: (_t, name: string) => queryTable(name) }),
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
        where: async (pred: (r: any) => boolean) => {
          rowsOf(table).filter(pred).forEach(r => Object.assign(r, structuredClone(v)));
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
import { parseCsvRawText, detectFixedHeaderMapping, detectMappingByKeyword, applyMapping, buildImportRawData } from '../src/lib/csv-parser.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { importFromCrawl, createListing, retryListing, relistListing } from '../src/services/listing-service.js';
import {
  resolveListingSalePrice,
  resolveDisplayPrices,
  crawlDisplayCsv,
  readProductCsvMetadata,
  validateSalePriceUsd,
  ListingPriceError,
} from '../src/services/listing-price.js';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { listingRoutes, listingJobTimers } from '../src/routes/listings.js';
import { crawlResultRoutes } from '../src/routes/crawl-results.js';
import { EMPTY_ACTIVE_LIST } from './fixtures/ebay-trading.js';
import { resetActiveSkuCache } from '../src/services/ebay-duplicate-check.js';

store.schema = schema;
const columnKeys = new Map<unknown, string>();
for (const table of [schema.products, schema.productImages, schema.crawlResults, schema.platformListings, schema.pricingSettings]) {
  for (const [key, col] of Object.entries(table)) {
    if (col && typeof col === 'object' && 'columnType' in (col as object)) columnKeys.set(col, key);
  }
}
(globalThis as any).__columnKeys = columnKeys;

// ── fixtures ────────────────────────────────────────────
const R2 = 'https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products';
const FULL_CSV = [
  '페이지,상품코드,상품명,Product Name (EN),입수량(박스),원가(toybox 판매가),판매가(toybox 정가),환산가(USD),마진(원),마진율,실측무게(g),가로(cm),세로(cm),높이(cm),부피무게(g),적용무게(g),R2 이미지,상품링크,원본 이미지',
  `1,43037,유희왕 시너지팩3탄-히어로즈 유니버스,Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe,64,"19,500","30,000",25.4,"10,500",35.0%,300,16,12,8,307,307,${R2}/TOYBOX-43037/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10941010,https://toybox.kr/shopimages/toybox119/0011220000822.jpg`,
  `1,77589,토미카 프라레일 JR 마리오 트레인,Tomica Plarail JR Mario Train,6,"42,600","71,000",60.1,"28,400",40.0%,"1,000",43,17,7,"1,023","1,023",${R2}/TOYBOX-77589/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=10940984,https://toybox.kr/shopimages/toybox119/0010610007332.jpg`,
  `9,99999,판매가 없음,Missing USD Price Item,1,"5,000","8,000",,"3,000",37.5%,300,16,12,8,307,307,${R2}/TOYBOX-99999/main-1.jpg,https://toybox.kr/shop/shopdetail.html?branduid=99999,`,
].join('\n');
const COUPANG_CSV = [
  '이미지,상품URL,상품명,가격',
  'https://thumbnail.coupangcdn.com/a.jpg,https://www.coupang.com/vp/products/123,포켓몬 카드 151,"19,900원"',
].join('\n');

const EBAY_SETTINGS = { platform: 'ebay', marginRate: '0.20', exchangeRate: '1300.00', platformFeeRate: '0.18', defaultShippingKrw: '12000' };
const SETTINGS_DATA = { marginRate: 0.2, exchangeRate: 1300, platformFeeRate: 0.18, defaultShippingKrw: 12000 };

let addItemBodies: string[] = [];

function resetDb() {
  store.tables.clear();
  store.nextId.clear();
  store.rowsOf(schema.pricingSettings).push({ id: 1, ...EBAY_SETTINGS });
}

/** CSV → Phase 1 import(batch)와 동일한 crawl_results 행 생성 */
function seedCrawlFromCsv(csv: string, rowIndex: number, id: number, fixed = true) {
  const raw = parseCsvRawText(csv);
  const mapping = fixed ? detectFixedHeaderMapping(raw[0])! : detectMappingByKeyword(raw);
  const row = applyMapping(raw, mapping)[rowIndex];
  const crawl = {
    id,
    sourceId: 1,
    externalId: row.url,
    title: row.name,
    titleEn: null,
    price: row.price.toFixed(2),                 // numeric(10,2) → DB는 문자열 반환
    currency: row.priceCurrency === 'USD' ? 'USD' : 'KRW',
    url: row.url,
    imageUrl: row.image,
    rawData: buildImportRawData(row, { uploadId: 'upload-1', rowIndex }),
    status: 'new',
    productId: null,
    ownerId: 'admin',
    ownerName: 'Admin',
  };
  store.rowsOf(schema.crawlResults).push(crawl);
  return crawl;
}

const startPriceOf = (body: string) => body.match(/<StartPrice currencyID="USD">([^<]+)<\/StartPrice>/)?.[1];

beforeEach(() => {
  resetActiveSkuCache();   // eBay 활성 SKU 색인 캐시는 테스트 간 공유하지 않는다
  listingJobTimers.sleep = async () => {};   // job 단계 사이 실제 500ms 대기 없음
  resetDb();
  addItemBodies = [];
  vi.restoreAllMocks();
  vi.spyOn(EbayClient.prototype as any, 'suggestCategoryId').mockResolvedValue('261068');
  vi.spyOn(EbayClient.prototype as any, 'callTradingAPI').mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    //   신규 CSV eBay 등록 전 READ-ONLY 중복 확인 — 같은 SKU 활성 상품 없음
    if (callName === 'GetMyeBaySelling') return EMPTY_ACTIVE_LIST;
    if (callName !== 'AddItem') throw new Error(`unexpected eBay call ${callName}`);
    addItemBodies.push(body);
    return `<AddItemResponse><Ack>Success</Ack><ItemID>${100000 + addItemBodies.length}</ItemID></AddItemResponse>`;
  });
});

describe('importFromCrawl — metadata.csvImport 보존', () => {
  it('USD CSV 원본의 판매가/원가/무게/치수/출처를 product metadata에 저장하고 KRW 원가에 USD를 넣지 않는다', async () => {
    const crawl = seedCrawlFromCsv(FULL_CSV, 0, 101);
    const productId = await importFromCrawl(crawl.id);
    const product = store.rowsOf(schema.products).find(p => p.id === productId);

    expect(product.metadata).toEqual({
      importedFrom: 101,
      csvImport: {
        version: 1,
        currency: 'USD',
        salePriceUsd: 25.4,
        purchaseCostKrw: 19500,
        retailPriceKrw: 30000,
        actualWeightG: 300,
        volumetricWeightG: 307,
        chargeableWeightG: 307,
        lengthCm: 16,
        widthCm: 12,
        heightCm: 8,
        sourceProductCode: '43037',
        sourceUrl: 'https://toybox.kr/shop/shopdetail.html?branduid=10941010',
        originalImageUrl: 'https://toybox.kr/shopimages/toybox119/0011220000822.jpg',
        importedFrom: 101,
        uploadId: 'upload-1',
        sourceRowNumber: 1,
        // Phase 2: 배송사/견적/수동 판매가 (import 시점 미지정)
        selectedShippingProvider: null,
        shippingQuote: null,
        shippingPolicy: null,
        salePriceOverrideUsd: null,
        salePriceOverrideHistory: [],
      },
    });
    expect(product.costPrice).toBe('19500');           // 25.40이 원가(KRW)로 들어가지 않음
    expect(product.title).toBe('Yu-Gi-Oh! Synergy Pack Vol. 3 - Heroes Universe'); // CSV 영문명 유지
    expect(product.titleKo).toBe('유희왕 시너지팩3탄-히어로즈 유니버스');
    expect(product.sourceUrl).toBe('https://toybox.kr/shop/shopdetail.html?branduid=10941010');
    expect(store.rowsOf(schema.productImages).map(i => i.url)).toEqual([`${R2}/TOYBOX-43037/main-1.jpg`]);
  });

  it('레거시(KRW) CSV는 기존과 동일하게 저장한다', async () => {
    const crawl = seedCrawlFromCsv(COUPANG_CSV, 0, 201, false);
    const productId = await importFromCrawl(crawl.id);
    const product = store.rowsOf(schema.products).find(p => p.id === productId);
    expect(product.metadata).toEqual({ importedFrom: 201 });
    expect(product.costPrice).toBe('19900.00');
    expect(product.title).toBe('GEMINI REWRITTEN TITLE');
  });
});

describe('createListing — AddItem payload (mock)', () => {
  //   Phase 2.1 release guard: 배송비 플래그 off(이 파일의 env)에서는 toybox USD 상품을 CSV가 단독으로 등록하지 않는다.
  //   원화 오계산($4.31)·매입원가(19500)로도 절대 등록되지 않음 — 배송비 포함 등록가는 shipping-pricing/release-guard 테스트에서 검증
  it('1,3,4,5. CSV 25.4 → 원화 계산 4.31·매입원가 19500으로 등록되지 않고, 플래그 off면 AddItem 없이 차단', async () => {
    const legacyIfMisread = await calculatePriceSimple(25.4, { platform: 'ebay' });
    expect(legacyIfMisread.salePrice).toBe(4.31);        // 수정 전 위험 경로 값 재확인

    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 0, 101).id);
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({
      code: 'SHIPPING_PRICING_DISABLED',
      message: '배송비 반영 기능이 비활성화되어 있어 이 상품을 eBay에 등록하지 않았습니다.',
    });

    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)).toHaveLength(0);
  });

  it('2. CSV 60.1 → 플래그 off면 AddItem 없이 차단', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 1, 102).id);
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('6. 레거시 상품은 calculatePriceSimple 결과 그대로', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(COUPANG_CSV, 0, 201, false).id);
    const expected = await calculatePriceSimple(19900, { platform: 'ebay' });
    await createListing(productId, 'ebay');
    expect(startPriceOf(addItemBodies[0])).toBe(expected.salePrice.toFixed(2));

    // importedFrom 없는 기존(마이그레이션) 상품도 동일
    store.rowsOf(schema.products).push({ id: 5000, sku: 'PMC-05000', title: 'Old', costPrice: '30000.00', metadata: null, condition: 'new', brand: '', productType: '' });
    const expectedOld = await calculatePriceSimple(30000, { platform: 'ebay' });
    await createListing(5000, 'ebay');
    expect(startPriceOf(addItemBodies[1])).toBe(expectedOld.salePrice.toFixed(2));
  });

  it('7. salePriceUsd 누락 시 등록 차단 (AddItem·listing 행 없음)', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 2, 103).id);
    await expect(createListing(productId, 'ebay')).rejects.toThrow('판매가(USD)가 없거나 올바르지 않아 등록하지 않았습니다.');
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)).toHaveLength(0);
  });

  it('crawl_results 원본 값과 불일치하면 차단', async () => {
    const crawl = seedCrawlFromCsv(FULL_CSV, 0, 101);
    const productId = await importFromCrawl(crawl.id);
    store.rowsOf(schema.crawlResults)[0].price = '26.00';
    await expect(createListing(productId, 'ebay')).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('25.4 → 254 오변환(metadata·crawl 동시)은 원본 CSV 셀 대조로 차단', async () => {
    const crawl = seedCrawlFromCsv(FULL_CSV, 0, 101);
    const productId = await importFromCrawl(crawl.id);
    store.rowsOf(schema.crawlResults)[0].price = '254.00';
    store.rowsOf(schema.crawlResults)[0].rawData.csvImport.fields.salePriceUsd = 254;
    store.rowsOf(schema.products).find(p => p.id === productId).metadata.csvImport.salePriceUsd = 254;
    await expect(createListing(productId, 'ebay')).rejects.toThrow(/원본 환산가\(USD\) 셀/);
    expect(addItemBodies).toHaveLength(0);
  });

  it('USD 원본인데 product metadata가 없으면(1.5 이전 import) 레거시로 계산하지 않고 차단', async () => {
    const crawl = seedCrawlFromCsv(FULL_CSV, 0, 101);
    store.rowsOf(schema.products).push({ id: 6000, sku: 'PMC-06000', title: 'x', costPrice: '25.40', metadata: { importedFrom: crawl.id }, condition: 'new' });
    await expect(createListing(6000, 'ebay')).rejects.toMatchObject({ code: 'METADATA_MISSING' });
    expect(addItemBodies).toHaveLength(0);
  });

  it('USD CSV 상품은 eBay·Shopify 외 플랫폼 등록 차단, Shopify는 eBay 등록 성공이 먼저 필요', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 0, 101).id);
    await expect(createListing(productId, 'alibaba')).rejects.toMatchObject({ code: 'PLATFORM_UNSUPPORTED' });
    //   신규 CSV Shopify: CSV 판매가 그대로지만 eBay active Item ID가 없으면 차단 (기존: PLATFORM_UNSUPPORTED)
    await expect(createListing(productId, 'shopify')).rejects.toMatchObject({ code: 'EBAY_REQUIRED' });
  });
});

describe('9. retryListing / relistListing 동일 규칙', () => {
  it('retry: 플래그 off면 error 리스팅 재시도도 차단, 상태·가격 불변', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 0, 101).id);
    store.rowsOf(schema.platformListings).push({ id: 7001, productId, platform: 'ebay', status: 'error', price: '4.31', quantity: 5 });
    await expect(retryListing(7001)).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)[0]).toMatchObject({ status: 'error', price: '4.31' });
  });

  it('relist: 플래그 off면 ended 리스팅 재개도 차단, 상태·가격 불변', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 1, 102).id);
    store.rowsOf(schema.platformListings).push({ id: 7002, productId, platform: 'ebay', status: 'ended', price: '9.99', quantity: 5 });
    await expect(relistListing(7002)).rejects.toMatchObject({ code: 'SHIPPING_PRICING_DISABLED' });
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings)[0]).toMatchObject({ status: 'ended', price: '9.99' });
  });

  it('retry/relist도 잘못된 판매가는 차단하고 리스팅 상태를 바꾸지 않는다', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 2, 103).id);
    store.rowsOf(schema.platformListings).push(
      { id: 7003, productId, platform: 'ebay', status: 'error', price: '1.00', quantity: 5 },
      { id: 7004, productId, platform: 'ebay', status: 'ended', price: '1.00', quantity: 5 },
    );
    await expect(retryListing(7003)).rejects.toBeInstanceOf(ListingPriceError);
    await expect(relistListing(7004)).rejects.toBeInstanceOf(ListingPriceError);
    expect(addItemBodies).toHaveLength(0);
    expect(store.rowsOf(schema.platformListings).map(l => l.status)).toEqual(['error', 'ended']);
  });
});

describe('8. 일괄등록 batch — 한 상품 오류가 전체를 중단시키지 않음', () => {
  it('POST /api/listings/create: 판매가 누락·배송비 미반영 CSV 상품은 상품별 사유로 실패, 레거시는 등록', async () => {
    const bad = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 2, 103).id);
    const toybox = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 0, 101).id);
    const legacy = await importFromCrawl(seedCrawlFromCsv(COUPANG_CSV, 0, 201, false).id);
    const expectedLegacy = await calculatePriceSimple(19900, { platform: 'ebay' });

    const app = Fastify();
    await app.register(listingRoutes, { prefix: '/api' });
    const res = await app.inject({
      method: 'POST', url: '/api/listings/create',
      payload: { productIds: [bad, toybox, legacy], platforms: ['ebay'] },
    });
    const { jobId } = res.json();
    expect(jobId).toBeTruthy();

    const jobs = (globalThis as any).__jobs as Map<string, any>;
    for (let i = 0; i < 60 && jobs.get(jobId)?.status !== 'done'; i++) await new Promise(r => setTimeout(r, 100));
    const job = jobs.get(jobId);
    await app.close();

    expect(job.status).toBe('done');
    expect(job.completed).toBe(1);
    expect(job.failed).toBe(2);
    expect(job.results[0]).toMatchObject({ success: false, error: '판매가(USD)가 없거나 올바르지 않아 등록하지 않았습니다.' });
    expect(job.results[1]).toMatchObject({ success: false, error: '배송비 반영 기능이 비활성화되어 있어 이 상품을 eBay에 등록하지 않았습니다.' });
    expect(job.results[2]).toMatchObject({ success: true });
    expect(addItemBodies.map(startPriceOf)).toEqual([expectedLegacy.salePrice.toFixed(2)]);
  }, 15000);
});

describe('10. 화면 USD/KRW 구분', () => {
  const allSettings = { ebay: SETTINGS_DATA, shopify: SETTINGS_DATA, alibaba: SETTINGS_DATA, shopee: SETTINGS_DATA };

  it('USD CSV crawl 행: 원가 칸 매입원가 ₩19,500 (₩25 아님), 플래그 off면 eBay 등록가 없음·차단 표시 (CSV $25.40 메모)', () => {
    const crawl = seedCrawlFromCsv(FULL_CSV, 0, 101);
    const display = resolveDisplayPrices({ costKrw: parseFloat(crawl.price), csv: crawlDisplayCsv(crawl), allSettings });
    expect(display).toMatchObject({
      //   Shopify 표시가 = CSV 판매가 그대로 (배송비 반영 플래그와 무관)
      costKrw: 19500, ebayPrice: 0, shopifyPrice: 25.4, priceSource: 'CSV_USD_BLOCKED',
      ebayListingBlocked: true, ebayBlockCode: 'SHIPPING_PRICING_DISABLED', ebayEditValue: 25.4,
    });
    expect(display.priceNote).toBe('CSV $25.40 · 차단: 배송비 반영 기능이 비활성화되어 있어 이 상품을 eBay에 등록하지 않았습니다.');
    expect('₩' + display.costKrw.toLocaleString()).toBe('₩19,500');
  });

  it('USD CSV product 행: 원가 ₩42,600, 플래그 off면 eBay 차단 (CSV $60.10 메모)', async () => {
    const productId = await importFromCrawl(seedCrawlFromCsv(FULL_CSV, 1, 102).id);
    const product = store.rowsOf(schema.products).find(p => p.id === productId);
    const display = resolveDisplayPrices({ costKrw: parseFloat(product.costPrice), csv: readProductCsvMetadata(product.metadata), allSettings });
    expect(display).toMatchObject({ costKrw: 42600, ebayPrice: 0, ebayListingBlocked: true, ebayEditValue: 60.1 });
    expect(display.priceNote).toMatch(/^CSV \$60\.10 · 차단: /);
  });

  it('레거시 행은 기존 계산(override 우선) 그대로', () => {
    const crawl = seedCrawlFromCsv(COUPANG_CSV, 0, 201, false);
    expect(crawlDisplayCsv(crawl)).toBeUndefined();
    const display = resolveDisplayPrices({ costKrw: 19900, csv: undefined, overrides: { shopify: 99 }, allSettings });
    expect(display).toMatchObject({ costKrw: 19900, shopifyPrice: 99, priceSource: 'LEGACY_CALCULATED', ebayListingBlocked: false });
    expect(display.ebayPrice).toBeGreaterThan(0);
    expect(display.ebayPrice).not.toBe(19900);
  });

  it('USD CSV crawl 행의 가격 인라인 수정은 400으로 차단', async () => {
    seedCrawlFromCsv(FULL_CSV, 0, 101);
    const app = Fastify();
    await app.register(crawlResultRoutes, { prefix: '/api' });
    const res = await app.inject({ method: 'PATCH', url: '/api/crawl-results/101', payload: { price: '19500' } });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(store.rowsOf(schema.crawlResults)[0].price).toBe('25.40');
  });
});

describe('resolveListingSalePrice 순수 검증', () => {
  const csvProduct = (salePriceUsd: unknown, extra: Record<string, unknown> = {}) => ({
    costPrice: '19500',
    metadata: { importedFrom: 1, csvImport: { version: 1, currency: 'USD', salePriceUsd, purchaseCostKrw: 19500, chargeableWeightG: 307, importedFrom: 1, ...extra } },
  });
  const source = (price: string, fieldPrice: number) => ({
    id: 1, currency: 'USD', price,
    rawData: { csvImport: { fields: { salePriceUsd: fieldPrice, priceCurrency: 'USD' }, sourceColumns: { '환산가(USD)': String(fieldPrice) } } },
  });

  it.each([
    ['없음', null], ['0', 0], ['음수', -1], ['문자열', '25.4'], ['NaN', NaN], ['Infinity', Infinity], ['소수 3자리', 25.401], ['매입원가와 동일', 19500],
  ])('판매가 %s → 차단', (_label, value) => {
    expect(() => resolveListingSalePrice(csvProduct(value), SETTINGS_DATA, { platform: 'ebay', sourceCrawl: source('25.40', 25.4) }))
      .toThrow(ListingPriceError);
  });

  it('원본 crawl 없으면 차단, 정상이어도 배송비 off면 차단, 배송비 on + 유효 snapshot이면 CSV_USD_PLUS_SHIPPING', () => {
    expect(() => resolveListingSalePrice(csvProduct(25.4), SETTINGS_DATA, { platform: 'ebay', sourceCrawl: null }))
      .toThrow(expect.objectContaining({ code: 'SOURCE_MISSING' }));
    expect(() => resolveListingSalePrice(csvProduct(25.4), SETTINGS_DATA, { platform: 'ebay', sourceCrawl: source('25.40', 25.4) }))
      .toThrow(expect.objectContaining({ code: 'SHIPPING_PRICING_DISABLED' }));

    const quoted = csvProduct(25.4, {
      selectedShippingProvider: 'KPL',
      shippingQuote: { status: 'OK', provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', chargeableWeightG: 307, bracketWeightKg: 0.5, shippingKrw: 13900, exchangeRate: 1300, shippingUsd: 10.7, rateVersionId: 4 },
    });
    const shipping = { enabled: true, exchangeRate: 1300, serviceCodes: { KPL: 'KPL_SF_US', eGS: 'EGS_STD_US' } };
    expect(resolveListingSalePrice(quoted, SETTINGS_DATA, { platform: 'ebay', sourceCrawl: source('25.40', 25.4), shipping }))
      .toMatchObject({ salePrice: 36.1, shippingCost: 9.24, currency: 'USD', source: 'CSV_USD_PLUS_SHIPPING', productClass: 'TOYBOX_USD' });
  });

  it('metadata 없는 상품은 LEGACY_CALCULATED', () => {
    expect(resolveListingSalePrice({ costPrice: '25.40', metadata: { importedFrom: 9 } }, SETTINGS_DATA, { platform: 'ebay', sourceCrawl: null }))
      .toMatchObject({ salePrice: 4.31, source: 'LEGACY_CALCULATED', productClass: 'LEGACY' });
    expect(validateSalePriceUsd(60.1)).toBe(60.1);
  });
});
