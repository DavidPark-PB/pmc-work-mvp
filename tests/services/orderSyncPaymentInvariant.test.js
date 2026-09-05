'use strict';

/**
 * tests/services/orderSyncPaymentInvariant.test.js — R2-E2A1 (2026-09-05).
 *
 * Verifies the "UNKNOWN ≠ ZERO" invariant for orderSync payment_amount:
 *
 *   · NEW order + missing/invalid amount → NULL persisted (not 0)
 *   · EXISTING order + missing/invalid amount → last-known DB value preserved
 *   · EXISTING order + valid new amount → normal update
 *   · Catastrophic R2-D1 scenario (eBay throws + Shopify succeeds) →
 *     zero SHIPPED mutations AND zero payment_amount corruption
 *
 * Test strategy: require.cache substitution + Object.create(OrderSync.prototype)
 * — same test-isolation pattern used by R2-D1 and R2-D3 (no production hooks
 * added; substitutes supabaseClient / EbayAPI / ShopifyAPI / GoogleSheetsAPI /
 * b2bBuyerMatcher into require.cache BEFORE loading OrderSync).
 *
 * The tests execute the REAL syncOrders() and REAL row-building path, then
 * inspect the payloads passed to db.upsert() to assert the invariant.
 *
 * Regression-freeze checks:
 *   · sku: o.sku || o.itemId || '' preserved (SKU ItemID fallback intact)
 *   · R2-D1 UNKNOWN ≠ SHIPPED preserved (no SHIPPED mutations under eBay
 *     failure with Shopify success)
 *   · R2-D3 UNKNOWN ≠ DELETE preserved (no Sheet batchClear calls)
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

// ─────────────────────────────────────────────────────────────────────
// Test scaffold — require.cache substitution BEFORE loading OrderSync
// ─────────────────────────────────────────────────────────────────────

const ROOT       = path.resolve(__dirname, '../..');
const ORDER_SYNC = path.resolve(ROOT, 'src/services/orderSync.js');
const SUPABASE   = path.resolve(ROOT, 'src/db/supabaseClient.js');
const EBAY_API   = path.resolve(ROOT, 'src/api/ebayAPI.js');
const SHOPIFY    = path.resolve(ROOT, 'src/api/shopifyAPI.js');
const GSHEETS    = path.resolve(ROOT, 'src/api/googleSheetsAPI.js');
const B2B_MATCH  = path.resolve(ROOT, 'src/services/b2bBuyerMatcher.js');
const CARRIER    = path.resolve(ROOT, 'src/services/carrierSheets.js');

function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

// ─── Recorder / spies ────────────────────────────────────────────────
const recorder = {
  upsertCalls: [],       // { table, rows, options }
  updateCalls: [],       // { table, patch }
  selectCalls: [],       // { table, cols }
  batchClearCalls: [],   // Sheet cleared ranges
  batchWriteCalls: [],
  appendCalls: [],
  preserveMap: new Map(),// existing DB state, keyed by order_no
};

function resetRecorder() {
  recorder.upsertCalls.length     = 0;
  recorder.updateCalls.length     = 0;
  recorder.selectCalls.length     = 0;
  recorder.batchClearCalls.length = 0;
  recorder.batchWriteCalls.length = 0;
  recorder.appendCalls.length     = 0;
  recorder.preserveMap.clear();
}

// ─── Supabase client stub ────────────────────────────────────────────
function buildDb() {
  return {
    from(table) {
      const query = {
        _table: table,
        _sel: null,
        _filters: [], // list of { col, values } (each .in()/.eq() appends)
        select(cols) {
          recorder.selectCalls.push({ table, cols });
          this._sel = cols;
          return this;
        },
        in(col, list) {
          this._filters.push({ col, values: list });
          return this;
        },
        eq(col, val) {
          this._filters.push({ col, values: [val] });
          return this;
        },
        async upsert(rows, options) {
          recorder.upsertCalls.push({ table, rows, options });
          return { data: null, error: null };
        },
        async update(patch) {
          recorder.updateCalls.push({ table, patch });
          return { data: null, error: null };
        },
        //   `await db.from(...).select(...).in(...)` chain — thenable.
        //   Filters conjunctively across every .in()/.eq() call so the
        //   existingNew probe (order_no IN allIds AND status IN ['NEW'])
        //   returns only the rows that match both, matching production
        //   PostgREST semantics.
        then(resolve) {
          const cols = this._sel || '*';
          const rows = [];
          for (const [orderNo, row] of recorder.preserveMap) {
            let ok = true;
            for (const f of this._filters) {
              const rowVal = row[f.col];
              if (!f.values.includes(rowVal)) { ok = false; break; }
            }
            if (!ok) continue;
            if (typeof cols === 'string' && cols !== '*') {
              const wanted = cols.split(',').map(s => s.trim());
              const projected = {};
              for (const c of wanted) projected[c] = row[c];
              rows.push(projected);
            } else {
              rows.push({ ...row });
            }
          }
          resolve({ data: rows, error: null });
        },
      };
      return query;
    },
  };
}

// ─── eBay / Shopify / Sheets / matcher stubs ─────────────────────────
class EbayStub {
  constructor() { this._failNext = false; }
  async getAwaitingShipmentOrders() {
    if (this._failNext) {
      this._failNext = false;
      throw new Error('eBay-simulated-failure');
    }
    return this._nextOrders || [];
  }
}

class ShopifyStub {
  constructor() {}
  async getOrders() {
    return this._nextOrders || [];
  }
}

class GSheetStub {
  constructor() {}
  async ensureSheetExists()   { return true; }
  async readData()            { return []; }
  async writeData()           { return true; }
  async appendData(_id, _range, rows) {
    recorder.appendCalls.push({ range: _range, rows });
    return true;
  }
  async batchWriteData(_id, updates) {
    recorder.batchWriteCalls.push({ updates });
    return true;
  }
  async batchClearData(_id, ranges) {
    recorder.batchClearCalls.push({ ranges });
    return true;
  }
  async getSheetMetadata()    { return { sheets: [{ properties: { title: '주문 배송' } }] }; }
}

// Install stubs BEFORE loading orderSync.
stubModule(SUPABASE, { getClient: () => buildDb() });
stubModule(EBAY_API, EbayStub);
stubModule(SHOPIFY,  ShopifyStub);
stubModule(GSHEETS,  GSheetStub);
stubModule(B2B_MATCH, { matchRecent: async () => ({ matched: 0 }) });
stubModule(CARRIER, class CarrierSheetsStub {
  static get EU_COUNTRIES() { return new Set([]); }
  async getOrCreateYunikTab() { return { title: 'test' }; }
  async addManyToCarrierSheet() { return true; }
});

// Benign env so downstream requires don't crash.
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'http://localhost:1';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || 'test-spreadsheet';
process.env.NODE_ENV = 'test';

const OrderSync = require('../../src/services/orderSync');
const { _normalizePaymentAmount } = OrderSync;

// ─── Helper: bypass constructor (avoids credentials.json load) ──────
function makeSyncInstance({ ebayOrders = [], shopifyOrders = [], ebayThrows = false } = {}) {
  const inst = Object.create(OrderSync.prototype);
  inst.ebay    = new EbayStub();
  inst.shopify = new ShopifyStub();
  inst.sheets  = new GSheetStub();
  inst.ebay._nextOrders    = ebayOrders;
  inst.ebay._failNext      = ebayThrows === true;
  inst.shopify._nextOrders = shopifyOrders;
  // Sub methods that hit the sheet — provide safe defaults
  inst.ensureSheet          = async () => true;
  inst.getExistingOrderRows = async () => new Map();
  inst.getExistingRowCount  = async () => 1;
  inst.cleanPhone           = (s) => s || '';
  return inst;
}

function seedExistingOrder(order_no, patch) {
  recorder.preserveMap.set(order_no, {
    order_no,
    carrier:        patch.carrier        ?? '',
    tracking_no:    patch.tracking_no    ?? '',
    status:         patch.status         ?? 'NEW',
    payment_amount: patch.payment_amount ?? null,
  });
}

function findPaymentUpsertPayload(order_no) {
  for (const call of recorder.upsertCalls) {
    if (call.table !== 'orders') continue;
    const row = (call.rows || []).find(r => r.order_no === order_no);
    if (row) return { row, options: call.options };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Pure normalizer tests
// ─────────────────────────────────────────────────────────────────────

test('NORM · positive numeric → itself', () => {
  assert.equal(_normalizePaymentAmount(12.5),    12.5);
  assert.equal(_normalizePaymentAmount('12.50'), 12.5);
  assert.equal(_normalizePaymentAmount(0.01),    0.01);
});

test('NORM · zero (KNOWN or UNKNOWN?) → null · documented decision', () => {
  //   Domain: eBay extractor coerces missing <Total> → '0' (ebayAPI.js:928),
  //   Shopify parseFloat(undefined) → NaN → 0. Literal 0 arriving here is
  //   semantically indistinguishable from absence. Historical evidence (110
  //   legacy zero rows, 100 % correlated with empty sku/carrier/tracking)
  //   confirms production 0 = malformed envelope, not $0 order.
  assert.equal(_normalizePaymentAmount(0),      null);
  assert.equal(_normalizePaymentAmount('0'),    null);
  assert.equal(_normalizePaymentAmount('0.00'), null);
});

test('NORM · missing / invalid → null', () => {
  assert.equal(_normalizePaymentAmount(null),      null);
  assert.equal(_normalizePaymentAmount(undefined), null);
  assert.equal(_normalizePaymentAmount(''),        null);
  assert.equal(_normalizePaymentAmount('   '),     null);
  assert.equal(_normalizePaymentAmount(NaN),       null);
  assert.equal(_normalizePaymentAmount('abc'),     null);
});

test('NORM · negative → null (implausible)', () => {
  assert.equal(_normalizePaymentAmount(-1),   null);
  assert.equal(_normalizePaymentAmount(-0.5), null);
  assert.equal(_normalizePaymentAmount('-3'), null);
});

// ─────────────────────────────────────────────────────────────────────
// Behavioural tests · execute real syncOrders()
// ─────────────────────────────────────────────────────────────────────

test('BH-PAY-A · new order + valid amount → correct numeric written', async () => {
  resetRecorder();
  const inst = makeSyncInstance({
    ebayOrders: [{
      ebayOrderId:   'EBAY-PAY-A',
      _orderStatus:  'Completed',
      _shippedTime:  '',
      sku:           'SKU-A',
      price:         42.50,
      title:         't',
      quantity:      1,
      shippingCountry: 'US',
    }],
  });
  await inst.syncOrders(7);
  const found = findPaymentUpsertPayload('EBAY-PAY-A');
  assert.ok(found, 'upsert must include the new order');
  assert.equal(found.row.payment_amount, 42.5);
  assert.equal(found.options?.ignoreDuplicates, true,
    'new orders take the insert path');
});

test('BH-PAY-B · new order + missing amount → NULL (not 0)', async () => {
  resetRecorder();
  const inst = makeSyncInstance({
    ebayOrders: [{
      ebayOrderId:   'EBAY-PAY-B',
      _orderStatus:  'Completed',
      _shippedTime:  '',
      sku:           'SKU-B',
      price:         0,          // extractor already coerced missing <Total> → 0
      title:         't',
      quantity:      1,
      shippingCountry: 'US',
    }],
  });
  await inst.syncOrders(7);
  const found = findPaymentUpsertPayload('EBAY-PAY-B');
  assert.ok(found, 'upsert must include the new order');
  assert.strictEqual(found.row.payment_amount, null,
    'UNKNOWN must be null · MUST NOT be 0');
  assert.notEqual(found.row.payment_amount, 0, 'explicit zero rejection');
});

test('BH-PAY-C · existing valid + incoming unknown → old value preserved', async () => {
  resetRecorder();
  seedExistingOrder('EBAY-PAY-C', {
    status:         'NEW',
    carrier:        '',
    tracking_no:    '',
    payment_amount: 99.99,
  });
  const inst = makeSyncInstance({
    ebayOrders: [{
      ebayOrderId:   'EBAY-PAY-C',
      _orderStatus:  'Completed',
      _shippedTime:  '',
      sku:           'SKU-C',
      price:         null,       // simulate upstream partial response
      title:         't',
      quantity:      1,
      shippingCountry: 'US',
    }],
  });
  // Seed existingNew probe so the order lands on the awaiting-update path
  recorder.preserveMap.set('EBAY-PAY-C', {
    order_no:       'EBAY-PAY-C',
    carrier:        '',
    tracking_no:    '',
    status:         'NEW',
    payment_amount: 99.99,
  });
  await inst.syncOrders(7);
  const found = findPaymentUpsertPayload('EBAY-PAY-C');
  assert.ok(found, 'awaiting-update upsert must include the order');
  assert.equal(found.row.payment_amount, 99.99,
    'previously-known good value preserved · UNKNOWN update MUST NOT overwrite');
});

test('BH-PAY-D · existing valid + malformed/NaN incoming → old value preserved', async () => {
  resetRecorder();
  recorder.preserveMap.set('EBAY-PAY-D', {
    order_no:       'EBAY-PAY-D',
    carrier:        '',
    tracking_no:    '',
    status:         'NEW',
    payment_amount: 55.55,
  });
  const inst = makeSyncInstance({
    ebayOrders: [{
      ebayOrderId:   'EBAY-PAY-D',
      _orderStatus:  'Completed',
      _shippedTime:  '',
      sku:           'SKU-D',
      price:         'garbage',   // parseFloat('garbage') === NaN
      title:         't',
      quantity:      1,
      shippingCountry: 'US',
    }],
  });
  await inst.syncOrders(7);
  const found = findPaymentUpsertPayload('EBAY-PAY-D');
  assert.ok(found);
  assert.equal(found.row.payment_amount, 55.55);
});

test('BH-PAY-E · existing valid + new valid → normal update', async () => {
  resetRecorder();
  recorder.preserveMap.set('EBAY-PAY-E', {
    order_no:       'EBAY-PAY-E',
    carrier:        '',
    tracking_no:    '',
    status:         'NEW',
    payment_amount: 20.00,
  });
  const inst = makeSyncInstance({
    ebayOrders: [{
      ebayOrderId:   'EBAY-PAY-E',
      _orderStatus:  'Completed',
      _shippedTime:  '',
      sku:           'SKU-E',
      price:         33.33,     // legitimate new observation
      title:         't',
      quantity:      1,
      shippingCountry: 'US',
    }],
  });
  await inst.syncOrders(7);
  const found = findPaymentUpsertPayload('EBAY-PAY-E');
  assert.ok(found);
  assert.equal(found.row.payment_amount, 33.33,
    'KNOWN new observation replaces existing value · normal update semantics');
});

test('BH-PAY-F · literal-zero domain semantics · treated as UNKNOWN · documented', async () => {
  resetRecorder();
  recorder.preserveMap.set('EBAY-PAY-F', {
    order_no:       'EBAY-PAY-F',
    carrier:        '',
    tracking_no:    '',
    status:         'NEW',
    payment_amount: 12.00,
  });
  //   Reason: eBay Trading `extractValue('Total') || '0'` at ebayAPI.js:928
  //   coerces missing <Total> XML to '0' upstream — at the orderSync layer
  //   we cannot distinguish "real 0" from "no value". Empirical evidence
  //   (110 legacy zero rows, 100 % correlated with empty sku/carrier/
  //   tracking) supports treating 0 as UNKNOWN.
  const inst = makeSyncInstance({
    ebayOrders: [{
      ebayOrderId:   'EBAY-PAY-F',
      _orderStatus:  'Completed',
      _shippedTime:  '',
      sku:           'SKU-F',
      price:         0,          // ambiguous · treated as UNKNOWN per policy
      title:         't',
      quantity:      1,
      shippingCountry: 'US',
    }],
  });
  await inst.syncOrders(7);
  const found = findPaymentUpsertPayload('EBAY-PAY-F');
  assert.ok(found);
  assert.equal(found.row.payment_amount, 12.00,
    'literal 0 is UNKNOWN per platform semantics · last-known preserved');
});

test('BH-PAY-G · CATASTROPHIC R2-D1 · eBay throws + Shopify succeeds · 0 SHIPPED · 0 payment corruption', async () => {
  resetRecorder();
  // Seed several existing NEW eBay orders that would previously have been
  // mass-flipped to SHIPPED (R2-D1 protection) AND whose payment_amount
  // could have been overwritten to 0 in later ticks (R2-E2A1 protection).
  for (const id of ['EBAY-PAY-G1', 'EBAY-PAY-G2', 'EBAY-PAY-G3']) {
    recorder.preserveMap.set(id, {
      order_no:       id,
      carrier:        '',
      tracking_no:    '',
      status:         'NEW',
      payment_amount: 77.77,
    });
  }
  const inst = makeSyncInstance({
    ebayThrows:    true,
    shopifyOrders: [{
      order_number: 'SHOP-1',
      created_at:   '2026-09-05T00:00:00Z',
      currency:     'USD',
      shipping_address: { country_code: 'US', name: 'x' },
      line_items:   [{ id: 'L1', sku: 'S1', price: '9.99', title: 't', quantity: 1 }],
    }],
  });
  await inst.syncOrders(7);

  //   Invariant 1 (R2-D1) — no SHIPPED mutation anywhere in the recorder
  const shippedMutations = [
    ...recorder.upsertCalls.flatMap(c => (c.rows || []).filter(r => r.status === 'SHIPPED')),
    ...recorder.updateCalls.filter(c => c.patch?.status === 'SHIPPED'),
  ];
  assert.equal(shippedMutations.length, 0,
    'R2-D1 · absent eBay orders MUST NOT be flipped to SHIPPED');

  //   Invariant 2 (R2-D3) — no Sheet batchClear
  assert.equal(recorder.batchClearCalls.length, 0,
    'R2-D3 · absent eBay orders MUST NOT trigger Sheet row clearing');

  //   Invariant 3 (R2-E2A1) — no upsert with payment_amount=0 anywhere
  const zeroPaymentUpserts = recorder.upsertCalls
    .flatMap(c => (c.rows || []))
    .filter(r => r.payment_amount === 0);
  assert.equal(zeroPaymentUpserts.length, 0,
    'R2-E2A1 · UNKNOWN MUST NOT be persisted as payment_amount=0');
});

// ─────────────────────────────────────────────────────────────────────
// Structural regression checks — narrow to payment_amount producer only
// ─────────────────────────────────────────────────────────────────────

test('STRUCT · producer path no longer contains `parseFloat(o.amount) || 0` for payment_amount', () => {
  const src = fs.readFileSync(ORDER_SYNC, 'utf8');
  //   Strip comments so we do not match the historical explanation.
  const code = src
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // The exact old pattern must not appear as an assignment target for
  // payment_amount. We look for the phrase followed on the SAME logical
  // slice as `payment_amount:` (allow whitespace/newlines).
  const forbidden = /payment_amount\s*:\s*parseFloat\s*\(\s*o\.amount\s*\)\s*\|\|\s*0/;
  assert.equal(forbidden.test(code), false,
    'producer must not carry the UNKNOWN→0 collapse for payment_amount');
});

test('STRUCT · SKU ItemID fallback preserved · line 87 semantic intact', () => {
  const src = fs.readFileSync(ORDER_SYNC, 'utf8');
  const fallback = /sku:\s*o\.sku\s*\|\|\s*o\.itemId\s*\|\|\s*''/;
  assert.equal(fallback.test(src), true,
    'sku: o.sku || o.itemId || \'\' MUST remain intact (owner directive)');
});

test('STRUCT · awaiting-update path selects payment_amount for preserve-map', () => {
  const src = fs.readFileSync(ORDER_SYNC, 'utf8');
  //   The preserve-select must include payment_amount alongside carrier/
  //   tracking_no/status, otherwise UNKNOWN incoming cannot fall back to
  //   the last-known DB value.
  const preserveSelect = /'order_no,\s*carrier,\s*tracking_no,\s*status,\s*payment_amount'/;
  assert.equal(preserveSelect.test(src), true,
    'preserve-select must include payment_amount for R2-E2A1');
});
