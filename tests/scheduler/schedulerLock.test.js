'use strict';

/**
 * tests/scheduler/schedulerLock.test.js — Refactor R1-A.
 *
 * Verifies the semantics of `src/services/schedulerLock.withLease()` and the
 * corresponding contract expected of migration 108's three RPCs
 * (acquire_scheduler_lease · heartbeat_scheduler_lease · release_scheduler_lease).
 *
 * These tests never touch a real database. The RPC layer is replaced by an
 * in-memory `MockLeaseStore` that implements the exact contract that the SQL
 * side of migration 108 must satisfy. If future SQL changes drift from this
 * contract, R1-B onward will surface the mismatch in integration testing.
 *
 * Owner rules for R1-A (2026-09-04):
 *   TEST A · different owner concurrent acquire → exactly one winner
 *   TEST B · SAME owner + DIFFERENT run_id overlap → second acquire FALSE
 *   TEST C · expired lease → next acquire takes over
 *   TEST D · normal release → next acquire succeeds
 *   TEST E · fn throws → release attempted in finally
 *   TEST F · acquire RPC error + failPolicy=closed → fn NOT called
 *   TEST G · acquire RPC error + failPolicy=open → fn called (LOCK_INFRA_BYPASS)
 *   TEST H · different lock_keys → both acquire concurrently
 *   TEST I · stale RUN A after RUN B takeover · A hb FALSE · A release FALSE · B lease survives
 *   TEST J · heartbeat extends the current lease's expiry
 *   TEST K · invalid TTL rejected before any RPC call
 *   TEST L · normal acquired=false under failPolicy=open still SKIPS fn
 *
 * Bonus:
 *   TEST M · SCHEDULER_LOCK_ENABLED=0 → pass-through (no RPC call · fn ran)
 *   TEST N · concurrent (Promise.all) acquire on same key → exactly one winner
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const schedulerLock = require('../../src/services/schedulerLock');

// ═══════════════════════════════════════════════════════════════════════════
// In-memory lease store · MUST mirror migration 108 semantics exactly.
// ═══════════════════════════════════════════════════════════════════════════
class MockLeaseStore {
  constructor() {
    this.rows = new Map();       // lock_key → { owner_id, run_id, acquired_at, expires_at, heartbeat_at }
    this._nowMs = Date.now();
    this._acquireCalls   = 0;
    this._heartbeatCalls = 0;
    this._releaseCalls   = 0;
    this._forceAcquireError   = null;
    this._forceHeartbeatError = null;
    this._forceReleaseError   = null;
  }
  now()               { return new Date(this._nowMs); }
  advance(ms)         { this._nowMs += ms; }
  forceAcquireError(e){ this._forceAcquireError   = e; }
  forceHeartbeatError(e){ this._forceHeartbeatError = e; }
  forceReleaseError(e){ this._forceReleaseError   = e; }

  // Simulate the Supabase JS SDK's client.rpc(name, params) API surface.
  rpc(name, params) {
    if (name === 'acquire_scheduler_lease')   return this._acquire(params);
    if (name === 'heartbeat_scheduler_lease') return this._heartbeat(params);
    if (name === 'release_scheduler_lease')   return this._release(params);
    return Promise.resolve({ data: null, error: new Error(`unknown rpc: ${name}`) });
  }

  async _acquire(p) {
    this._acquireCalls++;
    if (this._forceAcquireError) {
      const err = this._forceAcquireError;
      return { data: null, error: err };
    }
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
      // takeover or same-run refresh
      this.rows.set(p.p_lock_key, {
        owner_id: p.p_owner_id, run_id: p.p_run_id,
        acquired_at: nowIso, expires_at: newExpiresIso, heartbeat_at: nowIso,
      });
      return { data: [{ acquired: true, current_owner_id: p.p_owner_id, current_run_id: p.p_run_id, expires_at: newExpiresIso }], error: null };
    }
    // alive & not caller · reject
    return { data: [{ acquired: false, current_owner_id: existing.owner_id, current_run_id: existing.run_id, expires_at: existing.expires_at }], error: null };
  }

  async _heartbeat(p) {
    this._heartbeatCalls++;
    if (this._forceHeartbeatError) return { data: null, error: this._forceHeartbeatError };
    const nowMs = this._nowMs;
    const row = this.rows.get(p.p_lock_key);
    if (!row) return { data: [{ ok: false, expires_at: null }], error: null };
    const expiresMs = Date.parse(row.expires_at);
    const ownershipOk = row.owner_id === p.p_owner_id && row.run_id === p.p_run_id;
    const alive       = expiresMs > nowMs;
    if (ownershipOk && alive) {
      const nowIso = new Date(nowMs).toISOString();
      const newExpiresIso = new Date(nowMs + p.p_ttl_seconds * 1000).toISOString();
      row.heartbeat_at = nowIso;
      row.expires_at   = newExpiresIso;
      return { data: [{ ok: true, expires_at: newExpiresIso }], error: null };
    }
    return { data: [{ ok: false, expires_at: row.expires_at }], error: null };
  }

  async _release(p) {
    this._releaseCalls++;
    if (this._forceReleaseError) return { data: null, error: this._forceReleaseError };
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
// Helper · run a small block with the store installed, then restore.
// ═══════════════════════════════════════════════════════════════════════════
function withStore(fn) {
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

test('TEST A · different owner concurrent acquire → exactly one winner', withStore(async (store) => {
  // Simulate two processes by invoking the raw RPCs with different owner_ids.
  const key = 'test:A';
  const a = await store.rpc('acquire_scheduler_lease', {
    p_lock_key: key, p_owner_id: 'proc-a', p_run_id: 'run-a', p_ttl_seconds: 60,
  });
  const b = await store.rpc('acquire_scheduler_lease', {
    p_lock_key: key, p_owner_id: 'proc-b', p_run_id: 'run-b', p_ttl_seconds: 60,
  });
  assert.equal(a.data[0].acquired, true,  'proc-a should win first acquire');
  assert.equal(b.data[0].acquired, false, 'proc-b must be blocked');
  assert.equal(b.data[0].current_owner_id, 'proc-a');
  assert.equal(b.data[0].current_run_id,   'run-a');
}));

test('TEST B · SAME owner + DIFFERENT run_id overlap → second FALSE (in-process overlap block)', withStore(async (store) => {
  const key = 'test:B';
  const first = await store.rpc('acquire_scheduler_lease', {
    p_lock_key: key, p_owner_id: 'same-owner', p_run_id: 'run-1', p_ttl_seconds: 60,
  });
  const second = await store.rpc('acquire_scheduler_lease', {
    p_lock_key: key, p_owner_id: 'same-owner', p_run_id: 'run-2', p_ttl_seconds: 60,
  });
  assert.equal(first.data[0].acquired,  true,  'run-1 wins');
  assert.equal(second.data[0].acquired, false, 'run-2 must NOT reacquire · same owner ≠ same run');
  assert.equal(second.data[0].current_run_id, 'run-1', 'run-1 remains holder');
}));

test('TEST C · lease expiry → takeover succeeds', withStore(async (store) => {
  const key = 'test:C';
  const first = await store.rpc('acquire_scheduler_lease', {
    p_lock_key: key, p_owner_id: 'p1', p_run_id: 'r1', p_ttl_seconds: 5,
  });
  assert.equal(first.data[0].acquired, true);
  store.advance(6_000); // now past expiry
  const takeover = await store.rpc('acquire_scheduler_lease', {
    p_lock_key: key, p_owner_id: 'p2', p_run_id: 'r2', p_ttl_seconds: 5,
  });
  assert.equal(takeover.data[0].acquired, true, 'p2/r2 takes over expired lease');
  assert.equal(takeover.data[0].current_owner_id, 'p2');
  assert.equal(takeover.data[0].current_run_id,   'r2');
}));

test('TEST D · normal release → next acquire succeeds', withStore(async (store) => {
  const key = 'test:D';
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'p1', p_run_id: 'r1', p_ttl_seconds: 60 });
  const rel = await store.rpc('release_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'p1', p_run_id: 'r1' });
  assert.equal(rel.data, true);
  const second = await store.rpc('acquire_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'p2', p_run_id: 'r2', p_ttl_seconds: 60 });
  assert.equal(second.data[0].acquired, true, 'lease is free after release');
}));

test('TEST E · fn throws → release attempted in finally', withStore(async (store) => {
  const key = 'test:E';
  const beforeRelease = store._releaseCalls;
  await assert.rejects(async () => {
    await schedulerLock.withLease(key, { ttlSec: 60, heartbeatSec: 30 }, async () => {
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(store._releaseCalls, beforeRelease + 1, 'release RPC fired in finally');
  // and the lease row is gone
  assert.equal(store.rows.has(key), false, 'lease row deleted after failing run');
}));

test('TEST F · acquire RPC error + failPolicy=closed → fn NOT called', withStore(async (store) => {
  store.forceAcquireError(new Error('supabase down'));
  let fnCalled = false;
  const result = await schedulerLock.withLease(
    'test:F',
    { ttlSec: 60, heartbeatSec: 30, failPolicy: 'closed' },
    async () => { fnCalled = true; }
  );
  assert.equal(fnCalled, false, 'money-facing safety · fn must not run');
  assert.equal(result.ran,      false);
  assert.equal(result.acquired, false);
  assert.ok(result.error, 'error surfaced');
}));

test('TEST G · acquire RPC error + failPolicy=open → fn called', withStore(async (store) => {
  store.forceAcquireError(new Error('supabase down'));
  let fnCalled = false;
  const result = await schedulerLock.withLease(
    'test:G',
    { ttlSec: 60, heartbeatSec: 30, failPolicy: 'open' },
    async () => { fnCalled = true; return 'ok'; }
  );
  assert.equal(fnCalled, true, 'fail-open · fn runs even without lease');
  assert.equal(result.ran,   true);
  assert.equal(result.value, 'ok');
}));

test('TEST H · different lock_keys → both acquire concurrently', withStore(async (store) => {
  const a = await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'key:a', p_owner_id: 'p1', p_run_id: 'r1', p_ttl_seconds: 60 });
  const b = await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'key:b', p_owner_id: 'p1', p_run_id: 'r2', p_ttl_seconds: 60 });
  assert.equal(a.data[0].acquired, true);
  assert.equal(b.data[0].acquired, true);
  assert.equal(store.rows.size, 2, 'two separate lease rows');
}));

test('TEST I · stale RUN A after RUN B takeover · A cannot hb or release B\'s lease', withStore(async (store) => {
  const key = 'test:I';
  // RUN A acquires with 5s TTL.
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'proc', p_run_id: 'run-A', p_ttl_seconds: 5 });
  // Time passes · A's lease expires · RUN B takes over.
  store.advance(6_000);
  const bAcq = await store.rpc('acquire_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'proc', p_run_id: 'run-B', p_ttl_seconds: 60 });
  assert.equal(bAcq.data[0].acquired, true);
  // Late RUN A attempts heartbeat — MUST return ok=false and NOT touch B's row.
  const aHb = await store.rpc('heartbeat_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'proc', p_run_id: 'run-A', p_ttl_seconds: 60 });
  assert.equal(aHb.data[0].ok, false, 'stale run cannot heartbeat');
  // Late RUN A attempts release — MUST return false and NOT delete B's row.
  const aRel = await store.rpc('release_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'proc', p_run_id: 'run-A' });
  assert.equal(aRel.data, false, 'stale run cannot release winner');
  // RUN B's lease still exists · owner+run unchanged.
  const row = store.rows.get(key);
  assert.equal(row.owner_id, 'proc');
  assert.equal(row.run_id,   'run-B');
}));

test('TEST J · heartbeat extends the current lease\'s expiry', withStore(async (store) => {
  const key = 'test:J';
  const acq = await store.rpc('acquire_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'p', p_run_id: 'r', p_ttl_seconds: 10 });
  const originalExpires = Date.parse(acq.data[0].expires_at);
  store.advance(3_000);
  const hb = await store.rpc('heartbeat_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'p', p_run_id: 'r', p_ttl_seconds: 10 });
  assert.equal(hb.data[0].ok, true);
  const newExpires = Date.parse(hb.data[0].expires_at);
  assert.ok(newExpires > originalExpires, 'expires_at extended forward');
}));

test('TEST K · invalid TTL rejected before any RPC call', withStore(async (store) => {
  const beforeAcq = store._acquireCalls;
  await assert.rejects(
    schedulerLock.withLease('test:K', { ttlSec: 0, heartbeatSec: 10 }, async () => {}),
    /ttlSec/,
  );
  await assert.rejects(
    schedulerLock.withLease('test:K', { ttlSec: -5, heartbeatSec: 10 }, async () => {}),
    /ttlSec/,
  );
  await assert.rejects(
    schedulerLock.withLease('test:K', { ttlSec: 90_000, heartbeatSec: 10 }, async () => {}),
    /ttlSec/,
  );
  await assert.rejects(
    schedulerLock.withLease('test:K', { ttlSec: 60, heartbeatSec: 60 }, async () => {}),
    /heartbeatSec/,
  );
  assert.equal(store._acquireCalls, beforeAcq, 'no RPC calls made for invalid inputs');
}));

test('TEST L · normal acquired=false under failPolicy=open still SKIPS fn', withStore(async (store) => {
  const key = 'test:L';
  // Preload · someone else holds the lease
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: key, p_owner_id: 'other-proc', p_run_id: 'other-run', p_ttl_seconds: 60 });
  let fnCalled = false;
  const result = await schedulerLock.withLease(
    key,
    { ttlSec: 60, heartbeatSec: 30, failPolicy: 'open' },
    async () => { fnCalled = true; }
  );
  assert.equal(fnCalled, false, 'fail-open is ONLY for RPC infra errors · SKIP_LOCKED must skip fn');
  assert.equal(result.ran, false);
  assert.equal(result.acquired, false);
}));

test('TEST M · SCHEDULER_LOCK_ENABLED=0 · pass-through · no RPC call · fn runs', withStore(async (store) => {
  const prev = process.env.SCHEDULER_LOCK_ENABLED;
  process.env.SCHEDULER_LOCK_ENABLED = '0';
  try {
    const beforeAcq = store._acquireCalls;
    let fnCalled = false;
    const result = await schedulerLock.withLease('test:M',
      { ttlSec: 60, heartbeatSec: 30 },
      async () => { fnCalled = true; return 42; });
    assert.equal(fnCalled, true);
    assert.equal(result.value, 42);
    assert.equal(store._acquireCalls, beforeAcq, 'no RPC hit in disabled mode');
  } finally {
    if (prev === undefined) delete process.env.SCHEDULER_LOCK_ENABLED;
    else process.env.SCHEDULER_LOCK_ENABLED = prev;
  }
}));

test('TEST N · concurrent Promise.all acquire on same key → exactly one winner', withStore(async (store) => {
  const key = 'test:N';
  const results = await Promise.all([
    store.rpc('acquire_scheduler_lease',
      { p_lock_key: key, p_owner_id: 'p1', p_run_id: 'r1', p_ttl_seconds: 60 }),
    store.rpc('acquire_scheduler_lease',
      { p_lock_key: key, p_owner_id: 'p2', p_run_id: 'r2', p_ttl_seconds: 60 }),
    store.rpc('acquire_scheduler_lease',
      { p_lock_key: key, p_owner_id: 'p3', p_run_id: 'r3', p_ttl_seconds: 60 }),
  ]);
  const winners = results.filter(r => r.data[0].acquired);
  assert.equal(winners.length, 1, 'exactly one winner among 3 concurrent acquires');
}));
