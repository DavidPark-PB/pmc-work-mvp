-- 113_sku_master_dimensions.sql
-- PMC-CCOREA-SHIPPING-1B (2026-09-13).
--
-- Adds package dimensions to the canonical sku_master so the shipping quote
-- engine can compute volumetric weight (spec §4 rule 2) at the SKU-master
-- boundary. Existing product-side dims on `products.box_length/box_width/
-- box_height` remain untouched — they continue to serve the legacy sheets-
-- driven listing surface. The new columns are additive and optional; queries
-- that read them must handle NULL (product without registered dimensions
-- cannot be auto-listed — flagged as INSUFFICIENT_DIMENSIONS by the quote
-- engine, see spec §8).
--
-- Rollback (manual):
--   alter table sku_master drop column if exists height_cm;
--   alter table sku_master drop column if exists width_cm;
--   alter table sku_master drop column if exists length_cm;
--   drop index if exists idx_sku_master_dim_present;

alter table sku_master
  add column if not exists length_cm numeric(6,1),
  add column if not exists width_cm  numeric(6,1),
  add column if not exists height_cm numeric(6,1);

-- Partial index — supports "which SKUs are ready to auto-list?" queries.
create index if not exists idx_sku_master_dim_present
  on sku_master(id)
  where length_cm is not null
    and width_cm  is not null
    and height_cm is not null;
