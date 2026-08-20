-- products: partial index → proper UNIQUE constraint
DROP INDEX IF EXISTS idx_products_sku_unique;
UPDATE products SET sku = 'UNKNOWN-' || id WHERE sku IS NULL OR sku = '';
ALTER TABLE products ALTER COLUMN sku SET NOT NULL;
ALTER TABLE products ADD CONSTRAINT products_sku_unique UNIQUE (sku);

-- platform_listings: partial index → proper composite UNIQUE constraint
DROP INDEX IF EXISTS idx_pl_platform_item_unique;
UPDATE platform_listings SET platform_item_id = 'UNKNOWN-' || id
  WHERE platform_item_id IS NULL OR platform_item_id = '';
ALTER TABLE platform_listings ALTER COLUMN platform_item_id SET NOT NULL;
ALTER TABLE platform_listings ADD CONSTRAINT pl_platform_item_unique
  UNIQUE (platform, platform_item_id);
