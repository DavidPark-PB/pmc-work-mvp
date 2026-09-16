/**
 * 상품 파이프라인 상태 — 고유 product 1개당 정확히 한 가지 상태
 *
 * 집계 규칙:
 * - products.id 기준으로만 센다 (crawl_results 행, 플랫폼별 listing 행을 상품 수로 세지 않는다)
 * - eBay/Shopify는 status='active' + 외부 ID가 있을 때만 등록 완료로 본다 (ended/error/draft/pending 제외)
 * - 가격이 화면에 있다는 이유로 등록 완료로 세지 않는다
 * - 전체 = 양쪽 완료 + eBay만 + Shopify만 + 미등록 + 실패 + 처리 중 + 판매 취소
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export const PIPELINE_STATUSES = ['PROCESSING', 'LISTED_BOTH', 'EBAY_ONLY', 'SHOPIFY_ONLY', 'FAILED', 'CANCELLED', 'READY'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_TABS: { key: 'ALL' | PipelineStatus; label: string }[] = [
  { key: 'ALL', label: '전체' },
  { key: 'LISTED_BOTH', label: '양쪽 등록 완료' },
  { key: 'EBAY_ONLY', label: 'eBay만 등록' },
  { key: 'SHOPIFY_ONLY', label: 'Shopify만 등록' },
  { key: 'READY', label: '미등록' },
  { key: 'FAILED', label: '등록 실패' },
  { key: 'PROCESSING', label: '처리 중' },
  { key: 'CANCELLED', label: '판매 취소' },
];

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  PROCESSING: '처리 중',
  LISTED_BOTH: '2/2 판매중',
  EBAY_ONLY: '1/2 · Shopify 미연결',
  SHOPIFY_ONLY: '1/2 · eBay 미연결',
  FAILED: '등록 실패',
  CANCELLED: '판매 취소',
  READY: '미등록',
};

/** pending 리스팅이 이 시간 안에 갱신됐을 때만 '처리 중' — 중단된 과거 job이 계속 진행 중으로 보이지 않게 */
export const PROCESSING_WINDOW_MS = 30 * 60 * 1000;
/** 이 시간이 지난 running job은 현재 작업으로 보지 않는다 (중단 추정) */
export const STALE_JOB_MS = 2 * 60 * 60 * 1000;

export interface ProductStateFlags {
  ebayActive: boolean;
  shopifyActive: boolean;
  hasEnded: boolean;
  hasError: boolean;
  processing: boolean;
}

/** 상호 배타적 상태 (우선순위: 처리 중 → 등록 상태 → 실패 → 판매 취소 → 미등록) */
export function classifyProduct(flags: ProductStateFlags): PipelineStatus {
  if (flags.processing) return 'PROCESSING';
  if (flags.ebayActive && flags.shopifyActive) return 'LISTED_BOTH';
  if (flags.ebayActive) return 'EBAY_ONLY';
  if (flags.shopifyActive) return 'SHOPIFY_ONLY';
  if (flags.hasError) return 'FAILED';
  if (flags.hasEnded) return 'CANCELLED';
  return 'READY';
}

/** 화면 listing 배열(json_agg 결과)로 같은 규칙 적용 — 서버 집계와 행 표시가 어긋나지 않게 */
export function classifyFromListings(listings: { platform: string; status: string; platformItemId?: string | null; listingUrl?: string | null; updatedAt?: string | Date | null }[], now = Date.now()): PipelineStatus {
  const of = (platform: string) => listings.filter(l => l.platform === platform);
  const isActive = (l: { status: string; platformItemId?: string | null; listingUrl?: string | null }) => l.status === 'active' && !!(l.platformItemId || l.listingUrl);
  const recentPending = listings.some(l => (l.platform === 'ebay' || l.platform === 'shopify') && l.status === 'pending'
    && !!l.updatedAt && now - new Date(l.updatedAt).getTime() <= PROCESSING_WINDOW_MS);
  return classifyProduct({
    ebayActive: of('ebay').some(isActive),
    shopifyActive: of('shopify').some(isActive),
    hasEnded: listings.some(l => (l.platform === 'ebay' || l.platform === 'shopify') && l.status === 'ended'),
    hasError: listings.some(l => (l.platform === 'ebay' || l.platform === 'shopify') && l.status === 'error'),
    processing: recentPending,
  });
}

/** SQL에서 같은 우선순위로 상태를 계산하는 CASE (classifyProduct와 순서 동일) */
const STATUS_CASE = sql`CASE
  WHEN s.processing THEN 'PROCESSING'
  WHEN s.ebay_active AND s.shopify_active THEN 'LISTED_BOTH'
  WHEN s.ebay_active THEN 'EBAY_ONLY'
  WHEN s.shopify_active THEN 'SHOPIFY_ONLY'
  WHEN s.has_error THEN 'FAILED'
  WHEN s.has_ended THEN 'CANCELLED'
  ELSE 'READY'
END`;

/** uploadId 필터: 특정 업로드 / 레거시(CSV 아님) / 전체 */
function uploadFilter(uploadId: string | null | undefined) {
  if (!uploadId || uploadId === 'ALL') return sql``;
  if (uploadId === 'LEGACY') return sql` AND p.metadata->'csvImport' IS NULL`;
  return sql` AND p.metadata->'csvImport'->>'uploadId' = ${uploadId}`;
}

function productStateCte(uploadId: string | null | undefined) {
  return sql`
    WITH s AS (
      SELECT p.id,
        bool_or(pl.platform = 'ebay' AND pl.status = 'active' AND pl.platform_item_id IS NOT NULL) AS ebay_active,
        bool_or(pl.platform = 'shopify' AND pl.status = 'active' AND pl.platform_item_id IS NOT NULL) AS shopify_active,
        bool_or(pl.platform IN ('ebay','shopify') AND pl.status = 'ended') AS has_ended,
        bool_or(pl.platform IN ('ebay','shopify') AND pl.status = 'error') AS has_error,
        bool_or(pl.platform IN ('ebay','shopify') AND pl.status = 'pending'
          AND GREATEST(pl.updated_at, pl.created_at) > NOW() - (${PROCESSING_WINDOW_MS / 1000} || ' seconds')::interval) AS processing
      FROM products p
      LEFT JOIN platform_listings pl ON pl.product_id = p.id
      WHERE p.status <> 'trashed'${uploadFilter(uploadId)}
      GROUP BY p.id
    )`;
}

export type PipelineCounts = Record<PipelineStatus, number> & { total: number };

/** 탭 숫자 — 고유 products.id 기준, 상태는 상호 배타적이라 합계 = 전체 */
export async function loadPipelineCounts(uploadId?: string | null): Promise<PipelineCounts> {
  const result = await db.execute(sql`${productStateCte(uploadId)}
    SELECT ${STATUS_CASE} AS status, count(*)::int AS count FROM s GROUP BY 1`);
  const counts = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, 0])) as PipelineCounts;
  let total = 0;
  for (const row of result.rows as { status: PipelineStatus; count: number }[]) {
    counts[row.status] = Number(row.count);
    total += Number(row.count);
  }
  counts.total = total;
  return counts;
}

/** product로 아직 가져오지 않은 수집 데이터 (상품 파이프라인과 분리해서 표시) */
export async function loadCrawlWaitingCount(): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS count FROM crawl_results WHERE status = 'new' AND product_id IS NULL`);
  return Number((result.rows[0] as { count: number } | undefined)?.count ?? 0);
}

export interface PipelineProductRow {
  id: number;
  sku: string;
  title: string;
  titleKo: string | null;
  status: PipelineStatus;
  costPrice: string | null;
  metadata: unknown;
  sourceUrl: string | null;
  sourcePlatform: string | null;
  createdAt: Date;
  imageUrl: string | null;
  listings: string;
  uploadId: string | null;
}

/** 탭·업로드 필터가 적용된 상품 목록 (고유 product 행) */
export async function loadPipelineProducts(options: { status?: string | null; uploadId?: string | null; limit?: number } = {}): Promise<PipelineProductRow[]> {
  const limit = options.limit ?? 200;
  const status = options.status && options.status !== 'ALL' ? options.status : null;
  const result = await db.execute(sql`${productStateCte(options.uploadId)}
    SELECT p.id, p.sku, p.title, p.title_ko AS "titleKo", p.cost_price AS "costPrice", p.metadata,
           p.source_url AS "sourceUrl", p.source_platform AS "sourcePlatform", p.created_at AS "createdAt",
           p.metadata->'csvImport'->>'uploadId' AS "uploadId",
           ${STATUS_CASE} AS status,
           COALESCE(
             NULLIF((SELECT url FROM product_images WHERE product_id = p.id AND url IS NOT NULL AND url != '' ORDER BY position LIMIT 1), ''),
             (SELECT image_url FROM crawl_results WHERE product_id = p.id AND image_url IS NOT NULL AND image_url != '' LIMIT 1)
           ) AS "imageUrl",
           COALESCE((
             SELECT json_agg(json_build_object(
               'id', pl.id, 'platform', pl.platform, 'price', pl.price, 'status', pl.status,
               'listingUrl', pl.listing_url, 'platformItemId', pl.platform_item_id, 'quantity', pl.quantity,
               'updatedAt', pl.updated_at, 'error', pl.platform_data->>'error'
             ))
             FROM platform_listings pl WHERE pl.product_id = p.id
           ), '[]') AS listings
    FROM s JOIN products p ON p.id = s.id
    ${status ? sql`WHERE ${STATUS_CASE} = ${status}` : sql``}
    ORDER BY p.created_at DESC
    LIMIT ${limit}`);
  return (result.rows as any[]).map(row => ({ ...row, listings: typeof row.listings === 'string' ? row.listings : JSON.stringify(row.listings) }));
}

export interface UploadFilterOption {
  uploadId: string;
  filename: string;
  createdAt: Date | string;
  rowCount: number;
  importedCount: number;
  productCount: number;
  counts: PipelineCounts;
}

/** CSV 업로드별 필터 목록 + 업로드별 상태 요약 (고유 product 기준) */
export async function loadUploadFilters(limit = 10): Promise<UploadFilterOption[]> {
  const uploads = await db.execute(sql`
    SELECT u.upload_id AS "uploadId", u.filename, u.created_at AS "createdAt",
           u.row_count AS "rowCount", u.imported_count AS "importedCount"
    FROM csv_uploads u
    WHERE EXISTS (SELECT 1 FROM products p WHERE p.metadata->'csvImport'->>'uploadId' = u.upload_id AND p.status <> 'trashed')
    ORDER BY u.created_at DESC
    LIMIT ${limit}`);

  const out: UploadFilterOption[] = [];
  for (const upload of uploads.rows as any[]) {
    const counts = await loadPipelineCounts(upload.uploadId);
    out.push({
      uploadId: upload.uploadId,
      filename: upload.filename,
      createdAt: upload.createdAt,
      rowCount: Number(upload.rowCount ?? 0),
      importedCount: Number(upload.importedCount ?? 0),
      productCount: counts.total,
      counts,
    });
  }
  return out;
}

/** 진행 중으로 볼 수 있는 job만 (오래된 running job은 중단 추정으로 분리) */
export function splitStaleJobs<T extends { status: string; createdAt: Date | string; finishedAt?: Date | string | null }>(jobs: T[], now = Date.now()): { active: T[]; stale: T[] } {
  const active: T[] = [];
  const stale: T[] = [];
  for (const job of jobs) {
    const started = new Date(job.createdAt).getTime();
    if (job.status === 'running' && now - started <= STALE_JOB_MS) active.push(job);
    else stale.push(job);
  }
  return { active, stale };
}
