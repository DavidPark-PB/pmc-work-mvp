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

CREATE TABLE IF NOT EXISTS price_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku             TEXT NOT NULL,
  date            DATE NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  platform        TEXT DEFAULT 'ebay',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(sku, date, platform)
);

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
