/**
 * src/services/oms/omsOrderRepository.js — DB CRUD for oms_orders + oms_order_items.
 *
 * Owner directive §4: 모든 channel adapter 가 이 repo 를 통과한다.
 *                     Adapter 는 절대 supabase.from('oms_orders').insert(...) 하지 않는다.
 *
 * 이 파일은 DB 접근 계층. 비즈니스 로직 (field ownership, idempotency 전략) 은
 * omsOrderService.js.
 *
 * DB column 은 snake_case ↔ Canonical DTO camelCase 사이 mapping 은 여기서 수행.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');

// ─────────────────────────────────────────────────────────────
// Column mapping (Canonical → DB row)
// ─────────────────────────────────────────────────────────────
function orderToRow(order) {
  return {
    channel: order.channel,
    external_order_id: order.externalOrderId,
    external_order_number: order.externalOrderNumber,
    order_type: order.orderType,
    import_source: order.importSource,
    order_status: order.orderStatus,
    payment_status: order.paymentStatus,
    fulfillment_status: order.fulfillmentStatus,
    raw_order_status: order.rawOrderStatus,
    raw_payment_status: order.rawPaymentStatus,
    raw_fulfillment_status: order.rawFulfillmentStatus,

    buyer_name: order.buyer?.name ?? null,
    buyer_email: order.buyer?.email ?? null,
    buyer_phone: order.buyer?.phone ?? null,
    buyer_country: order.buyer?.country ?? null,
    buyer_country_code: order.buyer?.countryCode ?? null,

    ship_recipient_name: order.shippingAddress?.recipientName ?? null,
    ship_street1: order.shippingAddress?.street1 ?? null,
    ship_street2: order.shippingAddress?.street2 ?? null,
    ship_city: order.shippingAddress?.city ?? null,
    ship_state: order.shippingAddress?.state ?? null,
    ship_postal_code: order.shippingAddress?.postalCode ?? null,
    ship_country: order.shippingAddress?.country ?? null,
    ship_country_code: order.shippingAddress?.countryCode ?? null,
    ship_phone: order.shippingAddress?.phone ?? null,

    currency: order.currency,
    subtotal: order.subtotal,
    shipping_charged: order.shippingCharged,
    discount: order.discount,
    tax: order.tax,
    total: order.total,

    hold_reason: order.holdReason,
    hold_note: order.holdNote,
    cancellation_reason: order.cancellationReason,
    cancellation_note: order.cancellationNote,
    notes: order.notes,

    ordered_at: order.orderedAt,
    paid_at: order.paidAt,
    confirmed_at: order.confirmedAt,
    ready_to_ship_at: order.readyToShipAt,
    shipped_at: order.shippedAt,
    completed_at: order.completedAt,
    cancelled_at: order.cancelledAt,
    returned_at: order.returnedAt,

    raw_payload: order.rawPayload,
    source_system: order.sourceSystem,
    imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function itemToRow(item, orderId) {
  return {
    order_id: orderId,
    external_line_id: item.externalLineId,
    product_id: item.productId ?? null,
    sku_master_id: item.skuMasterId ?? null,
    marketplace_sku: item.marketplaceSku ?? null,
    listing_id: item.listingId ?? null,
    variant_id: item.variantId ?? null,
    title: item.title ?? null,
    quantity: item.quantity,
    unit_price: item.unitPrice ?? null,
    discount: item.discount ?? null,
    currency: item.currency ?? null,
    unit_cost_snapshot: item.unitCostSnapshot ?? null,
    landed_cost_snapshot: item.landedCostSnapshot ?? null,
    cost_currency: item.costCurrency ?? null,
    cost_source: item.costSource ?? null,
    match_status: item.matchStatus ?? 'pending',
    match_reason: item.matchReason ?? null,
    match_confidence: item.matchConfidence ?? null,
    raw_payload: item.rawPayload ?? null,
    updated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Order queries
// ─────────────────────────────────────────────────────────────
async function findByChannelExternalId(channel, externalOrderId) {
  const { data, error } = await getClient()
    .from('oms_orders')
    .select('*')
    .eq('channel', channel)
    .eq('external_order_id', externalOrderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertOrder(order) {
  const row = orderToRow(order);
  const { data, error } = await getClient()
    .from('oms_orders')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateOrderPartial(orderId, patch) {
  const row = { ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await getClient()
    .from('oms_orders')
    .update(row)
    .eq('id', orderId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────
// Item queries
// ─────────────────────────────────────────────────────────────
async function listItemsByOrderId(orderId) {
  const { data, error } = await getClient()
    .from('oms_order_items')
    .select('*')
    .eq('order_id', orderId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function insertItems(orderId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const rows = items.map((i) => itemToRow(i, orderId));
  const { data, error } = await getClient()
    .from('oms_order_items')
    .insert(rows)
    .select();
  if (error) throw error;
  return data || [];
}

async function updateItemPartial(itemId, patch) {
  const row = { ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await getClient()
    .from('oms_order_items')
    .update(row)
    .eq('id', itemId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  // mappers (exported for tests)
  orderToRow,
  itemToRow,
  // orders
  findByChannelExternalId,
  insertOrder,
  updateOrderPartial,
  // items
  listItemsByOrderId,
  insertItems,
  updateItemPartial,
};
