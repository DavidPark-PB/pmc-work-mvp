'use strict';

/**
 * tests/oms/sharedMarketplaceSkuMatcherRegression.test.js — Phase 8P-22B.
 *
 * End-to-end regression covering Vol.9 / Vol.11 shared marketplaceSku='19.90'
 * failure class fixed in H60G. Also exercises the identity-conflict fail-closed
 * path to prove the matcher's safety semantics remain intact.
 *
 * All DB access is stubbed at the getClient level. No network / no live DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const clientResolvedPath = require.resolve('../../src/db/supabaseClient.js');
const legacyMatcherPath = require.resolve('../../src/services/skuMatcher.js');

//   ─── in-memory identity fixture ───
let miRows = [];        //   marketplace_identity rows
let smRows = [];        //   sku_master rows (id, internal_sku)
let productRows = [];   //   products rows (id, sku)
let legacyReturn = { matched_sku_id: null, match_status: 'failed', match_confidence: null, match_reason: 'no_match' };

function stubGetClient() {
  return {
    from(table) {
      if (table === 'marketplace_identity') return miChain();
      if (table === 'sku_master') return smChain();
      if (table === 'products') return productsChain();
      return neverChain(table);
    },
  };
}
function miChain() {
  const filters = { channel: null, identity_type: null, identity_value: null };
  const o = {
    select() { return o; },
    eq(col, v) { filters[col] = v; return o; },
    in(col, values) { if (col === 'identity_value') filters.identity_value = new Set(values.map(String)); return o; },
    then(resolve, reject) {
      const filtered = miRows.filter(r => {
        if (filters.channel != null && r.channel !== filters.channel) return false;
        if (filters.identity_type != null && r.identity_type !== filters.identity_type) return false;
        if (filters.identity_value instanceof Set && !filters.identity_value.has(String(r.identity_value))) return false;
        return true;
      });
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
  };
  return o;
}
function smChain() {
  const o = {
    _idFilter: null,
    select() { return o; },
    eq(col, v) { if (col === 'id') o._idFilter = v; return o; },
    maybeSingle() {
      const row = smRows.find(r => r.id === o._idFilter);
      return Promise.resolve({ data: row || null, error: null });
    },
  };
  return o;
}
function productsChain() {
  const o = {
    _skuFilter: null,
    select() { return o; },
    eq(col, v) { if (col === 'sku') o._skuFilter = v; return o; },
    maybeSingle() {
      const row = productRows.find(r => r.sku === o._skuFilter);
      return Promise.resolve({ data: row || null, error: null });
    },
  };
  return o;
}
function neverChain(t) { throw new Error(`unexpected table access: ${t}`); }

//   Install stubs BEFORE requiring omsSkuMatcher.
require.cache[clientResolvedPath] = {
  id: clientResolvedPath, filename: clientResolvedPath, loaded: true,
  exports: { getClient: stubGetClient }, children: [], paths: [],
};
require.cache[legacyMatcherPath] = {
  id: legacyMatcherPath, filename: legacyMatcherPath, loaded: true,
  exports: { matchOrderLine: async () => legacyReturn }, children: [], paths: [],
};

const { matchCanonicalItem } = require('../../src/services/oms/omsSkuMatcher');

function reset() {
  miRows = []; smRows = []; productRows = [];
  legacyReturn = { matched_sku_id: null, match_status: 'failed', match_confidence: null, match_reason: 'no_match' };
}

test('shared msku · Vol.9 resolves to sku 2339 via ebay_listing_id (identity_exact)', async () => {
  reset();
  //   post-H60G state: ONLY listing MIs · no ebay_sku='19.90' MI anywhere.
  miRows = [
    { id: 1, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: '205948758686', sku_master_id: 2339, source: 'ingest_seed', confidence: 'high' },
    { id: 2, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: '206406729898', sku_master_id: 9484, source: 'owner_confirmed', confidence: 'high' },
  ];
  smRows = [
    { id: 2339, internal_sku: '205948758686', status: 'active' },
    { id: 9484, internal_sku: '206406729898', status: 'active' },
  ];
  productRows = [
    { id: 17214, sku: '205948758686' },
    { id: 24210, sku: '206406729898' },
  ];
  const r = await matchCanonicalItem({ channel: 'ebay', item: { listingId: '205948758686', marketplaceSku: '19.90', variantId: null } });
  assert.equal(r.skuMasterId, 2339);
  assert.equal(r.matchStatus, 'matched_link');
  assert.match(String(r.matchReason), /identity_exact:ebay_listing_id/);
  assert.equal(r.productId, 17214);
});

test('shared msku · Vol.11 resolves to sku 9484 independently', async () => {
  reset();
  miRows = [
    { id: 1, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: '205948758686', sku_master_id: 2339, source: 'ingest_seed', confidence: 'high' },
    { id: 2, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: '206406729898', sku_master_id: 9484, source: 'owner_confirmed', confidence: 'high' },
  ];
  smRows = [
    { id: 2339, internal_sku: '205948758686', status: 'active' },
    { id: 9484, internal_sku: '206406729898', status: 'active' },
  ];
  productRows = [{ id: 17214, sku: '205948758686' }, { id: 24210, sku: '206406729898' }];
  const r = await matchCanonicalItem({ channel: 'ebay', item: { listingId: '206406729898', marketplaceSku: '19.90', variantId: null } });
  assert.equal(r.skuMasterId, 9484);
  assert.equal(r.matchStatus, 'matched_link');
  assert.match(String(r.matchReason), /identity_exact:ebay_listing_id/);
  assert.equal(r.productId, 24210);
});

test('identity conflict fail-closed · listing→A + ebay_sku→B returns failed/identity_conflict', async () => {
  reset();
  miRows = [
    { id: 1, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: '111111111111', sku_master_id: 111, source: 'owner_confirmed', confidence: 'high' },
    { id: 2, channel: 'ebay', identity_type: 'ebay_sku',        identity_value: 'LEGIT-SKU-A', sku_master_id: 222, source: 'owner_confirmed', confidence: 'high' },
  ];
  smRows = [
    { id: 111, internal_sku: '111111111111', status: 'active' },
    { id: 222, internal_sku: 'LEGIT-SKU-A', status: 'active' },
  ];
  const r = await matchCanonicalItem({ channel: 'ebay', item: { listingId: '111111111111', marketplaceSku: 'LEGIT-SKU-A', variantId: null } });
  assert.equal(r.matchStatus, 'failed');
  assert.match(String(r.matchReason), /^identity_conflict:sku_masters=/);
  assert.equal(r.skuMasterId, null);
});

test('positive · unique legitimate ebay_sku still matches via ebay_sku MI', async () => {
  reset();
  miRows = [
    { id: 1, channel: 'ebay', identity_type: 'ebay_sku', identity_value: 'POKEMON-SV8A-KR-BOX', sku_master_id: 333, source: 'owner_confirmed', confidence: 'high' },
  ];
  smRows = [{ id: 333, internal_sku: 'POKEMON-SV8A-KR-BOX', status: 'active' }];
  productRows = [{ id: 5000, sku: 'POKEMON-SV8A-KR-BOX' }];
  const r = await matchCanonicalItem({ channel: 'ebay', item: { listingId: '888', marketplaceSku: 'POKEMON-SV8A-KR-BOX', variantId: null } });
  assert.equal(r.skuMasterId, 333);
  assert.equal(r.matchStatus, 'matched_link');
  assert.equal(r.productId, 5000);
});

test('no identity hits · falls through to legacy matcher (safety preserved)', async () => {
  reset();
  miRows = [];
  legacyReturn = { matched_sku_id: 444, match_status: 'matched_marketplace_sku', match_confidence: 'medium', match_reason: 'marketplace_sku' };
  smRows = [{ id: 444, internal_sku: 'SOME-LEGACY-SKU', status: 'active' }];
  productRows = [{ id: 6000, sku: 'SOME-LEGACY-SKU' }];
  const r = await matchCanonicalItem({ channel: 'ebay', item: { listingId: '999999', marketplaceSku: 'SOME-LEGACY-SKU', variantId: null } });
  assert.equal(r.skuMasterId, 444);
  assert.equal(r.matchStatus, 'matched_marketplace_sku');
});
