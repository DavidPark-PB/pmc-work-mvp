'use strict';

/**
 * tests/services/shopifyCreateProductTimeout.test.js — PMC-EXPORT-SAFETY-2E
 * (2026-09-09).
 *
 * Proves that ShopifyAPI.createProduct now uses a finite timeout, makes
 * exactly ONE POST attempt (no retry), and propagates timeout errors
 * upward so ProductExporter's 2D outer catch classifies them as
 * unknown_may_have_created.
 *
 * Non-timeout HTTP failures preserve the existing {success:false, error}
 * contract that 2D already fail-closes via UNKNOWN classification (OUT-3).
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO           = path.resolve(__dirname, '../..');
const SHOPIFY_JS     = path.join(REPO, 'src/api/shopifyAPI.js');
const EXPORTER_JS    = path.join(REPO, 'src/services/productExporter.js');

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = {
    id: fullPath, filename: fullPath, loaded: true,
    exports: exportsObj, children: [], paths: [],
  };
}
function readSrc(p) { return fs.readFileSync(p, 'utf8'); }

// ═════════════════════════════════════════════════════════════════════
// STRUCTURAL PROOFS · timeout constant + wiring
// ═════════════════════════════════════════════════════════════════════

test('SHOP-TIMEOUT-1 · createProduct axios POST includes a finite `timeout` option', () => {
  const src = readSrc(SHOPIFY_JS);
  //   Locate the createProduct method definition.
  const methodIdx = src.indexOf('async createProduct(');
  assert.ok(methodIdx > 0, 'createProduct method must exist');
  //   Find the next occurrence of `async ` (start of the next method) to
  //   bound the search region. Fall back to slice(methodIdx, +4000) if the
  //   next-method scan misses (there is one further down).
  const nextMethodIdx = src.indexOf('\n  async ', methodIdx + 20);
  const region = src.slice(methodIdx, nextMethodIdx > 0 ? nextMethodIdx : methodIdx + 4000);
  //   Inside createProduct, find axios.post(...) and its argument list.
  const postIdx = region.indexOf('axios.post(');
  assert.ok(postIdx > 0, 'axios.post must be called inside createProduct');
  //   Bracket-count to find the matching close paren for axios.post(...).
  let depth = 0, postEnd = -1;
  for (let i = postIdx; i < region.length; i++) {
    if (region[i] === '(') depth++;
    else if (region[i] === ')') { depth--; if (depth === 0) { postEnd = i; break; } }
  }
  assert.ok(postEnd > postIdx);
  const postCall = region.slice(postIdx, postEnd + 1);
  assert.ok(/timeout\s*:\s*([A-Z_][A-Z0-9_]*|\d+)/.test(postCall),
    `axios.post inside createProduct must have a \`timeout\` option (literal or named constant). Got:\n${postCall}`);
});

test('SHOP-TIMEOUT-2 · timeout value > 0', () => {
  const src = readSrc(SHOPIFY_JS);
  //   Locate the module-level constant OR direct literal.
  const constMatch = src.match(/SHOPIFY_CREATE_PRODUCT_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(constMatch, 'expected SHOPIFY_CREATE_PRODUCT_TIMEOUT_MS constant');
  const ms = parseInt(constMatch[1], 10);
  assert.ok(ms > 0, `timeout must be > 0 (got ${ms})`);
});

test('SHOP-TIMEOUT-3 · timeout value < 180000 ms (comfortably below 2C lease TTL)', () => {
  const src = readSrc(SHOPIFY_JS);
  const constMatch = src.match(/SHOPIFY_CREATE_PRODUCT_TIMEOUT_MS\s*=\s*(\d+)/);
  const ms = parseInt(constMatch[1], 10);
  assert.ok(ms < 180000, `timeout must leave margin below 180s lease TTL (got ${ms} ms)`);
  //   And it must not equal 180000 (needs actual margin for exporter to catch + persist).
  assert.ok(ms <= 120000, `timeout should leave >= 60s margin below 180s (got ${ms} ms)`);
});

// ═════════════════════════════════════════════════════════════════════
// BEHAVIORAL PROOFS · axios mocked, ShopifyAPI loaded fresh
// ═════════════════════════════════════════════════════════════════════

//   Controllable axios stub. Records every call and lets each test steer
//   the next .post response.
const axiosCalls = [];
let   axiosPostBehavior = null; // (url, data, cfg) => response | throws

function fakeAxios(config) {
  //   ShopifyAPI._request delegates to axios(config) directly, but 2E's
  //   createProduct uses axios.post(...) — see below.
  axiosCalls.push({ kind: 'call', config });
  throw new Error('fakeAxios: unexpected direct call (createProduct uses .post)');
}
fakeAxios.post = async function(url, data, cfg) {
  axiosCalls.push({ kind: 'post', url, data, cfg });
  if (typeof axiosPostBehavior === 'function') return axiosPostBehavior(url, data, cfg);
  //   Default: minimal Shopify success response.
  return { data: { product: {
    id: 999,
    variants: [{ id: 888 }],
    handle: 'test-handle',
    online_store_url: 'https://example.myshopify.com/products/test-handle',
  } } };
};
fakeAxios.get    = async function() { throw new Error('fakeAxios.get: unused in these tests'); };
fakeAxios.put    = async function() { throw new Error('fakeAxios.put: unused in these tests'); };
fakeAxios.delete = async function() { throw new Error('fakeAxios.delete: unused in these tests'); };

stub(require.resolve('axios'), fakeAxios);

//   Also stub ../config to avoid loading dotenv/side-effects.
stub(require.resolve(path.join(REPO, 'src/config')), {});

//   Set the two env vars Shopify's constructor requires.
process.env.SHOPIFY_STORE_URL   = 'example.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test-token';

delete require.cache[require.resolve(path.join(REPO, 'src/api/shopifyAPI'))];
const ShopifyAPI = require(path.join(REPO, 'src/api/shopifyAPI'));

function reset() {
  axiosCalls.length = 0;
  axiosPostBehavior = null;
}

test('SHOP-TIMEOUT-4 · one successful createProduct call → exactly ONE axios POST', async () => {
  reset();
  const api = new ShopifyAPI();
  const r = await api.createProduct({ title: 'T', sku: 'S', price: 19.99, quantity: 1 });
  const posts = axiosCalls.filter(c => c.kind === 'post');
  assert.equal(posts.length, 1, 'exactly one axios.post attempt');
  assert.equal(r.success, true);
});

test('SHOP-TIMEOUT-5 · simulated timeout → still exactly ONE axios POST · no retry', async () => {
  reset();
  //   Build an axios-style timeout error.
  axiosPostBehavior = () => {
    const err = new Error('timeout of 30000ms exceeded');
    err.code = 'ECONNABORTED';
    err.isAxiosError = true;
    throw err;
  };
  const api = new ShopifyAPI();
  let caught = null;
  try { await api.createProduct({ title: 'T', sku: 'S', price: 19.99, quantity: 1 }); }
  catch (e) { caught = e; }
  const posts = axiosCalls.filter(c => c.kind === 'post');
  assert.equal(posts.length, 1, 'timeout must NOT trigger a second POST attempt');
  assert.ok(caught, 'timeout must propagate as a thrown error');
});

test('SHOP-TIMEOUT-6 · axios ECONNABORTED timeout propagates/rejects from createProduct', async () => {
  reset();
  axiosPostBehavior = () => {
    const err = new Error('timeout of 30000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  };
  const api = new ShopifyAPI();
  await assert.rejects(
    () => api.createProduct({ title: 'T', sku: 'S', price: 1, quantity: 1 }),
    (err) => err.code === 'ECONNABORTED'
  );
});

test('SHOP-TIMEOUT-6b · Node/undici ETIMEDOUT also propagates/rejects', async () => {
  reset();
  axiosPostBehavior = () => {
    const err = new Error('connect ETIMEDOUT ...');
    err.code = 'ETIMEDOUT';
    throw err;
  };
  const api = new ShopifyAPI();
  await assert.rejects(
    () => api.createProduct({ title: 'T', sku: 'S', price: 1, quantity: 1 }),
    (err) => err.code === 'ETIMEDOUT'
  );
});

test('SHOP-TIMEOUT-7 · timeout is NEVER converted to {success:true}', async () => {
  reset();
  axiosPostBehavior = () => {
    const err = new Error('timeout of 30000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  };
  const api = new ShopifyAPI();
  //   The old catch would have collapsed this to {success:false}. Now it throws.
  //   Either way, MUST NOT collapse to success.
  try {
    const r = await api.createProduct({ title: 'T', sku: 'S', price: 1, quantity: 1 });
    assert.notEqual(r?.success, true, 'timeout must not produce success:true');
  } catch (e) {
    //   Preferred outcome: throws with ECONNABORTED.
    assert.equal(e.code, 'ECONNABORTED');
  }
});

test('SHOP-TIMEOUT-8 · normal Shopify success still returns success:true + durable productId', async () => {
  reset();
  axiosPostBehavior = () => ({ data: { product: {
    id: 42, variants: [{ id: 4242 }], handle: 'sample', online_store_url: null,
  }}});
  const api = new ShopifyAPI();
  const r = await api.createProduct({ title: 'T', sku: 'S', price: 19.99, quantity: 1 });
  assert.equal(r.success, true);
  assert.equal(r.productId, 42);
  assert.equal(r.variantId, 4242);
  assert.equal(r.handle, 'sample');
});

test('SHOP-TIMEOUT-9 · non-timeout HTTP failure still returns {success:false, error} · 2D contract preserved', async () => {
  reset();
  axiosPostBehavior = () => {
    const err = new Error('Request failed with status code 422');
    err.response = { status: 422, data: { errors: { price: ['must be greater than 0'] } } };
    err.isAxiosError = true;
    //   Note: NO .code = 'ECONNABORTED' — non-timeout failure
    throw err;
  };
  const api = new ShopifyAPI();
  const r = await api.createProduct({ title: 'T', sku: 'S', price: 0, quantity: 1 });
  assert.equal(r.success, false, 'non-timeout HTTP failure keeps returned-failure shape');
  assert.ok(r.error, 'error field present');
});

// ═════════════════════════════════════════════════════════════════════
// INTEGRATION-SAFETY · post-timeout ProductExporter classification
// ═════════════════════════════════════════════════════════════════════
//
// Prove end-to-end: a thrown timeout from Shopify createProduct →
// ProductExporter's outer catch → marketplaceCallStarted=true →
// outcome_class='unknown_may_have_created' → excluded from getFailedExports.
//
// Reuses the same in-memory fake-repo pattern from the outcome tests but
// via a fresh module registration to avoid cross-test require-cache pollution.

test('INTEGRATION-SAFETY-1 · post-createProduct timeout → outcome_class=unknown_may_have_created', async () => {
  //   Isolated module graph for this integration.
  const iso = require('module');
  const origCache = { ...require.cache };

  //   In-memory upsert spy + fake repo.
  const upserts = [];
  class FakeRepo {
    async upsertExportStatus(productId, platformId, patch) {
      upserts.push({ productId, platformId, patch });
    }
    async getMappingForProductPlatform() { return null; }
    async getFailedExports() { return []; }
  }
  stub(require.resolve(path.join(REPO, 'src/db/platformRepository')), FakeRepo);
  stub(require.resolve(path.join(REPO, 'src/db/supabaseClient')), {
    getClient: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: {
          id: 1, sku: 'SKU-A', title: 't', title_ko: 't',
          purchase_price: 10000, weight: 0.5, target_margin: 30, quantity: 1,
          image_urls: [], condition: 'new',
        }, error: null })})}),
      }),
    }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/platformRegistry')), {
    getFeeRates:       async () => ({ shopify: 0.02 }),
    getExchangeRates:  async () => ({ USD_KRW: 1400 }),
    getMarginSettings: async () => ({ default_margin_pct: 30, default_shipping_usd: 3.9 }),
    getPlatform:       async () => ({ id: 'plat-shopify', key: 'shopify', name: 'Shopify', active: true, config: {} }),
    getApiInstance:    () => ({
      async createProduct() {
        //   Simulate what happens AFTER the 2E axios throw propagates out of
        //   ShopifyAPI.createProduct: exporter sees a thrown error with
        //   code=ECONNABORTED. The Shopify adapter is not exercised here —
        //   we simulate its NEW post-2E behavior (throws instead of
        //   returning {success:false}).
        const err = new Error('timeout of 30000ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      },
      async getToken() { return 'tok'; },
    }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/pricingEngine')), {
    calculatePrices: () => ({ shopify: { price: 21.5, currency: 'USD' } }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/platformOptimizer')), {
    optimize: (k, p) => ({ sku: p.sku, title: p.title, price: 21.5 }),
  });
  class FakeTx { async getTranslation() { return null; } async translateProduct() { return null; } }
  stub(require.resolve(path.join(REPO, 'src/services/translationService')), FakeTx);
  //   schedulerLock: pass-through, ownership always valid.
  stub(require.resolve(path.join(REPO, 'src/services/schedulerLock')), {
    withLease: async (_k, _o, fn) => {
      const value = await fn({ runId: 'r', isLeaseLost: () => false, verifyOwnership: async () => true });
      return { acquired: true, ran: true, leaseLost: false, value };
    },
    OWNER_ID: 't', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  });
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));

  const e = new PE();
  const r = await e.exportProduct('SKU-A', ['shopify'], { dryRun: false });
  //   Restore original require.cache to avoid polluting later tests.
  for (const k of Object.keys(require.cache)) {
    if (!origCache[k]) delete require.cache[k];
    else require.cache[k] = origCache[k];
  }
  //   Classification proof.
  const finalUpsert = upserts[upserts.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed');
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created',
    'timeout thrown after createProduct started must classify as UNKNOWN, not CF');
  assert.equal(r.results.shopify.success, false);
});

test('INTEGRATION-SAFETY-2 · UNKNOWN timeout row is excluded by getFailedExports', () => {
  //   Structural proof: platformRepository.getFailedExports has the fail-closed
  //   filter that excludes outcome_class != 'confirmed_failure'.
  const src = fs.readFileSync(path.join(REPO, 'src/db/platformRepository.js'), 'utf8');
  const fnStart = src.indexOf('async getFailedExports(');
  assert.ok(fnStart > 0);
  const rest = src.slice(fnStart);
  const nextFn = rest.indexOf('async ', 10);
  const block = rest.slice(0, nextFn > 0 ? nextFn : 1500);
  assert.ok(/\.eq\(\s*['"]outcome_class['"]\s*,\s*['"]confirmed_failure['"]\s*\)/.test(block),
    'getFailedExports MUST require outcome_class=confirmed_failure — timeout UNKNOWN excluded');
});
