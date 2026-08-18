'use strict';

/**
 * tests/oms/salePriceObservationService.test.js — Phase 8O.
 *
 * READ-ONLY sale-price candidate projection.
 * Uses stub db · zero real DB / marketplace.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeSalePriceCandidate, CANDIDATE_STATUS, FRESHNESS_POLICY_DAYS } = require('../../src/services/oms/salePriceObservationService');

// ─── Stub DB ─────────────────────────────────────────────

function makeStubDb(data) {
  return {
    from(table) {
      const rows = data[table] || [];
      return {
        select() { return this; },
        eq: async (col, val) => ({ data: rows.filter(r => r[col] === val), error: null }),
        in:  async (col, vals) => ({ data: rows.filter(r => vals.includes(r[col])), error: null }),
      };
    },
  };
}

// Full lineage: physical 1 → sellable_unit 10 → components qty=1 →
// sku_master_link → sku_master 100 → sku_listing_link (item_id 'e_1') →
// ebay_products row with price_usd
function completeFixture(overrides = {}) {
  const now = Date.now();
  const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();   // 1d ago
  return {
    sellable_units: [{ id: 10, display_name: 'BP 1-Box', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }],
    sku_master: [{ id: 100, internal_sku: 'BP-SKU', weight_gram: 500 }],
    sku_listing_link: [{ sku_id: 100, listing_id: 'e_1', marketplace_sku: 'BP-SKU', is_primary: true }],
    ebay_products: [{ item_id: 'e_1', sku: 'BP-SKU', price_usd: 75, shipping_usd: 6, updated_at: recent, status: 'active' }],
    ...overrides,
  };
}

const opts = { usdKrw: 1350, usdKrwSource: 'pricing_safety_sot', usdKrwObservedAt: '2026-08-18T00:00:00Z' };

// ─── Happy path ─────────────────────────────────────

test('SP1. Full lineage · returns OBSERVED_LISTING_PRICE with FX-converted KRW', async () => {
  const db = makeStubDb(completeFixture());
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.status, 'OBSERVED_LISTING_PRICE');
  assert.equal(r.amount_native, 75);
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount_krw, 101250);   // 75 × 1350
  assert.equal(r.shipping_native, 6);
  assert.equal(r.shipping_krw, 8100);
  assert.equal(r.listing_id, 'e_1');
  assert.equal(r.listing_status, 'active');
  assert.equal(r.freshness_status, 'FRESH');
  assert.equal(r.fx_rate, 1350);
});

test('SP2. FX not supplied → UNKNOWN · amount_krw null · native KRW/currency still surfaced for audit', async () => {
  const db = makeStubDb(completeFixture());
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db /* no usdKrw */ });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'fx_usd_to_krw_unavailable');
  assert.equal(r.amount_krw, null);
  assert.equal(r.amount_native, 75, 'native price still surfaced for Owner audit');
  assert.equal(r.currency, 'USD');
});

test('SP3. Stale listing (>7d updated_at) → freshness_status STALE · candidate still returned', async () => {
  const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fx = completeFixture();
  fx.ebay_products[0].updated_at = stale;
  const db = makeStubDb(fx);
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.freshness_status, 'STALE');
  assert.equal(r.status, 'OBSERVED_LISTING_PRICE', 'stale but still returned · caller decides trust');
});

test('SP4. Non-ACTIVE listing status → prefers ACTIVE if any · else falls back', async () => {
  const fx = completeFixture();
  //   Two rows: one 'ended' (recent), one 'active' (older but active). Should prefer active.
  fx.ebay_products = [
    { item_id: 'e_1', sku: 'BP-SKU', price_usd: 99, shipping_usd: 0, updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'ended' },
    { item_id: 'e_2', sku: 'BP-SKU', price_usd: 75, shipping_usd: 6, updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), status: 'active' },
  ];
  fx.sku_listing_link.push({ sku_id: 100, listing_id: 'e_2', marketplace_sku: 'BP-SKU', is_primary: false });
  const db = makeStubDb(fx);
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.listing_id, 'e_2', 'active listing preferred over ended even if ended is newer');
  assert.equal(r.amount_native, 75);
});

test('SP5. No sellable_unit → UNKNOWN reason=no_sellable_unit_for_physical', async () => {
  const db = makeStubDb({});
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'no_sellable_unit_for_physical');
});

test('SP6. No sku_listing_link but sku exists → falls back to lookup by sku', async () => {
  const fx = completeFixture();
  fx.sku_listing_link = [];
  const db = makeStubDb(fx);
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.status, 'OBSERVED_LISTING_PRICE');
  assert.equal(r.marketplace_sku, 'BP-SKU');
});

test('SP7. ebay_products.price_usd = 0 or negative → UNKNOWN (never treats 0 as valid listing)', async () => {
  const fx = completeFixture();
  fx.ebay_products[0].price_usd = 0;
  const db = makeStubDb(fx);
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'ebay_price_missing_or_nonpositive');
});

test('SP8. Secondary market ask NEVER used as sale price fallback (contract test)', async () => {
  //   Even if the caller has secondary market observations, this service
  //   only reads ebay_products.price_usd. The absence of ebay data → UNKNOWN.
  const fx = completeFixture();
  fx.ebay_products = [];   // no ebay data
  const db = makeStubDb(fx);
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'no_ebay_product_row');
});

test('SP9. Confidence note surfaces "not a verified sale price" caveat', async () => {
  const db = makeStubDb(completeFixture());
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts });
  assert.match(r.confidence_note, /not a verified sale price/);
});

test('SP10. injected asOfMs deterministic freshness · exactly at 7-day boundary is FRESH', async () => {
  //   FRESHNESS_POLICY_DAYS = 7 → age <= 7d is FRESH
  const asOfMs = Date.parse('2026-08-18T00:00:00Z');
  const sevenDaysAgo = new Date(asOfMs - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fx = completeFixture();
  fx.ebay_products[0].updated_at = sevenDaysAgo;
  const db = makeStubDb(fx);
  const r = await observeSalePriceCandidate({ physicalProductId: 1, db, ...opts, asOfMs });
  assert.equal(r.freshness_status, 'FRESH');
});

test('SP11. Rejects invalid physicalProductId', async () => {
  await assert.rejects(() => observeSalePriceCandidate({ physicalProductId: 0, db: makeStubDb({}), ...opts }), /positive integer/);
});

test('SP12. Rejects missing db (production DB never auto-selected)', async () => {
  await assert.rejects(() => observeSalePriceCandidate({ physicalProductId: 1, ...opts }), /db.*required/);
});

// ─── Phase 8P-2b · schema-contract regression ───────

test('SP-8P2b-1. Source NEVER selects sellable_units.physical_product_id (migration 086 has no such column)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/salePriceObservationService.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(
    stripped,
    /['"]sellable_units['"][\s\S]{0,300}?physical_product_id/i,
    'salePriceObservationService must NOT couple sellable_units with physical_product_id',
  );
  assert.match(
    stripped,
    /['"]sellable_unit_components['"][\s\S]{0,300}?physical_product_id/i,
    'salePriceObservationService MUST source physical_product_id from sellable_unit_components',
  );
});

test('SP-8P2b-2. Migration 086/087 · sellable_units has no physical_product_id · sellable_unit_components has it', () => {
  const fs = require('fs');
  const path = require('path');
  const m086 = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/086_sellable_units.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const m087 = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/087_sellable_unit_components.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(m086, /physical_product_id/);
  assert.match(m087, /\bphysical_product_id\b/);
});
