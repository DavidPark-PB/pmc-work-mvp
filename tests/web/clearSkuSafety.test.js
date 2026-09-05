'use strict';

/**
 * tests/web/clearSkuSafety.test.js — R2-E1 (2026-09-05).
 *
 * Emergency safety fence for POST /api/products/ebay/clear-sku.
 *
 * Prior behaviour (removed): iterated non-PMC-prefixed active listings
 * (up to 5,000 rows), called ebay.clearCustomLabel per item, and on
 * "success" (including eBay Ack=Warning) unconditionally overwrote
 * ebay_products.sku with the numeric ItemID. No dry-run, no cap, no
 * confirmation, no idempotency. A single invocation could permanently
 * sever hundreds of sku_master joins.
 *
 * Invariant under test: the route is still registered, but performs
 * ZERO marketplace mutation, ZERO SKU writes, and ZERO DB mutation.
 * Every request — regardless of body — returns an explicit
 * `feature_disabled` semantic response.
 *
 * Test strategy: substitute the lazy-loaded EbayAPI class and the
 * supabaseClient module into require.cache BEFORE mounting the router,
 * so any regression that re-introduces the dangerous body would be
 * detected as a spy invocation. The fence handler itself performs no
 * I/O, so no spy calls are expected on the green path.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const path    = require('node:path');
const fs      = require('node:fs');
const express = require('express');

// ─────────────────────────────────────────────────────────────────────
// Spies — track any attempt to invoke marketplace or DB from the route
// ─────────────────────────────────────────────────────────────────────
const spy = {
  ebayCtorCalls:      0,
  ebayGetListings:    0,
  ebayClearCustom:    [],
  dbGetClient:        0,
  dbFromCalls:        [],
  dbUpdateCalls:      [],
};

function resetSpy() {
  spy.ebayCtorCalls   = 0;
  spy.ebayGetListings = 0;
  spy.ebayClearCustom.length = 0;
  spy.dbGetClient     = 0;
  spy.dbFromCalls.length     = 0;
  spy.dbUpdateCalls.length   = 0;
}

// Stub EbayAPI class — regression would call ctor via getEbayAPI()
class EbayAPIStub {
  constructor() { spy.ebayCtorCalls++; }
  async getActiveListings() {
    spy.ebayGetListings++;
    return { items: [], hasMore: false };
  }
  async clearCustomLabel(itemId) {
    spy.ebayClearCustom.push(itemId);
    return { success: true }; // if fence broke, would allow DB overwrite
  }
}

function installStubs() {
  const EBAY_PATH = path.resolve(__dirname, '../../src/api/ebayAPI.js');
  require.cache[EBAY_PATH] = {
    id: EBAY_PATH,
    filename: EBAY_PATH,
    loaded: true,
    exports: EbayAPIStub,
  };

  const DB_PATH = path.resolve(__dirname, '../../src/db/supabaseClient.js');
  const dbChain = {
    from(t)   { spy.dbFromCalls.push(t);   return dbChain; },
    update(p) { spy.dbUpdateCalls.push(p); return dbChain; },
    eq()      { return dbChain; },
    select()  { return dbChain; },
    delete()  { return dbChain; },
    insert()  { return dbChain; },
  };
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: {
      getClient: () => { spy.dbGetClient++; return dbChain; },
    },
  };
}

// Set benign env so any top-level require in api.js that inspects env
// (dotenv already loaded elsewhere) does not crash under test isolation.
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'http://localhost:1';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.NODE_ENV             = 'test';

installStubs();

// Now safe to require the real router — stubs are in place for any
// lazy consumer the (removed) mutation path used to reach.
const apiRouter = require('../../src/web/routes/api');

// ─────────────────────────────────────────────────────────────────────
// Minimal HTTP harness
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
      const payload  = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        method:   'POST',
        hostname: '127.0.0.1',
        port,
        path:     url,
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end',  () => {
          server.close();
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const ROUTE = '/api/products/ebay/clear-sku';

// ─────────────────────────────────────────────────────────────────────
// Behavioural tests
// ─────────────────────────────────────────────────────────────────────
test('TEST A · POST clear-sku returns feature_disabled 409', async () => {
  resetSpy();
  const r = await postJson(makeApp(), ROUTE, {});
  assert.equal(r.status, 409, `expected 409, got ${r.status}`);
  assert.equal(r.body.error,  'feature_disabled');
  assert.equal(r.body.reason, 'bulk_sku_mutation_disabled_for_safety');
});

test('TEST B · response success is not true', async () => {
  resetSpy();
  const r = await postJson(makeApp(), ROUTE, {});
  assert.notEqual(r.body.success, true);
  assert.equal(r.body.success, false);
});

test('TEST C · zero marketplace mutation calls', async () => {
  resetSpy();
  await postJson(makeApp(), ROUTE, {});
  assert.equal(spy.ebayCtorCalls,     0, 'EbayAPI ctor must not fire');
  assert.equal(spy.ebayGetListings,   0, 'getActiveListings must not fire');
  assert.equal(spy.ebayClearCustom.length, 0, 'clearCustomLabel must not fire');
});

test('TEST D · zero DB writes', async () => {
  resetSpy();
  await postJson(makeApp(), ROUTE, {});
  assert.equal(spy.dbGetClient,           0, 'getClient must not fire');
  assert.equal(spy.dbFromCalls.length,    0, 'db.from must not fire');
  assert.equal(spy.dbUpdateCalls.length,  0, 'db.update must not fire');
});

test('TEST E · bulk SKU update helper never invoked', async () => {
  resetSpy();
  await postJson(makeApp(), ROUTE, {});
  assert.equal(
    spy.dbFromCalls.filter((t) => t === 'ebay_products').length,
    0,
    'ebay_products table must not be touched',
  );
  assert.equal(spy.ebayClearCustom.length, 0);
});

test('TEST F · large body with many SKU/ItemID entries still no mutation', async () => {
  resetSpy();
  const bigBody = {
    items: Array.from({ length: 500 }, (_, i) => ({
      itemId: `ITEM-${i.toString().padStart(6, '0')}`,
      sku:    `LEGACY-SKU-${i}`,
    })),
    override: true,
    confirm:  true,
  };
  const r = await postJson(makeApp(), ROUTE, bigBody);
  assert.equal(r.status, 409);
  assert.equal(spy.ebayCtorCalls,        0);
  assert.equal(spy.ebayClearCustom.length, 0);
  assert.equal(spy.dbUpdateCalls.length,   0);
});

test('TEST G · empty / missing body still no mutation', async () => {
  resetSpy();
  const r = await postJson(makeApp(), ROUTE, undefined);
  assert.equal(r.status, 409);
  assert.equal(spy.ebayClearCustom.length, 0);
  assert.equal(spy.dbUpdateCalls.length,   0);
});

test('TEST H · route remains registered / callable (not 404)', async () => {
  resetSpy();
  const r = await postJson(makeApp(), ROUTE, {});
  assert.notEqual(r.status, 404, 'fence must NOT be a 404 — route stays registered');
  assert.equal(r.status, 409);
});

// ─────────────────────────────────────────────────────────────────────
// Structural invariant — static confirmation that api.js source contains
// no reachable path from the clear-sku route to a SKU-mutation call.
// Behavioural tests above prove non-invocation dynamically; this test
// catches a future edit that would put the dangerous body back below an
// unconditional return (which behavioural tests could miss if a caller
// bypassed express routing).
// ─────────────────────────────────────────────────────────────────────
test('TEST I · api.js source: clear-sku route body has no mutation call', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/web/routes/api.js'),
    'utf8',
  );
  // Isolate the exact route handler block for this endpoint.
  const start = src.indexOf("router.post('/products/ebay/clear-sku'");
  assert.ok(start > -1, 'clear-sku route must remain registered');
  // Find the next route registration to bound our slice.
  const restAfter = src.slice(start + 1);
  const nextRoute = restAfter.search(/router\.(get|post|put|patch|delete)\(/);
  const block = restAfter.slice(0, nextRoute > -1 ? nextRoute : 4000);
  // Strip comments to avoid matching legitimate documentation.
  const code = block
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden = [
    /clearCustomLabel\s*\(/,
    /getActiveListings\s*\(/,
    /ReviseItem/i,
    /\.update\s*\(\s*\{\s*sku\s*:/,
    /getEbayAPI\s*\(/,
    /getClient\s*\(/,
  ];
  for (const rx of forbidden) {
    assert.equal(
      rx.test(code),
      false,
      `clear-sku route body must NOT contain reachable mutation call: ${rx}`,
    );
  }
});
