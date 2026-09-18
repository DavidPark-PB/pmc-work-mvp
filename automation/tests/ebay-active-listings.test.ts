/**
 * eBay 활성 리스팅 조회 — 페이지네이션 · 고유 ItemID 집계 (callTradingAPI mock, 실호출 없음)
 *
 * production 원인: 응답에 SoldList/UnsoldList가 함께 오는데 전체 응답을 파싱해 페이지마다 같은 항목을 다시 담았다
 * (ActiveList 8,049건 → 24,162행). ActiveList 구간만·고유 ItemID로 집계한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const envState = vi.hoisted(() => {
  const env: Record<string, string | undefined> = {};
  (globalThis as any).__env = env;
  return env;
});
vi.mock('../src/lib/config.js', () => ({ env: (globalThis as any).__env }));
vi.mock('../src/db/index.js', () => ({ db: { query: { platformTokens: { findFirst: async () => undefined } } } }));

import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { createEbayDuplicateChecker } from '../src/services/ebay-duplicate-check.js';
import { fetchEbayListings } from '../src/services/listing-reconcile.js';

/** ActiveList + (페이지마다 반복되는) SoldList/UnsoldList 를 가진 실제 형태의 응답 */
function sellingResponse(active: { itemId: string; sku?: string; price?: string }[], opts: { page: number; totalPages: number; totalEntries: number; sold?: string[]; ack?: string }) {
  const item = (i: { itemId: string; sku?: string; price?: string }) =>
    `<Item><ItemID>${i.itemId}</ItemID>${i.sku ? `<SKU>${i.sku}</SKU>` : ''}<Title>t</Title><SellingStatus><CurrentPrice currencyID="USD">${i.price ?? '36.10'}</CurrentPrice></SellingStatus><Quantity>5</Quantity></Item>`;
  const soldItems = (opts.sold ?? ['SOLD-1', 'SOLD-2']).map(id => `<Item><ItemID>${id}</ItemID><SKU>SOLD-SKU</SKU></Item>`).join('');
  return `<?xml version="1.0"?><GetMyeBaySellingResponse><Ack>${opts.ack ?? 'Success'}</Ack>`
    + `<ActiveList><ItemArray>${active.map(item).join('')}</ItemArray>`
    + `<PaginationResult><TotalNumberOfPages>${opts.totalPages}</TotalNumberOfPages><TotalNumberOfEntries>${opts.totalEntries}</TotalNumberOfEntries></PaginationResult></ActiveList>`
    + `<SoldList><ItemArray>${soldItems}</ItemArray></SoldList>`
    + `<UnsoldList><ItemArray><Item><ItemID>UNSOLD-1</ItemID></Item></ItemArray></UnsoldList>`
    + `</GetMyeBaySellingResponse>`;
}

const pagesOf = (total: number, perPage = 200) => Math.ceil(total / perPage);
const makePages = (total: number, perPage = 200) => {
  const totalPages = pagesOf(total, perPage);
  return (page: number) => {
    const start = (page - 1) * perPage;
    const active = Array.from({ length: Math.min(perPage, total - start) }, (_, i) => ({ itemId: `IT-${start + i + 1}`, sku: `SKU-${start + i + 1}` }));
    return sellingResponse(active, { page, totalPages, totalEntries: total });
  };
};

let requestedPages: number[] = [];
let respond: (page: number) => string;

beforeEach(() => {
  requestedPages = [];
  respond = makePages(3);
  for (const k of Object.keys(envState)) delete envState[k];
  Object.assign(envState, { DATABASE_URL: 'postgres://mock', EBAY_ENVIRONMENT: 'PRODUCTION', EBAY_APP_ID: 'a', EBAY_CERT_ID: 'c', EBAY_DEV_ID: 'd', EBAY_USER_TOKEN: 'token', SHOPIFY_STORE_URL: 'shop.test', SHOPIFY_ACCESS_TOKEN: 'shpat_mock' });
  EbayClient.activeListPageDelayMs = 0;
  vi.restoreAllMocks();
  vi.spyOn(EbayClient.prototype as any, 'callTradingAPI').mockImplementation(async (...args: unknown[]) => {
    const [callName, body] = args as [string, string];
    if (callName !== 'GetMyeBaySelling') throw new Error(`unexpected eBay call ${callName}`);
    const page = Number(body.match(/<PageNumber>(\d+)<\/PageNumber>/)![1]);
    requestedPages.push(page);
    return respond(page);
  });
});

describe('eBay 활성 리스팅 페이지네이션', () => {
  it('3페이지 fixture: 페이지 번호를 1,2,3으로 올리고 서로 다른 ItemID만 수집 (SoldList·UnsoldList 제외)', async () => {
    respond = makePages(450);   // 200 + 200 + 50
    const items = await new EbayClient().getActiveListings();
    expect(requestedPages).toEqual([1, 2, 3]);
    expect(items).toHaveLength(450);
    expect(new Set(items.map(i => i.itemId)).size).toBe(450);
    expect(items.map(i => i.itemId).filter(id => id.startsWith('SOLD') || id.startsWith('UNSOLD'))).toEqual([]);
    expect(items[0]).toMatchObject({ itemId: 'IT-1', sku: 'SKU-1', price: '36.10', quantity: '5' });
    expect(items.at(-1)!.itemId).toBe('IT-450');
  });

  it('production 재현: 페이지마다 반복되는 Sold/Unsold 393행을 더하지 않는다 (8,049건 → 8,049행)', async () => {
    const total = 8049;
    const base = makePages(total);
    respond = (page) => base(page).replace('<SoldList><ItemArray>', `<SoldList><ItemArray>${Array.from({ length: 391 }, (_, i) => `<Item><ItemID>SOLD-${i}</ItemID></Item>`).join('')}`);
    const items = await new EbayClient().getActiveListings();
    expect(requestedPages).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
    expect([items.length, new Set(items.map(i => i.itemId)).size]).toEqual([total, total]);
  });

  it('같은 1페이지가 반복되면(PageNumber 미반영) 즉시 오류', async () => {
    const page1 = makePages(400)(1);
    respond = () => page1;
    await expect(new EbayClient().getActiveListings()).rejects.toThrow('이전 페이지와 같습니다');
    expect(requestedPages).toEqual([1, 2]);
  });

  it('응답이 깨졌으면 예외, 읽는 중 목록이 바뀐 것은 stale 로만 표시 (신규 등록을 막지 않음)', async () => {
    //   같은 ItemID가 두 페이지에 걸쳐 중복 → 고유 수가 총 건수보다 적다 = 불완전한 조회
    respond = (page) => sellingResponse(
      page === 1 ? [{ itemId: 'A' }, { itemId: 'B' }] : [{ itemId: 'B' }, { itemId: 'C' }],
      { page, totalPages: 2, totalEntries: 4 },
    );
    const dup = await new EbayClient().getActiveListingsWithMeta();
    expect([dup.items.map(i => i.itemId), dup.stale]).toEqual([['A', 'B', 'C'], true]);

    //   조회 도중 판매 종료·신규 노출로 총 건수가 바뀜 → 예외 없이 stale
    respond = (page) => sellingResponse([{ itemId: 'A' + page }], { page, totalPages: 2, totalEntries: page === 1 ? 2 : 9 });
    const changed = await new EbayClient().getActiveListingsWithMeta();
    expect([changed.items.length, changed.stale]).toEqual([2, true]);

    //   정상 조회는 stale 아님
    respond = makePages(300);
    expect((await new EbayClient().getActiveListingsWithMeta()).stale).toBe(false);

    respond = () => '<GetMyeBaySellingResponse><Ack>Failure</Ack></GetMyeBaySellingResponse>';
    await expect(new EbayClient().getActiveListings()).rejects.toThrow('GetMyeBaySelling 실패');

    respond = () => '<GetMyeBaySellingResponse><Ack>Success</Ack></GetMyeBaySellingResponse>';
    await expect(new EbayClient().getActiveListings()).rejects.toThrow('ActiveList가 없습니다');
  });

  it('8,000개 이상 · 20,000개 이상도 임의 상한 없이 페이지네이션대로 처리', async () => {
    respond = makePages(8500);
    expect(await new EbayClient().getActiveListings()).toHaveLength(8500);
    expect(requestedPages.length).toBe(43);

    requestedPages = [];
    respond = makePages(24000);
    const big = await new EbayClient().getActiveListings();
    expect([big.length, new Set(big.map(i => i.itemId)).size]).toEqual([24000, 24000]);
    expect(requestedPages.length).toBe(120);
    const src = (await import('fs')).readFileSync(new URL('../src/platforms/ebay/EbayClient.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/maxPages/);   // 임의 페이지 하드 상한 없음 (API TotalNumberOfPages까지만 조회)
  });

  it('중복 확인 index와 reconcile 조회도 같은 고유 집계를 쓴다', async () => {
    respond = (page) => sellingResponse(
      page === 1 ? [{ itemId: 'A1', sku: 'SKU-A' }, { itemId: 'B1', sku: 'SKU-B' }] : [{ itemId: 'C1', sku: 'SKU-B' }, { itemId: 'D1' }],
      { page, totalPages: 2, totalEntries: 4 },
    );
    const { index } = await new EbayClient().getActiveSkuIndex();
    expect([...index.entries()]).toEqual([['SKU-A', ['A1']], ['SKU-B', ['B1', 'C1']]]);   // 같은 SKU 2개는 그대로 노출 → 자동 연결 차단
    const checker = createEbayDuplicateChecker(() => new EbayClient().getActiveSkuIndex());
    expect(await checker.find('SKU-A')).toEqual({ itemId: 'A1' });
    await expect(checker.find('SKU-B')).rejects.toMatchObject({ code: 'EBAY_DUPLICATE_CHECK_FAILED' });
    expect(checker.loadCount()).toBe(1);

    requestedPages = [];
    const external = await fetchEbayListings();
    expect(external.map(e => e.externalId)).toEqual(['A1', 'B1', 'C1', 'D1']);
    expect(external.every(e => e.url.startsWith('https://www.ebay.com/itm/'))).toBe(true);
  });

  it('조회 경로는 읽기 전용 — AddItem/ReviseItem/EndItem 호출 0', async () => {
    respond = makePages(10);
    await new EbayClient().getActiveListings();
    await new EbayClient().getActiveSkuIndex();
    const calls = vi.mocked((EbayClient.prototype as any).callTradingAPI).mock.calls.map(c => c[0]);
    expect(new Set(calls)).toEqual(new Set(['GetMyeBaySelling']));
  });
});

describe('중복 확인 판정 (목록이 조회 중 바뀌는 상황)', () => {
  const snap = (skus: Record<string, string[]>, stale = false) => ({ index: new Map(Object.entries(skus)), stale });

  it('목록이 바뀌어도 새 SKU 는 한 번 더 확인한 뒤 신규 등록 진행 (이전: 무조건 차단)', async () => {
    let calls = 0;
    const checker = createEbayDuplicateChecker(async () => { calls++; return snap({ 'OTHER-SKU': ['1'] }, true); });
    expect(await checker.find('PMC-NEW')).toBeNull();
    expect([calls, checker.loadCount()]).toEqual([2, 2]);   // 재확인 1회까지만
    expect(await checker.find('PMC-NEW-2')).toBeNull();
    expect(calls).toBe(2);                                   // job 안에서는 재사용
  });

  it('재확인에서 같은 SKU 가 나타나면 AddItem 없이 그 상품에 연결', async () => {
    let calls = 0;
    const checker = createEbayDuplicateChecker(async () => {
      calls++;
      return calls === 1 ? snap({}, true) : snap({ 'PMC-1': ['990001'] }, true);
    });
    expect(await checker.find('PMC-1')).toEqual({ itemId: '990001' });
  });

  it('완전한 조회에서 없으면 재조회 없이 바로 신규 등록 · 같은 SKU 2개면 차단 · 조회 실패는 차단', async () => {
    let calls = 0;
    const clean = createEbayDuplicateChecker(async () => { calls++; return snap({ 'X': ['1'] }, false); });
    expect(await clean.find('PMC-9')).toBeNull();
    expect(calls).toBe(1);

    const dup = createEbayDuplicateChecker(async () => snap({ 'PMC-2': ['1', '2'] }, true));
    await expect(dup.find('PMC-2')).rejects.toMatchObject({ code: 'EBAY_DUPLICATE_CHECK_FAILED' });

    const broken = createEbayDuplicateChecker(async () => { throw new Error('GetMyeBaySelling 실패 (Ack=Failure)'); });
    await expect(broken.find('PMC-3')).rejects.toMatchObject({ code: 'EBAY_DUPLICATE_CHECK_FAILED' });
  });

  it('이 job 에서 등록한 Item ID 는 두 snapshot 모두에 반영된다', async () => {
    const checker = createEbayDuplicateChecker(async () => snap({}, true));
    expect(await checker.find('PMC-5')).toBeNull();
    checker.remember('PMC-5', '700001');
    expect(await checker.find('PMC-5')).toEqual({ itemId: '700001' });
  });
});
