-- 060_hermes_execution_approval.sql
--
-- Hermes Phase 5A — Approval-Gated Execution Foundation
--
-- Purpose:
--   Create internal-only execution approval/request tables. This migration does
--   not create marketplace write functions, schedulers, triggers for external
--   execution, or any price/inventory/listing automation.
--
-- Safety boundary:
--   - Internal approval/request records only.
--   - No marketplace APIs.
--   - No price, inventory, or listing changes.
--   - Execution requires a separate approved implementation phase.

create table if not exists hermes_execution_requests (
  id                  serial primary key,
  opportunity_id      integer,
  sku                 varchar(100),
  execution_type      varchar(50) not null,
  status              varchar(30) not null default 'draft',
  requested_action    jsonb not null default '{}'::jsonb,
  risk_level          varchar(30) not null default 'medium',
  requires_approval   boolean not null default true,
  approved_by         integer,
  approved_at         timestamp,
  rejected_by         integer,
  rejected_at         timestamp,
  rejection_reason    text,
  executed_by         integer,
  executed_at         timestamp,
  dry_run_result      jsonb,
  execution_result    jsonb,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamp not null default now(),
  updated_at          timestamp not null default now(),

  constraint chk_hermes_execution_requests_status
    check (status in (
      'draft',
      'pending_approval',
      'approved',
      'rejected',
      'dry_run_ready',
      'executed',
      'failed',
      'cancelled'
    )),

  constraint chk_hermes_execution_requests_type
    check (execution_type in (
      'price_change',
      'inventory_change',
      'listing_update',
      'listing_quality_update',
      'cost_data_update',
      'enrichment_run',
      'manual_review_task'
    )),

  constraint chk_hermes_execution_requests_risk
    check (risk_level in ('low', 'medium', 'high', 'critical'))
);

create table if not exists hermes_execution_events (
  id                  serial primary key,
  request_id          integer,
  event_type          varchar(50) not null,
  actor               varchar(100),
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamp not null default now()
);

create index if not exists idx_hermes_execution_requests_status_created
  on hermes_execution_requests (status, created_at desc);

create index if not exists idx_hermes_execution_requests_sku_created
  on hermes_execution_requests (sku, created_at desc) where sku is not null;

create index if not exists idx_hermes_execution_requests_opportunity
  on hermes_execution_requests (opportunity_id) where opportunity_id is not null;

create index if not exists idx_hermes_execution_requests_type_status
  on hermes_execution_requests (execution_type, status);

create index if not exists idx_hermes_execution_events_request_created
  on hermes_execution_events (request_id, created_at desc);

create index if not exists idx_hermes_execution_events_type_created
  on hermes_execution_events (event_type, created_at desc);

-- FK constraints are conditional so this migration remains idempotent.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_hermes_execution_requests_opportunity') then
    raise notice '[060] fk_hermes_execution_requests_opportunity already exists — skip';
  else
    alter table hermes_execution_requests
      add constraint fk_hermes_execution_requests_opportunity
      foreign key (opportunity_id) references opportunity_inbox(id) on delete set null;
    raise notice '[060] fk_hermes_execution_requests_opportunity ADDED';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'fk_hermes_execution_events_request') then
    raise notice '[060] fk_hermes_execution_events_request already exists — skip';
  else
    alter table hermes_execution_events
      add constraint fk_hermes_execution_events_request
      foreign key (request_id) references hermes_execution_requests(id) on delete cascade;
    raise notice '[060] fk_hermes_execution_events_request ADDED';
  end if;
end $$;

-- Keep updated_at current for internal request row updates.
create or replace function set_hermes_execution_requests_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_hermes_execution_requests_updated_at on hermes_execution_requests;
create trigger trg_hermes_execution_requests_updated_at
  before update on hermes_execution_requests
  for each row execute function set_hermes_execution_requests_updated_at();

-- Rollback (manual):
--   drop trigger if exists trg_hermes_execution_requests_updated_at on hermes_execution_requests;
--   drop function if exists set_hermes_execution_requests_updated_at();
--   alter table hermes_execution_events drop constraint if exists fk_hermes_execution_events_request;
--   alter table hermes_execution_requests drop constraint if exists fk_hermes_execution_requests_opportunity;
--   drop index if exists idx_hermes_execution_events_type_created;
--   drop index if exists idx_hermes_execution_events_request_created;
--   drop index if exists idx_hermes_execution_requests_type_status;
--   drop index if exists idx_hermes_execution_requests_opportunity;
--   drop index if exists idx_hermes_execution_requests_sku_created;
--   drop index if exists idx_hermes_execution_requests_status_created;
--   drop table if exists hermes_execution_events;
--   drop table if exists hermes_execution_requests;
