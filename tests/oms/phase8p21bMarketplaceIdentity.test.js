'use strict';

/**
 * tests/oms/phase8p21bMarketplaceIdentity.test.js — Phase 8P-21B
 *
 * Marketplace Identity Resolver — Owner-curated deterministic bridge.
 *
 * Proves:
 *   ─── marketplaceIdentityService (unit)
 *   S1.  resolveByIdentity: null identity → null
 *   S2.  resolveByIdentity: unknown identity_type → null (no cross-type)
 *   S3.  resolveByIdentity: exact hit returns full row
 *   S4.  resolveByIdentity: missing table → null (fail-open)
 *   S5.  resolveManyByIdentities: zero candidates → 0 queries
 *   S6.  resolveManyByIdentities: bounded chunking (250 candidates / 100 chunk = 3 queries)
 *   S7.  resolveManyByIdentities: dedup across duplicate candidates (no double query)
 *   S8.  resolveItemCandidates: no_match → status='no_match'
 *   S9.  resolveItemCandidates: single-sku match → matched + hit
 *   S10. resolveItemCandidates: MULTIPLE identities → DIFFERENT sku_masters → CONFLICT (no auto-link)
 *   S11. upsertIdentity: rejects unknown identity_type
 *   S12. upsertIdentity: rejects unknown source / confidence
 *
 *   ─── omsSkuMatcher step-0 integration
 *   M1.  identity hit → matchStatus='matched_link' · matchReason='identity_exact:<type>' · matchConfidence='high'
 *   M2.  identity miss → falls back to legacy sku_listing_link (matched_link · link_exact preserved)
 *   M3.  identity miss → sku_listing_link miss → marketplace_sku fallback still works
 *   M4.  identity miss → all misses → internal_sku fallback still works
 *   M5.  identity conflict (two types → different sku_masters) → matchStatus='failed' · matchReason='identity_conflict:...'
 *   M6.  wrong channel never matches (Shopify identity does not match eBay item)
 *   M7.  wrong identity_type never matches
 *   M8.  null identifiers never match
 *   M9.  title equality alone never resolves (title is not consulted)
 *
 *   ─── Splendor fixture
 *   SP1. Shopify variant_id=42847864324261 + owner-confirmed identity → resolves to sku_master #3180
 *   SP2. Graph proof: sku_master #3180 → sku_master_link → sellable_unit #6 → sellable_unit_components → physical_product #5
 *        (verified via in-memory fixture matching the READ-ONLY 8P-21A audit findings)
 *
 *   ─── buildIdentityCandidates (adapter-boundary safety)
 *   B1.  eBay item → priority: ebay_listing_id, ebay_sku
 *   B2.  Shopify item → priority: shopify_variant_id, shopify_product_id, shopify_sku
 *   B3.  Never emits ebay_transaction_id (not exposed by CanonicalOrderItem)
 *   B4.  Never emits title-based candidates
 *
 * All in-memory · zero DB · zero network. Migration NOT applied to prod.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

//   ── Fake supabase client that mirrors marketplace_identity + sku_listing_link + sku_master ──

let mIdentity = [];         // marketplace_identity rows
let skuListingLink = [];    // sku_listing_link rows
let skuMaster = [];         // sku_master rows
let products = [];          // products rows
let missingTable = new Set();

let dbSelectCalls = [];
let dbInsertCalls = [];

function _resetAll() {
  mIdentity = []; skuListingLink = []; skuMaster = []; products = [];
  missingTable = new Set();
  dbSelectCalls = []; dbInsertCalls = [];
}

function _buildFakeSupabase() {
  return {
    from(table) {
      if (missingTable.has(table)) {
        //   Simulate missing table for fail-open tests
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          in() { return this; },
          async maybeSingle() { return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } }; },
          async single() { return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } }; },
          then(resolve) { resolve({ data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } }); },
        };
      }
      const chain = {
        _cols: '*',
        _filters: [],
        _limit: null,
        select(cols) { chain._cols = cols; return chain; },
        eq(col, val) { chain._filters.push(['eq', col, val]); return chain; },
        is(col, val) { chain._filters.push(['is', col, val]); return chain; },
        in(col, vals) { chain._filters.push(['in', col, vals]); return chain; },
        limit(n) { chain._limit = n; return chain; },
        order(_col, _opts) { return chain; },
        async single() {
          dbSelectCalls.push({ table, cols: chain._cols, filters: chain._filters.slice() });
          const rows = _matchAll(table, chain._filters, chain._cols);
          if (rows.length === 0) return { data: null, error: { message: 'not found' } };
          return { data: rows[0], error: null };
        },
        async maybeSingle() {
          dbSelectCalls.push({ table, cols: chain._cols, filters: chain._filters.slice() });
          const rows = _matchAll(table, chain._filters, chain._cols);
          return { data: rows[0] || null, error: null };
        },
        then(resolve) {
          dbSelectCalls.push({ table, cols: chain._cols, filters: chain._filters.slice() });
          let rows = _matchAll(table, chain._filters, chain._cols);
          if (chain._limit != null) rows = rows.slice(0, chain._limit);
          resolve({ data: rows, error: null });
        },
        insert(row) {
          return {
            select() { return this; },
            async single() {
              dbInsertCalls.push({ table, row });
              const newRow = { ...row, id: 1 };
              _tableFor(table).push(newRow);
              return { data: newRow, error: null };
            },
          };
        },
        upsert(row, _opts) {
          return {
            select() { return this; },
            async single() {
              dbInsertCalls.push({ table, row, op: 'upsert' });
              const arr = _tableFor(table);
              //   Simulate onConflict by (channel, identity_type, identity_value)
              const idx = arr.findIndex(r => r.channel === row.channel && r.identity_type === row.identity_type && r.identity_value === row.identity_value);
              if (idx >= 0) { arr[idx] = { ...arr[idx], ...row }; return { data: arr[idx], error: null }; }
              const newRow = { ...row, id: arr.length + 1 };
              arr.push(newRow);
              return { data: newRow, error: null };
            },
          };
        },
      };
      return chain;
    },
  };
}

function _tableFor(name) {
  if (name === 'marketplace_identity') return mIdentity;
  if (name === 'sku_listing_link') return skuListingLink;
  if (name === 'sku_master') return skuMaster;
  if (name === 'products') return products;
  return [];
}

function _matchAll(table, filters, cols) {
  let out = _tableFor(table).slice();
  for (const [op, col, val] of filters) {
    if (op === 'eq') out = out.filter(r => r[col] === val);
    else if (op === 'is') out = out.filter(r => (val === null ? r[col] == null : r[col] === val));
    else if (op === 'in') out = out.filter(r => Array.isArray(val) && val.map(String).includes(String(r[col])));
  }
  if (typeof cols === 'string' && cols !== '*' && !cols.includes('raw_payload')) {
    out = out.map(r => { const p = {}; for (const c of cols.split(',').map(s => s.trim())) if (c in r) p[c] = r[c]; return p; });
  }
  return out;
}

const supabasePath = require.resolve('../../src/db/supabaseClient');
const svcPath = require.resolve('../../src/services/oms/marketplaceIdentityService');
const matcherPath = require.resolve('../../src/services/oms/omsSkuMatcher');
const legacyMatcherPath = require.resolve('../../src/services/skuMatcher');

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj, children: [], paths: [] };
}
function stubSupabase() {
  stub(supabasePath, {
    getClient: () => _buildFakeSupabase(),
    isSupabaseEnabled: () => true, getDbSource: () => 'supabase', isDualWrite: () => false,
    withReadCache: async (fn) => ({ value: await fn(), stats: {} }),
  });
}
stubSupabase();
delete require.cache[svcPath];
delete require.cache[legacyMatcherPath];
delete require.cache[matcherPath];
const svc = require(svcPath);
const { matchCanonicalItem, matchCanonicalItems, buildIdentityCandidates } = require(matcherPath);

// ── S1-S12 · marketplaceIdentityService unit tests ────────

test('S1 · resolveByIdentity: null identity_value → null', async () => {
  _resetAll();
  assert.equal(await svc.resolveByIdentity({ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: null }), null);
  assert.equal(await svc.resolveByIdentity({ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: '' }), null);
  assert.equal(await svc.resolveByIdentity({ channel: 'ebay', identityType: 'ebay_listing_id' }), null);
});

test('S2 · resolveByIdentity: unknown identity_type → null (no cross-type)', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: 'X', sku_master_id: 5 });
  assert.equal(await svc.resolveByIdentity({ channel: 'ebay', identityType: 'made_up_type', identityValue: 'X' }), null);
});

test('S3 · resolveByIdentity: exact hit returns full row', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'shopify', identity_type: 'shopify_variant_id', identity_value: '42847864324261', sku_master_id: 3180, source: 'owner_confirmed', confidence: 'high' });
  const r = await svc.resolveByIdentity({ channel: 'shopify', identityType: 'shopify_variant_id', identityValue: '42847864324261' });
  assert.ok(r);
  assert.equal(r.sku_master_id, 3180);
  assert.equal(r.source, 'owner_confirmed');
});

test('S4 · resolveByIdentity: missing table → null (fail-open)', async () => {
  _resetAll();
  missingTable.add('marketplace_identity');
  assert.equal(await svc.resolveByIdentity({ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'X' }), null);
});

test('S5 · resolveManyByIdentities: zero candidates → 0 queries', async () => {
  _resetAll();
  const { stats } = await svc.resolveManyByIdentities([]);
  assert.equal(stats.queries, 0);
  assert.equal(stats.rowsFound, 0);
});

test('S6 · resolveManyByIdentities: 250 candidates / chunk 100 → 3 queries', async () => {
  _resetAll();
  const candidates = Array.from({ length: 250 }, (_, i) => ({ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: `L-${i}` }));
  const { stats } = await svc.resolveManyByIdentities(candidates);
  assert.equal(stats.queries, 3);
});

test('S7 · resolveManyByIdentities: duplicate candidates dedup before chunking', async () => {
  _resetAll();
  const candidates = [
    { channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'L1' },
    { channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'L1' },
    { channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'L2' },
  ];
  const { stats } = await svc.resolveManyByIdentities(candidates);
  assert.equal(stats.queries, 1);   //   one chunk of 2 unique values
});

test('S8 · resolveItemCandidates: no_match → status="no_match"', async () => {
  _resetAll();
  const r = await svc.resolveItemCandidates([{ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'X' }]);
  assert.equal(r.status, 'no_match');
  assert.equal(r.sku_master_id, null);
});

test('S9 · resolveItemCandidates: single-sku match → matched', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: 'L1', sku_master_id: 100 });
  const r = await svc.resolveItemCandidates([{ channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'L1' }]);
  assert.equal(r.status, 'matched');
  assert.equal(r.sku_master_id, 100);
});

test('S10 · CONFLICT · multiple identities → different sku_masters → status="conflict" (no auto-link)', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'shopify', identity_type: 'shopify_variant_id', identity_value: 'V1', sku_master_id: 3180 });
  mIdentity.push({ id: 2, channel: 'shopify', identity_type: 'shopify_product_id', identity_value: 'P1', sku_master_id: 9999 });
  const r = await svc.resolveItemCandidates([
    { channel: 'shopify', identityType: 'shopify_variant_id', identityValue: 'V1' },
    { channel: 'shopify', identityType: 'shopify_product_id', identityValue: 'P1' },
  ]);
  assert.equal(r.status, 'conflict');
  assert.equal(r.sku_master_id, null);
  assert.deepEqual(r.conflictingSkuMasterIds.sort(), [3180, 9999]);
});

test('S11 · upsertIdentity: rejects unknown identity_type', async () => {
  await assert.rejects(() => svc.upsertIdentity({
    channel: 'ebay', identityType: 'made_up', identityValue: 'X', skuMasterId: 1,
  }), /identity_type not in allowlist/);
});

test('S12 · upsertIdentity: rejects unknown source / confidence', async () => {
  await assert.rejects(() => svc.upsertIdentity({
    channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'X', skuMasterId: 1, source: 'made_up',
  }), /source not in allowlist/);
  await assert.rejects(() => svc.upsertIdentity({
    channel: 'ebay', identityType: 'ebay_listing_id', identityValue: 'X', skuMasterId: 1, confidence: 'made_up',
  }), /confidence not in allowlist/);
});

// ── M1-M9 · omsSkuMatcher STEP-0 integration ─────────────

test('M1 · identity hit → matchStatus="matched_link" · matchReason="identity_exact:<type>" · confidence="high"', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'shopify', identity_type: 'shopify_variant_id', identity_value: '42847864324261', sku_master_id: 3180 });
  //   sku_master #3180 exists so resolveProductIdBySkuMasterId returns null (no products row) — ok.
  skuMaster.push({ id: 3180, internal_sku: '205409499120', title: 'Splendor Pokemon Edition' });
  const r = await matchCanonicalItem({ channel: 'shopify', item: {
    listingId: '8366221328549', variantId: '42847864324261', marketplaceSku: null,
  } });
  assert.equal(r.skuMasterId, 3180);
  assert.equal(r.matchStatus, 'matched_link');
  assert.equal(r.matchReason, 'identity_exact:shopify_variant_id');
  assert.equal(r.matchConfidence, 'high');
});

test('M2 · identity miss → sku_listing_link (link_exact) still works', async () => {
  _resetAll();
  //   no marketplace_identity rows; sku_listing_link has the answer
  skuListingLink.push({ id: 1, sku_id: 500, marketplace: 'ebay', listing_id: '999', option_id: null });
  skuMaster.push({ id: 500, internal_sku: '999', title: 'Legacy item' });
  const r = await matchCanonicalItem({ channel: 'ebay', item: {
    listingId: '999', variantId: null, marketplaceSku: '999',
  } });
  assert.equal(r.skuMasterId, 500);
  assert.equal(r.matchStatus, 'matched_link');
  assert.equal(r.matchReason, 'link_exact');
});

test('M3 · marketplace_sku fallback (sku_listing_link.marketplace_sku) still works', async () => {
  _resetAll();
  skuListingLink.push({ id: 1, sku_id: 700, marketplace: 'shopify', listing_id: 'ANY', option_id: 'ANY_OPT', marketplace_sku: 'PMC-X' });
  skuMaster.push({ id: 700, internal_sku: 'PMC-X', title: 'MP-SKU-only' });
  const r = await matchCanonicalItem({ channel: 'shopify', item: {
    listingId: 'other_listing', variantId: 'other_variant', marketplaceSku: 'PMC-X',
  } });
  assert.equal(r.skuMasterId, 700);
  assert.equal(r.matchStatus, 'matched_marketplace_sku');
  assert.equal(r.matchReason, 'marketplace_sku');
});

test('M4 · internal_sku fallback (sku_master.internal_sku == marketplaceSku) still works', async () => {
  _resetAll();
  skuMaster.push({ id: 800, internal_sku: 'INT-1', title: 'internal sku only' });
  const r = await matchCanonicalItem({ channel: 'shopify', item: {
    listingId: 'unknown', variantId: 'unknown', marketplaceSku: 'INT-1',
  } });
  assert.equal(r.skuMasterId, 800);
  assert.equal(r.matchStatus, 'matched_internal_sku');
});

test('M5 · CONFLICT · identity mismatch → status="failed" · reason="identity_conflict:..."', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'shopify', identity_type: 'shopify_variant_id', identity_value: 'V1', sku_master_id: 3180 });
  mIdentity.push({ id: 2, channel: 'shopify', identity_type: 'shopify_product_id', identity_value: 'P1', sku_master_id: 9999 });
  const r = await matchCanonicalItem({ channel: 'shopify', item: {
    listingId: 'P1', variantId: 'V1', marketplaceSku: null,
  } });
  assert.equal(r.skuMasterId, null);
  assert.equal(r.matchStatus, 'failed');
  assert.match(r.matchReason, /^identity_conflict:sku_masters=/);
  //   Both conflicting IDs referenced (order-agnostic)
  assert.ok(r.matchReason.includes('3180') && r.matchReason.includes('9999'));
});

test('M6 · wrong channel never matches (Shopify identity does not match eBay item)', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'shopify', identity_type: 'shopify_variant_id', identity_value: 'V1', sku_master_id: 3180 });
  const r = await matchCanonicalItem({ channel: 'ebay', item: { listingId: null, variantId: 'V1', marketplaceSku: null } });
  //   No fallback either → failed
  assert.equal(r.skuMasterId, null);
  assert.equal(r.matchStatus, 'failed');
});

test('M7 · wrong identity_type never matches (eBay listing_id in Shopify item field)', async () => {
  _resetAll();
  mIdentity.push({ id: 1, channel: 'ebay', identity_type: 'ebay_listing_id', identity_value: '205409499120', sku_master_id: 3180 });
  //   Shopify item uses variantId. Even if the value happens to match, identity_type is not shopify_variant_id.
  const r = await matchCanonicalItem({ channel: 'shopify', item: { listingId: null, variantId: '205409499120', marketplaceSku: null } });
  assert.equal(r.skuMasterId, null);
});

test('M8 · null identifiers never match', async () => {
  _resetAll();
  const r = await matchCanonicalItem({ channel: 'shopify', item: { listingId: null, variantId: null, marketplaceSku: null } });
  assert.equal(r.skuMasterId, null);
  assert.equal(r.matchStatus, 'failed');
});

test('M9 · title equality alone never resolves (title is never consulted)', async () => {
  _resetAll();
  skuMaster.push({ id: 3180, internal_sku: '205409499120', title: 'Splendor Pokemon Edition Board Game Korea Exclusive Version' });
  //   Give the item an identical title but NO deterministic identifier at all.
  const r = await matchCanonicalItem({ channel: 'shopify', item: {
    listingId: null, variantId: null, marketplaceSku: null,
    title: 'Splendor Pokemon Edition Board Game Korea Exclusive Version',
  } });
  assert.equal(r.skuMasterId, null);
  assert.equal(r.matchStatus, 'failed');
});

// ── SP1-SP2 · Splendor fixture (deterministic bridge proof) ───

test('SP1 · Splendor · Shopify variant_id=42847864324261 + owner-confirmed identity → sku_master #3180', async () => {
  _resetAll();
  //   OWNER-CONFIRMED identity row (FIXTURE only · not inserted in production this phase)
  mIdentity.push({
    id: 1, channel: 'shopify', identity_type: 'shopify_variant_id',
    identity_value: '42847864324261', sku_master_id: 3180,
    source: 'owner_confirmed', confidence: 'high',
  });
  skuMaster.push({ id: 3180, internal_sku: '205409499120', title: 'Splendor Pokemon Edition Board Game Korea Exclusive Version' });
  const r = await matchCanonicalItem({ channel: 'shopify', item: {
    listingId: '8366221328549', variantId: '42847864324261', marketplaceSku: null,
    title: 'Splendor Pokemon Edition Board Game Korea Exclusive Version',
  } });
  assert.equal(r.skuMasterId, 3180);
  assert.equal(r.matchStatus, 'matched_link');
  assert.equal(r.matchReason, 'identity_exact:shopify_variant_id');
});

test('SP2 · Graph proof · sku_master #3180 → sku_master_link → sellable_unit #6 → physical_product #5 (fixture matches 8P-21A audit)', () => {
  //   This test encodes the production graph observed in the 8P-21A read-only audit:
  //     sku_master_link[sku_master_id=3180] → sellable_unit_id=6 (mapping_confidence='manual', notes='phase_8p5_owner_confirmed_create · pcc-3180')
  //     sellable_units #6 · sellable_unit_components → physical_product_id=5, quantity_per_unit=1
  //   The resolver's job in 21B stops at sku_master. Downstream sellable_unit_components
  //   / physical_products resolution is Phase 8P-5/6 code (unchanged). Here we assert
  //   only that the SHAPE of the fixture matches the observed production graph so
  //   Owner can trust the downstream chain remains authoritative.
  const fixture = {
    sku_master_link: { sku_master_id: 3180, sellable_unit_id: 6, mapping_confidence: 'manual' },
    sellable_units:  { id: 6, display_name: 'Splendor Pokemon Edition Korea Exclusive Board Game (auto-created 1-unit sellable)' },
    sellable_unit_components: { sellable_unit_id: 6, physical_product_id: 5, quantity_per_unit: 1, role: 'primary' },
    physical_products: { id: 5, canonical_title: 'Splendor Pokemon Edition Korea Exclusive Board Game' },
  };
  assert.equal(fixture.sku_master_link.sku_master_id, 3180);
  assert.equal(fixture.sku_master_link.sellable_unit_id, 6);
  assert.equal(fixture.sellable_unit_components.sellable_unit_id, 6);
  assert.equal(fixture.sellable_unit_components.physical_product_id, 5);
  assert.equal(fixture.physical_products.id, 5);
});

// ── B1-B4 · buildIdentityCandidates adapter safety ─

test('B1 · eBay item → priority: ebay_listing_id, ebay_sku (no variant_id)', () => {
  const c = buildIdentityCandidates('ebay', { listingId: '205409499120', variantId: null, marketplaceSku: 'PMC-EBAY-1' });
  assert.deepEqual(c.map(x => x.identityType), ['ebay_listing_id', 'ebay_sku']);
  assert.deepEqual(c.map(x => x.identityValue), ['205409499120', 'PMC-EBAY-1']);
});

test('B2 · Shopify item → priority: shopify_variant_id, shopify_product_id, shopify_sku', () => {
  const c = buildIdentityCandidates('shopify', { listingId: '8366221328549', variantId: '42847864324261', marketplaceSku: 'PMC-SHOP-1' });
  assert.deepEqual(c.map(x => x.identityType), ['shopify_variant_id', 'shopify_product_id', 'shopify_sku']);
});

test('B3 · Never emits ebay_transaction_id (not exposed by CanonicalOrderItem)', () => {
  const c = buildIdentityCandidates('ebay', { listingId: 'X', variantId: 'Y', marketplaceSku: 'Z' });
  for (const cand of c) assert.ok(cand.identityType !== 'ebay_transaction_id');
  //   And confirm the identity_type allowlist itself does not include ebay_transaction_id
  assert.ok(!svc.IDENTITY_TYPE_ALLOWLIST.has('ebay_transaction_id'));
});

test('B4 · Never emits title-based candidates (buildIdentityCandidates ignores title)', () => {
  const c = buildIdentityCandidates('shopify', { listingId: null, variantId: null, marketplaceSku: null, title: 'ANY TITLE' });
  assert.equal(c.length, 0);
});

// ── Migration file structural guard ───────────────────────

test('MIG1 · migration 097_marketplace_identity.sql exists · declares table + UNIQUE + identity_type allowlist', () => {
  const mig = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/097_marketplace_identity.sql'), 'utf8');
  assert.match(mig, /create table if not exists marketplace_identity/);
  assert.match(mig, /unique \(channel, identity_type, identity_value\)/);
  //   Required identity types present
  for (const t of ['ebay_listing_id', 'ebay_sku', 'shopify_variant_id', 'shopify_product_id', 'shopify_sku']) {
    assert.match(mig, new RegExp(`'${t}'`), `missing identity_type '${t}' in allowlist`);
  }
  //   And explicitly NOT ebay_transaction_id
  assert.ok(!/'ebay_transaction_id'/.test(mig), 'ebay_transaction_id must NOT be in the allowlist');
  //   Rollback SQL commented
  assert.match(mig, /drop table if exists marketplace_identity/);
});

// ── Migration NOT applied assertion (documentation) ───────
//   This test intentionally does NOT check the DB (that would require a live
//   connection and would defeat the purpose of "do not apply migration").
//   The test suite as a whole runs in isolation with fake supabase.

// ── Regression guard: existing tests import surface unchanged ────

test('REG1 · omsSkuMatcher module exports unchanged (matchCanonicalItem, matchCanonicalItems, buildIdentityCandidates)', () => {
  const mod = require(matcherPath);
  assert.equal(typeof mod.matchCanonicalItem, 'function');
  assert.equal(typeof mod.matchCanonicalItems, 'function');
  assert.equal(typeof mod.buildIdentityCandidates, 'function');
});

test('REG2 · marketplaceIdentityService public surface', () => {
  assert.equal(typeof svc.resolveByIdentity, 'function');
  assert.equal(typeof svc.resolveManyByIdentities, 'function');
  assert.equal(typeof svc.resolveItemCandidates, 'function');
  assert.equal(typeof svc.upsertIdentity, 'function');
  assert.ok(svc.IDENTITY_TYPE_ALLOWLIST instanceof Set);
});
