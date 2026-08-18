'use strict';

/**
 * tests/oms/financialMetricsOrchestrator.test.js — Phase 8O.
 *
 * Verifies manual-override > auto-observation > UNKNOWN priority.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFinancialMetricsWithAutoInputs } = require('../../src/services/oms/financialMetricsOrchestrator');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function makeOwnerDecision() {
  return {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
  };
}

function fullDb() {
  const now = Date.now();
  const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const data = {
    sellable_units: [{ id: 10, physical_product_id: 1 }],
    sellable_unit_components: [{ sellable_unit_id: 10, quantity_per_unit: 1 }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }],
    sku_master: [{ id: 100, internal_sku: 'BP-SKU', weight_gram: 500 }],
    sku_listing_link: [{ sku_id: 100, listing_id: 'e_1', marketplace_sku: 'BP-SKU', is_primary: true }],
    ebay_products: [{ item_id: 'e_1', sku: 'BP-SKU', price_usd: 75, shipping_usd: 6, updated_at: recent, status: 'active' }],
  };
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

const usdOpts = { autoSalePriceOpts: { usdKrw: 1350, usdKrwSource: 'pricing_safety_sot' } };

// ─── Priority: MANUAL > AUTO > UNKNOWN ────────────────

test('O1. Manual override always wins over auto observation', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    manual: { expected_sale_price_krw: 200000, expected_sale_price_source: 'owner_typed' },
    ...usdOpts,
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.equal(r.inputs_resolution.sale_price.resolution, 'MANUAL');
  assert.equal(r.inputs_resolution.sale_price.value, 200000);
  assert.equal(r.inputs_resolution.sale_price.source, 'owner_typed');
});

test('O2. No manual · auto observation succeeds · AUTO_OBSERVED', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    ...usdOpts,
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.equal(r.inputs_resolution.sale_price.resolution, 'AUTO_OBSERVED');
  assert.equal(r.inputs_resolution.sale_price.value, 101250);   // 75 × 1350
  assert.match(r.inputs_resolution.sale_price.source, /ebay_listing:e_1/);
});

test('O3. No manual · auto observation UNKNOWN (no FX) · resolution UNKNOWN · financial UNKNOWN', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    /* no autoSalePriceOpts.usdKrw */
  });
  assert.equal(r.inputs_resolution.sale_price.resolution, 'UNKNOWN');
  //   Financial metrics gross_profit UNKNOWN because proceeds UNKNOWN
  for (const s of Object.values(r.financial_metrics.scenarios)) {
    assert.equal(s.expected_sale_proceeds.status, 'UNKNOWN');
  }
});

test('O4. Manual shipping override wins over auto shipping candidate', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    manual: { seller_borne_shipping_krw: 5555, shipping_source: 'owner_typed_ship' },
    ...usdOpts,
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.equal(r.inputs_resolution.shipping.resolution, 'MANUAL');
  assert.equal(r.inputs_resolution.shipping.value, 5555);
});

test('O5. autoDisabled=true short-circuits both observations', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    autoDisabled: true,
    ...usdOpts,
  });
  assert.equal(r.inputs_resolution.sale_price.resolution, 'UNKNOWN');
  assert.equal(r.inputs_resolution.shipping.resolution, 'UNKNOWN');
  assert.match(r.inputs_resolution.sale_price.note, /disabled by caller/);
});

test('O6. Secondary market ask NEVER used as sale price fallback (contract)', async () => {
  //   Even if auto observation fails, orchestrator MUST return UNKNOWN — never
  //   substitute observed_secondary_market_ask_min_krw as sale price.
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    /* no usdKrw · auto observation returns UNKNOWN */
  });
  assert.equal(r.inputs_resolution.sale_price.value, null, 'never falls back to secondary market ask');
});

test('O7. Auto shipping ESTIMATED · financial gross_profit AVAILABLE', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    ...usdOpts,
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.equal(r.inputs_resolution.shipping.resolution, 'AUTO_ESTIMATED');
  assert.ok(r.inputs_resolution.shipping.value > 0);
  //   Financial metrics compute for all 3 scenarios
  assert.equal(r.financial_metrics.scenarios.accounting.gross_profit.status, 'AVAILABLE');
});

test('O8. Sale price note surfaces "NOT a verified sale price" caveat when AUTO_OBSERVED', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    ...usdOpts,
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.match(r.inputs_resolution.sale_price.note, /NOT a verified sale price/);
});

test('O9. Shipping resolution surfaces auto_observation candidate for audit', async () => {
  const r = await buildFinancialMetricsWithAutoInputs({
    ownerDecision: makeOwnerDecision(), db: fullDb(),
    ...usdOpts,
    autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  });
  assert.ok(r.inputs_resolution.shipping.auto_observation);
  assert.equal(r.inputs_resolution.shipping.auto_observation.status, 'ESTIMATED');
});

test('O10. No ownerDecision → throw', async () => {
  await assert.rejects(() => buildFinancialMetricsWithAutoInputs({}), /ownerDecision required/);
});
