-- 115_shipping_quote_shadow_results.sql
-- PMC-CCOREA-SHIPPING-1B correction (2026-09-13) · owner directive §4.
--
-- Persistent shadow-mode comparison log. The automation subproject POSTs to
-- /api/internal/shipping/shadow-result after computing the legacy listing
-- price; that endpoint writes ONE row per (listing_job_id, product_ref) so
-- the owner can review shadow-vs-legacy divergence in the admin console
-- without relying on stdout logs.
--
-- Sensitive data policy (owner rule):
--   · No token, cookie, or session id is ever stored in this table.
--   · `calculation_details` (jsonb) may hold shape metadata (bracket, band id,
--     surcharge breakdown) — the caller MUST redact secrets before posting.
--
-- Idempotency: `uq_sqsr_job_ref` prevents duplicate rows per (listing_job_id,
-- product_ref) — automation retries or crawler re-runs are safe. `product_ref`
-- accepts either the SKU or the product id (whichever the automation subproject
-- has on hand); consumers must not assume one shape.

create table if not exists shipping_quote_shadow_results (
  id                       serial primary key,

  -- linkage to the automation batch that produced the comparison
  listing_job_id           varchar(200) not null,
  product_ref              varchar(200) not null,           -- SKU or product id (opaque to this table)
  marketplace              varchar(50)  not null,
  destination_country      varchar(2),

  -- comparison values (all in KRW / decimal fractions)
  legacy_listing_price     numeric(14,2),
  new_listing_price        numeric(14,2),
  difference_amount        numeric(14,2),                   -- new - legacy
  difference_pct           numeric(8,4),                    -- (new-legacy)/legacy · 4 dp
  legacy_shipping_cost     numeric(14,2),
  new_shipping_cost        numeric(14,2),
  chargeable_weight_kg     numeric(6,3),

  -- provenance
  service_code             varchar(50),
  rate_version_id          integer,                         -- loose FK — no cascade so archives survive rate churn
  policy_band_id           integer,                         -- loose FK

  -- status / block reason from the adapter
  status                   varchar(30)  not null,           -- 'ok' | 'blocked'
  blocked_reason           varchar(80),                     -- e.g. 'NO_SHIPPING_POLICY', 'RATE_NOT_LOADED'
  calculation_details      jsonb        default '{}'::jsonb,

  created_at               timestamptz  not null default now(),

  constraint chk_sqsr_status check (status in ('ok','blocked')),
  constraint uq_sqsr_job_ref unique (listing_job_id, product_ref)
);

create index if not exists idx_sqsr_created_at
  on shipping_quote_shadow_results(created_at desc);
create index if not exists idx_sqsr_status_blocked
  on shipping_quote_shadow_results(status, blocked_reason)
  where status = 'blocked';
create index if not exists idx_sqsr_marketplace_country
  on shipping_quote_shadow_results(marketplace, destination_country);

-- Rollback (manual): drop table if exists shipping_quote_shadow_results;
