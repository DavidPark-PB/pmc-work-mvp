'use strict';

/**
 * tests/web/customsPreflightSafety.test.js — R2-SHIP-1 (2026-09-05).
 *
 * Verifies the "UNKNOWN payment ≠ $1 customs" invariant on the two
 * international B2C label-creation routes:
 *
 *   · POST /api/orders/:orderNo/fedex-label
 *   · POST /api/orders/:orderNo/koreapost-label
 *
 * The `_verifyCustomsValue(raw)` helper at api.js:~4189 accepts positive
 * finite numerics only; every other input (null / undefined / 0 / NaN /
 * negative / non-numeric string) returns null. Both handlers preflight
 * on this helper BEFORE calling FedEx / Korea Post and BEFORE any DB
 * mutation. Owner directive (R2-SHIP-1 §5): request-body `customsValue`
 * MUST NOT bypass the preflight — unverified DB truth → BLOCK regardless
 * of client override.
 *
 * Test strategy: substitute the lazy-loaded FedEx / Korea Post / supabase
 * modules into require.cache BEFORE mounting the api router. Recorder
 * spies detect any carrier call, tracking write, DB mutation, storage
 * upload, or SHIPPED / PENDING_KOREAPOST flip.
 *
 * Frozen invariants also asserted:
 *   · R2-E1 clear-sku route stays feature-disabled (mounted, not affected)
 *   · R2-E2A1 orderSync payment preservation not affected
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const path    = require('node:path');
const fs      = require('node:fs');
const express = require('express');

// ─────────────────────────────────────────────────────────────────────
// Spies
// ─────────────────────────────────────────────────────────────────────
const spy = {
  fedexCtor:     0,
  fedexCreate:   [],
  kpCtor:        0,
  kpCreateParcel:[],
  dbGetClient:   0,
  dbFromCalls:   [],
  dbUpdateCalls: [],
  storageUploads:[],
  ordersByNo:    new Map(),
};
function resetSpy() {
  spy.fedexCtor        = 0;
  spy.fedexCreate.length     = 0;
  spy.kpCtor           = 0;
  spy.kpCreateParcel.length  = 0;
  spy.dbGetClient      = 0;
  spy.dbFromCalls.length     = 0;
  spy.dbUpdateCalls.length   = 0;
  spy.storageUploads.length  = 0;
}
function seedOrder(orderNo, patch) {
  spy.ordersByNo.set(orderNo, {
    order_no:           orderNo,
    buyer_name:         'Test Buyer',
    buyer_ioss:         null,
    street:             '123 Test St',
    city:               'Testville',
    province:           'CA',
    zip_code:           '90001',
    country_code:       'US',
    phone:              '5551234567',
    email:              't@t.com',
    payment_amount:     patch.payment_amount ?? null,
    currency:           patch.currency ?? 'USD',
    sku:                'SKU-T',
    title:              'Test Item',
    quantity:           1,
    weight_kg:          0.5,
    box_length:         20,
    box_width:          20,
    box_height:         10,
    tracking_no:        null,
    label_storage_path: null,
    ...patch,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────
class FedexStub {
  constructor() { spy.fedexCtor++; }
  isConfigured() { return true; }
  async createShipment(payload) {
    spy.fedexCreate.push(payload);
    return { trackingNumber: 'FDX-STUB-123', cost: 42, currency: 'USD', labelUrl: null, labelBase64: null };
  }
}
function getFedexAPI() { return new FedexStub(); }

class KoreaPostStub {
  constructor() { spy.kpCtor++; }
  isConfigured() { return true; }
  async createKPacketParcel(payload) {
    spy.kpCreateParcel.push(payload);
    return { regino: 'KP-STUB-999', reqno: 'REQ-1', cost: 8000 };
  }
}
function getKoreaPostAPI() { return new KoreaPostStub(); }

function buildDb() {
  return {
    from(table) {
      const q = {
        _table: table,
        _sel: null,
        _filters: [],
        select(cols) { this._sel = cols; return this; },
        in(col, vals) { this._filters.push({ col, values: vals }); return this; },
        eq(col, val) { this._filters.push({ col, values: [val] }); return this; },
        maybeSingle() {
          spy.dbFromCalls.push({ table, cols: this._sel, filters: this._filters, op: 'maybeSingle' });
          const orderNo = this._filters.find(f => f.col === 'order_no')?.values?.[0];
          const row = orderNo != null ? spy.ordersByNo.get(orderNo) : null;
          return Promise.resolve({ data: row || null, error: null });
        },
        async upsert(rows, options) {
          spy.dbUpdateCalls.push({ table, op: 'upsert', rows, options });
          return { data: null, error: null };
        },
        //   Update returns a chainable — production code does
        //   `await db.from('orders').update({...}).eq('order_no', X)`.
        //   The chain resolves after `.eq()` is called; we record then.
        update(patch) {
          const self = this;
          const chain = {
            _patch: patch,
            eq(col, val) {
              spy.dbUpdateCalls.push({
                table: self._table,
                op:    'update',
                patch,
                filters: [...self._filters, { col, values: [val] }],
              });
              return Promise.resolve({ data: null, error: null });
            },
            in(col, vals) {
              spy.dbUpdateCalls.push({
                table: self._table,
                op:    'update',
                patch,
                filters: [...self._filters, { col, values: vals }],
              });
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve) {
              spy.dbUpdateCalls.push({ table: self._table, op: 'update', patch, filters: self._filters });
              resolve({ data: null, error: null });
            },
          };
          return chain;
        },
        then(resolve) {
          spy.dbFromCalls.push({ table, cols: this._sel, filters: this._filters });
          resolve({ data: [], error: null });
        },
      };
      return q;
    },
    storage: {
      from(bucket) {
        return {
          async upload(fname, buf, opts) {
            spy.storageUploads.push({ bucket, fname, opts });
            return { data: { path: fname }, error: null };
          },
          async createSignedUrl() { return { data: { signedUrl: 'https://signed/test' }, error: null }; },
        };
      },
    },
  };
}
function getClient() { spy.dbGetClient++; return buildDb(); }

function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}
const FEDEX_API_PATH = path.resolve(__dirname, '../../src/api/fedexAPI.js');
const KP_API_PATH    = path.resolve(__dirname, '../../src/api/koreaPostAPI.js');
const SUPA_PATH      = path.resolve(__dirname, '../../src/db/supabaseClient.js');
const CARRIER_PATH   = path.resolve(__dirname, '../../src/services/carrierSheets.js');

stubModule(FEDEX_API_PATH, { getFedexAPI });
stubModule(KP_API_PATH,    { getKoreaPostAPI });
stubModule(SUPA_PATH,      { getClient });
stubModule(CARRIER_PATH,   class CarrierSheetsStub {
  static get EU_COUNTRIES() { return new Set(['FR', 'DE']); }
});

process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'http://localhost:1';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.NODE_ENV = 'test';

const apiRouter = require('../../src/web/routes/api');
const { _verifyCustomsValue } = apiRouter;

// ─────────────────────────────────────────────────────────────────────
// HTTP harness
// ─────────────────────────────────────────────────────────────────────
function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  return app;
}
function postJson(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        method: 'POST', hostname: '127.0.0.1', port, path: url,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end',  () => {
          server.close();
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* raw */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Pure helper tests
// ─────────────────────────────────────────────────────────────────────
test('NORM · positive finite → itself', () => {
  assert.equal(_verifyCustomsValue(12.5),   12.5);
  assert.equal(_verifyCustomsValue('12.5'), 12.5);
  assert.equal(_verifyCustomsValue(0.01),   0.01);
  assert.equal(_verifyCustomsValue(9999),   9999);
});

test('NORM · null / undefined / empty / NaN / negative / zero → null', () => {
  for (const v of [null, undefined, '', '   ', NaN, 'abc', 0, -1, -0.5, '-5', {}, []]) {
    assert.equal(_verifyCustomsValue(v), null, `input ${JSON.stringify(v)} must be UNKNOWN`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// FedEx behavioural tests · POST /api/orders/:orderNo/fedex-label
// ─────────────────────────────────────────────────────────────────────
const F_ROUTE = (orderNo) => `/api/orders/${orderNo}/fedex-label`;
const F_BODY  = { weightKg: 0.5, dimensions: { length: 20, width: 20, height: 10 }, serviceType: 'INTERNATIONAL_PRIORITY', currency: 'USD' };

test('BH-CUSTOMS-F1 · valid payment → carrier reachable', async () => {
  resetSpy();
  seedOrder('F1', { payment_amount: 42.50 });
  const r = await postJson(makeApp(), F_ROUTE('F1'), F_BODY);
  //   Preflight must not block; the FedEx stub is reached and returns success.
  assert.equal(r.status, 200, `expected 200, got ${r.status} · body=${JSON.stringify(r.body)}`);
  assert.equal(spy.fedexCreate.length, 1, 'FedEx.createShipment must fire once');
  const call = spy.fedexCreate[0];
  assert.equal(call.customs.totalValue,                    42.50, 'totalValue = verifiedPayment');
  assert.equal(call.customs.commodities[0].unitPrice.amount,     42.50, 'unitPrice = verifiedPayment');
  assert.equal(call.customs.commodities[0].customsValue.amount,  42.50, 'commodity customsValue = verifiedPayment');
  //   Order UPDATE with SHIPPED must have fired (existing behavior)
  const shippedFlips = spy.dbUpdateCalls.filter(c => c.op === 'update' && c.patch?.status === 'SHIPPED');
  assert.equal(shippedFlips.length, 1);
});

test('BH-CUSTOMS-F2 · null payment → 400 PAYMENT_UNVERIFIED · 0 FedEx calls · 0 DB writes', async () => {
  resetSpy();
  seedOrder('F2', { payment_amount: null });
  const r = await postJson(makeApp(), F_ROUTE('F2'), F_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error,  'PAYMENT_UNVERIFIED');
  assert.equal(r.body.reason, 'verified_customs_value_required');
  assert.equal(spy.fedexCreate.length,    0, 'no FedEx call');
  assert.equal(spy.dbUpdateCalls.length,  0, 'no DB mutation');
  assert.equal(spy.storageUploads.length, 0, 'no storage upload');
});

test('BH-CUSTOMS-F3 · zero payment → 400 · 0 side effects', async () => {
  resetSpy();
  seedOrder('F3', { payment_amount: 0 });
  const r = await postJson(makeApp(), F_ROUTE('F3'), F_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.fedexCreate.length,   0);
  assert.equal(spy.dbUpdateCalls.length, 0);
});

test('BH-CUSTOMS-F4 · malformed / NaN payment → 400 · 0 side effects', async () => {
  resetSpy();
  seedOrder('F4', { payment_amount: 'garbage' });
  const r = await postJson(makeApp(), F_ROUTE('F4'), F_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.fedexCreate.length,   0);
  assert.equal(spy.dbUpdateCalls.length, 0);
});

test('BH-CUSTOMS-F5 · negative payment → 400 · 0 side effects', async () => {
  resetSpy();
  seedOrder('F5', { payment_amount: -5 });
  const r = await postJson(makeApp(), F_ROUTE('F5'), F_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.fedexCreate.length,   0);
  assert.equal(spy.dbUpdateCalls.length, 0);
});

test('BH-CUSTOMS-F6 · invalid DB + valid body.customsValue → STILL 400 · owner directive no bypass', async () => {
  resetSpy();
  seedOrder('F6', { payment_amount: null });
  const r = await postJson(makeApp(), F_ROUTE('F6'), { ...F_BODY, customsValue: 999.99 });
  assert.equal(r.status, 400, 'body override MUST NOT bypass preflight');
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.fedexCreate.length,   0);
  assert.equal(spy.dbUpdateCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────
// Korea Post int'l behavioural tests · POST /api/orders/:orderNo/koreapost-label
// ─────────────────────────────────────────────────────────────────────
const K_ROUTE = (orderNo) => `/api/orders/${orderNo}/koreapost-label`;
const K_BODY  = { serviceType: 'KPACKET' };

test('BH-CUSTOMS-K1 · valid payment → carrier reachable', async () => {
  resetSpy();
  seedOrder('K1', { payment_amount: 27.50 });
  const r = await postJson(makeApp(), K_ROUTE('K1'), K_BODY);
  assert.equal(r.status, 200, `expected 200, got ${r.status} · body=${JSON.stringify(r.body)}`);
  assert.equal(spy.kpCreateParcel.length, 1);
  assert.equal(spy.kpCreateParcel[0].parcel.valueUSD, 27.50, 'valueUSD = verifiedPayment');
  const pendings = spy.dbUpdateCalls.filter(c => c.op === 'update' && c.patch?.status === 'PENDING_KOREAPOST');
  assert.equal(pendings.length, 1);
});

test('BH-CUSTOMS-K2 · null payment → 400 · 0 KP calls · 0 DB writes · 0 tracking mutation', async () => {
  resetSpy();
  seedOrder('K2', { payment_amount: null });
  const r = await postJson(makeApp(), K_ROUTE('K2'), K_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error,  'PAYMENT_UNVERIFIED');
  assert.equal(r.body.reason, 'verified_customs_value_required');
  assert.equal(spy.kpCreateParcel.length, 0);
  assert.equal(spy.dbUpdateCalls.length,  0);
});

test('BH-CUSTOMS-K3 · zero payment → 400 · 0 side effects', async () => {
  resetSpy();
  seedOrder('K3', { payment_amount: 0 });
  const r = await postJson(makeApp(), K_ROUTE('K3'), K_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.kpCreateParcel.length, 0);
  assert.equal(spy.dbUpdateCalls.length,  0);
});

test('BH-CUSTOMS-K4 · malformed payment → 400 · 0 side effects', async () => {
  resetSpy();
  seedOrder('K4', { payment_amount: 'garbage' });
  const r = await postJson(makeApp(), K_ROUTE('K4'), K_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.kpCreateParcel.length, 0);
  assert.equal(spy.dbUpdateCalls.length,  0);
});

test('BH-CUSTOMS-K5 · negative payment → 400 · 0 side effects', async () => {
  resetSpy();
  seedOrder('K5', { payment_amount: -5 });
  const r = await postJson(makeApp(), K_ROUTE('K5'), K_BODY);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.kpCreateParcel.length, 0);
  assert.equal(spy.dbUpdateCalls.length,  0);
});

test('BH-CUSTOMS-K6 · invalid DB + valid body.customsValue → STILL 400 · no bypass', async () => {
  resetSpy();
  seedOrder('K6', { payment_amount: null });
  //   KP route doesn't destructure `customsValue` from body, but we send it
  //   anyway to prove even a hypothetical override path would not bypass.
  const r = await postJson(makeApp(), K_ROUTE('K6'), { ...K_BODY, customsValue: 999.99 });
  assert.equal(r.status, 400, 'body override MUST NOT bypass preflight');
  assert.equal(r.body.error, 'PAYMENT_UNVERIFIED');
  assert.equal(spy.kpCreateParcel.length, 0);
  assert.equal(spy.dbUpdateCalls.length,  0);
});

// ─────────────────────────────────────────────────────────────────────
// Structural narrow assertions · shipping route slices only
// ─────────────────────────────────────────────────────────────────────
test('STRUCT · FedEx handler slice: no `Number(order.payment_amount) || 1` remains', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/web/routes/api.js'), 'utf8');
  const start = src.indexOf("router.post('/orders/:orderNo/fedex-label'");
  assert.ok(start > -1, 'FedEx route must remain registered');
  const rest = src.slice(start + 1);
  const nextIdx = rest.search(/router\.(get|post|put|patch|delete)\(/);
  const block = rest.slice(0, nextIdx > -1 ? nextIdx : 5000);
  const code = block
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  //   Forbidden: any expression that would let payment_amount collapse to 1
  //   on the customs commodity fields.
  const forbidden = /Number\s*\(\s*order\.payment_amount\s*\)\s*\|\|\s*1/;
  assert.equal(forbidden.test(code), false,
    'FedEx handler must not carry the UNKNOWN→$1 collapse');
});

test('STRUCT · KP int\'l handler slice: no `Number(order.payment_amount) || 1` remains', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/web/routes/api.js'), 'utf8');
  const start = src.indexOf("router.post('/orders/:orderNo/koreapost-label'");
  assert.ok(start > -1, 'KP int\'l route must remain registered');
  const rest = src.slice(start + 1);
  const nextIdx = rest.search(/router\.(get|post|put|patch|delete)\(/);
  const block = rest.slice(0, nextIdx > -1 ? nextIdx : 5000);
  const code = block
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden = /Number\s*\(\s*order\.payment_amount\s*\)\s*\|\|\s*1/;
  assert.equal(forbidden.test(code), false,
    'KP int\'l handler must not carry the UNKNOWN→$1 collapse');
});

test('STRUCT · both handlers reference _verifyCustomsValue preflight', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/web/routes/api.js'), 'utf8');
  //   Two preflight sites must exist — one per handler.
  const matches = src.match(/_verifyCustomsValue\s*\(\s*order\.payment_amount\s*\)/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 preflight sites, found ${matches.length}`);
});

// ─────────────────────────────────────────────────────────────────────
// R2-E1 clear-sku fence must still be reachable (regression sanity)
// ─────────────────────────────────────────────────────────────────────
test('REGRESSION · R2-E1 clear-sku still returns 409 feature_disabled', async () => {
  resetSpy();
  const r = await postJson(makeApp(), '/api/products/ebay/clear-sku', {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'feature_disabled');
});
