'use strict';

/**
 * tests/services/orderSyncSheetClearInvariant.test.js — Refactor R2-D3.
 *
 * The R2-D3 audit proved that src/services/orderSync.js ~line 182-204
 * carried the SAME absence-based inference R2-D1 had removed from the DB
 * status path — this time targeting the operational Google Sheet
 * `주문 배송`:
 *
 *   sheet row exists  AND  orderNo not present in current remote awaiting
 *   set  →  clear A:T row cells (batchClearData)
 *
 * That inference collapsed the same 12+ "not returned" conditions (eBay
 * API failure, timeout, rate limit, pagination gap, ModTime 30d date-
 * window exclusion, identifier mismatch, cancelled remote, partial
 * response, empty response) into a single "shipped" outcome on the
 * Sheet surface. Under the catastrophic scenario eBay-throws +
 * Shopify-success — the same one R2-D1 confirmed in production —
 * `currentAwaitingSet` held only Shopify IDs and every legitimate eBay
 * NEW/READY sheet row was silently blanked.
 *
 * R2-D3 fix: subtractive delete of the clearing block plus the
 * unreachable safety-net line that referenced its removed variables.
 * `existingMap` and duplicate prevention below are preserved.
 *
 * Invariant (owner directive 2026-09-05):
 *   UNKNOWN ≠ DELETE. An operational representation of an internal
 *   order may be removed only from POSITIVE fulfillment evidence.
 *   Absence of an external API response is never fulfillment evidence.
 *
 * TWO LAYERS OF TESTING (mirrors R2-D1 pattern):
 *
 *   1) STRUCTURAL — file-read + regex greps prove the dangerous
 *      identifiers and the sheet-clearing pattern are absent from live
 *      code. Because the fix is subtractive, this proves the invariant
 *      for every one of the 12+ missing-input conditions at once.
 *
 *   2) BEHAVIORAL — the actual OrderSync.syncOrders is invoked under
 *      isolated mocks with a fake `sheets` that records
 *      batchClearData calls. Owner rule 11 mandates behavioral
 *      coverage of the catastrophic scenario. Owner rules 3 + 10
 *      forbid modifying production for testability, so dependency
 *      isolation happens entirely test-side via require.cache
 *      substitution. src/services/orderSync.js changes are the
 *      approved subtractive safety cut, no test hooks.
 *
 * Owner rule 17 also mandates that R2-D3 must not reopen R2-D1. The
 * catastrophic behavioral test therefore asserts BOTH:
 *   · absence-derived Sheet clear calls = 0
 *   · SHIPPED DB status mutations = 0
 *
 * Test plan:
 *   Structural:
 *     · SC-M   absence-based batchClearData path removed
 *     · SC-M2  currentAwaitingSet / shippedRowsToClear / sheetShippedRemoved absent
 *     · SC-BC  batchClearData not called from live code (whole-file assertion
 *              scoped to orderSync.js since other files may legitimately
 *              use it · owner rule 16)
 *   Behavioral:
 *     · BH-SC-A catastrophic · eBay throws + Shopify success +
 *               existing eBay sheet rows · absence-derived clear = 0
 *               AND SHIPPED mutations = 0 (R2-D1 no-reopen check)
 *     · BH-SC-B empty eBay [] + Shopify success · absence clear = 0
 *     · BH-SC-C partial eBay response · missing sheet row NOT cleared
 *     · BH-SC-D normal sync · Sheet append still fires · clear = 0
 *     · BH-SC-E duplicate prevention · order already in sheet is
 *               skipped from newOrders · not re-appended
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const ORDER_SYNC_PATH = path.resolve(__dirname, '../../src/services/orderSync.js');

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL TESTS
// ═══════════════════════════════════════════════════════════════════════════

function readLiveCode() {
  const src = fs.readFileSync(ORDER_SYNC_PATH, 'utf8');
  return src
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

test('SC-M · absence-based batchClearData pattern removed from orderSync.js', () => {
  const code = readLiveCode();
  //   The exact removed pattern: `.batchClearData(SPREADSHEET_ID, shippedRowsToClear)`
  //   after a for-of over existingMap comparing against currentAwaitingSet.
  //   Below we assert the entry-point identifier `shippedRowsToClear`
  //   is gone; that alone proves the predicate cannot be assembled.
  //   Additionally assert the batchClearData call is gone from THIS file.
  assert.equal(/batchClearData\s*\(/.test(code), false,
    'batchClearData must not be called from orderSync.js after R2-D3');
});

test('SC-M2 · removed identifiers absent from live orderSync.js', () => {
  const code = readLiveCode();
  //   currentAwaitingSet was used only for the clearing predicate + the
  //   unreachable safety-net line the original author marked "도달 불가".
  //   Both references are gone.
  assert.equal(/\bcurrentAwaitingSet\b/.test(code), false,
    '`currentAwaitingSet` removed');
  assert.equal(/\bshippedRowsToClear\b/.test(code), false,
    '`shippedRowsToClear` removed');
  assert.equal(/\bsheetShippedRemoved\b/.test(code), false,
    '`sheetShippedRemoved` removed');
});

test('SC-BC · no absence-based sheet clearing path can be assembled', () => {
  const code = readLiveCode();
  //   Combination check: the predicate that would enable the pattern
  //   requires simultaneously `currentAwaitingSet.has(...)` (or an
  //   equivalent per-row set-difference check) AND a call to a Sheets
  //   API mutating existing rows. Both are absent. This assertion is
  //   defense-in-depth alongside SC-M / SC-M2.
  const forbiddenComposite = /!\s*[a-zA-Z_$][\w$]*Set\.has\([^)]+\)[\s\S]{0,200}batchClearData/;
  assert.equal(forbiddenComposite.test(code), false,
    'no compound "set-absence → sheet clear" pattern in orderSync.js');
});

test('SC-D1 · R2-D1 SHIPPED status invariant preserved · no reopen', () => {
  const code = readLiveCode();
  //   Guard against accidentally reintroducing R2-D1's dangerous status
  //   flip while implementing R2-D3.
  assert.equal(/status\s*:\s*['"]SHIPPED['"]/.test(code), false,
    'R2-D1 invariant preserved · no object literal { status: "SHIPPED" }');
  assert.equal(/\btoShip\b/.test(code), false, 'toShip identifier absent');
  assert.equal(/\bdbNewOrders\b/.test(code), false, 'dbNewOrders identifier absent');
});

test('SC-K · normal upsert / dedup / append surfaces preserved', () => {
  const code = readLiveCode();
  //   Positive assertions that the safety cut did not accidentally
  //   remove legitimate Sheet work.
  assert.ok(/\.upsert\s*\(\s*upsertRows/.test(code),
    'awaiting-row upsert path still present');
  assert.ok(/\.upsert\s*\(\s*newRows/.test(code),
    'new-row upsert path still present');
  assert.ok(/existingMap\s*=\s*await\s+this\.getExistingOrderRows/.test(code),
    'existingMap still populated for duplicate detection');
  assert.ok(/existingIds\.has\(o\.orderId\)/.test(code),
    'duplicate detection still consults existingIds');
  assert.ok(/appendData\s*\(/.test(code),
    'Sheet append path for newOrders still present');
});

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIORAL HARNESS · reuses R2-D1 A.1 pattern (require.cache substitution)
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
  require.cache[B2B_PATH] = {
    id: B2B_PATH, filename: B2B_PATH, loaded: true,
    exports: { matchRecent: async () => ({ matched: 0 }) },
  };
  class FakeCarrierSheets {
    async getOrCreateYunikTab() { return { title: 'test-tab' }; }
    async addManyToCarrierSheet() {}
    async addToCarrierSheet() {}
  }
  FakeCarrierSheets.EU_COUNTRIES = new Set();
  require.cache[CARRIER_PATH] = {
    id: CARRIER_PATH, filename: CARRIER_PATH, loaded: true,
    exports: FakeCarrierSheets,
  };
  delete require.cache[ORDER_SYNC_REQUIRE_PATH];
}

function makeFakeDb({ existingRows = [] } = {}) {
  const updateCalls = [];
  const upsertCalls = [];
  const insertCalls = [];
  const filterByClauses = (rows, clauses) =>
    rows.filter(row => {
      for (const c of clauses) {
        if (c.type === 'in' && !c.values.includes(row[c.col])) return false;
        if (c.type === 'eq' && row[c.col] !== c.val)          return false;
      }
      return true;
    });
  const from = (table) => ({
    select() {
      const clauses = [];
      const chain = {
        in(col, values) { clauses.push({ type: 'in', col, values }); return chain; },
        eq(col, val)    { clauses.push({ type: 'eq', col, val });     return chain; },
        then(resolve, reject) {
          const scoped = existingRows.filter(r => r._table === table);
          const filtered = filterByClauses(scoped, clauses).map(r => {
            const clone = { ...r }; delete clone._table; return clone;
          });
          Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
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
  return { db: { from }, updateCalls, upsertCalls, insertCalls };
}

/**
 * Fake Google Sheets that RECORDS every call. Critical for R2-D3
 * assertions: we must be able to prove batchClearData was called ZERO
 * times under absence conditions.
 */
function makeSheetsMock() {
  const batchClearCalls = [];
  const appendCalls     = [];
  const batchWriteCalls = [];
  const writeCalls      = [];
  const readCalls       = [];
  const sheets = {
    batchClearData: async (spreadsheetId, ranges) => {
      batchClearCalls.push({ spreadsheetId, ranges });
    },
    appendData: async (spreadsheetId, range, rows) => {
      appendCalls.push({ spreadsheetId, range, rows });
    },
    batchWriteData: async (spreadsheetId, updates) => {
      batchWriteCalls.push({ spreadsheetId, updates });
    },
    writeData: async (spreadsheetId, range, rows) => {
      writeCalls.push({ spreadsheetId, range, rows });
    },
    readData: async () => [],
    createSheet: async () => {},
  };
  return { sheets, batchClearCalls, appendCalls, batchWriteCalls, writeCalls, readCalls };
}

function makeSyncInstance({ ebayFn, shopifyFn, sheetsMock, existingSheetMap = new Map() }) {
  const OrderSync = require('../../src/services/orderSync');
  const instance = Object.create(OrderSync.prototype);
  instance.sheets  = sheetsMock;
  instance.ebay    = null;
  instance.shopify = null;
  instance.fetchEbayOrders    = ebayFn;
  instance.fetchShopifyOrders = shopifyFn;
  instance.ensureSheet         = async () => {};
  //   existingSheetMap = orderNo → 1-based row index · simulates what
  //   getExistingOrderRows would return if the Sheet already contains
  //   these orders.
  instance.getExistingOrderRows = async () => existingSheetMap;
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
// BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('BH-SC-A · CATASTROPHIC · eBay throws + Shopify success · Sheet clear = 0 · SHIPPED = 0 (R2-D1 no-reopen)', async () => {
  saveOriginals();
  //   Existing sheet contains 3 eBay orders. Under the removed logic
  //   ALL of them would be added to shippedRowsToClear and batchClearData
  //   would fire. After R2-D3 · zero calls.
  const existingSheetMap = new Map([
    ['EB-100', 5],
    ['EB-101', 6],
    ['EB-102', 7],
  ]);
  //   Existing DB eBay rows too · verify R2-D1 SHIPPED invariant.
  const existingRows = [
    { _table: 'orders', order_no: 'EB-100', status: 'NEW',   platform: 'eBay' },
    { _table: 'orders', order_no: 'EB-101', status: 'READY', platform: 'eBay' },
    { _table: 'orders', order_no: 'EB-102', status: 'NEW',   platform: 'eBay' },
  ];
  const { db, updateCalls } = makeFakeDb({ existingRows });
  installMocks(db);
  try {
    const sm = makeSheetsMock();
    const instance = makeSyncInstance({
      ebayFn:    async () => { throw new Error('eBay 429 rate limit'); },
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-1' }) ],
      sheetsMock: sm.sheets,
      existingSheetMap,
    });

    const result = await instance.syncOrders(7);

    //   R2-D3 invariant: absence-derived sheet clear MUST NOT fire.
    assert.equal(sm.batchClearCalls.length, 0,
      `CATASTROPHIC R2-D3 · sheet clearing MUST NOT fire · found ${sm.batchClearCalls.length} clear calls: ${JSON.stringify(sm.batchClearCalls)}`);

    //   R2-D1 no-reopen: SHIPPED status mutations MUST also remain 0.
    const shipped = shippedMutations(updateCalls);
    assert.equal(shipped.length, 0,
      `R2-D1 invariant regression · ${shipped.length} SHIPPED mutations issued: ${JSON.stringify(shipped)}`);

    //   eBay failure surfaces
    assert.ok(result.errors && result.errors.some(e => /eBay/.test(e)),
      'eBay failure surfaced in result.errors');

    //   Shopify normal processing continues · appendData fires for new order
    assert.ok(sm.appendCalls.length > 0,
      'Shopify successful order should still trigger sheet append');
  } finally {
    restoreOriginals();
  }
});

test('BH-SC-B · empty eBay [] + Shopify success · absence-derived clear = 0 · normal Shopify continues', async () => {
  saveOriginals();
  const existingSheetMap = new Map([['EB-200', 3], ['EB-201', 4]]);
  const { db } = makeFakeDb({ existingRows: [] });
  installMocks(db);
  try {
    const sm = makeSheetsMock();
    const instance = makeSyncInstance({
      ebayFn:    async () => [],
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-B' }) ],
      sheetsMock: sm.sheets,
      existingSheetMap,
    });
    await instance.syncOrders(7);
    assert.equal(sm.batchClearCalls.length, 0,
      'empty eBay response MUST NOT produce absence-derived Sheet clear');
    assert.ok(sm.appendCalls.length > 0,
      'Shopify processing continues');
  } finally {
    restoreOriginals();
  }
});

test('BH-SC-C · partial eBay response · missing sheet row NOT cleared', async () => {
  saveOriginals();
  //   Sheet has EB-A + EB-B. Remote returns EB-A only. B must not be cleared.
  const existingSheetMap = new Map([['EB-A', 10], ['EB-B', 11]]);
  const { db } = makeFakeDb({ existingRows: [] });
  installMocks(db);
  try {
    const sm = makeSheetsMock();
    const instance = makeSyncInstance({
      ebayFn:    async () => [ makeOrder({ orderId: 'EB-A', platform: 'eBay' }) ],
      shopifyFn: async () => [],
      sheetsMock: sm.sheets,
      existingSheetMap,
    });
    await instance.syncOrders(7);
    assert.equal(sm.batchClearCalls.length, 0,
      'partial response MUST NOT trigger clearing of absent local row EB-B');
  } finally {
    restoreOriginals();
  }
});

test('BH-SC-D · normal sync · Sheet append still fires for new order · clear = 0', async () => {
  saveOriginals();
  const existingSheetMap = new Map();   // empty sheet
  const { db } = makeFakeDb({ existingRows: [] });
  installMocks(db);
  try {
    const sm = makeSheetsMock();
    const instance = makeSyncInstance({
      ebayFn:    async () => [ makeOrder({ orderId: 'EB-N1', platform: 'eBay' }) ],
      shopifyFn: async () => [ makeOrder({ orderId: 'SF-N1' }) ],
      sheetsMock: sm.sheets,
      existingSheetMap,
    });
    const result = await instance.syncOrders(7);
    assert.equal(sm.batchClearCalls.length, 0);
    //   Sheet append for genuinely new orders should still fire
    assert.ok(sm.appendCalls.length > 0,
      'normal sync should still append new orders to sheet');
    assert.ok(result.synced >= 2);
  } finally {
    restoreOriginals();
  }
});

test('BH-SC-E · duplicate prevention · order already in sheet skipped from newOrders · not re-appended', async () => {
  saveOriginals();
  //   Sheet already has EB-DUP · remote returns SAME order · must be
  //   detected as duplicate · not re-appended. Verifies existingIds
  //   dedup path still works after R2-D3 removed the dead safety net.
  const existingSheetMap = new Map([['EB-DUP', 15]]);
  const { db } = makeFakeDb({ existingRows: [] });
  installMocks(db);
  try {
    const sm = makeSheetsMock();
    const instance = makeSyncInstance({
      ebayFn:    async () => [ makeOrder({ orderId: 'EB-DUP', platform: 'eBay' }) ],
      shopifyFn: async () => [],
      sheetsMock: sm.sheets,
      existingSheetMap,
    });
    const result = await instance.syncOrders(7);
    assert.equal(sm.batchClearCalls.length, 0);
    //   The order was already in sheet · duplicates count should be >= 1
    //   AND newOrders count should be 0 (nothing appended).
    assert.ok(result.duplicates >= 1,
      `existing order should be counted as duplicate · got duplicates=${result.duplicates}`);
    //   No append (both orders were duplicates or none exist)
    assert.equal(sm.appendCalls.length, 0,
      'no append fires when the only order is already in sheet');
  } finally {
    restoreOriginals();
  }
});
