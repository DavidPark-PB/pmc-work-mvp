-- =============================================
-- DEPRECATED: This file is superseded by 002_add_pmc_tables.sql
-- The Supabase project already has 10 tables from the initial setup.
-- Use 002_add_pmc_tables.sql which extends existing tables + adds 7 new ones.
-- =============================================
-- PMC Work MVP: Google Sheets → Supabase Migration (ORIGINAL — DO NOT RUN)
-- 12 tables covering all data entities
-- =============================================

-- Updated-at trigger function (reusable)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';


-- =============================================
-- 1. master_products (최종 Dashboard A-S 19열)
-- =============================================
CREATE TABLE master_products (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL DEFAULT '',
  image_url       TEXT DEFAULT '',
  weight_kg       NUMERIC(8,3) DEFAULT 0,

  -- Cost structure (KRW)
  purchase_price  INTEGER DEFAULT 0,
  shipping_krw    INTEGER DEFAULT 0,
  fee_krw         INTEGER DEFAULT 0,
  tax_krw         INTEGER DEFAULT 0,
  total_cost      INTEGER DEFAULT 0,

  -- Selling prices
  price_usd       NUMERIC(10,2) DEFAULT 0,
  shipping_usd    NUMERIC(10,2) DEFAULT 0,

  -- Calculated
  profit_krw      INTEGER DEFAULT 0,
  margin_pct      NUMERIC(6,2) DEFAULT 0,

  -- Sales & inventory
  sales_count     INTEGER DEFAULT 0,
  stock           INTEGER DEFAULT 0,

  -- Platform refs
  ebay_item_id    TEXT DEFAULT '',
  ebay_status     TEXT DEFAULT '',
  shopify_status  TEXT DEFAULT '',
  supplier        TEXT DEFAULT '',

  -- Extended (from master-products.json)
  title_en        TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  description_en  TEXT DEFAULT '',
  category        TEXT DEFAULT '',
  target_margin   NUMERIC(5,2) DEFAULT 30,
  condition       TEXT DEFAULT 'new',
  keywords        JSONB DEFAULT '[]'::jsonb,
  image_urls      JSONB DEFAULT '[]'::jsonb,
  ebay_category_id    TEXT DEFAULT '',
  naver_category_id   TEXT DEFAULT '',
  shopify_product_type TEXT DEFAULT '',
  quantity        INTEGER DEFAULT 1,
  platform_data   JSONB DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_master_products_sku ON master_products(sku);
CREATE INDEX idx_master_products_ebay_item ON master_products(ebay_item_id) WHERE ebay_item_id != '';
CREATE INDEX idx_master_products_margin ON master_products(margin_pct);
CREATE INDEX idx_master_products_updated ON master_products(updated_at);

CREATE TRIGGER trg_master_products_updated
  BEFORE UPDATE ON master_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 2. ebay_products (eBay Products A-N 14열)
-- =============================================
CREATE TABLE ebay_products (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  title           TEXT DEFAULT '',
  item_id         TEXT UNIQUE,
  price_usd       NUMERIC(10,2) DEFAULT 0,
  shipping_usd    NUMERIC(10,2) DEFAULT 0,
  sales_count     INTEGER DEFAULT 0,
  stock           INTEGER DEFAULT 0,
  status          TEXT DEFAULT '',
  fee_rate        NUMERIC(5,2) DEFAULT 13,
  image_url       TEXT DEFAULT '',

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ebay_sku ON ebay_products(sku);
CREATE INDEX idx_ebay_item_id ON ebay_products(item_id);

CREATE TRIGGER trg_ebay_products_updated
  BEFORE UPDATE ON ebay_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 3. shopify_products (Shopify A-K 11열)
-- =============================================
CREATE TABLE shopify_products (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  title           TEXT DEFAULT '',
  purchase_price_krw INTEGER DEFAULT 0,
  price_usd       NUMERIC(10,2) DEFAULT 0,
  exchange_rate   NUMERIC(10,2) DEFAULT 1400,
  fee_rate        NUMERIC(5,2) DEFAULT 15,
  shipping_krw    INTEGER DEFAULT 0,
  profit_krw      INTEGER DEFAULT 0,
  margin_pct      NUMERIC(6,2) DEFAULT 0,
  status          TEXT DEFAULT '',
  platform        TEXT DEFAULT 'Shopify',

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_shopify_sku ON shopify_products(sku);

CREATE TRIGGER trg_shopify_products_updated
  BEFORE UPDATE ON shopify_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 4. naver_products (Naver Products A-J 10열)
-- =============================================
CREATE TABLE naver_products (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_no      TEXT UNIQUE,
  sku             TEXT DEFAULT '',
  title           TEXT DEFAULT '',
  price_krw       INTEGER DEFAULT 0,
  stock           INTEGER DEFAULT 0,
  status          TEXT DEFAULT '',
  category_id     TEXT DEFAULT '',
  platform        TEXT DEFAULT 'Naver',
  fee_rate        NUMERIC(5,2) DEFAULT 5.5,
  last_synced     TIMESTAMPTZ DEFAULT now(),
  image_url       TEXT DEFAULT '',

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_naver_product_no ON naver_products(product_no);
CREATE INDEX idx_naver_sku ON naver_products(sku);

CREATE TRIGGER trg_naver_products_updated
  BEFORE UPDATE ON naver_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 5. alibaba_products (Alibaba Products A-J)
-- =============================================
CREATE TABLE alibaba_products (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT DEFAULT '',
  title           TEXT DEFAULT '',
  image_url       TEXT DEFAULT '',
  raw_data        JSONB DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_alibaba_sku ON alibaba_products(sku);

CREATE TRIGGER trg_alibaba_products_updated
  BEFORE UPDATE ON alibaba_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 6. orders (주문 배송 A-T 20열)
-- =============================================
CREATE TABLE orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_date      DATE,
  platform        TEXT NOT NULL DEFAULT '',
  order_no        TEXT NOT NULL UNIQUE,
  sku             TEXT DEFAULT '',
  title           TEXT DEFAULT '',
  quantity        INTEGER DEFAULT 1,
  payment_amount  NUMERIC(12,2) DEFAULT 0,
  currency        TEXT DEFAULT 'USD',
  buyer_name      TEXT DEFAULT '',
  country         TEXT DEFAULT '',
  carrier         TEXT DEFAULT '',
  tracking_no     TEXT DEFAULT '',
  status          TEXT DEFAULT 'NEW',

  -- Shipping address
  street          TEXT DEFAULT '',
  city            TEXT DEFAULT '',
  province        TEXT DEFAULT '',
  zip_code        TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  country_code    TEXT DEFAULT '',
  email           TEXT DEFAULT '',

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_orders_order_no ON orders(order_no);
CREATE INDEX idx_orders_platform ON orders(platform);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_date ON orders(order_date DESC);
CREATE INDEX idx_orders_sku ON orders(sku);

CREATE TRIGGER trg_orders_updated
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 7. b2b_buyers (B2B Buyers 시트)
-- =============================================
CREATE TABLE b2b_buyers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  buyer_id        TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  contact         TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  whatsapp        TEXT DEFAULT '',
  phone           TEXT DEFAULT '',
  address         TEXT DEFAULT '',
  country         TEXT DEFAULT '',
  currency        TEXT DEFAULT 'USD',
  payment_terms   TEXT DEFAULT 'Net 30',
  notes           TEXT DEFAULT '',
  total_orders    INTEGER DEFAULT 0,
  total_revenue   NUMERIC(14,2) DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_b2b_buyers_buyer_id ON b2b_buyers(buyer_id);

CREATE TRIGGER trg_b2b_buyers_updated
  BEFORE UPDATE ON b2b_buyers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 8. b2b_invoices (B2B Invoices 시트)
-- =============================================
CREATE TABLE b2b_invoices (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_no      TEXT NOT NULL UNIQUE,
  buyer_id        TEXT NOT NULL REFERENCES b2b_buyers(buyer_id),
  buyer_name      TEXT DEFAULT '',
  invoice_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date        DATE,
  items           JSONB DEFAULT '[]'::jsonb,
  subtotal        NUMERIC(14,2) DEFAULT 0,
  tax             NUMERIC(14,2) DEFAULT 0,
  shipping        NUMERIC(14,2) DEFAULT 0,
  total           NUMERIC(14,2) DEFAULT 0,
  currency        TEXT DEFAULT 'USD',
  status          TEXT DEFAULT 'CREATED',
  drive_file_id   TEXT DEFAULT '',
  drive_url       TEXT DEFAULT '',
  sent_via        TEXT DEFAULT '',
  sent_at         TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_b2b_invoices_no ON b2b_invoices(invoice_no);
CREATE INDEX idx_b2b_invoices_buyer ON b2b_invoices(buyer_id);
CREATE INDEX idx_b2b_invoices_status ON b2b_invoices(status);

CREATE TRIGGER trg_b2b_invoices_updated
  BEFORE UPDATE ON b2b_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 9. sku_scores (sku-scores.json)
-- =============================================
CREATE TABLE sku_scores (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,
  title           TEXT DEFAULT '',

  -- Raw inputs
  selling_price   NUMERIC(10,2) DEFAULT 0,
  purchase_price  INTEGER DEFAULT 0,
  platform_fees   TEXT DEFAULT '',
  net_margin_pct  NUMERIC(6,2) DEFAULT 0,
  sales_30d       INTEGER DEFAULT 0,
  competitor_count INTEGER DEFAULT 0,
  bundle_item_count INTEGER DEFAULT 0,
  price_fluctuation_pct NUMERIC(6,2) DEFAULT 0,

  -- Component scores (JSONB for flexibility)
  score_net_margin      JSONB DEFAULT '{}'::jsonb,
  score_turnover        JSONB DEFAULT '{}'::jsonb,
  score_competition     JSONB DEFAULT '{}'::jsonb,
  score_shipping_eff    JSONB DEFAULT '{}'::jsonb,
  score_price_stability JSONB DEFAULT '{}'::jsonb,

  -- Totals
  total_score       INTEGER DEFAULT 0,
  max_possible      INTEGER DEFAULT 100,
  normalized_score  NUMERIC(5,1) DEFAULT 0,
  classification    CHAR(1) DEFAULT 'D',

  -- Purchase decision
  purchase_allowed  BOOLEAN DEFAULT false,
  purchase_reason   TEXT DEFAULT '',

  -- Auto-retirement & manual overrides
  auto_retirement   JSONB DEFAULT '{}'::jsonb,
  manual_overrides  JSONB DEFAULT '{}'::jsonb,

  calculated_at     TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sku_scores_sku ON sku_scores(sku);
CREATE INDEX idx_sku_scores_class ON sku_scores(classification);
CREATE INDEX idx_sku_scores_norm ON sku_scores(normalized_score DESC);

CREATE TRIGGER trg_sku_scores_updated
  BEFORE UPDATE ON sku_scores
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =============================================
-- 10. sku_score_history (scores.history[])
-- =============================================
CREATE TABLE sku_score_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  date            DATE NOT NULL,
  total_score     INTEGER DEFAULT 0,
  normalized_score NUMERIC(5,1) DEFAULT 0,
  classification  CHAR(1) DEFAULT 'D',

  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(sku, date)
);

CREATE INDEX idx_score_history_sku_date ON sku_score_history(sku, date DESC);


-- =============================================
-- 11. price_history (price-history.json)
-- =============================================
CREATE TABLE price_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  date            DATE NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  platform        TEXT DEFAULT 'ebay',

  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(sku, date, platform)
);

CREATE INDEX idx_price_history_sku_date ON price_history(sku, date DESC);
CREATE INDEX idx_price_history_platform ON price_history(sku, platform);


-- =============================================
-- 12. sync_history (인메모리 → 영구 저장)
-- =============================================
CREATE TABLE sync_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform        TEXT NOT NULL,
  action          TEXT NOT NULL DEFAULT 'sync',
  status          TEXT DEFAULT 'success',
  items_synced    INTEGER DEFAULT 0,
  error_message   TEXT DEFAULT '',
  details         JSONB DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sync_history_platform ON sync_history(platform);
CREATE INDEX idx_sync_history_created ON sync_history(created_at DESC);


-- =============================================
-- RLS (서비스 역할 전체 접근 허용)
-- =============================================
ALTER TABLE master_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE ebay_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE naver_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE alibaba_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_buyers ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_history ENABLE ROW LEVEL SECURITY;

-- Service role full access policies
CREATE POLICY "service_all" ON master_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON ebay_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON shopify_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON naver_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON alibaba_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON b2b_buyers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON b2b_invoices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sku_scores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sku_score_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON price_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sync_history FOR ALL USING (true) WITH CHECK (true);
