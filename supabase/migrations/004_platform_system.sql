-- 004_platform_system.sql
-- Product Listing Master: platforms registry, margin settings,
-- translations, product_images, platform_mapping, platform_export_status,
-- competitor_prices, repricing_rules, price_change_log

-- ===== 1. platforms (platform registry) =====
CREATE TABLE IF NOT EXISTS platforms (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  color           TEXT DEFAULT '#666',
  api_module      TEXT DEFAULT '',
  market_type     TEXT DEFAULT 'global',
  fee_rate        NUMERIC(5,3) DEFAULT 0,
  currency        TEXT DEFAULT 'USD',
  is_active       BOOLEAN DEFAULT true,
  sort_order      INTEGER DEFAULT 0,
  config          JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

INSERT INTO platforms (key, name, display_name, color, api_module, market_type, fee_rate, currency, is_active, sort_order, config) VALUES
  ('naver',   'Naver',   '네이버',   '#03c75a', 'naverAPI',   'domestic', 0.055, 'KRW',   true,  1, '{"auth_type":"bcrypt_signature","title_max_length":100,"domestic_shipping_krw":3000}'),
  ('coupang', 'Coupang', '쿠팡',     '#e62e2e', 'coupangAPI', 'domestic', 0.108, 'KRW',   false, 2, '{"auth_type":"hmac_sha256"}'),
  ('ebay',    'eBay',    'eBay',     '#1565c0', 'ebayAPI',    'global',   0.180, 'USD',   true,  3, '{"auth_type":"oauth","title_max_length":80,"condition_map":{"new":"1000","used":"3000","refurbished":"2500"}}'),
  ('shopify', 'Shopify', 'Shopify',  '#96bf48', 'shopifyAPI', 'global',   0.033, 'USD',   true,  4, '{"auth_type":"admin_token","vendor":"PMC"}'),
  ('qoo10',   'Qoo10',   'Qoo10',   '#e53935', 'qoo10API',   'global',   0.120, 'JPY',   true,  5, '{"auth_type":"api_key"}'),
  ('shopee',  'Shopee',  'Shopee',   '#ee4d2d', 'shopeeAPI',  'global',   0.150, 'LOCAL', true,  6, '{"auth_type":"hmac"}'),
  ('alibaba', 'Alibaba', 'Alibaba',  '#ff6a00', 'alibabaAPI', 'global',   0.080, 'USD',   true,  7, '{"auth_type":"iop"}')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_platforms_active ON platforms(is_active) WHERE is_active = true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_platforms_updated') THEN
    CREATE TRIGGER trg_platforms_updated BEFORE UPDATE ON platforms
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ===== 2. margin_settings (exchange rates, margins, shipping, tax) =====
CREATE TABLE IF NOT EXISTS margin_settings (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  setting_key     TEXT NOT NULL UNIQUE,
  setting_value   NUMERIC(12,4) NOT NULL,
  label           TEXT DEFAULT '',
  category        TEXT DEFAULT 'general',
  updated_at      TIMESTAMPTZ DEFAULT now()
);

INSERT INTO margin_settings (setting_key, setting_value, label, category) VALUES
  ('exchange_rate_usd',        1400,   'USD/KRW 환율',        'exchange_rate'),
  ('exchange_rate_jpy',        1000,   'JPY/KRW 환율',        'exchange_rate'),
  ('exchange_rate_local',      1000,   'LOCAL/KRW 환율',      'exchange_rate'),
  ('default_margin_pct',       30,     '기본 목표 마진(%)',    'margin'),
  ('tax_rate',                 0.15,   '세율',                'tax'),
  ('default_shipping_usd',    3.9,    '기본 해외 배송비(USD)', 'shipping'),
  ('domestic_shipping_krw',   3000,   '기본 국내 배송비(KRW)', 'shipping')
ON CONFLICT (setting_key) DO NOTHING;

-- ===== 3. translations (translation cache) =====
CREATE TABLE IF NOT EXISTS translations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_lang     TEXT DEFAULT 'ko',
  target_lang     TEXT NOT NULL,
  title           TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  keywords        JSONB DEFAULT '[]'::jsonb,
  translated_by   TEXT DEFAULT 'claude',
  is_reviewed     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, target_lang)
);

CREATE INDEX IF NOT EXISTS idx_translations_product ON translations(product_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_translations_updated') THEN
    CREATE TRIGGER trg_translations_updated BEFORE UPDATE ON translations
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ===== 4. product_images (image variants: original/domestic/global) =====
CREATE TABLE IF NOT EXISTS product_images (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id          UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_type          TEXT NOT NULL,
  image_url           TEXT NOT NULL,
  sort_order          INTEGER DEFAULT 0,
  processing_status   TEXT DEFAULT 'pending',
  metadata            JSONB DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_pi_type ON product_images(product_id, image_type);

-- ===== 5. platform_mapping (per-product per-platform config) =====
CREATE TABLE IF NOT EXISTS platform_mapping (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform_id          UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  platform_title       TEXT DEFAULT '',
  platform_description TEXT DEFAULT '',
  platform_price       NUMERIC(12,2),
  platform_shipping    NUMERIC(8,2),
  platform_category_id TEXT DEFAULT '',
  is_enabled           BOOLEAN DEFAULT true,
  custom_fields        JSONB DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_product ON platform_mapping(product_id);
CREATE INDEX IF NOT EXISTS idx_pm_platform ON platform_mapping(platform_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_pm_updated') THEN
    CREATE TRIGGER trg_pm_updated BEFORE UPDATE ON platform_mapping
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ===== 6. platform_export_status (export tracking) =====
CREATE TABLE IF NOT EXISTS platform_export_status (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  platform_id       UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  export_status     TEXT DEFAULT 'pending',
  platform_item_id  TEXT DEFAULT '',
  exported_price    NUMERIC(12,2),
  exported_at       TIMESTAMPTZ,
  last_error        TEXT DEFAULT '',
  retry_count       INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_pes_product ON platform_export_status(product_id);
CREATE INDEX IF NOT EXISTS idx_pes_status ON platform_export_status(export_status);
CREATE INDEX IF NOT EXISTS idx_pes_item ON platform_export_status(platform_item_id) WHERE platform_item_id != '';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_pes_updated') THEN
    CREATE TRIGGER trg_pes_updated BEFORE UPDATE ON platform_export_status
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ===== 7. competitor_prices (eBay repricing) =====
CREATE TABLE IF NOT EXISTS competitor_prices (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku                 TEXT NOT NULL,
  platform            TEXT DEFAULT 'ebay',
  competitor_id       TEXT DEFAULT '',
  competitor_price    NUMERIC(12,2) NOT NULL,
  competitor_shipping NUMERIC(8,2) DEFAULT 0,
  competitor_url      TEXT DEFAULT '',
  tracked_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cp_sku ON competitor_prices(sku);
CREATE INDEX IF NOT EXISTS idx_cp_tracked ON competitor_prices(tracked_at);

-- ===== 8. repricing_rules =====
CREATE TABLE IF NOT EXISTS repricing_rules (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT,
  platform        TEXT DEFAULT 'ebay',
  strategy        TEXT DEFAULT 'undercut',
  undercut_amount NUMERIC(8,2) DEFAULT 0.01,
  min_price       NUMERIC(12,2),
  max_price       NUMERIC(12,2),
  min_margin_pct  NUMERIC(5,1) DEFAULT 10,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ===== 9. price_change_log =====
CREATE TABLE IF NOT EXISTS price_change_log (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku              TEXT NOT NULL,
  platform         TEXT DEFAULT 'ebay',
  old_price        NUMERIC(12,2),
  new_price        NUMERIC(12,2),
  reason           TEXT DEFAULT '',
  competitor_price NUMERIC(12,2),
  changed_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcl_sku ON price_change_log(sku);
CREATE INDEX IF NOT EXISTS idx_pcl_changed ON price_change_log(changed_at);

-- ===== Products table: ensure needed columns exist =====
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_ko TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS target_margin NUMERIC(5,1) DEFAULT 30;

-- ===== RLS policies for new tables =====
ALTER TABLE platforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE margin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_export_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE repricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_change_log ENABLE ROW LEVEL SECURITY;

-- Service role full access policies
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'platforms', 'margin_settings', 'translations', 'product_images',
    'platform_mapping', 'platform_export_status',
    'competitor_prices', 'repricing_rules', 'price_change_log'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY IF NOT EXISTS service_all_%s ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      tbl, tbl
    );
  END LOOP;
END $$;
