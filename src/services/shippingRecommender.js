/**
 * shippingRecommender — 실제 견적 비교 기반 배송사 추천 (사장님 spec, 2026-06-23)
 *
 * 변경 (이전 → 현재):
 *   이전 (Phase 2B): 무게 5구간 단순 룰 + 국가 예외 2개
 *   현재: shippingRateEngine 으로 KPL/쉽터/윤/EMS프리미엄/K-Packet 5개 동시 견적 →
 *         최저가 자동 추천 + 5개 가격 화면에 펼침. 직원은 보고 한 번에 결정.
 *
 * Review 케이스 (이전과 동일):
 *   1. sku_unmatched   — orders.sku ↔ sku_master 매칭 실패
 *   2. weight_missing  — sku_master.weight_gram NULL/0
 *   3. country_missing — orders.country_code NULL
 *   4. no_quote        — 모든 배송사 견적 미지원 (country 매핑 X 또는 너무 무거움)
 */
'use strict';

const rateEngine = require('./shippingRateEngine');

// 캐리어 정의 (배송사별 색상 + 정렬 순서)
// 견적 엔진의 carrier key 와 1:1 매칭.
const CARRIERS = {
  KPACKET:     { key: 'kpacket',     label: 'K-Packet',     color: '#9e9e9e', emoji: '⚪', order: 1 },
  KPL:         { key: 'kpl',         label: 'KPL',          color: '#1565c0', emoji: '🔵', order: 2 },
  SHIPTER:     { key: 'shipter',     label: '쉽터',         color: '#ff9800', emoji: '🟠', order: 3 },
  YUN_EXPRESS: { key: 'yun',         label: '윤익스프레스', color: '#fbc02d', emoji: '🟡', order: 4 },
  EMS_PREMIUM: { key: 'ems_premium', label: 'EMS프리미엄',  color: '#4caf50', emoji: '🟢', order: 5 },
};
const REVIEW = { key: 'review', label: '검토 필요', color: '#9e9e9e', emoji: '⚠️', order: 99 };

// carrier key → CARRIERS row 역인덱스
const CARRIER_BY_KEY = {};
for (const c of Object.values(CARRIERS)) CARRIER_BY_KEY[c.key] = c;

/**
 * SKU 매칭 시도 결과 helper (이전 버전과 동일 인터페이스).
 */
function buildMatchInfo(orderSku, matchedRow) {
  const sku = orderSku ? String(orderSku).trim() : '';
  if (!sku) {
    return { matched: false, attemptedSku: '', reason: 'orders.sku 가 빈 값 — 주문 데이터에 SKU 누락' };
  }
  if (!matchedRow) {
    return {
      matched: false, attemptedSku: sku,
      reason: `sku_master.internal_sku="${sku}" 없음 — 마스터에 SKU 등록 필요`,
    };
  }
  return { matched: true, attemptedSku: sku };
}

/**
 * 견적 비교 기반 추천.
 *
 * @param {Object} input
 * @param {number|null} input.weightGram   — sku_master 무게 (g). NULL/0 면 review.
 * @param {string|null} input.countryCode  — ISO 2-letter 또는 한국어.
 * @param {Object|null} input.matchInfo    — buildMatchInfo() 결과
 * @param {Object} [input.dimensions]      — { lengthCm, widthCm, heightCm } 부피중량 계산용
 * @returns {Object} {
 *   ok, carrier: { key, label, color, emoji, order } | null,
 *   reason: string,
 *   quotes: Array | null,         // 5개 배송사 견적 (최저가 정렬). 빈 배열 = no_quote.
 *   review?: { code, message },
 * }
 */
function recommend({ weightGram, countryCode, matchInfo, dimensions } = {}) {
  // 1) SKU 매칭 실패
  if (matchInfo && matchInfo.matched === false) {
    return {
      ok: false, carrier: REVIEW,
      reason: matchInfo.reason || 'SKU 매칭 실패',
      quotes: null,
      review: { code: 'sku_unmatched', message: matchInfo.reason || 'orders.sku ↔ sku_master.internal_sku 매칭 실패' },
    };
  }

  // 2) 무게 정보 부재
  const wG = Number(weightGram);
  if (!Number.isFinite(wG) || wG <= 0) {
    return {
      ok: false, carrier: REVIEW,
      reason: 'SKU 무게 미등록',
      quotes: null,
      review: { code: 'weight_missing', message: 'sku_master.weight_gram 이 NULL 또는 0 — 마스터에서 무게 입력 필요' },
    };
  }

  // 3) 국가 정보 부재
  const cc = countryCode ? String(countryCode).trim() : '';
  if (!cc) {
    return {
      ok: false, carrier: REVIEW,
      reason: '국가 정보 없음',
      quotes: null,
      review: { code: 'country_missing', message: 'orders.country_code 가 NULL/빈 값 — 주문 데이터 확인 필요' },
    };
  }

  // 4) 견적 엔진 호출
  const actualKg = wG / 1000;
  const dim = dimensions || {};
  const quotes = rateEngine.getQuotes({
    country: cc,
    actualKg,
    lengthCm: Number(dim.lengthCm) || 0,
    widthCm:  Number(dim.widthCm)  || 0,
    heightCm: Number(dim.heightCm) || 0,
  });

  if (!quotes || quotes.length === 0) {
    return {
      ok: false, carrier: REVIEW,
      reason: '견적 미지원',
      quotes: [],
      review: {
        code: 'no_quote',
        message: `${cc} ${actualKg}kg — 5개 배송사 모두 요율표 미등록 또는 무게 초과. shippingRateEngine 의 *_RATES 확인 필요`,
      },
    };
  }

  // 5) 최저가 추천
  const cheapest = quotes[0];
  const carrier = CARRIER_BY_KEY[cheapest.carrier] || REVIEW;
  return {
    ok: true,
    carrier,
    reason: `${carrier.label} 추천: ${cheapest.total.toLocaleString('ko-KR')}원 (최저가)`,
    quotes,
  };
}

module.exports = {
  recommend,
  buildMatchInfo,
  CARRIERS,
  REVIEW,
  CARRIER_BY_KEY,
};
