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
import { relations } from 'drizzle-orm';

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
  status: varchar('status', { length: 50 }).default('uploaded').notNull(), // uploaded → imported
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
