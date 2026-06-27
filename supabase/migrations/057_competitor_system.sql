-- Migration 057: 경쟁셀러 자동 수집 + AI 매핑 시스템
-- STEP 1: competitor_sellers
-- STEP 2: competitor_listings (기존 competitor_prices 대체/보완)
-- STEP 3: product_matches
-- STEP 4: price_history (기존 price_history 확장)

-- ================================================
-- 1. competitor_sellers — 경쟁셀러 마스터
-- ================================================
CREATE TABLE IF NOT EXISTS competitor_sellers (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id        TEXT NOT NULL UNIQUE,          -- eBay seller username
  seller_name      TEXT DEFAULT '',               -- 내부 관리용 이름
  platform         TEXT NOT NULL DEFAULT 'ebay',
  active           BOOLEAN DEFAULT true,
  crawl_interval   INTEGER DEFAULT 24,            -- 수집 주기 (시간)
  last_crawled_at  TIMESTAMPTZ,                   -- 마지막 수집 시각
  listing_count    INTEGER DEFAULT 0,             -- 수집된 리스팅 수
  memo             TEXT DEFAULT '',
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

INSERT INTO competitor_sellers (seller_id, seller_name, platform, memo) VALUES
  ('hello_kr',     'hello_kr',          'ebay', 'target_sellers 이전'),
  ('onmom_house',  'onmom_house',       'ebay', 'target_sellers 이전'),
  ('value-goods',  'value-goods',       'ebay', 'target_sellers 이전'),
  ('actkora',      'actkora',           'ebay', 'target_sellers 이전'),
  ('dwstore13',    '이대우/dwstore13',  'ebay', 'competitors 이전')
ON CONFLICT (seller_id) DO NOTHING;

-- ================================================
-- 2. competitor_listings — 경쟁상품 리스팅 전체
-- ================================================
CREATE TABLE IF NOT EXISTS competitor_listings (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_id        TEXT NOT NULL REFERENCES competitor_sellers(seller_id) ON DELETE CASCADE,
  ebay_item_id     TEXT NOT NULL,
  title            TEXT DEFAULT '',
  price            NUMERIC(12,2) DEFAULT 0,
  shipping         NUMERIC(12,2) DEFAULT 0,
  total_price      NUMERIC(12,2) GENERATED ALWAYS AS (price + shipping) STORED,
  quantity         INTEGER DEFAULT 0,
  sold             INTEGER DEFAULT 0,
  image_url        TEXT DEFAULT '',
  url              TEXT DEFAULT '',
  category         TEXT DEFAULT '',
  item_specifics   JSONB DEFAULT '{}'::jsonb,     -- Brand, Language, Set 등
  status           TEXT DEFAULT 'active'
                   CHECK (status IN ('active','ended','out_of_stock')),
  first_seen       TIMESTAMPTZ DEFAULT now(),
  last_seen        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (seller_id, ebay_item_id)
);

CREATE INDEX IF NOT EXISTS idx_comp_listings_seller   ON competitor_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_comp_listings_item     ON competitor_listings(ebay_item_id);
CREATE INDEX IF NOT EXISTS idx_comp_listings_status   ON competitor_listings(status);
CREATE INDEX IF NOT EXISTS idx_comp_listings_title    ON competitor_listings USING gin(to_tsvector('english', title));

-- ================================================
-- 3. product_matches — AI 매핑 결과 (핵심 테이블)
-- ================================================
CREATE TABLE IF NOT EXISTS product_matches (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  our_sku          TEXT NOT NULL,                 -- 우리 상품 SKU
  our_item_id      TEXT,                          -- 우리 eBay item_id
  competitor_item_id TEXT NOT NULL,               -- 경쟁사 eBay item_id
  seller_id        TEXT NOT NULL,
  confidence       NUMERIC(5,3) DEFAULT 0,        -- 0~1 (AI 확신도)
  method           TEXT DEFAULT 'ai'              -- ai | manual | title_sim
                   CHECK (method IN ('ai','manual','title_sim')),
  ai_reason        TEXT DEFAULT '',               -- AI 판단 이유
  status           TEXT DEFAULT 'pending'         -- pending | approved | rejected | ignored
                   CHECK (status IN ('pending','approved','rejected','ignored')),
  approved_by      TEXT,                          -- 승인자 username
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (our_sku, competitor_item_id)
);

CREATE INDEX IF NOT EXISTS idx_prod_matches_sku      ON product_matches(our_sku);
CREATE INDEX IF NOT EXISTS idx_prod_matches_status   ON product_matches(status);
CREATE INDEX IF NOT EXISTS idx_prod_matches_comp     ON product_matches(competitor_item_id);

-- ================================================
-- 4. competitor_price_history — 가격 변동 이력
-- ================================================
CREATE TABLE IF NOT EXISTS competitor_price_history (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  competitor_item_id TEXT NOT NULL,
  seller_id        TEXT DEFAULT '',
  old_price        NUMERIC(12,2),
  new_price        NUMERIC(12,2),
  old_shipping     NUMERIC(12,2),
  new_shipping     NUMERIC(12,2),
  old_total        NUMERIC(12,2),
  new_total        NUMERIC(12,2),
  change_pct       NUMERIC(7,2),                  -- 변동률 %
  changed_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_hist_item    ON competitor_price_history(competitor_item_id);
CREATE INDEX IF NOT EXISTS idx_price_hist_changed ON competitor_price_history(changed_at DESC);

-- ================================================
-- 5. competitor_listings에서 기존 competitor_prices 데이터 마이그레이션
--    (seller_id가 있는 것만, competitor_id → ebay_item_id)
-- ================================================
INSERT INTO competitor_listings
  (seller_id, ebay_item_id, title, price, shipping, url, status, last_seen)
SELECT
  cp.seller_id,
  cp.competitor_id,
  COALESCE(cp.title, ''),
  COALESCE(cp.competitor_price, 0),
  COALESCE(cp.competitor_shipping, 0),
  COALESCE(cp.competitor_url, ''),
  CASE WHEN cp.status = 'ended' THEN 'ended'
       WHEN cp.status = 'out_of_stock' THEN 'out_of_stock'
       ELSE 'active' END,
  COALESCE(cp.last_refreshed_at, cp.tracked_at, now())
FROM competitor_prices cp
WHERE cp.seller_id IS NOT NULL
  AND cp.seller_id != ''
  AND cp.competitor_id IS NOT NULL
  AND cp.competitor_id != ''
  AND EXISTS (
    SELECT 1 FROM competitor_sellers cs WHERE cs.seller_id = cp.seller_id
  )
ON CONFLICT (seller_id, ebay_item_id) DO NOTHING;

-- ================================================
-- 6. product_matches에 기존 매핑 이전
--    (competitor_prices의 sku ↔ competitor_id → 자동 승인 처리)
-- ================================================
INSERT INTO product_matches
  (our_sku, competitor_item_id, seller_id, confidence, method, status, approved_at)
SELECT DISTINCT
  cp.sku,
  cp.competitor_id,
  COALESCE(cp.seller_id, ''),
  0.99,
  'manual',
  'approved',
  now()
FROM competitor_prices cp
WHERE cp.sku IS NOT NULL
  AND cp.sku != ''
  AND cp.competitor_id IS NOT NULL
  AND cp.competitor_id != ''
  AND cp.sku != cp.competitor_id   -- sku=item_id인 자기자신 제외
ON CONFLICT (our_sku, competitor_item_id) DO NOTHING;

COMMENT ON TABLE competitor_sellers IS '경쟁셀러 마스터 — seller_id 등록하면 크론이 자동 수집';
COMMENT ON TABLE competitor_listings IS '경쟁상품 리스팅 전체 — 삭제 없이 ended 상태로 관리';
COMMENT ON TABLE product_matches IS 'AI 매핑 결과 — 한 번 승인하면 재질문 없음';
COMMENT ON TABLE competitor_price_history IS '가격 변동 이력 — 히스토리 영구 보관';
