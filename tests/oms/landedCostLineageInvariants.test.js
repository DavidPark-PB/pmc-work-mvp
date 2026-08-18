'use strict';

/**
 * tests/oms/landedCostLineageInvariants.test.js — Phase 8L batch 3.
 *
 * Trace: replacementLandedCost.computeReplacementLandedCost().
 *
 *   PRODUCT COST      = quoted_price_per_offer (source-currency → KRW)
 *   LANDED COST       = product + freight + duty + tax + fees   (all KRW)
 *   → INCOMPLETE if ANY component is missing · NEVER fabricates 0.
 *
 * Attack classes (Owner Part 8):
 *   • foreign currency without FX → KRW fabrication
 *   • missing landed component silently treated as 0
 *   • quoted_price_per_offer null / zero / negative
 *   • fx_rate wrong direction
 *   • per-physical rounding vs per-offer rounding
 *
 * SAFETY: pure calculation · no DB · no marketplace · no FX API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeReplacementLandedCost } = require('../../src/services/oms/replacementLandedCost');

// ─── FX resolution invariants ─────────────────────────────

test('FX1. KRW source → identity conversion (rate 1) · always available', () => {
  const res = computeReplacementLandedCost(
    { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 },
    { usdKrw: 1300 },
  );
  assert.equal(res.product_cost.status, 'AVAILABLE');
  assert.equal(res.product_cost.amount_krw_per_offer, 100000);
  assert.equal(res.product_cost.amount_krw_per_physical, 20000);
  assert.equal(res.product_cost.fx.fx_rate, 1);
  assert.equal(res.product_cost.fx.source_currency, 'KRW');
});

test('FX2. USD source WITHOUT opts.usdKrw → status UNKNOWN · amount NULL (never fabricated)', () => {
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    {},
  );
  assert.equal(res.product_cost.status, 'UNKNOWN');
  assert.equal(res.product_cost.amount_krw_per_offer, null);
  assert.equal(res.product_cost.amount_krw_per_physical, null);
  assert.equal(res.product_cost.fx, null);
  assert.ok(res.product_cost.missing.includes('fx_USD_to_KRW'));
});

test('FX3. USD source with opts.usdKrw=0 → treated as missing FX · UNKNOWN', () => {
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: 0 },
  );
  assert.equal(res.product_cost.status, 'UNKNOWN');
  assert.ok(res.product_cost.missing.includes('fx_USD_to_KRW'));
});

test('FX4. USD source with negative rate → treated as missing FX · UNKNOWN', () => {
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: -1300 },
  );
  assert.equal(res.product_cost.status, 'UNKNOWN');
});

test('FX5. JPY / CNY require caller-provided krwJpyRate / krwCnyRate · fall-through UNKNOWN', () => {
  const jpy = computeReplacementLandedCost(
    { currency: 'JPY', quoted_price_per_offer: 1500, quoted_price_per_physical_unit: 300, physical_units_per_offer: 5 },
    { usdKrw: 1300 /* only USD provided */ },
  );
  assert.equal(jpy.product_cost.status, 'UNKNOWN');

  const cny = computeReplacementLandedCost(
    { currency: 'CNY', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: 1300 },
  );
  assert.equal(cny.product_cost.status, 'UNKNOWN');

  const jpyOk = computeReplacementLandedCost(
    { currency: 'JPY', quoted_price_per_offer: 1500, quoted_price_per_physical_unit: 300, physical_units_per_offer: 5 },
    { krwJpyRate: 9 },
  );
  assert.equal(jpyOk.product_cost.status, 'AVAILABLE');
  assert.equal(jpyOk.product_cost.amount_krw_per_offer, 13500);
});

test('FX6. Unknown currency code (BTC, XYZ) → UNKNOWN · never silently uses USD rate as fallback', () => {
  const res = computeReplacementLandedCost(
    { currency: 'BTC', quoted_price_per_offer: 0.01, quoted_price_per_physical_unit: 0.002, physical_units_per_offer: 5 },
    { usdKrw: 1300 },
  );
  assert.equal(res.product_cost.status, 'UNKNOWN');
});

test('FX7. FX provenance surfaces source_currency / target_currency / fx_source / fx_observed_at', () => {
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: 1300, usdKrwSource: 'pricing_safety_sot', usdKrwObservedAt: '2026-08-18T00:00:00Z' },
  );
  assert.equal(res.product_cost.fx.source_currency, 'USD');
  assert.equal(res.product_cost.fx.target_currency, 'KRW');
  assert.equal(res.product_cost.fx.fx_rate, 1300);
  assert.equal(res.product_cost.fx.fx_source, 'pricing_safety_sot');
  assert.equal(res.product_cost.fx.fx_observed_at, '2026-08-18T00:00:00Z');
});

// ─── Product cost invariants ─────────────────────────────

test('PC1. quoted_price_per_offer null / 0 / negative → UNKNOWN', () => {
  for (const bad of [null, 0, -100, undefined, NaN]) {
    const res = computeReplacementLandedCost(
      { currency: 'KRW', quoted_price_per_offer: bad, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 },
      { usdKrw: 1300 },
    );
    assert.equal(res.product_cost.status, 'UNKNOWN', `bad=${bad} must yield UNKNOWN`);
    assert.ok(res.product_cost.missing.includes('quoted_price_per_offer'), `bad=${bad} must list quoted_price_per_offer as missing`);
  }
});

test('PC2. physical_units_per_offer 0 / negative / missing → UNKNOWN', () => {
  for (const bad of [0, -1, undefined]) {
    const res = computeReplacementLandedCost(
      { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: null, physical_units_per_offer: bad },
      { usdKrw: 1300 },
    );
    assert.equal(res.product_cost.status, 'UNKNOWN', `bad=${bad} must yield UNKNOWN`);
    assert.ok(res.product_cost.missing.includes('physical_units_per_offer'));
  }
});

test('PC3. Per-physical = per-offer / physical_units_per_offer · rounded to 2 decimals', () => {
  const res = computeReplacementLandedCost(
    { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 3 },
    { usdKrw: 1300 },
  );
  //   100000 / 3 = 33333.333... → rounded 33333.33
  assert.equal(res.product_cost.amount_krw_per_physical, 33333.33);
  assert.equal(res.product_cost.amount_krw_per_offer, 100000);
});

test('PC4. FX conversion applied to per-offer FIRST, then divided by physical_units (order matters for rounding)', () => {
  //   100 USD × 1300 = 130000 KRW · / 5 units = 26000 KRW/unit
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: 1300 },
  );
  assert.equal(res.product_cost.amount_krw_per_offer, 130000);
  assert.equal(res.product_cost.amount_krw_per_physical, 26000);
});

test('PC5. source_quoted_price_per_offer/physical preserve original native amounts verbatim · provenance', () => {
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: 1300 },
  );
  assert.equal(res.product_cost.source_currency, 'USD');
  assert.equal(res.product_cost.source_quoted_price_per_offer, 100);
  assert.equal(res.product_cost.source_quoted_price_per_physical, 20);
});

// ─── Landed cost invariants — all-or-nothing semantic ─────

test('L1. Landed cost INCOMPLETE when ANY of {product, freight, duty, tax, fees} is null · amount NULL (never 0)', () => {
  const base = { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 };
  const complete = { freightKrwPerOffer: 5000, dutyKrwPerOffer: 2000, taxKrwPerOffer: 3000, feesKrwPerOffer: 1000 };
  // baseline: all provided → COMPLETE
  const okRes = computeReplacementLandedCost(base, { usdKrw: 1300, ...complete });
  assert.equal(okRes.landed_cost.status, 'COMPLETE');
  assert.equal(okRes.landed_cost.amount_krw_per_offer, 111000);

  // remove each one → INCOMPLETE
  for (const drop of ['freightKrwPerOffer', 'dutyKrwPerOffer', 'taxKrwPerOffer', 'feesKrwPerOffer']) {
    const opts = { usdKrw: 1300, ...complete };
    delete opts[drop];
    const res = computeReplacementLandedCost(base, opts);
    assert.equal(res.landed_cost.status, 'INCOMPLETE', `${drop} missing must yield INCOMPLETE`);
    assert.equal(res.landed_cost.amount_krw_per_offer, null, `${drop} missing must not fabricate a total`);
    assert.equal(res.landed_cost.amount_krw_per_physical, null);
  }
});

test('L2. Landed cost INCOMPLETE cascades from product-cost UNKNOWN · both product and landed missing marked', () => {
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { /* no usdKrw */ freightKrwPerOffer: 5000, dutyKrwPerOffer: 2000, taxKrwPerOffer: 3000, feesKrwPerOffer: 1000 },
  );
  assert.equal(res.product_cost.status, 'UNKNOWN');
  assert.equal(res.landed_cost.status, 'INCOMPLETE');
  assert.ok(res.landed_cost.missing.includes('product_cost_krw'));
});

test('L3. Landed cost formula: product + freight + duty + tax + fees · per-offer · then / physical_units for per-physical', () => {
  const res = computeReplacementLandedCost(
    { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 },
    { usdKrw: 1300, freightKrwPerOffer: 10000, dutyKrwPerOffer: 5000, taxKrwPerOffer: 8000, feesKrwPerOffer: 2000 },
  );
  //   product 100000 + freight 10000 + duty 5000 + tax 8000 + fees 2000 = 125000 KRW/offer
  //   / 5 physical = 25000 KRW/physical
  assert.equal(res.landed_cost.amount_krw_per_offer, 125000);
  assert.equal(res.landed_cost.amount_krw_per_physical, 25000);
  assert.equal(res.landed_cost.components.product_cost_krw, 100000);
  assert.equal(res.landed_cost.components.freight_krw, 10000);
  assert.equal(res.landed_cost.components.duty_krw, 5000);
  assert.equal(res.landed_cost.components.tax_krw, 8000);
  assert.equal(res.landed_cost.components.fees_krw, 2000);
});

test('L4. Landed components each round-tripped verbatim (no coercion to 0)', () => {
  //   Verifies _numOrNull(v) returns null for undefined, NOT 0.
  const base = { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 };
  const res = computeReplacementLandedCost(base, { usdKrw: 1300, freightKrwPerOffer: undefined, dutyKrwPerOffer: 0, taxKrwPerOffer: 0, feesKrwPerOffer: 0 });
  //   freight is undefined → INCOMPLETE
  assert.equal(res.landed_cost.status, 'INCOMPLETE');
  assert.equal(res.landed_cost.components.freight_krw, null);
  //   duty/tax/fees explicit 0 → present as 0 (not null)
  assert.equal(res.landed_cost.components.duty_krw, 0);
  assert.equal(res.landed_cost.components.tax_krw, 0);
  assert.equal(res.landed_cost.components.fees_krw, 0);
});

test('L5. Landed components explicit 0 for all → COMPLETE · total = product only', () => {
  //   Freight/duty/tax/fees legitimately 0 (e.g., domestic KRW supplier) →
  //   landed should be COMPLETE and equal product_cost.
  const res = computeReplacementLandedCost(
    { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 },
    { usdKrw: 1300, freightKrwPerOffer: 0, dutyKrwPerOffer: 0, taxKrwPerOffer: 0, feesKrwPerOffer: 0 },
  );
  assert.equal(res.landed_cost.status, 'COMPLETE');
  assert.equal(res.landed_cost.amount_krw_per_offer, 100000);
  assert.equal(res.landed_cost.amount_krw_per_physical, 20000);
});

test('L6. Owner rule pinned · null landed status NEVER 0-fabricated', () => {
  //   Explicit invariant test that any caller reading `landed_cost.amount_krw_per_offer`
  //   and finding it null must treat as UNKNOWN · never as 0.
  const res = computeReplacementLandedCost(
    { currency: 'KRW', quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 },
    { usdKrw: 1300 /* no freight/duty/tax/fees */ },
  );
  assert.equal(res.landed_cost.status, 'INCOMPLETE');
  assert.notEqual(res.landed_cost.amount_krw_per_offer, 0, 'null !== 0 · Owner Part F');
  assert.equal(res.landed_cost.amount_krw_per_offer, null);
});

// ─── Cross-invariants · unit safety ─────────────────────────

test('X1. Currency case-insensitivity: usd == USD == Usd', () => {
  const usd = computeReplacementLandedCost({ currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 }, { usdKrw: 1300 });
  const lc  = computeReplacementLandedCost({ currency: 'usd', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 }, { usdKrw: 1300 });
  const mc  = computeReplacementLandedCost({ currency: 'Usd', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 }, { usdKrw: 1300 });
  assert.equal(usd.product_cost.amount_krw_per_offer, 130000);
  assert.equal(lc.product_cost.amount_krw_per_offer,  130000);
  assert.equal(mc.product_cost.amount_krw_per_offer,  130000);
});

test('X2. Empty / null / undefined currency → UNKNOWN · never assumes KRW as default', () => {
  for (const bad of ['', null, undefined]) {
    const res = computeReplacementLandedCost(
      { currency: bad, quoted_price_per_offer: 100000, quoted_price_per_physical_unit: 20000, physical_units_per_offer: 5 },
      { usdKrw: 1300 },
    );
    assert.equal(res.product_cost.status, 'UNKNOWN', `bad currency=${JSON.stringify(bad)} must NOT default to KRW`);
  }
});

test('X3. Fee/tax/duty/freight are all treated as KRW · no per-component FX', () => {
  //   The opts hand-labeled *KrwPerOffer — verify no accidental multiplication
  //   by fx.rate on these components.
  const res = computeReplacementLandedCost(
    { currency: 'USD', quoted_price_per_offer: 100, quoted_price_per_physical_unit: 20, physical_units_per_offer: 5 },
    { usdKrw: 1300, freightKrwPerOffer: 10000, dutyKrwPerOffer: 5000, taxKrwPerOffer: 8000, feesKrwPerOffer: 2000 },
  );
  //   product = 100 USD × 1300 = 130000 KRW · plus 10000+5000+8000+2000 = 155000
  assert.equal(res.landed_cost.amount_krw_per_offer, 155000);
  //   If any component had been re-multiplied by 1300, total would be off by ~million.
});
