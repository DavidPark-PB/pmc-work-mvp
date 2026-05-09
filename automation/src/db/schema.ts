import {
  pgTable,
  serial,
  varchar,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ============================================================
// Crawl Sources — 크롤링 대상 사이트
// ============================================================
export const crawlSources = pgTable('crawl_sources', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),        // '쿠팡', '롯데온', '이마트'
  baseUrl: text('base_url').notNull(),
  crawlerType: varchar('crawler_type', { length: 50 }).notNull(), // 'coupang', 'lotte', 'emart'
  config: jsonb('config'),                                  // 크롤러 설정
  isActive: boolean('is_active').default(true).notNull(),
  lastCrawledAt: timestamp('last_crawled_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ============================================================
// Crawl Results — 크롤링된 원본 데이터
// ============================================================
export const crawlResults = pgTable('crawl_results', {
  id: serial('id').primaryKey(),
  sourceId: integer('source_id').references(() => crawlSources.id).notNull(),
  externalId: varchar('external_id', { length: 255 }),      // 원본 사이트 상품ID (중복 방지)
  title: varchar('title', { length: 500 }).notNull(),       // 한글 상품명
  titleEn: varchar('title_en', { length: 500 }),            // 영문 번역 상품명
  price: numeric('price', { precision: 10, scale: 2 }),     // 원본 가격 (KRW)
  currency: varchar('currency', { length: 10 }).default('KRW'),
  url: text('url'),                                         // 원본 상품 URL
  imageUrl: text('image_url'),                              // 대표 이미지
  rawData: jsonb('raw_data'),                               // { vendor, images[], options[], bodyHtml }
  status: varchar('status', { length: 50 }).default('new').notNull(), // new → reviewed → imported → ignored
  productId: integer('product_id').references(() => products.id),     // import 시 연결
  ownerId: varchar('owner_id', { length: 100 }),                      // 소유자 UUID
  ownerName: varchar('owner_name', { length: 100 }),                  // 소유자 닉네임
  crawledAt: timestamp('crawled_at').defaultNow().notNull(),
}, (table) => [
  index('crawl_results_source_idx').on(table.sourceId),
  index('crawl_results_status_idx').on(table.status),
  uniqueIndex('crawl_results_source_external_idx').on(table.sourceId, table.externalId),
]);

// ============================================================
// Products — 마스터 상품 (판매할 상품)
// ============================================================
export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  sku: varchar('sku', { length: 100 }).notNull(),           // PMC-NNNNN
  title: varchar('title', { length: 500 }).notNull(),       // 영문 상품명 (eBay/Shopify용)
  titleKo: varchar('title_ko', { length: 500 }),            // 한글 상품명 (크롤에서)
  description: text('description'),                          // 영문 상품 설명 HTML
  costPrice: numeric('cost_price', { precision: 10, scale: 2 }), // 매입가 (KRW)
  weight: integer('weight'),                                 // 무게 (그램)
  brand: varchar('brand', { length: 255 }),                  // 브랜드/벤더
  productType: varchar('product_type', { length: 255 }),     // 상품 유형 ('Toy', 'TCG' 등)
  tags: text('tags').array(),                                // 태그 배열
  condition: varchar('condition', { length: 50 }).default('new'), // new, used (eBay 필수)
  sourceUrl: text('source_url'),                             // 한국 원본 URL
  sourcePlatform: varchar('source_platform', { length: 50 }), // 'coupang', 'lotte' 등
  status: varchar('status', { length: 50 }).default('active').notNull(), // active, soldout, discontinued
  metadata: jsonb('metadata'),                               // 기타 (최소한으로 사용)
  ownerId: varchar('owner_id', { length: 100 }),             // 소유자 UUID
  ownerName: varchar('owner_name', { length: 100 }),         // 소유자 닉네임
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('products_sku_idx').on(table.sku),
  index('products_status_idx').on(table.status),
  index('products_source_platform_idx').on(table.sourcePlatform),
]);

// ============================================================
// Product Images — 상품 이미지
// ============================================================
export const productImages = pgTable('product_images', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  url: text('url').notNull(),
  position: integer('position').default(0),
  alt: varchar('alt', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('product_images_product_idx').on(table.productId),
]);

// ============================================================
// Platform Listings — 플랫폼 리스팅 (우리가 올린 것)
// ============================================================
export const platformListings = pgTable('platform_listings', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  platform: varchar('platform', { length: 50 }).notNull(),   // 'ebay', 'shopify'
  platformItemId: varchar('platform_item_id', { length: 255 }), // eBay ItemID, Shopify ProductID (업로드 후)
  platformSku: varchar('platform_sku', { length: 255 }),
  title: varchar('title', { length: 500 }),                  // 리스팅 제목 (마스터와 다를 수 있음)
  listingUrl: text('listing_url'),
  status: varchar('status', { length: 50 }).default('draft').notNull(), // draft → pending → active → ended → error
  price: numeric('price', { precision: 10, scale: 2 }),      // 판매가 (USD)
  currency: varchar('currency', { length: 10 }).default('USD'),
  shippingCost: numeric('shipping_cost', { precision: 10, scale: 2 }), // 배송비
  quantity: integer('quantity').default(0),                   // 재고 수량
  lastSyncedAt: timestamp('last_synced_at'),
  platformData: jsonb('platform_data'),                      // 플랫폼 고유 데이터만
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('platform_listings_unique_idx').on(table.productId, table.platform),
  index('platform_listings_platform_idx').on(table.platform),
  index('platform_listings_status_idx').on(table.status),
]);

// ============================================================
// Shipping Rates — 배송비 조회 테이블
// ============================================================
export const shippingRates = pgTable('shipping_rates', {
  id: serial('id').primaryKey(),
  carrier: varchar('carrier', { length: 100 }).notNull(),    // 'YunExpress', 'K-Packet'
  minWeight: integer('min_weight').notNull(),                 // 그램
  maxWeight: integer('max_weight').notNull(),                 // 그램
  rate: numeric('rate', { precision: 10, scale: 2 }).notNull(), // KRW
  destination: varchar('destination', { length: 100 }).default('US'),
  isActive: boolean('is_active').default(true).notNull(),
});

// ============================================================
// Pricing Settings — 플랫폼별 가격 설정
// ============================================================
export const pricingSettings = pgTable('pricing_settings', {
  id: serial('id').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull().unique(), // 'ebay', 'shopify'
  marginRate: numeric('margin_rate', { precision: 5, scale: 4 }).notNull(),           // 0.3000
  exchangeRate: numeric('exchange_rate', { precision: 10, scale: 2 }).notNull(),       // 1400.00
  platformFeeRate: numeric('platform_fee_rate', { precision: 5, scale: 4 }).notNull(), // 0.1300
  defaultShippingKrw: numeric('default_shipping_krw', { precision: 10, scale: 2 }).notNull(), // 5500.00
  defaultQuantity: integer('default_quantity').notNull().default(5),                    // 기본 재고 수량 (사장님이 설정)
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================================
// CSV Uploads — 업로드 이력
// ============================================================
export const csvUploads = pgTable('csv_uploads', {
  id: serial('id').primaryKey(),
  uploadId: varchar('upload_id', { length: 100 }).notNull().unique(), // UUID
  filename: varchar('filename', { length: 500 }).notNull(),            // 원본 파일명
  rowCount: integer('row_count').notNull(),                            // 행 수
  importedCount: integer('imported_count').default(0),                  // DB 등록된 행 수
  status: varchar('status', { length: 50 }).default('uploaded').notNull(), // uploaded → mapped → imported
  rawFields: jsonb('raw_fields').$type<string[][]>(),                    // 원본 CSV 필드 (헤더+데이터), 매핑 확정 후 null
  columnMapping: jsonb('column_mapping').$type<Record<string, number>>(), // 확정 매핑 {name: 2, price: 5, ...}
  parsedRows: jsonb('parsed_rows').$type<{
    image: string; url: string; name: string; price: number;
    rating: number; reviewCount: number; discountRate: string;
    originalPrice: number; category?: string; brand?: string;
    weight?: number; description?: string;
  }[]>(),                                                              // 매핑 확정 후 생성
  ownerId: varchar('owner_id', { length: 100 }),             // 업로더 UUID
  ownerName: varchar('owner_name', { length: 100 }),         // 업로더 닉네임
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ============================================================
// Upload Jobs — 업로드 잡 상태 (서버 재시작에도 유지)
// ============================================================
export const uploadJobs = pgTable('upload_jobs', {
  id: varchar('id', { length: 100 }).primaryKey(),             // UUID
  status: varchar('status', { length: 50 }).notNull(),         // running, done, error
  platforms: jsonb('platforms').$type<string[]>().notNull(),    // ['ebay', 'shopify']
  total: integer('total').notNull(),
  completed: integer('completed').default(0).notNull(),
  failed: integer('failed').default(0).notNull(),
  results: jsonb('results').$type<{
    crawlResultId: number;
    title: string;
    platform: string;
    success: boolean;
    platformItemId?: string;
    listingUrl?: string;
    error?: string;
  }[]>().default([]).notNull(),
  dryRun: boolean('dry_run').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
});

// ============================================================
// Platform Tokens — 플랫폼 OAuth 토큰 (갱신 시 DB 저장)
// ============================================================
export const platformTokens = pgTable('platform_tokens', {
  id: serial('id').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull().unique(), // 'ebay', 'alibaba', 'shopee'
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at'),
  metadata: jsonb('metadata'),                                      // 플랫폼별 추가 데이터
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================================
// Category Cache — 플랫폼 카테고리 매핑 캐시
// ============================================================
export const categoryCache = pgTable('category_cache', {
  id: serial('id').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull(),      // 'ebay'
  keyword: varchar('keyword', { length: 500 }).notNull(),        // 검색 키워드
  categoryId: varchar('category_id', { length: 100 }).notNull(), // 플랫폼 카테고리 ID
  categoryName: varchar('category_name', { length: 500 }),       // 카테고리명
  cachedAt: timestamp('cached_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('category_cache_platform_keyword_idx').on(table.platform, table.keyword),
]);

// ============================================================
// Description Settings — 플랫폼별 상품 설명 템플릿
// ============================================================
export const descriptionSettings = pgTable('description_settings', {
  id: serial('id').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull().unique(), // 'common', 'ebay', 'shopify', 'alibaba', 'shopee'
  templateHtml: text('template_html').notNull().default(''),        // 공통 정책 HTML (배송/결제/반품)
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================================
// Users — 직원 계정 (로그인용)
// ============================================================
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 20 }).default('staff').notNull(), // 'admin' | 'staff'
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastLoginAt: timestamp('last_login_at'),
});

// ============================================================
// Audit Logs — 작업자별 감사 로그
// ============================================================
export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id'),                                    // nullable: 시스템 작업
  userName: varchar('user_name', { length: 100 }),               // 당시 displayName (삭제/이름변경 후에도 추적)
  action: varchar('action', { length: 100 }).notNull(),          // 'listing.create', 'staff.delete' 등
  category: varchar('category', { length: 30 }).notNull(),       // 'listing'|'product'|'staff'|'setting'|'assign'|'import'|'system'
  targetType: varchar('target_type', { length: 50 }),            // 'product', 'listing', 'crawl_result', 'user', 'setting'
  targetId: varchar('target_id', { length: 100 }),               // 대상 ID (복수 대상은 details에)
  success: boolean('success').default(true).notNull(),
  details: jsonb('details'),                                     // { error, count, platform, before, after, ... }
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('audit_logs_user_id_idx').on(table.userId),
  index('audit_logs_action_idx').on(table.action),
  index('audit_logs_category_idx').on(table.category),
  index('audit_logs_created_at_idx').on(table.createdAt),
]);

// ============================================================
// WMS Phase 1 — shared tables (메인 앱 supabase/migrations/038 가 권위)
//
// 주의:
//   - 본 sub-app schema 는 typed access layer 일 뿐, schema source-of-truth 가 아니다.
//   - shared table 의 컬럼 추가/변경/삭제는 반드시 메인 앱 migration 으로만 진행.
//   - 본 정의가 메인 SQL 과 어긋나면 drift — drizzle-kit pull 결과와 diff 0 유지 필요.
// ============================================================

// ── sku_master — WMS 내부 SKU 의 단일 기준 ───────────────────
export const skuMaster = pgTable('sku_master', {
  id: serial('id').primaryKey(),
  internalSku: varchar('internal_sku', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  productType: varchar('product_type', { length: 50 }),
  brand: varchar('brand', { length: 100 }),
  category: varchar('category', { length: 100 }),
  status: varchar('status', { length: 30 }).default('active').notNull(),     // 'active' | 'paused' | 'discontinued'
  automationEnabled: boolean('automation_enabled').default(false).notNull(),
  costKrw: numeric('cost_krw', { precision: 12, scale: 2 }),
  weightGram: integer('weight_gram'),
  hsCode: varchar('hs_code', { length: 50 }),
  notes: text('notes'),
  createdBy: integer('created_by'),                                          // users(id) — loose coupling, no FK
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_sku_master_status').on(table.status),
  index('idx_sku_master_automation_enabled').on(table.automationEnabled),
]);

// ── sku_listing_link — 내부 SKU ↔ 마켓 listing/option 매핑 ───
export const skuListingLink = pgTable('sku_listing_link', {
  id: serial('id').primaryKey(),
  skuId: integer('sku_id').references(() => skuMaster.id, { onDelete: 'cascade' }).notNull(),
  marketplace: varchar('marketplace', { length: 50 }).notNull(),  // 'ebay' | 'shopify' | 'naver' | 'shopee' | 'alibaba' | 'coupang' | 'qoo10'
  listingId: varchar('listing_id', { length: 200 }).notNull(),
  optionId: varchar('option_id', { length: 200 }),
  marketplaceSku: varchar('marketplace_sku', { length: 200 }),
  isPrimary: boolean('is_primary').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_sku_listing_link_sku_id').on(table.skuId),
  index('idx_sku_listing_link_marketplace').on(table.marketplace),
  uniqueIndex('sku_listing_link_marketplace_listing_option_unique').on(
    table.marketplace, table.listingId, table.optionId
  ),
]);

// ── jobs — DB jobs polling 토대 (Phase 1: schema only, worker 없음) ─
export const jobs = pgTable('jobs', {
  id: serial('id').primaryKey(),
  jobType: varchar('job_type', { length: 100 }).notNull(),
  status: varchar('status', { length: 30 }).default('pending').notNull(), // 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  payload: jsonb('payload'),
  priority: integer('priority').default(100).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 200 }).unique(),
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(3).notNull(),
  availableAt: timestamp('available_at').defaultNow().notNull(),
  lockedAt: timestamp('locked_at'),
  lockedBy: varchar('locked_by', { length: 100 }),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  failedAt: timestamp('failed_at'),
  errorMessage: text('error_message'),
  createdBy: integer('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_jobs_status_available').on(table.status, table.availableAt),
  index('idx_jobs_locked_at').on(table.lockedAt),
  index('idx_jobs_job_type').on(table.jobType),
]);

// ── automation_runs — 자동화 실행 이력 (Phase 1 foundation + Phase 3 PR S 확장) ─
//
// related_task_id 는 메인 앱 team_tasks(id) 를 참조한다. team_tasks 는 본 sub-app schema 의
// scope 밖 (메인 앱 전용) 이므로 typed FK 를 걸지 않고 plain integer 로 둔다. 메인 SQL 의
// `references team_tasks(id)` 가 운영 DB 단의 무결성을 보장.
//
// Phase 3 PR S — Safety Foundation 확장 컬럼 (메인 앱 supabase/migrations/040 가 권위):
//   - executed_by_user_id  → users(id) (sub-app schema 밖 — plain integer)
//   - action_name, target_table, target_id    : query-able executor / target metadata
//   - rollback_method, rollback_hint          : 되돌리기 가능 여부 + 방법 hint
//   - rolled_back_at/by, rollback_run_id, rollback_reason : 되돌리기 실행 기록
//
// rollback_run_id 는 automation_runs(id) 셀프 FK. 단방향 포인터 정책:
//   원본 row → 자신을 되돌린 rollback row id.   rollback row → NULL.
//   역방향은 rollback row 의 input_snapshot.original_run_id 로.
export const automationRuns = pgTable('automation_runs', {
  id: serial('id').primaryKey(),
  jobId: integer('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  automationType: varchar('automation_type', { length: 100 }).notNull(),
  triggeredBy: varchar('triggered_by', { length: 100 }),                 // 'cron' | 'user:{id}' | 'legacy_admin' | 'webhook' 등
  status: varchar('status', { length: 30 }).default('started').notNull(), // pending | started | succeeded | failed | aborted | cancelled | rollback_required | rolled_back
  inputSnapshot: jsonb('input_snapshot'),                                 // src/lib/redact.js 통과 후 저장 (PR S: rollback row 는 { original_run_id, original_after })
  outputSnapshot: jsonb('output_snapshot'),                               // src/lib/redact.js 통과 후 저장
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  errorCode: varchar('error_code', { length: 100 }),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0).notNull(),
  relatedSkuId: integer('related_sku_id').references(() => skuMaster.id),
  relatedTaskId: integer('related_task_id'),                              // team_tasks(id) — sub-app schema 밖, FK 없음
  createdAt: timestamp('created_at').defaultNow().notNull(),

  // Phase 3 PR S — Safety Foundation
  executedByUserId: integer('executed_by_user_id'),                       // users(id) — sub-app schema 밖, FK 없음 (plain int)
  actionName: varchar('action_name', { length: 100 }),                    // 'mock_order_import' | 'price_change' | 'rollback' 등
  targetTable: varchar('target_table', { length: 100 }),                  // ('wms_orders', N) 형식의 target row 포인터
  targetId: integer('target_id'),
  rollbackMethod: varchar('rollback_method', { length: 20 }),             // 'auto' | 'manual' | 'irreversible' | null
  rollbackHint: text('rollback_hint'),                                    // 'manual' 일 때 admin 이 참고할 SQL/절차
  rolledBackAt: timestamp('rolled_back_at'),
  rolledBackBy: integer('rolled_back_by'),                                // users(id) — sub-app schema 밖, FK 없음
  rollbackRunId: integer('rollback_run_id'),                              // automation_runs(id) 셀프 FK — sub-app 에선 plain int (drizzle 셀프 참조 회피)
  rollbackReason: text('rollback_reason'),
}, (table) => [
  index('idx_automation_runs_job_id').on(table.jobId),
  index('idx_automation_runs_type_status').on(table.automationType, table.status),
  index('idx_automation_runs_related_sku_id').on(table.relatedSkuId),
  // Phase 3 PR S 인덱스
  index('idx_automation_runs_executed_by').on(table.executedByUserId),
  index('idx_automation_runs_action_status').on(table.actionName, table.status),
  index('idx_automation_runs_target').on(table.targetTable, table.targetId),
  // Partial index — 040 SQL 의 WHERE status = 'rollback_required' 와 정합
  index('idx_automation_runs_rollback_required')
    .on(table.actionName)
    .where(sql`status = 'rollback_required'`),
]);

// ============================================================
// Relations
// ============================================================
export const crawlSourcesRelations = relations(crawlSources, ({ many }) => ({
  results: many(crawlResults),
}));

export const crawlResultsRelations = relations(crawlResults, ({ one }) => ({
  source: one(crawlSources, { fields: [crawlResults.sourceId], references: [crawlSources.id] }),
  product: one(products, { fields: [crawlResults.productId], references: [products.id] }),
}));

export const productsRelations = relations(products, ({ many }) => ({
  images: many(productImages),
  listings: many(platformListings),
  crawlResults: many(crawlResults),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const platformListingsRelations = relations(platformListings, ({ one }) => ({
  product: one(products, { fields: [platformListings.productId], references: [products.id] }),
}));

// WMS Phase 1 relations
export const skuMasterRelations = relations(skuMaster, ({ many }) => ({
  links: many(skuListingLink),
  automationRuns: many(automationRuns),
}));

export const skuListingLinkRelations = relations(skuListingLink, ({ one }) => ({
  sku: one(skuMaster, { fields: [skuListingLink.skuId], references: [skuMaster.id] }),
}));

export const jobsRelations = relations(jobs, ({ many }) => ({
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one }) => ({
  job: one(jobs, { fields: [automationRuns.jobId], references: [jobs.id] }),
  sku: one(skuMaster, { fields: [automationRuns.relatedSkuId], references: [skuMaster.id] }),
}));
