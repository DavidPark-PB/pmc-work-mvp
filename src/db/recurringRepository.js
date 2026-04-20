/**
 * recurring_payments — 정기결제 (월간/연간) 관리.
 * 매일 스케줄러가 `next_due_at <= today AND active` 인 행을
 * expenses 테이블에 insert하고 next_due_at을 다음 주기로 전진.
 */
const { getClient } = require('./supabaseClient');
const { normalize } = require('../services/expenseCategories');

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

  const { data, error } = await getClient().from('recurring_payments')
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
 */
async function fire(recurring, { expenseRepo, asOf = new Date() }) {
  const expense = await expenseRepo.createExpense({
    paidAt: recurring.nextDueAt,
    amount: recurring.amount,
    currency: recurring.currency,
    category: recurring.category,
    merchant: recurring.name,
    memo: recurring.memo,
    cardLast4: recurring.cardLast4,
    source: 'recurring',
    recurringId: recurring.id,
    createdBy: recurring.createdBy,
  });
  const next = advanceDueDate(recurring.nextDueAt, recurring.cycle, recurring.dayOfCycle);
  await update(recurring.id, { nextDueAt: next });
  return { expense, nextDueAt: next };
}

module.exports = {
  list, getById, create, update, remove, listDue, fire,
  computeFirstDueAt, advanceDueDate,
};
