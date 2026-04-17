/**
 * purchase_requests 테이블 — 발주 요청
 */
const { getClient } = require('./supabaseClient');

/**
 * 발주 목록 조회 — 모든 직원이 전체 목록 열람 가능 (중복 구매 방지 목적).
 * scope='mine' 파라미터로 본인 요청만 필터 가능.
 */
async function listRequests({ user, status, scope }) {
  const baseCols = `
    id, product_name, quantity, estimated_price, priority, reason,
    requested_by, requested_at, status, decision_by, decision_at,
    rejection_reason, rejection_note, ordered_by, ordered_at,
    requester:users!purchase_requests_requested_by_users_id_fk ( id, display_name, platform ),
    orderer:users!purchase_requests_ordered_by_fk ( id, display_name )
  `;
  const legacyCols = `
    id, product_name, quantity, estimated_price, priority, reason,
    requested_by, requested_at, status, decision_by, decision_at,
    rejection_reason, rejection_note,
    requester:users!purchase_requests_requested_by_users_id_fk ( id, display_name, platform )
  `;

  async function runQuery(cols) {
    let q = getClient().from('purchase_requests').select(cols);
    if (scope === 'mine') q = q.eq('requested_by', user.id);
    if (status) q = q.eq('status', status);
    return q.order('requested_at', { ascending: false });
  }

  let { data, error } = await runQuery(baseCols);
  // Migration 010 not applied yet → retry with legacy columns
  if (error && (error.code === '42703' || error.code === 'PGRST200')) {
    ({ data, error } = await runQuery(legacyCols));
  }
  if (error) throw error;

  return (data || []).sort((a, b) => {
    const rank = s => (s === 'pending' ? 0 : s === 'approved' ? 1 : s === 'ordered' ? 2 : 3);
    const ar = rank(a.status); const br = rank(b.status);
    if (ar !== br) return ar - br;
    const aUrg = a.priority === 'urgent' ? 0 : 1;
    const bUrg = b.priority === 'urgent' ? 0 : 1;
    if (aUrg !== bUrg) return aUrg - bUrg;
    return new Date(b.requested_at) - new Date(a.requested_at);
  });
}

/**
 * 발주 이력 기반 재고 추천
 *  - 최근 90일 데이터 집계 (rejected 제외)
 *  - 상품명(lowercase+trim) 기준 그룹
 *  - 산출: 요청횟수, 총수량, 평균수량, 마지막 요청일, 평균 요청간격, 권장재고
 *  - 권장재고 공식:
 *      월평균수량(=60일 총수량/2) × 1.5 (안전 재고 버퍼)
 *      최소 3개
 *      실제 최근 평균수량보다는 크게
 */
async function getRecommendations({ days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await getClient()
    .from('purchase_requests')
    .select('product_name, quantity, estimated_price, requested_at, status, priority')
    .gte('requested_at', since)
    .neq('status', 'rejected');
  if (error) throw error;

  // 상품명 정규화 키로 그룹
  const groups = new Map();
  for (const r of data || []) {
    const key = String(r.product_name || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        name: r.product_name.trim(),
        key,
        requestCount: 0,
        totalQty: 0,
        urgentCount: 0,
        approvedCount: 0,
        pendingCount: 0,
        dates: [],
        avgPriceKrw: 0,
        _priceSum: 0,
        _priceCount: 0,
      });
    }
    const g = groups.get(key);
    g.requestCount++;
    g.totalQty += Number(r.quantity) || 0;
    if (r.priority === 'urgent') g.urgentCount++;
    if (r.status === 'approved') g.approvedCount++;
    else if (r.status === 'pending') g.pendingCount++;
    g.dates.push(new Date(r.requested_at));
    if (r.estimated_price) {
      g._priceSum += Number(r.estimated_price);
      g._priceCount++;
    }
  }

  const items = [];
  for (const g of groups.values()) {
    g.dates.sort((a, b) => a - b);
    const lastAt = g.dates[g.dates.length - 1];
    const firstAt = g.dates[0];
    const spanDays = Math.max(1, (lastAt - firstAt) / 86400000);
    const avgIntervalDays = g.dates.length > 1 ? Math.round(spanDays / (g.dates.length - 1)) : null;
    const avgQty = g.totalQty / g.requestCount;

    // 최근 60일 집계 → 월평균
    const sixtyDaysAgo = Date.now() - 60 * 86400000;
    const recent = g.dates.filter(d => d.getTime() >= sixtyDaysAgo);
    const recentQty = recent.length > 0
      ? (g.totalQty * (recent.length / g.dates.length)) // 근사: 기간 내 비율
      : g.totalQty;
    const monthlyAvg = recent.length > 0 ? recentQty / 2 : avgQty; // 60일 / 2 = 월평균
    const suggestedStock = Math.max(3, Math.ceil(monthlyAvg * 1.5));

    items.push({
      name: g.name,
      requestCount: g.requestCount,
      totalQty: g.totalQty,
      avgQty: Math.round(avgQty * 10) / 10,
      lastRequestedAt: lastAt.toISOString(),
      avgIntervalDays,
      urgentCount: g.urgentCount,
      approvedCount: g.approvedCount,
      pendingCount: g.pendingCount,
      avgPrice: g._priceCount > 0 ? Math.round(g._priceSum / g._priceCount) : null,
      suggestedStock,
    });
  }

  // 정렬: 요청횟수 많은 순, 동률이면 총수량
  items.sort((a, b) => {
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return b.totalQty - a.totalQty;
  });

  return { windowDays: days, products: items };
}

async function getRequest(id) {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createRequest(values) {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .insert(values)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateRequest(id, values) {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .update(values)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getStats() {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .select('status, priority');
  if (error) throw error;
  const counts = { pending: 0, pendingUrgent: 0, approved: 0, ordered: 0, rejected: 0 };
  for (const r of data || []) {
    if (r.status === 'pending') {
      counts.pending++;
      if (r.priority === 'urgent') counts.pendingUrgent++;
    } else if (r.status === 'approved') counts.approved++;
    else if (r.status === 'ordered') counts.ordered++;
    else if (r.status === 'rejected') counts.rejected++;
  }
  return counts;
}

async function deleteRequest(id) {
  const { error } = await getClient()
    .from('purchase_requests')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, deleteRequest, getStats, getRecommendations };
