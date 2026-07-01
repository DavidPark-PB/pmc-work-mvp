-- 064_hermes_marketplace_preflight.sql
--
-- Hermes Phase 8B — Marketplace Preflight Records
--
-- Purpose:
--   Add an internal-only audit table for marketplace preflight checks.
--   This migration does not add marketplace execution result fields, marketplace
--   adapter fields, token storage, scheduler fields, or any write-execution path.

create table if not exists public.hermes_marketplace_preflight_records (
  id serial primary key,
  request_id integer not null references public.hermes_execution_requests(id),
  marketplace text not null,
  operation text not null,
  status text not null,
  actor text,
  reason text,
  preflight_result jsonb not null default '{}'::jsonb,
  listing_snapshot jsonb not null default '{}'::jsonb,
  planned_mutation jsonb not null default '{}'::jsonb,
  safety_flags jsonb not null default '{}'::jsonb,
  created_at timestamp default now(),

  constraint hermes_marketplace_preflight_status_chk check (
    status in ('preflight_passed', 'preflight_failed')
  ),
  constraint hermes_marketplace_preflight_marketplace_chk check (
    marketplace in ('ebay')
  ),
  constraint hermes_marketplace_preflight_operation_chk check (
    operation in ('listing_quality_update')
  )
);

create index if not exists idx_hmp_records_request_id
  on public.hermes_marketplace_preflight_records(request_id);

create index if not exists idx_hmp_records_marketplace_operation
  on public.hermes_marketplace_preflight_records(marketplace, operation);

create index if not exists idx_hmp_records_status
  on public.hermes_marketplace_preflight_records(status);

comment on table public.hermes_marketplace_preflight_records is
  'Hermes Phase 8 internal-only marketplace preflight audit records. No marketplace execution, no marketplace response, no price/inventory/listing writes.';

comment on column public.hermes_marketplace_preflight_records.preflight_result is
  'Rule-based cached/internal-data preflight result. Must not include marketplace tokens or external API responses.';

comment on column public.hermes_marketplace_preflight_records.listing_snapshot is
  'Cached/internal listing snapshot only. No live marketplace API fetch in Phase 8.';

comment on column public.hermes_marketplace_preflight_records.planned_mutation is
  'Planned mutation preview only. Phase 8 does not execute it and must not include price or quantity fields.';
