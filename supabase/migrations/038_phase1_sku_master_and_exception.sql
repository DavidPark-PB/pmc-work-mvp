-- 038_phase1_sku_master_and_exception.sql
-- WMS Phase 1 DB foundation. Non-destructive schema only — no app logic, no worker.
--
-- Adds:
--   1) sku_master                        WMS internal SKU source-of-truth
--   2) sku_listing_link                  internal SKU ↔ marketplace listing/option link
--   3) team_tasks exception columns      auto_generated, exception_type, context, dedupe_key,
--                                        severity, related_sku_id, related_order_id
--   4) team_tasks_dedupe_key_active      partial unique index on active dedupe keys
--   5) jobs                              DB jobs polling foundation (schema only)
--   6) automation_runs                   automation execution log foundation
--
-- Safety:
--   - All ADD COLUMN use IF NOT EXISTS with safe defaults — existing 38 team_tasks rows
--     get auto_generated=false and severity='medium', other new columns NULL.
--   - team_tasks_dedupe_key_active is partial (WHERE status != 'done' AND dedupe_key IS NOT NULL),
--     so existing rows (dedupe_key NULL) are excluded from the index.
--   - related_order_id has no FK in Phase 1 — orders/order_lines schema lands in Phase 2.
--   - jobs and automation_runs are schema only — no worker registers in this PR.
--   - 037_orders_fedex_label.sql is left untouched.

-- ──────────────────────────────────────────────────────────────────────────
-- 1) SKU master — internal source-of-truth for WMS SKUs.
--    Distinct from existing `products` (which remains marketplace-mirror aggregate).
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists sku_master (
  id                 serial primary key,
  internal_sku       varchar(100) not null unique,
  title              varchar(255) not null,
  product_type       varchar(50),
  brand              varchar(100),
  category           varchar(100),
  status             varchar(30)  not null default 'active',  -- 'active' | 'paused' | 'discontinued'
  automation_enabled boolean      not null default false,
  cost_krw           numeric(12,2),
  weight_gram        integer,
  hs_code            varchar(50),
  notes              text,
  created_by         integer,                                  -- users(id), no FK to keep loose coupling
  created_at         timestamp without time zone not null default now(),
  updated_at         timestamp without time zone not null default now()
);

create index if not exists idx_sku_master_status
  on sku_master(status);

create index if not exists idx_sku_master_automation_enabled
  on sku_master(automation_enabled);

-- ──────────────────────────────────────────────────────────────────────────
-- 2) SKU ↔ marketplace listing link.
--    A single internal SKU may link to N (marketplace, listing_id, option_id) tuples.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists sku_listing_link (
  id               serial primary key,
  sku_id           integer not null references sku_master(id) on delete cascade,
  marketplace      varchar(50)  not null,           -- 'ebay' | 'shopify' | 'naver' | 'shopee' | 'alibaba' | 'coupang' | 'qoo10'
  listing_id       varchar(200) not null,
  option_id        varchar(200),
  marketplace_sku  varchar(200),
  is_primary       boolean      not null default false,
  created_at       timestamp without time zone not null default now(),
  updated_at       timestamp without time zone not null default now(),
  unique (marketplace, listing_id, option_id)
);

create index if not exists idx_sku_listing_link_sku_id
  on sku_listing_link(sku_id);

create index if not exists idx_sku_listing_link_marketplace
  on sku_listing_link(marketplace);

-- ──────────────────────────────────────────────────────────────────────────
-- 3) team_tasks: WMS exception card columns.
--    Existing rows get auto_generated=false (default), severity='medium' (default),
--    other new columns NULL. No CHECK constraints on team_tasks were verified, so
--    no constraint conflicts.
-- ──────────────────────────────────────────────────────────────────────────
alter table team_tasks
  add column if not exists auto_generated   boolean      not null default false,
  add column if not exists exception_type   varchar(50),
  add column if not exists context          jsonb,
  add column if not exists dedupe_key       varchar(200),
  add column if not exists severity         varchar(20)  default 'medium',
  add column if not exists related_sku_id   integer      references sku_master(id),
  add column if not exists related_order_id integer;
-- related_order_id FK is intentionally deferred to Phase 2 (orders/order_lines pending).

create index if not exists idx_team_tasks_auto_generated
  on team_tasks(auto_generated);

create index if not exists idx_team_tasks_exception_type
  on team_tasks(exception_type);

create index if not exists idx_team_tasks_related_sku_id
  on team_tasks(related_sku_id);

-- 4) Partial unique index — prevents duplicate active exception cards for the same dedupe_key.
--    Excludes done cards (so the same key can resurface after resolution + cool-down)
--    and excludes NULL (so human-authored cards without dedupe_key don't conflict).
create unique index if not exists team_tasks_dedupe_key_active
  on team_tasks(dedupe_key)
  where status != 'done' and dedupe_key is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) jobs — DB jobs polling foundation.
--    Schema only in Phase 1. Worker logic (SELECT ... FOR UPDATE SKIP LOCKED,
--    retry / unlock cron) is intentionally NOT in this PR.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists jobs (
  id                serial primary key,
  job_type          varchar(100) not null,                              -- e.g. 'sku_match', 'price_change', 'label_create'
  status            varchar(30)  not null default 'pending',             -- 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  payload           jsonb,
  priority          integer      not null default 100,                   -- lower = higher priority
  idempotency_key   varchar(200) unique,                                 -- caller-provided dedupe key for safe retry
  attempts          integer      not null default 0,
  max_attempts      integer      not null default 3,
  available_at      timestamp without time zone not null default now(), -- backoff target time
  locked_at         timestamp without time zone,                         -- worker lock acquisition time
  locked_by         varchar(100),                                        -- worker identifier
  started_at        timestamp without time zone,
  completed_at      timestamp without time zone,
  failed_at         timestamp without time zone,
  error_message     text,
  created_by        integer,
  created_at        timestamp without time zone not null default now(),
  updated_at        timestamp without time zone not null default now()
);

create index if not exists idx_jobs_status_available
  on jobs(status, available_at);

create index if not exists idx_jobs_locked_at
  on jobs(locked_at);

create index if not exists idx_jobs_job_type
  on jobs(job_type);

-- ──────────────────────────────────────────────────────────────────────────
-- 6) automation_runs — execution history for jobs / automated workflows.
--    1 job → 1+ runs (one per attempt). Phase 1 schema only.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists automation_runs (
  id                serial primary key,
  job_id            integer references jobs(id) on delete set null,
  automation_type   varchar(100) not null,
  triggered_by      varchar(100),                                        -- 'cron' | 'user:{id}' | 'webhook' | etc.
  status            varchar(30)  not null default 'started',             -- 'started' | 'succeeded' | 'failed' | 'aborted'
  input_snapshot    jsonb,                                                -- mask via src/lib/redact.js before insert
  output_snapshot   jsonb,                                                -- mask via src/lib/redact.js before insert
  started_at        timestamp without time zone not null default now(),
  completed_at      timestamp without time zone,
  error_code        varchar(100),
  error_message     text,
  retry_count       integer      not null default 0,
  related_sku_id    integer      references sku_master(id),
  related_task_id   integer      references team_tasks(id),
  created_at        timestamp without time zone not null default now()
);

create index if not exists idx_automation_runs_job_id
  on automation_runs(job_id);

create index if not exists idx_automation_runs_type_status
  on automation_runs(automation_type, status);

create index if not exists idx_automation_runs_related_sku_id
  on automation_runs(related_sku_id);
