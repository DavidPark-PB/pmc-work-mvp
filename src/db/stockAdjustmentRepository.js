/**
 * stock_adjustments — 재고 실사 조정 로그.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '재고 실사 DB 마이그레이션이 적용되지 않았습니다 (030).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /stock_adjustments/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    itemId: row.item_id,
    barcode: row.barcode,
    title: row.title,
    previousStock: row.previous_stock,
    newStock: row.new_stock,
    delta: row.delta,
    reason: row.reason,
    note: row.note,
    sessionId: row.session_id,
    adjustedBy: row.adjusted_by,
    createdAt: row.created_at,
  };
}

async function create({ sku, itemId, barcode, title, previousStock, newStock, reason, note, sessionId, userId }) {
  if (!sku) throw new Error('SKU가 필요합니다');
  const prev = Number(previousStock) || 0;
  const next = Number(newStock) || 0;
  const { data, error } = await getClient().from('stock_adjustments').insert({
    sku: String(sku).slice(0, 100),
    item_id: itemId ? String(itemId).slice(0, 100) : null,
    barcode: barcode ? String(barcode).slice(0, 100) : null,
    title: title ? String(title).slice(0, 500) : null,
    previous_stock: prev,
    new_stock: next,
    delta: next - prev,
    reason: reason ? String(reason).slice(0, 200) : null,
    note: note ? String(note).slice(0, 2000) : null,
    session_id: sessionId ? String(sessionId).slice(0, 50) : null,
    adjusted_by: userId || null,
  }).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function listBySku(sku, limit = 50) {
  const { data, error } = await getClient().from('stock_adjustments')
    .select('*')
    .eq('sku', sku)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function listBySession(sessionId) {
  const { data, error } = await getClient().from('stock_adjustments')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false });
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function listRecent({ limit = 50, days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await getClient().from('stock_adjustments')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getSessionSummary(sessionId) {
  const rows = await listBySession(sessionId);
  const totalAdjustments = rows.length;
  const uniqueSkus = new Set(rows.map(r => r.sku)).size;
  const totalPositive = rows.filter(r => r.delta > 0).reduce((s, r) => s + r.delta, 0);
  const totalNegative = rows.filter(r => r.delta < 0).reduce((s, r) => s + Math.abs(r.delta), 0);
  const biggestDiff = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10);
  return { sessionId, totalAdjustments, uniqueSkus, totalPositive, totalNegative, biggestDiff };
}

module.exports = { create, listBySku, listBySession, listRecent, getSessionSummary };
