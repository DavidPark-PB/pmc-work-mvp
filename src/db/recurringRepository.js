/**
 * recurring_payments — 정기결제 (월간/연간) 관리.
 * 매일 스케줄러가 `next_due_at <= today AND active` 인 행을
 * expenses 테이블에 insert하고 next_due_at을 다음 주기로 전진.
 */
const { getClient } = require('./supabaseClient');
const { normalize } = require('../services/expenseCategories');
const { withLease } = require('../services/schedulerLock');

//   R1-D1-A (2026-09-05) · concurrent-run serialization.
//   Test hook · lets unit tests inject a fake Supabase client for `update()`
//   without going through the real DB. Only wired into fire()'s downstream
//   update() path so production code paths (list/create/getById/etc.) keep
//   the real singleton.
let _clientForTests = null;
function _setClientForTests(c) { _clientForTests = c; }
function _resetClientForTests() { _clientForTests = null; }
function _db() { return _clientForTests || getClient(); }

//   R1-D1-A · per-rule lease config. Conservative TTL/heartbeat matches
//   R1-C1 baseline · prefer avoiding false takeover over faster crash
//   recovery. fire() critical section is short (~500ms typical) but
//   300s absorbs Railway pauses and any Supabase retry.
const LEASE_KEY_PREFIX      = 'scheduler:recurring-expense:rule:';
const LEASE_TTL_SEC         = 300;
const LEASE_HEARTBEAT_SEC   = 30;

/**
 * R1-D1-A/B · classify a fire() outcome (from Promise.allSettled OR a raw
 * fire() return value) into one aggregation bucket. Both cron aggregation
 * (scheduler.js) and per-rule route accumulation (route.js /fire-due)
 * call this so the aggregation stays consistent across callers and is
 * testable in one place.
 *
 * Buckets:
 *   'fired'          · new expense INSERT + recurring UPDATE done (RPC CREATED)
 *   'recovered'      · prior committed occurrence found · schedule advanced ·
 *                      NO new expense created (RPC ALREADY_EXISTS · crash-replay
 *                      recovery). Truthful count for the finance dashboard:
 *                      never bucket recovered as fired.
 *   'skipped_locked' · another instance/run held the lease · nothing written
 *   'skipped_error'  · lease infra RPC error · nothing written (fail-closed)
 *   'stale'          · caller's expected occurrence no longer matches the
 *                      recurring row's next_due_at (RPC STALE_OCCURRENCE) ·
 *                      another actor already advanced the schedule
 *   'failed'         · fire() body threw · rejected promise · partial state
 *                      may exist (though the RPC transaction is atomic)
 */
function classifyFireResult(x) {
  if (x && x.status === 'rejected') return 'failed';
  const v = (x && x.status === 'fulfilled') ? x.value : x;
  if (!v) return 'failed';
  if (v.skipped) {
    if (v.skipReason === 'lease_error')      return 'skipped_error';
    if (v.skipReason === 'stale_occurrence') return 'stale';
    return 'skipped_locked';
  }
  //   R1-D1-B · ALREADY_EXISTS is a real recovery outcome · MUST NOT be
  //   counted as a fresh emission.
  if (v.outcome === 'ALREADY_EXISTS' || v.recovered === true) return 'recovered';
  return 'fired';
}

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '정기결제 DB 마이그레이션이 적용되지 않았습니다 (013).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /recurring_payments/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    currency: row.currency,
    category: row.category,
    cycle: row.cycle,
    dayOfCycle: row.day_of_cycle,
    nextDueAt: row.next_due_at,
    cardLast4: row.card_last4,
    memo: row.memo,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toIsoDate(d) {
  // 로컬 타임존 기준 YYYY-MM-DD (toISOString은 UTC로 변환해 날짜가 어긋남)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * dayOfCycle 기준으로 기준일 이후 첫 결제일을 계산.
 *  - monthly: fromDate의 다음 달 dayOfCycle 일 (같은 달이어도 dayOfCycle이 미래면 그 날짜)
 *  - yearly: dayOfCycle을 연중 순번(1~366)처럼 취급하지 않고 "매년 같은 월·일" 해석.
 *     간결한 구현: 현재 연도의 1월 dayOfCycle일(월 고정이 없으니 임의) — 복잡하므로 월간만 주로 쓰고
 *     연간은 cycle 저장 용도. 초기엔 dayOfCycle을 day-of-month로 통일.
 */
function computeFirstDueAt({ cycle = 'monthly', dayOfCycle = 1, fromDate = new Date() } = {}) {
  const dom = Math.min(Math.max(parseInt(dayOfCycle, 10) || 1, 1), 28); // 안전하게 1~28
  const now = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  if (cycle === 'yearly') {
    // 이번 연도 dayOfCycle일이 이미 지났으면 내년.
    const thisYear = new Date(now.getFullYear(), 0, dom);
    if (thisYear < now) thisYear.setFullYear(thisYear.getFullYear() + 1);
    return toIsoDate(thisYear);
  }
  // monthly
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), dom);
  if (thisMonth < now) thisMonth.setMonth(thisMonth.getMonth() + 1);
  return toIsoDate(thisMonth);
}

function advanceDueDate(currentIso, cycle, dayOfCycle) {
  const d = new Date(currentIso + 'T00:00:00');
  const dom = Math.min(Math.max(parseInt(dayOfCycle, 10) || 1, 1), 28);
  if (cycle === 'yearly') {
    d.setFullYear(d.getFullYear() + 1);
    d.setMonth(0, dom);
  } else {
    d.setMonth(d.getMonth() + 1, dom);
  }
  return toIsoDate(d);
}

async function list({ activeOnly = false } = {}) {
  let q = getClient().from('recurring_payments').select('*')
    .order('next_due_at', { ascending: true });
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('recurring_payments')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function create({ name, amount, currency = 'KRW', category, cycle = 'monthly', dayOfCycle = 1, cardLast4, memo, active = true, createdBy }) {
  if (!name?.trim()) throw new Error('이름을 입력하세요');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('금액을 입력하세요');
  const nextDueAt = computeFirstDueAt({ cycle, dayOfCycle });
  const { data, error } = await getClient().from('recurring_payments').insert({
    name: name.trim().slice(0, 200),
    amount: Number(amount),
    currency: (currency || 'KRW').toUpperCase().slice(0, 4),
    category: normalize(category),
    cycle: cycle === 'yearly' ? 'yearly' : 'monthly',
    day_of_cycle: Math.min(Math.max(parseInt(dayOfCycle, 10) || 1, 1), 28),
    next_due_at: nextDueAt,
    card_last4: cardLast4 ? String(cardLast4).slice(-4) : null,
    memo: memo?.trim() || null,
    active: !!active,
    created_by: createdBy || null,
  }).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function update(id, updates) {
  const patch = {};
  if (updates.name !== undefined) patch.name = String(updates.name).trim().slice(0, 200);
  if (updates.amount !== undefined) patch.amount = Number(updates.amount);
  if (updates.currency !== undefined) patch.currency = String(updates.currency).toUpperCase().slice(0, 4);
  if (updates.category !== undefined) patch.category = normalize(updates.category);
  if (updates.cycle !== undefined) patch.cycle = updates.cycle === 'yearly' ? 'yearly' : 'monthly';
  if (updates.dayOfCycle !== undefined) patch.day_of_cycle = Math.min(Math.max(parseInt(updates.dayOfCycle, 10) || 1, 1), 28);
  if (updates.cardLast4 !== undefined) patch.card_last4 = updates.cardLast4 ? String(updates.cardLast4).slice(-4) : null;
  if (updates.memo !== undefined) patch.memo = (updates.memo || '').trim() || null;
  if (updates.active !== undefined) patch.active = !!updates.active;
  if (updates.nextDueAt !== undefined) patch.next_due_at = updates.nextDueAt;
  if (Object.keys(patch).length === 0) throw new Error('변경할 내용이 없습니다');

  // 주기·결제일 변경 시 next_due_at 재계산
  if (patch.cycle !== undefined || patch.day_of_cycle !== undefined) {
    if (patch.next_due_at === undefined) {
      const existing = await getById(id);
      const cycle = patch.cycle || existing.cycle;
      const dom = patch.day_of_cycle != null ? patch.day_of_cycle : existing.dayOfCycle;
      patch.next_due_at = computeFirstDueAt({ cycle, dayOfCycle: dom });
    }
  }

  //   R1-D1-A · route through _db() so unit tests can inject a fake client
  //   for fire()'s downstream update. Production behavior identical: _db()
  //   returns getClient() when no test override is set.
  const { data, error } = await _db().from('recurring_payments')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id) {
  const { error } = await getClient().from('recurring_payments').delete().eq('id', id);
  if (error) throwFriendly(error);
}

/**
 * 오늘 시점에 지불일이 지난 active 정기결제들을 반환.
 */
async function listDue({ asOf = new Date() } = {}) {
  const today = toIsoDate(asOf);
  const { data, error } = await getClient().from('recurring_payments').select('*')
    .eq('active', true).lte('next_due_at', today);
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

/**
 * 정기결제 1건을 expense로 발행 + next_due_at 전진.
 * expenseRepo.createExpense는 rowCount 등 부가처리 포함.
 *
 * R1-D1-A (2026-09-05) · per-rule distributed lease.
 *   Every fire() call — from the 03:00 cron, POST /:id/run, or POST
 *   /fire-due — acquires `scheduler:recurring-expense:rule:${id}` before
 *   touching expenses. During a Railway rolling deploy two Node processes
 *   overlap for a window and previously both would INSERT the same
 *   expense row for the same recurring rule. This lease prevents that.
 *
 *   IMPORTANT: this is CONCURRENT-RUN serialization only. Crash-replay
 *   (expense INSERT succeeds → recurring UPDATE fails → next run fires
 *   the same expense again) is NOT solved here. That is D1-B, which
 *   will add a partial UNIQUE index and ON CONFLICT handling in
 *   expenses. Do NOT describe this commit as "exactly-once".
 *
 * Return shape:
 *   success (fire ran):
 *     { expense, nextDueAt }                      — legacy shape preserved
 *   SKIP_LOCKED (another instance holds the lease):
 *     { skipped: true, skipReason: 'locked', recurringId }
 *   lease infra failure (RPC unreachable etc.):
 *     { skipped: true, skipReason: 'lease_error', recurringId, error }
 *
 *   Callers MUST inspect `skipped` before counting as an emitted
 *   expense. classifyFireResult() bins these correctly.
 */
async function fire(recurring, { expenseRepo, asOf = new Date() }) {
  //   Validate rule id BEFORE constructing the lock key. An undefined/null/
  //   empty id would produce the shared key
  //   `scheduler:recurring-expense:rule:undefined` and let two rules with
  //   missing ids block each other. Fail fast, before any DB call.
  if (recurring == null || recurring.id == null || recurring.id === '') {
    throw new Error('recurring.id required for fire()');
  }
  const numericId = Number(recurring.id);
  if (!Number.isFinite(numericId)) {
    throw new Error(`recurring.id must be a finite number (got ${JSON.stringify(recurring.id)})`);
  }
  const lockKey = `${LEASE_KEY_PREFIX}${numericId}`;

  const leaseResult = await withLease(
    lockKey,
    {
      ttlSec: LEASE_TTL_SEC,
      heartbeatSec: LEASE_HEARTBEAT_SEC,
      failPolicy: 'closed',   // money-facing · never run without a lease
    },
    async (_ctx) => {
      //   R1-D1-B · replace the previous two-statement flow (INSERT expense
      //   → UPDATE recurring) with a single atomic RPC call. The RPC locks
      //   the recurring_payments row, validates expected occurrence, checks
      //   for a prior committed occurrence (crash-replay recovery), then
      //   INSERTs + advances in ONE transaction. Layer 3 partial UNIQUE
      //   index is the final backstop if this path is somehow bypassed.
      //
      //   Schedule calculation SoT stays in JS · we pass the expected
      //   current occurrence AND the pre-computed next occurrence · RPC
      //   only validates, does not derive.
      const expectedOccurrence = recurring.nextDueAt;
      const nextOccurrence = advanceDueDate(
        recurring.nextDueAt, recurring.cycle, recurring.dayOfCycle
      );

      const { data, error } = await _db().rpc('fire_recurring_expense_atomic', {
        p_recurring_id:        Number(recurring.id),
        p_expected_occurrence: expectedOccurrence,
        p_next_occurrence:     nextOccurrence,
        p_amount:              Number(recurring.amount),
        p_currency:            recurring.currency || 'KRW',
        p_category:            recurring.category || 'uncategorized',
        p_merchant:            recurring.name || null,
        p_memo:                recurring.memo || null,
        p_card_last4:          recurring.cardLast4 || null,
        p_created_by:          recurring.createdBy || null,
      });
      if (error) throwFriendly(error);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('fire_recurring_expense_atomic returned empty result');

      //   Legacy expense shape · enough for observability · callers only
      //   read id/paid_at in current code.
      const expenseStub = row.expense_id != null ? {
        id:           row.expense_id,
        paid_at:      row.occurrence,
        amount:       Number(recurring.amount),
        currency:     recurring.currency || 'KRW',
        category:     recurring.category || 'uncategorized',
        merchant:     recurring.name || null,
        source:       'recurring',
        recurring_id: recurring.id,
      } : null;

      if (row.outcome === 'CREATED') {
        return {
          expense: expenseStub,
          nextDueAt: row.next_due_at,
          outcome: 'CREATED',
        };
      }
      if (row.outcome === 'ALREADY_EXISTS') {
        //   Crash-replay recovery · schedule advanced · no new expense.
        //   The `expense` field points at the pre-existing row so callers
        //   still get a valid reference · `recovered: true` flags the
        //   distinction · classifyFireResult buckets this as 'recovered'.
        return {
          expense: expenseStub,
          nextDueAt: row.next_due_at,
          outcome: 'ALREADY_EXISTS',
          recovered: true,
        };
      }
      if (row.outcome === 'STALE_OCCURRENCE') {
        //   Another actor already advanced the schedule since we read the
        //   rule. Nothing to do. Truthful skip · not a failure.
        return {
          skipped: true,
          skipReason: 'stale_occurrence',
          recurringId: recurring.id,
          nextDueAt: row.next_due_at,
        };
      }
      //   Unknown outcome · treat as failure so caller does not falsely
      //   report success. Should never happen given the RPC contract.
      throw new Error(`fire_recurring_expense_atomic unexpected outcome: ${row.outcome}`);
    }
  );

  if (leaseResult.ran && leaseResult.value) {
    //   Legacy success shape preserved verbatim so route handlers and cron
    //   aggregators keep working.
    return leaseResult.value;
  }
  //   Distinguish infra error from normal contention · caller MUST see
  //   both as `skipped=true` (never fired) but the skipReason drives
  //   HTTP status / log level.
  if (leaseResult.error) {
    return {
      skipped: true,
      skipReason: 'lease_error',
      recurringId: recurring.id,
      error: (leaseResult.error && leaseResult.error.message)
        ? leaseResult.error.message
        : String(leaseResult.error),
    };
  }
  return {
    skipped: true,
    skipReason: 'locked',
    recurringId: recurring.id,
  };
}

module.exports = {
  list, getById, create, update, remove, listDue, fire,
  computeFirstDueAt, advanceDueDate,
  //   R1-D1-A · shared classification helper · consumed by scheduler.js
  //   and route.js so aggregation is consistent across callers.
  classifyFireResult,
  //   Internals · exported for tests only.
  _LEASE_KEY_PREFIX: LEASE_KEY_PREFIX,
  _LEASE_TTL_SEC: LEASE_TTL_SEC,
  _LEASE_HEARTBEAT_SEC: LEASE_HEARTBEAT_SEC,
  _setClientForTests,
  _resetClientForTests,
};
