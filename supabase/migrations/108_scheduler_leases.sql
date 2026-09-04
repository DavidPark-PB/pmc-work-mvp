-- 108_scheduler_leases.sql
-- Owner Directive (2026-09-04) · Refactor R1-A · Distributed scheduler lease primitive.
--
-- Goal:
--   Provide a distributed lock/lease mechanism for background scheduler jobs so that
--   a rolling deploy · multi-instance topology · in-process overlap · or crashed
--   Node process cannot produce duplicate money-facing writes (eBay repricing,
--   expense ledger fires, marketplace ingestion double-upsert, etc.).
--
-- Why a lease table + RPC (not pg_advisory_lock):
--   The app talks to Postgres only via @supabase/supabase-js (HTTP · PostgREST).
--   PostgREST does not preserve a stable session between calls · the transaction
--   pooler reassigns backend connections per request. Session-scoped advisory
--   locks (`pg_advisory_lock`) and transaction-scoped ones (`pg_advisory_xact_lock`)
--   cannot fence a Node-side job that runs for minutes.
--
--   A row-based lease · atomically acquired via `INSERT ... ON CONFLICT DO UPDATE
--   WHERE expires_at <= NOW()` · fits the HTTP call model exactly. Ownership is
--   tracked by two columns (owner_id · run_id) so:
--     · owner_id  = the Node process identity (host + pid + boot uuid)
--     · run_id    = the individual withLease() invocation identity (per-call UUID)
--
--   Same-process overlap (two runs of the same job in the same process) is
--   REJECTED because run_id differs even when owner_id is identical. This is
--   the deliberate correction to the initial design.
--
--   Ownership fencing on heartbeat/release requires (lock_key, owner_id, run_id)
--   to all match. A stale runner whose lease expired and was taken over by
--   another run cannot heartbeat or release the winner's row.
--
-- Contract:
--   All three functions are `security invoker` (default) · called with the
--   service_role key from server-side scheduler code. Not intended for anon.
--   `search_path` pinned to `public, pg_catalog` to prevent search_path
--   hijacking (defensive · service_role is trusted but least-surprise).
--
-- Safety:
--   · Additive only · CREATE TABLE / INDEX / FUNCTION IF NOT EXISTS · CREATE OR REPLACE
--   · No DROP · no destructive statement
--   · Re-runnable · idempotent
--   · Zero effect on any existing table
--
-- Rollback (informational · do NOT run in production):
--   drop function if exists release_scheduler_lease(text, text, text);
--   drop function if exists heartbeat_scheduler_lease(text, text, text, integer);
--   drop function if exists acquire_scheduler_lease(text, text, text, integer);
--   drop index if exists idx_scheduler_leases_expires;
--   drop table if exists scheduler_leases;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. scheduler_leases · one row per active lease.
-- ══════════════════════════════════════════════════════════════════════════
create table if not exists scheduler_leases (
  lock_key      text        primary key,
  owner_id      text        not null,
  run_id        text        not null,
  acquired_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  heartbeat_at  timestamptz not null default now(),
  metadata      jsonb
);

-- Index for the (rare) sweep query · not required by acquire/heartbeat/release
-- (those use the primary key) but useful for observability dashboards that
-- want to list expired leases.
create index if not exists idx_scheduler_leases_expires
  on scheduler_leases (expires_at);

comment on table scheduler_leases is
  'R1-A · distributed lease rows keyed by lock_key. Ownership = (owner_id, run_id). Expired rows may be taken over by the next acquire. No PII.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. acquire_scheduler_lease · atomic acquire (single statement · race-safe).
-- ══════════════════════════════════════════════════════════════════════════
-- Returns exactly one row:
--   acquired         boolean · true iff caller owns the lease after this call
--   current_owner_id text    · owner_id currently holding the lease (may be caller)
--   current_run_id   text    · run_id currently holding the lease (may be caller)
--   expires_at       timestamptz · current expiry
--
-- Success semantics:
--   · lock row absent           → INSERT · acquired=true
--   · lock row present, expired → UPDATE (WHERE expires_at <= now()) · acquired=true
--   · lock row present, alive   → no-op · acquired=false · returns holder info
--   · same owner_id, different run_id, lease alive → acquired=false
--     (same-process overlap protection · deliberate)
--   · same owner_id + same run_id → refresh path succeeds (retry-safe · same
--     invocation calling twice); note that withLease() never does this because
--     it generates a fresh run_id per invocation.

create or replace function acquire_scheduler_lease(
  p_lock_key    text,
  p_owner_id    text,
  p_run_id      text,
  p_ttl_seconds integer
) returns table(
  acquired         boolean,
  current_owner_id text,
  current_run_id   text,
  expires_at       timestamptz
)
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_now          timestamptz := now();
  v_new_expires  timestamptz;
  v_row_owner    text;
  v_row_run      text;
  v_row_expires  timestamptz;
begin
  -- ── input validation ────────────────────────────────────────────────────
  if p_lock_key is null or p_lock_key = '' then
    raise exception 'lock_key required' using errcode = '22023';
  end if;
  if p_owner_id is null or p_owner_id = '' then
    raise exception 'owner_id required' using errcode = '22023';
  end if;
  if p_run_id is null or p_run_id = '' then
    raise exception 'run_id required' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'ttl_seconds must be > 0' using errcode = '22023';
  end if;
  if p_ttl_seconds > 86400 then
    raise exception 'ttl_seconds must be <= 86400' using errcode = '22023';
  end if;

  v_new_expires := v_now + make_interval(secs => p_ttl_seconds);

  -- ── atomic acquire ─────────────────────────────────────────────────────
  --   Single INSERT ... ON CONFLICT UPDATE statement. Postgres serializes
  --   concurrent statements on the same primary key via row-level locking.
  --   The ON CONFLICT UPDATE only fires when the existing row is expired
  --   OR when the caller is the SAME owner+run (retry idempotency).
  --   Different run_id in the same owner cannot take over an unexpired lease.
  insert into scheduler_leases as l
    (lock_key, owner_id, run_id, acquired_at, expires_at, heartbeat_at)
  values
    (p_lock_key, p_owner_id, p_run_id, v_now, v_new_expires, v_now)
  on conflict (lock_key) do update
    set owner_id     = excluded.owner_id,
        run_id       = excluded.run_id,
        acquired_at  = excluded.acquired_at,
        expires_at   = excluded.expires_at,
        heartbeat_at = excluded.heartbeat_at
    where l.expires_at <= v_now
       or (l.owner_id = excluded.owner_id and l.run_id = excluded.run_id);

  -- ── read back winner ───────────────────────────────────────────────────
  select l.owner_id, l.run_id, l.expires_at
    into v_row_owner, v_row_run, v_row_expires
    from scheduler_leases l
   where l.lock_key = p_lock_key;

  if v_row_owner = p_owner_id and v_row_run = p_run_id then
    return query select true, v_row_owner, v_row_run, v_row_expires;
  else
    return query select false, v_row_owner, v_row_run, v_row_expires;
  end if;
end;
$$;

comment on function acquire_scheduler_lease is
  'R1-A · atomic scheduler lease acquire · rejects same-process overlap when run_id differs · Owner (2026-09-04).';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. heartbeat_scheduler_lease · extend expiry · ownership-fenced.
-- ══════════════════════════════════════════════════════════════════════════
-- Only the (owner_id, run_id) that currently holds an unexpired lease can
-- heartbeat. A stale runner whose lease was taken over by another run gets
-- ok=false and MUST stop working (and reflect leaseLost=true up the stack).

create or replace function heartbeat_scheduler_lease(
  p_lock_key    text,
  p_owner_id    text,
  p_run_id      text,
  p_ttl_seconds integer
) returns table(
  ok         boolean,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_now         timestamptz := now();
  v_new_expires timestamptz;
  v_expires     timestamptz;
  v_rows        integer;
begin
  if p_lock_key is null or p_lock_key = '' then
    raise exception 'lock_key required' using errcode = '22023';
  end if;
  if p_owner_id is null or p_owner_id = '' then
    raise exception 'owner_id required' using errcode = '22023';
  end if;
  if p_run_id is null or p_run_id = '' then
    raise exception 'run_id required' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 86400 then
    raise exception 'ttl_seconds must be 1..86400' using errcode = '22023';
  end if;

  v_new_expires := v_now + make_interval(secs => p_ttl_seconds);

  update scheduler_leases
     set heartbeat_at = v_now,
         expires_at   = v_new_expires
   where lock_key   = p_lock_key
     and owner_id   = p_owner_id
     and run_id     = p_run_id
     and expires_at > v_now;

  get diagnostics v_rows = row_count;

  select l.expires_at into v_expires
    from scheduler_leases l
   where l.lock_key = p_lock_key;

  return query select (v_rows = 1), v_expires;
end;
$$;

comment on function heartbeat_scheduler_lease is
  'R1-A · extend lease · requires (lock_key, owner_id, run_id) all match AND lease unexpired.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. release_scheduler_lease · delete row · ownership-fenced.
-- ══════════════════════════════════════════════════════════════════════════
-- Only the (owner_id, run_id) that owns the lease can delete it. A stale
-- runner attempting to release after its lease was taken over returns false
-- and the surviving winner's row is untouched.

create or replace function release_scheduler_lease(
  p_lock_key text,
  p_owner_id text,
  p_run_id   text
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_rows integer;
begin
  if p_lock_key is null or p_lock_key = '' then
    raise exception 'lock_key required' using errcode = '22023';
  end if;
  if p_owner_id is null or p_owner_id = '' then
    raise exception 'owner_id required' using errcode = '22023';
  end if;
  if p_run_id is null or p_run_id = '' then
    raise exception 'run_id required' using errcode = '22023';
  end if;

  delete from scheduler_leases
   where lock_key = p_lock_key
     and owner_id = p_owner_id
     and run_id   = p_run_id;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

comment on function release_scheduler_lease is
  'R1-A · release lease · requires (lock_key, owner_id, run_id) all match · fence stale runners.';
