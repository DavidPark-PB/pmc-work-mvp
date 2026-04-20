/**
 * inventory_purchases — 카드/상품 현금 매입 기록.
 * 자동으로 expenses 테이블에 '재료비' row를 만들어 재무 대시보드에 반영 (expense_id FK로 연결).
 */
const { getClient } = require('./supabaseClient');
const expenseRepo = require('./expenseRepository');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '카드 매입 DB 마이그레이션이 적용되지 않았습니다 (017).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /inventory_purchases/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    purchasedAt: row.purchased_at,
    sellerName: row.seller_name,
    sellerContact: row.seller_contact,
    paymentMethod: row.payment_method,
    bankRef: row.bank_ref,
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    items: Array.isArray(row.items) ? row.items : (row.items ? row.items : []),
    notes: row.notes,
    receiptPath: row.receipt_path || null,
    receiptName: row.receipt_name || null,
    receiptMime: row.receipt_mime || null,
    receiptSize: row.receipt_size || null,
    hasReceipt: !!row.receipt_path,
    expenseId: row.expense_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(it => {
    const name = String(it?.name || '').trim().slice(0, 300);
    if (!name) return null;
    const qty = Number(it?.quantity) || 0;
    const unit = Number(it?.unitPrice) || 0;
    return {
      name,
      sku: (it?.sku ? String(it.sku).trim().slice(0, 100) : null),
      quantity: qty,
      unitPrice: unit,
      catalogTab: it?.catalogTab || null,
      catalogRowIndex: it?.catalogRowIndex || null,
    };
  }).filter(Boolean);
}

function itemsSummary(items) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return '품목 없음';
  const first = `${arr[0].name}${arr[0].quantity ? ' ×' + arr[0].quantity : ''}`;
  if (arr.length === 1) return first;
  return `${first} 외 ${arr.length - 1}`;
}

async function list({ from, to, seller, paymentMethod, createdBy, limit = 500 } = {}) {
  let q = getClient().from('inventory_purchases').select('*')
    .order('purchased_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (from) q = q.gte('purchased_at', from);
  if (to) q = q.lte('purchased_at', to);
  if (seller) q = q.ilike('seller_name', `%${seller}%`);
  if (paymentMethod) q = q.eq('payment_method', paymentMethod);
  if (createdBy !== undefined && createdBy !== null) q = q.eq('created_by', createdBy);
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('inventory_purchases')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

/**
 * 매입 등록 + expense 자동 생성.
 * expense 생성 실패 시 purchase 등록은 롤백 (중복 집계 방지).
 */
async function create(input) {
  const purchased = input.purchasedAt;
  if (!purchased) throw new Error('매입일을 입력하세요');
  const sellerName = String(input.sellerName || '').trim();
  if (!sellerName) throw new Error('판매자를 입력하세요');

  const items = sanitizeItems(input.items);
  const itemsSum = items.reduce((s, i) => s + (i.quantity * i.unitPrice), 0);
  const total = Number(input.totalAmount);
  if (!Number.isFinite(total) || total <= 0) {
    if (itemsSum > 0) input.totalAmount = itemsSum;
    else throw new Error('총액 또는 품목을 입력하세요');
  }
  const finalTotal = Number(input.totalAmount);

  // 1) 연동 expense 먼저 생성 — 실패 시 purchase insert도 안 함
  let expense = null;
  try {
    expense = await expenseRepo.createExpense({
      paidAt: purchased,
      amount: finalTotal,
      currency: (input.currency || 'KRW').toUpperCase(),
      category: '재료비',
      merchant: sellerName,
      memo: `카드 매입 · ${itemsSummary(items)}`,
      source: 'manual',
      cardLast4: null,
      createdBy: input.createdBy || null,
    });
  } catch (e) {
    throw new Error(`연동 지출 생성 실패: ${e.message}`);
  }

  // 2) purchase insert
  const row = {
    purchased_at: purchased,
    seller_name: sellerName.slice(0, 200),
    seller_contact: input.sellerContact ? String(input.sellerContact).slice(0, 200) : null,
    payment_method: ['cash', 'bank_transfer', 'card', 'other'].includes(input.paymentMethod)
      ? input.paymentMethod : 'cash',
    bank_ref: input.bankRef ? String(input.bankRef).slice(0, 200) : null,
    total_amount: finalTotal,
    currency: (input.currency || 'KRW').toUpperCase().slice(0, 4),
    items,
    notes: input.notes ? String(input.notes).trim() : null,
    expense_id: expense?.id || null,
    created_by: input.createdBy || null,
  };
  const { data, error } = await getClient().from('inventory_purchases')
    .insert(row).select().single();
  if (error) {
    // 롤백: expense 삭제
    if (expense?.id) {
      try { await expenseRepo.deleteExpense(expense.id); } catch {}
    }
    throwFriendly(error);
  }
  return decorate(data);
}

/**
 * 수정 — total/date/seller 바뀌면 연동 expense도 동기화.
 */
async function update(id, updates) {
  const existing = await getById(id);
  if (!existing) return null;

  const patch = { updated_at: new Date().toISOString() };
  if (updates.purchasedAt !== undefined) patch.purchased_at = updates.purchasedAt;
  if (updates.sellerName !== undefined) patch.seller_name = String(updates.sellerName).trim().slice(0, 200);
  if (updates.sellerContact !== undefined) patch.seller_contact = updates.sellerContact ? String(updates.sellerContact).slice(0, 200) : null;
  if (updates.paymentMethod !== undefined) {
    patch.payment_method = ['cash', 'bank_transfer', 'card', 'other'].includes(updates.paymentMethod)
      ? updates.paymentMethod : existing.paymentMethod;
  }
  if (updates.bankRef !== undefined) patch.bank_ref = updates.bankRef ? String(updates.bankRef).slice(0, 200) : null;
  if (updates.currency !== undefined) patch.currency = String(updates.currency).toUpperCase().slice(0, 4);
  if (updates.notes !== undefined) patch.notes = updates.notes ? String(updates.notes).trim() : null;
  if (updates.items !== undefined) patch.items = sanitizeItems(updates.items);
  if (updates.totalAmount !== undefined) patch.total_amount = Number(updates.totalAmount);

  if (Object.keys(patch).length === 1) throw new Error('변경할 내용이 없습니다'); // updated_at만 있음

  const { data, error } = await getClient().from('inventory_purchases')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  const updated = decorate(data);

  // 연동 expense 동기화
  if (existing.expenseId) {
    const expPatch = {};
    if (patch.purchased_at !== undefined) expPatch.paidAt = patch.purchased_at;
    if (patch.total_amount !== undefined) expPatch.amount = patch.total_amount;
    if (patch.seller_name !== undefined) expPatch.merchant = patch.seller_name;
    if (patch.items !== undefined) expPatch.memo = `카드 매입 · ${itemsSummary(patch.items)}`;
    if (patch.currency !== undefined) expPatch.currency = patch.currency;
    if (Object.keys(expPatch).length > 0) {
      try { await expenseRepo.updateExpense(existing.expenseId, expPatch); }
      catch (e) { console.warn(`[inventoryPurchase] linked expense update failed: ${e.message}`); }
    }
  }

  return updated;
}

async function remove(id) {
  const existing = await getById(id);
  if (!existing) return;

  // Storage 영수증 제거는 라우트 단에서 (bucket 객체 필요)
  const { error } = await getClient().from('inventory_purchases').delete().eq('id', id);
  if (error) throwFriendly(error);

  // 연동 expense도 함께 제거 (중복 집계 방지)
  if (existing.expenseId) {
    try { await expenseRepo.deleteExpense(existing.expenseId); }
    catch (e) { console.warn(`[inventoryPurchase] linked expense delete failed: ${e.message}`); }
  }
  return existing;
}

async function setReceipt(id, { path, name, mime, size }) {
  const { data, error } = await getClient().from('inventory_purchases')
    .update({ receipt_path: path, receipt_name: name, receipt_mime: mime, receipt_size: size, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function clearReceipt(id) {
  const { data, error } = await getClient().from('inventory_purchases')
    .update({ receipt_path: null, receipt_name: null, receipt_mime: null, receipt_size: null, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function distinctSellers({ limit = 100 } = {}) {
  const { data, error } = await getClient().from('inventory_purchases')
    .select('seller_name, seller_contact, purchased_at')
    .order('purchased_at', { ascending: false })
    .limit(1000);
  if (error && isMissing(error)) return [];
  if (error) throw error;
  const seen = new Map();
  for (const r of data || []) {
    const key = r.seller_name;
    if (!seen.has(key)) {
      seen.set(key, { name: r.seller_name, contact: r.seller_contact || null, lastAt: r.purchased_at });
    }
  }
  return [...seen.values()].slice(0, limit);
}

async function summaryByMonth(month, { createdBy } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month must be YYYY-MM');
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(n => parseInt(n, 10));
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;

  let q = getClient().from('inventory_purchases')
    .select('seller_name, total_amount, currency, payment_method')
    .gte('purchased_at', from).lte('purchased_at', to);
  if (createdBy !== undefined && createdBy !== null) q = q.eq('created_by', createdBy);
  const { data, error } = await q;
  if (error && isMissing(error)) return { month, totals: {}, bySeller: [], byMethod: {} };
  if (error) throw error;

  const totals = {};
  const bySellerMap = new Map();
  const byMethod = {};
  for (const r of data || []) {
    const ccy = String(r.currency || 'KRW').toUpperCase();
    const amt = Number(r.total_amount) || 0;
    totals[ccy] = (totals[ccy] || 0) + amt;
    const sellerKey = r.seller_name;
    if (!bySellerMap.has(sellerKey)) bySellerMap.set(sellerKey, { seller: sellerKey, total: 0, count: 0 });
    const s = bySellerMap.get(sellerKey);
    s.total += amt;
    s.count++;
    byMethod[r.payment_method || 'cash'] = (byMethod[r.payment_method || 'cash'] || 0) + amt;
  }
  const bySeller = [...bySellerMap.values()].sort((a, b) => b.total - a.total);
  return { month, totals, bySeller, byMethod };
}

module.exports = {
  list, getById, create, update, remove,
  setReceipt, clearReceipt, distinctSellers, summaryByMonth, itemsSummary,
};
