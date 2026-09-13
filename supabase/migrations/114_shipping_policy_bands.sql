-- 114_shipping_policy_bands.sql
-- PMC-CCOREA-SHIPPING-1B (2026-09-13) · owner directive §8.
--
-- Maps a (marketplace, destination, chargeable-weight band) tuple to a
-- pre-existing eBay Business Policy ID that the operator entered manually.
-- We NEVER auto-create or auto-modify eBay policies — the ebay_policy_id
-- column stores an id the owner already configured in eBay Seller Hub.
--
-- If no band matches at auto-listing time → NO_SHIPPING_POLICY blocked reason
-- (owner directive §8: never default to a fallback policy).
--
-- Rollback (manual): drop table if exists shipping_policy_bands;

create table if not exists shipping_policy_bands (
  id                        serial primary key,
  marketplace               varchar(50)  not null,          -- 'ebay' (only current consumer)
  destination_country       varchar(2),                     -- ISO code, null = any (region below)
  destination_region        varchar(50),                    -- 'ALL' | 'EU' | 'AMERICAS' etc; used when country null
  min_chargeable_weight_kg  numeric(6,3) not null,          -- inclusive lower bound
  max_chargeable_weight_kg  numeric(6,3) not null,          -- inclusive upper bound
  ebay_policy_id            varchar(100) not null,          -- eBay Business Policy identifier (owner-provided)
  policy_name               varchar(200),                   -- human label from eBay
  buyer_shipping_fee_krw    numeric(12,2) not null default 0,  -- what the buyer pays (subtracted from listing price)
  active                    boolean      not null default true,
  created_by                integer,                        -- users(id), loose FK
  created_at                timestamptz  not null default now(),
  updated_at                timestamptz  not null default now(),
  note                      text,
  constraint chk_spb_range   check (max_chargeable_weight_kg >= min_chargeable_weight_kg),
  constraint chk_spb_scope   check (destination_country is not null or destination_region is not null),
  --   No unique constraint on (marketplace, country/region, band) — allow the
  --   operator to keep historical rows with active=false. Uniqueness among
  --   ACTIVE rows is enforced at query time (lookup returns the newest match).
  constraint uq_spb_active   unique (marketplace, destination_country, destination_region, min_chargeable_weight_kg, max_chargeable_weight_kg, ebay_policy_id)
);

create index if not exists idx_spb_lookup_active
  on shipping_policy_bands(marketplace, destination_country, min_chargeable_weight_kg, max_chargeable_weight_kg)
  where active = true;

create index if not exists idx_spb_region_lookup_active
  on shipping_policy_bands(marketplace, destination_region, min_chargeable_weight_kg, max_chargeable_weight_kg)
  where active = true and destination_country is null;
