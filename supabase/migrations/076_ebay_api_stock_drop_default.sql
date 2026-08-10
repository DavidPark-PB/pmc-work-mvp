-- 076_ebay_api_stock_drop_default.sql
--
-- Phase 1 Commit 8 — remove the silent UNKNOWN → 0 corruption at the schema level.
--
-- Problem: ebay_products.ebay_api_stock was created (out-of-band ALTER, no prior
-- migration in this repo) as INTEGER with DEFAULT 0. Every INSERT that did not
-- supply a value stored 0, making it impossible to distinguish "we have not
-- synced yet / eBay returned null" from "actual sold out". Downstream code
-- (hermesExecutionApproval overstock / slow_mover signals, skuContextBuilder
-- inventory canonicalisation) then treated 0 as authoritative, feeding wrong
-- signals into the operator dashboards.
--
-- Owner directive (2026-08-10): UNKNOWN ≠ ZERO. Nullable stays; DEFAULT goes.
--
-- Preflight before applying (2026-08-10, ccorea.dev@gmail.com's Project):
--   total_rows              9686
--   ebay_api_stock non-null 9686  (100% — every historical row was filled by DEFAULT 0)
--   ebay_api_stock = 0      1022  (mixed: some real sold-out, some historical UNKNOWN,
--                                  irrecoverable — future syncs will overwrite as they run)
--   ebay_api_stock > 0      8664
--   ebay_api_stock < 0         0  (no invalid data)
--
-- This migration:
--   * DROP DEFAULT on ebay_products.ebay_api_stock
--   * Adds a COMMENT that documents the UNKNOWN semantics
--   * Leaves existing rows untouched (non-destructive)
--   * Does NOT touch ebay_products.stock (local editable field — separate phase
--     decides whether its DEFAULT 0 is semantic or a bug)
--
-- Rollback:
--   ALTER TABLE ebay_products ALTER COLUMN ebay_api_stock SET DEFAULT 0;

ALTER TABLE ebay_products
  ALTER COLUMN ebay_api_stock DROP DEFAULT;

COMMENT ON COLUMN ebay_products.ebay_api_stock IS
  'Last quantity observed from eBay Trading API. '
  'NULL = never synced or last read returned null (UNKNOWN). '
  '0 = actual sold-out confirmed by eBay. '
  'Positive = known available. '
  'NEVER default to 0 in code — UNKNOWN != ZERO.';
