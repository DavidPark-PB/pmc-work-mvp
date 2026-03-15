-- Add package dimension columns to products for volumetric weight calculation
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS box_length NUMERIC(8,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS box_width  NUMERIC(8,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS box_height NUMERIC(8,1) DEFAULT 0;
-- Units: cm
-- Volumetric weight (kg) = box_length * box_width * box_height / 5000
