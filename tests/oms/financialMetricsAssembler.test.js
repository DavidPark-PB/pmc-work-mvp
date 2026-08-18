'use strict';

/**
 * tests/oms/financialMetricsAssembler.test.js — Phase 8L integration.
 *
 * Verifies the thin adapter between Owner Decision projection and the
 * pure financialMetricsService. Contract guarantees:
 *
 *   • 3 INDEPENDENT scenarios (accounting / replacement / secondary_market_ask)
 *     · never blended
 *   • secondary ask never auto-promoted to supplier / accounting cost
 *   • sale price / shipping caller-supplied · missing → UNKNOWN (not 0)
 *   • Owner Decision output shape UNCHANGED (assembler returns separate object)
 *   • zero DB / API / marketplace calls
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFinancialMetrics } = require('../../src/services/oms/financialMetricsAssembler');

// ─── Fixture builder mirroring buildOwnerDecision output ─

function makeOwnerDecision(overrides = {}) {
  return {
    physical_product_id: 1,
    generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: 'watch', confidence_level: 'low', priority_score: 100, urgency_label: 'medium', one_line_summary: 'x' },
    product: { title: 'BP', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    demand: { trusted: true },
    supply: { verdict: 'AT_RISK', current_supply_quality: 'ask_only' },
    cost_context: {
      historical_typical_supplier_cost_krw_median: 19500,
      historical_accounting_cost_krw: 45000,
      observed_secondary_market_ask_min_krw: 40000,
      note: 'category-independent',
    },
    ...overrides,
  };
}

// ─── Structural invariants ─────────────────────────────

test('AS1. Returns 3 independent scenarios · accounting / replacement / secondary_market_ask', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
    expected_sale_price_source: 'ebay_listing:xyz', shipping_source: 'kpacket_us',
  });
  assert.deepEqual(Object.keys(r.scenarios).sort(), ['accounting', 'replacement', 'secondary_market_ask']);
});

test('AS2. Each scenario carries its own cost_basis_source · never shared with another', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  assert.equal(r.scenarios.accounting.cost_basis_source, 'sku_master_cost_krw');
  assert.equal(r.scenarios.replacement.cost_basis_source, 'historical_supplier_median_krw');
  assert.equal(r.scenarios.secondary_market_ask.cost_basis_source, 'secondary_ask_min_krw');
});

test('AS3. Each scenario has its own category and cost basis note (secondary market flagged as REFERENCE)', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  assert.equal(r.scenarios.accounting.category, 'accounting');
  assert.equal(r.scenarios.replacement.category, 'replacement');
  assert.equal(r.scenarios.secondary_market_ask.category, 'secondary_market_ask');
  assert.match(r.scenarios.secondary_market_ask.cost_basis_note, /SECONDARY MARKET ASK.*NOT a supplier quote.*NOT accounting cost/);
});

test('AS4. Full happy path · all 3 scenarios yield AVAILABLE proceeds / profit / margin / break-even / inventory-value', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  //   Accounting: cost 45000 · proceeds 74000 · profit 29000 · margin 39.19%
  assert.equal(r.scenarios.accounting.gross_profit.amount_krw, 29000);
  //   Replacement: cost 19500 · profit 54500 · margin 73.65%
  assert.equal(r.scenarios.replacement.gross_profit.amount_krw, 54500);
  //   Secondary: cost 40000 · profit 34000 · margin 45.95%
  assert.equal(r.scenarios.secondary_market_ask.gross_profit.amount_krw, 34000);
  //   All three inventory values DIFFERENT · Owner rule §5 (no blending)
  const a = r.scenarios.accounting.inventory_value.amount_krw;
  const b = r.scenarios.replacement.inventory_value.amount_krw;
  const c = r.scenarios.secondary_market_ask.inventory_value.amount_krw;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

// ─── UNKNOWN cascades ─────────────────────────────────

test('AS5. Missing sale price → all scenarios proceeds/profit/margin UNKNOWN · break-even & inventory-value still work', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    /* no expected_sale_price_krw */
    seller_borne_shipping_krw: 8000,
  });
  for (const scenario of Object.values(r.scenarios)) {
    assert.equal(scenario.expected_sale_proceeds.status, 'UNKNOWN');
    assert.equal(scenario.gross_profit.status, 'UNKNOWN');
    assert.equal(scenario.gross_margin.status, 'UNKNOWN');
    //   Break-even + inventory-value are independent of sale price
    assert.equal(scenario.break_even_price.status, 'AVAILABLE');
    assert.equal(scenario.inventory_value.status, 'AVAILABLE');
  }
  assert.ok(r.missing_inputs.includes('expected_sale_price_krw'));
});

test('AS6. Missing shipping → proceeds/profit/margin/break-even UNKNOWN · inventory-value still works', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000,
    /* no seller_borne_shipping_krw */
  });
  for (const scenario of Object.values(r.scenarios)) {
    assert.equal(scenario.expected_sale_proceeds.status, 'UNKNOWN');
    assert.equal(scenario.break_even_price.status, 'UNKNOWN');
    assert.equal(scenario.inventory_value.status, 'AVAILABLE');
  }
  assert.ok(r.missing_inputs.includes('seller_borne_shipping_krw'));
});

test('AS7. Missing cost for ONE scenario keeps other scenarios AVAILABLE · UNKNOWN is scenario-local', () => {
  const od = makeOwnerDecision({
    cost_context: {
      historical_typical_supplier_cost_krw_median: null,   // replacement UNKNOWN
      historical_accounting_cost_krw: 45000,                // accounting AVAILABLE
      observed_secondary_market_ask_min_krw: 40000,         // secondary AVAILABLE
      note: 'partial',
    },
  });
  const r = buildFinancialMetrics(od, {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  assert.equal(r.scenarios.replacement.gross_profit.status, 'UNKNOWN');
  assert.equal(r.scenarios.accounting.gross_profit.status, 'AVAILABLE');
  assert.equal(r.scenarios.secondary_market_ask.gross_profit.status, 'AVAILABLE');
});

test('AS8. Missing on_hand → inventory_value UNKNOWN for ALL scenarios · other metrics unaffected', () => {
  const od = makeOwnerDecision({ inventory: { on_hand: null, reserved: 0, available: 0 } });
  const r = buildFinancialMetrics(od, {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  for (const s of Object.values(r.scenarios)) {
    assert.equal(s.inventory_value.status, 'UNKNOWN');
    //   Non-inventory metrics still compute
    assert.equal(s.expected_sale_proceeds.status, 'AVAILABLE');
  }
});

// ─── Category isolation guarantees ─────────────────────

test('AS9. Secondary market cost NEVER surfaces as accounting or replacement cost basis', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  //   Accounting uses accounting cost only
  assert.equal(r.scenarios.accounting.cost_basis_krw, 45000);
  //   Replacement uses historical supplier median only
  assert.equal(r.scenarios.replacement.cost_basis_krw, 19500);
  //   Secondary uses secondary ask only
  assert.equal(r.scenarios.secondary_market_ask.cost_basis_krw, 40000);
  //   No cross-pollination
});

test('AS10. All scenarios use SAME sale price and shipping (fair-apples comparison)', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  for (const s of Object.values(r.scenarios)) {
    assert.equal(s.expected_sale_proceeds.breakdown.sale_price_krw, 100000);
    assert.equal(s.expected_sale_proceeds.breakdown.shipping_krw, 8000);
  }
});

test('AS11. Owner Decision object NOT mutated by the assembler', () => {
  const od = makeOwnerDecision();
  const before = JSON.stringify(od);
  buildFinancialMetrics(od, { expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  assert.equal(JSON.stringify(od), before, 'ownerDecision reference must be untouched');
});

test('AS12. Provenance sources preserved verbatim in every scenario', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, expected_sale_price_source: 'ebay_listing:205376020693',
    seller_borne_shipping_krw: 8000, shipping_source: 'kpacket_us',
  });
  for (const s of Object.values(r.scenarios)) {
    assert.equal(s.expected_sale_proceeds.provenance.expected_sale_price_source, 'ebay_listing:205376020693');
    assert.equal(s.expected_sale_proceeds.provenance.shipping_source, 'kpacket_us');
  }
});

test('AS13. Caveats surface for market-reference categories · Owner rule §5', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  const caveatsJoined = (r.caveats || []).join(' · ');
  assert.match(caveatsJoined, /secondary_market_ask.*MARKET REFERENCE/);
  assert.match(caveatsJoined, /replacement.*historical supplier/);
});

test('AS14. inputs_used surfaces cost_context_snapshot verbatim (audit trail)', () => {
  const r = buildFinancialMetrics(makeOwnerDecision(), {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  assert.deepEqual(r.inputs_used.cost_context_snapshot, {
    historical_accounting_cost_krw: 45000,
    historical_typical_supplier_cost_krw_median: 19500,
    observed_secondary_market_ask_min_krw: 40000,
  });
});

test('AS15. Error / empty owner decision · returns UNKNOWN scenarios without throwing', () => {
  //   Robust against ownerDecision={} or error projection.
  const r1 = buildFinancialMetrics({}, {});
  assert.equal(r1.scenarios.accounting.inventory_value.status, 'UNKNOWN');
  //   No crash even with null
  const r2 = buildFinancialMetrics(null, {});
  assert.equal(r2.scenarios.accounting.inventory_value.status, 'UNKNOWN');
});
