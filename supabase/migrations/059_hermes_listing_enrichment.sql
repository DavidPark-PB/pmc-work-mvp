-- Migration 059: Hermes Listing Data Enrichment
-- Purpose: read-only eBay listing detail cache for Listing Intelligence scoring.
-- Safety: no marketplace write / repricing workflow is introduced here.

CREATE TABLE IF NOT EXISTS listing_details (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform               TEXT NOT NULL DEFAULT 'ebay',
  listing_type           TEXT NOT NULL DEFAULT 'our' CHECK (listing_type IN ('our','competitor')),
  sku                    TEXT,
  item_id                TEXT NOT NULL,
  title                  TEXT DEFAULT '',
  category_id            TEXT DEFAULT '',
  category_name          TEXT DEFAULT '',
  condition_id           TEXT DEFAULT '',
  condition              TEXT DEFAULT '',
  sold_quantity          INTEGER,
  watch_count            INTEGER,
  view_count             INTEGER,
  image_count            INTEGER DEFAULT 0,
  handling_time          INTEGER,
  estimated_delivery     TEXT DEFAULT '',
  promotion_status       TEXT DEFAULT '',
  listing_status         TEXT DEFAULT '',
  source_api             TEXT DEFAULT 'trading_get_item',
  last_enriched_at       TIMESTAMPTZ DEFAULT now(),
  raw_data               JSONB DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, listing_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_details_sku ON listing_details(sku);
CREATE INDEX IF NOT EXISTS idx_listing_details_item ON listing_details(item_id);
CREATE INDEX IF NOT EXISTS idx_listing_details_enriched ON listing_details(last_enriched_at DESC);

CREATE TABLE IF NOT EXISTS listing_images (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform               TEXT NOT NULL DEFAULT 'ebay',
  listing_type           TEXT NOT NULL DEFAULT 'our' CHECK (listing_type IN ('our','competitor')),
  item_id                TEXT NOT NULL,
  image_url              TEXT NOT NULL,
  position               INTEGER DEFAULT 0,
  width                  INTEGER,
  height                 INTEGER,
  source                 TEXT DEFAULT 'trading_get_item',
  created_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, listing_type, item_id, image_url)
);

CREATE INDEX IF NOT EXISTS idx_listing_images_item ON listing_images(item_id);

CREATE TABLE IF NOT EXISTS listing_item_specifics (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform               TEXT NOT NULL DEFAULT 'ebay',
  listing_type           TEXT NOT NULL DEFAULT 'our' CHECK (listing_type IN ('our','competitor')),
  item_id                TEXT NOT NULL,
  name                   TEXT NOT NULL,
  value                  TEXT DEFAULT '',
  source                 TEXT DEFAULT 'trading_get_item',
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, listing_type, item_id, name)
);

CREATE INDEX IF NOT EXISTS idx_listing_specifics_item ON listing_item_specifics(item_id);
CREATE INDEX IF NOT EXISTS idx_listing_specifics_name ON listing_item_specifics(name);

CREATE TABLE IF NOT EXISTS listing_policies (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform               TEXT NOT NULL DEFAULT 'ebay',
  listing_type           TEXT NOT NULL DEFAULT 'our' CHECK (listing_type IN ('our','competitor')),
  item_id                TEXT NOT NULL,
  return_policy          JSONB DEFAULT '{}'::jsonb,
  shipping_policy        JSONB DEFAULT '{}'::jsonb,
  payment_policy         JSONB DEFAULT '{}'::jsonb,
  handling_time          INTEGER,
  estimated_delivery     TEXT DEFAULT '',
  source                 TEXT DEFAULT 'trading_get_item',
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, listing_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_policies_item ON listing_policies(item_id);

CREATE TABLE IF NOT EXISTS listing_enrichment_errors (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform               TEXT NOT NULL DEFAULT 'ebay',
  listing_type           TEXT NOT NULL DEFAULT 'our',
  sku                    TEXT,
  item_id                TEXT,
  error_message          TEXT NOT NULL,
  source_api             TEXT DEFAULT 'trading_get_item',
  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_enrichment_errors_item_time ON listing_enrichment_errors(item_id, created_at DESC);

-- updated_at trigger uses the existing helper from earlier migrations when present.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS trg_listing_details_updated ON listing_details;
    CREATE TRIGGER trg_listing_details_updated
      BEFORE UPDATE ON listing_details
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS trg_listing_specifics_updated ON listing_item_specifics;
    CREATE TRIGGER trg_listing_specifics_updated
      BEFORE UPDATE ON listing_item_specifics
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS trg_listing_policies_updated ON listing_policies;
    CREATE TRIGGER trg_listing_policies_updated
      BEFORE UPDATE ON listing_policies
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

COMMENT ON TABLE listing_details IS 'Hermes read-only eBay listing detail cache for listing intelligence';
COMMENT ON TABLE listing_images IS 'Hermes read-only listing image URLs and counts';
COMMENT ON TABLE listing_item_specifics IS 'Hermes read-only eBay item specifics cache';
COMMENT ON TABLE listing_policies IS 'Hermes read-only listing shipping/return/payment policy cache';
