-- 097_marketplace_identity.sql
-- Phase 8P-21B · Marketplace Identity Resolver — canonical bridge
--   marketplace order-line identifiers  →  sku_master
--
-- Owner directive (Phase 8P-21A audit):
--   channel · identity_type · identity_value  uniquely identifies a marketplace item
--   and MUST resolve to a single sku_master. This table becomes the deterministic
--   authority consulted BEFORE the legacy sku_listing_link waterfall. Owner-curated.
--
--   Never used for title fuzzy matching. Never mutates marketplace state.
--
-- Design (mirrors project conventions from 088_sku_master_link.sql · 038 sku_listing_link):
--   - FK sku_master(id) ON DELETE RESTRICT  — historical identity protection
--   - Partial UNIQUE not needed · identity_value is NOT NULL
--   - CHECK constraints for source · confidence · identity_type allowlist
--   - CREATE INDEX IF NOT EXISTS · additive · legacy无수정
--
-- CRITICAL:
--   `ebay_transaction_id` is intentionally NOT in the identity_type allowlist —
--   CanonicalOrderItem does not currently expose a transaction id to the matcher
--   (per Phase 8P-21B Task 1 explicit audit note). Adding it later requires an
--   allowlist migration + adapter change.
--
-- Dependencies: 038_phase1_sku_master_and_exception.sql (sku_master table)

create table if not exists marketplace_identity (
  id                     serial       primary key,

  channel                varchar(50)  not null,          -- 'ebay' | 'shopify' | 'naver' | 'coupang' | 'qoo10' | 'shopee'
  identity_type          varchar(50)  not null,          -- see chk_marketplace_identity_type allowlist below
  identity_value         varchar(500) not null,          -- e.g. Shopify variant_id '42847864324261'

  sku_master_id          integer      not null
                                       references sku_master(id) on delete restrict,

  source                 varchar(50)  not null default 'owner_confirmed',
  confidence             varchar(20)  not null default 'high',

  notes                  text,

  created_at             timestamptz  not null default now(),
  updated_at             timestamptz  not null default now(),
  created_by             integer,                        -- users(id) loose (matches sku_master_link convention)

  constraint uq_marketplace_identity_ctv
    unique (channel, identity_type, identity_value),

  constraint chk_marketplace_identity_source check (source in (
    'owner_confirmed',
    'ingest_seed',
    'catalog_export',
    'auto_inferred_review'
  )),

  constraint chk_marketplace_identity_confidence check (confidence in (
    'high','medium','low','review_pending'
  )),

  constraint chk_marketplace_identity_type check (identity_type in (
    -- eBay
    'ebay_listing_id',
    'ebay_sku',
    -- Shopify
    'shopify_variant_id',
    'shopify_product_id',
    'shopify_sku',
    -- Naver (Smart Store)
    'naver_product_order_id',
    'naver_product_id',
    'naver_sku',
    -- Coupang
    'coupang_vendor_item_id',
    'coupang_option_id',
    'coupang_sku',
    -- Qoo10
    'qoo10_item_code',
    'qoo10_option_code',
    'qoo10_sku',
    -- Shopee
    'shopee_item_id',
    'shopee_model_id',
    'shopee_sku',
    -- Universal (future GTIN dedupe)
    'upc_ean',
    'gtin'
  ))
);

-- Reverse-direction index — "this sku_master's identity rows"
create index if not exists idx_marketplace_identity_sku_master
  on marketplace_identity(sku_master_id);

-- Priority-scan index for bulk resolver — (channel, identity_type) is the
-- outermost filter of every resolver query.
create index if not exists idx_marketplace_identity_channel_type
  on marketplace_identity(channel, identity_type);

-- Auditing / freshness index — matches sku_master_link.linked_at convention.
create index if not exists idx_marketplace_identity_created_at
  on marketplace_identity(created_at);

-- Rollback:
--   drop index if exists idx_marketplace_identity_created_at;
--   drop index if exists idx_marketplace_identity_channel_type;
--   drop index if exists idx_marketplace_identity_sku_master;
--   drop table if exists marketplace_identity;
