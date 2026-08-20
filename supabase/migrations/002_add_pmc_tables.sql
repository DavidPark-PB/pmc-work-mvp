-- =============================================
-- PMC Work MVP: Extend Existing Schema + Add PMC Tables
-- Runs AFTER the existing 10 tables (products, platform_listings, etc.)
-- =============================================

-- Reusable updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';


-- =============================================
-- 1. Extend products table for PMC Dashboard
--    (maps to 최종 Dashboard A-S 19열)
-- =============================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_krw INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fee_krw INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_krw INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_cost INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_usd NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS profit_krw INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin_pct NUMERIC(6,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sales_count INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_item_id TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_status TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_status TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier TEXT DEFAULT '';

-- Unique index on SKU for upsert (skip nulls and empties)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_products_sku_unique') THEN
    CREATE UNIQUE INDEX idx_products_sku_unique ON products(sku) WHERE sku IS NOT NULL AND sku != '';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_products_ebay_item ON products(ebay_item_id) WHERE ebay_item_id != '';
CREATE INDEX IF NOT EXISTS idx_products_margin ON products(margin_pct);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at);

-- updated_at trigger (skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_products_updated') THEN
    CREATE TRIGGER trg_products_updated
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;


-- =============================================
-- 2. Extend platform_listings for PMC data
-- =============================================
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS fee_rate NUMERIC(5,2) DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(10,2) DEFAULT 1400;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS sales_count INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS sku TEXT DEFAULT '';
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS purchase_price_krw INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS shipping_krw INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS profit_krw INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS margin_pct NUMERIC(6,2) DEFAULT 0;

-- Unique index for upsert by platform + item_id
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pl_platform_item_unique') THEN
    CREATE UNIQUE INDEX idx_pl_platform_item_unique
      ON platform_listings(platform, platform_item_id)
      WHERE platform_item_id IS NOT NULL AND platform_item_id != '';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_pl_platform ON platform_listings(platform);
CREATE INDEX IF NOT EXISTS idx_pl_sku ON platform_listings(sku);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_pl_updated') THEN
    CREATE TRIGGER trg_pl_updated
      BEFORE UPDATE ON platform_listings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;


-- =============================================
-- 3. orders (주문 배송 A-T 20열)
-- =============================================
CREATE TABLE IF NOT EXISTS orders (
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

CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_platform ON orders(platform);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders(sku);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_orders_updated') THEN
    CREATE TRIGGER trg_orders_updated
      BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;


-- =============================================
-- 4. b2b_buyers
-- =============================================
CREATE TABLE IF NOT EXISTS b2b_buyers (
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

CREATE INDEX IF NOT EXISTS idx_b2b_buyers_buyer_id ON b2b_buyers(buyer_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_b2b_buyers_updated') THEN
    CREATE TRIGGER trg_b2b_buyers_updated
      BEFORE UPDATE ON b2b_buyers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;


-- =============================================
-- 5. b2b_invoices
-- =============================================
CREATE TABLE IF NOT EXISTS b2b_invoices (
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

CREATE INDEX IF NOT EXISTS idx_b2b_invoices_no ON b2b_invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_buyer ON b2b_invoices(buyer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_status ON b2b_invoices(status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_b2b_invoices_updated') THEN
    CREATE TRIGGER trg_b2b_invoices_updated
      BEFORE UPDATE ON b2b_invoices
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;


-- =============================================
-- 6. sku_scores (sku-scores.json)
-- =============================================
CREATE TABLE IF NOT EXISTS sku_scores (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,
  title           TEXT DEFAULT '',
  selling_price   NUMERIC(10,2) DEFAULT 0,
  purchase_price  INTEGER DEFAULT 0,
  platform_fees   TEXT DEFAULT '',
  net_margin_pct  NUMERIC(6,2) DEFAULT 0,
  sales_30d       INTEGER DEFAULT 0,
  competitor_count INTEGER DEFAULT 0,
  bundle_item_count INTEGER DEFAULT 0,
  price_fluctuation_pct NUMERIC(6,2) DEFAULT 0,
  score_net_margin      JSONB DEFAULT '{}'::jsonb,
  score_turnover        JSONB DEFAULT '{}'::jsonb,
  score_competition     JSONB DEFAULT '{}'::jsonb,
  score_shipping_eff    JSONB DEFAULT '{}'::jsonb,
  score_price_stability JSONB DEFAULT '{}'::jsonb,
  total_score       INTEGER DEFAULT 0,
  max_possible      INTEGER DEFAULT 100,
  normalized_score  NUMERIC(5,1) DEFAULT 0,
  classification    CHAR(1) DEFAULT 'D',
  purchase_allowed  BOOLEAN DEFAULT false,
  purchase_reason   TEXT DEFAULT '',
  auto_retirement   JSONB DEFAULT '{}'::jsonb,
  manual_overrides  JSONB DEFAULT '{}'::jsonb,
  calculated_at     TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_scores_sku ON sku_scores(sku);
CREATE INDEX IF NOT EXISTS idx_sku_scores_class ON sku_scores(classification);
CREATE INDEX IF NOT EXISTS idx_sku_scores_norm ON sku_scores(normalized_score DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sku_scores_updated') THEN
    CREATE TRIGGER trg_sku_scores_updated
      BEFORE UPDATE ON sku_scores
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;


-- =============================================
-- 7. sku_score_history
-- =============================================
CREATE TABLE IF NOT EXISTS sku_score_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  date            DATE NOT NULL,
  total_score     INTEGER DEFAULT 0,
  normalized_score NUMERIC(5,1) DEFAULT 0,
  classification  CHAR(1) DEFAULT 'D',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(sku, date)
);

CREATE INDEX IF NOT EXISTS idx_score_history_sku_date ON sku_score_history(sku, date DESC);


-- =============================================
-- 8. price_history
-- =============================================
CREATE TABLE IF NOT EXISTS price_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  date            DATE NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  platform        TEXT DEFAULT 'ebay',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(sku, date, platform)
);

CREATE INDEX IF NOT EXISTS idx_price_history_sku_date ON price_history(sku, date DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_platform ON price_history(sku, platform);


-- =============================================
-- 9. sync_history
-- =============================================
CREATE TABLE IF NOT EXISTS sync_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform        TEXT NOT NULL,
  action          TEXT NOT NULL DEFAULT 'sync',
  status          TEXT DEFAULT 'success',
  items_synced    INTEGER DEFAULT 0,
  error_message   TEXT DEFAULT '',
  details         JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_history_platform ON sync_history(platform);
CREATE INDEX IF NOT EXISTS idx_sync_history_created ON sync_history(created_at DESC);


-- =============================================
-- RLS policies for new tables
-- =============================================
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_buyers ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_history ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "service_all" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON b2b_buyers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON b2b_invoices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sku_scores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sku_score_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON price_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON sync_history FOR ALL USING (true) WITH CHECK (true);
