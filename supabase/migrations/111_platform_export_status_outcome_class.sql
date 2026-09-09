-- 111_platform_export_status_outcome_class.sql
-- PMC-EXPORT-SAFETY-2D (2026-09-09) — Marketplace-write outcome truth column.
--
-- Purpose:
--   ProductExporter currently persists status='failed' for any post-createProduct
--   error path, and retryFailedExports() then re-issues real marketplace writes
--   for those rows. This is unsafe: many failure branches (HTTP timeout after
--   send, connection reset after send, HTTP 5xx, adapter-returned
--   {success:false} on HTTP failure) are UNKNOWN_MAY_HAVE_CREATED — the
--   marketplace may already hold the listing. Retrying such rows duplicates.
--
-- This migration adds an evidence column that separates operational state
-- (export_status) from outcome truth (outcome_class). After 2D, retry only
-- picks rows where BOTH columns agree it is safe:
--   export_status='failed' AND outcome_class='confirmed_failure'.
--
-- Values written by application code:
--   'confirmed_success'         · positive success evidence + durable ID
--   'confirmed_failure'         · pre-createProduct failure (safe to retry)
--   'unknown_may_have_created'  · marketplace call was reached but outcome
--                                 cannot be proven (NEVER auto-retried)
--
-- Historical rows keep outcome_class = NULL — meaning "outcome was never
-- truthfully classified". NULL is deliberately treated as UNKNOWN by the
-- retry filter; do NOT auto-backfill historical rows to any value (that
-- would invent certainty we don't have).
--
-- No DEFAULT.  Any new write MUST specify outcome_class explicitly, so
-- forgetting to set it fails at the code review level rather than silently
-- classifying as CF.
--
-- No CHECK constraint.  Forward compatibility for future outcome classes
-- (e.g. 'confirmed_success_no_durable_id' or reconciliation states) should
-- not require a migration.  App code validates the values it writes.
--
-- No index.  Retry query volume is tiny (admin-triggered, no cron) and
-- the composite filter (export_status, retry_count, outcome_class) is
-- served by the existing (product_id, platform_id) unique index for
-- lookups. Add later if query evidence demands it.

ALTER TABLE platform_export_status
  ADD COLUMN IF NOT EXISTS outcome_class TEXT NULL;

COMMENT ON COLUMN platform_export_status.outcome_class IS
  'PMC-EXPORT-SAFETY-2D outcome truth. NULL=pre-2D historical (untrusted, treated as UNKNOWN by retry). Values: confirmed_success, confirmed_failure, unknown_may_have_created. NEVER auto-backfill.';
