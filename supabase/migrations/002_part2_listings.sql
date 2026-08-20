ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS fee_rate NUMERIC(5,2) DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(10,2) DEFAULT 1400;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS sales_count INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS sku TEXT DEFAULT '';
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS purchase_price_krw INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS shipping_krw INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS profit_krw INTEGER DEFAULT 0;
ALTER TABLE platform_listings ADD COLUMN IF NOT EXISTS margin_pct NUMERIC(6,2) DEFAULT 0;

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
