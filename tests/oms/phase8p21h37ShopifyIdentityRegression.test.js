'use strict';

/**
 * PHASE 8P-21H37
 * Shopify OMS identity regression guard.
 *
 * Protects the production-shape contract that fixed historical Item 19:
 *
 * Canonical camelCase:
 *   listingId
 *   variantId
 *   marketplaceSku
 *
 * must produce Shopify identity candidates in deterministic priority:
 *
 *   variant -> product -> sku
 *
 * No DB writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIdentityCandidates,
} = require('../../src/services/oms/omsSkuMatcher');

test('H37-1 Shopify production camelCase emits exact variant + product identities', () => {
  const item = {
    id: 19,
    listingId: '10682634666149',
    variantId: '48096374227109',
    marketplaceSku: null,
    title: 'for Luis Castrillon',
    quantity: 1,
    unitPrice: 251.41,
  };

  const candidates = buildIdentityCandidates('shopify', item);

  assert.deepEqual(candidates, [
    {
      channel: 'shopify',
      identityType: 'shopify_variant_id',
      identityValue: '48096374227109',
    },
    {
      channel: 'shopify',
      identityType: 'shopify_product_id',
      identityValue: '10682634666149',
    },
  ]);
});

test('H37-2 Shopify identity priority is variant -> product -> sku', () => {
  const candidates = buildIdentityCandidates('shopify', {
    listingId: 'PRODUCT-1',
    variantId: 'VARIANT-1',
    marketplaceSku: 'SKU-1',
  });

  assert.deepEqual(
    candidates.map(x => x.identityType),
    [
      'shopify_variant_id',
      'shopify_product_id',
      'shopify_sku',
    ]
  );
});

test('H37-3 snake_case regression must NOT silently masquerade as canonical input', () => {
  const candidates = buildIdentityCandidates('shopify', {
    listing_id: 'PRODUCT-1',
    variant_id: 'VARIANT-1',
    marketplace_sku: 'SKU-1',
  });

  assert.deepEqual(candidates, []);
});

test('H37-4 title must never become identity evidence', () => {
  const candidates = buildIdentityCandidates('shopify', {
    listingId: null,
    variantId: null,
    marketplaceSku: null,
    title: 'for Luis Castrillon',
  });

  assert.deepEqual(candidates, []);
});

test('H37-5 null/blank identities are ignored', () => {
  const candidates = buildIdentityCandidates('shopify', {
    listingId: '',
    variantId: '   ',
    marketplaceSku: null,
  });

  assert.deepEqual(candidates, []);
});

test('H37-6 Shopify identity values are normalized to strings', () => {
  const candidates = buildIdentityCandidates('shopify', {
    listingId: 10682634666149,
    variantId: 48096374227109,
    marketplaceSku: null,
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].identityValue, '48096374227109');
  assert.equal(candidates[1].identityValue, '10682634666149');

  for (const candidate of candidates) {
    assert.equal(typeof candidate.identityValue, 'string');
  }
});
