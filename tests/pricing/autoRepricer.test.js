'use strict';

/**
 * autoRepricer.test.js — Phase 1 Commit 5A tests
 * ---------------------------------------------------------------------------
 * Two concerns:
 *   1. forced dryRun still holds (real-mode inputs are silently rerouted)
 *   2. When the code path IS live (hypothetical / test-only), gate is called
 *      with context=AUTO and the deterministic requestId — no direct
 *      ebay.updateItem call survives.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../../src/services/priceExecutionGate');
const { runAutoRepricer, _internal } = require('../../src/services/autoRepricer');

/* ─────────────────────────── mocks ─────────────────────────── */

function makeDb({ competitorPrices = [], sellerTiers = [], repricerLogInserts = [] } = {}) {
  return {
    repricerLogInserts,
    from(table) {
      return {
        select(cols, opts) {
          if (opts && opts.count === 'exact') {
            return {
              eq() { return { gte: async () => ({ count: 0, error: null }) }; },
            };
          }
          return {
            neq() {
              return {
                not() {
                  return {
                    eq() {
                      return {
                        gt() {
                          return {
                            range: async () => ({ data: table === 'competitor_prices' ? competitorPrices : [], error: null }),
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
            // used by target_sellers
            async then(resolve) { resolve({ data: table === 'target_sellers' ? sellerTiers : [], error: null }); },
          };
        },
        insert(row) {
          repricerLogInserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function makeEbay({ myListings = [], updateResponse = { success: true }, updateThrow = null } = {}) {
  const updateCalls = [];
  return {
    updateCalls,
    async getActiveListings(page /* , limit */) {
      if (page > 1) return { items: [], hasMore: false };
      return { items: myListings, hasMore: false };
    },
    async updateItem(itemId, opts) {
      updateCalls.push({ itemId, opts });
      if (updateThrow) throw updateThrow;
      return updateResponse;
    },
  };
}

function makeGateStub(behavior = { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2 }) {
  const calls = [];
  const stub = async (req) => {
    calls.push(req);
    return typeof behavior === 'function' ? behavior(req, calls.length) : behavior;
  };
  stub.calls = calls;
  return stub;
}

/* ─────────────────────────── 1. forced dryRun invariant ─────────────────────────── */

test('runAutoRepricer(true) — dryRun does not touch ebay OR gate', async () => {
  const ebay = makeEbay({
    myListings: [{ itemId: 'I1', sku: 'S1', title: 't', price: 60 }],
  });
  const gateStub = makeGateStub();
  const db = makeDb({
    // compTotal 55 vs myTotal 63.9 → losing 9$. kill=49.10, drop 18% (<30 cap), floor 36 (<49.10). Safe → change staged.
    competitorPrices: [{ sku: 'S1', competitor_id: 'X', competitor_price: 50, competitor_shipping: 5, prev_price: 51, seller_id: 'raon-kr', status: 'active' }],
  });
  const r = await runAutoRepricer(true, { db, ebay, gateExecute: gateStub });
  assert.equal(r.mode, 'dry_run');
  assert.equal(ebay.updateCalls.length, 0);
  assert.equal(gateStub.calls.length, 0);
  // Change was staged as dry_run
  const staged = r.changes.filter(c => c.status === 'dry_run');
  assert.ok(staged.length >= 1);
});

test('runAutoRepricer(false) — forced dryRun rewrites to dryRun=true, still 0 marketplace calls', async () => {
  const ebay = makeEbay({
    myListings: [{ itemId: 'I1', sku: 'S1', title: 't', price: 60 }],
  });
  const gateStub = makeGateStub();
  const db = makeDb({
    // compTotal 55 vs myTotal 63.9 → losing 9$. kill=49.10, drop 18% (<30 cap), floor 36 (<49.10). Safe → change staged.
    competitorPrices: [{ sku: 'S1', competitor_id: 'X', competitor_price: 50, competitor_shipping: 5, prev_price: 51, seller_id: 'raon-kr', status: 'active' }],
  });
  const r = await runAutoRepricer(false, { db, ebay, gateExecute: gateStub });
  // forced dryRun re-mapping
  assert.equal(r.mode, 'dry_run');
  assert.equal(ebay.updateCalls.length, 0);
  assert.equal(gateStub.calls.length, 0);
});

/* ─────────────────────────── 2. Live path (unit-level, bypasses the forced-dryRun guard) ─────────────────────────── */
// The forced-dryRun guard rewrites dryRun=false into true at the top of
// runAutoRepricer(). To exercise the gate wiring without ripping that guard
// out, these tests call _applyViaGate directly with hand-built inputs.

test('_applyViaGate → gate called with context=AUTO, actor=system:autoRepricer', async () => {
  const gateStub = makeGateStub();
  const outcome = await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 59,
    direction: 'kill', reason: 'vs raon-kr', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  assert.equal(outcome.outcome, gate.OUTCOME.APPLIED);
  assert.equal(gateStub.calls.length, 1);
  const req = gateStub.calls[0];
  assert.equal(req.context, 'AUTO');
  assert.equal(req.actor, 'system:autoRepricer');
  assert.equal(req.currency, 'USD');
  assert.equal(req.sku, 'S1');
  assert.equal(req.itemId, 'I1');
  assert.equal(req.newPrice, 59);
});

test('_applyViaGate — requestId is deterministic same-day / different-price', async () => {
  const gateStub = makeGateStub();
  await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 59,
    direction: 'kill', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 59,
    direction: 'kill', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 58,  // price differs
    direction: 'kill', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 59,
    direction: 'kill', reason: 'r', dateStr: '2026-08-11',  // day differs
    deps: { gateExecute: gateStub },
  });
  assert.equal(gateStub.calls[0].requestId, gateStub.calls[1].requestId, 'same input → same key');
  assert.notEqual(gateStub.calls[0].requestId, gateStub.calls[2].requestId, 'different price → different key');
  assert.notEqual(gateStub.calls[0].requestId, gateStub.calls[3].requestId, 'different day → different key');
});

test('_applyViaGate — different direction → different requestId', async () => {
  const gateStub = makeGateStub();
  await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 60, newPrice: 65,
    direction: 'raise', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 65,
    direction: 'kill', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  assert.notEqual(gateStub.calls[0].requestId, gateStub.calls[1].requestId);
});

test('_applyViaGate on gate BLOCKED (KILL_SWITCH) propagates the outcome (no ebay call in the stub layer)', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.BLOCKED, reasonCode: gate.GATE_REASON.KILL_SWITCH,
    runId: 5, eventId: null,
  });
  const outcome = await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 59,
    direction: 'kill', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  assert.equal(outcome.outcome, gate.OUTCOME.BLOCKED);
  assert.equal(outcome.reasonCode, gate.GATE_REASON.KILL_SWITCH);
  assert.equal(_internal._statusFromGate(outcome), 'blocked');
});

test('_applyViaGate on gate FAILED → _statusFromGate returns "failed"', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.FAILED, reasonCode: gate.GATE_REASON.MARKETPLACE_FAILED,
    runId: 5, eventId: 6, error: 'eBay 500',
  });
  const outcome = await _internal._applyViaGate({
    sku: 'S1', itemId: 'I1', oldPrice: 80, newPrice: 59,
    direction: 'kill', reason: 'r', dateStr: '2026-08-10',
    deps: { gateExecute: gateStub },
  });
  assert.equal(_internal._statusFromGate(outcome), 'failed');
});

test('_applyViaGate on IDEMPOTENT_REPLAY → status "applied_replay" or "failed_replay"', async () => {
  const g1 = makeGateStub({ outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS' });
  const g2 = makeGateStub({ outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_FAILURE' });
  const r1 = await _internal._applyViaGate({ sku: 'S', itemId: 'I', newPrice: 1, direction: 'kill', dateStr: 'd', deps: { gateExecute: g1 } });
  const r2 = await _internal._applyViaGate({ sku: 'S', itemId: 'I', newPrice: 1, direction: 'kill', dateStr: 'd', deps: { gateExecute: g2 } });
  assert.equal(_internal._statusFromGate(r1), 'applied_replay');
  assert.equal(_internal._statusFromGate(r2), 'failed_replay');
});

/* ─────────────────────────── 3. Bypass audit ─────────────────────────── */

test('AUDIT: autoRepricer.js has no surviving ebay.updateItem call in mutation branches', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/autoRepricer.js'), 'utf8');
  // ebay.updateItem must not appear at all after the refactor. It appears only
  // inside comments/tests-of-the-past; grep everywhere except pure comment
  // lines and helper docs is not needed — we simply require zero matches
  // anywhere in the module source.
  const matches = [...src.matchAll(/ebay\.updateItem\s*\(/g)];
  assert.equal(matches.length, 0, `expected 0 ebay.updateItem calls, found ${matches.length}`);
});

test('AUDIT: autoRepricer requires priceExecutionGate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/autoRepricer.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/priceExecutionGate['"]\)/);
});

test('AUDIT: forced dryRun protection still present', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/autoRepricer.js'), 'utf8');
  // The block that rewrites dryRun=false → true must survive this commit.
  assert.match(src, /LIVE 요청 차단/);
  assert.match(src, /dryRun\s*=\s*true;/);
});

/* ─────────────────────────── 4. Helper unit ─────────────────────────── */

test('_autoRepricerRequestId format is stable and includes all components', () => {
  const k = _internal._autoRepricerRequestId({
    sku: 'PMC-X', itemId: '123', direction: 'kill', newPrice: 59.5, dateStr: '2026-08-10',
  });
  assert.equal(k, 'autoRepricer:2026-08-10:kill:PMC-X:123:59.50');
});

test('_autoRepricerRequestId — missing sku → "nosku"', () => {
  const k = _internal._autoRepricerRequestId({
    sku: null, itemId: '123', direction: 'raise', newPrice: 60, dateStr: '2026-08-10',
  });
  assert.equal(k, 'autoRepricer:2026-08-10:raise:nosku:123:60.00');
});
