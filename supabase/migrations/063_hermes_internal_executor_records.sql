-- 063_hermes_internal_executor_records.sql
--
-- Hermes Phase 7B — Internal Limited Executor Records
--
-- Purpose:
--   Add an internal-only record table for limited manual_review_task executor
--   preflight/result visibility.
--
-- Safety boundary:
--   - Internal manual_review_task records only.
--   - No marketplace execution columns.
--   - No marketplace adapter fields.
--   - No price, inventory, or listing mutation fields.
--   - No scheduler or external side-effect fields.

create table if not exists hermes_internal_execution_records (
  id serial primary key,
  request_id integer not null references hermes_execution_requests(id),
  execution_type text not null,
  status text not null,
  actor text,
  reason text,
  preflight_result jsonb not null default '{}'::jsonb,
  internal_task_result jsonb not null default '{}'::jsonb,
  safety_flags jsonb not null default '{}'::jsonb,
  created_at timestamp default now()
);

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chk_hermes_internal_execution_records_status') then
    raise notice '[063] chk_hermes_internal_execution_records_status already exists — skip';
  else
    alter table hermes_internal_execution_records
      add constraint chk_hermes_internal_execution_records_status
      check (status in ('preflight_passed', 'preflight_failed', 'internal_task_recorded'));
    raise notice '[063] chk_hermes_internal_execution_records_status ADDED';
  end if;
end $$;

create index if not exists idx_hermes_internal_execution_records_request_id
  on hermes_internal_execution_records (request_id, created_at desc);

create index if not exists idx_hermes_internal_execution_records_status
  on hermes_internal_execution_records (status, created_at desc);

create unique index if not exists uq_hermes_internal_execution_records_task_recorded_request
  on hermes_internal_execution_records (request_id)
  where status = 'internal_task_recorded';

-- Rollback (manual):
--   drop index if exists uq_hermes_internal_execution_records_task_recorded_request;
--   drop index if exists idx_hermes_internal_execution_records_status;
--   drop index if exists idx_hermes_internal_execution_records_request_id;
--   drop table if exists hermes_internal_execution_records;
