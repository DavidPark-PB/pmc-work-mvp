/**
 * DuplicatePurchaseDetector — 발주 중복 검사 (PR P-1A-B)
 *
 * spec:
 *   normalize(name): 소문자 + 공백 모두 제거 + 구분자(- _ . , /) 제거 + 괄호((){}[]) 제거
 *   findDuplicates({ normalized, sku, days, excludeId }):
 *     - 최근 N일 (기본 7일) 이내 + deleted_at IS NULL 만 대상
 *     - normalized 일치 OR sku 일치 (둘 중 하나라도 매칭)
 *     - excludeId 가 있으면 자기 자신 제외 (수정 모드 보호)
 *
 * 정책:
 *   - soft-deleted 발주는 절대 결과에 포함되지 않음 (사장님 짚은점 4)
 *   - 결과는 status / requested_at desc 정렬
 */
'use strict';

const { getClient } = require('../db/supabaseClient');

/**
 * 상품명 정규화. 모든 중복 비교는 이 함수 결과로 수행.
 * 빈 입력 / null 은 빈 문자열 반환 → caller 에서 falsy 체크 권장.
 */
function normalize(name) {
  if (name == null) return '';
  return String(name)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[-_.,/]/g, '')
    .replace(/[()[\]{}]/g, '');
}

/**
 * 중복 발주 후보 검색.
 *
 * @param {Object} opts
 * @param {string} [opts.normalized]  — 이미 normalize() 통과한 값
 * @param {string} [opts.productName] — raw 상품명 (이 경우 내부에서 normalize)
 * @param {string} [opts.sku]         — SKU 직접 매칭
 * @param {number} [opts.days=7]      — 최근 N일 윈도우
 * @param {number} [opts.excludeId]   — 결과에서 제외할 발주 id (수정 모드)
 * @returns {Promise<Array>} matched purchase_requests rows (요약 필드만)
 */
async function findDuplicates({ normalized, productName, sku, days = 7, excludeId } = {}) {
  const norm = normalized != null ? String(normalized) : normalize(productName);
  const trimmedSku = sku != null ? String(sku).trim() : '';
  if (!norm && !trimmedSku) return [];

  const since = new Date(Date.now() - days * 86400000).toISOString();

  // PostgREST or() 의 inline value escaping 리스크 회피용으로 두 query 따로 실행 후 합침.
  const cols = 'id, product_name, normalized_product_name, sku, quantity, status, priority, requested_by, requested_at, requester:users!purchase_requests_requested_by_users_id_fk ( id, display_name )';

  async function runEq(column, value) {
    let q = getClient()
      .from('purchase_requests')
      .select(cols)
      .gte('requested_at', since)
      .is('deleted_at', null)
      .eq(column, value);
    if (Number.isFinite(excludeId)) q = q.neq('id', excludeId);
    const { data, error } = await q.order('requested_at', { ascending: false }).limit(20);
    if (error) throw error;
    return data || [];
  }

  const merged = new Map();
  if (norm) {
    for (const r of await runEq('normalized_product_name', norm)) merged.set(r.id, r);
  }
  if (trimmedSku) {
    for (const r of await runEq('sku', trimmedSku)) merged.set(r.id, r);
  }

  return Array.from(merged.values())
    .sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))
    .slice(0, 20);
}

module.exports = { normalize, findDuplicates };
