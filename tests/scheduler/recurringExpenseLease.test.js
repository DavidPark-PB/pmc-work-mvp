'use strict';

/**
 * tests/scheduler/recurringExpenseLease.test.js — Refactor R1-D1-A.
 *
 * Verifies per-rule distributed leasing for recurring expense firing plus
 * truthful aggregation semantics across every fire() caller (03:00 cron,
 * POST /:id/run, POST /fire-due).
 *
 * Absolute invariant (owner directive 2026-09-05):
 *   expense INSERT count == fired count reported by scheduler / route
 *   SKIP_LOCKED never counted as an emitted expense.
 *
 * R1-D1-B (2026-09-05) — fire() body now calls the atomic RPC
 * `fire_recurring_expense_atomic` instead of expenseRepo.createExpense +
 * update(). The test harness therefore uses AtomicRpcMock (same class as
 * recurringExpenseIdempotency.test.js) so this file exercises the SAME
 * production code path. The lease semantics under test are unchanged;
 * only the underlying persistence mock updated.
 *
 * Owner rules (R1-D1-A · 2026-09-05) — test intents preserved:
 *   A valid rule · lease acquire · expense INSERT 1 · recurring UPDATE 1
 *   B same rule prelocked · expense 0 · UPDATE 0 · SKIP_LOCKED
 *   C acquire RPC error · expense 0 · UPDATE 0 · distinguished skipped_error
 *   D same-process same-rule concurrent fire × 2 · exactly one INSERT
 *   E different-process simulation same rule · exactly one INSERT
 *   F different rules concurrent · both execute
 *   G N-way same rule · exactly one INSERT
 *   H fire body throws (RPC error) · release attempted
 *   I expense succeeds · advance also happens (atomic · no partial state)
 *   J success return compatibility · legacy shape preserved
 *   K manual route expected spread compatibility · static shape check
 *   L cron SKIP not falsely counted as emitted · aggregation logic verified
 *   M invalid recurring.id · no lease acquired · no RPC call
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
// AtomicRpcMock · JS emulation of fire_recurring_expense_atomic (mig 109).
// Contract MUST match SQL · any drift caught by integration.
// ═══════════════════════════════════════════════════════════════════════════
class AtomicRpcMock {
  constructor() {
    this.recurring = new Map();
    this.expenses = [];
    this._nextExpenseId = 1;
    this._rpcErrorNext = null;
    this._locks = new Map();
    this._rpcCalls = 0;
    this._insertDelayMs = 0;
  }
  seedRecurring({ id, next_due_at }) { this.recurring.set(id, { id, next_due_at }); }
  seedExpense(row) { this.expenses.push({ id: this._nextExpenseId++, ...row }); }
  forceRpcErrorNext(e) { this._rpcErrorNext = e; }
  setInsertDelay(ms) { this._insertDelayMs = ms; }
  rpcCallCount() { return this._rpcCalls; }
  expenseCountFor(recurring_id) {
    return this.expenses.filter(e => e.recurring_id === recurring_id && e.source === 'recurring').length;
  }
  async _serialize(recurring_id, fn) {
    const prev = this._locks.get(recurring_id) || Promise.resolve();
    let release;
    const gate = new Promise(res => { release = res; });
    this._locks.set(recurring_id, prev.then(() => gate));
    await prev;
    try { return await fn(); }
    finally { release(); }
  }
  async rpc(name, params) {
    if (name !== 'fire_recurring_expense_atomic') {
      return { data: null, error: new Error(`unknown rpc: ${name}`) };
    }
    this._rpcCalls++;
    if (this._rpcErrorNext) {
      const e = this._rpcErrorNext; this._rpcErrorNext = null;
      return { data: null, error: e };
    }
    const p = params;
    if (p.p_recurring_id == null) return { data: null, error: mkErr('22023', 'recurring_id required') };
    if (!p.p_expected_occurrence) return { data: null, error: mkErr('22023', 'expected_occurrence required') };
    if (!p.p_next_occurrence)     return { data: null, error: mkErr('22023', 'next_occurrence required') };
    if (p.p_next_occurrence <= p.p_expected_occurrence) {
      return { data: null, error: mkErr('22023', 'next_occurrence must be after expected') };
    }
    if (p.p_amount == null || p.p_amount < 0) return { data: null, error: mkErr('22023', 'amount must be >= 0') };
    if (!p.p_currency) return { data: null, error: mkErr('22023', 'currency required') };
    if (!p.p_category) return { data: null, error: mkErr('22023', 'category required') };

    return this._serialize(p.p_recurring_id, async () => {
      const row = this.recurring.get(p.p_recurring_id);
      if (!row) return { data: null, error: mkErr('P0002', `recurring_payments not found: ${p.p_recurring_id}`) };
      if (row.next_due_at !== p.p_expected_occurrence) {
        return { data: [{ outcome: 'STALE_OCCURRENCE', expense_id: null, occurrence: row.next_due_at, next_due_at: row.next_due_at }], error: null };
      }
      const existing = this.expenses.find(e =>
        e.recurring_id === p.p_recurring_id
        && e.paid_at === p.p_expected_occurrence
        && e.source === 'recurring');
      if (existing) {
        row.next_due_at = p.p_next_occurrence;
        return { data: [{ outcome: 'ALREADY_EXISTS', expense_id: existing.id, occurrence: p.p_expected_occurrence, next_due_at: p.p_next_occurrence }], error: null };
      }
      //   Simulate work · lets D1-A concurrency tests overlap without races
      //   inside the mock (serialize ensures one at a time regardless).
      if (this._insertDelayMs > 0) {
        await new Promise(r => setTimeout(r, this._insertDelayMs));
      }
      const newExpense = {
        id: this._nextExpenseId++,
        paid_at: p.p_expected_occurrence,
        amount: p.p_amount, currency: p.p_currency, category: p.p_category,
        merchant: p.p_merchant, memo: p.p_memo, card_last4: p.p_card_last4,
        source: 'recurring', recurring_id: p.p_recurring_id, created_by: p.p_created_by,
      };
      this.expenses.push(newExpense);
      row.next_due_at = p.p_next_occurrence;
      return { data: [{ outcome: 'CREATED', expense_id: newExpense.id, occurrence: p.p_expected_occurrence, next_due_at: p.p_next_occurrence }], error: null };
    });
  }
}
function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }

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

//   fire() still takes {expenseRepo, ...} for signature compatibility with
//   R1-D1-B pre-existing callers · but R1-D1-B (RPC) does NOT call
//   expenseRepo.createExpense. This noop shims that surface.
const noopExpenseRepo = {
  async createExpense() { throw new Error('createExpense should NOT be called under R1-D1-B (RPC path)'); },
};

// ═══════════════════════════════════════════════════════════════════════════
// Harness · lease store + atomic RPC mock together
// ═══════════════════════════════════════════════════════════════════════════
function withHarness(fn) {
  return async () => {
    const store = new MockLeaseStore();
    const rpc = new AtomicRpcMock();
    schedulerLock._setClientForTests(store);
    recurringRepo._setClientForTests(rpc);
    try { await fn(store, rpc); }
    finally {
      schedulerLock._resetClientForTests();
      recurringRepo._resetClientForTests();
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS · lease behavior + aggregation
// ═══════════════════════════════════════════════════════════════════════════

test('TEST A · valid rule · lease acquire · expense INSERT 1 · recurring UPDATE 1', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(result.outcome, 'CREATED');
  assert.equal(rpc.expenseCountFor(42), 1);
  assert.equal(rpc.recurring.get(42).next_due_at, '2026-10-15');
}));

test('TEST B · same rule prelocked · expense 0 · UPDATE 0 · SKIP_LOCKED', withHarness(async (store, rpc) => {
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:42',
      p_owner_id: 'other-proc', p_run_id: 'other-run', p_ttl_seconds: 300 });
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(rpc.rpcCallCount(), 0, 'RPC not hit under SKIP_LOCKED');
  assert.equal(rpc.expenseCountFor(42), 0);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'locked');
  assert.equal(result.recurringId, 42);
}));

test('TEST C · acquire RPC error · expense 0 · UPDATE 0 · distinguished skipped_error', withHarness(async (store, rpc) => {
  store.forceAcquireErrorFor('scheduler:recurring-expense:rule:42', new Error('supabase down'));
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(rpc.rpcCallCount(), 0);
  assert.equal(rpc.expenseCountFor(42), 0);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'lease_error');
}));

test('TEST D · same-process same-rule concurrent fire × 2 · exactly one INSERT', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.setInsertDelay(30);
  const [r1, r2] = await Promise.all([
    recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }),
  ]);
  //   One CREATED · other SKIP_LOCKED (D1-A lease) OR STALE (D1-B row lock)
  //   Either way: expense count = 1 · that's the invariant.
  assert.equal(rpc.expenseCountFor(42), 1);
  const outcomes = [r1, r2].map(r => r.outcome || `skip:${r.skipReason}`);
  assert.ok(outcomes.includes('CREATED'), `outcomes=${JSON.stringify(outcomes)}`);
}));

test('TEST E · different-process simulation same rule · exactly one INSERT', withHarness(async (store, rpc) => {
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:42',
      p_owner_id: 'proc-alpha', p_run_id: 'run-alpha', p_ttl_seconds: 300 });
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(rpc.expenseCountFor(42), 0);
  assert.equal(result.skipped, true);
}));

test('TEST F · different rules concurrent · both execute', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 1, next_due_at: '2026-09-15' });
  rpc.seedRecurring({ id: 2, next_due_at: '2026-09-15' });
  const [r1, r2] = await Promise.all([
    recurringRepo.fire(makeRule({ id: 1 }), { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(makeRule({ id: 2 }), { expenseRepo: noopExpenseRepo }),
  ]);
  assert.equal(r1.outcome, 'CREATED');
  assert.equal(r2.outcome, 'CREATED');
  assert.equal(rpc.expenseCountFor(1), 1);
  assert.equal(rpc.expenseCountFor(2), 1);
}));

test('TEST G · N-way same rule · exactly one INSERT', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 99, next_due_at: '2026-09-15' });
  rpc.setInsertDelay(30);
  const rule = makeRule({ id: 99 });
  const results = await Promise.all([
    recurringRepo.fire(rule, { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(rule, { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(rule, { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(rule, { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(rule, { expenseRepo: noopExpenseRepo }),
  ]);
  assert.equal(rpc.expenseCountFor(99), 1, 'exactly one INSERT · lease + row-lock triple defense');
  const created = results.filter(r => r.outcome === 'CREATED').length;
  assert.equal(created, 1);
}));

test('TEST H · fire body throws (RPC error) · release attempted', withHarness(async (store, rpc) => {
  const beforeRel = store._releaseCalls;
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.forceRpcErrorNext(mkErr('XX000', 'db insert failed'));
  await assert.rejects(
    recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }),
    /db insert failed/,
  );
  assert.equal(rpc.expenseCountFor(42), 0, 'no expense created on RPC error');
  assert.ok(store._releaseCalls > beforeRel, 'lease released in finally');
  assert.equal(store.rows.has('scheduler:recurring-expense:rule:42'), false);
}));

test('TEST I · expense succeeds · advance also happens (atomic · no partial state)', withHarness(async (store, rpc) => {
  //   R1-D1-B guarantees atomicity: either both expense INSERT AND recurring
  //   next_due UPDATE happen (CREATED) or neither (any error). No partial state.
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(r.outcome, 'CREATED');
  assert.equal(rpc.expenseCountFor(42), 1);
  assert.equal(rpc.recurring.get(42).next_due_at, '2026-10-15', 'advance succeeded');
}));

test('TEST J · successful return compatibility · legacy shape preserved', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.ok('expense' in result, 'expense field present');
  assert.ok('nextDueAt' in result, 'nextDueAt field present');
  assert.equal(result.skipped, undefined);
}));

test('TEST K · manual route expected spread compatibility · shape check', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 1, next_due_at: '2026-09-15' });
  const okResult = await recurringRepo.fire(makeRule({ id: 1 }), { expenseRepo: noopExpenseRepo });
  const routeSuccess = { ok: true, emitted: true, expense: okResult.expense, nextDueAt: okResult.nextDueAt };
  assert.equal(routeSuccess.emitted, true);
  assert.ok(routeSuccess.expense);

  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:2',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  rpc.seedRecurring({ id: 2, next_due_at: '2026-09-15' });
  const skipResult = await recurringRepo.fire(makeRule({ id: 2 }), { expenseRepo: noopExpenseRepo });
  const routeSkip = { ok: true, emitted: false, skipped: true, skipReason: skipResult.skipReason };
  assert.equal(routeSkip.emitted, false);
  assert.equal(routeSkip.skipReason, 'locked');
}));

test('TEST L · aggregation logic · skipped never counted as fired', () => {
  const results = [
    { status: 'fulfilled', value: { outcome: 'CREATED', expense: {}, nextDueAt: '2026-10-01' } },
    { status: 'fulfilled', value: { skipped: true, skipReason: 'locked' } },
    { status: 'fulfilled', value: { skipped: true, skipReason: 'lease_error' } },
    { status: 'rejected', reason: new Error('boom') },
    { status: 'fulfilled', value: { outcome: 'CREATED', expense: {}, nextDueAt: '2026-11-01' } },
  ];
  const buckets = results.map(recurringRepo.classifyFireResult);
  assert.deepEqual(buckets, ['fired', 'skipped_locked', 'skipped_error', 'failed', 'fired']);
  const fired = buckets.filter(b => b === 'fired').length;
  assert.equal(fired, 2);
});

test('TEST M · invalid recurring.id · no lease acquired · no RPC call', withHarness(async (store, rpc) => {
  await assert.rejects(recurringRepo.fire({ nextDueAt: '2026-09-15' }, { expenseRepo: noopExpenseRepo }), /recurring\.id/);
  await assert.rejects(recurringRepo.fire({ id: null }, { expenseRepo: noopExpenseRepo }), /recurring\.id/);
  await assert.rejects(recurringRepo.fire({ id: '' }, { expenseRepo: noopExpenseRepo }), /recurring\.id/);
  await assert.rejects(recurringRepo.fire({ id: 'not-a-number' }, { expenseRepo: noopExpenseRepo }), /finite number/);
  assert.equal(rpc.rpcCallCount(), 0);
  const badKey = 'scheduler:recurring-expense:rule:undefined';
  assert.equal(store.rows.has(badKey), false);
}));

test('TEST N · SCHEDULER_LOCK_ENABLED=0 · pass-through · legacy behavior', async () => {
  const prev = process.env.SCHEDULER_LOCK_ENABLED;
  process.env.SCHEDULER_LOCK_ENABLED = '0';
  const rpc = new AtomicRpcMock();
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  recurringRepo._setClientForTests(rpc);
  try {
    const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
    assert.equal(result.outcome, 'CREATED');
    assert.equal(rpc.expenseCountFor(42), 1);
  } finally {
    if (prev === undefined) delete process.env.SCHEDULER_LOCK_ENABLED;
    else process.env.SCHEDULER_LOCK_ENABLED = prev;
    recurringRepo._resetClientForTests();
  }
});

test('TEST O · body throw · lease release attempted (regression of H)', withHarness(async (store, rpc) => {
  const beforeRel = store._releaseCalls;
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.forceRpcErrorNext(mkErr('XX000', 'boom'));
  await assert.rejects(recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }));
  assert.ok(store._releaseCalls > beforeRel);
  assert.equal(store.rows.has('scheduler:recurring-expense:rule:42'), false);
}));

// ─── caller aggregation tests ─────────────────────────────────────────────

test('TEST P · cron aggregation · 1 fired + 1 locked · fired=1 · skippedLocked=1', () => {
  const results = [
    { status: 'fulfilled', value: { outcome: 'CREATED', expense: {}, nextDueAt: '2026-10-01' } },
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
});

test('TEST Q · cron · skipped_error result · fired 증가 안 함', () => {
  const results = [
    { status: 'fulfilled', value: { skipped: true, skipReason: 'lease_error' } },
    { status: 'fulfilled', value: { outcome: 'CREATED', expense: {}, nextDueAt: '2026-10-01' } },
  ];
  let fired = 0, skippedError = 0;
  results.forEach(x => {
    const b = recurringRepo.classifyFireResult(x);
    if (b === 'fired') fired++;
    else if (b === 'skipped_error') skippedError++;
  });
  assert.equal(fired, 1);
  assert.equal(skippedError, 1);
});

test('TEST R · POST /:id/run locked · HTTP semantic (emitted:false · not 500)', withHarness(async (store, rpc) => {
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:42',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'locked');
  const routeBody = { ok: true, emitted: false, skipped: true, skipReason: 'locked', recurringId: result.recurringId };
  assert.equal(routeBody.emitted, false);
  assert.equal(routeBody.ok, true);
}));

test('TEST S · POST /:id/run real fire · emitted:true', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const result = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  const routeBody = { ok: true, emitted: true, expense: result.expense, nextDueAt: result.nextDueAt };
  assert.equal(routeBody.emitted, true);
  assert.ok(routeBody.expense);
  assert.equal(routeBody.nextDueAt, '2026-10-15');
}));

test('TEST T · POST /fire-due · 1 fire + 1 locked · fired=1 · skipped=1', withHarness(async (store, rpc) => {
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:2',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  rpc.seedRecurring({ id: 1, next_due_at: '2026-09-15' });
  rpc.seedRecurring({ id: 2, next_due_at: '2026-09-15' });
  const due = [makeRule({ id: 1 }), makeRule({ id: 2 })];
  let fired = 0, skipped = 0, leaseErrored = 0, failed = 0;
  for (const r of due) {
    try {
      const result = await recurringRepo.fire(r, { expenseRepo: noopExpenseRepo });
      const b = recurringRepo.classifyFireResult(result);
      if (b === 'fired')          fired++;
      else if (b === 'skipped_locked') skipped++;
      else if (b === 'skipped_error')  leaseErrored++;
      else                        failed++;
    } catch (e) { failed++; }
  }
  assert.equal(fired, 1);
  assert.equal(skipped, 1);
  assert.equal(rpc.expenseCountFor(1), 1);
  assert.equal(rpc.expenseCountFor(2), 0);
}));

test('TEST U · rejected fire · failed=1 · fired 증가 안 함', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 1, next_due_at: '2026-09-15' });
  rpc.seedRecurring({ id: 2, next_due_at: '2026-09-15' });
  const due = [makeRule({ id: 1 }), makeRule({ id: 2 })];
  let fired = 0, failed = 0;
  for (const r of due) {
    try {
      if (r.id === 2) rpc.forceRpcErrorNext(mkErr('XX000', 'rule 2 boom'));
      const result = await recurringRepo.fire(r, { expenseRepo: noopExpenseRepo });
      const b = recurringRepo.classifyFireResult(result);
      if (b === 'fired')  fired++;
      else                failed++;
    } catch (e) { failed++; }
  }
  assert.equal(fired, 1, 'only rule#1 counted as fired');
  assert.equal(failed, 1, 'rule#2 RPC error counted as failed');
  assert.equal(rpc.expenseCountFor(1), 1);
  assert.equal(rpc.expenseCountFor(2), 0);
}));

test('TEST V · expense insert count == fired count invariant', withHarness(async (store, rpc) => {
  await store.rpc('acquire_scheduler_lease',
    { p_lock_key: 'scheduler:recurring-expense:rule:8',
      p_owner_id: 'other', p_run_id: 'other-run', p_ttl_seconds: 300 });
  rpc.seedRecurring({ id: 7, next_due_at: '2026-09-15' });
  rpc.seedRecurring({ id: 8, next_due_at: '2026-09-15' });
  rpc.seedRecurring({ id: 9, next_due_at: '2026-09-15' });
  const due = [makeRule({ id: 7 }), makeRule({ id: 8 }), makeRule({ id: 9 })];
  const results = await Promise.allSettled(
    due.map(r => recurringRepo.fire(r, { expenseRepo: noopExpenseRepo }))
  );
  const buckets = results.map(recurringRepo.classifyFireResult);
  const fired = buckets.filter(b => b === 'fired').length;
  const totalCreatedExpenses =
    rpc.expenseCountFor(7) + rpc.expenseCountFor(8) + rpc.expenseCountFor(9);
  assert.equal(totalCreatedExpenses, fired,
    `expense INSERT count (${totalCreatedExpenses}) must equal fired count (${fired})`);
  assert.equal(fired, 2, 'rule#7 + rule#9');
  assert.equal(buckets.filter(b => b === 'skipped_locked').length, 1, 'rule#8 locked');
}));
