-- =============================================
-- 005_dashboard_improvements.sql
-- Dashboard Operations Layer Extension
-- Safe to run multiple times (idempotent)
-- Does NOT alter automation-owned columns
-- =============================================

-- Enable pg_trgm extension for partial text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================
-- 1. PERFORMANCE INDEXES
-- =============================================

-- products indexes
CREATE INDEX IF NOT EXISTS idx_products_sku_btree
  ON products(sku);

CREATE INDEX IF NOT EXISTS idx_products_status_btree
  ON products(status);

CREATE INDEX IF NOT EXISTS idx_products_created_desc
  ON products(created_at DESC);

-- Trigram indexes for partial search (requires pg_trgm)
CREATE INDEX IF NOT EXISTS idx_products_title_trgm
  ON products USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
  ON products USING gin (sku gin_trgm_ops);

-- platform_listings indexes
CREATE INDEX IF NOT EXISTS idx_pl_product_id
  ON platform_listings(product_id);

CREATE INDEX IF NOT EXISTS idx_pl_status_platform
  ON platform_listings(platform, status);

-- orders: add index on sku for JOIN queries
CREATE INDEX IF NOT EXISTS idx_orders_sku_btree
  ON orders(sku);

-- orders.product_id: column may not exist yet (orders uses sku FK)
-- We do NOT add product_id FK to orders to preserve automation compatibility.
-- Use orders.sku JOIN products.sku instead.

-- competitor_prices
CREATE INDEX IF NOT EXISTS idx_cp_sku_platform
  ON competitor_prices(sku, platform);

-- =============================================
-- 2. WORKFLOW STATUS (separate from automation's status column)
-- automation uses products.status = 'active'|'soldout'|'discontinued'
-- dashboard uses workflow_status = 'draft'|'ready'|'listed'|'soldout'|'archived'
-- =============================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(20) DEFAULT 'draft';

-- Add check constraint if not already exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_products_workflow_status'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_workflow_status
      CHECK (workflow_status IN ('draft','ready','listed','soldout','archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_workflow_status
  ON products(workflow_status);

-- Backfill from existing automation status
UPDATE products SET workflow_status = CASE
  WHEN status = 'active'       THEN 'listed'
  WHEN status = 'soldout'      THEN 'soldout'
  WHEN status = 'discontinued' THEN 'archived'
  ELSE 'draft'
END
WHERE workflow_status = 'draft' AND status IS NOT NULL AND status != '';

-- =============================================
-- 3. INVENTORY TABLE
-- Centralized stock management, separate from products.stock
-- products.stock is kept for automation backward compat
-- =============================================

CREATE TABLE IF NOT EXISTS inventory (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 0,
  reserved    INTEGER NOT NULL DEFAULT 0,
  location    VARCHAR(100) NOT NULL DEFAULT 'default',
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, location)
);

CREATE INDEX IF NOT EXISTS idx_inventory_product_id
  ON inventory(product_id);

CREATE INDEX IF NOT EXISTS idx_inventory_quantity
  ON inventory(quantity);

CREATE INDEX IF NOT EXISTS idx_inventory_location
  ON inventory(location);

-- Backfill: migrate products.stock → inventory (skip if already done)
INSERT INTO inventory (product_id, quantity, location)
SELECT id, COALESCE(stock, 0), 'default'
FROM products
WHERE stock IS NOT NULL AND stock > 0
ON CONFLICT (product_id, location) DO NOTHING;

-- updated_at trigger for inventory
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_inventory_updated') THEN
    CREATE TRIGGER trg_inventory_updated
      BEFORE UPDATE ON inventory
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- =============================================
-- 4. AUTOMATION LOGS TABLE
-- Separate from sync_history (which tracks sync jobs)
-- automation_logs tracks per-product job events
-- =============================================

CREATE TABLE IF NOT EXISTS automation_logs (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_type    VARCHAR(50) NOT NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku         VARCHAR(100) DEFAULT '',
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','running','success','failed')),
  message     TEXT DEFAULT '',
  details     JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alog_created_desc
  ON automation_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alog_job_type
  ON automation_logs(job_type);

CREATE INDEX IF NOT EXISTS idx_alog_product_id
  ON automation_logs(product_id);

CREATE INDEX IF NOT EXISTS idx_alog_status
  ON automation_logs(status);

CREATE INDEX IF NOT EXISTS idx_alog_sku
  ON automation_logs(sku);

-- =============================================
-- 5. RLS POLICIES
-- =============================================

ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'service_all' AND tablename = 'inventory'
  ) THEN
    CREATE POLICY "service_all" ON inventory FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'service_all' AND tablename = 'automation_logs'
  ) THEN
    CREATE POLICY "service_all" ON automation_logs FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- =============================================
-- 6. HELPER VIEW: product_listing_matrix
-- Aggregates platform_listings per product as columns
-- Used by dashboard Listings Matrix page
-- =============================================

CREATE OR REPLACE VIEW product_listing_matrix AS
SELECT
  p.id,
  p.sku,
  p.title,
  p.workflow_status,
  p.cost_price,
  p.price_usd,
  p.margin_pct,
  p.created_at,
  MAX(CASE WHEN pl.platform = 'ebay'    THEN pl.status END) AS ebay_status,
  MAX(CASE WHEN pl.platform = 'shopify' THEN pl.status END) AS shopify_status,
  MAX(CASE WHEN pl.platform = 'naver'   THEN pl.status END) AS naver_status,
  MAX(CASE WHEN pl.platform = 'coupang' THEN pl.status END) AS coupang_status,
  MAX(CASE WHEN pl.platform = 'qoo10'   THEN pl.status END) AS qoo10_status,
  MAX(CASE WHEN pl.platform = 'shopee'  THEN pl.status END) AS shopee_status,
  MAX(CASE WHEN pl.platform = 'alibaba' THEN pl.status END) AS alibaba_status,
  COALESCE(inv.quantity, p.stock, 0) AS inventory_quantity
FROM products p
LEFT JOIN platform_listings pl ON pl.product_id = p.id
LEFT JOIN inventory inv ON inv.product_id = p.id AND inv.location = 'default'
GROUP BY p.id, p.sku, p.title, p.workflow_status, p.cost_price,
         p.price_usd, p.margin_pct, p.created_at, inv.quantity, p.stock;
