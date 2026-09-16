/**
 * 상품 파이프라인 상태·집계 — 고유 products.id 기준, 상호 배타 상태, CSV 업로드별 필터
 * DB는 fake, 플랫폼 호출 없음
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { Eta } from 'eta';
import {
  classifyProduct, classifyFromListings, splitStaleJobs,
  PIPELINE_STATUSES, PIPELINE_TABS, PROCESSING_WINDOW_MS, STALE_JOB_MS,
} from '../src/services/product-pipeline.js';

describe('1. 상호 배타 상태', () => {
  const base = { ebayActive: false, shopifyActive: false, hasEnded: false, hasError: false, processing: false };

  it('우선순위: 처리 중 → 양쪽 → eBay만 → Shopify만 → 실패 → 판매 취소 → 미등록', () => {
    expect(classifyProduct({ ...base, processing: true, ebayActive: true, shopifyActive: true })).toBe('PROCESSING');
    expect(classifyProduct({ ...base, ebayActive: true, shopifyActive: true, hasError: true })).toBe('LISTED_BOTH');
    expect(classifyProduct({ ...base, ebayActive: true, hasError: true, hasEnded: true })).toBe('EBAY_ONLY');
    expect(classifyProduct({ ...base, shopifyActive: true, hasError: true })).toBe('SHOPIFY_ONLY');
    expect(classifyProduct({ ...base, hasError: true, hasEnded: true })).toBe('FAILED');
    expect(classifyProduct({ ...base, hasEnded: true })).toBe('CANCELLED');
    expect(classifyProduct(base)).toBe('READY');
  });

  it('active만 등록으로 인정 — ended/error/draft/pending과 가격은 등록 완료가 아니다', () => {
    const now = Date.now();
    const l = (platform: string, status: string, extra: Record<string, unknown> = {}) => ({ platform, status, platformItemId: 'X1', ...extra });
    expect(classifyFromListings([l('ebay', 'active'), l('shopify', 'active')], now)).toBe('LISTED_BOTH');
    expect(classifyFromListings([l('ebay', 'active'), l('shopify', 'error')], now)).toBe('EBAY_ONLY');
    expect(classifyFromListings([l('ebay', 'ended'), l('shopify', 'ended')], now)).toBe('CANCELLED');
    expect(classifyFromListings([l('ebay', 'draft'), l('shopify', 'draft')], now)).toBe('READY');
    expect(classifyFromListings([l('ebay', 'error')], now)).toBe('FAILED');
    //   외부 ID가 없는 active(유령 행)는 등록으로 보지 않는다
    expect(classifyFromListings([{ platform: 'ebay', status: 'active', platformItemId: null, listingUrl: null }], now)).toBe('READY');
    //   최근 pending만 처리 중, 오래된 pending은 아니다
    expect(classifyFromListings([l('ebay', 'pending', { updatedAt: new Date(now - 60_000) })], now)).toBe('PROCESSING');
    expect(classifyFromListings([l('ebay', 'pending', { updatedAt: new Date(now - PROCESSING_WINDOW_MS - 1000) })], now)).toBe('READY');
  });

  it('상태 목록과 탭이 1:1로 대응하고 전체를 제외한 탭 수가 상태 수와 같다', () => {
    const tabKeys = PIPELINE_TABS.map(t => t.key);
    expect(tabKeys[0]).toBe('ALL');
    expect([...tabKeys.slice(1)].sort()).toEqual([...PIPELINE_STATUSES].sort());
    expect(PIPELINE_TABS.map(t => t.label)).toEqual(['전체', '양쪽 등록 완료', 'eBay만 등록', 'Shopify만 등록', '미등록', '등록 실패', '처리 중', '판매 취소']);
  });

  it('SQL 집계가 같은 우선순위를 쓰는지 (CASE 순서) + product 단위 집계', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/product-pipeline.ts'), 'utf-8');
    const caseBlock = src.match(/const STATUS_CASE[\s\S]*?END`/)![0];
    expect([...caseBlock.matchAll(/'(\w+)'/g)].map(m => m[1])).toEqual(['PROCESSING', 'LISTED_BOTH', 'EBAY_ONLY', 'SHOPIFY_ONLY', 'FAILED', 'CANCELLED', 'READY']);
    expect(src).toContain("pl.status = 'active' AND pl.platform_item_id IS NOT NULL");
    expect(src).toContain('GROUP BY p.id');                       // 고유 product 기준
    expect(src).toContain("WHERE p.status <> 'trashed'");          // 휴지통 제외
    expect(src).not.toMatch(/FROM crawl_results[\s\S]{0,200}JOIN products/);   // crawl 행을 상품 수로 세지 않음
  });

  it('오래된 running job은 현재 작업에서 제외', () => {
    const now = Date.now();
    const { active, stale } = splitStaleJobs([
      { id: 'a', status: 'running', createdAt: new Date(now - 60_000) },
      { id: 'b', status: 'running', createdAt: new Date(now - STALE_JOB_MS - 1000) },
      { id: 'c', status: 'done', createdAt: new Date(now) },
    ], now);
    expect(active.map(j => j.id)).toEqual(['a']);
    expect(stale.map(j => j.id)).toEqual(['b', 'c']);
  });
});

describe('2. 화면: 탭 · 필터 · 영역 분리', () => {
  const counts = { LISTED_BOTH: 185, EBAY_ONLY: 3, SHOPIFY_ONLY: 0, READY: 1, FAILED: 12, PROCESSING: 0, CANCELLED: 0, total: 201 };
  const item = (id: number, status: string, listings: any[] = [], type: 'product' | 'crawl' = 'product') => ({
    type, id, sku: 'PMC-' + id, title: 't' + id, titleEn: 't', titleKo: 't', imageUrl: '', sourceUrl: '', sourceLabel: 'CSV',
    listings: JSON.stringify(listings), pipelineStatus: status, uploadId: 'up-1', costKrw: 0, priceSource: 'CSV_USD_PLUS_SHIPPING',
    createdAt: new Date(), ebayPrice: 36.1, shopifyPrice: 25.4, alibabaPrice: 0, shopeePrice: 0, shippingCost: 0, ebayListingBlocked: false,
  });
  const render = (data: Record<string, unknown> = {}) => new Eta({ views: path.join(process.cwd(), 'views') }).render('./dashboard', {
    step: 0, user: { id: 'admin', name: 'Admin', isAdmin: true },
    stats: { totalProducts: 201, productsByStatus: {}, totalListings: 0, listingsByPlatform: {}, listingsByStatus: {}, crawlByStatus: { new: 489 } },
    allItems: [
      item(1, 'LISTED_BOTH', [{ id: 1, platform: 'ebay', status: 'active', platformItemId: 'E1', listingUrl: 'u', price: '36.1' }, { id: 2, platform: 'shopify', status: 'active', platformItemId: 'S1', listingUrl: 'u', price: '25.4' }]),
      item(2, 'EBAY_ONLY', [{ id: 3, platform: 'ebay', status: 'active', platformItemId: 'E2', listingUrl: 'u', price: '36.1' }, { id: 4, platform: 'shopify', status: 'error', price: '25.4', error: 'Shopify 422' }]),
      item(3, 'FAILED', [{ id: 5, platform: 'ebay', status: 'error', price: '36.1', error: 'eBay 실패' }]),
      item(4, 'READY', []),
      item(5, 'CANCELLED', [{ id: 6, platform: 'ebay', status: 'ended', platformItemId: 'E5', price: '36.1' }]),
      item(6, 'PROCESSING', [{ id: 7, platform: 'ebay', status: 'pending', price: '36.1' }]),
    ],
    recentCrawlResults: [], activeJobs: [], staleJobs: 8,
    pipeline: counts, pipelineTabs: PIPELINE_TABS, uploadFilters: [
      { uploadId: 'up-1', filename: 'toybox.csv', createdAt: new Date('2026-09-15'), rowCount: 693, importedCount: 691, productCount: 201, notSelectedRows: 492, listedBoth: 185, remaining: 16, counts },
    ],
    crawlWaiting: 489, filters: { status: 'ALL', uploadId: 'up-1', view: 'batch' }, view: 'batch',
    uploadBatches: [{ uploadId: 'up-1', filename: 'toybox.csv', createdAt: new Date('2026-09-15'), rowCount: 693, importedCount: 691, productCount: 201, notSelectedRows: 492, listedBoth: 185, remaining: 16, counts }],
    selectedBatch: { uploadId: 'up-1', filename: 'toybox.csv', createdAt: new Date('2026-09-15'), rowCount: 693, importedCount: 691, productCount: 201, notSelectedRows: 492, listedBoth: 185, remaining: 16, counts },
    filteredProductIds: [1, 2, 3, 4, 5, 6],
    releaseGuard: { shippingPricingEnabled: true, pricingDisabledCount: 0 },
    ...data,
  });

  it('탭 8개 · 숫자는 고유 product 기준 · 합계 = 전체', () => {
    const html = render();
    const tabs = [...html.matchAll(/data-tab-status="(\w+)"[^>]*>([^<]+)<span class="tab-count">(\d+)<\/span>/g)].map(m => [m[1], m[2].trim(), Number(m[3])] as [string, string, number]);
    expect(tabs.map(t => t[0])).toEqual(['ALL', 'LISTED_BOTH', 'EBAY_ONLY', 'SHOPIFY_ONLY', 'READY', 'FAILED', 'PROCESSING', 'CANCELLED']);
    expect(tabs.map(t => t[1])).toEqual(['전체', '양쪽 등록 완료', 'eBay만 등록', 'Shopify만 등록', '미등록', '등록 실패', '처리 중', '판매 취소']);
    const total = tabs[0][2];
    const sum = tabs.slice(1).reduce((a, t) => a + t[2], 0);
    expect(sum).toBe(total);
    expect(total).toBe(201);
    //   탭은 CSV 작업(uploadId)을 유지한 서버 필터 링크
    expect(html).toContain('href="/?status=LISTED_BOTH&amp;uploadId=up-1"');
    expect(html).toContain('href="/?status=FAILED&amp;uploadId=up-1"');
  });

  it('행 상태 badge는 서버 상태를 그대로 쓰고, 부분 성공은 플랫폼 오류 badge를 따로 보여준다', () => {
    const html = render();
    expect(html.match(/data-pipeline-status="(\w+)"/g)).toEqual([
      'data-pipeline-status="LISTED_BOTH"', 'data-pipeline-status="EBAY_ONLY"', 'data-pipeline-status="FAILED"',
      'data-pipeline-status="READY"', 'data-pipeline-status="CANCELLED"', 'data-pipeline-status="PROCESSING"',
    ]);
    expect(html).toContain('data-testid="shopify-error"');
    expect(html).toContain('title="Shopify 422"');
    expect(html).toContain('2/2 판매중');
    expect(html).toContain('1/2 · Shopify 미연결');
    expect(html).toContain('등록 실패');
    expect(html).toContain('미등록');
  });

  it('CSV 작업 화면: 이 작업 요약 + 작업 목록으로 돌아가기', () => {
    const html = render();
    expect(html).toContain('data-testid="batch-title"');
    expect(html).toContain('toybox.csv');
    expect(html).toContain('CSV 작업 목록');
    const summary = html.match(/data-testid="upload-summary"[\s\S]*?<\/span>/)![0];
    for (const part of ['원본 693행', '가져온 상품 201개', '양쪽 185', 'eBay만 3', 'Shopify만 0', '미등록 1', '실패 12', '처리 중 0', '판매 취소 0', '선택하지 않은 원본 행 492개']) {
      expect(summary).toContain(part);
    }
    expect(html).toContain('href="/?status=EBAY_ONLY&amp;uploadId=up-1"');
  });

  it('기본 화면은 최근 CSV 작업 목록 — 전역 업로드 대기 탭·누적 상품 목록 없음', () => {
    const html = render({ view: 'batches', filters: { status: 'ALL', uploadId: 'ALL', view: 'batches' }, selectedBatch: null, filteredProductIds: [] });
    expect(html).toContain('data-testid="batch-list"');
    const card = html.match(/data-testid="batch-card"[\s\S]*?작업 열기/)![0];
    for (const part of ['toybox.csv', '원본 693행', '가져온 상품 201개', '선택하지 않은 행 492개', '양쪽 완료 185', 'eBay만 3', '미등록 1', '실패 12', '남은 작업 16개']) {
      expect(card).toContain(part);
    }
    expect(card).toContain('href="/?status=ALL&amp;uploadId=up-1"');
    //   기본 화면에는 상태 탭·상품 표·수집 데이터 영역이 없다 (누적 숫자 노출 금지)
    expect(html).not.toContain('data-tab-status=');
    expect(html).not.toContain('id="tab-all"');
    expect(html).not.toContain('수집 데이터 · DB 가져오기 대기');
    expect(html).not.toMatch(/업로드 대기 <span class="tab-count"/);
    expect(html).toContain('href="/?view=all"');
    expect(html).toContain('href="/upload-csv"');
  });

  it('작업 화면에서 수백 개를 하나씩 체크하지 않고 탭 전체를 선택·등록할 수 있다', () => {
    const html = render();
    expect(html).toContain('id="btn-select-filtered"');
    expect(html).toMatch(/이 탭 전체 선택 \(6개\)/);
    expect(html).toMatch(/이 탭 전체 등록 \(6개\)/);
    expect(html).toContain('const FILTERED_PRODUCT_IDS = [1,2,3,4,5,6];');
    expect(html).toContain("body.csvPlatforms = plan.csvPlatforms");
  });

  it('수집 데이터(crawl)는 참고용 전체 화면에만 · 과거 중단 job은 현재 작업에서 제외', () => {
    const html = render({ view: 'all', filters: { status: 'ALL', uploadId: 'ALL', view: 'all' }, selectedBatch: null });
    expect(html).toContain('수집 데이터 · DB 가져오기 대기');
    const crawlCount = html.match(/data-testid="crawl-waiting-count">(\d+)개/)![1];
    expect(crawlCount).toBe('489');
    expect(html).toContain('상품 수에 포함하지 않습니다');
    expect(html).toMatch(/data-testid="stale-jobs"[\s\S]*?작업 8개/);
    //   crawl 수(489)가 상품 탭 숫자에 더해지지 않는다
    expect(html).not.toMatch(/tab-count">690</);
    expect(html).not.toMatch(/tab-count">10927</);
  });

  it('완료/판매취소 AJAX 탭과 crawl 기반 집계는 제거됐다', () => {
    const view = fs.readFileSync(path.join(process.cwd(), 'views/dashboard.eta'), 'utf-8');
    expect(view).not.toMatch(/loadCompleted|loadEnded|completed-status-filter|ended-platform-filter/);
    expect(view).not.toMatch(/crawlByStatus\['new'\]/);
    expect(view).not.toContain('업로드 대기 <span class="tab-count">');
    const pages = fs.readFileSync(path.join(process.cwd(), 'src/routes/pages.ts'), 'utf-8');
    expect(pages).toContain('loadPipelineCounts(uploadIdParam)');
    expect(pages).toContain('loadPipelineProducts({ status: pipelineStatusParam');
    expect(pages).toContain('splitStaleJobs(allJobs)');
  });
});
