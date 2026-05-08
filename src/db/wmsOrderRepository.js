/**
 * src/db/wmsOrderRepository.js — WMS 주문 (wms_orders / wms_order_lines) CRUD wrapper
 *
 * 이름 결정 (2026-05-09):
 *   기존 src/db/orderRepository.js 는 public.orders (eBay 주문 sync) 전용 — 수정 금지.
 *   본 파일은 Phase 2 의 wms_orders / wms_order_lines 만 다룬다.
 *
 * 중요:
 *   - 본 파일은 public.orders / order_lines 를 절대 참조하지 않는다.
 *     모든 from() 인자는 'wms_orders' 또는 'wms_order_lines' 만 사용.
 *   - raw_payload / buyer_contact 의 redact 적용은 호출자 (orderImporter) 책임.
 *     repo 는 받은 값 그대로 저장한다.
 *   - 039 schema 의 컬럼만 다룬다.
 *
 * 039 wms_orders 컬럼:
 *   id, marketplace, external_order_id, order_status, buyer_name, buyer_country,
 *   buyer_contact, ordered_at, total_amount, currency, raw_payload,
 *   import_source, imported_by, created_at, updated_at
 *
 * 039 wms_order_lines 컬럼:
 *   id, order_id, external_line_id, marketplace_sku, listing_id, option_id, title,
 *   quantity, unit_price, currency, matched_sku_id, match_status, match_reason,
 *   match_confidence, raw_payload, created_at, updated_at
 */
'use strict';

const { getClient } = require('./supabaseClient');

class DuplicateOrderError extends Error {
  constructor(marketplace, externalOrderId, existing) {
    super(`Duplicate WMS order: marketplace=${marketplace}, external_order_id=${externalOrderId}`);
    this.code = 'DUPLICATE_ORDER';
    this.marketplace = marketplace;
    this.externalOrderId = externalOrderId;
    this.existing = existing || null;
  }
}

// ── orders ────────────────────────────────────────────────

/**
 * marketplace + external_order_id 로 기존 wms_orders 1건 조회.
 * @returns row or null
 */
async function getWmsOrderByMarketplaceExternalId(marketplace, externalOrderId) {
  const { data, error } = await getClient()
    .from('wms_orders')
    .select('*')
    .eq('marketplace', marketplace)
    .eq('external_order_id', externalOrderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * wms_orders insert.
 * payload 는 039 컬럼만 포함 (호출자가 redact 적용 후 전달).
 * UNIQUE 위반 (23505) 은 DuplicateOrderError 로 변환해 던진다.
 */
async function createWmsOrder(payload) {
  const { data, error } = await getClient()
    .from('wms_orders')
    .insert(payload)
    .select()
    .single();
  if (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      const existing = await getWmsOrderByMarketplaceExternalId(
        payload.marketplace, payload.external_order_id,
      ).catch(() => null);
      throw new DuplicateOrderError(payload.marketplace, payload.external_order_id, existing);
    }
    throw error;
  }
  return data;
}

async function listWmsOrders({ marketplace, status, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const safeOffset = Math.max(0, Number(offset) || 0);
  let q = getClient()
    .from('wms_orders')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);
  if (marketplace) q = q.eq('marketplace', marketplace);
  if (status) q = q.eq('order_status', status);
  const { data, error, count } = await q;
  if (error) throw error;
  return { data: data || [], total: count || 0 };
}

async function getWmsOrderWithLines(orderId) {
  const c = getClient();
  const [orderRes, linesRes] = await Promise.all([
    c.from('wms_orders').select('*').eq('id', orderId).maybeSingle(),
    c.from('wms_order_lines').select('*').eq('order_id', orderId).order('id', { ascending: true }),
  ]);
  if (orderRes.error) throw orderRes.error;
  if (linesRes.error) throw linesRes.error;
  if (!orderRes.data) return null;
  return { ...orderRes.data, lines: linesRes.data || [] };
}

// ── order_lines ────────────────────────────────────────────────

/**
 * wms_order_lines bulk insert. lines 는 호출자가 redact 통과시킨 상태.
 * 각 line 에 order_id 자동 주입.
 */
async function createWmsOrderLines(orderId, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const rows = lines.map((l) => ({ ...l, order_id: orderId }));
  const { data, error } = await getClient()
    .from('wms_order_lines')
    .insert(rows)
    .select();
  if (error) throw error;
  return data || [];
}

/**
 * 매칭 결과로 line 1건 update.
 * matchResult: { matched_sku_id, match_status, match_confidence, match_reason }
 */
async function updateWmsOrderLineMatch(lineId, matchResult) {
  const updates = {
    matched_sku_id:    matchResult.matched_sku_id ?? null,
    match_status:      matchResult.match_status   || 'pending',
    match_confidence:  matchResult.match_confidence ?? null,
    match_reason:      matchResult.match_reason   ?? null,
    updated_at:        new Date().toISOString(),
  };
  const { data, error } = await getClient()
    .from('wms_order_lines')
    .update(updates)
    .eq('id', lineId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function listWmsOrderLines(orderId) {
  const { data, error } = await getClient()
    .from('wms_order_lines')
    .select('*')
    .eq('order_id', orderId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = {
  DuplicateOrderError,
  // orders
  createWmsOrder,
  getWmsOrderByMarketplaceExternalId,
  listWmsOrders,
  getWmsOrderWithLines,
  // lines
  createWmsOrderLines,
  updateWmsOrderLineMatch,
  listWmsOrderLines,
};
