'use strict';

/**
 * tests/services/ebay/skuAuthorityValidator.test.js — Phase 8P-22B.
 *
 * Deterministic unit tests for validateEbaySkuAuthority.
 * No DB · no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEbaySkuAuthority, isPriceShapedEbaySku, isUuidShapedEbaySku } = require('../../../src/services/ebay/skuAuthorityValidator');

test('validateEbaySkuAuthority · price-shaped values are rejected', () => {
  for (const v of ['19.90', '47.94', '90.0', '0.99', '1234.56']) {
    const r = validateEbaySkuAuthority(v);
    assert.equal(r.ok, false, `expected reject for '${v}'`);
    assert.equal(r.verdict, 'INVALID_PRICE_SHAPED');
  }
});

test('validateEbaySkuAuthority · UUID fallback flag rejects UUID-shape', () => {
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const asFallback = validateEbaySkuAuthority(uuid, { canonicalUuidArtifact: true });
  assert.equal(asFallback.ok, false);
  assert.equal(asFallback.verdict, 'INVALID_UUID_ARTIFACT');
  //   Without the fallback flag a bare UUID string is NOT rejected by pattern alone.
  const asObserved = validateEbaySkuAuthority(uuid);
  assert.equal(asObserved.ok, true);
});

test('validateEbaySkuAuthority · blank / null / whitespace', () => {
  for (const v of [null, undefined, '', '   ', '\t\n']) {
    const r = validateEbaySkuAuthority(v);
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'INVALID_BLANK');
  }
});

test('validateEbaySkuAuthority · non-unique across listings is rejected', () => {
  const observed = new Set(['205948758686', '206406729898']);
  const r = validateEbaySkuAuthority('SHARED-KEY-A', { observedListingIds: observed });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'INVALID_NON_UNIQUE');
});

test('validateEbaySkuAuthority · legitimate seller SKU accepted', () => {
  const r = validateEbaySkuAuthority('POKEMON-SV8A-KR-BOX');
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'VALID_AUTHORITY');
});

test('validateEbaySkuAuthority · numeric short "90" NOT rejected by shape alone (evidence-based)', () => {
  //   Owner rule: do not create a broad "short numeric always invalid" rule.
  const r = validateEbaySkuAuthority('90');
  assert.equal(r.ok, true, 'plain "90" with no non-uniqueness evidence should NOT be rejected');
});

test('validateEbaySkuAuthority · "90" IS rejected when observed on >1 listing', () => {
  const r = validateEbaySkuAuthority('90', { observedListingIds: new Set(['A', 'B']) });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'INVALID_NON_UNIQUE');
});

test('validateEbaySkuAuthority · control characters rejected', () => {
  const r = validateEbaySkuAuthority('BAD\x00SKU');
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'INVALID_OTHER');
});

test('isPriceShapedEbaySku / isUuidShapedEbaySku helpers', () => {
  assert.equal(isPriceShapedEbaySku('19.90'), true);
  assert.equal(isPriceShapedEbaySku('19'), false);
  assert.equal(isUuidShapedEbaySku('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), true);
  assert.equal(isUuidShapedEbaySku('not-a-uuid'), false);
});
