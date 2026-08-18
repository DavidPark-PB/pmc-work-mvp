'use strict';

/**
 * tests/oms/financialMetricsOrchestrator8P.test.js — Phase 8P.
 *
 * Verifies the extended priority order:
 *   1. MANUAL
 *   2. AUTO_SOLD_MEDIAN     (Phase 8P · new)
 *   3. AUTO_OBSERVED        (Phase 8O listing candidate)
 *   4. UNKNOWN
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFinancialMetricsWithAutoInputs } = require('../../src/services/oms/financialMetricsOrchestrator');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

const asOfMs = Date.parse('2026-08-18T12:00:00Z');
const ISO = (d) => new Date(asOfMs - d * 86400_000).toISOString();

function ownerDecision() {
  return {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
  };
}

function fullDb({ soldItems = null, listingRow = null } = {}) {
  //   Build a db that supports both salePriceObservationService (via
  //   sku_listing_link + ebay_products) and recentSoldPriceService
  //   (via oms_orders + oms_order_items). Physical identity mapping
  //   is injected separately via identityCoverageFn (not via db here).
  const recent = new Date(asOfMs - 86400_000).toISOString();
  const data = {
    sellable_units: [{ id: 10, display_name: 'BP 1-Box', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }],
    sku_master: [{ id: 100, internal_sku: 'BP-SKU', weight_gram: 500 }],
    sku_listing_link: [{ sku_id: 100, listing_id: 'e_1', marketplace_sku: 'BP-SKU', is_primary: true }],
    ebay_products: listingRow == null ? [] : [listingRow],
    oms_orders: (soldItems || []).map(x => ({
      id: x.order_id, external_order_number: 'A' + x.order_id, channel: 'ebay',
      shipped_at: x.shipped_at, cancelled_at: null,
      order_status: 'shipped', payment_status: 'paid',
    })),
    oms_order_items: (soldItems || []).map(x => ({
      id: x.item_id, order_id: x.order_id, sku_master_id: 100,
      quantity: 1, unit_price: x.unit_price, discount: 0, currency: 'USD',
    })),
  };
  return {
    from(table) {
      const rows = data[table] || [];
      const q = { _filters: [], _range: [] };
      const buildResult = () => {
        let out = rows.slice();
        for (const [c, v] of q._filters) out = out.filter(r => r[c] === v);
        for (const [op, c, v] of q._range) {
          if (op === 'gte') out = out.filter(r => r[c] != null && r[c] >= v);
          if (op === 'lte') out = out.filter(r => r[c] != null && r[c] <= v);
          if (op === 'in')  out = out.filter(r => v.includes(r[c]));
        }
        return { data: out, error: null };
      };
      return {
        select() { return this; },
        eq(c, v) { q._filters.push([c, v]); return this; },
        gte(c, v) { q._range.push(['gte', c, v]); return this; },
        lte(c, v) { q._range.push(['lte', c, v]); return this; },
        in(c, v) { q._range.push(['in', c, v]); return Promise.resolve(buildResult()); },
        then(res) { res(buildResult()); },
      };
    },
  };
}

//   The orchestrator now calls recentSoldPriceService which internally calls
//   analysePhysicalIdentityCoverage (via physicalSpecificCoverage → analysePhysicalIdentity → real DB).
//   To keep tests DB-stub-based, we monkey-patch analysePhysicalIdentityCoverage
//   via a small module require-cache override.

const identityCoverageModule = require('../../src/services/oms/physicalSpecificCoverage');
const originalCoverage = identityCoverageModule.analysePhysicalIdentityCoverage;
function withTrustedIdentity(fn) {
  identityCoverageModule.analysePhysicalIdentityCoverage = async ({ physicalProductId, channel, days }) => ({
    physical_product_id: physicalProductId, channel, days,
    velocity_trusted: true, trust_reason: 'ok',
    known_shopify_identities: [{ listing_id: 'e_1', variant_id: null, sku_master_id: 100 }],
  });
  return fn().finally(() => { identityCoverageModule.analysePhysicalIdentityCoverage = originalCoverage; });
}

const fxOpts = { usdKrw: 1350, usdKrwSource: 'pricing_safety_sot' };

// ─── P20 · MANUAL beats SOLD_MEDIAN ─────────────

test('P20. MANUAL sale price beats SOLD_MEDIAN even when sold candidate is available', async () => {
  await withTrustedIdentity(async () => {
    const soldItems = [1, 2, 3, 4].map(i => ({ order_id: 1000 + i, item_id: 5000 + i, unit_price: 75, shipped_at: ISO(i) }));
    const listingRow = { item_id: 'e_1', sku: 'BP-SKU', price_usd: 60, shipping_usd: 6, updated_at: ISO(1), status: 'active' };
    const r = await buildFinancialMetricsWithAutoInputs({
      ownerDecision: ownerDecision(), db: fullDb({ soldItems, listingRow }),
      manual: { expected_sale_price_krw: 200000, expected_sale_price_source: 'owner_typed' },
      autoSalePriceOpts: fxOpts,
      autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
    });
    assert.equal(r.inputs_resolution.sale_price.resolution, 'MANUAL');
    assert.equal(r.inputs_resolution.sale_price.value, 200000);
  });
});

// ─── P21 · SOLD_MEDIAN beats OBSERVED_LISTING ─────

test('P21. SOLD_MEDIAN beats OBSERVED_LISTING · sold candidate available AND listing available', async () => {
  await withTrustedIdentity(async () => {
    const soldItems = [1, 2, 3, 4].map(i => ({ order_id: 1000 + i, item_id: 5000 + i, unit_price: 75, shipped_at: ISO(i) }));
    const listingRow = { item_id: 'e_1', sku: 'BP-SKU', price_usd: 60, shipping_usd: 6, updated_at: ISO(1), status: 'active' };
    const r = await buildFinancialMetricsWithAutoInputs({
      ownerDecision: ownerDecision(), db: fullDb({ soldItems, listingRow }),
      autoSalePriceOpts: fxOpts,
      autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
    });
    assert.equal(r.inputs_resolution.sale_price.resolution, 'AUTO_SOLD_MEDIAN');
    assert.equal(r.inputs_resolution.sale_price.value, 75 * 1350);   // 101250
    assert.match(r.inputs_resolution.sale_price.source, /recent_sold_median/);
    assert.match(r.inputs_resolution.sale_price.note, /RECENT SOLD MEDIAN/);
  });
});

// ─── P22 · OBSERVED_LISTING fallback works ────────

test('P22. OBSERVED_LISTING fallback · sold has insufficient samples · listing available', async () => {
  await withTrustedIdentity(async () => {
    //   Only 1 sold sample · below default minSamples=3 → sold UNKNOWN → fall back to listing
    const soldItems = [{ order_id: 1001, item_id: 5001, unit_price: 75, shipped_at: ISO(1) }];
    const listingRow = { item_id: 'e_1', sku: 'BP-SKU', price_usd: 60, shipping_usd: 6, updated_at: ISO(1), status: 'active' };
    const r = await buildFinancialMetricsWithAutoInputs({
      ownerDecision: ownerDecision(), db: fullDb({ soldItems, listingRow }),
      autoSalePriceOpts: fxOpts,
      autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
    });
    assert.equal(r.inputs_resolution.sale_price.resolution, 'AUTO_OBSERVED');
    assert.equal(r.inputs_resolution.sale_price.value, 60 * 1350);   // 81000
    assert.match(r.inputs_resolution.sale_price.note, /Fallback.*sold median unavailable/);
    //   Audit trail records both candidates seen
    const seen = r.inputs_resolution.sale_price.candidates_seen.map(c => c.type);
    assert.ok(seen.includes('RECENT_SOLD_PRICE_MEDIAN'));
    assert.ok(seen.includes('OBSERVED_LISTING_PRICE'));
  });
});

// ─── P23 · UNKNOWN fallback works ───────────────

test('P23. UNKNOWN fallback · both sold and listing unavailable', async () => {
  await withTrustedIdentity(async () => {
    const r = await buildFinancialMetricsWithAutoInputs({
      ownerDecision: ownerDecision(), db: fullDb({ soldItems: [], listingRow: null }),
      autoSalePriceOpts: fxOpts,
      autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
    });
    assert.equal(r.inputs_resolution.sale_price.resolution, 'UNKNOWN');
    assert.match(r.inputs_resolution.sale_price.note, /sold=.*listing=/);
  });
});

// ─── Extra · Sold candidate audit trail carries confidence and sample_count ─

test('P-orch-extra. Sold candidate provenance surfaces confidence + sample_count', async () => {
  await withTrustedIdentity(async () => {
    const soldItems = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => ({ order_id: 1000 + i, item_id: 5000 + i, unit_price: 75, shipped_at: ISO(i) }));
    const r = await buildFinancialMetricsWithAutoInputs({
      ownerDecision: ownerDecision(), db: fullDb({ soldItems }),
      autoSalePriceOpts: fxOpts,
      autoShippingOpts: { lengthCm: 20, widthCm: 15, heightCm: 5 },
    });
    assert.equal(r.inputs_resolution.sale_price.resolution, 'AUTO_SOLD_MEDIAN');
    assert.equal(r.inputs_resolution.sale_price.auto_observation.sample_count, 10);
    assert.equal(r.inputs_resolution.sale_price.auto_observation.confidence, 'HIGH');
  });
});
