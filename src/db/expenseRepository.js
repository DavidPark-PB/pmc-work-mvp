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

function decorate(row, receiptCount, userName) {
  if (!row) return null;
  const extra = Number.isFinite(receiptCount) ? receiptCount : 0;
  const hasLegacy = !!row.receipt_path;
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
    createdByName: userName || null,  // '등록자' 표시용 — users.display_name lookup 결과
    createdAt: row.created_at,
    // legacy 단일 영수증 (036 이전)
    receiptPath: row.receipt_path || null,
    receiptName: row.receipt_name || null,
    receiptMime: row.receipt_mime || null,
    receiptSize: row.receipt_size || null,
    // 다중 영수증 count (036 expense_receipts 테이블 기준)
    receiptCount: extra,
    // hasReceipt = legacy 단일 OR 다중 1개 이상 (둘 중 하나라도 있으면 true)
    hasReceipt: hasLegacy || extra > 0,
    // 048 신규 컬럼 (W-G2-B / G3)
    status: row.status || '지급완료',
    sourceType: row.source_type || null,
    sourceId: row.source_id || null,
    paidBy: row.paid_by || null,
  };
}

/**
 * expense_id 배열 → { expense_id: receipt_count } map.
 * expense_receipts 테이블 (036) 미적용 시 빈 map.
 */
async function _receiptCountMap(expenseIds) {
  if (!expenseIds || expenseIds.length === 0) return new Map();
  const { data, error } = await getClient().from('expense_receipts')
    .select('expense_id').in('expense_id', expenseIds);
  if (error) {
    // 036 미적용 시 silent fallback
    if (/expense_receipts.*does not exist|relation .* does not exist|PGRST205/.test((error.message || '') + (error.code || ''))) {
      return new Map();
    }
    throw error;
  }
  const map = new Map();
  for (const r of data || []) {
    map.set(r.expense_id, (map.get(r.expense_id) || 0) + 1);
  }
  return map;
}

/**
 * userId 배열 → { userId: display_name } map.
 * '등록자' 표시용 — listExpenses / getExpense 가 decorate 시 동봉.
 */
async function _userNameMap(userIds) {
  if (!userIds || userIds.length === 0) return new Map();
  const unique = [...new Set(userIds.filter(Number.isFinite))];
  if (unique.length === 0) return new Map();
  const { data, error } = await getClient().from('users')
    .select('id, display_name, username')
    .in('id', unique);
  if (error) {
    // 신뢰 못 할 경우에도 갱신 안 함. 빈 map 으로 fallback.
    console.warn('[expenseRepo] _userNameMap 실패:', error.message);
    return new Map();
  }
  const map = new Map();
  for (const r of data || []) {
    map.set(r.id, r.display_name || r.username || `#${r.id}`);
  }
  return map;
}

/** 과거 지출에 쓰인 카드 뒷자리 목록 (distinct, 최근 사용순). 드롭다운용. */
async function listDistinctCards({ createdBy } = {}) {
  let q = getClient().from('expenses')
    .select('card_last4, paid_at')
    .not('card_last4', 'is', null)
    .order('paid_at', { ascending: false })
    .limit(1000);
  if (createdBy !== undefined && createdBy !== null) q = q.eq('created_by', createdBy);
  const { data, error } = await q;
  if (error && isMissingTable(error)) return [];
  if (error) throw error;
  // 최근 사용순 유지하면서 중복 제거
  const seen = new Set();
  const out = [];
  for (const row of data || []) {
    const c = String(row.card_last4 || '').trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
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

// ── 다중 영수증 (036 마이그레이션 필요) ──

async function addReceiptRecord({ expenseId, path, name, mime, size, userId }) {
  const { data, error } = await getClient().from('expense_receipts').insert({
    expense_id: expenseId,
    storage_path: path,
    file_name: name || null,
    mime_type: mime || null,
    file_size: size || null,
    uploaded_by: userId || null,
  }).select().single();
  if (error) throw error;
  return _decorateReceipt(data);
}

async function listReceiptsByExpense(expenseId) {
  const { data, error } = await getClient().from('expense_receipts')
    .select('*')
    .eq('expense_id', expenseId)
    .order('uploaded_at', { ascending: true });
  if (error) {
    // 마이그레이션 036 미적용 시 빈 배열 fallback
    if (/expense_receipts.*does not exist|relation .* does not exist|PGRST205/.test(error.message + (error.code || ''))) return [];
    throw error;
  }
  return (data || []).map(_decorateReceipt);
}

async function getReceiptById(receiptId) {
  const { data, error } = await getClient().from('expense_receipts')
    .select('*').eq('id', receiptId).maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data ? _decorateReceipt(data) : null;
}

async function deleteReceiptById(receiptId) {
  const { error } = await getClient().from('expense_receipts').delete().eq('id', receiptId);
  if (error) throw error;
}

function _decorateReceipt(r) {
  if (!r) return null;
  return {
    id: r.id,
    expenseId: r.expense_id,
    path: r.storage_path,
    name: r.file_name,
    mime: r.mime_type,
    size: r.file_size,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
  };
}

async function listExpenses({ from, to, category, source, createdBy, hasReceipt, limit = 500 } = {}) {
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

  const rows = data || [];
  // 다중 영수증 count map (N+1 회피 — 한 번 query)
  const ids = rows.map(r => r.id);
  const userIds = rows.map(r => r.created_by).filter(Boolean);
  const [countMap, userMap] = await Promise.all([
    _receiptCountMap(ids),
    _userNameMap(userIds),
  ]);

  let decorated = rows.map(r => decorate(r, countMap.get(r.id) || 0, userMap.get(r.created_by)));

  // hasReceipt 필터 (사장님 fix #4) — client-side filter (legacy + 다중 모두 검사)
  if (hasReceipt === true || hasReceipt === 'true' || hasReceipt === '1' || hasReceipt === 1) {
    decorated = decorated.filter(d => d.hasReceipt);
  } else if (hasReceipt === false || hasReceipt === 'false' || hasReceipt === '0' || hasReceipt === 0) {
    decorated = decorated.filter(d => !d.hasReceipt);
  }
  return decorated;
}

async function getExpense(id) {
  const { data, error } = await getClient().from('expenses')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  if (!data) return null;
  const [countMap, userMap] = await Promise.all([
    _receiptCountMap([id]),
    _userNameMap(data.created_by ? [data.created_by] : []),
  ]);
  return decorate(data, countMap.get(id) || 0, userMap.get(data.created_by));
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
  setReceipt, clearReceipt, listDistinctCards,
  // 다중 영수증
  addReceiptRecord, listReceiptsByExpense, getReceiptById, deleteReceiptById,
};
