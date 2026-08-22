'use strict';

/**
 * tests/scripts/seedSkuMasterFromEbayGuard.test.js — Phase 8P-22B.
 *
 * Runs the seed script in dry-run mode against a stubbed Supabase client
 * containing the Vol.9/Vol.11 shared-msku scenario + price + UUID + legit rows.
 *
 * Asserts the 22B validator rejects malformed candidates and returns per-bucket
 * counters — without any DB writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const clientResolvedPath = require.resolve('../../src/db/supabaseClient.js');
const seedScriptPath = require.resolve('../../scripts/seed-sku-master-from-ebay.js');

function stubClient(fixture) {
  //   Chain returns rows for select-only. No inserts should happen in dry-run.
  const chainable = (rows) => {
    const state = { rows };
    const o = {
      select() { return o; },
      eq() { return o; },
      neq() { return o; },
      in(_col, _slice) { return o; },
      limit() { return o; },
      range(from, to) {
        //   emulate pagination: return the slice, then empty
        if (state.paged) return Promise.resolve({ data: [], error: null });
        state.paged = true;
        return Promise.resolve({ data: rows, error: null });
      },
      insert() { return Promise.reject(new Error('DB writes forbidden in test')); },
    };
    return o;
  };
  return {
    from(table) {
      if (table === 'ebay_products') return chainable(fixture.ebay_products);
      if (table === 'sku_master') return chainable(fixture.sku_master_existing);
      if (table === 'sku_listing_link') return chainable([]);
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function loadSeedWithStub(fixture) {
  //   Clear cache · install stub · require fresh
  delete require.cache[clientResolvedPath];
  delete require.cache[seedScriptPath];
  require.cache[clientResolvedPath] = {
    id: clientResolvedPath, filename: clientResolvedPath, loaded: true,
    exports: { getClient: () => stubClient(fixture) }, children: [], paths: [],
  };
  //   Force dry-run (no --apply flag). Preserve original argv on cleanup.
  return require(seedScriptPath);
}

test('seed dry-run · rejects price-shaped SKUs and reports counter', async () => {
  const fixture = {
    ebay_products: [
      { sku: '19.90', title: 'Vol.9 Shadow Milk', item_id: '205948758686', status: 'active' },
      { sku: '19.90', title: 'Vol.11 Dark Witch (dup sku, different listing)', item_id: '206406729898', status: 'active' },
      { sku: '47.94', title: 'Starbucks Miffy', item_id: '206160357944', status: 'active' },
      { sku: 'POKEMON-SV8A-KR-BOX', title: 'Legit Pokemon Booster Box', item_id: '999888777666', status: 'active' },
      { sku: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'UUID fallback', item_id: '888777666555', status: 'active' },
    ],
    sku_master_existing: [], //   nothing pre-existing
  };
  const { main } = loadSeedWithStub(fixture);
  //   argv must not include --apply
  const originalArgv = process.argv.slice();
  process.argv = ['node', 'seed'];
  try {
    const r = await main();
    assert.ok(r, 'main() should return summary in dry-run');
    //   Vol.9/Vol.11 share sku '19.90' → non_unique OR price_shaped (price wins first in validator order)
    //   47.94 → price_shaped
    //   UUID → uuid_artifact (seed sets canonicalUuidArtifact:true)
    //   POKEMON-SV8A-KR-BOX → safe
    assert.equal(r.wouldCreate, 1, 'only 1 legit SKU should pass');
    assert.equal(r.counters.skipped_price_shaped, 2, 'both 19.90 (dedup) and 47.94 rejected');
    assert.equal(r.counters.skipped_uuid_artifact, 1);
    assert.ok(r.quarantineCount >= 3, 'quarantine list captured all rejects');
  } finally {
    process.argv = originalArgv;
  }
});

test('seed dry-run · legitimate SKU with single listing accepted (positive regression)', async () => {
  const fixture = {
    ebay_products: [
      { sku: 'POKEMON-SV8A-KR-BOX', title: 'ok', item_id: '111', status: 'active' },
      { sku: 'ROBOCARPOLI-BUNDLE-A', title: 'ok2', item_id: '222', status: 'active' },
    ],
    sku_master_existing: [],
  };
  const { main } = loadSeedWithStub(fixture);
  const originalArgv = process.argv.slice();
  process.argv = ['node', 'seed'];
  try {
    const r = await main();
    assert.equal(r.wouldCreate, 2);
    assert.equal(r.counters.skipped_price_shaped, 0);
    assert.equal(r.counters.skipped_uuid_artifact, 0);
    assert.equal(r.counters.skipped_non_unique, 0);
    assert.equal(r.quarantineCount, 0);
  } finally {
    process.argv = originalArgv;
  }
});
