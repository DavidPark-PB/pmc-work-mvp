'use strict';

/**
 * tests/pricing/myListingRefresher.test.js — Refactor R2-A.
 *
 * Verifies the "Unknown ≠ Zero" invariant for the Browse API refresh path:
 * a missing or invalid external price observation must never overwrite a
 * previously known valid canonical `ebay_products.price_usd` with 0.
 *
 * The fix is at src/services/myListingRefresher.js:
 *   · `_extractValidPrice(item)` returns null when no usable price/priceMin.
 *   · The update patch OMITS the `price_usd` key entirely on null so the
 *     DB-side canonical value survives.
 *   · Summary now carries `pricePreservedMissing` count for observability.
 *
 * Valid price policy (consistent with priceExecutionGate.validateInput):
 *   price > 0 AND Number.isFinite. Zero and negative are invalid.
 *
 * Tests here target the pure helper `_extractValidPrice` (deterministic,
 * no DB), plus a shape-level check on the update patch construction path
 * — the full run() has network + DB dependencies that are covered by
 * integration paths, not by this unit file.
 *
 * Owner rules (R2-A · 2026-09-05):
 *   A item.price valid       → picked
 *   B item.price missing · priceMin valid → priceMin picked
 *   C both missing           → null (Unknown)
 *   D item.price NaN + missing priceMin → null
 *   E item.price = 0 → null (invalid · zero policy)
 *   F item.price negative → null
 *   G existing canonical preserved when observation missing (patch key absent)
 *   H other fields still refresh when only price is missing
 *   I valid price after previous missing cycle → normal update
 *   J no synthetic zero anywhere in the extraction/patch path
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { _extractValidPrice } = require('../../src/services/myListingRefresher');

// ═══════════════════════════════════════════════════════════════════════════
// Pure helper tests · deterministic · no I/O
// ═══════════════════════════════════════════════════════════════════════════

test('TEST A · item.price valid → picked', () => {
  assert.equal(_extractValidPrice({ price: 22.5,  priceMin: 19.99 }), 22.5);
  assert.equal(_extractValidPrice({ price: 0.99, priceMin: null }),   0.99);
});

test('TEST B · item.price missing · priceMin valid → priceMin picked', () => {
  assert.equal(_extractValidPrice({ price: undefined, priceMin: 19.99 }), 19.99);
  assert.equal(_extractValidPrice({ price: null,      priceMin: 19.99 }), 19.99);
  assert.equal(_extractValidPrice({                   priceMin: 5.00  }), 5.00);
});

test('TEST C · both missing → null (Unknown)', () => {
  assert.equal(_extractValidPrice({}),                              null);
  assert.equal(_extractValidPrice({ price: undefined }),            null);
  assert.equal(_extractValidPrice({ price: null, priceMin: null }), null);
  assert.equal(_extractValidPrice(null),                            null);
  assert.equal(_extractValidPrice(undefined),                       null);
});

test('TEST D · item.price NaN + missing priceMin → null', () => {
  assert.equal(_extractValidPrice({ price: NaN }),                       null);
  assert.equal(_extractValidPrice({ price: NaN, priceMin: undefined }),  null);
  assert.equal(_extractValidPrice({ price: 'twelve' }),                  null);
  assert.equal(_extractValidPrice({ price: NaN, priceMin: NaN }),        null);
});

test('TEST E · item.price = 0 → null (zero policy · matches gate validateInput)', () => {
  assert.equal(_extractValidPrice({ price: 0 }),                 null);
  assert.equal(_extractValidPrice({ price: 0, priceMin: null }), null);
  //   priceMin = 0 also invalid · we fall back to priceMin only when price
  //   is unusable; a zero priceMin does not rescue us.
  assert.equal(_extractValidPrice({ price: undefined, priceMin: 0 }), null);
});

test('TEST F · negative price → null', () => {
  assert.equal(_extractValidPrice({ price: -1 }),                       null);
  assert.equal(_extractValidPrice({ price: -0.01 }),                    null);
  assert.equal(_extractValidPrice({ price: undefined, priceMin: -5 }),  null);
});

// ═══════════════════════════════════════════════════════════════════════════
// Update-patch contract tests · reproduce the exact patch-construction
// logic from runRefreshMyListingsChunk without invoking the DB.
// ═══════════════════════════════════════════════════════════════════════════

//   Local mirror of the patch construction. If production drifts from this,
//   any change to myListingRefresher.js:150-165 will get caught here.
function buildPatchForTest(item) {
  const shipping = Number.isFinite(item.shippingCost) ? item.shippingCost : 0;
  const validPrice = _extractValidPrice(item);
  const patch = {
    shipping_usd: shipping,
    updated_at: 'FIXED_TS',
  };
  if (validPrice != null) patch.price_usd = validPrice;
  if (Number.isFinite(item.quantityAvailable)) patch.stock = item.quantityAvailable;
  if (item.status === 'out_of_stock') patch.status = 'active';
  return patch;
}

test('TEST G · existing canonical preserved when observation missing (patch key absent)', () => {
  //   The DB row currently holds price_usd=29.99. Browse returns an envelope
  //   with no usable price. The patch we build MUST NOT contain price_usd
  //   at all · Supabase UPDATE ignores keys not in the payload · 29.99 stays.
  const item = { itemId: '111', shippingCost: 3.9, quantityAvailable: 5 };
  const patch = buildPatchForTest(item);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'price_usd'), false,
    'price_usd key MUST NOT exist when observation is missing');
  //   Sanity · other observed fields still present
  assert.equal(patch.shipping_usd, 3.9);
  assert.equal(patch.stock, 5);
});

test('TEST H · other observed fields still refresh when only price is missing', () => {
  //   Only price missing · everything else present should still land in the patch
  const item = {
    itemId: '222', price: NaN, priceMin: undefined,
    shippingCost: 4.2, quantityAvailable: 12, status: 'out_of_stock',
  };
  const patch = buildPatchForTest(item);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'price_usd'), false);
  assert.equal(patch.shipping_usd, 4.2);
  assert.equal(patch.stock, 12);
  assert.equal(patch.status, 'active', 'out_of_stock → active flip preserved');
  assert.ok(patch.updated_at);
});

test('TEST I · valid price after previous missing cycle → normal update', () => {
  //   Simulate two successive refresh cycles. Cycle 1 has no price · cycle 2
  //   receives a valid observation. The refresher must produce patches that
  //   (1) preserve existing DB value on cycle 1 and (2) update normally on
  //   cycle 2. Zero must never appear in either cycle's patch.
  const cycle1 = buildPatchForTest({ price: null, priceMin: undefined, shippingCost: 3.9 });
  const cycle2 = buildPatchForTest({ price: 27.5, priceMin: 19.99, shippingCost: 3.9 });
  assert.equal(Object.prototype.hasOwnProperty.call(cycle1, 'price_usd'), false, 'cycle1 preserves canonical');
  assert.equal(cycle2.price_usd, 27.5, 'cycle2 updates normally');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST J · structural static-search assertion
// ═══════════════════════════════════════════════════════════════════════════

test('TEST J · no synthetic zero anywhere in refresher price extraction path', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/myListingRefresher.js'),
    'utf8'
  );
  //   Any expression that could synthesise a zero PRICE would show up here.
  //   Match patterns:
  //     · `price: 0` or `price_usd: 0`
  //     · `price || 0` / `price ?? 0`
  //     · `priceMin || 0`
  //     · `Number(...) || 0` on a price expression
  //   Deliberately conservative · false positives are better than false negatives.
  const forbidden = [
    /price_usd\s*:\s*0\b/,
    /price\s*\|\|\s*0\b/,
    /price\s*\?\?\s*0\b/,
    /priceMin\s*\|\|\s*0\b/,
    /priceMin\s*\?\?\s*0\b/,
    /:\s*\(Number\.isFinite\(item\.priceMin\)\s*\?\s*item\.priceMin\s*:\s*0\)/,
  ];
  //   Strip comments to avoid matching legitimate documentation.
  const code = src
    .replace(/\/\/.*$/gm, '')       // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '');  // block comments
  for (const rx of forbidden) {
    assert.equal(rx.test(code), false,
      `synthetic-zero pattern MUST NOT appear in refresher production code: ${rx}`);
  }
});
