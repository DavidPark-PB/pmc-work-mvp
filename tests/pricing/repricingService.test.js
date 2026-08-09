'use strict';

/**
 * repricingService.test.js — Phase 1 Commit 6 tests
 * ---------------------------------------------------------------------------
 * Verifies that RepricingService.executeRepricing now routes every
 * marketplace mutation through PriceExecutionGate, without changing the
 * legacy evaluation logic or the route's response contract.
 *
 * All I/O is stubbed. evaluation is injected so evaluateRepricing() stays
 * untested here — its calculation is preserved bit-for-bit and covered by
 * the priceEngine characterization tests (Commit 1).
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../../src/services/priceExecutionGate');
const RepricingService = require('../../src/services/repricingService');
const { _internal } = RepricingService;

/* ─────────────────────────── mocks ─────────────────────────── */

function makeDb({ productsRows = [], productsUpdateError = null } = {}) {
  const productsUpdates = [];
  return {
    productsUpdates,
    from(table) {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                single: async () => {
                  if (table === 'products') {
                    const row = productsRows.find(r => r[col] === val) || null;
                    return { data: row, error: row ? null : { message: 'no row' } };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
        update(patch) {
          return {
            eq(col, val) {
              if (table === 'products') {
                productsUpdates.push({ col, val, patch });
                return Promise.resolve({ error: productsUpdateError });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
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

/** stub for platformRepository.logPriceChange — captures calls. */
function stubRepoLogPriceChange(svc) {
  const logCalls = [];
  const origGetRepo = svc._getPlatformRepo.bind(svc);
  svc._getPlatformRepo = () => ({
    ...origGetRepo(),
    logPriceChange: async (...args) => { logCalls.push(args); },
    getExportStatus: async () => ({ platform_item_id: 'ITEM-STUB' }),
  });
  return logCalls;
}

const HEALTHY_EVAL = () => ({
  action: 'decrease',
  currentPrice: 20,
  recommendedPrice: 18,
  competitorTotal: 19,
  floorPrice: 15,
  strategy: 'undercut',
  rule: { id: 1, sku: 'PMC-R', strategy: 'undercut' },
});

const NOW = () => new Date('2026-08-10T14:00:00Z');
const OPTS = (extra = {}) => ({
  evaluation: HEALTHY_EVAL(),
  actor: 'user:9',
  deps: { now: NOW, itemId: '236000000009', platformObj: { id: 1 }, ...extra.deps },
  ...extra,
});

/* ─────────────────────────── 1. Short-circuit paths (no gate call) ─────────────────────────── */

test('evaluation.action=no_change → executed:false, no gate call', async () => {
  const svc = new RepricingService();
  const g = makeGateStub();
  const r = await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: { action: 'no_change', currentPrice: 20, recommendedPrice: 20 },
    deps: { gateExecute: g, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(r.executed, false);
  assert.equal(r.action, 'no_change');
  assert.equal(g.calls.length, 0);
});

test('evaluation.action=no_competitor_data → executed:false, no gate call', async () => {
  const svc = new RepricingService();
  const g = makeGateStub();
  const r = await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: { action: 'no_competitor_data', currentPrice: 20 },
    deps: { gateExecute: g, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(r.executed, false);
  assert.equal(g.calls.length, 0);
});

test('evaluation.action=no_rules → executed:false, no gate call', async () => {
  const svc = new RepricingService();
  const g = makeGateStub();
  const r = await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: { action: 'no_rules', currentPrice: 20 },
    deps: { gateExecute: g, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(r.executed, false);
  assert.equal(g.calls.length, 0);
});

test('null evaluation (product not found) → executed:false, no gate call', async () => {
  const svc = new RepricingService();
  const g = makeGateStub();
  const r = await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: null,
    deps: { gateExecute: g, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(r.executed, false);
  assert.equal(g.calls.length, 0);
});

test('platform!=ebay → refused this phase, no gate call', async () => {
  const svc = new RepricingService();
  const g = makeGateStub();
  const r = await svc.executeRepricing('PMC-R', 'shopify', {
    evaluation: HEALTHY_EVAL(),
    deps: { gateExecute: g, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(r.executed, false);
  assert.match(r.error, /gate shopify 지원 안 함/);
  assert.equal(g.calls.length, 0);
});

/* ─────────────────────────── 2. Gate contract ─────────────────────────── */

test('gate called with context=MANUAL_APPROVED, actor propagated, currency=USD', async () => {
  const svc = new RepricingService();
  stubRepoLogPriceChange(svc);
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  const db = makeDb({ productsRows: [{ sku: 'PMC-R', id: 1 }] });
  await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: '236000000009', platformObj: { id: 1 } } }));
  assert.equal(seen[0].context, 'MANUAL_APPROVED');
  assert.equal(seen[0].actor, 'user:9');
  assert.equal(seen[0].currency, 'USD');
  assert.equal(seen[0].sku, 'PMC-R');
  assert.equal(seen[0].itemId, '236000000009');
  assert.equal(seen[0].oldPrice, 20);
  assert.equal(seen[0].newPrice, 18);
});

test('no actor → defaults to system:repricing', async () => {
  const svc = new RepricingService();
  stubRepoLogPriceChange(svc);
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  const db = makeDb({ productsRows: [{ sku: 'PMC-R', id: 1 }] });
  await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: HEALTHY_EVAL(),
    deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(seen[0].actor, 'system:repricing');
});

/* ─────────────────────────── 3. Gate outcomes ─────────────────────────── */

test('gate BLOCKED (KILL_SWITCH) → executed:false blocked:true, products NOT updated, log NOT written', async () => {
  const svc = new RepricingService();
  const logCalls = stubRepoLogPriceChange(svc);
  const g = makeGateStub({
    outcome: gate.OUTCOME.BLOCKED, reasonCode: gate.GATE_REASON.KILL_SWITCH,
    runId: 5, eventId: null,
  });
  const db = makeDb();
  const r = await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } } }));
  assert.equal(r.executed, false);
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, gate.GATE_REASON.KILL_SWITCH);
  assert.equal(r.marketplaceCalls, 0);
  assert.equal(db.productsUpdates.length, 0);
  assert.equal(logCalls.length, 0);
});

test('gate FAILED → executed:false, products NOT updated, log NOT written', async () => {
  const svc = new RepricingService();
  const logCalls = stubRepoLogPriceChange(svc);
  const g = makeGateStub({
    outcome: gate.OUTCOME.FAILED, reasonCode: gate.GATE_REASON.MARKETPLACE_FAILED,
    runId: 5, eventId: 6, error: 'eBay 500',
  });
  const db = makeDb();
  const r = await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } } }));
  assert.equal(r.executed, false);
  assert.equal(r.error, 'eBay 500');
  assert.equal(r.marketplaceCalls, 1);   // gate attempted
  assert.equal(db.productsUpdates.length, 0);
  assert.equal(logCalls.length, 0);
});

test('gate APPLIED → executed:true, products.price_usd synced, price_change_log written', async () => {
  const svc = new RepricingService();
  const logCalls = stubRepoLogPriceChange(svc);
  const g = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 77, eventId: 88,
  });
  const db = makeDb();
  const r = await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } } }));
  assert.equal(r.executed, true);
  assert.equal(r.newPrice, 18);
  assert.equal(r.gateRunId, 77);
  assert.equal(r.gateEventId, 88);
  assert.equal(r.marketplaceCalls, 1);
  // Legacy mirror sync happened AFTER gate success
  assert.equal(db.productsUpdates.length, 1);
  assert.equal(db.productsUpdates[0].patch.price_usd, 18);
  assert.equal(db.productsUpdates[0].col, 'sku');
  assert.equal(db.productsUpdates[0].val, 'PMC-R');
  assert.equal(r.legacyPriceSync, true);
  // Legacy price_change_log written
  assert.equal(logCalls.length, 1);
  assert.deepEqual(logCalls[0].slice(0, 4), ['PMC-R', 'ebay', 20, 18]);
  assert.equal(r.legacyLogWrote, true);
});

test('gate APPLIED but legacy products.update fails → still executed:true, legacyPriceSync=false', async () => {
  const svc = new RepricingService();
  stubRepoLogPriceChange(svc);
  const g = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  });
  const db = makeDb({ productsUpdateError: { message: 'connection reset' } });
  const r = await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } } }));
  assert.equal(r.executed, true);
  assert.equal(r.legacyPriceSync, false);
});

test('gate IDEMPOTENT_REPLAY PRIOR_SUCCESS → executed:true idempotent, no products update, no log write', async () => {
  const svc = new RepricingService();
  const logCalls = stubRepoLogPriceChange(svc);
  const g = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS',
    priorRunId: 10, eventId: 11,
  });
  const db = makeDb();
  const r = await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } } }));
  assert.equal(r.executed, true);
  assert.equal(r.idempotent, true);
  assert.equal(r.priorReason, 'PRIOR_SUCCESS');
  assert.equal(r.marketplaceCalls, 0);
  // Prior run already synced legacy tables when it originally succeeded; don't re-fire
  assert.equal(db.productsUpdates.length, 0);
  assert.equal(logCalls.length, 0);
});

test('gate IDEMPOTENT_REPLAY PRIOR_FAILURE → executed:false idempotent, no legacy sync', async () => {
  const svc = new RepricingService();
  const logCalls = stubRepoLogPriceChange(svc);
  const g = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_FAILURE',
    priorRunId: 10, eventId: 11,
  });
  const db = makeDb();
  const r = await svc.executeRepricing('PMC-R', 'ebay', OPTS({ deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } } }));
  assert.equal(r.executed, false);
  assert.equal(r.idempotent, true);
  assert.equal(db.productsUpdates.length, 0);
  assert.equal(logCalls.length, 0);
});

/* ─────────────────────────── 4. Idempotency key ─────────────────────────── */

test('_repricingRequestId — deterministic same-hour/same-price → same key', () => {
  const a = _internal._repricingRequestId({ sku: 'S', itemId: 'I', platform: 'ebay', price: 18, hourBucket: '2026-08-10T14' });
  const b = _internal._repricingRequestId({ sku: 'S', itemId: 'I', platform: 'ebay', price: 18, hourBucket: '2026-08-10T14' });
  assert.equal(a, b);
  assert.equal(a, 'repricing:manual:S:I:ebay:2026-08-10T14:18.00');
});

test('_repricingRequestId — different hour → different key (user can re-approve later)', () => {
  const a = _internal._repricingRequestId({ sku: 'S', itemId: 'I', platform: 'ebay', price: 18, hourBucket: '2026-08-10T14' });
  const c = _internal._repricingRequestId({ sku: 'S', itemId: 'I', platform: 'ebay', price: 18, hourBucket: '2026-08-10T15' });
  assert.notEqual(a, c);
});

test('_repricingRequestId — different price (re-evaluation) → different key', () => {
  const a = _internal._repricingRequestId({ sku: 'S', itemId: 'I', platform: 'ebay', price: 18, hourBucket: '2026-08-10T14' });
  const d = _internal._repricingRequestId({ sku: 'S', itemId: 'I', platform: 'ebay', price: 17, hourBucket: '2026-08-10T14' });
  assert.notEqual(a, d);
});

test('opts.requestId overrides the derived key', async () => {
  const svc = new RepricingService();
  stubRepoLogPriceChange(svc);
  const seen = [];
  const g = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2,
  }; };
  const db = makeDb();
  await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: HEALTHY_EVAL(),
    actor: 'user:9',
    requestId: 'client-supplied-xyz',
    deps: { gateExecute: g, db, now: NOW, itemId: 'I', platformObj: { id: 1 } },
  });
  assert.equal(seen[0].requestId, 'client-supplied-xyz');
});

/* ─────────────────────────── 5. Item ID resolution failure ─────────────────────────── */

test('deps.itemId missing AND no exportStatus → executed:false, no gate call', async () => {
  const svc = new RepricingService();
  // stubRepo returns no itemId
  const origGetRepo = svc._getPlatformRepo.bind(svc);
  svc._getPlatformRepo = () => ({
    ...origGetRepo(),
    getExportStatus: async () => null,
    logPriceChange: async () => {},
  });
  const g = makeGateStub();
  const db = makeDb({ productsRows: [{ sku: 'PMC-R', id: 1 }] });
  const r = await svc.executeRepricing('PMC-R', 'ebay', {
    evaluation: HEALTHY_EVAL(),
    deps: { gateExecute: g, db, now: NOW, platformObj: { id: 1 } },  // no itemId
  });
  assert.equal(r.executed, false);
  assert.match(r.error, /No platform item ID/);
  assert.equal(g.calls.length, 0);
});

/* ─────────────────────────── 6. Static bypass audit ─────────────────────────── */

test('AUDIT: repricingService.js has no api.updatePrice / ebay.updateItem / Revise call', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/repricingService.js'), 'utf8');
  assert.equal((src.match(/api\.updatePrice\s*\(/g) || []).length, 0);
  assert.equal((src.match(/ebay\.updateItem\s*\(/g) || []).length, 0);
  assert.equal((src.match(/ReviseFixedPriceItem/g) || []).length, 0);
  assert.equal((src.match(/ReviseItem\b/g) || []).length, 0);
});

test('AUDIT: repricingService requires priceExecutionGate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/repricingService.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/priceExecutionGate['"]\)/);
});

test('AUDIT: route /api/repricing/execute/:sku passes actor to service', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/web/routes/api.js'), 'utf8');
  const start = src.indexOf("router.post('/repricing/execute/:sku'");
  assert.notEqual(start, -1);
  const rest = src.slice(start);
  const nextRoute = rest.slice(50).search(/router\.(post|get|put|delete)\('/);
  const block = nextRoute === -1 ? rest : rest.slice(0, 50 + nextRoute);
  assert.match(block, /executeRepricing\(/);
  assert.match(block, /actor:/);
});
