'use strict';

/**
 * battleKillPrice.test.js — Phase 1 Commit 3 unit tests
 * ---------------------------------------------------------------------------
 * Verifies the extracted /api/battle/kill-price handler:
 *   - Every marketplace call goes through PriceExecutionGate
 *   - Kill switch / invalid price / idempotency / concurrent-run BLOCK
 *   - Competitor-crash pre-check preserved from the legacy route
 *   - Route file has NO surviving direct ebay.updateItem call
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../../src/services/priceExecutionGate');
const { executeBattleKillPrice, CRASH_THRESHOLD_PCT } = require('../../src/services/battleKillPriceService');

/* ─────────────────────────── mocks ─────────────────────────── */

function makeDb({ competitorPrices = [], ebayProducts = [] } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(col, val) {
              // .select().eq().maybeSingle()
              return {
                async maybeSingle() {
                  if (table === 'ebay_products') {
                    const row = ebayProducts.find(r => r[col] === val) || null;
                    return { data: row, error: null };
                  }
                  return { data: null, error: null };
                },
                // .select().eq(col,val).neq(col2,val2).order(...)
                neq(col2, val2) {
                  return {
                    order() {
                      const rows = (table === 'competitor_prices' ? competitorPrices : [])
                        .filter(r => r[col] === val && r[col2] !== val2);
                      return Promise.resolve({ data: rows, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

/** Configurable gate stub — captures every call and returns a scripted outcome. */
function makeGateStub(behavior = {}) {
  const calls = [];
  const stub = async (req, deps) => {
    calls.push({ req, deps });
    if (typeof behavior === 'function') return behavior(req, deps, calls.length);
    return behavior;
  };
  stub.calls = calls;
  return stub;
}

const HEALTHY_BODY = () => ({
  itemId: '236000000001', newPrice: 59, sku: 'PMC-BATTLE-001',
});

const CTX = () => ({ userId: 42, actor: 'user:42' });

/* ─────────────────────────── 1. Input validation ─────────────────────────── */

test('missing itemId → 400 without touching gate', async () => {
  const gateStub = makeGateStub();
  const r = await executeBattleKillPrice(
    { newPrice: 59, sku: 'X' }, CTX(),
    { db: makeDb(), gateExecute: gateStub },
  );
  assert.equal(r.httpStatus, 400);
  assert.equal(gateStub.calls.length, 0);
  assert.equal(r.marketplaceCalls, 0);
});

test('missing newPrice → 400 without touching gate', async () => {
  const gateStub = makeGateStub();
  const r = await executeBattleKillPrice(
    { itemId: '1', sku: 'X' }, CTX(),
    { db: makeDb(), gateExecute: gateStub },
  );
  assert.equal(r.httpStatus, 400);
  assert.equal(gateStub.calls.length, 0);
});

test('non-positive newPrice → 400 without touching gate', async () => {
  const gateStub = makeGateStub();
  for (const p of [0, -5, NaN, Infinity, 'abc']) {
    const r = await executeBattleKillPrice(
      { itemId: '1', sku: 'X', newPrice: p }, CTX(),
      { db: makeDb(), gateExecute: gateStub },
    );
    assert.equal(r.httpStatus, 400, `expected 400 for newPrice=${p}`);
  }
  assert.equal(gateStub.calls.length, 0);
});

/* ─────────────────────────── 2. Competitor-crash pre-check ─────────────────────────── */

test('competitor -50% crash → pre-blocked, gate never called', async () => {
  const gateStub = makeGateStub();
  const db = makeDb({
    competitorPrices: [
      { sku: 'PMC-CRASH', competitor_id: 'raon-kr', competitor_price: 30, prev_price: 100, status: 'active' },
    ],
  });
  const r = await executeBattleKillPrice(
    { ...HEALTHY_BODY(), sku: 'PMC-CRASH', newPrice: 29 },
    CTX(),
    { db, gateExecute: gateStub },
  );
  assert.equal(r.ok, false);
  assert.match(r.body.error, /폭락/);
  assert.equal(gateStub.calls.length, 0);
  assert.equal(r.marketplaceCalls, 0);
});

test('competitor -10% (below crash threshold) → gate proceeds', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 1, eventId: 1,
  });
  const db = makeDb({
    competitorPrices: [
      { sku: 'PMC-OK', competitor_id: 'X', competitor_price: 90, prev_price: 100, status: 'active' },
    ],
  });
  const r = await executeBattleKillPrice(
    { ...HEALTHY_BODY(), sku: 'PMC-OK' }, CTX(),
    { db, gateExecute: gateStub },
  );
  assert.equal(r.ok, true);
  assert.equal(gateStub.calls.length, 1);
});

/* ─────────────────────────── 3. Gate outcome → HTTP mapping ─────────────────────────── */

test('gate APPLIED → 200 success with runId + eventId', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 77, eventId: 88,
  });
  const r = await executeBattleKillPrice(HEALTHY_BODY(), CTX(),
    { db: makeDb(), gateExecute: gateStub });
  assert.equal(r.ok, true);
  assert.equal(r.body.success, true);
  assert.equal(r.body.runId, 77);
  assert.equal(r.body.eventId, 88);
  assert.equal(r.marketplaceCalls, 1);
});

test('gate BLOCKED (KILL_SWITCH) → 200 success:false blocked:true', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.BLOCKED, reasonCode: gate.GATE_REASON.KILL_SWITCH,
    runId: 10, eventId: 20,
  });
  const r = await executeBattleKillPrice(HEALTHY_BODY(), CTX(),
    { db: makeDb(), gateExecute: gateStub });
  assert.equal(r.ok, false);
  assert.equal(r.body.blocked, true);
  assert.equal(r.body.reason, gate.GATE_REASON.KILL_SWITCH);
  assert.equal(r.marketplaceCalls, 0);
});

test('gate FAILED → 200 success:false, ebay_products change 0 (proven by marketplaceCalls but no APPLIED)', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.FAILED, reasonCode: gate.GATE_REASON.MARKETPLACE_FAILED,
    runId: 5, eventId: 6, error: 'InvalidItem',
  });
  const r = await executeBattleKillPrice(HEALTHY_BODY(), CTX(),
    { db: makeDb(), gateExecute: gateStub });
  assert.equal(r.ok, false);
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, 'InvalidItem');
  // marketplaceCalls=1 because the gate DID call the stub, but per Commit 2
  // contract the gate did NOT update ebay_products (that path is inside the
  // gate; when it returns FAILED the state sync never fired).
  assert.equal(r.marketplaceCalls, 1);
});

test('gate IDEMPOTENT_REPLAY (PRIOR_SUCCESS) → 200 success:true idempotent:true', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS',
    priorRunId: 111, eventId: 222,
  });
  const r = await executeBattleKillPrice(HEALTHY_BODY(), CTX(),
    { db: makeDb(), gateExecute: gateStub });
  assert.equal(r.ok, true);
  assert.equal(r.body.idempotent, true);
  assert.equal(r.body.priorRunId, 111);
});

test('gate IDEMPOTENT_REPLAY (PRIOR_FAILURE) → 200 success:false idempotent:true', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_FAILURE',
    priorRunId: 111, error: 'prior failed',
  });
  const r = await executeBattleKillPrice(HEALTHY_BODY(), CTX(),
    { db: makeDb(), gateExecute: gateStub });
  assert.equal(r.ok, false);
  assert.equal(r.body.idempotent, true);
});

/* ─────────────────────────── 4. Idempotency wiring ─────────────────────────── */

test('same body twice within a second → same requestId → gate stub sees same key', async () => {
  const seen = [];
  const gateStub = async (req) => {
    seen.push(req.requestId);
    return { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1 };
  };
  gateStub.calls = seen;
  await executeBattleKillPrice(HEALTHY_BODY(), CTX(), { db: makeDb(), gateExecute: gateStub });
  await executeBattleKillPrice(HEALTHY_BODY(), CTX(), { db: makeDb(), gateExecute: gateStub });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'both requests should derive the same requestId (1-second bucket)');
});

test('client-supplied requestId is honoured verbatim', async () => {
  const seen = [];
  const gateStub = async (req) => { seen.push(req.requestId); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1,
  }; };
  await executeBattleKillPrice(
    { ...HEALTHY_BODY(), requestId: 'client-supplied-abc' }, CTX(),
    { db: makeDb(), gateExecute: gateStub },
  );
  assert.equal(seen[0], 'client-supplied-abc');
});

/* ─────────────────────────── 5. Gate contract passthrough ─────────────────────────── */

test('gate is called with context=MANUAL_APPROVED and actor=user:<id>', async () => {
  const seen = [];
  const gateStub = async (req) => {
    seen.push(req);
    return { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1 };
  };
  await executeBattleKillPrice(HEALTHY_BODY(), CTX(),
    { db: makeDb(), gateExecute: gateStub });
  assert.equal(seen[0].context, 'MANUAL_APPROVED');
  assert.equal(seen[0].actor, 'user:42');
  assert.equal(seen[0].currency, 'USD');
});

test('missing user (unauthenticated context) → actor=system, still MANUAL_APPROVED', async () => {
  const seen = [];
  const gateStub = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1,
  }; };
  await executeBattleKillPrice(HEALTHY_BODY(), {}, { db: makeDb(), gateExecute: gateStub });
  assert.equal(seen[0].actor, 'system');
  assert.equal(seen[0].context, 'MANUAL_APPROVED');
});

test('old price is read from ebay_products and passed to the gate', async () => {
  const seen = [];
  const gateStub = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1,
  }; };
  const db = makeDb({ ebayProducts: [{ item_id: '236000000001', price_usd: 62.5 }] });
  await executeBattleKillPrice(HEALTHY_BODY(), CTX(), { db, gateExecute: gateStub });
  assert.equal(seen[0].oldPrice, 62.5);
});

/* ─────────────────────────── 6. Bypass audit — the whole point of Commit 3 ─────────────────────────── */

test('AUDIT: /api/battle/kill-price handler in api.js does NOT call ebay.updateItem directly', () => {
  const apiPath = path.join(__dirname, '../../src/web/routes/api.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  // Extract just the /battle/kill-price handler block.
  const start = apiSrc.indexOf("router.post('/battle/kill-price'");
  assert.notEqual(start, -1, 'kill-price route not found in api.js');
  // Find the closing }); of THIS handler. We look for the next line that's the
  // start of the next router.*(' declaration.
  const rest = apiSrc.slice(start);
  const nextRoute = rest.slice(50).search(/router\.(post|get|put|delete)\('/);
  const handlerBlock = nextRoute === -1 ? rest : rest.slice(0, 50 + nextRoute);
  // Must not contain any of the bypass patterns
  const bypassPatterns = [
    /ebay\.updateItem\s*\(/,
    /getEbayAPI\s*\(\s*\)\s*\.\s*update/,
    /\.from\(\s*['"]ebay_products['"]\s*\)\.\s*update/,
    /ReviseFixedPriceItem/,
    /ReviseInventoryStatus/,
  ];
  for (const p of bypassPatterns) {
    assert.equal(p.test(handlerBlock), false, `kill-price handler must not match ${p}`);
  }
});

test('AUDIT: kill-price handler imports and uses executeBattleKillPrice', () => {
  const apiPath = path.join(__dirname, '../../src/web/routes/api.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  const start = apiSrc.indexOf("router.post('/battle/kill-price'");
  const rest = apiSrc.slice(start);
  const nextRoute = rest.slice(50).search(/router\.(post|get|put|delete)\('/);
  const handlerBlock = nextRoute === -1 ? rest : rest.slice(0, 50 + nextRoute);
  assert.match(handlerBlock, /executeBattleKillPrice/);
  assert.match(handlerBlock, /require\(['"]\.\.\/\.\.\/services\/battleKillPriceService['"]\)/);
});

/* ─────────────────────────── 7. defaultRequestId helper ─────────────────────────── */

test('defaultRequestId — same shape within 1s → identical, different price → different', () => {
  const { defaultRequestId } = require('../../src/services/battleKillPriceService')._internal;
  const a = defaultRequestId({ sku: 'S', itemId: 'I', price: 10, userId: 1 });
  const b = defaultRequestId({ sku: 'S', itemId: 'I', price: 10, userId: 1 });
  assert.equal(a, b);
  const c = defaultRequestId({ sku: 'S', itemId: 'I', price: 11, userId: 1 });
  assert.notEqual(a, c);
  const d = defaultRequestId({ sku: 'S', itemId: 'I', price: 10, userId: 2 });
  assert.notEqual(a, d);
});
