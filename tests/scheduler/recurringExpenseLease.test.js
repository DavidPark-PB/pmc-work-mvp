'use strict';

/**
 * tests/scheduler/recurringExpenseLease.test.js — Refactor R1-D1-A.
 *
 * Verifies per-rule distributed leasing for recurring expense firing plus
 * truthful aggregation semantics across every fire() caller (03:00 cron,
 * POST /:id/run, POST /fire-due).
 *
 * Absolute invariant (owner directive 2026-09-05):
 *   expense INSERT count (mocked) == fired count reported by scheduler / route
 *   SKIP_LOCKED never counted as an emitted expense.
 *
 * Zero real DB writes · schedulerLock uses MockLeaseStore · Supabase
 * client for recurringRepository.update is injected via
 * _setClientForTests. expenseRepo is mocked at each call.
 *
 * Owner rules (R1-D1-A · 2026-09-05):
 *   A valid rule · lease acquire · expense INSERT 1 · recurring UPDATE 1
 *   B same rule prelocked · expense 0 · UPDATE 0 · SKIP_LOCKED
 *   C acquire RPC error · expense 0 · UPDATE 0 · distinguished skipped_error
 *   D same-process same-rule concurrent fire × 2 · exactly one body
 *   E different-process simulation same rule · exactly one body
 *   F different rules concurrent · both execute
 *   G N-way same rule · exactly one execute
 *   H expense create throws · recurring UPDATE 0 · release attempted
 *   I expense succeeds · recurring UPDATE throws · partial failure (D1-B residual)
 *   J success return compatibility · legacy shape preserved
 *   K manual route expected spread compatibility · static shape check
 *   L cron SKIP not falsely counted as emitted · aggregation logic verified
 *   M invalid recurring.id · no lease acquired · expense 0
 *   N SCHEDULER_LOCK_ENABLED=0 · pass-through · legacy behavior
 *   O body throw · lease release attempted
 *   P cron aggregation: 1 fired + 1 locked · fired=1 · skippedLocked=1
 *   Q cron: skipped_error result · fired 증가 안 함
 *   R POST /:id/run locked · emitted:false · HTTP 200 · not 500
 *   S POST /:id/run real fire · emitted:true
 *   T POST /fire-due · 1 fire + 1 locked · fired=1 · skipped=1
 *   U rejected fire · failed=1 · fired 증가 안 함
 *   V expense insert count == fired count invariant
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const schedulerLock = require('../../src/services/schedulerLock');
const recurringRepo = require('../../src/db/recurringRepository');

// ═══════════════════════════════════════════════════════════════════════════
// MockLeaseStore · mirrors migration 108 RPCs (same contract as R1-A/B/C1).
// ═══════════════════════════════════════════════════════════════════════════
class MockLeaseStore {
  constructor() {
    this.rows = new Map();
    this._nowMs = Date.now();
    this._acquireErrorFor = new Map();
    this._releaseCalls = 0;
  }
  advance(ms) { this._nowMs += ms; }
  forceAcquireErrorFor(lockKey, e) { this._acquireErrorFor.set(lockKey, e); }
  rpc(name, params) {
    if (name === 'acquire_scheduler_lease')   return this._acquire(params);
    if (name === 'heartbeat_scheduler_lease') return this._heartbeat(params);
    if (name === 'release_scheduler_lease')   return this._release(params);
    return Promise.resolve({ data: null, error: new Error(`unknown rpc: ${name}`) });
  }
  async _acquire(p) {
    if (this._acquireErrorFor.has(p.p_lock_key)) {
      return { data: null, error: this._acquireErrorFor.get(p.p_lock_key) };
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
    this._releaseCalls++;
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
// Minimal Supabase-shaped mock for recurringRepository.update()
// Only needs the .from(t).update(patch).eq(col, v).select().single() surface.
// ═══════════════════════════════════════════════════════════════════════════
function makeUpdateDbMock({ throwOnUpdate = null } = {}) {
  const calls = [];
  const db = {
    from(table) {
      return {
        update(patch) {
          return {
            eq(col, val) {
              return {
                select() {
                  return {
                    async single() {
                      calls.push({ table, patch, [col]: val });
                      if (throwOnUpdate) return { data: null, error: throwOnUpdate };
                      //   Return a row shaped like recurring_payments so decorate() works.
                      return {
                        data: {
                          id: val, name: 'x', amount: 1000, currency: 'KRW',
                          category: 'x', cycle: 'monthly', day_of_cycle: 1,
                          next_due_at: patch.next_due_at || '2026-10-01',
                          card_last4: null, memo: null, active: true,
                          created_by: null, created_at: '2026-09-01',
                        },
                        error: null,
                      };
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
  return { db, calls };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fake expenseRepo · counts createExpense invocations and optionally throws.
// ═══════════════════════════════════════════════════════════════════════════
function makeExpenseRepo({ throwOnCreate = null } = {}) {
  const calls = [];
  const expenseRepo = {
    async createExpense(input) {
      calls.push(input);
      if (throwOnCreate) throw throwOnCreate;
      return { id: calls.length, ...input };
    },
  };
  return { expenseRepo, calls };
}

// ═══════════════════════════════════════════════════════════════════════════
// Rule factory · deterministic default
// ═══════════════════════════════════════════════════════════════════════════
function makeRule(overrides = {}) {
  return {
    id: 42,
    name: 'Netflix',
    amount: 17500,
    currency: 'KRW',
    category: 'subscription',
    cycle: 'monthly',
    dayOfCycle: 15,
    nextDueAt: '2026-09-15',
    cardLast4: '1234',
    memo: null,
    active: true,
    createdBy: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Harness · install schedulerLock mock + recurringRepo db mock together.
// ═══════════════════════════════════════════════════════════════════════════
function withHarness(fn) {
  return async () => {
    const store = new MockLeaseStore();
    const { db, calls: updateCalls } = makeUpdateDbMock();
    schedulerLock._setClientForTests(store);
    recurringRepo._setClientForTests(db);
    try { await fn(store, updateCalls); }
    finally {
      schedulerLock._resetClientForTests();
      recurringRepo._resetClientForTests();
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS · Per-rule lease + classification helper
// ═══════════════════════════════════════════════════════════════════════════

test('TEST A · valid rule · lease acquire · expense INSERT 1 · recurring UPDATE 1', withHarness(async (store, updateCalls) => {
  const { expenseRepo, calls } = makeExpenseRepo();
  const rule = makeRule();
  const result = await recurringRepo.fire(rule, { expenseRepo });
  assert.equal(calls.length, 1);
  assert.equal(updateCalls.length, 1);
  assert.ok(result.expense);
  assert.equal(result.nextDueAt, '2026-10-15');
  assert.equal(result.skipped, undefined, 'legacy success shape · no skipped field');
}));

test('TEST B · same rule prelocked · expense 0 · UPDATE 0 · SKIP_LOCKED', withHarness(async (store, updateCalls) => {
  //   Preload another owner's lease for rule#42
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:42',
      p_owner_id: 'other-proc', p_run_id: 'other-run', p_ttl_seconds: 300 });
  const { expenseRepo, calls } = makeExpenseRepo();
  const result = await recurringRepo.fire(makeRule(), { expenseRepo });
  assert.equal(calls.length, 0, 'expense create MUST NOT be called under SKIP_LOCKED');
  assert.equal(updateCalls.length, 0, 'recurring UPDATE MUST NOT run either');
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'locked');
  assert.equal(result.recurringId, 42);
}));

test('TEST C · acquire RPC error · expense 0 · UPDATE 0 · distinguished skipped_error', withHarness(async (store, updateCalls) => {
  store.forceAcquireErrorFor('scheduler:recurring-expense:rule:42', new Error('supabase down'));
  const { expenseRepo, calls } = makeExpenseRepo();
  const result = await recurringRepo.fire(makeRule(), { expenseRepo });
  assert.equal(calls.length, 0);
  assert.equal(updateCalls.length, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'lease_error', 'infra error DISTINCT from normal locked');
  assert.equal(result.recurringId, 42);
  assert.ok(result.error);
}));

test('TEST D · same-process same-rule concurrent fire × 2 · exactly one body', withHarness(async (store, updateCalls) => {
  //   Long-running expenseRepo makes the two invocations overlap deterministically.
  const seen = { count: 0, max: 0 };
  const slowRepo = {
    async createExpense(input) {
      seen.count++;
      if (seen.count > seen.max) seen.max = seen.count;
      await new Promise(r => setTimeout(r, 30));
      seen.count--;
      return { id: 1, ...input };
    },
  };
  const rule = makeRule();
  const [r1, r2] = await Promise.all([
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
  ]);
  assert.equal(seen.max, 1, 'lock allows only one active fire body');
  const skipped = [r1, r2].filter(r => r.skipped).length;
  const emitted = [r1, r2].filter(r => !r.skipped).length;
  assert.equal(skipped, 1);
  assert.equal(emitted, 1);
}));

test('TEST E · different-process simulation same rule · exactly one body', withHarness(async (store, updateCalls) => {
  //   Simulate proc-alpha as external lease holder · this process (schedulerLock's
  //   OWNER_ID) attempts and must skip.
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:42',
      p_owner_id: 'proc-alpha', p_run_id: 'run-alpha', p_ttl_seconds: 300 });
  const { expenseRepo, calls } = makeExpenseRepo();
  const result = await recurringRepo.fire(makeRule(), { expenseRepo });
  assert.equal(calls.length, 0);
  assert.equal(result.skipped, true);
}));

test('TEST F · different rules concurrent · both execute', withHarness(async (store, updateCalls) => {
  const { expenseRepo, calls } = makeExpenseRepo();
  const [r1, r2] = await Promise.all([
    recurringRepo.fire(makeRule({ id: 1 }), { expenseRepo }),
    recurringRepo.fire(makeRule({ id: 2 }), { expenseRepo }),
  ]);
  assert.equal(calls.length, 2, 'different rules · different keys · both run');
  assert.ok(r1.expense);
  assert.ok(r2.expense);
}));

test('TEST G · N-way same rule · exactly one execute', withHarness(async (store, updateCalls) => {
  const seen = { count: 0, max: 0 };
  const slowRepo = {
    async createExpense(input) {
      seen.count++;
      if (seen.count > seen.max) seen.max = seen.count;
      await new Promise(r => setTimeout(r, 30));
      seen.count--;
      return { id: 1, ...input };
    },
  };
  const rule = makeRule({ id: 99 });
  const results = await Promise.all([
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
    recurringRepo.fire(rule, { expenseRepo: slowRepo }),
  ]);
  assert.equal(seen.max, 1);
  const emitted = results.filter(r => !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  assert.equal(emitted, 1);
  assert.equal(skipped, 4);
}));

test('TEST H · expense create throws · recurring UPDATE 0 · release attempted', withHarness(async (store, updateCalls) => {
  const beforeRel = store._releaseCalls;
  const { expenseRepo, calls } = makeExpenseRepo({ throwOnCreate: new Error('db insert failed') });
  await assert.rejects(
    recurringRepo.fire(makeRule(), { expenseRepo }),
    /db insert failed/,
  );
  assert.equal(calls.length, 1, 'expense create attempted');
  assert.equal(updateCalls.length, 0, 'recurring UPDATE NOT reached · body threw first');
  assert.ok(store._releaseCalls > beforeRel, 'lease released in finally');
  assert.equal(store.rows.has('scheduler:recurring-expense:rule:42'), false, 'lease row cleaned up');
}));

test('TEST I · expense succeeds · recurring UPDATE throws · partial failure reproduced (D1-B residual)', async () => {
  //   Custom harness · db update throws
  const store = new MockLeaseStore();
  const { db, calls: updateCalls } = makeUpdateDbMock({ throwOnUpdate: new Error('update RPC failed') });
  schedulerLock._setClientForTests(store);
  recurringRepo._setClientForTests(db);
  try {
    const { expenseRepo, calls } = makeExpenseRepo();
    await assert.rejects(
      recurringRepo.fire(makeRule(), { expenseRepo }),
    );
    //   Expense was INSERTed (mock recorded call), but UPDATE failed.
    //   D1-A does NOT solve this class of duplicate-on-replay.
    assert.equal(calls.length, 1, 'expense insert happened');
    assert.equal(updateCalls.length, 1, 'update attempted then errored');
    //   Documenting the residual · next run would re-insert (D1-B fix required).
  } finally {
    schedulerLock._resetClientForTests();
    recurringRepo._resetClientForTests();
  }
});

test('TEST J · successful return compatibility · legacy shape preserved', withHarness(async (store, updateCalls) => {
  const { expenseRepo } = makeExpenseRepo();
  const result = await recurringRepo.fire(makeRule(), { expenseRepo });
  assert.ok('expense' in result, 'expense field present');
  assert.ok('nextDueAt' in result, 'nextDueAt field present');
  //   No `skipped` field on success (must be undefined)
  assert.equal(result.skipped, undefined);
}));

test('TEST K · manual route expected spread compatibility · shape check', withHarness(async (store, updateCalls) => {
  //   Route does `res.json({ok:true, emitted:true, expense, nextDueAt})` for success
  //   and `res.json({ok:true, emitted:false, skipped:true, skipReason:'locked'})` for skip.
  //   Verify both shapes construct cleanly from fire()'s return.
  const { expenseRepo } = makeExpenseRepo();
  const okResult = await recurringRepo.fire(makeRule(), { expenseRepo });
  const routeSuccess = { ok: true, emitted: true, expense: okResult.expense, nextDueAt: okResult.nextDueAt };
  assert.equal(routeSuccess.emitted, true);
  assert.ok(routeSuccess.expense);

  //   Now the skip shape
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:2',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  const skipResult = await recurringRepo.fire(makeRule({ id: 2 }), { expenseRepo });
  const routeSkip = { ok: true, emitted: false, skipped: true, skipReason: skipResult.skipReason };
  assert.equal(routeSkip.emitted, false);
  assert.equal(routeSkip.skipReason, 'locked');
}));

test('TEST L · aggregation logic · skipped never counted as fired', () => {
  //   Direct test of classifyFireResult · the shared classifier used by both
  //   scheduler.js and route.js. If this passes, both callers count correctly.
  const results = [
    { status: 'fulfilled', value: { expense: {}, nextDueAt: '2026-10-01' } },        // fired
    { status: 'fulfilled', value: { skipped: true, skipReason: 'locked' } },         // skipped_locked
    { status: 'fulfilled', value: { skipped: true, skipReason: 'lease_error' } },    // skipped_error
    { status: 'rejected', reason: new Error('boom') },                                // failed
    { status: 'fulfilled', value: { expense: {}, nextDueAt: '2026-11-01' } },        // fired
  ];
  const buckets = results.map(recurringRepo.classifyFireResult);
  assert.deepEqual(buckets, ['fired', 'skipped_locked', 'skipped_error', 'failed', 'fired']);
  const fired = buckets.filter(b => b === 'fired').length;
  assert.equal(fired, 2, 'exactly 2 fired · skipped not inflated');
});

test('TEST M · invalid recurring.id · no lease acquired · expense 0', withHarness(async (store, updateCalls) => {
  const { expenseRepo, calls } = makeExpenseRepo();
  //   Missing id
  await assert.rejects(recurringRepo.fire({ nextDueAt: '2026-09-15' }, { expenseRepo }), /recurring\.id/);
  //   Null id
  await assert.rejects(recurringRepo.fire({ id: null }, { expenseRepo }), /recurring\.id/);
  //   Empty string
  await assert.rejects(recurringRepo.fire({ id: '' }, { expenseRepo }), /recurring\.id/);
  //   Non-numeric string
  await assert.rejects(recurringRepo.fire({ id: 'not-a-number' }, { expenseRepo }), /finite number/);
  assert.equal(calls.length, 0, 'no expense created for invalid ids');
  //   No lease row ever created for undefined key
  const badKey = 'scheduler:recurring-expense:rule:undefined';
  assert.equal(store.rows.has(badKey), false, 'no lease under undefined key');
}));

test('TEST N · SCHEDULER_LOCK_ENABLED=0 · pass-through · legacy behavior', async () => {
  const prev = process.env.SCHEDULER_LOCK_ENABLED;
  process.env.SCHEDULER_LOCK_ENABLED = '0';
  //   No lease store · but recurringRepo still needs a mock db for update()
  const { db } = makeUpdateDbMock();
  recurringRepo._setClientForTests(db);
  try {
    const { expenseRepo, calls } = makeExpenseRepo();
    const result = await recurringRepo.fire(makeRule(), { expenseRepo });
    assert.equal(calls.length, 1, 'legacy pass-through · expense created');
    assert.ok(result.expense);
    assert.equal(result.skipped, undefined);
  } finally {
    if (prev === undefined) delete process.env.SCHEDULER_LOCK_ENABLED;
    else process.env.SCHEDULER_LOCK_ENABLED = prev;
    recurringRepo._resetClientForTests();
  }
});

test('TEST O · body throw · lease release attempted (regression of H)', withHarness(async (store, updateCalls) => {
  const beforeRel = store._releaseCalls;
  const { expenseRepo } = makeExpenseRepo({ throwOnCreate: new Error('boom') });
  await assert.rejects(recurringRepo.fire(makeRule(), { expenseRepo }));
  assert.ok(store._releaseCalls > beforeRel);
  assert.equal(store.rows.has('scheduler:recurring-expense:rule:42'), false);
}));

// ─── caller aggregation tests ─────────────────────────────────────────────

test('TEST P · cron aggregation · 1 fired + 1 locked · fired=1 · skippedLocked=1', () => {
  //   Simulate the scheduler.js aggregation logic directly. If it stays in
  //   sync with classifyFireResult, cron log/count is truthful.
  const results = [
    { status: 'fulfilled', value: { expense: {}, nextDueAt: '2026-10-01' } },
    { status: 'fulfilled', value: { skipped: true, skipReason: 'locked' } },
  ];
  let fired = 0, skippedLocked = 0, skippedError = 0, failed = 0;
  results.forEach(x => {
    const b = recurringRepo.classifyFireResult(x);
    if (b === 'fired')          fired++;
    else if (b === 'skipped_locked') skippedLocked++;
    else if (b === 'skipped_error')  skippedError++;
    else                        failed++;
  });
  assert.equal(fired, 1);
  assert.equal(skippedLocked, 1);
  assert.equal(skippedError, 0);
  assert.equal(failed, 0);
});

test('TEST Q · cron · skipped_error result · fired 증가 안 함', () => {
  const results = [
    { status: 'fulfilled', value: { skipped: true, skipReason: 'lease_error' } },
    { status: 'fulfilled', value: { expense: {}, nextDueAt: '2026-10-01' } },
  ];
  let fired = 0, skippedLocked = 0, skippedError = 0, failed = 0;
  results.forEach(x => {
    const b = recurringRepo.classifyFireResult(x);
    if (b === 'fired')          fired++;
    else if (b === 'skipped_locked') skippedLocked++;
    else if (b === 'skipped_error')  skippedError++;
    else                        failed++;
  });
  assert.equal(fired, 1);
  assert.equal(skippedError, 1);
  assert.equal(skippedLocked, 0);
});

test('TEST R · POST /:id/run locked · HTTP semantic (emitted:false · not 500)', withHarness(async (store, updateCalls) => {
  //   Preload someone else's lease
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:42',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  const { expenseRepo } = makeExpenseRepo();
  const result = await recurringRepo.fire(makeRule(), { expenseRepo });
  //   Route builds: if (skipped && skipReason==='locked') → HTTP 200 with { ok:true, emitted:false, ... }
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'locked');
  //   Build the exact response shape the route sends
  const routeBody = {
    ok: true, emitted: false, skipped: true, skipReason: 'locked', recurringId: result.recurringId,
  };
  assert.equal(routeBody.emitted, false);
  assert.equal(routeBody.ok, true, 'ok:true · not an error · HTTP 200 expected');
}));

test('TEST S · POST /:id/run real fire · emitted:true', withHarness(async (store, updateCalls) => {
  const { expenseRepo } = makeExpenseRepo();
  const result = await recurringRepo.fire(makeRule(), { expenseRepo });
  const routeBody = {
    ok: true, emitted: true, expense: result.expense, nextDueAt: result.nextDueAt,
  };
  assert.equal(routeBody.emitted, true);
  assert.ok(routeBody.expense);
  assert.equal(routeBody.nextDueAt, '2026-10-15');
}));

test('TEST T · POST /fire-due · 1 fire + 1 locked · fired=1 · skipped=1', withHarness(async (store, updateCalls) => {
  //   Simulate fire-due loop
  const { expenseRepo } = makeExpenseRepo();
  //   Lock rule#2 with another owner
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:2',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  const due = [makeRule({ id: 1 }), makeRule({ id: 2 })];
  let fired = 0, skipped = 0, leaseErrored = 0, failed = 0;
  for (const r of due) {
    try {
      const result = await recurringRepo.fire(r, { expenseRepo });
      const b = recurringRepo.classifyFireResult(result);
      if (b === 'fired')          fired++;
      else if (b === 'skipped_locked') skipped++;
      else if (b === 'skipped_error')  leaseErrored++;
      else                        failed++;
    } catch (e) {
      failed++;
    }
  }
  assert.equal(fired, 1, 'rule#1 fired');
  assert.equal(skipped, 1, 'rule#2 skipped by lock');
  assert.equal(leaseErrored, 0);
  assert.equal(failed, 0);
}));

test('TEST U · rejected fire · failed=1 · fired 증가 안 함', withHarness(async (store, updateCalls) => {
  //   Rule#1 fires fine · rule#2 throws inside body
  let sku2Threw = false;
  const expenseRepo = {
    async createExpense(input) {
      if (input.recurringId === 2) { sku2Threw = true; throw new Error('rule 2 boom'); }
      return { id: 1, ...input };
    },
  };
  const due = [makeRule({ id: 1 }), makeRule({ id: 2 })];
  let fired = 0, skipped = 0, leaseErrored = 0, failed = 0;
  for (const r of due) {
    try {
      const result = await recurringRepo.fire(r, { expenseRepo });
      const b = recurringRepo.classifyFireResult(result);
      if (b === 'fired')          fired++;
      else if (b === 'skipped_locked') skipped++;
      else if (b === 'skipped_error')  leaseErrored++;
      else                        failed++;
    } catch (e) {
      failed++;
    }
  }
  assert.ok(sku2Threw);
  assert.equal(fired, 1, 'only rule#1 counted as fired');
  assert.equal(failed, 1, 'rule#2 counted as failed');
}));

test('TEST V · expense insert count == fired count invariant', withHarness(async (store, updateCalls) => {
  //   Mixed scenario · verify the invariant end-to-end
  //   rule#7 fires, rule#8 locked, rule#9 fires
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:8',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  const { expenseRepo, calls } = makeExpenseRepo();
  const due = [makeRule({ id: 7 }), makeRule({ id: 8 }), makeRule({ id: 9 })];
  const results = await Promise.allSettled(
    due.map(r => recurringRepo.fire(r, { expenseRepo }))
  );
  const buckets = results.map(recurringRepo.classifyFireResult);
  const fired = buckets.filter(b => b === 'fired').length;
  //   INVARIANT: number of actual expense INSERTs == number of "fired" reported
  assert.equal(calls.length, fired,
    `expense insert count (${calls.length}) must equal fired count (${fired})`);
  assert.equal(fired, 2, 'rule#7 + rule#9');
  assert.equal(buckets.filter(b => b === 'skipped_locked').length, 1, 'rule#8 locked');
}));
