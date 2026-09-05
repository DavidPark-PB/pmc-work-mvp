-- 109_recurring_expense_atomic.sql
-- Owner Directive (2026-09-05) · Refactor R1-D1-B · Recurring expense
--   DB-level idempotency + atomic occurrence.
--
-- Why this migration:
--   R1-D1-A introduced a per-rule distributed lease around recurringRepository
--   .fire() so that two Node processes cannot double-INSERT the same recurring
--   expense during a Railway rolling deploy. Lease is best-effort · it does
--   NOT survive a crash between the expense INSERT and the recurring_payments
--   UPDATE. Next tick re-fires the same occurrence · duplicate row.
--
--   Company-level effect: expenseRepository.summaryByMonth() (finance dash-
--   board) sums every expenses row regardless of source · so a duplicate
--   recurring row silently inflates the owner's monthly total. SKU/order
--   profit is unaffected (listingProfitabilityCalculator / omsProfitService
--   never touch expenses) but the monthly finance view IS wrong.
--
-- Design (3-layer defense):
--   Layer 1 · R1-D1-A distributed lease           · concurrent-run block
--   Layer 2 · fire_recurring_expense_atomic RPC   · single tx · row lock ·
--                                                   optimistic-occurrence
--                                                   check · crash-replay
--                                                   recovery
--   Layer 3 · partial UNIQUE (recurring_id, paid_at) WHERE source='recurring'
--                                                 · final DB-level backstop
--
--   Even if Layers 1 + 2 both fail (e.g. someone bypasses the RPC and
--   INSERTs directly into expenses with source='recurring'), Layer 3 rejects
--   the duplicate at the DB. All three layers must fail for a bad row to
--   appear.
--
-- Canonical occurrence identity: (recurring_id, paid_at)
--   Both columns are `date` (verified pre-migration). recurring.nextDueAt
--   flows directly into paid_at at fire time, and JS-side toIsoDate()
--   already normalises to KST YYYY-MM-DD. No timezone drift possible.
--
-- Manual /:id/run semantic (verified pre-migration):
--   Each manual click fires the current occurrence AND advances the schedule.
--   A second click emits a NEW occurrence at the newly-advanced date · so
--   two clicks produce two rows with DIFFERENT paid_at. The UNIQUE partial
--   index does NOT block intentional back-to-back manual runs · they use
--   different paid_at values.
--
-- Migration safety:
--   · Additive only · CREATE UNIQUE INDEX IF NOT EXISTS · CREATE OR REPLACE
--   · No DROP · no destructive statement
--   · No expense row modification · no backfill
--   · Idempotent · safe to re-run
--   · Pre-audit shows 0 existing duplicates in production · UNIQUE creation
--     will not fail on legacy data
--
-- Rollback (informational · do NOT run in production):
--   drop function if exists fire_recurring_expense_atomic(
--     integer, date, date, numeric, text, text, text, text, text, integer);
--   drop index if exists expenses_recurring_occurrence_uniq;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Partial UNIQUE · canonical occurrence identity backstop
-- ══════════════════════════════════════════════════════════════════════════
-- Enforces at DB level: at most one expense row per (recurring_id, paid_at)
-- when the row is a recurring occurrence. Manual expenses (source='manual'
-- or 'csv') and recurring_id-less rows are ignored.
create unique index if not exists expenses_recurring_occurrence_uniq
  on expenses (recurring_id, paid_at)
  where source = 'recurring' and recurring_id is not null;

comment on index expenses_recurring_occurrence_uniq is
  'R1-D1-B · one recurring occurrence per (rule, date) · backstop for the atomic RPC. Owner (2026-09-05).';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. fire_recurring_expense_atomic · single-tx canonical fire operation
-- ══════════════════════════════════════════════════════════════════════════
-- Owner rule: JS is the SoT for schedule calculation (advanceDueDate).
-- The RPC receives the expected current occurrence AND the pre-computed
-- next occurrence · does not re-derive the schedule · only validates and
-- persists atomically.
--
-- Outcomes:
--   'CREATED'          new expense INSERT + next_due_at advanced (normal path)
--   'ALREADY_EXISTS'   expense for this (rule, occurrence) already exists ·
--                      next_due_at was still at expected_occurrence (crash
--                      recovery path) · schedule advanced · no double INSERT
--   'STALE_OCCURRENCE' recurring_payments.next_due_at no longer equals
--                      expected_occurrence · another instance/run already
--                      moved the schedule forward · nothing to do

create or replace function fire_recurring_expense_atomic(
  p_recurring_id       integer,
  p_expected_occurrence date,
  p_next_occurrence    date,
  p_amount             numeric,
  p_currency           text,
  p_category           text,
  p_merchant           text,
  p_memo               text,
  p_card_last4         text,
  p_created_by         integer
) returns table(
  outcome      text,
  expense_id   integer,
  occurrence   date,
  next_due_at  date
)
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_row_current_due date;
  v_expense_id      integer;
begin
  -- ── input validation ───────────────────────────────────────────────────
  if p_recurring_id is null then
    raise exception 'recurring_id required' using errcode = '22023';
  end if;
  if p_expected_occurrence is null then
    raise exception 'expected_occurrence required' using errcode = '22023';
  end if;
  if p_next_occurrence is null then
    raise exception 'next_occurrence required' using errcode = '22023';
  end if;
  if p_next_occurrence <= p_expected_occurrence then
    raise exception 'next_occurrence (%) must be after expected (%)',
      p_next_occurrence, p_expected_occurrence using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'amount must be >= 0' using errcode = '22023';
  end if;
  if p_currency is null or p_currency = '' then
    raise exception 'currency required' using errcode = '22023';
  end if;
  if p_category is null or p_category = '' then
    raise exception 'category required' using errcode = '22023';
  end if;

  -- ── row lock ───────────────────────────────────────────────────────────
  -- Two transactions racing on the same recurring_id serialise here.
  -- Lease (R1-D1-A) is the fast path · this is the DB-level fallback.
  select next_due_at
    into v_row_current_due
    from recurring_payments
   where id = p_recurring_id
   for update;

  if v_row_current_due is null then
    raise exception 'recurring_payments not found: %', p_recurring_id
      using errcode = 'P0002';
  end if;

  -- ── stale caller protection ────────────────────────────────────────────
  -- The caller read next_due_at at some point earlier. If it changed under
  -- them, another instance/run has already advanced the schedule. Do NOT
  -- INSERT a new expense · do NOT advance again.
  if v_row_current_due <> p_expected_occurrence then
    return query select 'STALE_OCCURRENCE'::text, null::integer,
                        v_row_current_due, v_row_current_due;
    return;
  end if;

  -- ── crash-replay recovery ──────────────────────────────────────────────
  -- If next_due_at is still expected_occurrence AND an expense for this
  -- occurrence already exists, we crashed between INSERT and UPDATE last
  -- time. Recover: advance the schedule, return ALREADY_EXISTS · no new
  -- INSERT.
  select id
    into v_expense_id
    from expenses
   where recurring_id = p_recurring_id
     and paid_at      = p_expected_occurrence
     and source       = 'recurring'
   limit 1;

  if v_expense_id is not null then
    update recurring_payments
       set next_due_at = p_next_occurrence,
           updated_at  = now()
     where id = p_recurring_id;
    return query select 'ALREADY_EXISTS'::text, v_expense_id,
                        p_expected_occurrence, p_next_occurrence;
    return;
  end if;

  -- ── normal path · INSERT expense + advance recurring ────────────────────
  -- Layer 3 (partial UNIQUE) would reject a bad row if the check above
  -- somehow missed a duplicate · the exception would bubble up as 23505
  -- and the caller catches it as an unexpected failure (not the normal
  -- ALREADY_EXISTS recovery). In practice we hold the row lock so this is
  -- unreachable.
  insert into expenses (
    paid_at, amount, currency, category, merchant, memo,
    source, card_last4, recurring_id, created_by
  ) values (
    p_expected_occurrence, p_amount, p_currency, p_category, p_merchant, p_memo,
    'recurring', p_card_last4, p_recurring_id, p_created_by
  )
  returning id into v_expense_id;

  update recurring_payments
     set next_due_at = p_next_occurrence,
         updated_at  = now()
   where id = p_recurring_id;

  return query select 'CREATED'::text, v_expense_id,
                      p_expected_occurrence, p_next_occurrence;
end;
$$;

comment on function fire_recurring_expense_atomic is
  'R1-D1-B · one recurring occurrence · atomic · row-locked · stale-safe · Owner (2026-09-05).';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. Permission hardening · backend service_role only (same pattern as 108)
-- ══════════════════════════════════════════════════════════════════════════
-- Postgres CREATE FUNCTION defaults EXECUTE to PUBLIC. Locking down keeps
-- anon/authenticated PostgREST callers from firing arbitrary expense rows.
-- Scheduler code always calls with SUPABASE_SERVICE_KEY.

revoke execute on function fire_recurring_expense_atomic(
  integer, date, date, numeric, text, text, text, text, text, integer
) from public;

do $revoke_anon$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function fire_recurring_expense_atomic('
         || 'integer, date, date, numeric, text, text, text, text, text, integer'
         || ') from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function fire_recurring_expense_atomic('
         || 'integer, date, date, numeric, text, text, text, text, text, integer'
         || ') from authenticated';
  end if;
end $revoke_anon$;

do $grant_service$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function fire_recurring_expense_atomic('
         || 'integer, date, date, numeric, text, text, text, text, text, integer'
         || ') to service_role';
  end if;
end $grant_service$;
