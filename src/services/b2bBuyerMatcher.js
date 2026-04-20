/**
 * 플랫폼 주문 ↔ B2B 거래처 자동 매칭.
 *
 * b2b_buyers.external_ids JSONB 구조:
 *   { "ebay": ["buyer@x.com", "wholesale_usa"], "alibaba": ["abc_trade"], ... }
 *
 * 매칭 규칙 (순서대로 시도):
 *   1) 해당 플랫폼 external_ids[platform]에 주문 email 일치 (소문자)
 *   2) 같은 external_ids[platform]에 주문 buyer_name 일치 (소문자)
 *   3) b2b_buyers.email 필드와 주문 email 일치 (fallback)
 *   전부 없으면 null → 미매칭
 *
 * 성능: 매칭 실행 시 buyer index 1회 구축(해시), 주문 배열은 streaming.
 */
const { getClient } = require('../db/supabaseClient');

function norm(s) { return String(s || '').toLowerCase().trim(); }

async function loadBuyerIndex() {
  const { data, error } = await getClient()
    .from('b2b_buyers')
    .select('buyer_id, name, email, external_ids');
  if (error && error.code === '42703') return { byPlatformId: new Map(), byGlobalEmail: new Map() }; // migration 미적용
  if (error) throw error;

  const byPlatformId = new Map();   // key: `${platform}:${id}` → buyerId
  const byGlobalEmail = new Map();  // key: email → buyerId

  for (const b of data || []) {
    const buyerId = b.buyer_id;
    const ext = b.external_ids || {};
    for (const [platform, ids] of Object.entries(ext)) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        const key = `${norm(platform)}:${norm(id)}`;
        if (!byPlatformId.has(key)) byPlatformId.set(key, buyerId);
      }
    }
    // 주 이메일은 flexible: 어떤 플랫폼에서 와도 매칭
    if (b.email) {
      const key = norm(b.email);
      if (!byGlobalEmail.has(key)) byGlobalEmail.set(key, buyerId);
    }
  }
  return { byPlatformId, byGlobalEmail };
}

function matchOrder(order, index) {
  const platform = norm(order.platform);
  if (!platform) return null;

  const email = norm(order.email || '');
  const name = norm(order.buyer_name || '');

  if (email) {
    const k = `${platform}:${email}`;
    if (index.byPlatformId.has(k)) return index.byPlatformId.get(k);
  }
  if (name) {
    const k = `${platform}:${name}`;
    if (index.byPlatformId.has(k)) return index.byPlatformId.get(k);
  }
  if (email && index.byGlobalEmail.has(email)) {
    return index.byGlobalEmail.get(email);
  }
  return null;
}

/**
 * 미매칭 주문을 스캔해서 external_ids 기준으로 b2b_buyer_id를 채움.
 * 기존 매칭된 건은 건드리지 않음 (재배정하려면 null로 초기화하거나 수동 assign).
 *
 * 옵션: onlyUnmapped=true(기본) → b2b_buyer_id IS NULL만 대상.
 */
async function backfillOrders({ onlyUnmapped = true, batchSize = 500, limit = 20000 } = {}) {
  const index = await loadBuyerIndex();
  if (index.byPlatformId.size === 0 && index.byGlobalEmail.size === 0) {
    return { scanned: 0, matched: 0, reason: 'no_buyer_external_ids' };
  }
  const db = getClient();
  let scanned = 0;
  let matched = 0;
  let offset = 0;
  while (scanned < limit) {
    let q = db.from('orders')
      .select('order_no, platform, buyer_name, email, b2b_buyer_id')
      .order('order_date', { ascending: false })
      .range(offset, offset + batchSize - 1);
    if (onlyUnmapped) q = q.is('b2b_buyer_id', null);
    const { data, error } = await q;
    if (error && error.code === '42703') return { scanned, matched, reason: 'column_missing' };
    if (error) throw error;
    if (!data || data.length === 0) break;

    scanned += data.length;
    const updates = new Map(); // buyerId → [order_no, ...]
    for (const o of data) {
      const buyerId = matchOrder(o, index);
      if (!buyerId) continue;
      if (!updates.has(buyerId)) updates.set(buyerId, []);
      updates.get(buyerId).push(o.order_no);
    }
    for (const [buyerId, orderNos] of updates) {
      const { error: uErr, data: uData } = await db.from('orders')
        .update({ b2b_buyer_id: buyerId })
        .in('order_no', orderNos)
        .select('order_no');
      if (uErr) { console.warn('[b2bMatcher] update fail:', uErr.message); continue; }
      matched += (uData || []).length;
    }
    if (data.length < batchSize) break;
    offset += batchSize;
  }
  return { scanned, matched };
}

/**
 * orderSync가 새 주문을 insert한 직후 호출. 최근 주문(NEW status)만 빠르게 매칭.
 */
async function matchRecent({ since } = {}) {
  const index = await loadBuyerIndex();
  if (index.byPlatformId.size === 0 && index.byGlobalEmail.size === 0) return { matched: 0 };
  const db = getClient();
  let q = db.from('orders')
    .select('order_no, platform, buyer_name, email')
    .is('b2b_buyer_id', null)
    .limit(2000);
  if (since) q = q.gte('order_date', since);
  const { data, error } = await q;
  if (error && error.code === '42703') return { matched: 0, reason: 'column_missing' };
  if (error) throw error;

  const batches = new Map();
  for (const o of data || []) {
    const buyerId = matchOrder(o, index);
    if (!buyerId) continue;
    if (!batches.has(buyerId)) batches.set(buyerId, []);
    batches.get(buyerId).push(o.order_no);
  }
  let matched = 0;
  for (const [buyerId, orderNos] of batches) {
    try {
      const { data: u } = await db.from('orders')
        .update({ b2b_buyer_id: buyerId })
        .in('order_no', orderNos)
        .select('order_no');
      matched += (u || []).length;
    } catch {}
  }
  return { matched };
}

module.exports = { loadBuyerIndex, matchOrder, backfillOrders, matchRecent };
