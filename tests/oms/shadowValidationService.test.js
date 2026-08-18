'use strict';

/**
 * tests/oms/shadowValidationService.test.js — Phase 8O.
 *
 * READ-ONLY shadow-mode validator + anomaly classification.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runShadowValidation, ANOMALY_TYPE } = require('../../src/services/oms/shadowValidationService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function makeOwnerDecision(id, overrides = {}) {
  return {
    physical_product_id: id,
    generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH, priority_score: 100 + id, urgency_label: 'medium', confidence_level: 'low' },
    product: { title: `p${id}` },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    ...overrides,
  };
}

function makeDb(data) {
  return {
    from(table) {
      const rows = data[table] || [];
      return {
        select() { return this; },
        eq: async (c, v) => ({ data: rows.filter(r => r[c] === v), error: null }),
        in:  async (c, vs) => ({ data: rows.filter(r => vs.includes(r[c])), error: null }),
      };
    },
  };
}

function fullDb() {
  const now = Date.now();
  const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  return makeDb({
    sellable_units: [{ id: 10, display_name: 'BP', variant_kind: 'base', status: 'active' }, { id: 20, display_name: 'X', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }, { sellable_unit_id: 20, physical_product_id: 2, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }, { sku_master_id: 200, sellable_unit_id: 20 }],
    sku_master: [{ id: 100, internal_sku: 'BP', weight_gram: 500 }, { id: 200, internal_sku: 'X', weight_gram: 500 }],
    sku_listing_link: [{ sku_id: 100, listing_id: 'e_1', marketplace_sku: 'BP', is_primary: true }, { sku_id: 200, listing_id: 'e_2', marketplace_sku: 'X', is_primary: true }],
    ebay_products: [
      { item_id: 'e_1', sku: 'BP', price_usd: 75, shipping_usd: 6, updated_at: recent, status: 'active' },
      { item_id: 'e_2', sku: 'X',  price_usd: 40, shipping_usd: 4, updated_at: recent, status: 'active' },
    ],
  });
}

const opts = { autoSalePriceOpts: { usdKrw: 1350, usdKrwSource: 'pricing_safety_sot' }, autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 } };

// ─── Harness structure ────────────────────────────────

test('SV1. Runs across multiple physicals · returns per-row + summary', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1, 2],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db: fullDb(),
    ...opts,
  });
  assert.equal(r.count, 2);
  assert.equal(r.physicals.length, 2);
  assert.equal(r.summary.physicals_total, 2);
  assert.ok(r.summary.anomalies_by_type);
});

test('SV2. Full happy path · sale/shipping AUTO_OBSERVED · no MISSING_DATA sale_price/shipping', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db: fullDb(),
    ...opts,
  });
  const row = r.physicals[0];
  assert.equal(row.inputs_resolution.sale_price.resolution, 'AUTO_OBSERVED');
  assert.equal(row.inputs_resolution.shipping.resolution, 'AUTO_ESTIMATED');
  const kinds = row.anomalies.map(a => a.kind);
  assert.ok(!kinds.includes('sale_price_unknown'));
  assert.ok(!kinds.includes('shipping_unknown'));
});

// ─── Anomaly classifications ─────────────────────────

test('SV3. Missing FX → sale_price UNKNOWN → MISSING_DATA sale_price_unknown', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db: fullDb(),
    /* no autoSalePriceOpts.usdKrw */
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  const kinds = r.physicals[0].anomalies.map(a => a.kind);
  assert.ok(kinds.includes('sale_price_unknown'));
});

test('SV4. Missing dimensions → shipping UNKNOWN → MISSING_DATA shipping_unknown', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db: fullDb(),
    autoSalePriceOpts: { usdKrw: 1350 },
    /* no dims */
  });
  const kinds = r.physicals[0].anomalies.map(a => a.kind);
  assert.ok(kinds.includes('shipping_unknown'));
});

test('SV5. Stale listing (updated_at > 7d) → MISSING_DATA sale_price_stale', async () => {
  const stale = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const db = fullDb();
  //   Adjust the row directly via a fresh db
  const db2 = makeDb({
    sellable_units: [{ id: 10, display_name: 'BP', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }],
    sku_master: [{ id: 100, internal_sku: 'BP', weight_gram: 500 }],
    sku_listing_link: [{ sku_id: 100, listing_id: 'e_1', marketplace_sku: 'BP', is_primary: true }],
    ebay_products: [{ item_id: 'e_1', sku: 'BP', price_usd: 75, shipping_usd: 6, updated_at: stale, status: 'active' }],
  });
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db: db2,
    ...opts,
  });
  const kinds = r.physicals[0].anomalies.map(a => a.kind);
  assert.ok(kinds.includes('sale_price_stale'));
});

test('SV6. Listing status "ended" → MISSING_DATA listing_not_active', async () => {
  const db = makeDb({
    sellable_units: [{ id: 10, display_name: 'BP', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }],
    sku_master: [{ id: 100, internal_sku: 'BP', weight_gram: 500 }],
    sku_listing_link: [{ sku_id: 100, listing_id: 'e_1', marketplace_sku: 'BP', is_primary: true }],
    ebay_products: [{ item_id: 'e_1', sku: 'BP', price_usd: 75, shipping_usd: 6, updated_at: new Date().toISOString(), status: 'ended' }],
  });
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db, ...opts,
  });
  const kinds = r.physicals[0].anomalies.map(a => a.kind);
  assert.ok(kinds.includes('listing_not_active'));
});

test('SV7. accounting vs replacement divergence > 3× → POLICY_CANDIDATE', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id, {
      cost_context: { historical_typical_supplier_cost_krw_median: 5000, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    }),
    db: fullDb(),
    ...opts,
  });
  const kinds = r.physicals[0].anomalies.map(a => a.kind);
  assert.ok(kinds.includes('accounting_vs_replacement_divergence'));
  //   Verify classification is POLICY_CANDIDATE (never auto-corrected)
  const a = r.physicals[0].anomalies.find(x => x.kind === 'accounting_vs_replacement_divergence');
  assert.equal(a.type, ANOMALY_TYPE.POLICY_CANDIDATE);
});

test('SV8. Secondary market > 10× below replacement → POLICY_CANDIDATE outlier', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id, {
      cost_context: { historical_typical_supplier_cost_krw_median: 20000, historical_accounting_cost_krw: 20000, observed_secondary_market_ask_min_krw: 500 },
    }),
    db: fullDb(),
    ...opts,
  });
  const kinds = r.physicals[0].anomalies.map(a => a.kind);
  assert.ok(kinds.includes('secondary_market_outlier_far_below_replacement'));
});

test('SV9. Negative gross_profit → EXPECTED_BUSINESS_CONDITION (loss on aged stock)', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1],
    ownerDecisionFn: async (id) => makeOwnerDecision(id, {
      cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 200000, observed_secondary_market_ask_min_krw: 40000 },
    }),
    db: fullDb(),
    ...opts,
  });
  const a = r.physicals[0].anomalies.find(x => x.kind === 'negative_profit');
  assert.ok(a);
  assert.equal(a.type, ANOMALY_TYPE.EXPECTED_BUSINESS_CONDITION);
});

test('SV10. Summary aggregates counts by type + kind', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1, 2],
    ownerDecisionFn: async (id) => makeOwnerDecision(id),
    db: fullDb(),
    autoSalePriceOpts: {},   // no FX → both physicals get sale_price_unknown
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.ok(r.summary.anomalies_by_type[ANOMALY_TYPE.MISSING_DATA] >= 2);
  assert.ok(r.summary.anomalies_by_kind.sale_price_unknown >= 2);
});

test('SV11. Errored ownerDecision surfaces as row.error · other physicals continue', async () => {
  const r = await runShadowValidation({
    physicalProductIds: [1, 2],
    ownerDecisionFn: async (id) => {
      if (id === 1) throw new Error('unavailable');
      return makeOwnerDecision(id);
    },
    db: fullDb(),
    ...opts,
  });
  assert.equal(r.physicals[0].error?.stage, 'ownerDecision');
  assert.ok(!r.physicals[1].error);
  assert.equal(r.summary.physicals_errored, 1);
});

test('SV12. Never mutates DB · read-only contract', () => {
  //   Static assertion — verify no .insert/.update/.delete on shadowValidationService
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/services/oms/shadowValidationService.js'), 'utf8');
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.insert\s*\(/);
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.update\s*\(/);
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.delete\s*\(/);
});
