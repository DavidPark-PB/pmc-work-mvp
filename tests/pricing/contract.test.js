'use strict';

/**
 * contract.test.js — Phase 1 Commit 9
 * ---------------------------------------------------------------------------
 * Source-aware validators for the pricing pipeline. No formula changes;
 * these lock the "13 vs 0.13 vs 13%" ambiguity down before values reach
 * any calculator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../../src/pricing/contract');
const E = c.CONTRACT_ERRORS;

/* ─────────────────────────── fee_rate (platforms → decimal) ─────────────────────────── */

test('feeRateFromPlatforms — 0.18 valid decimal', () => {
  const r = c.feeRateFromPlatforms(0.18);
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.18);
});
test('feeRateFromPlatforms — 0 valid (no fee)', () => {
  const r = c.feeRateFromPlatforms(0);
  assert.equal(r.ok, true);
  assert.equal(r.value, 0);
});
test('feeRateFromPlatforms — 1 valid (edge case 100%)', () => {
  const r = c.feeRateFromPlatforms(1);
  assert.equal(r.ok, true);
});
test('feeRateFromPlatforms — 13 rejected (wrong scale)', () => {
  const r = c.feeRateFromPlatforms(13);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.OUT_OF_EXPECTED_RANGE);
});
test('feeRateFromPlatforms — negative rejected', () => {
  const r = c.feeRateFromPlatforms(-0.1);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.NEGATIVE);
});
test('feeRateFromPlatforms — null rejected', () => {
  const r = c.feeRateFromPlatforms(null);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.NULL_OR_MISSING);
});
test('feeRateFromPlatforms — NaN rejected', () => {
  const r = c.feeRateFromPlatforms(NaN);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.NOT_A_NUMBER);
});

/* ─────────────────────────── fee_rate (ebay_products → percent) ─────────────────────────── */

test('feeRateFromEbayProducts — 13 → 0.13', () => {
  const r = c.feeRateFromEbayProducts(13);
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.13);
});
test('feeRateFromEbayProducts — string "13" → 0.13', () => {
  const r = c.feeRateFromEbayProducts('13');
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.13);
});
test('feeRateFromEbayProducts — 0 → 0', () => {
  const r = c.feeRateFromEbayProducts(0);
  assert.equal(r.ok, true);
  assert.equal(r.value, 0);
});
test('feeRateFromEbayProducts — 100 → 1 (edge)', () => {
  const r = c.feeRateFromEbayProducts(100);
  assert.equal(r.ok, true);
  assert.equal(r.value, 1);
});
test('feeRateFromEbayProducts — 0.13 rejected as AMBIGUOUS (looks decimal, column is percent)', () => {
  const r = c.feeRateFromEbayProducts(0.13);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.AMBIGUOUS_SCALE);
});
test('feeRateFromEbayProducts — 200 rejected (out of range)', () => {
  const r = c.feeRateFromEbayProducts(200);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.OUT_OF_EXPECTED_RANGE);
});
test('feeRateFromEbayProducts — negative rejected', () => {
  const r = c.feeRateFromEbayProducts(-5);
  assert.equal(r.ok, false);
});

test('feeRateFromMasterProducts — behaves like ebay_products', () => {
  assert.equal(c.feeRateFromMasterProducts(15).value, 0.15);
  assert.equal(c.feeRateFromMasterProducts(5.5).value, 0.055);
});

/* ─────────────────────────── fee_rate (platform_listings — ambiguous) ─────────────────────────── */

test('feeRateFromPlatformListings — no scaleHint → AMBIGUOUS_SCALE', () => {
  const r = c.feeRateFromPlatformListings(13);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.AMBIGUOUS_SCALE);
});
test('feeRateFromPlatformListings — scaleHint=decimal 0.18 valid', () => {
  const r = c.feeRateFromPlatformListings(0.18, { scaleHint: 'decimal' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.18);
});
test('feeRateFromPlatformListings — scaleHint=percent 13 → 0.13', () => {
  const r = c.feeRateFromPlatformListings(13, { scaleHint: 'percent' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.13);
});
test('feeRateFromPlatformListings — scaleHint=decimal but value=13 → out of range', () => {
  const r = c.feeRateFromPlatformListings(13, { scaleHint: 'decimal' });
  assert.equal(r.ok, false);
  assert.equal(r.error, E.OUT_OF_EXPECTED_RANGE);
});
test('feeRateFromPlatformListings — unknown scaleHint → AMBIGUOUS_SCALE', () => {
  const r = c.feeRateFromPlatformListings(13, { scaleHint: 'weird' });
  assert.equal(r.ok, false);
});

/* ─────────────────────────── currency ─────────────────────────── */

test('currencyForEbayPrice — USD valid', () => {
  const r = c.currencyForEbayPrice('USD');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'USD');
});
test('currencyForEbayPrice — lowercase usd → USD', () => {
  assert.equal(c.currencyForEbayPrice('usd').value, 'USD');
});
test('currencyForEbayPrice — KRW rejected (not USD)', () => {
  const r = c.currencyForEbayPrice('KRW');
  assert.equal(r.ok, false);
  assert.equal(r.error, E.UNSUPPORTED_CURRENCY);
});
test('currencyForEbayPrice — null rejected', () => {
  const r = c.currencyForEbayPrice(null);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.NULL_OR_MISSING);
});
test('currencyForEbayPrice — undefined rejected', () => {
  const r = c.currencyForEbayPrice(undefined);
  assert.equal(r.ok, false);
});
test('currencyForEbayPrice — empty string rejected', () => {
  const r = c.currencyForEbayPrice('');
  assert.equal(r.ok, false);
});

/* ─────────────────────────── exchange rate ─────────────────────────── */

test('exchangeRateKrwPerUsd — 1400 valid', () => {
  assert.equal(c.exchangeRateKrwPerUsd(1400).value, 1400);
});
test('exchangeRateKrwPerUsd — 0 rejected (silent default danger)', () => {
  const r = c.exchangeRateKrwPerUsd(0);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.ZERO_WHERE_POSITIVE_REQUIRED);
});
test('exchangeRateKrwPerUsd — negative rejected', () => {
  const r = c.exchangeRateKrwPerUsd(-100);
  assert.equal(r.ok, false);
});
test('exchangeRateKrwPerUsd — 100 rejected (out of range)', () => {
  const r = c.exchangeRateKrwPerUsd(100);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.OUT_OF_EXPECTED_RANGE);
});
test('exchangeRateKrwPerUsd — 10000 rejected (KRW/USD sanity)', () => {
  const r = c.exchangeRateKrwPerUsd(10000);
  assert.equal(r.ok, false);
});
test('exchangeRateKrwPerUsd — NaN rejected', () => {
  const r = c.exchangeRateKrwPerUsd(NaN);
  assert.equal(r.ok, false);
});
test('exchangeRateKrwPerUsd — Infinity rejected', () => {
  const r = c.exchangeRateKrwPerUsd(Infinity);
  assert.equal(r.ok, false);
});
test('exchangeRateKrwPerUsd — null rejected (no silent 1400 fallback)', () => {
  const r = c.exchangeRateKrwPerUsd(null);
  assert.equal(r.ok, false);
});

/* ─────────────────────────── weight ─────────────────────────── */

test('weightGram — 500 valid', () => {
  assert.equal(c.weightGram(500).value, 500);
});
test('weightGram — 0 rejected without allowZero', () => {
  const r = c.weightGram(0);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.ZERO_WHERE_POSITIVE_REQUIRED);
});
test('weightGram — 0 allowed with allowZero', () => {
  const r = c.weightGram(0, { allowZero: true });
  assert.equal(r.ok, true);
});
test('weightGram — negative rejected', () => {
  assert.equal(c.weightGram(-100).ok, false);
});
test('weightGram — 1.2 rejected (non-integer)', () => {
  const r = c.weightGram(1.2);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.NON_INTEGER);
});

test('weightKgToGram — 1.2 kg → 1200 g', () => {
  const r = c.weightKgToGram(1.2);
  assert.equal(r.ok, true);
  assert.equal(r.value, 1200);
});
test('weightKgToGram — 0.5 → 500', () => {
  assert.equal(c.weightKgToGram(0.5).value, 500);
});
test('weightKgToGram — 0 rejected without allowZero', () => {
  assert.equal(c.weightKgToGram(0).ok, false);
});
test('weightKgToGram — negative rejected', () => {
  assert.equal(c.weightKgToGram(-1).ok, false);
});

test('weightWithoutUnitTag — always MISSING_UNIT_TAG (no guessing)', () => {
  const r = c.weightWithoutUnitTag(1200);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.MISSING_UNIT_TAG);
});

/* ─────────────────────────── price / cost ─────────────────────────── */

test('sellingPriceUsd — 59 valid', () => {
  assert.equal(c.sellingPriceUsd(59).value, 59);
});
test('sellingPriceUsd — 0 rejected', () => {
  assert.equal(c.sellingPriceUsd(0).ok, false);
});
test('sellingPriceUsd — negative rejected', () => {
  assert.equal(c.sellingPriceUsd(-5).ok, false);
});
test('sellingPriceUsd — 2M rejected (runaway)', () => {
  const r = c.sellingPriceUsd(2_000_000);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.OUT_OF_EXPECTED_RANGE);
});
test('sellingPriceUsd — Infinity rejected', () => {
  assert.equal(c.sellingPriceUsd(Infinity).ok, false);
});

test('costKrw — 45000 valid', () => {
  assert.equal(c.costKrw(45000).value, 45000);
});
test('costKrw — 0 valid (free)', () => {
  assert.equal(c.costKrw(0).ok, true);
});
test('costKrw — negative rejected', () => {
  assert.equal(c.costKrw(-100).ok, false);
});
test('costKrw — 45000.5 rejected as non-integer by default', () => {
  const r = c.costKrw(45000.5);
  assert.equal(r.ok, false);
  assert.equal(r.error, E.NON_INTEGER);
});
test('costKrw — 45000.5 allowed with allowNonInteger', () => {
  assert.equal(c.costKrw(45000.5, { allowNonInteger: true }).ok, true);
});

/* ─────────────────────────── validatePricingInputs (batch) ─────────────────────────── */

test('validatePricingInputs — happy path', () => {
  const r = c.validatePricingInputs({
    feeRate:      { source: 'ebay_products', raw: 13 },
    currency:     'USD',
    exchangeRate: 1400,
    weight:       { source: 'weight_gram', raw: 500 },
    sellingPriceUsd: 59,
    costKrw:      45000,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    feeRate: 0.13, currency: 'USD', exchangeRate: 1400,
    weightGram: 500, sellingPriceUsd: 59, costKrw: 45000,
  });
});

test('validatePricingInputs — mixed sources', () => {
  const r = c.validatePricingInputs({
    feeRate: { source: 'platforms', raw: 0.18 },
    weight:  { source: 'weight_kg', raw: 1.2 },
    exchangeRate: 1450,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.feeRate, 0.18);
  assert.equal(r.value.weightGram, 1200);
});

test('validatePricingInputs — collects multiple errors', () => {
  const r = c.validatePricingInputs({
    feeRate:      { source: 'ebay_products', raw: -5 },
    currency:     'JPY',
    exchangeRate: 0,
    weight:       { source: 'weight_gram', raw: 0 },
    sellingPriceUsd: -1,
    costKrw:      -100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 6);
  const fields = r.errors.map(e => e.field).sort();
  assert.deepEqual(fields, ['costKrw', 'currency', 'exchangeRate', 'feeRate', 'sellingPriceUsd', 'weight']);
});

test('validatePricingInputs — unknown fee source → MISSING_UNIT_TAG', () => {
  const r = c.validatePricingInputs({ feeRate: { source: 'unknown_table', raw: 13 } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].error, E.MISSING_UNIT_TAG);
});

test('validatePricingInputs — missing fields are simply skipped', () => {
  const r = c.validatePricingInputs({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {});
});

/* ─────────────────────────── regression safety: existing pricing values still pass ─────────────────────────── */

test('regression — the healthy CASE A inputs from Commit 1 remain valid under the contract', () => {
  // From priceEngine.characterization.test CASE A:
  //   ebay fee 18% (platforms scale), USD price 59, cost KRW equivalent
  const r = c.validatePricingInputs({
    feeRate:         { source: 'platforms', raw: 0.18 },
    currency:        'USD',
    exchangeRate:    1450,
    sellingPriceUsd: 59,
    costKrw:         65000,
  });
  assert.equal(r.ok, true);
});
