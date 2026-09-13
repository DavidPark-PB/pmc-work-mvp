-- 112_shipping_rate_master.sql
-- PMC-CCOREA-SHIPPING-1B (2026-09-13). Owner-approved directive §3.
--
-- Canonical shipping-rate master tables. The 5 tables mirror the 5
-- non-dashboard sheets of CCOREA_통합배송비_기본데이터_v1.xlsx:
--   국가_Master   → shipping_countries
--   서비스_Master → shipping_services
--   운임_Master   → shipping_rate_brackets
--   할증_Master   → shipping_surcharges
--   원본목록      → shipping_rate_versions
--
-- Idempotency (owner rule §2 of directive): re-importing the same workbook
-- version must be a no-op. Enforced by:
--   · shipping_rate_versions(provider, source_name, effective_from) UNIQUE
--   · every dependent row is scoped by rate_version_id (never mutated in place)
--   · new versions supersede prior via status flip (not delete)
--
-- Idempotent DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
-- matches existing convention (mig 038, 078, 111).
--
-- No production apply. This file lives in the repo only until owner runs
-- it against Supabase per CLAUDE.md workflow.
--
-- ─────────────────────────────────────────────────────────────────────

-- shipping_rate_versions ───────────────────────────────────────────────
--   One row per uploaded rate book. Prior versions are NEVER deleted —
--   status flips to 'superseded' and effective_to is stamped on import.
create table if not exists shipping_rate_versions (
  id             serial primary key,
  provider       varchar(50)  not null,               -- 'eGS' | 'FICP' | 'FedEx' | 'KPL' | 'SHIPTER' | 'KOREAPOST'
  source_name    varchar(300) not null,               -- filename or 'seed:YYYY-MM-DD'
  effective_from date         not null,
  effective_to   date,                                -- null = open-ended
  status         varchar(20)  not null default 'draft',
  imported_at    timestamptz  not null default now(),
  imported_by    integer,                             -- users(id) loose FK
  note           text,
  constraint chk_srv_status check (status in ('draft','active','superseded','archived')),
  constraint uq_srv_provider_source unique (provider, source_name, effective_from)
);
create index if not exists idx_srv_provider_active
  on shipping_rate_versions(provider) where status = 'active';

-- shipping_services ────────────────────────────────────────────────────
--   Service master with per-service volumetric divisor (spec §2 rule 2).
create table if not exists shipping_services (
  id                   serial primary key,
  rate_version_id      integer not null references shipping_rate_versions(id) on delete cascade,
  provider             varchar(50)  not null,
  service_code         varchar(50)  not null,        -- 'EGS_STD_US' | 'EGS_EXPRESS' | 'FICP' | 'KPL' ...
  service_name         varchar(200) not null,
  vol_divisor          integer      not null,        -- 6000 (eGS Std US) | 5000 (EU/Express) | ...
  sale_type            varchar(20),                  -- 'B2C' | 'B2B' | 'BOTH'
  incoterm             varchar(10),                  -- 'DAP' | 'DDP' | 'IP' | 'DDU'
  rate_loaded          boolean      not null default false,   -- Y/N from workbook
  coverage             text,
  usage                text,
  perkg_surcharge_krw  numeric(12,2),               -- eGS Standard 긴급할증 per kg (Express = 0 · included)
  active               boolean      not null default true,
  constraint uq_ss_version_code unique (rate_version_id, service_code)
);
create index if not exists idx_ss_version_active
  on shipping_services(rate_version_id) where active = true;

-- shipping_countries ───────────────────────────────────────────────────
--   Per-country VAT rate + benchmark service for LISTING quotes.
create table if not exists shipping_countries (
  id                     serial primary key,
  rate_version_id        integer not null references shipping_rate_versions(id) on delete cascade,
  country_code           varchar(2)  not null,       -- ISO 3166-1 alpha-2
  country_name           varchar(200),
  express_zone           varchar(50),
  is_eu                  boolean     not null default false,
  vat_rate               numeric(6,4) not null default 0,  -- 0.1900 = 19% · applied only if is_eu
  benchmark_service_code varchar(50) not null,       -- spec §4 rule 5 → LISTING service
  constraint uq_sc_version_country unique (rate_version_id, country_code)
);
create index if not exists idx_sc_version_eu
  on shipping_countries(rate_version_id) where is_eu = true;

-- shipping_rate_brackets ───────────────────────────────────────────────
--   The bracket table. weight_to_kg is the UPPER bound of the bracket.
--   Round-up lookup (spec §4 rule 4): pick the smallest bracket with
--   weight_to_kg >= chargeableKg. NEVER round down.
create table if not exists shipping_rate_brackets (
  id              serial primary key,
  rate_version_id integer not null references shipping_rate_versions(id) on delete cascade,
  service_code    varchar(50)  not null,
  country_key     varchar(50)  not null,             -- ISO country code | zone name | '__ALL__'
  zone_key        varchar(50),                       -- optional secondary partition (Express zones)
  weight_to_kg    numeric(6,3) not null,             -- upper bound of bracket
  base_rate       numeric(12,2) not null,
  currency        varchar(3)  not null default 'KRW',
  note            text,
  active          boolean     not null default true,
  --   zone_key is included in the uniqueness key because eGS Express uses
  --   zone-based brackets (country_key is empty, zone_key='A'..'J' identifies
  --   the express zone matching shipping_countries.express_zone).
  --   Null zone_key collapses via COALESCE so country-only services still work.
  constraint uq_srb_lookup unique (rate_version_id, service_code, country_key, zone_key, weight_to_kg),
  constraint chk_srb_currency check (currency in ('KRW','USD','EUR'))
);
create index if not exists idx_srb_lookup
  on shipping_rate_brackets(rate_version_id, service_code, country_key, weight_to_kg)
  where active = true;

-- shipping_surcharges ──────────────────────────────────────────────────
--   Rate-book surcharges: EU HS €3/unique, VAT scope, weekly FSC, etc.
--   NOT operator-facing FX (that stays in margin_settings per directive §5).
create table if not exists shipping_surcharges (
  id              serial primary key,
  rate_version_id integer not null references shipping_rate_versions(id) on delete cascade,
  rule_code       varchar(50)  not null,             -- 'EU_HS_3EUR' | 'FSC_WEEKLY' | 'EU_VAT' ...
  scope           varchar(100),                      -- 'EU' | 'service:EGS_EXPRESS' | 'country:DE' | 'global'
  value           numeric(14,4) not null,
  unit            varchar(30)  not null,             -- 'EUR' | 'KRW' | 'PCT' | 'KRW_PER_KG'
  enabled         boolean      not null default true,
  effective_from  date,
  effective_to    date,
  note            text
);
create index if not exists idx_ssur_active
  on shipping_surcharges(rate_version_id) where enabled = true;

-- Rollback (manual, if needed):
--   drop table if exists shipping_surcharges;
--   drop table if exists shipping_rate_brackets;
--   drop table if exists shipping_countries;
--   drop table if exists shipping_services;
--   drop table if exists shipping_rate_versions;
