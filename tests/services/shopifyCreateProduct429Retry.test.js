'use strict';

/**
 * tests/services/shopifyCreateProduct429Retry.test.js  (2026-09-19)
 *
 * Owner-reported bug: AI 상품제작 rejected on Shopify side with
 *   "Exceeded 2 calls per second for api client. Reduce request rates
 *    to resume uninterrupted service."
 *
 * Root cause: `ShopifyAPI.createProduct` (src/api/shopifyAPI.js) POSTed
 * to /products.json via a bare `axios.post` that BYPASSED the existing
 * `_request()` helper's 429 retry-with-backoff. When Shopify's leaky
 * bucket rejected mid-batch, the whole create failed without retry.
 *
 * Fix: wrap the POST in a 429-only retry (Retry-After header + capped
 * exponential backoff, max 4 attempts, 1s/2s/4s/8s). 429 is safe to
 * retry because Shopify rejects BEFORE any product row is created —
 * there is no risk of duplicate listings from the retry.
 * Timeout (ECONNABORTED / ETIMEDOUT) and 5xx still fail-closed to
 * preserve the PMC-EXPORT-SAFETY-2E unknown_may_have_created semantics.
 * A proactive throttle (≥550ms between successive dispatches)
 * complements the reactive retry.
 *
 * Test strategy: monkey-patch axios.post on the shopifyAPI's require
 * cache to script deterministic status codes without hitting the
 * network. The test uses fake-timers (advanceTimers via sleep hooking)
 * — instead we shorten the retry backoff by monkey-patching
 * `setTimeout` locally.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO       = path.resolve(__dirname, '../..');
const SHOPIFY_JS = path.join(REPO, 'src/api/shopifyAPI.js');

//   Seed env so ShopifyAPI constructor doesn't blow up on missing creds.
process.env.SHOPIFY_STORE_URL   = process.env.SHOPIFY_STORE_URL   || 'stub-store.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || 'stub-token';

//   Fresh module load each test — the module-scope
//   `_lastShopifyCreateDispatchAt` throttle timestamp must start clean.
function loadShopifyFresh() {
  delete require.cache[require.resolve(SHOPIFY_JS)];
  delete require.cache[require.resolve('axios')];
  //   Load axios first so we can capture the module before shopifyAPI
  //   requires it.
  const axios = require('axios');
  const Shopify = require(SHOPIFY_JS);
  Shopify._resetShopifyThrottleForTest();
  return { axios, Shopify };
}

//   Stub axios.post with a scripted response queue. Each call consumes
//   one item from `responses`. Item shape:
//     { status, data?, headers? } → resolves as axios success or throws
//     with err.response.{status,data,headers} for non-2xx.
function stubAxiosPost(axios, responses) {
  const calls = [];
  axios.post = async (url, data, config) => {
    calls.push({ url, data, config, at: Date.now() });
    const next = responses.shift();
    if (!next) throw new Error(`axios.post stub ran out of responses (call #${calls.length})`);
    if (next.status >= 200 && next.status < 300) {
      return { status: next.status, data: next.data || { product: { id: 999, variants: [{ id: 1 }], handle: 'stub' } } };
    }
    const err = new Error(`Request failed with status code ${next.status}`);
    err.response = { status: next.status, data: next.data || {}, headers: next.headers || {} };
    throw err;
  };
  return calls;
}

//   ═════════════════════════════════════════════════════════════
//   §1 · 429 is retried with backoff; success on 2nd attempt
//   ═════════════════════════════════════════════════════════════

test('SHOPIFY-1 · single 429 followed by 200 → createProduct succeeds', async (t) => {
  const { axios, Shopify } = loadShopifyFresh();
  //   Cap the retry backoff to near-zero so test runs fast.
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => origSetTimeout(fn, 1);
  t.after(() => { global.setTimeout = origSetTimeout; });

  const calls = stubAxiosPost(axios, [
    { status: 429, data: { errors: 'Exceeded 2 calls per second for api client.' }, headers: { 'retry-after': '0.001' } },
    { status: 200, data: { product: { id: 12345, variants: [{ id: 99 }], handle: 'test-a' } } },
  ]);
  const client = new Shopify();
  const r = await client.createProduct({ title: 'T', sku: 'S', price: 10 });
  assert.equal(r.success, true, `expected success — got ${JSON.stringify(r)}`);
  assert.equal(r.productId, 12345);
  assert.equal(calls.length, 2, `expected 2 axios.post calls (429 then 200) — got ${calls.length}`);
});

test('SHOPIFY-2 · four consecutive 429s → gives up and surfaces error (no infinite loop)', async (t) => {
  const { axios, Shopify } = loadShopifyFresh();
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => origSetTimeout(fn, 1);
  t.after(() => { global.setTimeout = origSetTimeout; });

  const calls = stubAxiosPost(axios, [
    { status: 429, headers: { 'retry-after': '0.001' } },
    { status: 429, headers: { 'retry-after': '0.001' } },
    { status: 429, headers: { 'retry-after': '0.001' } },
    { status: 429, headers: { 'retry-after': '0.001' } },
  ]);
  const client = new Shopify();
  const r = await client.createProduct({ title: 'T', sku: 'S', price: 10 });
  assert.equal(r.success, false,
    'after 4 straight 429s, createProduct MUST surface {success:false} (no infinite retry)');
  assert.equal(calls.length, 4, `MUST attempt exactly 4 times — got ${calls.length}`);
});

//   ═════════════════════════════════════════════════════════════
//   §2 · TIMEOUT and 5xx are NOT retried (fail-closed preserved)
//   ═════════════════════════════════════════════════════════════

test('SHOPIFY-3 · ECONNABORTED (timeout) is NOT retried and propagates as thrown error', async (t) => {
  const { axios, Shopify } = loadShopifyFresh();

  let callCount = 0;
  axios.post = async () => {
    callCount++;
    const err = new Error('timeout of 30000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  };
  const client = new Shopify();
  await assert.rejects(
    () => client.createProduct({ title: 'T', sku: 'S', price: 10 }),
    (e) => e.code === 'ECONNABORTED',
    'timeout MUST propagate upward for ProductExporter to classify as unknown_may_have_created',
  );
  assert.equal(callCount, 1, 'timeout MUST NOT be retried (may have committed on Shopify side)');
});

test('SHOPIFY-4 · 500 server error is NOT retried and surfaces {success:false}', async (t) => {
  const { axios, Shopify } = loadShopifyFresh();

  const calls = stubAxiosPost(axios, [
    { status: 500, data: { errors: 'internal server error' } },
  ]);
  const client = new Shopify();
  const r = await client.createProduct({ title: 'T', sku: 'S', price: 10 });
  assert.equal(r.success, false, '5xx MUST NOT be retried and MUST surface failure');
  assert.equal(calls.length, 1, '5xx MUST fire exactly once (no retry — may have committed)');
});

test('SHOPIFY-5 · 401 auth error is NOT retried', async (t) => {
  const { axios, Shopify } = loadShopifyFresh();

  const calls = stubAxiosPost(axios, [
    { status: 401, data: { errors: '[API] Invalid API key or access token' } },
  ]);
  const client = new Shopify();
  const r = await client.createProduct({ title: 'T', sku: 'S', price: 10 });
  assert.equal(r.success, false);
  assert.equal(calls.length, 1, 'auth errors MUST NOT be retried');
});

//   ═════════════════════════════════════════════════════════════
//   §3 · Proactive throttle ≥550ms between successive dispatches
//   ═════════════════════════════════════════════════════════════

test('SHOPIFY-6 · back-to-back createProduct calls wait ≥550ms between dispatches (proactive throttle)', async (t) => {
  const { axios, Shopify } = loadShopifyFresh();

  const calls = stubAxiosPost(axios, [
    { status: 200 },
    { status: 200 },
  ]);
  const client = new Shopify();
  await client.createProduct({ title: 'A', sku: 'A', price: 10 });
  await client.createProduct({ title: 'B', sku: 'B', price: 10 });
  assert.equal(calls.length, 2);
  const gap = calls[1].at - calls[0].at;
  assert.ok(gap >= 500,
    `proactive throttle MUST space calls ≥ ~500ms apart — got ${gap}ms`);
});

//   ═════════════════════════════════════════════════════════════
//   §4 · Source-level: the raw axios.post that bypassed _request
//        is gone (regression guard)
//   ═════════════════════════════════════════════════════════════

test('SHOPIFY-7 · createProduct source uses the 429-retry loop, not a bare one-shot axios.post', () => {
  const fs = require('fs');
  const src = fs.readFileSync(SHOPIFY_JS, 'utf8');
  //   The retry loop constant must exist and be referenced from createProduct.
  assert.ok(/SHOPIFY_CREATE_PRODUCT_MAX_429_RETRIES/.test(src),
    'the 429 retry cap constant MUST be declared');
  //   createProduct body must reference the throttle helper.
  assert.ok(/_waitShopifyThrottle\s*\(\s*\)/.test(src),
    'createProduct MUST call the proactive throttle helper before dispatch');
  //   The retry loop attempts must be visible.
  assert.ok(/for\s*\(\s*let\s+attempt\s*=\s*1\s*;\s*attempt\s*<=\s*SHOPIFY_CREATE_PRODUCT_MAX_429_RETRIES/.test(src),
    'createProduct MUST run the 429 retry loop');
});
