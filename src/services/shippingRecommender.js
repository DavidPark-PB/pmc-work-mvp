/**
 * shippingRecommender — 배송사 자동 추천 (PR Phase 2B)
 *
 * 사장님 spec (메모리 project_shipping_phase2.md):
 *   - 룰 5개 (무게 구간) + 국가 예외 2개 (유럽 / 캐나다·스위스)
 *   - 단순 if-else. 룰 엔진 X.
 *   - "추천 이유" 직원이 즉시 이해할 수 있게 명시
 *
 * 검토 필요 (review) 4가지 케이스:
 *   1. weight_missing      — SKU 무게 NULL/0
 *   2. country_missing     — 주문 국가 코드 없음
 *   3. sku_unmatched       — orders.sku 가 sku_master.internal_sku 매칭 실패
 *   4. no_rule             — 위 3개 통과해도 룰 미적용 (실제로 거의 발생 X — fallback)
 *
 * 사장님 추가 조건 (2026-05-12):
 *   - SKU 매칭 실패 시 정확한 로그: orders.sku 원본 + 시도한 internal_sku + 구체 실패 이유
 *     (empty / not_found / duplicates 등) → 직원이 sku_master 에서 무엇 고쳐야 하는지 즉시 파악
 */
'use strict';

// 캐리어 정의 (사장님 spec 색상 + UI 정렬 순서)
const CARRIERS = {
  KOREA_POST:   { key: 'koreapost', label: '우체국',     color: '#4caf50', emoji: '🟢', order: 1 },
  SHIPTER:      { key: 'shipter',   label: '쉽터',       color: '#ff9800', emoji: '🟠', order: 2 },
  KPL:          { key: 'kpl',       label: 'KPL',        color: '#1565c0', emoji: '🔵', order: 3 },
  FEDEX:        { key: 'fedex',     label: '페덱스',     color: '#e94560', emoji: '🔴', order: 4 },
  YUN_EXPRESS:  { key: 'yun',       label: '윤익스프레스', color: '#fbc02d', emoji: '🟡', order: 5 },
  K_PACKET:     { key: 'kpacket',   label: 'K패킷',      color: '#888888', emoji: '⚪', order: 6 },
};
const REVIEW = { key: 'review', label: '검토 필요', color: '#9e9e9e', emoji: '⚠️', order: 99 };

// 유럽 국가 (ISO 2-letter). shippingRates.js 의 SHIPTER_COUNTRY_MAP 의 키를 가져오되,
// CH (스위스) 는 사장님 spec 상 K-Packet 으로 가야 하므로 제외.
const EUROPE_COUNTRIES = new Set([
  'GB','DE','FR','IT','ES','PT','PL','NL','FI','RO',
  'SE','AT','BE','CZ','EE','HU','LT','DK','LU','SK',
  'SI','IE','BG','LV','GR','CY','MT','HR','UA','NO',
  'RS','GE','ME','AL','BA','MD',
  // CH 는 K-Packet 예외라 의도적으로 제외
]);

// K-Packet 예외 국가 (사장님 spec)
const KPACKET_EXCEPTIONS = new Set(['CA', 'CH']);

/**
 * 무게 구간 룰 (사장님 spec):
 *   ≤ 100g       → 우체국
 *   100 ~ 200g   → 우체국
 *   200 ~ 300g   → 쉽터
 *   300 ~ 1500g  → KPL
 *   > 1500g      → 페덱스
 */
function _byWeight(grams) {
  if (grams <= 200) return { carrier: CARRIERS.KOREA_POST, reason: `${grams}g ≤ 200g` };
  if (grams <= 300) return { carrier: CARRIERS.SHIPTER,    reason: `200g < ${grams}g ≤ 300g` };
  if (grams <= 1500) return { carrier: CARRIERS.KPL,       reason: `300g < ${grams}g ≤ 1500g` };
  return { carrier: CARRIERS.FEDEX, reason: `${grams}g 초과 (> 1500g)` };
}

/**
 * @param {Object} input
 * @param {number|null} input.weightGram  — SKU 무게 (g). NULL/0 면 review.
 * @param {string|null} input.countryCode — ISO 2-letter 또는 NULL.
 * @param {Object|null} input.matchInfo   — SKU 매칭 정보 { matched: boolean, reason?, attemptedSku? }
 * @returns {Object} {
 *   ok: boolean,
 *   carrier: { key, label, color, emoji, order } | null,
 *   reason: string,
 *   review?: { code, message }  // review 일 때만
 * }
 */
function recommend({ weightGram, countryCode, matchInfo } = {}) {
  // 1) SKU 매칭 실패 검토 (사장님 spec 검토 케이스 3)
  if (matchInfo && matchInfo.matched === false) {
    return {
      ok: false,
      carrier: REVIEW,
      reason: matchInfo.reason || 'SKU 매칭 실패',
      review: { code: 'sku_unmatched', message: matchInfo.reason || 'orders.sku ↔ sku_master.internal_sku 매칭 실패' },
    };
  }

  // 2) 무게 정보 부재 (검토 케이스 1)
  const w = Number(weightGram);
  if (!Number.isFinite(w) || w <= 0) {
    return {
      ok: false,
      carrier: REVIEW,
      reason: 'SKU 무게 미등록',
      review: { code: 'weight_missing', message: 'sku_master.weight_gram 이 NULL 또는 0 — 마스터에서 무게 입력 필요' },
    };
  }

  // 3) 국가 정보 부재 (검토 케이스 2)
  const cc = countryCode ? String(countryCode).trim().toUpperCase() : '';
  if (!cc) {
    return {
      ok: false,
      carrier: REVIEW,
      reason: '국가 정보 없음',
      review: { code: 'country_missing', message: 'orders.country_code 가 NULL/빈 값 — 주문 데이터 확인 필요' },
    };
  }

  // 4) 국가 예외 (우선순위 최상위)
  //    EU/유럽: 윤익스프레스 (전 무게)
  //    캐나다 / 스위스: K-Packet
  if (KPACKET_EXCEPTIONS.has(cc)) {
    return {
      ok: true,
      carrier: CARRIERS.K_PACKET,
      reason: `K-Packet 추천: ${cc} (${cc === 'CA' ? '캐나다' : '스위스'} 예외)`,
    };
  }
  if (EUROPE_COUNTRIES.has(cc)) {
    return {
      ok: true,
      carrier: CARRIERS.YUN_EXPRESS,
      reason: `윤익스프레스 추천: 유럽 국가 (${cc})`,
    };
  }

  // 5) 무게 룰 (그 외 국가)
  const byWeight = _byWeight(w);
  return {
    ok: true,
    carrier: byWeight.carrier,
    reason: `${byWeight.carrier.label} 추천: ${byWeight.reason}`,
  };
}

/**
 * SKU 매칭 시도 결과를 만드는 helper.
 * 사장님 spec — 정확한 실패 이유를 caller 에게 전달:
 *   - empty:      orders.sku 가 빈 값
 *   - not_found:  sku_master 에 해당 internal_sku 없음
 *   - found:      매칭 성공
 *
 * @param {string|null} orderSku
 * @param {Object|null} matchedRow — sku_master row { internal_sku, weight_gram, title }
 * @returns {{ matched: boolean, attemptedSku: string, reason?: string }}
 */
function buildMatchInfo(orderSku, matchedRow) {
  const sku = orderSku ? String(orderSku).trim() : '';
  if (!sku) {
    return {
      matched: false,
      attemptedSku: '',
      reason: 'orders.sku 가 빈 값 — 주문 데이터에 SKU 누락',
    };
  }
  if (!matchedRow) {
    return {
      matched: false,
      attemptedSku: sku,
      reason: `sku_master.internal_sku="${sku}" 없음 — 마스터에 SKU 등록 필요`,
    };
  }
  return { matched: true, attemptedSku: sku };
}

module.exports = {
  recommend,
  buildMatchInfo,
  CARRIERS,
  REVIEW,
  EUROPE_COUNTRIES,
  KPACKET_EXCEPTIONS,
};
