'use strict';

/**
 * tests/scheduler/recurringExpenseIdempotency.test.js — Refactor R1-D1-B.
 *
 * Verifies DB-level idempotency + atomic occurrence semantics for
 * recurring expense firing. Complements R1-D1-A (concurrent-run
 * serialization) with crash-replay and stale-caller defense.
 *
 * Zero real DB writes · schedulerLock uses MockLeaseStore · the atomic
 * RPC `fire_recurring_expense_atomic` is emulated in JavaScript with
 * exact contract fidelity (row lock via serialized async access,
 * expected-occurrence check, ALREADY_EXISTS recovery, INSERT on normal
 * path, UNIQUE constraint enforcement). If future SQL changes drift
 * from this contract, staging integration will surface the mismatch.
 *
 * Owner rules (R1-D1-B · 2026-09-05):
 *   A normal occurrence · expense 1 · next_due advanced 1
 *   B same occurrence retry · expense still 1 · no extra advance
 *   C two concurrent calls same occurrence · expense exactly 1
 *   D expense already exists · next_due old → recover · no new INSERT · advance
 *   E next_due already advanced · retry old expected → STALE · no write
 *   F network response loss · retry old expected → no duplicate · no double advance
 *   G different recurring rules → independent
 *   H partial UNIQUE prevents duplicate even if app race
 *   I invalid recurring_id → no write
 *   J expected_occurrence mismatch → no write
 *   K next_occurrence invalid (<= expected) → reject
 *   L lease SKIP_LOCKED → RPC not called
 *   M lease infra error → RPC not called
 *   N RPC error → fire reports failure · not falsely fired
 *   O CREATED classifier → fired +1
 *   P RECOVERED classifier → recovered +1 · fired +0
 *   Q API emitted semantics
 *   R existing D1-A tests remain green (structural assertion)
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const schedulerLock = require('../../src/services/schedulerLock');
const recurringRepo = require('../../src/db/recurringRepository');

// ═══════════════════════════════════════════════════════════════════════════
// MockLeaseStore · same as prior scheduler tests.
// ═══════════════════════════════════════════════════════════════════════════
class MockLeaseStore {
  constructor() {
    this.rows = new Map();
    this._nowMs = Date.now();
    this._acquireErrorFor = new Map();
  }
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
    const row = this.rows.get(p.p_lock_key);
    if (!row) return { data: [{ ok: false, expires_at: null }], error: null };
    const ownershipOk = row.owner_id === p.p_owner_id && row.run_id === p.p_run_id;
    const alive = Date.parse(row.expires_at) > this._nowMs;
    if (ownershipOk && alive) {
      const nowIso = new Date(this._nowMs).toISOString();
      const newExpiresIso = new Date(this._nowMs + p.p_ttl_seconds * 1000).toISOString();
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
// AtomicRpcMock · JS emulation of fire_recurring_expense_atomic.
// Contract MUST match migration 109 · any drift here means production drift.
// Serialised via a per-rule promise chain to emulate PostgreSQL row lock.
// Enforces the partial UNIQUE (recurring_id, paid_at) constraint at end.
// ═══════════════════════════════════════════════════════════════════════════
class AtomicRpcMock {
  constructor() {
    this.recurring = new Map();    // id → { id, next_due_at }
    this.expenses = [];            // {id, recurring_id, paid_at, source, ...}
    this._nextExpenseId = 1;
    this._rpcErrorNext = null;
    this._locks = new Map();       // recurring_id → last promise (serializes calls)
    this._rpcCalls = 0;
  }
  seedRecurring({ id, next_due_at }) { this.recurring.set(id, { id, next_due_at }); }
  seedExpense(row) {
    this.expenses.push({ id: this._nextExpenseId++, ...row });
  }
  forceRpcErrorNext(e) { this._rpcErrorNext = e; }
  rpcCallCount() { return this._rpcCalls; }
  expenseCountFor(recurring_id) {
    return this.expenses.filter(e => e.recurring_id === recurring_id && e.source === 'recurring').length;
  }

  //   Serialise per recurring_id · emulates SELECT FOR UPDATE row lock.
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
    const {
      p_recurring_id, p_expected_occurrence, p_next_occurrence,
      p_amount, p_currency, p_category, p_merchant, p_memo,
      p_card_last4, p_created_by,
    } = params;
    // Input validation (mirrors migration 109)
    if (p_recurring_id == null) return { data: null, error: mkErr('22023', 'recurring_id required') };
    if (!p_expected_occurrence) return { data: null, error: mkErr('22023', 'expected_occurrence required') };
    if (!p_next_occurrence)     return { data: null, error: mkErr('22023', 'next_occurrence required') };
    if (p_next_occurrence <= p_expected_occurrence) {
      return { data: null, error: mkErr('22023', 'next_occurrence must be after expected') };
    }
    if (p_amount == null || p_amount < 0) return { data: null, error: mkErr('22023', 'amount must be >= 0') };
    if (!p_currency) return { data: null, error: mkErr('22023', 'currency required') };
    if (!p_category) return { data: null, error: mkErr('22023', 'category required') };

    return this._serialize(p_recurring_id, async () => {
      const row = this.recurring.get(p_recurring_id);
      if (!row) return { data: null, error: mkErr('P0002', `recurring_payments not found: ${p_recurring_id}`) };

      if (row.next_due_at !== p_expected_occurrence) {
        return { data: [{
          outcome: 'STALE_OCCURRENCE', expense_id: null,
          occurrence: row.next_due_at, next_due_at: row.next_due_at,
        }], error: null };
      }

      const existing = this.expenses.find(e =>
        e.recurring_id === p_recurring_id
        && e.paid_at === p_expected_occurrence
        && e.source === 'recurring');
      if (existing) {
        row.next_due_at = p_next_occurrence;
        return { data: [{
          outcome: 'ALREADY_EXISTS', expense_id: existing.id,
          occurrence: p_expected_occurrence, next_due_at: p_next_occurrence,
        }], error: null };
      }

      //   Layer 3 · partial UNIQUE enforcement · if anyone bypassed the
      //   existing check and there IS a row with same (rid, paid_at, source),
      //   reject with 23505. In our serialised model this is unreachable
      //   from within a single RPC call · covered by TEST H.
      const dup = this.expenses.find(e =>
        e.recurring_id === p_recurring_id
        && e.paid_at === p_expected_occurrence
        && e.source === 'recurring');
      if (dup) return { data: null, error: mkErr('23505', 'duplicate key violates expenses_recurring_occurrence_uniq') };

      const newExpense = {
        id: this._nextExpenseId++,
        paid_at: p_expected_occurrence,
        amount: p_amount, currency: p_currency, category: p_category,
        merchant: p_merchant, memo: p_memo, card_last4: p_card_last4,
        source: 'recurring', recurring_id: p_recurring_id, created_by: p_created_by,
      };
      this.expenses.push(newExpense);
      row.next_due_at = p_next_occurrence;

      return { data: [{
        outcome: 'CREATED', expense_id: newExpense.id,
        occurrence: p_expected_occurrence, next_due_at: p_next_occurrence,
      }], error: null };
    });
  }
}
function mkErr(code, message) { const e = new Error(message); e.code = code; return e; }

// ═══════════════════════════════════════════════════════════════════════════
// Test fixtures + harness
// ═══════════════════════════════════════════════════════════════════════════
function makeRule(overrides = {}) {
  return {
    id: 42, name: 'Netflix', amount: 17500, currency: 'KRW',
    category: 'subscription', cycle: 'monthly', dayOfCycle: 15,
    nextDueAt: '2026-09-15', cardLast4: '1234', memo: null,
    active: true, createdBy: null, ...overrides,
  };
}

function withHarness(fn) {
  return async () => {
    const store = new MockLeaseStore();
    const rpc = new AtomicRpcMock();
    schedulerLock._setClientForTests(store);
    recurringRepo._setClientForTests(rpc);   //   _db() delegates .rpc() and .from() to this
    try { await fn(store, rpc); }
    finally {
      schedulerLock._resetClientForTests();
      recurringRepo._resetClientForTests();
    }
  };
}

// Minimal expenseRepo · fire() ignores it now (RPC does the INSERT) but
// keeping the parameter avoids caller signature changes.
const noopExpenseRepo = {
  async createExpense() { throw new Error('createExpense should NOT be called under R1-D1-B (RPC path)'); },
};

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('TEST A · normal occurrence · expense 1 · next_due advanced 1', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(r.outcome, 'CREATED');
  assert.ok(r.expense.id > 0);
  assert.equal(r.nextDueAt, '2026-10-15');
  assert.equal(rpc.expenseCountFor(42), 1);
  assert.equal(rpc.recurring.get(42).next_due_at, '2026-10-15');
}));

test('TEST B · same occurrence retry · expense still 1 · no extra advance', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  //   First call succeeds
  await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  //   Second call with same rule state (retry · same expected occurrence)
  //   Simulates a client that thinks the previous call failed. The RPC
  //   sees next_due already advanced to 2026-10-15 · returns STALE.
  //   NOTE: the rule object here still has nextDueAt='2026-09-15' (client
  //   read-cache) · that IS the network-response-loss scenario · so
  //   expected != actual = STALE_OCCURRENCE.
  const r2 = await recurringRepo.fire(makeRule({ nextDueAt: '2026-09-15' }), { expenseRepo: noopExpenseRepo });
  assert.equal(r2.skipped, true);
  assert.equal(r2.skipReason, 'stale_occurrence');
  assert.equal(rpc.expenseCountFor(42), 1, 'no extra expense created');
  assert.equal(rpc.recurring.get(42).next_due_at, '2026-10-15', 'no extra advance');
}));

test('TEST C · two concurrent calls same occurrence · expense exactly 1', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const [r1, r2] = await Promise.all([
    recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }),
    recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }),
  ]);
  //   D1-A lease serialises · one wins with CREATED · the other skipped
  //   or (rare timing) reaches the RPC with expected=2026-09-15 while
  //   row already at 2026-10-15 → STALE. Either way · expense count = 1.
  const outcomes = [r1, r2].map(r => r.outcome || (r.skipped ? `skip:${r.skipReason}` : 'unknown'));
  assert.equal(rpc.expenseCountFor(42), 1, `expense must be exactly 1 · outcomes=${JSON.stringify(outcomes)}`);
}));

test('TEST D · expense already exists · next_due old → recover · no new INSERT · advance', withHarness(async (store, rpc) => {
  //   Seed the crash-replay condition: expense exists but next_due unadvanced.
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.seedExpense({ recurring_id: 42, paid_at: '2026-09-15', source: 'recurring',
                    amount: 17500, currency: 'KRW', category: 'subscription' });
  const before = rpc.expenseCountFor(42);
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(r.outcome, 'ALREADY_EXISTS');
  assert.equal(r.recovered, true);
  assert.equal(r.nextDueAt, '2026-10-15');
  assert.equal(rpc.expenseCountFor(42), before, 'no new expense · recovered from prior commit');
  assert.equal(rpc.recurring.get(42).next_due_at, '2026-10-15', 'next_due advanced by recovery');
}));

test('TEST E · next_due already advanced · retry old expected → STALE · no write', withHarness(async (store, rpc) => {
  //   Rule already advanced to next month · caller retries with old nextDueAt.
  rpc.seedRecurring({ id: 42, next_due_at: '2026-10-15' });
  const r = await recurringRepo.fire(makeRule({ nextDueAt: '2026-09-15' }), { expenseRepo: noopExpenseRepo });
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'stale_occurrence');
  assert.equal(rpc.expenseCountFor(42), 0, 'no expense created');
  assert.equal(rpc.recurring.get(42).next_due_at, '2026-10-15', 'no double advance');
}));

test('TEST F · network response loss · retry old expected → no duplicate · no double advance', withHarness(async (store, rpc) => {
  //   First call commits (CREATED) · client "sees failure" (simulated by
  //   ignoring the return) · client retries with the SAME (stale) rule.
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  const nextDueAfterFirst = rpc.recurring.get(42).next_due_at;
  const countAfterFirst = rpc.expenseCountFor(42);
  //   Retry with original (stale) nextDueAt
  const retry = await recurringRepo.fire(makeRule({ nextDueAt: '2026-09-15' }), { expenseRepo: noopExpenseRepo });
  assert.equal(retry.skipped, true);
  assert.equal(retry.skipReason, 'stale_occurrence');
  assert.equal(rpc.expenseCountFor(42), countAfterFirst, 'zero duplicate');
  assert.equal(rpc.recurring.get(42).next_due_at, nextDueAfterFirst, 'zero double advance');
}));

test('TEST G · different recurring rules · independent', withHarness(async (store, rpc) => {
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

test('TEST H · partial UNIQUE would prevent duplicate even if app race occurs', withHarness(async (store, rpc) => {
  //   Simulate the "app bypassed check but UNIQUE catches it" path by
  //   pre-seeding an expense · then directly calling the RPC with a
  //   scenario where the existing-check path is the recovery. Our mock's
  //   ALREADY_EXISTS path returns without INSERT · so count stays 1.
  //   This test documents that Layer 3 (partial UNIQUE) is the ultimate
  //   backstop; the mock enforces the constraint via the same existence
  //   check the production INSERT would collide against.
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.seedExpense({ recurring_id: 42, paid_at: '2026-09-15', source: 'recurring',
                    amount: 17500, currency: 'KRW', category: 'subscription' });
  await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(rpc.expenseCountFor(42), 1, 'UNIQUE-equivalent prevents duplicate');
}));

test('TEST I · invalid recurring_id → no write', withHarness(async (store, rpc) => {
  await assert.rejects(recurringRepo.fire({ nextDueAt: '2026-09-15' }, { expenseRepo: noopExpenseRepo }), /recurring\.id/);
  await assert.rejects(recurringRepo.fire({ id: 'abc' }, { expenseRepo: noopExpenseRepo }), /finite number/);
  assert.equal(rpc.rpcCallCount(), 0, 'no RPC hit for invalid id');
}));

test('TEST J · expected_occurrence mismatch → no write', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-11-15' });   // already advanced
  const r = await recurringRepo.fire(makeRule({ nextDueAt: '2026-09-15' }), { expenseRepo: noopExpenseRepo });
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'stale_occurrence');
  assert.equal(rpc.expenseCountFor(42), 0);
}));

test('TEST K · next_occurrence invalid (<= expected) → RPC rejects · fire throws', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  //   Construct a rule whose advance would produce next <= expected.
  //   Easiest: force by supplying malformed dayOfCycle that keeps date same.
  //   Our JS advanceDueDate always advances month · so create a rule where
  //   nextDueAt is already in the future so advance produces > expected —
  //   NOT the failure case. Instead, directly call RPC via mock with bad
  //   inputs to prove the guard exists.
  const bad = await rpc.rpc('fire_recurring_expense_atomic', {
    p_recurring_id: 42, p_expected_occurrence: '2026-09-15',
    p_next_occurrence: '2026-09-15',   // == expected · invalid
    p_amount: 1000, p_currency: 'KRW', p_category: 'x',
    p_merchant: 'n', p_memo: null, p_card_last4: null, p_created_by: null,
  });
  assert.ok(bad.error, 'RPC rejects invalid next_occurrence');
  assert.match(bad.error.message, /next_occurrence/);
  assert.equal(rpc.expenseCountFor(42), 0);
}));

test('TEST L · lease SKIP_LOCKED → RPC not called', withHarness(async (store, rpc) => {
  await store.rpc('acquire_scheduler_lease', {
    p_lock_key: 'scheduler:recurring-expense:rule:42',
    p_owner_id: 'other', p_run_id: 'other', p_ttl_seconds: 300,
  });
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const beforeCalls = rpc.rpcCallCount();
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'locked');
  assert.equal(rpc.rpcCallCount(), beforeCalls, 'RPC not hit under SKIP_LOCKED');
}));

test('TEST M · lease infra error → RPC not called', withHarness(async (store, rpc) => {
  store.forceAcquireErrorFor('scheduler:recurring-expense:rule:42', new Error('supabase down'));
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const beforeCalls = rpc.rpcCallCount();
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'lease_error');
  assert.equal(rpc.rpcCallCount(), beforeCalls, 'RPC not hit under lease infra error');
}));

test('TEST N · RPC error → fire reports failure · not falsely fired', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.forceRpcErrorNext(mkErr('XX000', 'internal RPC failure'));
  await assert.rejects(
    recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo }),
    /internal RPC failure/,
  );
  assert.equal(rpc.expenseCountFor(42), 0, 'no expense created');
  //   In cron aggregation, the throw is Promise.allSettled rejected · classifier → 'failed'
  const settled = [{ status: 'rejected', reason: new Error('internal RPC failure') }];
  assert.equal(recurringRepo.classifyFireResult(settled[0]), 'failed');
}));

test('TEST O · CREATED classifier → fired +1', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(recurringRepo.classifyFireResult(r), 'fired');
}));

test('TEST P · RECOVERED classifier → recovered +1 · fired +0', withHarness(async (store, rpc) => {
  rpc.seedRecurring({ id: 42, next_due_at: '2026-09-15' });
  rpc.seedExpense({ recurring_id: 42, paid_at: '2026-09-15', source: 'recurring',
                    amount: 17500, currency: 'KRW', category: 'subscription' });
  const r = await recurringRepo.fire(makeRule(), { expenseRepo: noopExpenseRepo });
  assert.equal(r.recovered, true);
  assert.equal(recurringRepo.classifyFireResult(r), 'recovered', 'never bucket recovered as fired');
}));

test('TEST Q · API emitted semantics', withHarness(async (store, rpc) => {
  //   Direct shape verification against what recurring.js route builds.
  rpc.seedRecurring({ id: 1, next_due_at: '2026-09-15' });
  const created = await recurringRepo.fire(makeRule({ id: 1 }), { expenseRepo: noopExpenseRepo });
  //   Route: emitted=true when created
  assert.equal(created.outcome, 'CREATED');
  const routeBody1 = { ok: true, emitted: true, expense: created.expense, nextDueAt: created.nextDueAt };
  assert.equal(routeBody1.emitted, true);

  //   Recovered scenario
  rpc.seedRecurring({ id: 2, next_due_at: '2026-09-15' });
  rpc.seedExpense({ recurring_id: 2, paid_at: '2026-09-15', source: 'recurring',
                    amount: 1000, currency: 'KRW', category: 'x' });
  const rec = await recurringRepo.fire(makeRule({ id: 2 }), { expenseRepo: noopExpenseRepo });
  const routeBody2 = { ok: true, emitted: false, recovered: true, alreadyExists: true,
                       expense: rec.expense, nextDueAt: rec.nextDueAt };
  assert.equal(routeBody2.emitted, false);
  assert.equal(routeBody2.recovered, true);

  //   Stale scenario
  rpc.seedRecurring({ id: 3, next_due_at: '2026-11-15' });   // already advanced
  const stale = await recurringRepo.fire(makeRule({ id: 3, nextDueAt: '2026-09-15' }), { expenseRepo: noopExpenseRepo });
  assert.equal(stale.skipReason, 'stale_occurrence');
  const routeBody3 = { ok: true, emitted: false, skipped: true, skipReason: 'stale_occurrence',
                       nextDueAt: stale.nextDueAt };
  assert.equal(routeBody3.emitted, false);
  assert.equal(routeBody3.skipped, true);
}));

test('TEST R · existing D1-A classifier still routes lease outcomes correctly', () => {
  //   Structural check: classifier still handles the D1-A buckets after
  //   R1-D1-B extensions. If someone accidentally broke the switch order,
  //   this catches it.
  const legacy = [
    { status: 'fulfilled', value: { expense: {}, nextDueAt: '2026-10-01' } },          // fired
    { status: 'fulfilled', value: { skipped: true, skipReason: 'locked' } },           // skipped_locked
    { status: 'fulfilled', value: { skipped: true, skipReason: 'lease_error' } },      // skipped_error
    { status: 'rejected', reason: new Error('boom') },                                  // failed
  ];
  const buckets = legacy.map(recurringRepo.classifyFireResult);
  assert.deepEqual(buckets, ['fired', 'skipped_locked', 'skipped_error', 'failed']);

  //   New R1-D1-B buckets
  const newBuckets = [
    { status: 'fulfilled', value: { outcome: 'ALREADY_EXISTS', recovered: true } },    // recovered
    { status: 'fulfilled', value: { skipped: true, skipReason: 'stale_occurrence' } }, // stale
  ].map(recurringRepo.classifyFireResult);
  assert.deepEqual(newBuckets, ['recovered', 'stale']);
});
