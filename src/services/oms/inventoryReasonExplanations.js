/**
 * src/services/oms/inventoryReasonExplanations.js — Phase 8K · pure dictionary.
 *
 * Owner-facing Korean plain-language explanation for `reason_codes` and
 * upstream enum strings that Phase 8A/8E/8F emit.
 *
 * Contract:
 *   translate(reasonCode, context?) -> string
 *     · reasonCode: string  (never mutated)
 *     · context:    optional object with numbers/labels the dictionary may
 *                   embed (e.g., largest_shipment_share_30d, evidenced_depth)
 *   · Unknown reasonCode → returns the ORIGINAL string verbatim (Owner rule 6)
 *   · No side effects · no I/O · no external calls
 *   · Never throws · defensive against non-string / undefined inputs
 */
'use strict';

// Whitelisted reason codes → Korean explanation function.
// Each function receives (context || {}) so it can embed numeric context safely.
// Missing context field → placeholder or omitted phrase; never invented values.
const DICT = Object.freeze({
  // ─── Phase 8A / strategicHoldService decision reason_codes ───────────
  'demand_untrusted':
    () => '수요 데이터가 신뢰 조건을 통과하지 못했습니다 (다중 채널 판매 이력 부족 등).',
  'missing:trusted_cross_channel_velocity':
    () => '다중 채널 (eBay/Shopify) 확정 배송 이력이 부족해 판매속도를 신뢰할 수 없습니다.',
  'hold_status:review_demand_shock':
    () => '단기 수요 급변 신호 감지 · Owner 검토 필요.',
  'hold_status:review_supply_risk':
    () => '공급 리스크 신호 감지 · Owner 검토 필요.',
  'hold_status:review_demand_and_supply_risk':
    () => '수요 · 공급 양쪽 모두에 리스크 신호가 감지되었습니다 · Owner 검토 필요.',
  'hold_status:sell_normally':
    () => '수요 · 공급 · 재고 조건이 정상 판매 범위 안에 있습니다.',
  'strategic_hold_candidate_from_hold_service':
    () => 'strategicHoldService가 전략적 보유 후보로 분류했습니다 (policy_source=provisional).',
  'protect_operating_stock_from_hold_service':
    () => '운영 재고 보호 임계값 아래로 판정 · sellable exposure 축소 검토.',
  'replenish_signal_from_hold_service':
    () => '재입고 신호 감지 · 조달 옵션 확인 필요 (자동 발주 없음).',

  // ─── strategicHoldService supply reason_codes ───────────
  'current_supply_ask_only':
    (ctx = {}) => `현재 확보 가능한 공급은 SECONDARY_MARKET_ASK 뿐입니다 (executable quote 없음)${_maybe(ctx.evidenced_depth, ' · 확인된 depth ')}${_maybe(ctx.evidenced_depth, '개')}.`,
  'supplier_diversity_zero':
    () => '현재 신뢰 가능한 공급처가 0개 · 공급망 다양성 결여.',
  'supplier_diversity_one':
    () => '현재 신뢰 가능한 공급처가 1개 뿐 · 단일 공급처 리스크.',
  'no_current_primary_supplier_quote':
    () => '주 배급사(primary distributor)의 현재 SUPPLIER_QUOTE가 없습니다.',
  'replacement_difficulty_hard':
    () => '대체 조달 난이도 HARD · executable quote 없이는 정량 조달 어려움.',
  'replacement_difficulty_very_hard':
    () => '대체 조달 난이도 VERY_HARD · 정량 조달 매우 어려움.',
  'replacement_difficulty_moderate':
    () => '대체 조달 난이도 MODERATE.',

  // ─── Phase 8A demand_concentration ───────────
  'demand_concentrated_large_order':
    (ctx = {}) => {
      const largest = ctx.largest_shipment_units_30d;
      const share = ctx.largest_shipment_share_30d;
      const parts = ['30일 매출이 1건의 대형 주문에 집중되어 있습니다'];
      if (Number.isFinite(largest)) parts.push(`가장 큰 주문 ${largest}개`);
      if (Number.isFinite(share)) parts.push(`전체의 ${_pct(share)}`);
      parts.push('· 이런 패턴은 지속적 수요로 판정되지 않습니다.');
      return parts.join(' · ').replace(/ · \·/g, ' ·');
    },

  // ─── channelSalesEvidence trust_reason ───────────
  'multi_channel_evidence':
    () => '다중 채널(eBay + Shopify)에서 확정 배송 이력이 확보되어 판매속도를 신뢰합니다.',
  'trusted_with_shipments':
    () => '해당 채널의 실제 배송 이력이 확보되어 판매속도를 신뢰합니다.',
  'legitimate_zero_full_coverage':
    () => '완전한 커버리지 기간에 판매 이력이 0건 · 판매속도 0 자체는 신뢰합니다.',
});

/**
 * @param {string} reasonCode
 * @param {Object} [context]
 * @returns {string}
 */
function translate(reasonCode, context) {
  if (typeof reasonCode !== 'string' || reasonCode.length === 0) {
    return String(reasonCode);   // preserve non-string / empty verbatim
  }
  // dynamic-suffix reasons: strategicHoldService emits eg 'uncovered_at_60_15' or
  //   'secondary_market_dependency_at_60_100pct'. Match by prefix.
  if (/^uncovered_at_60_\d+$/.test(reasonCode)) {
    const n = reasonCode.match(/^uncovered_at_60_(\d+)$/)?.[1];
    return `60개 조달 목표에서 현재 확인된 공급으로는 ${n}개가 부족합니다.`;
  }
  if (/^uncovered_at_100_\d+$/.test(reasonCode)) {
    const n = reasonCode.match(/^uncovered_at_100_(\d+)$/)?.[1];
    return `100개 조달 목표에서 현재 확인된 공급으로는 ${n}개가 부족합니다.`;
  }
  if (/^secondary_market_dependency_at_60_\d+pct$/.test(reasonCode)) {
    const n = reasonCode.match(/^secondary_market_dependency_at_60_(\d+)pct$/)?.[1];
    return `60개 조달 목표의 ${n}%가 secondary market ask에 의존합니다 (primary 채널 확인 필요).`;
  }
  const fn = DICT[reasonCode];
  if (typeof fn === 'function') {
    try { return fn(context || {}); } catch (_) { return reasonCode; }
  }
  // Unknown reason → verbatim passthrough (Owner rule 6)
  return reasonCode;
}

// ─── formatting helpers (never fabricate values) ─────────

function _maybe(v, prefix = '') {
  if (v == null) return '';
  return prefix + String(v);
}
function _pct(v) {
  if (!Number.isFinite(v)) return '';
  return (Math.round(Number(v) * 1000) / 10).toFixed(1) + '%';
}

module.exports = {
  translate,
  KNOWN_REASON_CODES: Object.freeze(Object.keys(DICT)),
  _internals: { DICT, _pct, _maybe },
};
