'use strict';

/**
 * tests/oms/marketplaceIdentityEbaySeedGuard.test.js — Phase 8P-22B.
 *
 * upsertIdentity must reject seeded eBay ebay_sku values that are price-shaped,
 * uuid-fallback-shaped, or non-unique across listings — while:
 *   - allowing legitimate seller-authored ebay_sku values
 *   - allowing Owner-confirmed ebay_sku inserts (bypass)
 *   - never touching listing_id / non-eBay identity types
 *
 * Stubs the Supabase client — no network / no DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

//   ─── stub the shared supabase client BEFORE requiring the service ───
const clientResolvedPath = require.resolve('../../src/db/supabaseClient.js');

//   test-controlled state
let sllRowsForCurrentMsku = [];
let upsertLog = [];

function makeStubClient() {
  //   Chainable stub. Only the shapes used by the service under test.
  const chain = (rowsFn) => {
    const o = {
      _rows: [],
      select() { return o; },
      eq() { return o; },
      neq() { return o; },
      in() { return o; },
      limit() { return o; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      single() { return Promise.resolve({ data: o._rows[0] || null, error: null }); },
      range() { return Promise.resolve({ data: [], error: null }); },
      then(res) { return Promise.resolve({ data: rowsFn(), error: null }).then(res); },
    };
    return o;
  };
  return {
    from(table) {
      if (table === 'sku_listing_link') return chain(() => sllRowsForCurrentMsku);
      if (table === 'marketplace_identity') {
        return {
          upsert(row) {
            upsertLog.push(row);
            return {
              select() {
                return {
                  single() { return Promise.resolve({ data: { id: 99, ...row }, error: null }); },
                };
              },
            };
          },
          select() { return chain(() => []); },
        };
      }
      return chain(() => []);
    },
  };
}

require.cache[clientResolvedPath] = {
  id: clientResolvedPath, filename: clientResolvedPath, loaded: true,
  exports: { getClient: makeStubClient }, children: [], paths: [],
};

const { upsertIdentity } = require('../../src/services/oms/marketplaceIdentityService');

function reset() { sllRowsForCurrentMsku = []; upsertLog = []; }

test('ebay ebay_sku ingest_seed · price-shaped rejected', async () => {
  reset();
  await assert.rejects(
    () => upsertIdentity({ channel: 'ebay', identityType: 'ebay_sku', identityValue: '19.90', skuMasterId: 100, source: 'ingest_seed' }),
    /H22B|rejected|price/i,
  );
  assert.equal(upsertLog.length, 0, 'no DB upsert must occur');
});

test('ebay ebay_sku ingest_seed · non-unique (2 listings) rejected', async () => {
  reset();
  sllRowsForCurrentMsku = [{ listing_id: 'A' }, { listing_id: 'B' }];
  await assert.rejects(
    () => upsertIdentity({ channel: 'ebay', identityType: 'ebay_sku', identityValue: 'SOMESKU-123', skuMasterId: 101, source: 'ingest_seed' }),
    /non_unique|H22B/i,
  );
  assert.equal(upsertLog.length, 0);
});

test('ebay ebay_sku ingest_seed · legitimate unique seller SKU accepted', async () => {
  reset();
  sllRowsForCurrentMsku = [{ listing_id: 'ONLY-ONE' }];
  const r = await upsertIdentity({ channel: 'ebay', identityType: 'ebay_sku', identityValue: 'POKEMON-SV8A-KR-BOX', skuMasterId: 102, source: 'ingest_seed' });
  assert.ok(r);
  assert.equal(r.identity_value, 'POKEMON-SV8A-KR-BOX');
  assert.equal(upsertLog.length, 1);
});

test('ebay ebay_sku owner_confirmed · bypasses guard (still writes)', async () => {
  reset();
  const r = await upsertIdentity({ channel: 'ebay', identityType: 'ebay_sku', identityValue: '19.90', skuMasterId: 103, source: 'owner_confirmed' });
  assert.ok(r);
  assert.equal(r.identity_value, '19.90');
  assert.equal(upsertLog.length, 1);
});

test('ebay ebay_listing_id · guard does NOT apply (writes freely)', async () => {
  reset();
  const r = await upsertIdentity({ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: '206406729898', skuMasterId: 104, source: 'ingest_seed' });
  assert.ok(r);
  assert.equal(r.identity_value, '206406729898');
  assert.equal(upsertLog.length, 1);
});
