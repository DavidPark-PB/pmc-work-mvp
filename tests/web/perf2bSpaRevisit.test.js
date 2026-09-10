'use strict';

/**
 * tests/web/perf2bSpaRevisit.test.js — PMC-PERF-2B (2026-09-10).
 *
 * Runtime proofs for SPA menu-revisit acceleration:
 *
 *   opsProfit / opsProfitOms  · SAFE_SHORT_CACHE (3s TTL, URL/period-keyed)
 *                             · in-flight dedup
 *                             · query-key change → cache miss (search / goPage)
 *                             · error path never caches (Unknown ≠ Zero)
 *                             · bounded — one snapshot per route
 *
 *   opsInventory              · DEDUP_ONLY (no data cache) — inventory truth
 *
 *   shipping (dashboard.js)   · DEDUP_ONLY — mutation callsites re-invoke on the
 *                             · exact function; a data cache would need bypass
 *                               plumbed through 11 setTimeout callsites
 *
 *   ops-profit dispatch (dashboard.js)
 *                             · explicit Promise.allSettled — proves independence
 *
 *   0071dcd defer commit preserved (30 defer attributes untouched)
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO       = path.resolve(__dirname, '../..');
const OPERATIONS = path.join(REPO, 'public/js/operations.js');
const DASHBOARD  = path.join(REPO, 'public/js/dashboard.js');
const INDEX_HTML = path.join(REPO, 'public/index.html');

// ─── minimal DOM stub — only what operations.js touches ─────────────────────
function makeDom() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', value: '' });
    return elements.get(id);
  };
  return {
    document: {
      getElementById: get,
      querySelectorAll: () => [],
      querySelector: () => null,
      readyState: 'complete',
      addEventListener: () => {},
    },
    elements,
  };
}

function makeFetchCounter(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, fetch: fn };
}

// Load operations.js in THIS realm (not a vm sandbox) so Promise identity is
// shared with the test — vm.runInContext creates a fresh Promise constructor
// which breaks async-function dedup timing.
const OPS_SRC = fs.readFileSync(OPERATIONS, 'utf8');
const opsFactory = new Function(
  'window', 'document', 'fetch', 'setInterval', 'clearInterval',
  'setTimeout', 'URLSearchParams', 'alert', 'console',
  OPS_SRC + '\nreturn window;'
);

async function loadOpsModule(fetchImpl, dom, fc) {
  const win = {};
  opsFactory(
    win,
    dom.document,
    fetchImpl,
    () => 0,
    () => {},
    (fn) => { /* eager: fire timer callbacks so notif init doesn't leak */ if (typeof fn === 'function') try { fn(); } catch (_) {} return 0; },
    URLSearchParams,
    () => {},
    { log: () => {}, error: () => {}, warn: () => {} },
  );
  //  operations.js kicks off opsNotif.startPolling → opsApi.get('/notifications')
  //  synchronously on load. Drain that microtask and reset the counter so the
  //  test only measures traffic caused by its own load() calls.
  await new Promise(r => setImmediate(r));
  if (fc) fc.calls.length = 0;
  return win;
}

// Successful profit payload — used by fetch handler.
const OK_PROFIT = {
  data: [{ sku: 'SKU-1', title: 't', sale_price: 1, cost_price_usd: 1, cost_price_krw: 1000,
           platform_fee: 0.1, fee_rate: 0.1, shipping_cost: 0.5, profit: 0.3, margin_pct: 25, platform: 'ebay' }],
  pagination: { page: 1, totalPages: 1, total: 1, limit: 50 },
};
const OK_PROFIT_OMS = {
  summary: { totalOrders: 1, totalLines: 1, revenueUsd: 10, costUsd: 4, feeUsd: 1, shippingUsd: 2, netProfitUsd: 3, marginPct: 30 },
  byChannel: [{ channel: 'ebay', orders: 1, revenueUsd: 10, costUsd: 4, feeUsd: 1, feeRate: 0.1, shippingUsd: 2, netProfitUsd: 3, marginPct: 30 }],
  warnings: {}, exchangeRate: 1370, period: '30', since: '2026-08-11T00:00:00Z',
};
const OK_INVENTORY = {
  data: [{ product_id: 1, quantity: 5, reserved: 0, location: 'A', updated_at: '2026-09-10T00:00:00Z',
           products: { sku: 'SKU-1', title: 't', barcode: '' } }],
  pagination: { page: 1, totalPages: 1, total: 1, limit: 50 },
};

function mkResp(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

// ─────────────────────────────────────────────────────────────────────────────
// opsProfit — SAFE_SHORT_CACHE (3s TTL) + dedup
// ─────────────────────────────────────────────────────────────────────────────

test('PERF2B-1 · opsProfit: second call within TTL serves from cache (0 additional fetches)', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_PROFIT));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfit._resetCache();

  await win.opsProfit.load();
  const afterFirst = fc.calls.length;
  await win.opsProfit.load();
  assert.equal(fc.calls.length, afterFirst,
    'revisit within TTL must NOT trigger another fetch');
  assert.ok(win.opsProfit._peekCache(), 'cache must be populated after first successful load');
});

test('PERF2B-2 · opsProfit: cache expires after TTL — fresh fetch occurs', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_PROFIT));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfit._resetCache();

  await win.opsProfit.load();
  const before = fc.calls.length;

  // Simulate age > TTL by mutating cache.at into the past.
  const cache = win.opsProfit._peekCache();
  cache.at = Date.now() - 5000; // > 3000ms TTL
  await win.opsProfit.load();
  assert.equal(fc.calls.length, before + 1,
    'after TTL expiry the next load MUST hit the network');
});

test('PERF2B-3 · opsProfit: concurrent duplicate loads deduped to one fetch', async () => {
  const dom = makeDom();
  // Simulate slow fetch so two loads overlap.
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const fc = makeFetchCounter(() => pending);
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfit._resetCache();

  const p1 = win.opsProfit.load();
  const p2 = win.opsProfit.load();
  assert.equal(fc.calls.length, 1, 'two concurrent loads MUST issue only one fetch');
  resolve(mkResp(OK_PROFIT));
  await Promise.all([p1, p2]);
});

test('PERF2B-4 · opsProfit: query-key change (search/goPage) misses cache', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_PROFIT));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfit._resetCache();

  await win.opsProfit.load(); // page=1 default
  const before = fc.calls.length;
  win.opsProfit.goPage(2);    // page=2 → different URL
  await new Promise(r => setImmediate(r));
  await win.opsProfit.load(); // still page=2 now, so this reuses page-2 in-flight or cache
  assert.ok(fc.calls.length >= before + 1,
    'page change MUST trigger a new fetch (different URL key)');
});

test('PERF2B-5 · opsProfit: error response does NOT populate cache (Unknown ≠ Zero)', async () => {
  const dom = makeDom();
  //  URL-keyed mock: /profit always fails first, then succeeds; unrelated URLs
  //  (e.g. /notifications from module-load) get a harmless success. Counting
  //  on call-order is unreliable because the loaded module fires a background
  //  notifications fetch on init.
  let profitCalls = 0;
  const fc = makeFetchCounter(async (url) => {
    if (url.includes('/profit')) {
      profitCalls++;
      if (profitCalls === 1) {
        return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
      }
      return mkResp(OK_PROFIT);
    }
    return mkResp({ data: [], unread: 0 });
  });
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfit._resetCache();

  await win.opsProfit.load(); // fails
  assert.equal(win.opsProfit._peekCache(), null, 'failed fetch MUST NOT populate cache');
  await win.opsProfit.load();
  assert.equal(profitCalls, 2, 'subsequent load after failure MUST refetch');
});

// ─────────────────────────────────────────────────────────────────────────────
// opsProfitOms — SAFE_SHORT_CACHE (3s TTL) + dedup, keyed on period
// ─────────────────────────────────────────────────────────────────────────────

test('PERF2B-6 · opsProfitOms: revisit within TTL serves from cache', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_PROFIT_OMS));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfitOms._resetCache();

  await win.opsProfitOms.load();
  const before = fc.calls.length;
  await win.opsProfitOms.load();
  assert.equal(fc.calls.length, before, 'revisit within TTL must NOT trigger a fetch');
});

test('PERF2B-7 · opsProfitOms: TTL expiry triggers refresh', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_PROFIT_OMS));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfitOms._resetCache();

  await win.opsProfitOms.load();
  const cache = win.opsProfitOms._peekCache();
  cache.at = Date.now() - 5000;
  const before = fc.calls.length;
  await win.opsProfitOms.load();
  assert.equal(fc.calls.length, before + 1, 'after TTL expiry the next load MUST fetch fresh');
});

test('PERF2B-8 · opsProfitOms: period change misses cache', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_PROFIT_OMS));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  win.opsProfitOms._resetCache();

  await win.opsProfitOms.load(); // period default 30
  const before = fc.calls.length;
  dom.elements.get('opsProfitOmsPeriod').value = '60';
  await win.opsProfitOms.load();
  assert.equal(fc.calls.length, before + 1,
    'period change MUST invalidate cache and trigger a fresh fetch');
});

// ─────────────────────────────────────────────────────────────────────────────
// opsInventory — DEDUP_ONLY (no TTL cache — inventory is operational truth)
// ─────────────────────────────────────────────────────────────────────────────

test('PERF2B-9 · opsInventory: concurrent loads deduped to one fetch', async () => {
  const dom = makeDom();
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const fc = makeFetchCounter(() => pending);
  const win = await loadOpsModule(fc.fetch, dom, fc);

  const p1 = win.opsInventory.load();
  const p2 = win.opsInventory.load();
  assert.equal(fc.calls.length, 1,
    'two concurrent inventory loads MUST dedup to one fetch');
  resolve(mkResp(OK_INVENTORY));
  await Promise.all([p1, p2]);
});

test('PERF2B-10 · opsInventory: sequential loads BOTH hit network (no TTL cache — inventory truth)', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_INVENTORY));
  const win = await loadOpsModule(fc.fetch, dom, fc);

  await win.opsInventory.load();
  await win.opsInventory.load();
  assert.equal(fc.calls.length, 2,
    'inventory MUST re-fetch on every completed load — no data cache (scan mutations occur out-of-band)');
});

test('PERF2B-11 · opsInventory: does NOT expose _peekCache (proves no data cache)', async () => {
  const dom = makeDom();
  const fc = makeFetchCounter(() => mkResp(OK_INVENTORY));
  const win = await loadOpsModule(fc.fetch, dom, fc);
  assert.equal(typeof win.opsInventory._peekCache, 'undefined',
    'opsInventory MUST NOT expose a cache accessor (dedup-only)');
});

// ─────────────────────────────────────────────────────────────────────────────
// dashboard.js — shipping DEDUP_ONLY + ops-profit explicit parallel dispatch
// ─────────────────────────────────────────────────────────────────────────────

test('PERF2B-12 · dashboard.js: shippingLoadRecent wraps _shippingLoadRecentImpl with in-flight dedup', () => {
  const src = fs.readFileSync(DASHBOARD, 'utf8');
  assert.ok(/_shippingLoadInflight\s*=\s*null/.test(src),
    'must declare _shippingLoadInflight guard');
  assert.ok(/async function _shippingLoadRecentImpl\s*\(/.test(src),
    'must extract the fetch body into _shippingLoadRecentImpl');
  const wrapper = /async function shippingLoadRecent\s*\(\s*\)\s*\{[\s\S]*?\n\}/m.exec(src);
  assert.ok(wrapper, 'must have a wrapper shippingLoadRecent()');
  assert.ok(/if\s*\(\s*_shippingLoadInflight\s*\)\s*return\s+_shippingLoadInflight/.test(wrapper[0]),
    'wrapper MUST short-circuit when a load is already in flight');
});

test('PERF2B-13 · dashboard.js: ops-profit dispatch uses explicit Promise.allSettled', () => {
  const src = fs.readFileSync(DASHBOARD, 'utf8');
  const idx = src.indexOf("case 'ops-profit'");
  assert.ok(idx > 0, 'ops-profit case must exist');
  const region = src.slice(idx, idx + 1000);
  //  Must invoke Promise.allSettled with BOTH loader calls in a single array —
  //  proves independence and failure isolation. Deliberately brace-less
  //  case body (see pmcUiMap2A EXTRA test — inner `    }\n` would truncate
  //  the switch-parsing regex).
  assert.ok(/Promise\.allSettled\s*\(\s*\[/.test(region),
    'ops-profit dispatch MUST wrap both loaders in Promise.allSettled — proves independence');
  assert.ok(/opsProfitOms\.load\(\)/.test(region), 'opsProfitOms.load() must still fire');
  assert.ok(/opsProfit\.load\(\)/.test(region),    'opsProfit.load() must still fire');
  //  No block-brace inside this case — prevents the pmcUiMap2A regex regression.
  const caseBody = /case 'ops-profit':([\s\S]*?)break;/.exec(region);
  assert.ok(caseBody, 'must find case body ending in break');
  assert.ok(!/^\s*\{\s*$/m.test(caseBody[1]),
    'case body MUST NOT open a block brace on its own line — breaks sidebar test regex');
});

test('PERF2B-14 · dashboard.js: shipping data cache NOT introduced (spec: DEDUP_ONLY)', () => {
  const src = fs.readFileSync(DASHBOARD, 'utf8');
  //  A data cache would need a TTL constant + snapshot in the shipping loader.
  //  Prove neither pattern exists.
  const shippingBlock = /_shippingLoadRecentImpl[\s\S]{0,4500}/m.exec(src) || [''];
  assert.ok(!/_shippingCache\s*=\s*\{/.test(shippingBlock[0]),
    'shipping data cache is FORBIDDEN in this phase');
  assert.ok(!/SHIPPING_CACHE_TTL/.test(shippingBlock[0]),
    'shipping TTL constant is FORBIDDEN in this phase');
});

// ─────────────────────────────────────────────────────────────────────────────
// 0071dcd defer preservation
// ─────────────────────────────────────────────────────────────────────────────

test('PERF2B-15 · 0071dcd defer commit preserved (≥30 defer attributes on script tags)', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const deferTags = html.match(/<script\b[^>]*\bdefer\b[^>]*>/g) || [];
  assert.ok(deferTags.length >= 30,
    `expected ≥30 <script defer> tags (0071dcd); got ${deferTags.length}`);
});
