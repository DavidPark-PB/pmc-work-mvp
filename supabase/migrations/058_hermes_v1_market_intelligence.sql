-- Migration 058: Hermes v1 Market Intelligence data model
-- Purpose: explicit v1 tables for monitoring, analysis, alerts, and daily reports.
-- Safety: no marketplace write / repricing table is introduced here.
-- Depends on migration 057 for product_matches and competitor_listings backfill.
-- Existing table names checked in migrations 001-057: the five v1 tables below are new.

-- 1) my_listings — snapshot of our eBay listings used for market comparisons
CREATE TABLE IF NOT EXISTS my_listings (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform            TEXT NOT NULL DEFAULT 'ebay',
  sku                 TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  title               TEXT DEFAULT '',
  price               NUMERIC(12,2) DEFAULT 0,
  shipping            NUMERIC(12,2) DEFAULT 0,
  total_price         NUMERIC(12,2) GENERATED ALWAYS AS (price + shipping) STORED,
  quantity            INTEGER DEFAULT 0,
  status              TEXT DEFAULT 'active',
  last_synced_at      TIMESTAMPTZ DEFAULT now(),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, item_id)
);

CREATE INDEX IF NOT EXISTS idx_my_listings_sku ON my_listings(sku);
CREATE INDEX IF NOT EXISTS idx_my_listings_platform_status ON my_listings(platform, status);

-- 2) sku_mappings — approved/pending links between our SKU and competitor listings
CREATE TABLE IF NOT EXISTS sku_mappings (
  id                       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  our_sku                  TEXT NOT NULL,
  our_item_id              TEXT,
  competitor_seller_id     TEXT NOT NULL,
  competitor_item_id       TEXT NOT NULL,
  competitor_title         TEXT DEFAULT '',
  auto_change_allowed      BOOLEAN NOT NULL DEFAULT false,
  target_margin_pct        NUMERIC(7,2) DEFAULT 30,
  minimum_margin_pct       NUMERIC(7,2) DEFAULT 15,
  match_confidence         NUMERIC(5,3) DEFAULT 0,
  match_method             TEXT DEFAULT 'manual',
  status                   TEXT DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected','ignored')),
  notes                    TEXT DEFAULT '',
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now(),
  UNIQUE (our_sku, competitor_item_id)
);

CREATE INDEX IF NOT EXISTS idx_sku_mappings_sku ON sku_mappings(our_sku);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_comp ON sku_mappings(competitor_item_id);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_status ON sku_mappings(status);

-- 3) price_snapshots — time-series snapshots for our listings and competitors
CREATE TABLE IF NOT EXISTS price_snapshots (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_type      TEXT NOT NULL CHECK (snapshot_type IN ('our','competitor')),
  platform           TEXT NOT NULL DEFAULT 'ebay',
  sku                TEXT,
  seller_id          TEXT,
  item_id            TEXT NOT NULL,
  title              TEXT DEFAULT '',
  price              NUMERIC(12,2) DEFAULT 0,
  shipping           NUMERIC(12,2) DEFAULT 0,
  total_price        NUMERIC(12,2) GENERATED ALWAYS AS (price + shipping) STORED,
  quantity           INTEGER,
  status             TEXT DEFAULT 'active',
  promotion          TEXT DEFAULT '',
  estimated_delivery TEXT DEFAULT '',
  seller_feedback    TEXT DEFAULT '',
  raw_data           JSONB DEFAULT '{}'::jsonb,
  captured_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_item_time ON price_snapshots(item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_snapshots_sku_time ON price_snapshots(sku, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_snapshots_type_time ON price_snapshots(snapshot_type, captured_at DESC);

-- 4) market_alerts — v1 market intelligence alerts only; no price-write workflow
CREATE TABLE IF NOT EXISTS market_alerts (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_key          TEXT UNIQUE,
  alert_type         TEXT NOT NULL,
  severity           TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','watch','warning','critical')),
  platform           TEXT NOT NULL DEFAULT 'ebay',
  sku                TEXT,
  our_item_id        TEXT,
  competitor_seller_id TEXT,
  competitor_item_id TEXT,
  title              TEXT DEFAULT '',
  message            TEXT NOT NULL,
  recommendation     TEXT DEFAULT '',
  old_price          NUMERIC(12,2),
  new_price          NUMERIC(12,2),
  old_shipping       NUMERIC(12,2),
  new_shipping       NUMERIC(12,2),
  old_status         TEXT,
  new_status         TEXT,
  margin_pct         NUMERIC(7,2),
  data               JSONB DEFAULT '{}'::jsonb,
  sent_to_telegram   BOOLEAN DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_alerts_created ON market_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_alerts_type ON market_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_market_alerts_sku ON market_alerts(sku);

-- 5) daily_reports — generated CEO/market reports
CREATE TABLE IF NOT EXISTS daily_reports (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  report_date    DATE NOT NULL,
  report_type    TEXT NOT NULL DEFAULT 'ebay_market_intelligence',
  title          TEXT NOT NULL,
  summary        TEXT DEFAULT '',
  markdown       TEXT NOT NULL,
  data           JSONB DEFAULT '{}'::jsonb,
  sent_to_telegram BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (report_date, report_type)
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(report_date DESC);

-- Backfill v1 mapping table from existing product_matches when available.
INSERT INTO sku_mappings (
  our_sku,
  our_item_id,
  competitor_seller_id,
  competitor_item_id,
  competitor_title,
  auto_change_allowed,
  match_confidence,
  match_method,
  status,
  notes,
  created_at,
  updated_at
)
SELECT
  pm.our_sku,
  pm.our_item_id,
  pm.seller_id,
  pm.competitor_item_id,
  COALESCE(cl.title, ''),
  false,
  COALESCE(pm.confidence, 0),
  COALESCE(pm.method, 'manual'),
  pm.status,
  COALESCE(pm.ai_reason, ''),
  COALESCE(pm.created_at, now()),
  COALESCE(pm.updated_at, now())
FROM product_matches pm
LEFT JOIN competitor_listings cl ON cl.ebay_item_id = pm.competitor_item_id
WHERE pm.our_sku IS NOT NULL
  AND pm.competitor_item_id IS NOT NULL
ON CONFLICT (our_sku, competitor_item_id) DO NOTHING;

COMMENT ON TABLE my_listings IS 'Hermes v1 snapshot of our eBay listings for market intelligence comparisons';
COMMENT ON TABLE sku_mappings IS 'Hermes v1 SKU-to-competitor mapping; auto_change_allowed is false by default';
COMMENT ON TABLE price_snapshots IS 'Hermes v1 historical price/status snapshots for our and competitor listings';
COMMENT ON TABLE market_alerts IS 'Hermes v1 monitoring/analysis alerts; recommendation-only, no approval workflow';
COMMENT ON TABLE daily_reports IS 'Hermes v1 generated market intelligence reports';

-- Rollback note (manual, if this migration must be reverted before production use):
--   DROP TABLE IF EXISTS daily_reports;
--   DROP TABLE IF EXISTS market_alerts;
--   DROP TABLE IF EXISTS price_snapshots;
--   DROP TABLE IF EXISTS sku_mappings;
--   DROP TABLE IF EXISTS my_listings;
-- These tables are additive v1 reporting tables only. Dropping them does not touch
-- existing 057 tables (competitor_sellers, competitor_listings, product_matches,
-- competitor_price_history) or any marketplace listing data.
