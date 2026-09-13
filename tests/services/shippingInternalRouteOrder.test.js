'use strict';

/**
 * tests/services/shippingInternalRouteOrder.test.js — PMC-CCOREA-SHIPPING-1B (2026-09-13, correction).
 *
 * Owner directive: prove that /api/internal/shipping/* is mounted BEFORE the
 * global authGuard so that server-to-server bearer-token calls reach the
 * requireInternalToken middleware instead of being pre-empted by session auth.
 *
 * Verifies at TWO levels:
 *   (A) Source-level: server.js declares the mount before `app.use(authGuard)`.
 *   (B) Runtime: a mini Express app that mirrors server.js's exact mount
 *       sequence responds to /api/internal/shipping/quote with
 *       requireInternalToken's error shapes — NEVER with the session-401
 *       "Authentication required" body used by authGuard.
 *
 * Runtime scenarios (owner directive §필수 보안 검증):
 *   1. env unset             → 503 INTERNAL_TOKEN_NOT_CONFIGURED
 *   2. env too short         → 503 INTERNAL_TOKEN_TOO_SHORT
 *   3. no Authorization      → 401 INVALID_INTERNAL_TOKEN
 *   4. wrong bearer          → 401 INVALID_INTERNAL_TOKEN
 *   5. correct bearer        → PAST authGuard (route body reached; may 500
 *                              on downstream DB call — that's fine, we only
 *                              need to know the response is NOT the session
 *                              401 "Authentication required")
 *   6. admin cookie only     → 401 INVALID_INTERNAL_TOKEN (cookie ignored)
 *   7. other /api/* routes   → still guarded by global authGuard
 *   8. no token echo in body → response bodies contain neither the expected
 *                              nor the received token
 *
 * Uses POST because /quote and /shadow-result are POST-only.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const http    = require('node:http');
const path    = require('node:path');

const REPO       = path.resolve(__dirname, '../..');
const SERVER_JS  = path.join(REPO, 'server.js');
const ROUTE_JS   = path.join(REPO, 'src/web/routes/shippingInternal.js');
const TOKEN_MW   = path.join(REPO, 'src/middleware/internalToken.js');
const MOD_ADAPTER = require.resolve(path.join(REPO, 'src/services/shipping/autoListingPricingAdapter.js'));
const MOD_RECORDER = require.resolve(path.join(REPO, 'src/services/shipping/shadowRecorder.js'));
const MOD_SB_CLIENT = require.resolve(path.join(REPO, 'src/db/supabaseClient.js'));

const OK_TOKEN = 't'.repeat(32);   //   ≥ MIN_TOKEN_LENGTH

//   ─────────────────────────────────────────────────────────────
//   Level A · SOURCE-LEVEL — mount order in server.js
//   ─────────────────────────────────────────────────────────────

test('ROUTE-ORDER-A · server.js mounts /api/internal/shipping BEFORE app.use(authGuard)', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const internalIdx = src.indexOf(`app.use('/api/internal/shipping'`);
  const authIdx     = src.indexOf('app.use(authGuard)');
  assert.ok(internalIdx > 0,           `/api/internal/shipping mount MUST exist`);
  assert.ok(authIdx > 0,               `app.use(authGuard) MUST exist`);
  assert.ok(internalIdx < authIdx,
    `internal shipping mount MUST precede authGuard (found internal at ${internalIdx}, authGuard at ${authIdx})`);
});

test('ROUTE-ORDER-A2 · server.js has EXACTLY ONE /api/internal/shipping mount', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const matches = src.match(/app\.use\(\s*['"]\/api\/internal\/shipping['"]/g) || [];
  assert.equal(matches.length, 1,
    `expected exactly one mount; found ${matches.length}`);
});

test('ROUTE-ORDER-A3 · router applies requireInternalToken to every route', () => {
  const src = fs.readFileSync(ROUTE_JS, 'utf8');
  //   router.use(requireInternalToken) must sit BEFORE any router.get/post etc.
  const useIdx = src.indexOf('router.use(requireInternalToken)');
  const firstRoute = src.search(/router\.(get|post|patch|delete|put)\s*\(/);
  assert.ok(useIdx > 0,   'router.use(requireInternalToken) must be declared');
  assert.ok(firstRoute > 0, 'at least one route must be declared');
  assert.ok(useIdx < firstRoute,
    'router.use(requireInternalToken) must precede all route declarations');
});

test('ROUTE-ORDER-A4 · global authGuard does NOT carry a /api/internal/ skip', () => {
  //   Owner directive: no broad path skip in the guard itself.
  const authMw = fs.readFileSync(path.join(REPO, 'src/middleware/auth.js'), 'utf8');
  assert.ok(!/\/api\/internal/.test(authMw),
    'authGuard MUST NOT carry a /api/internal path skip — the fix is order, not exception');
});

//   ─────────────────────────────────────────────────────────────
//   Level B · RUNTIME — build a mini app mirroring the mount order
//   ─────────────────────────────────────────────────────────────
//   We spin up a lightweight Express server that installs
//   the SAME middleware sequence server.js uses (verbatim: mount internal
//   shipping router, then app.use(authGuard)) and exercises each scenario.
//   Downstream deps (supabase client / adapter / recorder) are stubbed so
//   the route body doesn't actually touch a DB.

function buildMiniApp() {
  //   Stub supabase before requiring the route.
  delete require.cache[MOD_SB_CLIENT];
  require.cache[MOD_SB_CLIENT] = {
    id: MOD_SB_CLIENT, filename: MOD_SB_CLIENT, loaded: true,
    exports: {
      getClient: () => ({
        //   Anything the route touches under a valid token — return a
        //   deterministic error so we can distinguish "route reached" (500
        //   with our error shape) from "authGuard preempted" (401 with
        //   `Authentication required`).
        from() { throw new Error('mini-app-stub: DB unavailable'); },
      }),
    },
  };
  //   Stub adapter + recorder so the route body has something callable.
  delete require.cache[MOD_ADAPTER];
  require.cache[MOD_ADAPTER] = {
    id: MOD_ADAPTER, filename: MOD_ADAPTER, loaded: true,
    exports: {
      buildAutoListingPreview: async () => ({ ok: true, mode: 'shadow', totalShippingCostKrw: 17100 }),
      isShadowEnabled: () => false,
    },
  };
  delete require.cache[MOD_RECORDER];
  require.cache[MOD_RECORDER] = {
    id: MOD_RECORDER, filename: MOD_RECORDER, loaded: true,
    exports: { recordShadowResult: async () => ({ id: 1, deduped: false }) },
  };

  //   Purge the route + middleware caches so they pick up the new env.
  delete require.cache[require.resolve(ROUTE_JS)];
  delete require.cache[require.resolve(TOKEN_MW)];

  const express = require('express');
  const app = express();
  //   Simulate the exact server.js sequence for the paths we care about:
  //     1. mount internal shipping (with its own requireInternalToken)
  //     2. mount a global "authGuard" that mirrors production's error body
  app.use('/api/internal/shipping', require(ROUTE_JS));
  //   Sentinel guard — production authGuard body is
  //   `{"error":"Authentication required"}` with HTTP 401.
  //   If a request reaches this middleware, the fix has failed.
  app.use('/api/internal/shipping', () => { throw new Error('unreachable — internal route handled it'); });
  app.use((_req, res, _next) => res.status(401).json({ error: 'Authentication required' }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function requestJson({ port, path: p, method = 'POST', headers = {}, body = '{}' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* keep raw */ }
        resolve({ statusCode: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
async function withRunning(fn) {
  const app = buildMiniApp();
  const server = await listen(app);
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('ROUTE-ORDER-B1 · env unset → 503 INTERNAL_TOKEN_NOT_CONFIGURED (never session-401)', async () => {
  delete process.env.SHIPPING_QUOTE_INTERNAL_TOKEN;
  await withRunning(async (port) => {
    const r = await requestJson({ port, path: '/api/internal/shipping/quote', headers: { 'Authorization': `Bearer ${OK_TOKEN}` } });
    assert.equal(r.statusCode, 503, `expected 503; got ${r.statusCode} · body=${r.raw.slice(0, 200)}`);
    assert.equal(r.json && r.json.error, 'INTERNAL_TOKEN_NOT_CONFIGURED');
    assert.notEqual(r.json && r.json.error, 'Authentication required');
  });
});

test('ROUTE-ORDER-B2 · env too short → 503 INTERNAL_TOKEN_TOO_SHORT', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = 'short';
  await withRunning(async (port) => {
    const r = await requestJson({ port, path: '/api/internal/shipping/quote', headers: { 'Authorization': `Bearer short` } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json && r.json.error, 'INTERNAL_TOKEN_TOO_SHORT');
  });
});

test('ROUTE-ORDER-B3 · no Authorization header → 401 INVALID_INTERNAL_TOKEN (not session-401)', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  await withRunning(async (port) => {
    const r = await requestJson({ port, path: '/api/internal/shipping/quote' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json && r.json.error, 'INVALID_INTERNAL_TOKEN');
    assert.notEqual(r.json && r.json.error, 'Authentication required');
  });
});

test('ROUTE-ORDER-B4 · wrong Bearer → 401 INVALID_INTERNAL_TOKEN', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  await withRunning(async (port) => {
    const r = await requestJson({ port, path: '/api/internal/shipping/quote', headers: { 'Authorization': `Bearer ${'x'.repeat(32)}` } });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json && r.json.error, 'INVALID_INTERNAL_TOKEN');
  });
});

test('ROUTE-ORDER-B5 · correct Bearer → passes authGuard sentinel and reaches route body', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  await withRunning(async (port) => {
    const r = await requestJson({
      port, path: '/api/internal/shipping/quote',
      headers: { 'Authorization': `Bearer ${OK_TOKEN}` },
      body: JSON.stringify({ destinationCountry: 'US' }),
    });
    //   The stubbed adapter returns { ok:true, mode:'shadow' } → 200.
    assert.equal(r.statusCode, 200, `expected 200; got ${r.statusCode} · body=${r.raw.slice(0, 200)}`);
    assert.notEqual(r.json && r.json.error, 'Authentication required',
      'response body MUST NOT be the session-401 shape');
    assert.equal(r.json && r.json.ok, true);
    assert.equal(r.json && r.json.mode, 'shadow');
  });
});

test('ROUTE-ORDER-B6 · admin session cookie only → 401 INVALID_INTERNAL_TOKEN (cookie ignored)', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  await withRunning(async (port) => {
    const r = await requestJson({
      port, path: '/api/internal/shipping/quote',
      headers: { 'Cookie': 'pmc_session=fake-admin-session-value' },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json && r.json.error, 'INVALID_INTERNAL_TOKEN');
  });
});

test('ROUTE-ORDER-B7 · unrelated /api/* path still hits sentinel authGuard (401 Authentication required)', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  await withRunning(async (port) => {
    const r = await requestJson({ port, path: '/api/some/other/route' });
    assert.equal(r.statusCode, 401);
    //   The sentinel guard in buildMiniApp mirrors production's authGuard body.
    assert.equal(r.json && r.json.error, 'Authentication required');
  });
});

test('ROUTE-ORDER-B8 · error responses never echo the token (expected or received)', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  const RECEIVED = 'z'.repeat(48);
  await withRunning(async (port) => {
    const r = await requestJson({ port, path: '/api/internal/shipping/quote', headers: { 'Authorization': `Bearer ${RECEIVED}` } });
    assert.equal(r.statusCode, 401);
    assert.ok(!r.raw.includes(OK_TOKEN), 'expected token MUST NOT appear in body');
    assert.ok(!r.raw.includes(RECEIVED),  'received token MUST NOT appear in body');
  });
});

test('ROUTE-ORDER-B9 · POST /shadow-result routes identically (same middleware ordering)', async () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  await withRunning(async (port) => {
    const noAuth = await requestJson({ port, path: '/api/internal/shipping/shadow-result' });
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.json && noAuth.json.error, 'INVALID_INTERNAL_TOKEN');

    const ok = await requestJson({
      port, path: '/api/internal/shipping/shadow-result',
      headers: { 'Authorization': `Bearer ${OK_TOKEN}` },
      body: JSON.stringify({ listingJobId: 'J', productRef: 'R', marketplace: 'ebay', status: 'ok' }),
    });
    //   Stubbed recorder returns { id, deduped } → route wraps as { ok:true, ... }
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json && ok.json.ok, true);
  });
});
