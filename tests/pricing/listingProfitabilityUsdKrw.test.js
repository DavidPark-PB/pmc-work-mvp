'use strict';

/**
 * listingProfitabilityUsdKrw.test.js — Phase 2-2C
 * ---------------------------------------------------------------------------
 * Owner directive (2026-08-11):
 *   listingProfitabilityCalculator must not hold its own usd_krw constant
 *   anymore; every calculation function requires opts.usdKrw from the
 *   pricing safety SoT and fail-closes on missing/invalid values.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const calc = require('../../src/services/listingProfitabilityCalculator');

/* ─────────────────────────── ASSUMPTIONS deprecation ─────────────────────────── */

test('ASSUMPTIONS.usd_krw is now null (deprecated hardcode)', () => {
  assert.equal(calc.ASSUMPTIONS.usd_krw, null,
    'ASSUMPTIONS.usd_krw must be null in Phase 2-2C — callers supply opts.usdKrw');
});

test('ASSUMPTIONS still exports ebay_fee_pct and destination_country', () => {
  // Backward compat for report emitters
  assert.equal(calc.ASSUMPTIONS.ebay_fee_pct, 0.18);
  assert.equal(calc.ASSUMPTIONS.destination_country, '미국');
});

/* ─────────────────────────── fail-closed ─────────────────────────── */

test('calculateListingProfitability without opts.usdKrw → throws', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv' }),
    /opts\.usdKrw is required/
  );
});

test('calculateListingProfitability with usdKrw=null → throws', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv', usdKrw: null }),
    /opts\.usdKrw is required/
  );
});

test('calculateListingProfitability with usdKrw=0 → throws (silent-default guard)', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv', usdKrw: 0 }),
    /out of plausible range/
  );
});

test('calculateListingProfitability with usdKrw=NaN → throws', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv', usdKrw: NaN }),
    /out of plausible range/
  );
});

test('calculateListingProfitability with usdKrw=100 → throws (out of range)', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv', usdKrw: 100 }),
    /out of plausible range/
  );
});

test('calculateListingProfitability with usdKrw=10000 → throws (out of range)', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv', usdKrw: 10000 }),
    /out of plausible range/
  );
});

test('calculateListingProfitability with usdKrw=-1300 → throws', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/nonexistent.csv', usdKrw: -1300 }),
    /out of plausible range/
  );
});

test('calculateListingProfitabilityOverlay without opts.usdKrw → throws', () => {
  assert.throws(
    () => calc.calculateListingProfitabilityOverlay({ listings: '/a', overlay: '/b' }),
    /opts\.usdKrw is required/
  );
});

test('calculateListingProfitabilityOverlayFilled without opts.usdKrw → throws', () => {
  assert.throws(
    () => calc.calculateListingProfitabilityOverlayFilled({ listings: '/a', overlay: '/b' }),
    /opts\.usdKrw is required/
  );
});

/* ─────────────────────────── happy path (1300 accepted) ─────────────────────────── */

test('calculateListingProfitability accepts usdKrw=1300 (fails only later on missing file)', () => {
  // We're pinning that the validator does NOT throw at usdKrw=1300;
  // the downstream error is a file-not-found which is unrelated to the
  // contract check.
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/definitely/no/such/path.csv', usdKrw: 1300 }),
    /ENOENT|no such file/i
  );
});

test('calculateListingProfitability accepts usdKrw=1400', () => {
  assert.throws(
    () => calc.calculateListingProfitability({ file: '/definitely/no/such/path.csv', usdKrw: 1400 }),
    /ENOENT|no such file/i
  );
});

/* ─────────────────────────── engine1DryRunJob wiring ─────────────────────────── */

const engine1Src = fs.readFileSync(
  path.join(__dirname, '../../src/jobs/engine1DryRunJob.js'),
  'utf8'
);

test('engine1DryRunJob imports getPricingSafetyExchangeRate', () => {
  assert.match(engine1Src, /require\(['"]\.\.\/pricing\/rates['"]\)/);
  assert.match(engine1Src, /getPricingSafetyExchangeRate/);
});

test('engine1DryRunJob loads usdKrw once per run (bypassCache:true, fresh read)', () => {
  assert.match(engine1Src, /await getPricingSafetyExchangeRate\(\{\s*bypassCache:\s*true\s*\}\)/);
});

test('engine1DryRunJob no longer uses ASSUMPTIONS.usd_krw for landing cost', () => {
  // Both call sites (classifySharedParams + computeLandingCost) now use
  // the local usdKrw var, not ASSUMPTIONS.usd_krw.
  assert.equal(/usdKrw:\s*ASSUMPTIONS\.usd_krw/.test(engine1Src), false,
    'ASSUMPTIONS.usd_krw should not be passed as usdKrw anywhere in engine1');
});

test('engine1DryRunJob still uses ASSUMPTIONS.ebay_fee_pct (fee_pct is not owner-controlled SoT yet)', () => {
  assert.match(engine1Src, /ebayFeePct:\s*ASSUMPTIONS\.ebay_fee_pct/);
});

test('engine1DryRunJob aborts run on exchange rate load failure', () => {
  assert.match(engine1Src, /aborted:\s*'exchange_rate_load_failed'/);
});

test('engine1DryRunJob logs the effective pricing safety rate', () => {
  assert.match(engine1Src, /pricing safety rate = \$\{usdKrw\}/);
});

/* ─────────────────────────── hermes-agent.js wiring ─────────────────────────── */

const hermesSrc = fs.readFileSync(
  path.join(__dirname, '../../scripts/hermes-agent.js'),
  'utf8'
);

test('hermes-agent.js passes usdKrw to calculateListingProfitability', () => {
  assert.match(hermesSrc, /calculateListingProfitability\(\{ file, usdKrw \}\)/);
});

test('hermes-agent.js passes usdKrw to overlay + overlay-filled calculators', () => {
  assert.match(hermesSrc, /calculateListingProfitabilityOverlay\(\{ listings, overlay, usdKrw \}\)/);
  assert.match(hermesSrc, /calculateListingProfitabilityOverlayFilled\(\{ listings, overlay, usdKrw \}\)/);
});

test('hermes-agent.js requires pricing/rates helper', () => {
  const usageCount = (hermesSrc.match(/require\(['"]\.\.\/src\/pricing\/rates['"]\)/g) || []).length;
  assert.ok(usageCount >= 3,
    `expected pricing/rates required at each of the 3 calc entrypoints, found ${usageCount}`);
});

/* ─────────────────────────── no other hardcoded 1450 in the calculator ─────────────────────────── */

test('AUDIT: 1450 is no longer used in arithmetic in listingProfitabilityCalculator', () => {
  // Grep for arithmetic use of 1450 (assignment, *, /, +, -). The literal
  // appears in the deprecation error message text, which is expected — that
  // is a warning to future callers, not a computation. We reject only
  // arithmetic occurrences.
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/services/listingProfitabilityCalculator.js'),
    'utf8'
  );
  const arithmeticPatterns = [
    /=\s*1450\b/,      // usd_krw: 1450 or const foo = 1450
    /\*\s*1450\b/,     // multiply by 1450
    /\/\s*1450\b/,     // divide by 1450
    /\+\s*1450\b/, /-\s*1450\b/,
  ];
  for (const p of arithmeticPatterns) {
    assert.equal(p.test(src), false,
      `expected no arithmetic use of 1450 in the calculator; pattern matched: ${p}`);
  }
});
