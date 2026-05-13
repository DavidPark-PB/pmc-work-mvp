/**
 * ShippingWeightCalculator — 주문 단위 배송 무게·예상비 자동 계산
 *
 * Phase 3 of 배송비 계산/배송추천 리디자인 (사장님 spec 2026-05-12).
 *
 * 입력: orderId (wms_orders.id)
 * 동작:
 *   1. wms_orders + wms_order_lines + matched sku_master 일괄 조회
 *   2. 각 line 의 단품무게 × 수량 → product_weight_g 합산
 *   3. 포장무게 = SKU별 default_packaging_weight_g OR 배송그룹 기본값 OR 50g
 *   4. final_weight_g = product + packaging
 *   5. volumetric_weight_g = sum(qty × L×W×H) / 5 (g; divisor 5000 universal)
 *   6. chargeable_weight_g = max(final, volumetric)
 *   7. shippingRecommender.recommend() → 추천 carrier
 *   8. shippingRates.getShippingEstimates() → 추천 service + 예상비
 *   9. order_shipments upsert
 *
 * 호출 시점:
 *   - orderImporter.importMockOrder() 직후 (best-effort, 실패 무시)
 *   - 배송추천 페이지 진입 시 missing 한 주문에 대해 lazy 호출 (Phase 4)
 *   - admin 수동 trigger (batch recalc, Phase 4)
 */
'use strict';

const { getClient } = require('../db/supabaseClient');
const orderShipmentRepo = require('../db/orderShipmentRepository');
const recommender = require('./shippingRecommender');
const rates = require('./shippingRates');

// 부피무게 universal divisor — 5000 = 국제표준 (FedEx/DHL). 보수적 기준치.
// 실제 carrier 의 divisor (예: K-Packet 6000, YunExpress 6000) 와 다를 수 있으나,
// chargeable_weight 는 안전 마진으로 5000 적용. 운임 lookup 자체는 carrier 별 정확.
const VOLUMETRIC_DIVISOR = 5000;

// 배송 그룹별 기본 포장무게 (g). SKU.default_packaging_weight_g 가 NULL 일 때만 사용.
// 사장님 spec 예시: 포켓몬 카드, K-pop 포토카드 = 작고 가벼움.
const PACKAGING_DEFAULTS = {
  card:      5,    // 포켓몬·유희왕 — bubble mailer 한 장 정도
  photocard: 5,    // K-pop 포카
  sticker:   5,
  apparel:   30,   // poly mailer
  album:     80,   // 박스 + bubble wrap
  toy:       150,  // 박스 (중간)
  figure:    150,
  general:   50,
  // null/미지정: 50 fallback
};
const PACKAGING_FALLBACK_G = 50;

class CalcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * 주문 + line + matched SKU 일괄 조회.
 * 반환: { order, lines: [{ ...line, sku: {...sku_master} | null }] }
 *       order=null 이면 not found.
 */
async function _loadOrderWithLines(orderId) {
  const db = getClient();

  const { data: order, error: e1 } = await db
    .from('wms_orders')
    .select('id, marketplace, external_order_id, order_status, buyer_country, ordered_at, total_amount, currency')
    .eq('id', orderId)
    .maybeSingle();
  if (e1) throw e1;
  if (!order) return { order: null, lines: [] };

  const { data: lines, error: e2 } = await db
    .from('wms_order_lines')
    .select(`
      id, order_id, marketplace_sku, listing_id, option_id,
      title, quantity, unit_price, currency,
      matched_sku_id, match_status, match_reason
    `)
    .eq('order_id', orderId);
  if (e2) throw e2;

  // matched SKU 일괄 조회 (N+1 회피)
  const skuIds = [...new Set((lines || []).map(l => l.matched_sku_id).filter(Boolean))];
  let skuMap = new Map();
  if (skuIds.length > 0) {
    const { data: skus, error: e3 } = await db
      .from('sku_master')
      .select('id, internal_sku, weight_gram, weight_status, default_packaging_weight_g, width_cm, height_cm, length_cm, shipping_group')
      .in('id', skuIds);
    if (e3) throw e3;
    skuMap = new Map((skus || []).map(s => [s.id, s]));
  }

  const enriched = (lines || []).map(l => ({
    ...l,
    sku: l.matched_sku_id ? (skuMap.get(l.matched_sku_id) || null) : null,
  }));
  return { order, lines: enriched };
}

/**
 * 라인 한 줄의 포장무게 (g) — SKU 우선, 없으면 group 기본, 없으면 fallback.
 */
function _resolveLinePackaging(line) {
  const sku = line.sku;
  if (sku && sku.default_packaging_weight_g != null) return Number(sku.default_packaging_weight_g);
  const group = sku?.shipping_group || null;
  if (group && PACKAGING_DEFAULTS[group] != null) return PACKAGING_DEFAULTS[group];
  return PACKAGING_FALLBACK_G;
}

/**
 * 주문 전체 집계.
 * 반환: {
 *   productWeightG, packagingWeightG, finalWeightG,
 *   volumetricWeightG, chargeableWeightG,
 *   missingSkus: [{ lineId, marketplaceSku, reason }],
 *   hasAllWeights, anyDims
 * }
 */
function _aggregate(lines) {
  let productWeightG = 0;
  let packagingWeightG = 0;   // 박스 1개 가정 — 라인별 포장 합산이 아니라 '대표' 포장
  let volumetricCm3Sum = 0;
  let anyDims = false;
  let hasAllWeights = true;
  const missingSkus = [];

  // 한 박스로 배송한다는 가정: 포장무게는 라인별 합산이 아니라 '최대 포장' 사용.
  // (단일 라인 주문은 자연스럽게 그 라인의 포장. 다중 라인은 가장 큰 포장 적용 — 안전 측.)
  let maxPackaging = 0;

  for (const line of lines) {
    const qty = Number(line.quantity) || 0;
    const sku = line.sku;

    if (!sku) {
      hasAllWeights = false;
      missingSkus.push({
        lineId: line.id,
        marketplaceSku: line.marketplace_sku,
        reason: 'SKU 매칭 실패 — sku_master 에 없음',
      });
      continue;
    }
    if (sku.weight_gram == null || !(sku.weight_gram > 0)) {
      hasAllWeights = false;
      missingSkus.push({
        lineId: line.id,
        marketplaceSku: line.marketplace_sku,
        internalSku: sku.internal_sku,
        reason: 'sku_master.weight_gram 미입력',
      });
      continue;
    }

    productWeightG += Number(sku.weight_gram) * qty;

    // 포장 — 가장 큰 라인 포장을 채택
    const linePack = _resolveLinePackaging(line);
    if (linePack > maxPackaging) maxPackaging = linePack;

    // 부피 — 모든 dim 이 있는 라인만 집계 (하나라도 없으면 그 라인은 부피 0 처리)
    if (sku.width_cm != null && sku.height_cm != null && sku.length_cm != null) {
      const vol = Number(sku.width_cm) * Number(sku.height_cm) * Number(sku.length_cm);
      if (vol > 0) {
        volumetricCm3Sum += vol * qty;
        anyDims = true;
      }
    }
  }

  packagingWeightG = maxPackaging || PACKAGING_FALLBACK_G;
  const finalWeightG = productWeightG + packagingWeightG;
  // volumetric_g = cm³ / divisor (kg) × 1000 (g) = cm³ / (divisor/1000)
  const volumetricWeightG = anyDims ? Math.round((volumetricCm3Sum / VOLUMETRIC_DIVISOR) * 1000 * 100) / 100 : 0;
  const chargeableWeightG = Math.max(finalWeightG, volumetricWeightG);

  return {
    productWeightG: Math.round(productWeightG * 100) / 100,
    packagingWeightG,
    finalWeightG: Math.round(finalWeightG * 100) / 100,
    volumetricWeightG,
    chargeableWeightG: Math.round(chargeableWeightG * 100) / 100,
    missingSkus,
    hasAllWeights,
    anyDims,
  };
}

/**
 * 추천 carrier + 예상 운임. 무게/국가 미충족 시 review 반환.
 */
function _recommendCarrierAndCost({ chargeableWeightG, countryCode, hasAllWeights }) {
  // 무게 정보 부족 시 즉시 review
  if (!hasAllWeights || !(chargeableWeightG > 0)) {
    return {
      carrierKey: 'review',
      service: null,
      estimatedCostKRW: null,
      reason: !hasAllWeights ? '일부 SKU 무게 미입력 — 마스터 확인 필요' : '계산된 chargeable_weight 가 0',
    };
  }
  if (!countryCode) {
    return {
      carrierKey: 'review',
      service: null,
      estimatedCostKRW: null,
      reason: '주문 국가 정보 없음',
    };
  }

  // 1) 추천 carrier (Phase 2B 룰 — 기존 recommender 재사용)
  const rec = recommender.recommend({
    weightGram: chargeableWeightG,
    countryCode,
    matchInfo: { matched: true }, // 이 호출 시점엔 이미 SKU 매칭 됐음
  });
  const carrierKey = rec?.carrier?.key || 'review';

  // 2) 운임 lookup (해당 carrier 와 매칭되는 service 우선)
  const weightKg = chargeableWeightG / 1000;
  let estimatedCostKRW = null;
  let service = null;
  try {
    const estimates = rates.getShippingEstimates(String(countryCode).toUpperCase(), weightKg);
    if (Array.isArray(estimates) && estimates.length > 0) {
      // recommender 의 carrier 와 같은 carrier 의 첫 견적을 사용. 못 찾으면 첫 견적 (cheapest).
      const carrierLabel = rec?.carrier?.label;
      const matched = carrierLabel
        ? estimates.find(e => e.carrier === carrierLabel)
        : null;
      const chosen = matched || estimates[0];
      if (chosen && chosen.priceKRW != null) {
        estimatedCostKRW = Number(chosen.priceKRW);
        service = chosen.service || null;
      }
    }
  } catch (e) {
    // 운임 lookup 실패는 치명적 X — carrier 만 채워서 진행
  }

  return { carrierKey, service, estimatedCostKRW, reason: rec?.reason || null };
}

/**
 * 주문 ID 하나에 대해 전체 계산 + order_shipments 에 upsert.
 *
 * @param {number} orderId — wms_orders.id
 * @param {Object} [opts]
 * @param {boolean} [opts.skipPersist=false] — true 면 DB 쓰지 않고 결과만 반환 (테스트용)
 * @returns {Promise<{
 *   ok: boolean,
 *   orderId: number,
 *   shipment: Object|null,   // order_shipments row (skipPersist 면 미저장 객체)
 *   missingSkus: Array,
 *   hasAllWeights: boolean,
 *   reason: string|null,
 *   error: string|null
 * }>}
 */
async function calculateForOrder(orderId, opts = {}) {
  const oid = parseInt(orderId, 10);
  if (!Number.isFinite(oid)) {
    return { ok: false, orderId: null, shipment: null, missingSkus: [], hasAllWeights: false, reason: null, error: 'orderId invalid' };
  }

  let loaded;
  try {
    loaded = await _loadOrderWithLines(oid);
  } catch (e) {
    return { ok: false, orderId: oid, shipment: null, missingSkus: [], hasAllWeights: false, reason: null, error: `주문 조회 실패: ${e.message}` };
  }
  const { order, lines } = loaded;
  if (!order) {
    return { ok: false, orderId: oid, shipment: null, missingSkus: [], hasAllWeights: false, reason: null, error: '주문 없음' };
  }

  const agg = _aggregate(lines);
  const rec = _recommendCarrierAndCost({
    chargeableWeightG: agg.chargeableWeightG,
    countryCode: order.buyer_country,
    hasAllWeights: agg.hasAllWeights,
  });

  const fields = {
    productWeightG:     agg.productWeightG,
    packagingWeightG:   agg.packagingWeightG,
    finalWeightG:       agg.finalWeightG,
    volumetricWeightG:  agg.volumetricWeightG,
    chargeableWeightG:  agg.chargeableWeightG,
    recommendedCarrier: rec.carrierKey,
    recommendedService: rec.service,
    estimatedShippingCost: rec.estimatedCostKRW,
    estimatedShippingCurrency: 'KRW',
  };

  let shipment = null;
  if (!opts.skipPersist) {
    try {
      shipment = await orderShipmentRepo.upsertForOrder({ orderId: oid, fields });
    } catch (e) {
      // 마이그레이션 미적용 / 권한 등의 이유로 저장 실패 — 결과만 반환
      return {
        ok: false, orderId: oid, shipment: { ...fields, orderId: oid },
        missingSkus: agg.missingSkus, hasAllWeights: agg.hasAllWeights,
        reason: rec.reason, error: `order_shipments upsert 실패: ${e.message}`,
      };
    }
  } else {
    shipment = { orderId: oid, ...fields };
  }

  return {
    ok: rec.carrierKey !== 'review',
    orderId: oid,
    shipment,
    missingSkus: agg.missingSkus,
    hasAllWeights: agg.hasAllWeights,
    reason: rec.reason,
    error: null,
  };
}

/**
 * 여러 주문에 대해 순차 계산. 한 건 실패해도 다음 건 진행.
 * 반환: results 배열 (각 항목은 calculateForOrder 의 반환 shape).
 */
async function calculateForOrders(orderIds = []) {
  const results = [];
  for (const oid of orderIds) {
    try {
      results.push(await calculateForOrder(oid));
    } catch (e) {
      results.push({ ok: false, orderId: oid, shipment: null, missingSkus: [], hasAllWeights: false, reason: null, error: e.message });
    }
  }
  return results;
}

module.exports = {
  calculateForOrder,
  calculateForOrders,
  // 테스트 / Phase 4 UI helper 가 재사용하도록 export
  _aggregate, _resolveLinePackaging, _recommendCarrierAndCost,
  VOLUMETRIC_DIVISOR, PACKAGING_DEFAULTS, PACKAGING_FALLBACK_G,
  CalcError,
};
