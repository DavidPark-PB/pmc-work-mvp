-- 110_orders_tracking_provenance.sql
-- Owner Directive (2026-09-06) · R2-SHIP-6F1A · Provenance foundation for tracking.
--
-- Goal:
--   Enable safe SAFE_INSERT_ONLY tracking imports (from eBay observation, from
--   direct carrier API returns, from any future manual entry) with a stamped
--   source + observation timestamp + import timestamp. Today the `orders` table
--   has only `carrier TEXT` + `tracking_no TEXT` and no way to distinguish
--   "eBay says this tracking is attached to the order" (marketplace observation)
--   from "carrier API returned this on registration" (positive shipment evidence)
--   from historical unknown-provenance rows.
--
-- Additive · idempotent · zero destructive change:
--   · 3 nullable columns · no NOT NULL · no DEFAULT
--   · zero UPDATE of historical rows — existing 8 tracked rows keep
--     tracking_source=NULL, tracking_observed_at=NULL, tracking_imported_at=NULL.
--     Known value ≠ known provenance. Fabricating provenance for the 7 KP + 1
--     FedEx historical rows would misrepresent audit truth (we don't know when
--     they were actually observed vs when the row was last touched by any
--     write). Owner directive: never invent provenance.
--   · No CHECK constraint · caller responsibility to write valid enum values
--     (recommended: 'ebay_observation' · 'koreapost_api' · 'fedex_api' ·
--     'manual' · 'migration'). Constraints can be added later once writers
--     stabilize.
--   · IF NOT EXISTS guards make migration re-runnable.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tracking_source        TEXT,
  ADD COLUMN IF NOT EXISTS tracking_observed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracking_imported_at   TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.tracking_source IS
  'Source of tracking_no observation. Recommended enum values: '
  '''ebay_observation'' (eBay Trading GetOrders ShipmentTrackingDetails · marketplace observation · NOT carrier confirmation), '
  '''koreapost_api'' (Korea Post regino returned by createKPacketParcel/createDomesticOrder), '
  '''fedex_api'' (FedEx masterTrackingNumber returned by createShipment), '
  '''manual'' (owner-typed via PMC UI · not yet implemented), '
  '''migration'' (historical bulk backfill · not yet used). '
  'NULL for historical rows written before this column existed (do not invent).';

COMMENT ON COLUMN public.orders.tracking_observed_at IS
  'Timestamp at which the source system claims to have observed the tracking. '
  'Populate ONLY if the source explicitly returns a tracking-specific timestamp. '
  'Do NOT substitute order ModifiedTime / CreatedTime / orders.updated_at / NOW(). '
  'NULL is the correct value when no verified observation timestamp exists.';

COMMENT ON COLUMN public.orders.tracking_imported_at IS
  'Server-clock timestamp when tracking_no was written to this row by the PMC '
  'writer. This is always genuinely known at write time · never invented for '
  'historical rows.';

COMMIT;
