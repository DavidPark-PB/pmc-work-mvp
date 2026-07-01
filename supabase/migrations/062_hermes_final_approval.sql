-- 062_hermes_final_approval.sql
--
-- Hermes Phase 6B — Internal Final Approval Fields
--
-- Purpose:
--   Add internal-only final approval fields to hermes_execution_requests.
--   Final approval is not marketplace execution and does not create executor,
--   scheduler, marketplace API, price, inventory, or listing automation fields.
--
-- Safety boundary:
--   - Internal final approval metadata only.
--   - No marketplace APIs.
--   - No price, inventory, or listing changes.
--   - No executor, scheduler, or external side effects.

alter table hermes_execution_requests
  add column if not exists final_approval_status text not null default 'not_requested',
  add column if not exists final_approval_actor text,
  add column if not exists final_approval_reason text,
  add column if not exists final_approved_at timestamp,
  add column if not exists final_approval_policy_version text,
  add column if not exists final_approval_dry_run_hash text,
  add column if not exists final_approval_snapshot jsonb,
  add column if not exists final_approval_rejected_actor text,
  add column if not exists final_approval_rejected_at timestamp,
  add column if not exists final_approval_rejection_reason text,
  add column if not exists final_approval_expires_at timestamp;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chk_hermes_execution_requests_final_approval_status') then
    raise notice '[062] chk_hermes_execution_requests_final_approval_status already exists — skip';
  else
    alter table hermes_execution_requests
      add constraint chk_hermes_execution_requests_final_approval_status
      check (final_approval_status in ('not_requested', 'approved', 'rejected', 'expired'));
    raise notice '[062] chk_hermes_execution_requests_final_approval_status ADDED';
  end if;
end $$;

create index if not exists idx_hermes_execution_requests_final_approval_status
  on hermes_execution_requests (final_approval_status, final_approved_at desc);

create index if not exists idx_hermes_execution_requests_final_approval_actor
  on hermes_execution_requests (final_approval_actor) where final_approval_actor is not null;

create index if not exists idx_hermes_execution_requests_final_approval_expires
  on hermes_execution_requests (final_approval_expires_at) where final_approval_expires_at is not null;

-- Rollback (manual):
--   drop index if exists idx_hermes_execution_requests_final_approval_expires;
--   drop index if exists idx_hermes_execution_requests_final_approval_actor;
--   drop index if exists idx_hermes_execution_requests_final_approval_status;
--   alter table hermes_execution_requests drop constraint if exists chk_hermes_execution_requests_final_approval_status;
--   alter table hermes_execution_requests drop column if exists final_approval_expires_at;
--   alter table hermes_execution_requests drop column if exists final_approval_rejection_reason;
--   alter table hermes_execution_requests drop column if exists final_approval_rejected_at;
--   alter table hermes_execution_requests drop column if exists final_approval_rejected_actor;
--   alter table hermes_execution_requests drop column if exists final_approval_snapshot;
--   alter table hermes_execution_requests drop column if exists final_approval_dry_run_hash;
--   alter table hermes_execution_requests drop column if exists final_approval_policy_version;
--   alter table hermes_execution_requests drop column if exists final_approved_at;
--   alter table hermes_execution_requests drop column if exists final_approval_reason;
--   alter table hermes_execution_requests drop column if exists final_approval_actor;
--   alter table hermes_execution_requests drop column if exists final_approval_status;
