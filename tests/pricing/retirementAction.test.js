'use strict';

/**
 * retirementAction.test.js — Phase 1 Commit 5D tests
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../../src/services/priceExecutionGate');
const {
  executeRetirementAction,
  _internal,
} = require('../../src/services/retirementActionService');

function makeGateStub(behavior = { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2 }) {
  const calls = [];
  const stub = async (req) => {
    calls.push(req);
    return typeof behavior === 'function' ? behavior(req, calls.length) : behavior;
  };
  stub.calls = calls;
  return stub;
}

const CTX = () => ({ userId: 7, actor: 'user:7', dateStr: '2026-08-10' });

/* ─────────────────────────── 1. Input validation & non-price actions ─────────────────────────── */

test('missing sku → error, no gate call', async () => {
  const g = makeGateStub();
  const r = await executeRetirementAction({ action: 'price_increase_5pct' }, CTX(), { gateExecute: g });
  assert.equal(r.success, false);
  assert.match(r.error, /sku와 action/);
  assert.equal(g.calls.length, 0);
});

test('deactivate action → success flag only, no gate call', async () => {
  const g = makeGateStub();
  const r = await executeRetirementAction({ sku: 'S1', action: 'deactivate' }, CTX(), { gateExecute: g });
  assert.equal(r.success, true);
  assert.match(r.note, /비활성화/);
  assert.equal(g.calls.length, 0);
  assert.equal(r.marketplaceCalls, 0);
});

test('margin_review action → flag only, no gate call', async () => {
  const g = makeGateStub();
  const r = await executeRetirementAction({ sku: 'S1', action: 'margin_review' }, CTX(), { gateExecute: g });
  assert.equal(r.success, true);
  assert.equal(g.calls.length, 0);
});

test('unknown action → error, no gate call', async () => {
  const g = makeGateStub();
  const r = await executeRetirementAction({ sku: 'S1', action: 'unknown_x' }, CTX(), { gateExecute: g });
  assert.equal(r.success, false);
  assert.match(r.error, /unsupported/);
  assert.equal(g.calls.length, 0);
});

/* ─────────────────────────── 2. +5% math preserved ─────────────────────────── */

test('+5% math is exactly currentPrice * 1.05 rounded to 2 decimals', async () => {
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  const r = await executeRetirementAction(
    { sku: 'S1', action: 'price_increase_5pct', currentPrice: 20.00, ebayItemId: 'I1' },
    CTX(), { gateExecute: g },
  );
  assert.equal(r.newPrice, 21.00);
  assert.equal(seen[0].newPrice, 21.00);
});

test('+5% math handles decimals — 19.99 * 1.05 = 20.9895 → 20.99', async () => {
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  await executeRetirementAction(
    { sku: 'S1', action: 'price_increase_5pct', currentPrice: 19.99, ebayItemId: 'I1' },
    CTX(), { gateExecute: g },
  );
  assert.equal(seen[0].newPrice, 20.99);
});

test('currentPrice ≤ 0 → error, no gate call', async () => {
  const g = makeGateStub();
  for (const cp of [0, -1, NaN]) {
    const r = await executeRetirementAction(
      { sku: 'S1', action: 'price_increase_5pct', currentPrice: cp, ebayItemId: 'I1' },
      CTX(), { gateExecute: g },
    );
    assert.equal(r.success, false);
    assert.match(r.error, /현재 가격 정보 없음/);
  }
  assert.equal(g.calls.length, 0);
});

test('missing ebayItemId → error, no gate call', async () => {
  const g = makeGateStub();
  const r = await executeRetirementAction(
    { sku: 'S1', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: null },
    CTX(), { gateExecute: g },
  );
  assert.equal(r.success, false);
  assert.match(r.error, /eBay Item ID 없음/);
  assert.equal(g.calls.length, 0);
});

/* ─────────────────────────── 3. Gate contract ─────────────────────────── */

test('gate called with context=MANUAL_APPROVED, actor=user:<id>, currency=USD', async () => {
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  await executeRetirementAction(
    { sku: 'PMC-RET', action: 'price_increase_5pct', currentPrice: 100, ebayItemId: '236000009999' },
    CTX(), { gateExecute: g },
  );
  assert.equal(seen[0].context, 'MANUAL_APPROVED');
  assert.equal(seen[0].actor, 'user:7');
  assert.equal(seen[0].currency, 'USD');
  assert.equal(seen[0].sku, 'PMC-RET');
  assert.equal(seen[0].itemId, '236000009999');
  assert.equal(seen[0].oldPrice, 100);
  assert.equal(seen[0].newPrice, 105);
});

test('no user → actor=system:retirement', async () => {
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  await executeRetirementAction(
    { sku: 'S', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: 'I' },
    { dateStr: '2026-08-10' }, { gateExecute: g },
  );
  assert.equal(seen[0].actor, 'system:retirement');
});

/* ─────────────────────────── 4. Kill switch / gate outcomes ─────────────────────────── */

test('gate BLOCKED (KILL_SWITCH) → success=false, marketplaceCalls=0, blocked flag', async () => {
  const g = makeGateStub({
    outcome: gate.OUTCOME.BLOCKED, reasonCode: gate.GATE_REASON.KILL_SWITCH,
    runId: 5, eventId: null,
  });
  const r = await executeRetirementAction(
    { sku: 'S', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: 'I' },
    CTX(), { gateExecute: g },
  );
  assert.equal(r.success, false);
  assert.equal(r.blocked, true);
  assert.match(r.error, /blocked by gate/);
  assert.equal(r.marketplaceCalls, 0);
});

test('gate FAILED → success=false, marketplaceCalls=1 (gate attempted eBay)', async () => {
  const g = makeGateStub({
    outcome: gate.OUTCOME.FAILED, reasonCode: gate.GATE_REASON.MARKETPLACE_FAILED,
    runId: 5, eventId: 6, error: 'eBay 500',
  });
  const r = await executeRetirementAction(
    { sku: 'S', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: 'I' },
    CTX(), { gateExecute: g },
  );
  assert.equal(r.success, false);
  assert.equal(r.error, 'eBay 500');
  assert.equal(r.marketplaceCalls, 1);
});

test('gate IDEMPOTENT_REPLAY PRIOR_SUCCESS → success=true idempotent, marketplaceCalls=0', async () => {
  const g = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS',
    priorRunId: 10, eventId: 11,
  });
  const r = await executeRetirementAction(
    { sku: 'S', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: 'I' },
    CTX(), { gateExecute: g },
  );
  assert.equal(r.success, true);
  assert.match(r.note, /idempotent replay/);
  assert.equal(r.marketplaceCalls, 0);
});

test('gate APPLIED → success=true, oldPrice/newPrice/runId/eventId returned', async () => {
  const g = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 77, eventId: 88,
  });
  const r = await executeRetirementAction(
    { sku: 'S', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: 'I' },
    CTX(), { gateExecute: g },
  );
  assert.equal(r.success, true);
  assert.equal(r.oldPrice, 20);
  assert.equal(r.newPrice, 21);
  assert.equal(r.runId, 77);
  assert.equal(r.eventId, 88);
  assert.equal(r.marketplaceCalls, 1);
});

/* ─────────────────────────── 5. Idempotency key ─────────────────────────── */

test('_retirementRequestId is deterministic; different day → different key', () => {
  const a = _internal._retirementRequestId({ sku: 'S', itemId: 'I', newPrice: 21.00, dateStr: '2026-08-10' });
  const b = _internal._retirementRequestId({ sku: 'S', itemId: 'I', newPrice: 21.00, dateStr: '2026-08-10' });
  const c = _internal._retirementRequestId({ sku: 'S', itemId: 'I', newPrice: 21.00, dateStr: '2026-08-11' });
  const d = _internal._retirementRequestId({ sku: 'S', itemId: 'I', newPrice: 22.00, dateStr: '2026-08-10' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.equal(a, 'retirement:price_increase_5pct:2026-08-10:S:I:21.00');
});

test('client-supplied requestId honoured verbatim', async () => {
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  await executeRetirementAction(
    { sku: 'S', action: 'price_increase_5pct', currentPrice: 20, ebayItemId: 'I', requestId: 'client-req-abc' },
    CTX(), { gateExecute: g },
  );
  assert.equal(seen[0].requestId, 'client-req-abc');
});

/* ─────────────────────────── 6. Static bypass audit ─────────────────────────── */

test('AUDIT: route retirement/execute price_increase_5pct branch has NO direct eBay call', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/web/routes/api.js'), 'utf8');
  const start = src.indexOf("router.post('/sku-scores/retirement/execute'");
  assert.notEqual(start, -1);
  const rest = src.slice(start);
  const nextRoute = rest.slice(50).search(/router\.(post|get|put|delete)\('/);
  const handlerBlock = nextRoute === -1 ? rest : rest.slice(0, 50 + nextRoute);
  assert.equal(/ebay\.updateItem\s*\(/.test(handlerBlock), false);
  assert.equal(/getEbayAPI\s*\(\s*\)\s*\.\s*updateItem/.test(handlerBlock), false);
  // Positive: must delegate to the new service
  assert.match(handlerBlock, /executeRetirementAction/);
});

test('AUDIT: retirementActionService uses priceExecutionGate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/retirementActionService.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/priceExecutionGate['"]\)/);
  assert.equal((src.match(/ebay\.updateItem\s*\(/g) || []).length, 0);
});
