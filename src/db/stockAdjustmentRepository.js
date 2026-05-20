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
    // PR S-1 (049 마이그레이션)
    status: row.status || 'pending',
    appliedAt: row.applied_at || null,
    appliedBy: row.applied_by || null,
  };
}

async function create({ sku, itemId, barcode, title, previousStock, newStock, reason, note, sessionId, userId, status }) {
  if (!sku && status !== 'review_required' && status !== 'pending') throw new Error('SKU가 필요합니다');
  const prev = Number(previousStock) || 0;
  const next = Number(newStock) || 0;
  const initialStatus = ['pending', 'review_required', 'applied', 'cancelled'].includes(status) ? status : 'pending';
  const { data, error } = await getClient().from('stock_adjustments').insert({
    sku: sku ? String(sku).slice(0, 100) : null,    // 임시 실사 / 검토 필요는 sku NULL 허용
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
    status: initialStatus,
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

// ── PR S-1 (049): 승인 워크플로우 ──

/**
 * 검토/승인 대기 row 조회.
 * @param {Object} opts
 * @param {string} [opts.status]  — 'pending' | 'review_required'  (default: pending)
 * @param {number} [opts.limit=200]
 */
async function listByStatus({ status = 'pending', limit = 200 } = {}) {
  const { data, error } = await getClient().from('stock_adjustments')
    .select('*').eq('status', status)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('stock_adjustments')
    .select('*').eq('id', id).maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return decorate(data);
}

/**
 * 일괄 승인 — pending row 들의 status='applied' + products.stock = newStock 일괄 반영.
 * sku NULL row 는 skip (임시 실사 / 검토 필요는 별도 처리 필요).
 *
 * @param {Array<number>} ids
 * @param {number} appliedBy — admin user id
 * @returns {Promise<{applied, skipped, results: [{id, ok, error?}]}>}
 */
async function applyBatch(ids, appliedBy) {
  if (!Array.isArray(ids) || ids.length === 0) return { applied: 0, skipped: 0, results: [] };
  const c = getClient();
  const results = [];
  let applied = 0, skipped = 0;
  const nowIso = new Date().toISOString();

  for (const id of ids) {
    try {
      const row = await getById(id);
      if (!row) { results.push({ id, ok: false, error: 'not found' }); skipped++; continue; }
      if (row.status !== 'pending' && row.status !== 'review_required') {
        results.push({ id, ok: false, error: `status=${row.status} → 승인 불가` }); skipped++; continue;
      }
      if (!row.sku) {
        results.push({ id, ok: false, error: 'sku NULL → 일괄 승인 불가 (임시/검토 케이스)' }); skipped++; continue;
      }
      // products.stock 업데이트
      const { error: upErr } = await c.from('products').update({ stock: row.newStock }).eq('sku', row.sku);
      if (upErr) {
        results.push({ id, ok: false, error: 'products.stock 업데이트 실패: ' + upErr.message });
        skipped++; continue;
      }
      // status='applied'
      const { error: stErr } = await c.from('stock_adjustments').update({
        status: 'applied', applied_at: nowIso, applied_by: appliedBy,
      }).eq('id', id);
      if (stErr) {
        results.push({ id, ok: false, error: 'status 업데이트 실패: ' + stErr.message });
        skipped++; continue;
      }
      results.push({ id, ok: true, sku: row.sku, newStock: row.newStock });
      applied++;
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
      skipped++;
    }
  }
  return { applied, skipped, results };
}

async function setStatus(id, status, { byUser } = {}) {
  if (!['pending', 'review_required', 'applied', 'cancelled'].includes(status)) {
    throw new Error('invalid status');
  }
  const patch = { status };
  if (status === 'applied') {
    patch.applied_at = new Date().toISOString();
    patch.applied_by = byUser || null;
  }
  const { data, error } = await getClient().from('stock_adjustments')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

/**
 * 실사 항목 수정 — newStock / reason / note 만 변경 가능. delta 는 자동 재계산.
 * sku / previousStock / sessionId / adjusted_by / status / created_at 는 불변.
 * applied / cancelled 상태는 수정 금지 (호출자가 사전 차단).
 *
 * @param {number} id
 * @param {{newStock?: number, reason?: string, note?: string}} patch
 */
async function update(id, patch = {}) {
  const updates = {};
  if (patch.newStock !== undefined) {
    const n = parseInt(patch.newStock, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error('newStock 은 0 이상의 정수');
    updates.new_stock = n;
  }
  if (patch.reason !== undefined) {
    updates.reason = patch.reason ? String(patch.reason).slice(0, 200) : null;
  }
  if (patch.note !== undefined) {
    updates.note = patch.note ? String(patch.note) : null;
  }
  if (Object.keys(updates).length === 0) throw new Error('변경할 필드가 없습니다');

  // newStock 바뀌면 delta 재계산 — 기존 previous_stock 기준
  if (updates.new_stock !== undefined) {
    const existing = await getById(id);
    if (!existing) throw new Error('항목을 찾을 수 없습니다');
    updates.delta = updates.new_stock - (existing.previousStock || 0);
  }

  const { data, error } = await getClient().from('stock_adjustments')
    .update(updates).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

module.exports = {
  create, listBySku, listBySession, listRecent, getSessionSummary,
  // PR S-1 추가
  listByStatus, getById, applyBatch, setStatus,
  // 인라인 수정 (사장님 요청 2026-05-20)
  update,
};
