-- 075_automation_runs_request_id.sql
--
-- Phase 1 Commit 2 (Price Execution Gate) prerequisite.
--
-- Add persistent idempotency key to automation_runs so PriceExecutionGate
-- (and any future user-initiated mutation) can rely on DB-enforced
-- uniqueness rather than in-memory maps.
--
-- Why automation_runs (not price_events):
--   040_safety_foundation.sql already designates automation_runs as the
--   canonical execution audit log for ALL user-initiated actions
--   (including future 'price_change'). Reusing it keeps price_events
--   append-only and preserves the existing safetyExec.js pattern.
--
-- Why the WHERE-NULL partial index:
--   Existing rows (Phase 1..3 automations) predate request_id and stay
--   NULL. NULL != NULL in PostgreSQL UNIQUE semantics, but the partial
--   index makes intent explicit and keeps the index small.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS request_id text;

COMMENT ON COLUMN automation_runs.request_id IS
  'Client-supplied idempotency key. UNIQUE across all automation_runs when set. '
  'PriceExecutionGate rejects a re-issued request_id by returning the prior run''s outcome.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_request_id
  ON automation_runs(request_id)
  WHERE request_id IS NOT NULL;
