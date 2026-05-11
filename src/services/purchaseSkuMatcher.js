/**
 * PurchaseSkuMatcher — sku_master 자동완성 검색 (PR P-1A-B)
 *
 * 발주 폼의 SKU 자동완성 전용. (Phase 2 의 src/services/skuMatcher.js 는 order ↔ sku 매칭용으로 별도)
 *
 * spec 검색 순위 (사장님 1-A):
 *   1. SKU 코드 완전 일치
 *   2. SKU 코드 부분 일치
 *   3. 상품명 (title) 부분 일치
 *   4. 최근 N일 발주 이력 (purchase_requests.sku) 에 등장한 SKU 가중치 상승
 *
 * fallback (사장님 짚은점 2):
 *   - sku_master 가 비었거나 매칭 0건 → 빈 배열 반환. caller (UI) 가 "일치하는 SKU 없음" 표시 + 그래도 직접 입력 허용.
 *   - 발주 저장 시 sku 가 sku_master 에 없어도 거부 X — UI 에서 "SKU 미연결" 뱃지로 표시.
 */
'use strict';

const { getClient } = require('../db/supabaseClient');

const DEFAULT_LIMIT = 10;
const DEFAULT_RECENT_DAYS = 30;

/** PostgREST ilike 패턴 안전화 — `%`, `_`, `\` escape. */
function escapeLikePattern(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

/**
 * 자동완성 결과 1행. UI 가 그대로 사용.
 */
function shape(row, recentBoostMap) {
  return {
    internal_sku: row.internal_sku,
    title:        row.title,
    brand:        row.brand || null,
    category:     row.category || null,
    status:       row.status,
    recent_purchase_count: recentBoostMap.get(row.internal_sku) || 0,
  };
}

/**
 * @param {string}  q              — 사용자 입력 (SKU 또는 상품명 일부)
 * @param {Object} [opts]
 * @param {number} [opts.limit=10]
 * @param {number} [opts.recentDays=30]
 * @returns {Promise<Array>} 자동완성 후보 (우선순위 정렬)
 */
async function searchByQuery(q, opts = {}) {
  const trimmed = String(q || '').trim();
  if (!trimmed) return [];

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || DEFAULT_LIMIT, 1), 30);
  const recentDays = Math.min(Math.max(parseInt(opts.recentDays, 10) || DEFAULT_RECENT_DAYS, 1), 180);

  const c = getClient();
  const safe = escapeLikePattern(trimmed);

  // 1. SKU 완전 일치
  const exact = await c
    .from('sku_master')
    .select('internal_sku, title, brand, category, status')
    .eq('internal_sku', trimmed)
    .limit(1);
  if (exact.error) throw exact.error;
  const exactRows = exact.data || [];

  // 2. SKU 부분 일치 (완전 일치 제외)
  const skuPartial = await c
    .from('sku_master')
    .select('internal_sku, title, brand, category, status')
    .ilike('internal_sku', `%${safe}%`)
    .neq('internal_sku', trimmed)
    .limit(limit);
  if (skuPartial.error) throw skuPartial.error;
  const skuPartialRows = skuPartial.data || [];

  // 3. 상품명 부분 일치 (위 2개 결과에 없는 것만)
  const seenSkus = new Set([...exactRows, ...skuPartialRows].map(r => r.internal_sku));
  const titlePartial = await c
    .from('sku_master')
    .select('internal_sku, title, brand, category, status')
    .ilike('title', `%${safe}%`)
    .limit(limit);
  if (titlePartial.error) throw titlePartial.error;
  const titlePartialRows = (titlePartial.data || []).filter(r => !seenSkus.has(r.internal_sku));

  // 4. 최근 N일 발주 가중치 — purchase_requests.sku NOT NULL + deleted_at IS NULL 의 빈도
  const since = new Date(Date.now() - recentDays * 86400000).toISOString();
  const recentBoost = new Map();
  const candidateSkus = [
    ...exactRows.map(r => r.internal_sku),
    ...skuPartialRows.map(r => r.internal_sku),
    ...titlePartialRows.map(r => r.internal_sku),
  ];
  if (candidateSkus.length > 0) {
    const recent = await c
      .from('purchase_requests')
      .select('sku')
      .gte('requested_at', since)
      .is('deleted_at', null)
      .in('sku', candidateSkus);
    if (!recent.error) {
      for (const r of recent.data || []) {
        if (!r.sku) continue;
        recentBoost.set(r.sku, (recentBoost.get(r.sku) || 0) + 1);
      }
    }
  }

  // 우선순위 결합: exact → skuPartial → titlePartial. 각 그룹 안에서 recent_purchase_count desc.
  const sortByBoost = arr =>
    arr.slice().sort((a, b) => (recentBoost.get(b.internal_sku) || 0) - (recentBoost.get(a.internal_sku) || 0));

  const ordered = [
    ...sortByBoost(exactRows),
    ...sortByBoost(skuPartialRows),
    ...sortByBoost(titlePartialRows),
  ].slice(0, limit);

  return ordered.map(r => shape(r, recentBoost));
}

module.exports = { searchByQuery };
