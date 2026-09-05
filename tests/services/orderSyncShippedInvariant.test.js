'use strict';

/**
 * tests/services/orderSyncShippedInvariant.test.js — Refactor R2-D1.
 *
 * The R2-D audit proved that src/services/orderSync.js:135-150 collapsed
 * 12+ distinct "not returned" conditions (API failure, timeout, rate
 * limit, pagination gap, date-window (ModTime 30d) exclusion, ID
 * mismatch, cancelled remote, partial response, empty response …) into
 * a single SHIPPED mass flip. Production evidence in the audit:
 *   · 4624/4631 (99.85%) eBay SHIPPED rows carry no tracking
 *   · 2026-05-26 · 1000 orders flipped in one second
 *   · 2026-06-23 · 809 orders flipped in one second (same date as the
 *     cancelStatus-filter incident owner memory recorded)
 *
 * Invariant (owner directive 2026-09-05):
 *   An internal order may transition to SHIPPED only from POSITIVE
 *   shipment evidence. Absence of an external observation is never
 *   shipment evidence. UNKNOWN ≠ SHIPPED.
 *
 * TWO LAYERS OF TESTING (owner rule 12 · defense in depth):
 *
 *   1) STRUCTURAL — file-read + regex greps prove no dangerous branch
 *      exists in live code. Because the R2-D1 fix is subtractive, this
 *      proves the invariant for every one of the 12+ missing-input
 *      conditions simultaneously.
 *
 *   2) BEHAVIORAL — the actual OrderSync.syncOrders is invoked under
 *      isolated mocks (fake Supabase via require.cache + monkey-patched
 *      instance fetchers) for the specific catastrophic scenario that
 *      owner rule 5 mandates behavioral coverage of:
 *
 *        eBay fetch THROWS  +  Shopify fetch SUCCESS
 *          + local eBay NEW + READY rows exist
 *        =>  ZERO SHIPPED mutations issued to the mock DB
 *        +   Shopify order processing continues
 *        +   eBay failure surfaces in result.errors
 *
 *      Owner rule 2 + 3 forbid modifying production for testability, so
 *      dependency isolation happens entirely test-side via require.cache
 *      substitution. src/services/orderSync.js is byte-for-byte the same
 *      as commit 1cf9712.
 *
 * Test plan (owner rule 9):
 *   Structural (defense in depth):
 *     · M   mass .update({status:SHIPPED}).in(...) pattern absent
 *     · M2  toShip · currentAwaitingOrderNos · dbNewOrders identifiers absent
 *     · A-J no code path in orderSync mutates status to SHIPPED
 *     · N   shippedCount never derived from set difference
 *     · K   normal upsert paths still present
 *     · L   carrier/EU/sheet flow untouched
 *     · +   fetch-failure catch→[] path retained (downstream safe)
 *   Behavioral (owner mandate):
 *     · BH-A catastrophic · eBay throws + Shopify success · 0 SHIPPED mutations
 *     · BH-B empty eBay + Shopify success · 0 SHIPPED mutations · Shopify continues
 *     · BH-C partial eBay response · absent local order NOT SHIPPED
 *     · BH-D normal eBay success · normal upsert path fires · 0 SHIPPED mutations
 *     · BH-E READY-status preservation · READY row NOT flipped when absent
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const ORDER_SYNC_PATH = path.resolve(__dirname, '../../src/services/orderSync.js');

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL TESTS · defense in depth
// ═══════════════════════════════════════════════════════════════════════════

function readLiveCode() {
  const src = fs.readFileSync(ORDER_SYNC_PATH, 'utf8');
  return src
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

test('TEST M · mass .update({status:SHIPPED}).in(...) pattern absent', () => {
  const code = readLiveCode();
  const massFlipRe = /\.update\(\s*\{[^}]{0,300}status\s*:\s*['"]SHIPPED['"][^}]{0,300}\}\s*\)\s*\.in\s*\(/;
  assert.equal(massFlipRe.test(code), false,
    'orderSync.js MUST NOT contain a mass .update({status:SHIPPED}).in() pattern');
});

test('TEST M2 · dangerous identifiers from the removed block absent', () => {
  const code = readLiveCode();
  assert.equal(/\btoShip\b/.test(code), false, '`toShip` variable removed');
  assert.equal(/\bcurrentAwaitingOrderNos\b/.test(code), false, '`currentAwaitingOrderNos` removed');
  assert.equal(/\bdbNewOrders\b/.test(code), false, '`dbNewOrders` removed');
});

test('TEST A-J · no code path in orderSync mutates status to SHIPPED', () => {
  const code = readLiveCode();
  const forbiddenPatterns = [
    /status\s*:\s*['"]SHIPPED['"]/,
    /['"]status['"]\s*,\s*['"]SHIPPED['"]/,
  ];
  for (const rx of forbiddenPatterns) {
    assert.equal(rx.test(code), false,
      `orderSync.js MUST NOT synthesize SHIPPED status: ${rx}`);
  }
});

test('TEST N · shippedCount is never derived from set difference', () => {
  const code = readLiveCode();
  assert.equal(/shippedCount\s*=\s*toShip\.length/.test(code), false);
  assert.equal(/shippedCount\s*\+\+/.test(code), false);
  assert.equal(/shippedCount\s*=\s*0/.test(code), true,
    'shippedCount initialisation retained (return-shape compat)');
});

test('TEST K · normal upsert paths still present', () => {
  const code = readLiveCode();
  assert.ok(/\.upsert\s*\(\s*upsertRows/.test(code));
  assert.ok(/\.upsert\s*\(\s*newRows/.test(code));
  assert.ok(/from\(\s*'orders'\s*\)/.test(code));
});

test('TEST L · carrier / EU / sheet flow untouched', () => {
  const code = readLiveCode();
  assert.ok(/carrierSheets|CarrierSheets/.test(code));
  assert.ok(/EU_COUNTRIES|euOrders/i.test(code));
  assert.ok(/getExistingRowCount|getExistingOrderRows/.test(code));
});

test('fetch-failure catch path retained · downstream now safe', () => {
  const code = readLiveCode();
  assert.ok(/fetchEbayOrders[\s\S]{0,80}\.catch/.test(code));
  assert.ok(/if\s*\(\s*allOrders\.length\s*===\s*0\s*\)/.test(code));
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL HARNESS · require.cache substitution · test-side only
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_PATH = require.resolve('../../src/db/supabaseClient');
const B2B_PATH      = require.resolve('../../src/services/b2bBuyerMatcher');
const CARRIER_PATH  = require.resolve('../../src/services/carrierSheets');
const ORDER_SYNC_REQUIRE_PATH = require.resolve('../../src/services/orderSync');

let _orig = null;

function saveOriginals() {
  _orig = {
    supabase: require.cache[SUPABASE_PATH],
    b2b:      require.cache[B2B_PATH],
    carrier:  require.cache[CARRIER_PATH],
    orderSync: require.cache[ORDER_SYNC_REQUIRE_PATH],
  };
}

function restoreOriginals() {
  const restore = (p, orig) => {
    if (orig) require.cache[p] = orig;
    else      delete require.cache[p];
  };
  if (!_orig) return;
  restore(SUPABASE_PATH,             _orig.supabase);
  restore(B2B_PATH,                  _orig.b2b);
  restore(CARRIER_PATH,              _orig.carrier);
  restore(ORDER_SYNC_REQUIRE_PATH,   _orig.orderSync);
  _orig = null;
}

function installMocks(fakeDb) {
  // ── fake supabaseClient (getClient() returns the fake db) ────────────
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true,
    exports: {
      getClient: () => fakeDb,
      isSupabaseEnabled: () => true,
      getDbSource: () => 'test',
      isDualWrite: () => false,
      withReadCache: async (fn) => ({ value: await fn(), stats: {} }),
    },
  };
  // ── fake b2bBuyerMatcher (called unconditionally after new-order upsert) ─
  require.cache[B2B_PATH] = {
    id: B2B_PATH, filename: B2B_PATH, loaded: true,
    exports: { matchRecent: async () => ({ matched: 0 }) },
  };
  // ── fake carrierSheets (required lazily inside EU branch) ────────────
  class FakeCarrierSheets {
    async getOrCreateYunikTab() { return { title: 'test-tab' }; }
    async addManyToCarrierSheet() {}
    async addToCarrierSheet() {}
  }
  FakeCarrierSheets.EU_COUNTRIES = new Set();   // empty · no EU branch triggered
  require.cache[CARRIER_PATH] = {
    id: CARRIER_PATH, filename: CARRIER_PATH, loaded: true,
    exports: FakeCarrierSheets,
  };
  // Force orderSync to re-import so its module-level `const { getClient: getSupabase } = require('../db/supabaseClient')`
  // captures the mocked getClient.
  delete require.cache[ORDER_SYNC_REQUIRE_PATH];
}

/**
 * Minimal Supabase-shaped mock. Supports the exact surfaces orderSync uses:
 *   .from(t).select(cols).in(...).in(...).eq(...) → awaited to {data, error}
 *   .from(t).update(patch).in(col, values)        → awaited to {error}
 *   .from(t).update(patch).eq(col, val)           → awaited to {error}
 *   .from(t).upsert(rows, opts)                   → awaited to {error}
 *   .from(t).insert(rows)                         → awaited to {error}
 *
 * Records every write for assertion. Reads are matched from existingRows
 * (each row must carry _table = 'orders').
 */
function makeFakeDb({ existingRows = [] } = {}) {
  const updateCalls = [];
  const upsertCalls = [];
  const insertCalls = [];
  const selectCalls = [];

  const filterByClauses = (rows, clauses) =>
    rows.filter(row => {
      for (const c of clauses) {
        if (c.type === 'in' && !c.values.includes(row[c.col])) return false;
        if (c.type === 'eq' && row[c.col] !== c.val)          return false;
      }
      return true;
    });

  const from = (table) => ({
    select(cols) {
      const clauses = [];
      const chain = {
        in(col, values) { clauses.push({ type: 'in', col, values }); return chain; },
        eq(col, val)    { clauses.push({ type: 'eq', col, val });     return chain; },
        then(resolve, reject) {
          selectCalls.push({ table, cols, clauses: [...clauses] });
          const scoped = existingRows.filter(r => r._table === table);
          const filtered = filterByClauses(scoped, clauses).map(r => {
            const clone = { ...r }; delete clone._table; return clone;
          });
          Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
        // .maybeSingle / .single / .order / .limit unused by orderSync post-fix · skip
      };
      return chain;
    },
    update(patch) {
      return {
        in(col, values) {
          updateCalls.push({ table, patch, filter: { type: 'in', col, values } });
          return Promise.resolve({ error: null });
        },
        eq(col, val) {
          updateCalls.push({ table, patch, filter: { type: 'eq', col, val } });
          return Promise.resolve({ error: null });
        },
      };
    },
    upsert(rows, opts) {
      upsertCalls.push({ table, rows, opts });
      return Promise.resolve({ error: null });
    },
    insert(rows) {
      insertCalls.push({ table, rows });
      return Promise.resolve({ error: null });
    },
  });

  return { db: { from }, updateCalls, upsertCalls, insertCalls, selectCalls };
}

/**
 * Build an OrderSync instance without invoking its real constructor
 * (which would try to load Google credentials, eBay, and Shopify APIs).
 * Owner rule 2: no production modification for testability.
 */
function makeSyncInstance({ ebayFn, shopifyFn }) {
  //   Requires AFTER installMocks so orderSync module captures the mocked
  //   supabaseClient at module load.
  const OrderSync = require('../../src/services/orderSync');
  const instance = Object.create(OrderSync.prototype);

  //   Override every side-effect surface with no-ops so syncOrders reaches
  //   the previously-dangerous block boundary without side effects.
  instance.sheets = {
    batchClearData: async () => {},
    appendData:     async () => {},
    batchWriteData: async () => {},
    writeData:      async () => {},
  };
  instance.ebay    = null;   // fetchEbayOrders overridden below
  instance.shopify = null;   // fetchShopifyOrders overridden below

  //   Bypass the fetchers entirely · caller controls what allOrders holds.
  instance.fetchEbayOrders    = ebayFn;
  instance.fetchShopifyOrders = shopifyFn;

  //   Sheet helpers · owner rule 4 · no real Sheets I/O.
  instance.ensureSheet         = async () => {};
  instance.getExistingOrderRows = async () => new Map();
  instance.getExistingRowCount  = async () => 0;

  return instance;
}

function makeOrder(overrides = {}) {
  return {
    orderId:     'ORD-1',
    orderDate:   '2026-09-05',
    platform:    'Shopify',
    sku:         'SKU-1',
    itemId:      '',
    title:       'test',
    quantity:    1,
    amount:      10,
    currency:    'USD',
    buyerName:   'Buyer',
    country:     'US',
    countryCode: 'US',
    street: '', city: '', province: '', zipCode: '', phone: '', email: '',
    ...overrides,
  };
}

function shippedMutations(updateCalls) {
  return updateCalls.filter(c =>
    c.table === 'orders' && c.patch && c.patch.status === 'SHIPPED'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS · owner mandate (rule 5)
// ═══════════════════════════════════════════════════════════════════════════

test('BH-A · CATASTROPHIC · eBay throws + Shopify success · 0 SHIPPED mutations · local eBay NEW+READY preserved', async () => {
  saveOriginals();
  //   Existing eBay NEW + READY rows in fake DB · the previously-catastrophic
  //   case would have mass-flipped all of them to SHIPPED.
  const existingRows = [
    { _table: 'orders', order_no: 'EB-001', status: 'NEW',   platform: 'eBay', carrier: null,     tracking_no: null },
    { _table: 'orders', order_no: 'EB-002', status: 'READY', platform: 'eBay', carrier: 'FedEx',  tracking_no: null },
    { _table: 'orders', order_no: 'EB-003', status: 'NEW',   platform: 'eBay', carrier: null,     tracking_no: null },
  ];
  const { db, updateCalls, upsertCalls } = makeFakeDb({ existingRows });
  installMocks(db);
  try {
    const instance = makeSyncInstance({
      ebayFn:    async () => { throw new Error('eBay 429 rate limit'); },
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-100', platform: 'Shopify' }) ],
    });

    const result = await instance.syncOrders(7);

    //   The invariant: ZERO status='SHIPPED' mutations issued to the DB
    //   for the existing local eBay NEW/READY rows, despite eBay failing
    //   and Shopify succeeding with a non-empty order set.
    const shipped = shippedMutations(updateCalls);
    assert.equal(shipped.length, 0,
      `CATASTROPHIC invariant broken · ${shipped.length} SHIPPED mutations issued: ${JSON.stringify(shipped)}`);

    //   eBay failure MUST surface in result.errors (existing semantics).
    assert.ok(result.errors && result.errors.some(e => /eBay/.test(e)),
      'eBay failure must be reported in result.errors');

    //   Shopify successful order MUST still upsert to orders (new-order path).
    const orderUpserts = upsertCalls.filter(c => c.table === 'orders');
    assert.ok(orderUpserts.length > 0,
      'Shopify successful order should still upsert · 0 upserts = catastrophic fix over-cut');

    //   shippedCount must be truthful 0 (this function no longer creates SHIPPED transitions).
    assert.equal(result.shipped, 0, `result.shipped must be 0 · got ${result.shipped}`);
  } finally {
    restoreOriginals();
  }
});

test('BH-B · empty eBay [] + Shopify success · 0 SHIPPED mutations · Shopify continues', async () => {
  saveOriginals();
  const existingRows = [
    { _table: 'orders', order_no: 'EB-101', status: 'NEW',   platform: 'eBay' },
    { _table: 'orders', order_no: 'EB-102', status: 'READY', platform: 'eBay' },
  ];
  const { db, updateCalls, upsertCalls } = makeFakeDb({ existingRows });
  installMocks(db);
  try {
    const instance = makeSyncInstance({
      ebayFn:    async () => [],
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-200' }) ],
    });
    const result = await instance.syncOrders(7);

    assert.equal(shippedMutations(updateCalls).length, 0,
      'empty eBay response MUST NOT produce SHIPPED mutations');
    assert.ok(upsertCalls.filter(c => c.table === 'orders').length > 0,
      'Shopify order should still be upserted');
    assert.equal(result.shipped, 0);
  } finally {
    restoreOriginals();
  }
});

test('BH-C · partial eBay response · absent local eBay order NOT SHIPPED', async () => {
  saveOriginals();
  //   Local: A (NEW) + B (READY). eBay returns only A. B is absent.
  //   Under the removed logic, B would be flipped to SHIPPED. It must not be.
  const existingRows = [
    { _table: 'orders', order_no: 'EB-A', status: 'NEW',   platform: 'eBay' },
    { _table: 'orders', order_no: 'EB-B', status: 'READY', platform: 'eBay' },
  ];
  const { db, updateCalls } = makeFakeDb({ existingRows });
  installMocks(db);
  try {
    const instance = makeSyncInstance({
      ebayFn:    async () => [ makeOrder({ orderId: 'EB-A', platform: 'eBay' }) ],
      shopifyFn: async () => [],
    });
    await instance.syncOrders(7);

    const shipped = shippedMutations(updateCalls);
    assert.equal(shipped.length, 0,
      `absent local eBay-B MUST NOT be inferred SHIPPED · found ${shipped.length} mutations`);
  } finally {
    restoreOriginals();
  }
});

test('BH-D · normal eBay success · normal upsert path fires · 0 SHIPPED mutations', async () => {
  saveOriginals();
  //   No existing rows · pure new-order insertion.
  const { db, updateCalls, upsertCalls } = makeFakeDb({ existingRows: [] });
  installMocks(db);
  try {
    const instance = makeSyncInstance({
      ebayFn:    async () => [ makeOrder({ orderId: 'EB-N1', platform: 'eBay' }) ],
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-N1' }) ],
    });
    const result = await instance.syncOrders(7);

    assert.equal(shippedMutations(updateCalls).length, 0);
    //   Both should upsert (new-order path via ignoreDuplicates upsert)
    const orderUpserts = upsertCalls.filter(c => c.table === 'orders');
    assert.ok(orderUpserts.length >= 1,
      'normal sync should upsert at least one order');
    //   syncOrders returns should indicate synced count > 0
    assert.ok(result.synced >= 2, `synced count should be >= 2 · got ${result.synced}`);
  } finally {
    restoreOriginals();
  }
});

test('BH-E · READY status preservation · READY row NOT flipped when absent from response', async () => {
  saveOriginals();
  //   Ensures READY-specific handling · not only NEW · matches owner rule 10.
  const existingRows = [
    { _table: 'orders', order_no: 'EB-R1', status: 'READY', platform: 'eBay', carrier: 'FedEx' },
    { _table: 'orders', order_no: 'EB-R2', status: 'READY', platform: 'eBay', carrier: '우체국' },
  ];
  const { db, updateCalls } = makeFakeDb({ existingRows });
  installMocks(db);
  try {
    const instance = makeSyncInstance({
      ebayFn:    async () => [],   // eBay returns no awaiting orders
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-X' }) ],
    });
    await instance.syncOrders(7);

    const shipped = shippedMutations(updateCalls);
    //   Precise claim (owner rule 11): no SHIPPED mutation was issued for
    //   the READY rows. We do not claim the DB state was preserved (mock
    //   doesn't model that) · we claim the WRITE that would corrupt it
    //   was never issued. That is sufficient for this subtractive fix.
    assert.equal(shipped.length, 0,
      `READY rows MUST NOT receive SHIPPED mutation on absent response · found ${shipped.length}`);
  } finally {
    restoreOriginals();
  }
});
