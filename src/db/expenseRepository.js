/**
 * expenses 테이블 — 지출 데이터 레이어.
 * 수동 등록, CSV 업로드, 정기결제 자동 발행 모두 여기 insertOne 경유.
 */
const { getClient } = require('./supabaseClient');
const { normalize } = require('../services/expenseCategories');

// PostgreSQL "relation does not exist" + PostgREST "schema cache miss"
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);
const MISSING_TABLE_MSG = '재무 기능 DB 마이그레이션이 적용되지 않았습니다 (013). 관리자에게 문의하세요.';

function isMissingTable(err) {
  if (!err) return false;
  if (MISSING_TABLE_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return /expenses|recurring_payments|expense_category_rules/i.test(msg)
      && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissingTable(err)) throw new Error(MISSING_TABLE_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    paidAt: row.paid_at,
    amount: Number(row.amount),
    currency: row.currency,
    category: row.category,
    merchant: row.merchant,
    memo: row.memo,
    source: row.source,
    cardLast4: row.card_last4,
    taskId: row.task_id,
    recurringId: row.recurring_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    receiptPath: row.receipt_path || null,
    receiptName: row.receipt_name || null,
    receiptMime: row.receipt_mime || null,
    receiptSize: row.receipt_size || null,
    hasReceipt: !!row.receipt_path,
  };
}

async function setReceipt(id, { path, name, mime, size }) {
  const { data, error } = await getClient().from('expenses')
    .update({ receipt_path: path, receipt_name: name, receipt_mime: mime, receipt_size: size })
    .eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function clearReceipt(id) {
  const { data, error } = await getClient().from('expenses')
    .update({ receipt_path: null, receipt_name: null, receipt_mime: null, receipt_size: null })
    .eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function listExpenses({ from, to, category, source, createdBy, limit = 500 } = {}) {
  let q = getClient().from('expenses')
    .select('*')
    .order('paid_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (from) q = q.gte('paid_at', from);
  if (to) q = q.lte('paid_at', to);
  if (category) q = q.eq('category', category);
  if (source) q = q.eq('source', source);
  if (createdBy !== undefined && createdBy !== null) q = q.eq('created_by', createdBy);
  const { data, error } = await q;
  if (error && isMissingTable(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getExpense(id) {
  const { data, error } = await getClient().from('expenses')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function createExpense({
  paidAt, amount, currency = 'KRW', category, merchant, memo,
  source = 'manual', cardLast4, taskId, recurringId, createdBy,
}) {
  if (!paidAt) throw new Error('paid_at is required');
  if (!Number.isFinite(Number(amount))) throw new Error('amount must be number');
  const row = {
    paid_at: paidAt,
    amount: Number(amount),
    currency: (currency || 'KRW').toUpperCase().slice(0, 4),
    category: normalize(category),
    merchant: merchant || null,
    memo: memo || null,
    source,
    card_last4: cardLast4 ? String(cardLast4).slice(-4) : null,
    task_id: taskId || null,
    recurring_id: recurringId || null,
    created_by: createdBy || null,
  };
  const { data, error } = await getClient().from('expenses')
    .insert(row).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function bulkCreate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const prepared = rows.map(r => ({
    paid_at: r.paidAt,
    amount: Number(r.amount),
    currency: (r.currency || 'KRW').toUpperCase().slice(0, 4),
    category: normalize(r.category),
    merchant: r.merchant || null,
    memo: r.memo || null,
    source: r.source || 'csv',
    card_last4: r.cardLast4 ? String(r.cardLast4).slice(-4) : null,
    task_id: r.taskId || null,
    recurring_id: r.recurringId || null,
    created_by: r.createdBy || null,
  }));
  const { data, error } = await getClient().from('expenses')
    .insert(prepared).select();
  if (error) throwFriendly(error);
  return (data || []).map(decorate);
}

async function updateExpense(id, updates) {
  const patch = {};
  if (updates.paidAt !== undefined) patch.paid_at = updates.paidAt;
  if (updates.amount !== undefined) patch.amount = Number(updates.amount);
  if (updates.currency !== undefined) patch.currency = String(updates.currency || 'KRW').toUpperCase().slice(0, 4);
  if (updates.category !== undefined) patch.category = normalize(updates.category);
  if (updates.merchant !== undefined) patch.merchant = updates.merchant || null;
  if (updates.memo !== undefined) patch.memo = updates.memo || null;
  if (updates.cardLast4 !== undefined) patch.card_last4 = updates.cardLast4 ? String(updates.cardLast4).slice(-4) : null;
  if (updates.taskId !== undefined) patch.task_id = updates.taskId || null;
  if (Object.keys(patch).length === 0) throw new Error('변경할 내용이 없습니다');
  const { data, error } = await getClient().from('expenses')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function deleteExpense(id) {
  const { error } = await getClient().from('expenses').delete().eq('id', id);
  if (error) throwFriendly(error);
}

/**
 * 카테고리별 월 합계. { month: 'YYYY-MM', [KRW|USD|...] : { [category]: amount } }
 * 통화 섞이면 통화별로 따로 합산 — 대시보드가 표시 여부 결정.
 */
async function summaryByMonth(month, { createdBy } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month must be YYYY-MM');
  const from = `${month}-01`;
  const [year, mm] = month.split('-').map(n => parseInt(n, 10));
  const lastDay = new Date(year, mm, 0).getDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;

  let q = getClient().from('expenses')
    .select('category, amount, currency')
    .gte('paid_at', from).lte('paid_at', to);
  if (createdBy !== undefined && createdBy !== null) q = q.eq('created_by', createdBy);
  const { data, error } = await q;
  if (error && isMissingTable(error)) return { month, totals: {}, byCategory: {} };
  if (error) throw error;

  const totals = {};
  const byCategory = {};
  for (const r of data || []) {
    const ccy = String(r.currency || 'KRW').toUpperCase();
    const amt = Number(r.amount) || 0;
    totals[ccy] = (totals[ccy] || 0) + amt;
    if (!byCategory[r.category]) byCategory[r.category] = {};
    byCategory[r.category][ccy] = (byCategory[r.category][ccy] || 0) + amt;
  }
  return { month, totals, byCategory };
}

// ── 카테고리 학습 캐시 ──

async function getCachedCategory(merchant) {
  if (!merchant) return null;
  const pattern = String(merchant).toLowerCase().trim();
  if (!pattern) return null;
  // substring match — pattern이 stored pattern에 포함되거나, stored pattern이 요청 머천트에 포함
  const { data, error } = await getClient().from('expense_category_rules')
    .select('*')
    .ilike('merchant_pattern', `%${pattern.slice(0, 30)}%`)
    .order('confidence', { ascending: false })
    .limit(1);
  if (error && isMissingTable(error)) return null;
  if (error) return null; // cache miss is silent
  return data?.[0]?.category || null;
}

async function saveCachedCategory({ merchant, category, confidence = 80, createdBy }) {
  const pattern = String(merchant || '').toLowerCase().trim().slice(0, 200);
  if (!pattern) return;
  const cat = normalize(category);
  try {
    await getClient().from('expense_category_rules').upsert({
      merchant_pattern: pattern,
      category: cat,
      confidence,
      created_by: createdBy || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'merchant_pattern' });
  } catch { /* best-effort cache */ }
}

module.exports = {
  listExpenses, getExpense, createExpense, bulkCreate, updateExpense, deleteExpense,
  summaryByMonth, getCachedCategory, saveCachedCategory,
  setReceipt, clearReceipt,
};
