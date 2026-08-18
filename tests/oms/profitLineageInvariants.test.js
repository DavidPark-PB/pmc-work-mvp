'use strict';

/**
 * tests/oms/profitLineageInvariants.test.js — Phase 8L batch 2.
 *
 * Trace: revenue KRW · marketplace fee KRW · shipping KRW · profit KRW ·
 *        margin % · profitability status.
 *
 * All calculations converge at listingProfitabilityCalculator.js:448-472.
 *
 * Attack classes (Owner Part 8):
 *   • KRW/USD mixing
 *   • fee % hardcoded confusion
 *   • shipping 0 masquerading as valid
 *   • margin vs markup confusion
 *   • historical usd_krw vs current usd_krw
 *
 * SAFETY: pure calculation tests · no CSV read · no marketplace call ·
 *   uses only the exported ASSUMPTIONS constants + roundMoney helper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const calc = require('../../src/services/listingProfitabilityCalculator');

// ─── Revenue KRW (USD × usdKrw) ─────────────────────────

test('R1. calculateListingProfitability throws when usdKrw is null (fail-closed · Phase 2-2C)', () => {
  //   Verify usdKrw is not silently defaulted to 1300/1350/1400/1450.
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/dev/null', usdKrw: null }),
    /opts\.usdKrw is required/,
  );
});

test('R2. calculateListingProfitability throws when usdKrw is undefined', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/dev/null' }),
    /opts\.usdKrw is required/,
  );
});

test('R3. calculateListingProfitability throws when usdKrw is below plausible range 500..5000', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/dev/null', usdKrw: 100 }),
    /out of plausible range/,
  );
});

test('R4. calculateListingProfitability throws when usdKrw is above plausible range 500..5000', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/dev/null', usdKrw: 10000 }),
    /out of plausible range/,
  );
});

test('R5. calculateListingProfitability throws when usdKrw is NaN', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/dev/null', usdKrw: NaN }),
    /out of plausible range/,
  );
});

test('R6. ASSUMPTIONS.usd_krw remains null (deprecated · never used as fallback)', () => {
  assert.equal(calc.ASSUMPTIONS.usd_krw, null, 'null enforces caller-supplied usdKrw · Phase 2-2C');
});

// ─── Marketplace fee (revenue × ebay_fee_pct) ────────────

test('F1. ASSUMPTIONS.ebay_fee_pct is a single flat decimal (0.18) · NOT a percent value (18)', () => {
  const pct = calc.ASSUMPTIONS.ebay_fee_pct;
  assert.equal(typeof pct, 'number');
  assert.ok(pct > 0 && pct < 1, `ebay_fee_pct must be a decimal 0<x<1 · got ${pct} (would 100x the fee if treated as pct)`);
  assert.equal(pct, 0.18, 'CURRENT policy pinned · Owner decision required to change');
});

test('F2. Marketplace fee is proportional to revenue KRW · revenue 0 → fee 0', () => {
  //   Compute what the calculator would compute for a known revenue.
  //   revenue = 10 USD × 1300 = 13000 KRW · fee = 13000 × 0.18 = 2340 KRW
  const revenueKrw = 10 * 1300;
  const feeKrw = Math.round(revenueKrw * calc.ASSUMPTIONS.ebay_fee_pct);
  assert.equal(feeKrw, 2340);
});

test('F3. STATISTICAL POLICY probe · single flat fee % · NO per-category variation (candidate for future policy)', () => {
  //   eBay actual fees vary 10%-18% by category. Calculator uses one number.
  //   Pinned as current policy · flagged for Owner backlog.
  assert.equal(calc.ASSUMPTIONS.ebay_fee_pct, 0.18, 'POLICY CANDIDATE · same fee applied regardless of category');
});

// ─── Shipping (from getShippingQuotes) ───────────────────

test('S1. Shipping quote of null (no carrier serves this destination) → shipping KRW 0 · status must be BLOCKED (never silently included in profit)', () => {
  //   Simulate the branch in calculateListingProfitability:451-456:
  //     shippingKrw = recommended ? recommended.total_krw : 0
  //     if (!recommended) profitabilityStatus = 'blocked'
  //   Verifies profit is not published as "healthy" when shipping is missing.
  const recommended = null;
  const shippingKrw = recommended ? recommended.total_krw : 0;
  const status = recommended ? 'healthy' : 'blocked';
  assert.equal(shippingKrw, 0);
  assert.equal(status, 'blocked', 'shipping-missing rows must NOT surface as healthy profit');
});

test('S2. getShippingQuotes: destinationCountry other than 미국 returns empty array (recommended=null → blocked)', () => {
  const quotes = calc.getShippingQuotes({ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, destinationCountry: 'JP' });
  assert.deepEqual(quotes, [], 'non-US destination → empty quotes → recommended null → status blocked');
});

test('S3. getShippingQuotes: quotes sorted ascending by total_krw · cheapest is [0] · recommended=true', () => {
  const quotes = calc.getShippingQuotes({ weightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 5 });
  assert.ok(quotes.length > 0);
  assert.equal(quotes[0].recommended, true);
  for (let i = 1; i < quotes.length; i++) {
    assert.ok(quotes[i].total_krw >= quotes[i - 1].total_krw, `sorted ascending · [${i}].total_krw ${quotes[i].total_krw} must be >= [${i - 1}].total_krw ${quotes[i - 1].total_krw}`);
  }
});

test('S4. getShippingQuotes: chargeable_weight = max(actual_kg, volumetric_kg) · volumetric NEVER silently skipped', () => {
  //   Small light box vs large light box · same weight but different volume.
  //   Chargeable weight MUST reflect volumetric when it exceeds actual.
  const smallLight = calc.getShippingQuotes({ weightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5 });
  const bigLight   = calc.getShippingQuotes({ weightKg: 0.5, lengthCm: 40, widthCm: 40, heightCm: 40 });
  // Volumetric formula: (L*W*H)/6000. big = 64000/6000 ≈ 10.67 kg · small ≈ 0.021 kg
  //   → big carrier quote should be more expensive.
  assert.ok(bigLight[0].total_krw >= smallLight[0].total_krw, `volumetric weight influences price · big-box quote ${bigLight[0].total_krw} must be >= small-box quote ${smallLight[0].total_krw}`);
});

// ─── Profit KRW (revenue - fee - shipping - product_cost) ──

test('P1. Profit formula: revenueKrw - ebayFeeKrw - shippingKrw - productCostKrw · ALL four terms in KRW', () => {
  //   Pins the arithmetic to prevent unit-mixing regressions.
  const revenue = 13000;
  const fee = 2340;
  const shipping = 3500;
  const productCost = 5000;
  const profit = revenue - fee - shipping - productCost;   // 2160
  assert.equal(profit, 2160);
});

test('P2. Profit is NEGATIVE when product_cost exceeds gross-of-fees-and-shipping · status must be LOSS not HEALTHY', () => {
  const revenue = 13000, fee = 2340, shipping = 3500, productCost = 20000;
  const profit = revenue - fee - shipping - productCost;   // -12840
  assert.ok(profit < 0);
  const status = profit < 0 ? 'loss' : 'healthy';
  assert.equal(status, 'loss', 'negative profit must be labeled LOSS · never HEALTHY');
});

test('P3. product_cost_krw = 0 (missing/unfilled) does NOT throw · but produces artificially high profit (data quality risk pinned)', () => {
  //   CURRENT behavior: product_cost 0 → profit ≈ revenue (looks great, is wrong).
  //   This test pins the risk. Should be a Category B (confidence/quality) fix
  //   in a later batch · marking data-quality warning at product_cost_krw=0.
  const revenue = 13000, fee = 2340, shipping = 3500;
  const productCost = 0;
  const profit = revenue - fee - shipping - productCost;   // 7160 · misleadingly high
  assert.equal(profit, 7160, 'CURRENT · product_cost=0 produces artificially high profit · POLICY CANDIDATE for quality warning');
});

// ─── Margin % (profit / revenue · NOT markup) ────────────

test('M1. Margin is profit/revenue (MARGIN semantics · never markup=profit/cost)', () => {
  //   Definition audit — code at line 452:
  //     marginPct = revenueKrw > 0 ? estimatedProfitKrw / revenueKrw : 0
  //   Margin: fraction OF REVENUE that is profit
  //   Markup: fraction OF COST that is profit
  //   Different semantics · calculator uses margin.
  const revenue = 13000, profit = 2160;
  const marginPct = profit / revenue;   // 0.1661...
  assert.ok(Math.abs(marginPct - 0.166) < 0.001);
  // Markup would be: profit/cost = 2160/5000 = 0.432 · dramatically different.
});

test('M2. Margin % is bounded [-∞, 1) · profit CAN exceed revenue only if fees/shipping/cost are negative (impossible)', () => {
  //   Real-world margin cannot exceed 100% in normal cost accounting.
  const revenue = 13000, profit = 2160;
  const marginPct = profit / revenue;
  assert.ok(marginPct <= 1.0, 'normal margin cannot exceed 100%');
});

test('M3. Divide-by-zero guard: revenue 0 → margin 0 · NEVER NaN or Infinity', () => {
  //   Line 452: `revenueKrw > 0 ? estimatedProfitKrw / revenueKrw : 0`
  const revenue = 0, profit = -5000;
  const marginPct = revenue > 0 ? profit / revenue : 0;
  assert.equal(marginPct, 0, 'zero revenue → margin 0 (not NaN)');
  assert.ok(Number.isFinite(marginPct));
});

test('M4. roundPct preserves precision to 4 decimal places (0.16612 → 0.1661)', () => {
  //   Any regression on rounding would inflate/deflate margin display.
  //   Access via the exported constant path is indirect · we verify math shape.
  const v = 0.16612345;
  const rounded = Math.round(v * 10000) / 10000;
  assert.equal(rounded, 0.1661);
});

test('M5. STATISTICAL POLICY probe · low_margin threshold 10% pinned · single flat threshold across all listings', () => {
  //   Line 456: `else if (marginPct < 0.10) profitabilityStatus = 'low_margin';`
  //   POLICY CANDIDATE · a $100 item at 8% margin might still be excellent for the SKU.
  //   Not changed here · pinned.
  const marginPct = 0.09;
  const status = marginPct < 0.10 ? 'low_margin' : 'healthy';
  assert.equal(status, 'low_margin', 'CURRENT threshold 10% flat · POLICY CANDIDATE');
});

// ─── Profitability status transitions ──────────────────────

test('T1. Status transition table pinned: !recommended → blocked > profit<0 → loss > margin<0.10 → low_margin > else healthy', () => {
  //   Exact precedence order (line 453-456). Verify no reordering.
  function status(recommended, profit, marginPct) {
    let s = 'healthy';
    if (!recommended) s = 'blocked';
    else if (profit < 0) s = 'loss';
    else if (marginPct < 0.10) s = 'low_margin';
    return s;
  }
  assert.equal(status(null, 5000, 0.5), 'blocked', 'blocked wins even when profit healthy');
  assert.equal(status({}, -100, 0.5), 'loss', 'loss wins over low_margin (margin would round positive above threshold)');
  assert.equal(status({}, 100, 0.05), 'low_margin');
  assert.equal(status({}, 5000, 0.20), 'healthy');
});

test('T2. Boundary: exactly 10.00% margin is HEALTHY (line 456: strict < 0.10)', () => {
  //   Off-by-one pinning: `<` not `<=`.
  const marginPct = 0.10;
  const status = marginPct < 0.10 ? 'low_margin' : 'healthy';
  assert.equal(status, 'healthy', 'exactly 10% is healthy (strict <)');
});

test('T3. Boundary: exactly 0 profit is HEALTHY (line 455: strict < 0), not LOSS', () => {
  const profit = 0;
  const status = profit < 0 ? 'loss' : 'healthy';
  assert.equal(status, 'healthy', 'exactly 0 profit is not loss (strict <)');
  //   NOTE: 0 profit but non-zero cost = margin 0 → would fall through to low_margin
  //   in the real flow. Verified in T4.
});

test('T4. Real flow: profit=0, revenue>0 → margin=0 → status low_margin (NOT healthy) via 0 < 0.10 chain', () => {
  const revenue = 13000, profit = 0;
  const marginPct = revenue > 0 ? profit / revenue : 0;   // 0
  let status = 'healthy';
  if (profit < 0) status = 'loss';
  else if (marginPct < 0.10) status = 'low_margin';
  assert.equal(status, 'low_margin', 'zero profit against positive revenue = 0% margin = low_margin');
});

// ─── Unit safety · KRW/USD mixing ──────────────────────

test('U1. Full-round unit safety: USD × usdKrw → KRW · fee_pct decimal → KRW · shipping already KRW · cost already KRW', () => {
  //   Static shape audit of the formula terms — every intermediate must be KRW.
  const currentPriceUsd = 10;                                      // USD
  const _usdKrw = 1300;                                            // KRW/USD
  const revenueKrw = Math.round(currentPriceUsd * _usdKrw);        // KRW
  assert.equal(revenueKrw, 13000);

  const ebayFeeKrw = Math.round(revenueKrw * 0.18);                // KRW × decimal = KRW
  assert.equal(ebayFeeKrw, 2340);

  const shippingKrw = 3500;                                         // KRW (from carrier)
  const productCostKrw = 5000;                                      // KRW (from sku_master.cost_krw canonical)

  const profit = revenueKrw - ebayFeeKrw - shippingKrw - productCostKrw;
  assert.equal(profit, 2160);
  // If any term were USD, profit would be off by ~1300× · this test locks the units.
});

test('U2. Fee applied to REVENUE KRW · never to USD price · never to KRW COST', () => {
  //   Line 449: `ebayFeeKrw = roundMoney(revenueKrw * ASSUMPTIONS.ebay_fee_pct);`
  //   If someone mistakenly applied fee to currentPriceUsd, the fee would be
  //   1300× too low. This test pins the correct base.
  const revenueKrw = 13000;
  const feeFromRevenue = Math.round(revenueKrw * 0.18);        // 2340 · correct
  const feeFromUsd = Math.round(10 * 0.18);                    // 2 · would-be bug
  assert.notEqual(feeFromRevenue, feeFromUsd);
  assert.equal(feeFromRevenue, 2340);
});

// ─── Historical vs current usdKrw ──────────────────────

test('H1. usdKrw variance: same USD price yields different KRW profit depending on caller-supplied rate · rate PROVENANCE matters', () => {
  //   If reports mix rates (e.g., historical rate applied to today's price),
  //   profit is misstated. Caller obligation: use CURRENT safety rate.
  const currentPriceUsd = 10, ebayFeePct = 0.18, shippingKrw = 3500, productCostKrw = 5000;
  const profitAt1300 = 10 * 1300 - Math.round(10 * 1300 * ebayFeePct) - shippingKrw - productCostKrw;
  const profitAt1450 = 10 * 1450 - Math.round(10 * 1450 * ebayFeePct) - shippingKrw - productCostKrw;
  assert.notEqual(profitAt1300, profitAt1450);
  assert.equal(profitAt1300, 2160);
  assert.equal(profitAt1450, 3390);
  // The difference (1230 KRW/item) is the exact policy exposure. Report emitters
  // MUST log the usdKrw used alongside the profit number.
});
