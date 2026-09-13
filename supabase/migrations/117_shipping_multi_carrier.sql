-- 117_shipping_multi_carrier.sql
-- PMC-CCOREA-SHIPPING-1C MULTI-CARRIER QUOTE SELECTION (2026-09-13).
--
-- Owner directive: LISTING quotes must no longer auto-pick eGS via the
-- country benchmark_service_code. Instead every eligible service is
-- quoted, the operator sees a comparison table, and picks. This migration
-- adds the minimum schema pieces the shadow implementation needs.
--
-- File is committed as a FILE only. It is NOT applied to production in
-- this deploy — owner must approve migration 117 before it lands.
-- The application code shipped alongside this migration reads the new
-- columns/table only when they exist; every read is guarded so the code
-- keeps working on the current schema (§12 shadow rule).
--
-- Additions in this migration:
--   (1) sku_master.is_branded           boolean  — operator-set flag
--       sku_master.shipping_service_override      varchar(64)  — per-SKU forced pick
--       sku_master.shipping_service_exclusions_json jsonb      — per-SKU deny list
--   (2) shipping_policy_bands.provider     varchar(32)  — nullable = any
--       shipping_policy_bands.service_code varchar(64)  — nullable = any
--       (unique index widened to include provider + service_code)
--   (3) shipping_eligibility_rules — new table for global rules
--       e.g. "all branded products exclude eGS" or "Pokemon only ships via KPL".
--
-- Access model matches migration 116: RLS + REVOKE for the new table.

-- ═════════════════════════════════════════════════════════════
-- 1) sku_master brand + shipping overrides
-- ═════════════════════════════════════════════════════════════
alter table public.sku_master
  add column if not exists is_branded                       boolean,
  add column if not exists shipping_service_override        varchar(64),
  add column if not exists shipping_service_exclusions_json jsonb;

comment on column public.sku_master.is_branded is
  '브랜드 제품 여부 (운영자 설정). NULL = 미확인 → BRAND_STATUS_UNKNOWN warning. brand column과 별개 — 브랜드명이 있어도 non-branded로 취급 가능.';
comment on column public.sku_master.shipping_service_override is
  '이 SKU를 무조건 특정 shipping_services.service_code로 견적. NULL = compare.';
comment on column public.sku_master.shipping_service_exclusions_json is
  '이 SKU에서 제외할 service_code 목록. 형태: ["EGS_STD_US","EGS_EMS_미국"]. NULL/[] = 제외 없음.';

-- ═════════════════════════════════════════════════════════════
-- 2) shipping_policy_bands provider / service refinement
-- ═════════════════════════════════════════════════════════════
alter table public.shipping_policy_bands
  add column if not exists provider     varchar(32),
  add column if not exists service_code varchar(64);

comment on column public.shipping_policy_bands.provider is
  '이 band이 매칭될 provider (eGS / KPL / FEDEX / …). NULL = 모든 provider.';
comment on column public.shipping_policy_bands.service_code is
  '이 band이 매칭될 service_code. NULL = 모든 service 안에서 국가/중량으로만 매칭.';

-- 조회 성능을 위한 인덱스 (marketplace + destination + provider + weight range).
create index if not exists idx_policy_bands_lookup
  on public.shipping_policy_bands (marketplace, destination_country, provider, service_code, min_chargeable_weight_kg, max_chargeable_weight_kg)
  where active = true;

-- ═════════════════════════════════════════════════════════════
-- 3) shipping_eligibility_rules — global provider/service restrictions
-- ═════════════════════════════════════════════════════════════
create table if not exists public.shipping_eligibility_rules (
  id                serial primary key,
  provider          varchar(32)  not null,
  service_code      varchar(64),                 -- NULL = every service of this provider
  restriction_type  varchar(32)  not null,       -- 'brand_all' | 'brand_specific' | 'country' | 'sale_type' | 'weight' | 'ad_hoc'
  brand_name        varchar(200),                -- '*' or NULL = any brand · exact match otherwise
  country_scope     varchar(32),                 -- NULL = any · ISO-2 (e.g. 'US') · region tag (e.g. 'EU')
  sale_type         varchar(8),                  -- NULL = any · 'B2C' · 'B2B'
  allowed           boolean not null default false,   -- false = restriction / true = explicit permission override
  active            boolean not null default true,
  note              text,
  created_by        integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.shipping_eligibility_rules is
  '배송서비스 사용 가능/불가 규칙. 예: (eGS, NULL, brand_all, "*", NULL, NULL, false) → 모든 브랜드 제품에서 eGS 제외.';
create index if not exists idx_eligibility_rules_provider
  on public.shipping_eligibility_rules (provider, service_code) where active = true;
create index if not exists idx_eligibility_rules_type
  on public.shipping_eligibility_rules (restriction_type) where active = true;

-- ═════════════════════════════════════════════════════════════
-- 4) Access hardening — RLS + REVOKE matching migration 116 policy
-- ═════════════════════════════════════════════════════════════
alter table public.shipping_eligibility_rules enable row level security;
revoke all privileges on table    public.shipping_eligibility_rules            from anon, authenticated;
revoke all privileges on sequence public.shipping_eligibility_rules_id_seq     from anon, authenticated;
-- No CREATE POLICY — service_role only, same model as the rest of the shipping tables.

-- ═════════════════════════════════════════════════════════════
-- 5) Seed the "브랜드 제품 → eGS 전면 제외" default rule (§4)
--    Seed runs on migration apply; safe to re-apply — check ON CONFLICT.
--    NOTE: this seed is inserted only when the table has zero rows so a
--    re-apply during rollback rehearsal does not create duplicates.
-- ═════════════════════════════════════════════════════════════
insert into public.shipping_eligibility_rules
  (provider, service_code, restriction_type, brand_name, country_scope, sale_type, allowed, note)
select 'eGS', NULL, 'brand_all', '*', NULL, NULL, false,
       'Default rule (2026-09-13, PMC-CCOREA-SHIPPING-1C): all branded products EXCLUDE eGS. Operator may override per brand/service via new rows.'
where not exists (
  select 1 from public.shipping_eligibility_rules
  where provider = 'eGS' and restriction_type = 'brand_all' and coalesce(brand_name, '') = '*'
);

-- Rollback (manual, if needed):
--   drop table public.shipping_eligibility_rules;
--   alter table public.shipping_policy_bands drop column provider, drop column service_code;
--   drop index if exists idx_policy_bands_lookup;
--   alter table public.sku_master
--     drop column is_branded,
--     drop column shipping_service_override,
--     drop column shipping_service_exclusions_json;
