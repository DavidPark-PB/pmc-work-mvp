'use strict';

/**
 * tests/scheduler/repricingLease.test.js — Refactor R1-B.
 *
 * Verifies that runRepricingPipeline is fenced by the R1-A distributed
 * lease and that ownership is re-checked immediately before every
 * ebay.updateItem call inside priceExecutionGate.
 *
 * Zero real I/O:
 *   · scheduler_leases     · in-memory MockLeaseStore (mirrors migration 108)
 *   · Supabase queries     · in-memory Supabase-shaped mock (from gate test)
 *   · eBay Trading API     · in-memory stub · counted per test
 *   · autoRepricer         · either fake (for wrapper tests) or full
 *                            (for cooperative-stop tests) · never talks to prod
 *
 * Owner rules (R1-B, 2026-09-05):
 *   TEST A · lease acquired · pipeline executes
 *   TEST B · SKIP_LOCKED    · pipeline not executed
 *   TEST C · acquire infra error + closed · fail closed · pipeline skipped
 *   TEST D · same-process second invocation · only first runs
 *   TEST E · autoRepricer verifier false      · remaining loop stops
 *   TEST F · autoRepricer verifier throws     · remaining loop stops
 *   TEST G · gate ownership verify TRUE       · ebay.updateItem called exactly once
 *   TEST H · gate ownership verify FALSE      · ebay.updateItem called ZERO
 *   TEST I · gate ownership verifier throws   · ebay.updateItem called ZERO
 *   TEST J · verify ordering · verifier resolves BEFORE ebay.updateItem
 *   TEST K · gate other caller · no ownershipVerifier · existing behavior unchanged
 *   TEST L · job throws · lease release attempted
 *   TEST M · DRY_RUN · dryrun mode · no gate call · no eBay update
 *   TEST N · kill_switch=true · gate blocks · ebay.updateItem ZERO (regression)
 *   TEST O · return-shape backward compat · skipped result carries alerts=0 etc
 *   TEST P · stale A after B takeover · A gate write BLOCKED · B path unaffected
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const schedulerLock = require('../../src/services/schedulerLock');
const gate          = require('../../src/services/priceExecutionGate');

// ═══════════════════════════════════════════════════════════════════════════
// MockLeaseStore · exact contract mirror of migration 108 RPCs
// (copied inline · this test must be independent of schedulerLock.test.js).
// ═══════════════════════════════════════════════════════════════════════════
class MockLeaseStore {
  constructor() {
    this.rows = new Map();
    this._nowMs = Date.now();
    this._forceAcquireError = null;
  }
  advance(ms) { this._nowMs += ms; }
  forceAcquireError(e) { this._forceAcquireError = e; }
  rpc(name, params) {
    if (name === 'acquire_scheduler_lease')   return this._acquire(params);
    if (name === 'heartbeat_scheduler_lease') return this._heartbeat(params);
    if (name === 'release_scheduler_lease')   return this._release(params);
    return Promise.resolve({ data: null, error: new Error(`unknown rpc: ${name}`) });
  }
  async _acquire(p) {
    if (this._forceAcquireError) return { data: null, error: this._forceAcquireError };
    const nowMs = this._nowMs;
    const nowIso = new Date(nowMs).toISOString();
    const newExpiresIso = new Date(nowMs + p.p_ttl_seconds * 1000).toISOString();
    const existing = this.rows.get(p.p_lock_key);
    if (!existing) {
      this.rows.set(p.p_lock_key, {
        owner_id: p.p_owner_id, run_id: p.p_run_id,
        acquired_at: nowIso, expires_at: newExpiresIso, heartbeat_at: nowIso,
      });
      return { data: [{ acquired: true, current_owner_id: p.p_owner_id, current_run_id: p.p_run_id, expires_at: newExpiresIso }], error: null };
    }
    const expiresMs = Date.parse(existing.expires_at);
    const isExpired = expiresMs <= nowMs;
    const isSameRun = existing.owner_id === p.p_owner_id && existing.run_id === p.p_run_id;
    if (isExpired || isSameRun) {
      this.rows.set(p.p_lock_key, {
        owner_id: p.p_owner_id, run_id: p.p_run_id,
        acquired_at: nowIso, expires_at: newExpiresIso, heartbeat_at: nowIso,
      });
      return { data: [{ acquired: true, current_owner_id: p.p_owner_id, current_run_id: p.p_run_id, expires_at: newExpiresIso }], error: null };
    }
    return { data: [{ acquired: false, current_owner_id: existing.owner_id, current_run_id: existing.run_id, expires_at: existing.expires_at }], error: null };
  }
  async _heartbeat(p) {
    const nowMs = this._nowMs;
    const row = this.rows.get(p.p_lock_key);
    if (!row) return { data: [{ ok: false, expires_at: null }], error: null };
    const expiresMs = Date.parse(row.expires_at);
    const ownershipOk = row.owner_id === p.p_owner_id && row.run_id === p.p_run_id;
    const alive = expiresMs > nowMs;
    if (ownershipOk && alive) {
      const nowIso = new Date(nowMs).toISOString();
      const newExpiresIso = new Date(nowMs + p.p_ttl_seconds * 1000).toISOString();
      row.heartbeat_at = nowIso;
      row.expires_at = newExpiresIso;
      return { data: [{ ok: true, expires_at: newExpiresIso }], error: null };
    }
    return { data: [{ ok: false, expires_at: row.expires_at }], error: null };
  }
  async _release(p) {
    const row = this.rows.get(p.p_lock_key);
    if (!row) return { data: false, error: null };
    if (row.owner_id === p.p_owner_id && row.run_id === p.p_run_id) {
      this.rows.delete(p.p_lock_key);
      return { data: true, error: null };
    }
    return { data: false, error: null };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Supabase-shaped mock for priceExecutionGate (extracted from gate tests).
// Only the surface the gate actually uses.
// ═══════════════════════════════════════════════════════════════════════════
function makeGateDbMocks({
  guardrails = { kill_switch: false, auto_apply_enabled: true },
  ebayResponse = { success: true },
  ebayThrow = null,
} = {}) {
  const automationRuns = [];
  const priceEvents    = [];
  const ebayProductsUpdates = [];
  const ebayCalls      = [];
  let nextRunId  = 1;
  let nextEventId = 1;

  const db = {
    from(table) {
      return {
        insert(row) {
          if (table === 'automation_runs') {
            if (row.request_id && automationRuns.some(r => r.request_id === row.request_id)) {
              return {
                select: () => ({
                  single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }),
                }),
              };
            }
            const newRow = { id: nextRunId++, status: 'pending', ...row };
            automationRuns.push(newRow);
            return {
              select: () => ({
                single: async () => ({ data: { id: newRow.id }, error: null }),
              }),
            };
          }
          return { select: () => ({ single: async () => ({ data: null, error: new Error('unexpected insert') }) }) };
        },
        update(patch) {
          return {
            eq: async (col, val) => {
              if (table === 'automation_runs') {
                const r = automationRuns.find(x => x[col] === val);
                if (r) Object.assign(r, patch);
                return { error: null };
              }
              if (table === 'ebay_products') {
                ebayProductsUpdates.push({ [col]: val, patch });
                return { error: null };
              }
              return { error: null };
            },
          };
        },
        select() {
          return {
            eq: (col, val) => ({
              maybeSingle: async () => {
                if (table === 'automation_runs') {
                  const r = automationRuns.find(x => x[col] === val);
                  return { data: r || null, error: null };
                }
                return { data: null, error: null };
              },
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => {
                    if (table === 'automation_runs') {
                      const rows = automationRuns.filter(x => x[col] === val);
                      return { data: rows[rows.length - 1] || null, error: null };
                    }
                    return { data: null, error: null };
                  },
                }),
              }),
            }),
          };
        },
      };
    },
  };

  const ebay = {
    async updateItem(itemId, opts) {
      ebayCalls.push({ itemId, ...opts, calledAt: Date.now() });
      if (ebayThrow) throw ebayThrow;
      return ebayResponse;
    },
  };

  const publishPriceEvent = async (payload) => {
    const id = nextEventId++;
    priceEvents.push({ id, ...payload });
    return id;
  };

  const getGuardrails = async () => guardrails;

  return { db, ebay, publishPriceEvent, getGuardrails, ebayCalls, priceEvents, automationRuns, ebayProductsUpdates };
}

// ═══════════════════════════════════════════════════════════════════════════
// Common gate request template
// ═══════════════════════════════════════════════════════════════════════════
function makeGateReq(overrides = {}) {
  return {
    sku: 'SKU-R1B-TEST',
    itemId: '123456789',
    oldPrice: 20.00,
    newPrice: 19.99,
    reasonCode: 'AUTO_UNDERCUT_SAFE',
    requestId: `r1b-test:${Math.random().toString(36).slice(2)}`,
    context: 'AUTO',
    actor: 'system:test',
    currency: 'USD',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Lease harness helper
// ═══════════════════════════════════════════════════════════════════════════
function withLeaseStore(fn) {
  return async () => {
    const store = new MockLeaseStore();
    schedulerLock._setClientForTests(store);
    try { await fn(store); }
    finally { schedulerLock._resetClientForTests(); }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

// -------------------- LAYER 1 · pipeline wrapper --------------------

test('TEST A · lease acquired · pipeline executes', withLeaseStore(async (store) => {
  // Reload pipeline with a mocked _runPipelineInner (via require.cache) is
  // heavy · instead we just invoke withLease with the same lock key and
  // assert the acquire path opens · verifies primitive-to-pipeline binding.
  const KEY = 'scheduler:repricing-pipeline';
  let ran = false;
  const r = await schedulerLock.withLease(KEY,
    { ttlSec: 60, heartbeatSec: 10, failPolicy: 'closed' },
    async () => { ran = true; return { alerts: 0, changed: 0 }; });
  assert.equal(ran, true);
  assert.equal(r.acquired, true);
  assert.equal(r.value.changed, 0);
}));

test('TEST B · SKIP_LOCKED · pipeline not executed', withLeaseStore(async (store) => {
  const KEY = 'scheduler:repricing-pipeline';
  // pre-hold the lease with another owner
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: KEY, p_owner_id: 'other-proc', p_run_id: 'other-run', p_ttl_seconds: 300 });
  let ran = false;
  const r = await schedulerLock.withLease(KEY,
    { ttlSec: 60, heartbeatSec: 10, failPolicy: 'closed' },
    async () => { ran = true; });
  assert.equal(ran, false, 'pipeline must not run when another holder is alive');
  assert.equal(r.acquired, false);
  assert.equal(r.ran, false);
}));

test('TEST C · acquire infra error + failPolicy=closed · pipeline skipped', withLeaseStore(async (store) => {
  store.forceAcquireError(new Error('supabase down'));
  let ran = false;
  const r = await schedulerLock.withLease('scheduler:repricing-pipeline',
    { ttlSec: 60, heartbeatSec: 10, failPolicy: 'closed' },
    async () => { ran = true; });
  assert.equal(ran, false, 'money-facing: fn must not run on infra error');
  assert.equal(r.ran, false);
  assert.ok(r.error);
}));

test('TEST D · same-process second invocation · only first runs', withLeaseStore(async (store) => {
  const KEY = 'scheduler:repricing-pipeline';
  // Start two concurrent withLease calls · same lockKey · same owner_id
  // (schedulerLock generates fresh run_ids per call, so the second must be
  // rejected).
  let firstStarted = false;
  let firstResolve;
  const firstDone = new Promise(res => { firstResolve = res; });
  const first = schedulerLock.withLease(KEY,
    { ttlSec: 60, heartbeatSec: 10, failPolicy: 'closed' },
    async () => { firstStarted = true; await firstDone; return 'first-value'; });
  // brief settle for first to acquire
  await new Promise(r => setImmediate(r));
  let secondRan = false;
  const secondPromise = schedulerLock.withLease(KEY,
    { ttlSec: 60, heartbeatSec: 10, failPolicy: 'closed' },
    async () => { secondRan = true; });
  const second = await secondPromise;
  assert.equal(secondRan, false, 'second invocation must SKIP · same process overlap');
  assert.equal(second.acquired, false);
  // let first finish
  firstResolve();
  const firstResult = await first;
  assert.equal(firstStarted, true);
  assert.equal(firstResult.value, 'first-value');
}));

// -------------------- LAYER 2 · autoRepricer cooperative stop --------------------
//   These tests run the real runAutoRepricer against an in-memory Supabase
//   mock so the per-SKU loop actually iterates and honours deps.ownershipVerifier.

function makeAutoRepricerDbMock({ competitors = [], myListings = [] } = {}) {
  return {
    from(table) {
      return {
        select() {
          const chain = {
            neq: () => chain,
            not: () => chain,
            eq: () => chain,
            gt: () => chain,
            gte: () => chain,
            range: async () => {
              if (table === 'competitor_prices') return { data: competitors, error: null };
              return { data: [], error: null };
            },
            then: (resolve, reject) => {
              if (table === 'ebay_products') return Promise.resolve({ data: myListings, error: null }).then(resolve, reject);
              if (table === 'target_sellers') return Promise.resolve({ data: [], error: null }).then(resolve, reject);
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return chain;
        },
        insert: async () => ({ error: null }),
        // repricer_log count query
      };
    },
  };
}

test('TEST E · autoRepricer verifier returns false · loop stops · report.leaseLost=true', async () => {
  const { runAutoRepricer } = require('../../src/services/autoRepricer');
  const competitors = [
    { sku: 'A', competitor_id: 'c1', competitor_price: 10, competitor_shipping: 0, prev_price: 15, seller_id: 's1', status: 'active' },
    { sku: 'B', competitor_id: 'c2', competitor_price: 10, competitor_shipping: 0, prev_price: 15, seller_id: 's1', status: 'active' },
    { sku: 'C', competitor_id: 'c3', competitor_price: 10, competitor_shipping: 0, prev_price: 15, seller_id: 's1', status: 'active' },
  ];
  const myListings = [
    { sku: 'A', item_id: '111', title: '', price_usd: 20 },
    { sku: 'B', item_id: '222', title: '', price_usd: 20 },
    { sku: 'C', item_id: '333', title: '', price_usd: 20 },
  ];
  const db = makeAutoRepricerDbMock({ competitors, myListings });
  let calls = 0;
  const ownershipVerifier = async () => { calls++; return false; }; // FALSE immediately
  const report = await runAutoRepricer(true, { db, ownershipVerifier });
  assert.equal(report.leaseLost, true);
  assert.equal(report.processed, 0, 'zero SKUs processed since verifier returned false on first iteration');
  assert.equal(calls, 1);
});

test('TEST F · autoRepricer verifier throws · loop stops · report.leaseLost=true', async () => {
  const { runAutoRepricer } = require('../../src/services/autoRepricer');
  const competitors = [
    { sku: 'A', competitor_id: 'c1', competitor_price: 10, competitor_shipping: 0, prev_price: 15, seller_id: 's1', status: 'active' },
    { sku: 'B', competitor_id: 'c2', competitor_price: 10, competitor_shipping: 0, prev_price: 15, seller_id: 's1', status: 'active' },
  ];
  const myListings = [
    { sku: 'A', item_id: '111', title: '', price_usd: 20 },
    { sku: 'B', item_id: '222', title: '', price_usd: 20 },
  ];
  const db = makeAutoRepricerDbMock({ competitors, myListings });
  const ownershipVerifier = async () => { throw new Error('rpc timeout'); };
  const report = await runAutoRepricer(true, { db, ownershipVerifier });
  assert.equal(report.leaseLost, true);
  assert.equal(report.processed, 0);
});

// -------------------- LAYER 3 · gate write-boundary fence --------------------

test('TEST G · gate ownership verify TRUE · ebay.updateItem called exactly once', async () => {
  const m = makeGateDbMocks();
  const ownershipVerifier = async () => true;
  const result = await gate.executePriceWrite(
    makeGateReq(),
    { db: m.db, ebay: m.ebay, getGuardrails: m.getGuardrails, publishPriceEvent: m.publishPriceEvent, ownershipVerifier }
  );
  assert.equal(result.outcome, gate.OUTCOME.APPLIED);
  assert.equal(m.ebayCalls.length, 1, 'exactly one eBay write');
  assert.equal(m.ebayCalls[0].price, 19.99);
});

test('TEST H · gate ownership verify FALSE · ebay.updateItem called ZERO', async () => {
  const m = makeGateDbMocks();
  const ownershipVerifier = async () => false;
  const result = await gate.executePriceWrite(
    makeGateReq(),
    { db: m.db, ebay: m.ebay, getGuardrails: m.getGuardrails, publishPriceEvent: m.publishPriceEvent, ownershipVerifier }
  );
  assert.equal(result.outcome, gate.OUTCOME.BLOCKED);
  assert.equal(result.reasonCode, gate.GATE_REASON.OWNERSHIP_LOST);
  assert.equal(m.ebayCalls.length, 0, 'ownership lost · NO eBay write');
  assert.equal(m.ebayProductsUpdates.length, 0, 'no state sync either');
});

test('TEST I · gate ownership verifier throws · ebay.updateItem called ZERO', async () => {
  const m = makeGateDbMocks();
  const ownershipVerifier = async () => { throw new Error('rpc network partition'); };
  const result = await gate.executePriceWrite(
    makeGateReq(),
    { db: m.db, ebay: m.ebay, getGuardrails: m.getGuardrails, publishPriceEvent: m.publishPriceEvent, ownershipVerifier }
  );
  assert.equal(result.outcome, gate.OUTCOME.BLOCKED);
  assert.equal(result.reasonCode, gate.GATE_REASON.OWNERSHIP_LOST);
  assert.equal(m.ebayCalls.length, 0);
});

test('TEST J · verify ordering · verifier resolves BEFORE ebay.updateItem', async () => {
  const m = makeGateDbMocks();
  let verifierEndedAtMs = null;
  const ownershipVerifier = async () => {
    await new Promise(res => setTimeout(res, 10));
    verifierEndedAtMs = Date.now();
    return true;
  };
  await gate.executePriceWrite(
    makeGateReq(),
    { db: m.db, ebay: m.ebay, getGuardrails: m.getGuardrails, publishPriceEvent: m.publishPriceEvent, ownershipVerifier }
  );
  assert.equal(m.ebayCalls.length, 1);
  assert.ok(verifierEndedAtMs !== null, 'verifier ran');
  assert.ok(m.ebayCalls[0].calledAt >= verifierEndedAtMs, 'eBay write happened AFTER verifier resolved');
});

test('TEST K · gate other caller (no ownershipVerifier) · existing behavior unchanged', async () => {
  const m = makeGateDbMocks();
  const result = await gate.executePriceWrite(
    makeGateReq({ context: 'MANUAL_APPROVED' }),
    { db: m.db, ebay: m.ebay, getGuardrails: m.getGuardrails, publishPriceEvent: m.publishPriceEvent }
    // no ownershipVerifier
  );
  assert.equal(result.outcome, gate.OUTCOME.APPLIED, 'legacy MANUAL_APPROVED path unchanged');
  assert.equal(m.ebayCalls.length, 1);
  assert.equal(result.reasonCode, 'AUTO_UNDERCUT_SAFE');
});

test('TEST L · pipeline body throws · lease release attempted', withLeaseStore(async (store) => {
  const KEY = 'scheduler:repricing-pipeline';
  await assert.rejects(
    schedulerLock.withLease(KEY,
      { ttlSec: 60, heartbeatSec: 10, failPolicy: 'closed' },
      async () => { throw new Error('boom inside pipeline'); }),
    /boom inside pipeline/,
  );
  assert.equal(store.rows.has(KEY), false, 'lease row deleted even after fn throw');
}));

test('TEST M · DRY_RUN · dryrun mode · no gate call · no eBay update', async () => {
  const { runAutoRepricer } = require('../../src/services/autoRepricer');
  const competitors = [
    { sku: 'A', competitor_id: 'c1', competitor_price: 10, competitor_shipping: 0, prev_price: 15, seller_id: 's1', status: 'active' },
  ];
  const myListings = [{ sku: 'A', item_id: '111', title: '', price_usd: 20 }];
  const db = makeAutoRepricerDbMock({ competitors, myListings });
  let gateCalls = 0;
  const gateExecute = async () => { gateCalls++; return { outcome: 'APPLIED' }; };
  const report = await runAutoRepricer(true, { db, gateExecute, ownershipVerifier: async () => true });
  assert.equal(gateCalls, 0, 'dry_run mode must not invoke the gate');
  assert.equal(report.mode, 'dry_run');
});

test('TEST N · kill_switch=true · gate blocks · ebay.updateItem ZERO (regression)', async () => {
  const m = makeGateDbMocks({ guardrails: { kill_switch: true, auto_apply_enabled: true } });
  // Even if verifier says OK, kill_switch takes precedence
  const ownershipVerifier = async () => true;
  const result = await gate.executePriceWrite(
    makeGateReq(),
    { db: m.db, ebay: m.ebay, getGuardrails: m.getGuardrails, publishPriceEvent: m.publishPriceEvent, ownershipVerifier }
  );
  assert.equal(result.outcome, gate.OUTCOME.BLOCKED);
  assert.equal(result.reasonCode, gate.GATE_REASON.KILL_SWITCH);
  assert.equal(m.ebayCalls.length, 0);
});

test('TEST O · return-shape backward compat · skipped result carries alerts=0 etc', withLeaseStore(async (store) => {
  const KEY = 'scheduler:repricing-pipeline';
  // pre-hold with a different owner
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: KEY, p_owner_id: 'other-proc', p_run_id: 'other-run', p_ttl_seconds: 300 });
  // Require the pipeline fresh (module state) and invoke it. We do NOT go
  // through the real DB; the pipeline body never runs because SKIP_LOCKED.
  delete require.cache[require.resolve('../../src/jobs/repricingPipelineJob')];
  const { runRepricingPipeline } = require('../../src/jobs/repricingPipelineJob');
  const result = await runRepricingPipeline({ dryRun: true, silent: true });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'locked');
  //   Legacy caller compatibility · all these fields must exist and be zero
  assert.equal(result.alerts, 0);
  assert.equal(result.priceAlerts, 0);
  assert.equal(result.proposals, 0);
  assert.equal(result.raises, 0);
  assert.equal(result.drops, 0);
  assert.equal(result.holds, 0);
  assert.equal(result.changed, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.leaseLost, false);
}));

test('TEST P · stale A after B takeover · A gate write BLOCKED · B path unaffected', async () => {
  //   Simulate: two processes A and B. A acquired the lease and is running.
  //   A's lease expired due to network partition. B took over. A's next
  //   ownership verify at the gate must return FALSE (heartbeat rejects
  //   stale run_id) so A's ebay.updateItem is BLOCKED. Meanwhile B's own
  //   gate call — with B's live verifier — is unaffected.

  const store = new MockLeaseStore();
  schedulerLock._setClientForTests(store);
  try {
    const KEY = 'scheduler:repricing-pipeline';
    // A acquires with short TTL
    const aAcq = await store.rpc('acquire_scheduler_lease',
      { p_lock_key: KEY, p_owner_id: 'proc-A', p_run_id: 'run-A', p_ttl_seconds: 2 });
    assert.equal(aAcq.data[0].acquired, true);
    // A ownership verifier · replicates what ctx.verifyOwnership does
    const aVerifier = async () => {
      const hb = await store.rpc('heartbeat_scheduler_lease',
        { p_lock_key: KEY, p_owner_id: 'proc-A', p_run_id: 'run-A', p_ttl_seconds: 2 });
      return hb.data[0].ok === true;
    };
    // Expire A · advance clock beyond TTL
    store.advance(3_000);
    // B takes over
    const bAcq = await store.rpc('acquire_scheduler_lease',
      { p_lock_key: KEY, p_owner_id: 'proc-B', p_run_id: 'run-B', p_ttl_seconds: 60 });
    assert.equal(bAcq.data[0].acquired, true);
    const bVerifier = async () => {
      const hb = await store.rpc('heartbeat_scheduler_lease',
        { p_lock_key: KEY, p_owner_id: 'proc-B', p_run_id: 'run-B', p_ttl_seconds: 60 });
      return hb.data[0].ok === true;
    };
    // A tries to write via gate — verifier must return false
    const gateA = makeGateDbMocks();
    const rA = await gate.executePriceWrite(
      makeGateReq({ requestId: 'stale-A' }),
      { db: gateA.db, ebay: gateA.ebay, getGuardrails: gateA.getGuardrails, publishPriceEvent: gateA.publishPriceEvent, ownershipVerifier: aVerifier }
    );
    assert.equal(rA.outcome, gate.OUTCOME.BLOCKED);
    assert.equal(rA.reasonCode, gate.GATE_REASON.OWNERSHIP_LOST);
    assert.equal(gateA.ebayCalls.length, 0, 'stale A must not write to eBay');
    // B writes via gate — verifier must return true · applied
    const gateB = makeGateDbMocks();
    const rB = await gate.executePriceWrite(
      makeGateReq({ requestId: 'live-B' }),
      { db: gateB.db, ebay: gateB.ebay, getGuardrails: gateB.getGuardrails, publishPriceEvent: gateB.publishPriceEvent, ownershipVerifier: bVerifier }
    );
    assert.equal(rB.outcome, gate.OUTCOME.APPLIED, 'live B path continues normally');
    assert.equal(gateB.ebayCalls.length, 1, 'B writes once');
  } finally {
    schedulerLock._resetClientForTests();
  }
});
