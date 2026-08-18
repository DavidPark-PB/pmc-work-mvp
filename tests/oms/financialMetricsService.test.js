'use strict';

/**
 * tests/oms/financialMetricsService.test.js — Phase 8L implementation contract.
 *
 * Verifies the 5 financial metrics + lineage/provenance guarantees:
 *   expected_sale_proceeds · gross_profit · gross_margin ·
 *   break_even_price · inventory_value
 *
 * Every metric returns {status: 'AVAILABLE'|'UNKNOWN'} and NEVER
 * fabricates numbers when inputs are missing. Cost basis is EXPLICIT —
 * this service never blends categories.
 *
 * SAFETY: pure calculation · no DB · no marketplace · no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fm = require('../../src/services/oms/financialMetricsService');

// ─── expected_sale_proceeds ───────────────────────────

test('ESP1. All inputs present · proceeds = price - (price × 0.18) - shipping · rounded KRW', () => {
  const r = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: 100000,
    expected_sale_price_source: 'ebay_listing:205376020693',
    seller_borne_shipping_krw: 8000,
    shipping_source: 'kpacket_us',
  });
  //   fee = 100000 × 0.18 = 18000 · proceeds = 100000 - 18000 - 8000 = 74000
  assert.equal(r.status, 'AVAILABLE');
  assert.equal(r.amount_krw, 74000);
  assert.equal(r.breakdown.marketplace_fee_krw, 18000);
  assert.equal(r.breakdown.shipping_krw, 8000);
  assert.equal(r.provenance.marketplace_fee_pct, 0.18);
});

test('ESP2. Sale price null → UNKNOWN · never 0-fabricated', () => {
  const r = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: null, seller_borne_shipping_krw: 8000 });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.amount_krw, null);
  assert.ok(r.missing.includes('expected_sale_price_krw'));
});

test('ESP3. Shipping null → UNKNOWN · shipping 0 (explicit) → AVAILABLE', () => {
  const nullShip = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: null });
  assert.equal(nullShip.status, 'UNKNOWN');
  assert.ok(nullShip.missing.includes('seller_borne_shipping_krw'));

  const zeroShip = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 0 });
  assert.equal(zeroShip.status, 'AVAILABLE');
  assert.equal(zeroShip.amount_krw, 82000);   // 100000 - 18000 - 0
});

test('ESP4. marketplace_fee_pct explicit 0 → fee 0 · proceeds = price - shipping · never uses undocumented default', () => {
  const r = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000, marketplace_fee_pct: 0,
  });
  assert.equal(r.amount_krw, 92000);   // 100000 - 0 - 8000
  assert.equal(r.provenance.marketplace_fee_pct, 0);
});

test('ESP5. marketplace_fee_pct >= 1 → UNKNOWN (percentage out of valid domain)', () => {
  const r = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000, marketplace_fee_pct: 1.5,
  });
  assert.equal(r.status, 'UNKNOWN');
  assert.ok(r.missing.includes('marketplace_fee_pct'));
});

test('ESP6. marketplace_fixed_fee_krw supported additively · fixed + percentage combined', () => {
  const r = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 0, marketplace_fixed_fee_krw: 300,
  });
  //   fee = 100000 × 0.18 + 300 = 18300 · proceeds = 100000 - 18300 - 0 = 81700
  assert.equal(r.amount_krw, 81700);
});

test('ESP7. sale price 0 or negative → UNKNOWN', () => {
  for (const bad of [0, -100, NaN]) {
    const r = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: bad, seller_borne_shipping_krw: 0 });
    assert.equal(r.status, 'UNKNOWN', `bad=${bad}`);
  }
});

test('ESP8. Sale price provenance surfaced in every result · required for downstream audit', () => {
  const r = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: 100000, expected_sale_price_source: 'ebay_listing:205376020693',
    seller_borne_shipping_krw: 8000, shipping_source: 'kpacket_us',
  });
  assert.equal(r.provenance.expected_sale_price_source, 'ebay_listing:205376020693');
  assert.equal(r.provenance.shipping_source, 'kpacket_us');
});

test('ESP9. Missing provenance labels → null, but not UNKNOWN if numbers present · provenance is metadata', () => {
  const r = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
    /* no provenance labels */
  });
  assert.equal(r.status, 'AVAILABLE');
  assert.equal(r.provenance.expected_sale_price_source, null);
  assert.equal(r.provenance.shipping_source, null);
});

// ─── gross_profit ─────────────────────────────────

test('GP1. proceeds AVAILABLE + cost_basis + valid source → gross = proceeds - cost', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({
    expected_sale_proceeds: proc,
    cost_basis_krw: 45000,
    cost_basis_source: 'sku_master_cost_krw',
  });
  assert.equal(gp.status, 'AVAILABLE');
  assert.equal(gp.amount_krw, 29000);   // 74000 - 45000
  assert.equal(gp.provenance.cost_basis_source, 'sku_master_cost_krw');
});

test('GP2. proceeds UNKNOWN → gross UNKNOWN · missing.expected_sale_proceeds', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: null, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw' });
  assert.equal(gp.status, 'UNKNOWN');
  assert.ok(gp.missing.includes('expected_sale_proceeds'));
});

test('GP3. cost_basis_krw null → UNKNOWN · never uses 0 as cost', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: null, cost_basis_source: 'sku_master_cost_krw' });
  assert.equal(gp.status, 'UNKNOWN');
  assert.ok(gp.missing.includes('cost_basis_krw'));
});

test('GP4. cost_basis_source missing / invalid → UNKNOWN · Owner rule 4 (no blending)', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const bad = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 45000, cost_basis_source: 'made_up_source' });
  assert.equal(bad.status, 'UNKNOWN');

  const missing = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 45000 });
  assert.equal(missing.status, 'UNKNOWN');
});

test('GP5. secondary_ask_min_krw as cost basis is ACCEPTED · but caller must explicitly opt-in (never auto-selected)', () => {
  //   Owner Part 4: secondary ask must not be auto-used as cost basis.
  //   Contract: caller CAN pass it explicitly if they judge it appropriate,
  //   but the service never blends or auto-derives.
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({
    expected_sale_proceeds: proc,
    cost_basis_krw: 40000,
    cost_basis_source: 'secondary_ask_min_krw',
  });
  assert.equal(gp.status, 'AVAILABLE');
  assert.equal(gp.amount_krw, 34000);
  assert.equal(gp.provenance.cost_basis_source, 'secondary_ask_min_krw', 'provenance surfaces the choice · Owner can audit');
});

test('GP6. Negative gross_profit surfaces as negative amount · never coerced to 0', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 200000, cost_basis_source: 'sku_master_cost_krw' });
  assert.equal(gp.status, 'AVAILABLE');
  assert.equal(gp.amount_krw, -126000, 'proceeds 74000 - cost 200000 = -126000 · sign preserved');
});

// ─── gross_margin ────────────────────────────────

test('GM1. MARGIN semantics: gross_profit / expected_sale_proceeds × 100 (NOT markup)', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw' });
  const gm = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gp });
  //   gp 29000 / proceeds 74000 × 100 = 39.1892%
  assert.equal(gm.status, 'AVAILABLE');
  assert.equal(gm.pct, 39.1892);
  //   markup would be 29000/45000×100 = 64.44% · dramatically different
});

test('GM2. Zero proceeds denominator → UNKNOWN · never NaN or Infinity', () => {
  //   Force proceeds 0 with an artificial construction: 100k price, 100% fee (excluded by ESP5),
  //   so we have to craft a zero-proceeds scenario differently:
  //   proceeds = 10000 - 1800 - 8200 = 0
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 10000, seller_borne_shipping_krw: 8200 });
  assert.equal(proc.amount_krw, 0);
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 5000, cost_basis_source: 'sku_master_cost_krw' });
  const gm = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gp });
  assert.equal(gm.status, 'UNKNOWN');
  assert.equal(gm.pct, null);
});

test('GM3. Negative proceeds → UNKNOWN (margin undefined for loss-making revenue)', () => {
  //   proceeds = 10000 - 1800 - 10000 = -1800
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 10000, seller_borne_shipping_krw: 10000 });
  assert.equal(proc.amount_krw, -1800);
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 5000, cost_basis_source: 'sku_master_cost_krw' });
  const gm = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gp });
  assert.equal(gm.status, 'UNKNOWN');
});

test('GM4. gross_profit UNKNOWN → margin UNKNOWN', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc /* no cost */ });
  const gm = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gp });
  assert.equal(gm.status, 'UNKNOWN');
});

test('GM5. Margin percentage bounded ≤ 100% under normal cost accounting · negative margin allowed', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gpLoss = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 200000, cost_basis_source: 'sku_master_cost_krw' });
  const gm = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gpLoss });
  assert.ok(gm.pct < 0, `loss must yield negative margin · got ${gm.pct}`);
});

test('GM6. Rounding deterministic · at most 4 decimal places · repeatable', () => {
  const proc = fm.computeExpectedSaleProceeds({ expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const gp = fm.computeGrossProfit({ expected_sale_proceeds: proc, cost_basis_krw: 45123, cost_basis_source: 'sku_master_cost_krw' });
  const gm1 = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gp });
  const gm2 = fm.computeGrossMargin({ expected_sale_proceeds: proc, gross_profit: gp });
  assert.equal(gm1.pct, gm2.pct, 'deterministic rounding');
  // Assert that the stored value round-trips through 4-decimal rounding · IEEE-754
  //   float representation is inexact, so we can't use isInteger(pct*10000).
  const roundedAgain = Math.round(gm1.pct * 10000) / 10000;
  assert.equal(roundedAgain, gm1.pct, 'value already at ≤4 decimal precision · re-rounding is a no-op');
});

// ─── break_even_price ────────────────────────────

test('BE1. Percentage inverse: cost=45000 shipping=8000 fee=0.18 → break_even = (45000+8000)/(1-0.18) = 64634', () => {
  const r = fm.computeBreakEvenPrice({
    cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw',
    seller_borne_shipping_krw: 8000,
  });
  assert.equal(r.status, 'AVAILABLE');
  assert.equal(r.amount_krw, 64634);   // Math.round(53000/0.82)
});

test('BE2. Round-trip verification: at break-even price, proceeds should equal cost basis', () => {
  const cost = 45000, ship = 8000;
  const be = fm.computeBreakEvenPrice({
    cost_basis_krw: cost, cost_basis_source: 'sku_master_cost_krw',
    seller_borne_shipping_krw: ship,
  });
  const proc = fm.computeExpectedSaleProceeds({
    expected_sale_price_krw: be.amount_krw, seller_borne_shipping_krw: ship,
  });
  //   Rounding tolerance: 1 KRW
  assert.ok(Math.abs(proc.amount_krw - cost) <= 1, `round-trip proceeds ${proc.amount_krw} should ≈ cost ${cost}`);
});

test('BE3. Fixed fee reflected in inverse: (cost + shipping + fixed_fee) / (1 - fee_pct)', () => {
  const r = fm.computeBreakEvenPrice({
    cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw',
    seller_borne_shipping_krw: 8000, marketplace_fixed_fee_krw: 300,
  });
  //   (45000 + 8000 + 300) / 0.82 = 65000
  assert.equal(r.amount_krw, 65000);
});

test('BE4. fee_pct >= 1 → UNKNOWN · denominator (1 - fee_pct) <= 0 is impossible', () => {
  const r = fm.computeBreakEvenPrice({
    cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw',
    seller_borne_shipping_krw: 8000, marketplace_fee_pct: 1.0,
  });
  assert.equal(r.status, 'UNKNOWN');
});

test('BE5. cost null / shipping null / source invalid → UNKNOWN', () => {
  const nullCost = fm.computeBreakEvenPrice({ cost_basis_krw: null, cost_basis_source: 'sku_master_cost_krw', seller_borne_shipping_krw: 8000 });
  assert.equal(nullCost.status, 'UNKNOWN');

  const nullShip = fm.computeBreakEvenPrice({ cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw', seller_borne_shipping_krw: null });
  assert.equal(nullShip.status, 'UNKNOWN');

  const badSrc = fm.computeBreakEvenPrice({ cost_basis_krw: 45000, cost_basis_source: 'wrong', seller_borne_shipping_krw: 8000 });
  assert.equal(badSrc.status, 'UNKNOWN');
});

test('BE6. Break-even is EXCLUSIVELY driven by explicit inputs · never derived from historical median blend', () => {
  //   Contract: no automatic cost basis selection. Only what caller provides.
  const r = fm.computeBreakEvenPrice({
    cost_basis_krw: 19500, cost_basis_source: 'historical_supplier_median_krw',
    seller_borne_shipping_krw: 5000,
  });
  assert.equal(r.provenance.cost_basis_source, 'historical_supplier_median_krw', 'provenance surfaces caller choice');
  //   (19500 + 5000) / 0.82 = 29878
  assert.equal(r.amount_krw, 29878);
});

// ─── inventory_value ────────────────────────────

test('IV1. quantity × per_unit_cost · single category · rounded KRW', () => {
  const r = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 45000,
    cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
  });
  assert.equal(r.status, 'AVAILABLE');
  assert.equal(r.amount_krw, 2025000);
  assert.equal(r.per_unit_krw, 45000);
  assert.equal(r.quantity, 45);
  assert.equal(r.category, 'accounting');
});

test('IV2. quantity 0 → value 0 · AVAILABLE (legitimate empty inventory)', () => {
  const r = fm.computeInventoryValue({
    physical_quantity: 0, per_unit_cost_krw: 45000,
    cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
  });
  assert.equal(r.status, 'AVAILABLE');
  assert.equal(r.amount_krw, 0);
});

test('IV3. per_unit_cost_krw null → UNKNOWN · NEVER treats null as 0', () => {
  const r = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: null,
    cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
  });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.amount_krw, null);
});

test('IV4. cost_basis_source invalid → UNKNOWN · Owner rule 7 (no category blending)', () => {
  const r = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 45000,
    cost_basis_source: 'blended_average', category: 'accounting',
  });
  assert.equal(r.status, 'UNKNOWN');
});

test('IV5. category invalid → UNKNOWN (must be accounting | replacement | secondary_market_ask)', () => {
  const r = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 45000,
    cost_basis_source: 'sku_master_cost_krw', category: 'made_up',
  });
  assert.equal(r.status, 'UNKNOWN');
});

test('IV6. Category-per-value semantic: accounting vs replacement vs secondary_market_ask are DISTINCT results', () => {
  const accounting = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 45000,
    cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
  });
  const replacement = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 19500,
    cost_basis_source: 'historical_supplier_median_krw', category: 'replacement',
  });
  const marketAsk = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 40000,
    cost_basis_source: 'secondary_ask_min_krw', category: 'secondary_market_ask',
  });
  assert.notEqual(accounting.amount_krw, replacement.amount_krw);
  assert.notEqual(accounting.amount_krw, marketAsk.amount_krw);
  assert.notEqual(replacement.amount_krw, marketAsk.amount_krw);
  //   Owner Part 7: never combine into a single number.
});

test('IV7. Non-integer physical_quantity → UNKNOWN (quantity must be discrete units)', () => {
  for (const bad of [45.5, -1, 'abc']) {
    const r = fm.computeInventoryValue({
      physical_quantity: bad, per_unit_cost_krw: 45000,
      cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
    });
    assert.equal(r.status, 'UNKNOWN', `bad=${bad}`);
  }
});

test('IV8. Owner must supply per_unit cost matched to physical unit · service does NOT auto-multiply for multipacks', () => {
  //   Contract test: if caller passes per_unit_cost of a 10-pack instead of
  //   a single unit, that's a caller bug · service just does qty × cost.
  //   This test PINS the contract, so callers know the service does not
  //   auto-adjust for multipack semantics.
  const singleUnit = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 45000,
    cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
  });
  const tenPackMistake = fm.computeInventoryValue({
    physical_quantity: 45, per_unit_cost_krw: 450000, // caller supplied 10x cost by mistake
    cost_basis_source: 'sku_master_cost_krw', category: 'accounting',
  });
  assert.equal(singleUnit.amount_krw, 2025000);
  assert.equal(tenPackMistake.amount_krw, 20250000);
  //   Service cannot detect the mismatch · caller MUST verify unit semantics.
  //   See tests/oms/inventoryValueUnitSemantics — future guardrail lives at caller.
});

// ─── computeFinancialMetrics · aggregate ──────────

test('AGG1. All 5 metrics computed in one call · cascading UNKNOWN when inputs are missing', () => {
  const result = fm.computeFinancialMetrics({
    expected_sale_price_krw: 100000, expected_sale_price_source: 'ebay_listing:x',
    seller_borne_shipping_krw: 8000, shipping_source: 'kpacket_us',
    cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw',
    physical_quantity: 45, per_unit_cost_krw: 45000, category: 'accounting',
  });
  assert.equal(result.expected_sale_proceeds.status, 'AVAILABLE');
  assert.equal(result.gross_profit.status, 'AVAILABLE');
  assert.equal(result.gross_margin.status, 'AVAILABLE');
  assert.equal(result.break_even_price.status, 'AVAILABLE');
  assert.equal(result.inventory_value.status, 'AVAILABLE');
  assert.equal(result.expected_sale_proceeds.amount_krw, 74000);
  assert.equal(result.gross_profit.amount_krw, 29000);
  assert.equal(result.break_even_price.amount_krw, 64634);
  assert.equal(result.inventory_value.amount_krw, 2025000);
});

test('AGG2. Missing sale_price → proceeds & gross & margin UNKNOWN · break_even & inventory_value INDEPENDENT still work', () => {
  const result = fm.computeFinancialMetrics({
    /* no expected_sale_price_krw */
    seller_borne_shipping_krw: 8000,
    cost_basis_krw: 45000, cost_basis_source: 'sku_master_cost_krw',
    physical_quantity: 45, per_unit_cost_krw: 45000, category: 'accounting',
  });
  assert.equal(result.expected_sale_proceeds.status, 'UNKNOWN');
  assert.equal(result.gross_profit.status, 'UNKNOWN');
  assert.equal(result.gross_margin.status, 'UNKNOWN');
  //   break_even and inventory_value are independent of sale_price
  assert.equal(result.break_even_price.status, 'AVAILABLE');
  assert.equal(result.inventory_value.status, 'AVAILABLE');
});

test('AGG3. Missing cost → gross & break_even & inventory_value UNKNOWN · proceeds AVAILABLE', () => {
  const result = fm.computeFinancialMetrics({
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
    /* no cost_basis_krw or per_unit_cost_krw */
    category: 'accounting',
  });
  assert.equal(result.expected_sale_proceeds.status, 'AVAILABLE');
  assert.equal(result.gross_profit.status, 'UNKNOWN');
  assert.equal(result.gross_margin.status, 'UNKNOWN');
  assert.equal(result.break_even_price.status, 'UNKNOWN');
  assert.equal(result.inventory_value.status, 'UNKNOWN');
});

// ─── Contract enums ──────────────────────────────

test('E1. COST_BASIS_SOURCES exposes the exact 5 approved category names', () => {
  assert.deepEqual([...fm.COST_BASIS_SOURCES], [
    'sku_master_cost_krw',
    'historical_supplier_median_krw',
    'secondary_ask_min_krw',
    'landed_cost_krw',
    'supplier_quote_krw',
  ]);
});

test('E2. INVENTORY_VALUE_CATEGORY exposes the exact 3 approved category names · no blending allowed', () => {
  assert.deepEqual(Object.keys(fm.INVENTORY_VALUE_CATEGORY).sort(), ['ACCOUNTING', 'REPLACEMENT', 'SECONDARY_MARKET_ASK']);
});

test('E3. DEFAULT_MARKETPLACE_FEE_PCT reuses Hermes Phase 18A ASSUMPTIONS.ebay_fee_pct (0.18)', () => {
  assert.equal(fm.DEFAULT_MARKETPLACE_FEE_PCT, 0.18);
});
