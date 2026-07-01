-- 061_hermes_execution_actor_audit.sql
--
-- Hermes Phase 5D — Execution Approval Actor/Audit Hardening
--
-- Purpose:
--   Add text actor audit columns and cancellation-specific fields to avoid using
--   integer placeholder values for non-numeric actors. This migration is
--   additive and does not modify migration 060.
--
-- Safety boundary:
--   - Internal approval/request audit columns only.
--   - No marketplace APIs.
--   - No price, inventory, or listing changes.
--   - No executor, scheduler, or external side effects.

alter table hermes_execution_requests
  add column if not exists approved_actor text,
  add column if not exists rejected_actor text,
  add column if not exists cancelled_actor text,
  add column if not exists cancelled_by integer,
  add column if not exists cancelled_at timestamp,
  add column if not exists cancellation_reason text;

-- Backfill actor text from Phase 5C review metadata where available.
update hermes_execution_requests
set approved_actor = metadata #>> '{hermes_execution_review,actor}'
where approved_actor is null
  and status = 'approved'
  and metadata #>> '{hermes_execution_review,actor}' is not null;

update hermes_execution_requests
set rejected_actor = metadata #>> '{hermes_execution_review,actor}'
where rejected_actor is null
  and status = 'rejected'
  and metadata #>> '{hermes_execution_review,actor}' is not null;

update hermes_execution_requests
set cancelled_actor = metadata #>> '{hermes_execution_review,actor}'
where cancelled_actor is null
  and status = 'cancelled'
  and metadata #>> '{hermes_execution_review,actor}' is not null;

-- Normalize Phase 5C placeholder integer actor values to null.
update hermes_execution_requests
set approved_by = null
where approved_by = 0;

update hermes_execution_requests
set rejected_by = null
where rejected_by = 0;

update hermes_execution_requests
set cancelled_by = null
where cancelled_by = 0;

create index if not exists idx_hermes_execution_requests_approved_actor
  on hermes_execution_requests (approved_actor) where approved_actor is not null;

create index if not exists idx_hermes_execution_requests_rejected_actor
  on hermes_execution_requests (rejected_actor) where rejected_actor is not null;

create index if not exists idx_hermes_execution_requests_cancelled_actor
  on hermes_execution_requests (cancelled_actor) where cancelled_actor is not null;

-- Rollback (manual):
--   drop index if exists idx_hermes_execution_requests_cancelled_actor;
--   drop index if exists idx_hermes_execution_requests_rejected_actor;
--   drop index if exists idx_hermes_execution_requests_approved_actor;
--   alter table hermes_execution_requests drop column if exists cancellation_reason;
--   alter table hermes_execution_requests drop column if exists cancelled_at;
--   alter table hermes_execution_requests drop column if exists cancelled_by;
--   alter table hermes_execution_requests drop column if exists cancelled_actor;
--   alter table hermes_execution_requests drop column if exists rejected_actor;
--   alter table hermes_execution_requests drop column if exists approved_actor;
