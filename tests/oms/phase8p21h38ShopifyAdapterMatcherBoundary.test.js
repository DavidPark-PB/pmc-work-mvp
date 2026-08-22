'use strict';

/**
 * PHASE 8P-21H38
 *
 * Regression guard for the exact production boundary:
 *
 * Shopify raw line_item
 *   → shopifyOrderAdapter
 *   → CanonicalOrderItem camelCase
 *   → real omsSkuMatcher
 *   → marketplace_identity resolver
 *   → matched_link / high / identity_exact:shopify_variant_id
 *
 * NO production writes.
 * NO real DB writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
  };
}

const identityPath = require.resolve(
  '../../src/services/oms/marketplaceIdentityService'
);
const legacyMatcherPath = require.resolve(
  '../../src/services/skuMatcher'
);
const dbPath = require.resolve(
  '../../src/db/supabaseClient'
);
const omsMatcherPath = require.resolve(
  '../../src/services/oms/omsSkuMatcher'
);

/*
 * Identity resolver fixture:
 * Item19 exact Shopify variant identity → sku_master 9482.
 *
 * resolveItemCandidates deliberately consumes the candidates produced
 * by the REAL buildIdentityCandidates implementation.
 */
async function fakeResolveManyByIdentities(candidates) {
  return {
    resolve(candidate) {
      if (
        candidate &&
        candidate.channel === 'shopify' &&
        candidate.identityType === 'shopify_variant_id' &&
        candidate.identityValue === '48096374227109'
      ) {
        return {
          channel: 'shopify',
          identity_type: 'shopify_variant_id',
          identity_value: '48096374227109',
          sku_master_id: 9482,
          confidence: 'high',
          source: 'owner_confirmed',
        };
      }

      return null;
    },
  };
}

stub(identityPath, {
  resolveManyByIdentities: fakeResolveManyByIdentities,

  async resolveItemCandidates(candidates, opts = {}) {
    let resolver = opts.resolver;

    // Mirror production marketplaceIdentityService:
    // single-item path builds its own resolver when none is supplied.
    if (typeof resolver !== 'function') {
      const built = await fakeResolveManyByIdentities(candidates);
      resolver = built.resolve;
    }

    const hits = [];
    const seenSkuMasterIds = new Set();

    for (const c of candidates) {
      const hit = resolver(c);

      if (hit && hit.sku_master_id != null) {
        hits.push(hit);
        seenSkuMasterIds.add(hit.sku_master_id);
      }
    }

    if (hits.length === 0) {
      return {
        status: 'no_match',
        sku_master_id: null,
        hits: [],
      };
    }

    if (seenSkuMasterIds.size > 1) {
      return {
        status: 'conflict',
        sku_master_id: null,
        hits,
        conflictingSkuMasterIds: [...seenSkuMasterIds],
      };
    }

    return {
      status: 'matched',
      sku_master_id: hits[0].sku_master_id,
      hit: hits[0],
      hits,
    };
  },
});

/*
 * Legacy matcher must never be reached for the exact variant hit.
 */
let legacyCalls = 0;

stub(legacyMatcherPath, {
  async matchOrderLine() {
    legacyCalls += 1;
    throw new Error('legacy matcher must not run on exact identity hit');
  },
});

/*
 * Minimal read-only fake DB for:
 * sku_master #9482 internal_sku
 *   → products #24169
 */
stub(dbPath, {
  getClient() {
    return {
      from(table) {
        const state = {
          table,
          id: null,
          sku: null,
        };

        return {
          select() {
            return this;
          },

          eq(column, value) {
            if (column === 'id') state.id = value;
            if (column === 'sku') state.sku = value;
            return this;
          },

          async maybeSingle() {
            if (state.table === 'sku_master' && state.id === 9482) {
              return {
                data: { internal_sku: 'ITEM19-SKU' },
                error: null,
              };
            }

            if (
              state.table === 'products' &&
              state.sku === 'ITEM19-SKU'
            ) {
              return {
                data: { id: 24169 },
                error: null,
              };
            }

            return { data: null, error: null };
          },
        };
      },
    };
  },
});

delete require.cache[omsMatcherPath];

const {
  matchCanonicalItem,
  matchCanonicalItems,
  buildIdentityCandidates,
} = require(omsMatcherPath);

const {
  toCanonicalOrder,
} = require('../../src/services/oms/adapters/shopifyOrderAdapter');

function item19RawOrder() {
  return {
    id: 10682634666149,
    name: '#ITEM19-REGRESSION',
    order_number: 19,
    created_at: '2026-08-22T00:00:00Z',
    updated_at: '2026-08-22T00:00:00Z',
    financial_status: 'paid',
    fulfillment_status: null,
    currency: 'USD',

    subtotal_price: '251.41',
    total_discounts: '0.00',
    total_shipping_price_set: {
      shop_money: { amount: '0.00', currency_code: 'USD' },
    },
    total_tax: '0.00',
    total_price: '251.41',

    line_items: [
      {
        id: 190000000001,
        product_id: 10682634666149,
        variant_id: 48096374227109,
        sku: null,
        title: 'for Luis Castrillon',
        quantity: 1,
        price: '251.41',
        total_discount: '0.00',
      },
    ],

    customer: null,
    billing_address: null,
    shipping_address: null,
  };
}

test('H38-1 raw Shopify Item19 → canonical production camelCase identity fields', () => {
  const canonical = toCanonicalOrder(item19RawOrder());

  assert.equal(canonical.channel, 'shopify');
  assert.equal(canonical.items.length, 1);

  const item = canonical.items[0];

  assert.equal(item.listingId, '10682634666149');
  assert.equal(item.variantId, '48096374227109');
  assert.equal(item.marketplaceSku, null);

  assert.equal(item.listing_id, undefined);
  assert.equal(item.variant_id, undefined);
  assert.equal(item.marketplace_sku, undefined);
});

test('H38-2 canonical Item19 produces variant identity before product identity', () => {
  const item = toCanonicalOrder(item19RawOrder()).items[0];

  const candidates = buildIdentityCandidates('shopify', item);

  assert.deepEqual(candidates.slice(0, 2), [
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

test('H38-3 REAL matcher exact variant identity → Item19 sku/product matched_link high', async () => {
  legacyCalls = 0;

  const item = toCanonicalOrder(item19RawOrder()).items[0];

  const result = await matchCanonicalItem({
    channel: 'shopify',
    item,
  });

  assert.deepEqual(result, {
    skuMasterId: 9482,
    productId: 24169,
    matchStatus: 'matched_link',
    matchConfidence: 'high',
    matchReason: 'identity_exact:shopify_variant_id',
  });

  assert.equal(
    legacyCalls,
    0,
    'exact marketplace_identity hit must short-circuit legacy matcher'
  );
});

test('H38-4 REAL bulk matcher preserves Item19 exact identity result', async () => {
  legacyCalls = 0;

  const canonical = toCanonicalOrder(item19RawOrder());

  const result = await matchCanonicalItems({
    channel: 'shopify',
    items: canonical.items,
  });

  assert.equal(result.length, 1);

  assert.equal(result[0].match.skuMasterId, 9482);
  assert.equal(result[0].match.productId, 24169);
  assert.equal(result[0].match.matchStatus, 'matched_link');
  assert.equal(result[0].match.matchConfidence, 'high');
  assert.equal(
    result[0].match.matchReason,
    'identity_exact:shopify_variant_id'
  );

  assert.equal(legacyCalls, 0);
});
