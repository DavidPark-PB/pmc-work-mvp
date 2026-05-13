/**
 * OrderShipmentRepository — order_shipments 테이블 CRUD
 *
 * Phase 2 of 배송비 계산/배송추천 리디자인.
 *
 * 한 주문(wms_orders.id) 당 한 행. order_id 가 UNIQUE 라 upsertForOrder()
 * 가 주 진입점. Phase 3 계산 서비스가 주문 임포트 직후 호출해서 자동 계산값을
 * 채우고, Phase 4 배송추천 UI 가 인라인 수정 시 갱신.
 *
 * 컬럼 매핑: camelCase 입력 → snake_case 컬럼. 출력은 _decorate() 가 다시 camel
 * 로 정규화해 라우트에서 그대로 응답할 수 있게 함.
 */
const { getClient } = require('./supabaseClient');

const COLUMNS = `
  id, order_id,
  product_weight_g, packaging_weight_g, final_weight_g,
  volumetric_weight_g, chargeable_weight_g,
  recommended_carrier, recommended_service,
  estimated_shipping_cost, estimated_shipping_currency,
  actual_shipping_cost, shipping_margin,
  is_weight_overridden, overridden_weight_g, override_reason,
  master_weight_updated,
  created_at, updated_at
`;

const ALLOWED_PATCH_FIELDS = new Set([
  'product_weight_g', 'packaging_weight_g', 'final_weight_g',
  'volumetric_weight_g', 'chargeable_weight_g',
  'recommended_carrier', 'recommended_service',
  'estimated_shipping_cost', 'estimated_shipping_currency',
  'actual_shipping_cost', 'shipping_margin',
  'is_weight_overridden', 'overridden_weight_g', 'override_reason',
  'master_weight_updated',
]);

// camelCase 입력 → snake_case 컬럼 키로 매핑. 알 수 없는 키는 버림.
function toRow(input = {}) {
  const map = {
    productWeightG:        'product_weight_g',
    packagingWeightG:      'packaging_weight_g',
    finalWeightG:          'final_weight_g',
    volumetricWeightG:     'volumetric_weight_g',
    chargeableWeightG:     'chargeable_weight_g',
    recommendedCarrier:    'recommended_carrier',
    recommendedService:    'recommended_service',
    estimatedShippingCost: 'estimated_shipping_cost',
    estimatedShippingCurrency: 'estimated_shipping_currency',
    actualShippingCost:    'actual_shipping_cost',
    shippingMargin:        'shipping_margin',
    isWeightOverridden:    'is_weight_overridden',
    overriddenWeightG:     'overridden_weight_g',
    overrideReason:        'override_reason',
    masterWeightUpdated:   'master_weight_updated',
  };
  const row = {};
  // 1) camelCase 입력
  for (const [camel, snake] of Object.entries(map)) {
    if (input[camel] !== undefined) row[snake] = input[camel];
  }
  // 2) snake_case 도 그대로 받아줌 (호출자 편의)
  for (const k of Object.keys(input)) {
    if (ALLOWED_PATCH_FIELDS.has(k)) row[k] = input[k];
  }
  return row;
}

function _decorate(r) {
  if (!r) return null;
  return {
    id: r.id,
    orderId: r.order_id,
    productWeightG:     r.product_weight_g    != null ? Number(r.product_weight_g)    : null,
    packagingWeightG:   r.packaging_weight_g  != null ? Number(r.packaging_weight_g)  : null,
    finalWeightG:       r.final_weight_g      != null ? Number(r.final_weight_g)      : null,
    volumetricWeightG:  r.volumetric_weight_g != null ? Number(r.volumetric_weight_g) : null,
    chargeableWeightG:  r.chargeable_weight_g != null ? Number(r.chargeable_weight_g) : null,
    recommendedCarrier:  r.recommended_carrier || null,
    recommendedService:  r.recommended_service || null,
    estimatedShippingCost:     r.estimated_shipping_cost     != null ? Number(r.estimated_shipping_cost) : null,
    estimatedShippingCurrency: r.estimated_shipping_currency || 'KRW',
    actualShippingCost:  r.actual_shipping_cost != null ? Number(r.actual_shipping_cost) : null,
    shippingMargin:      r.shipping_margin     != null ? Number(r.shipping_margin)     : null,
    isWeightOverridden:  !!r.is_weight_overridden,
    overriddenWeightG:   r.overridden_weight_g != null ? Number(r.overridden_weight_g) : null,
    overrideReason:      r.override_reason || null,
    masterWeightUpdated: !!r.master_weight_updated,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── 조회 ──────────────────────────────────────────────────

/** 단일 주문의 배송 정보. 없으면 null. */
async function getByOrderId(orderId) {
  const oid = parseInt(orderId, 10);
  if (!Number.isFinite(oid)) return null;
  const { data, error } = await getClient()
    .from('order_shipments')
    .select(COLUMNS)
    .eq('order_id', oid)
    .maybeSingle();
  if (error) {
    // 마이그레이션 052 미적용 시 graceful — 빈 결과 반환
    if (/order_shipments.*does not exist|relation .* does not exist|PGRST205/.test(error.message + (error.code || ''))) return null;
    throw error;
  }
  return _decorate(data);
}

/** 여러 주문의 배송 정보 bulk lookup. orderId → shipment Map 반환. */
async function listByOrderIds(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return new Map();
  const ids = [...new Set(orderIds.map(n => parseInt(n, 10)).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const { data, error } = await getClient()
    .from('order_shipments')
    .select(COLUMNS)
    .in('order_id', ids);
  if (error) {
    if (/order_shipments.*does not exist|relation .* does not exist|PGRST205/.test(error.message + (error.code || ''))) return new Map();
    throw error;
  }
  const map = new Map();
  for (const r of data || []) map.set(r.order_id, _decorate(r));
  return map;
}

// ── 쓰기 ──────────────────────────────────────────────────

/**
 * 주문별 배송 정보 upsert. order_id 가 UNIQUE 라 한 행만 유지.
 * @param {Object} params
 * @param {number} params.orderId  — wms_orders.id (필수)
 * @param {Object} params.fields   — camelCase 또는 snake_case 부분 업데이트
 * @returns {Promise<Object>} decorated row
 */
async function upsertForOrder({ orderId, fields = {} }) {
  const oid = parseInt(orderId, 10);
  if (!Number.isFinite(oid)) throw new Error('orderId 필수');

  const row = { order_id: oid, ...toRow(fields), updated_at: new Date().toISOString() };
  const { data, error } = await getClient()
    .from('order_shipments')
    .upsert(row, { onConflict: 'order_id' })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return _decorate(data);
}

/**
 * Phase 4 인라인 수정 전용 helper — 무게 수동 수정 + 사유 기록.
 *   - 단순 wrapper: overriddenWeightG + override_reason + is_weight_overridden=true.
 *   - master 반영 여부는 별도 호출 (markMasterUpdated).
 */
async function setOverride({ orderId, overriddenWeightG, overrideReason }) {
  if (overriddenWeightG == null || !(overriddenWeightG > 0)) {
    throw new Error('overriddenWeightG 는 양수여야 합니다');
  }
  return upsertForOrder({
    orderId,
    fields: {
      isWeightOverridden: true,
      overriddenWeightG: Number(overriddenWeightG),
      overrideReason: overrideReason || null,
    },
  });
}

/** sku_master 반영 여부 토글. Phase 4 의 'SKU 마스터에도 반영' 옵션. */
async function markMasterUpdated(orderId, value = true) {
  return upsertForOrder({ orderId, fields: { masterWeightUpdated: !!value } });
}

/** 배송 row 삭제 (테스트·롤백 용). 운영에서는 거의 사용 X — order 삭제 시 CASCADE. */
async function removeByOrderId(orderId) {
  const oid = parseInt(orderId, 10);
  if (!Number.isFinite(oid)) return;
  const { error } = await getClient()
    .from('order_shipments')
    .delete()
    .eq('order_id', oid);
  if (error) throw error;
}

module.exports = {
  getByOrderId,
  listByOrderIds,
  upsertForOrder,
  setOverride,
  markMasterUpdated,
  removeByOrderId,
  // re-export for tests / phase 3 service
  _decorate, toRow, ALLOWED_PATCH_FIELDS,
};
