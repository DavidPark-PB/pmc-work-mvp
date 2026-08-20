CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_products_updated') THEN
    CREATE TRIGGER trg_products_updated
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;
