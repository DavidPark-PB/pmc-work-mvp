/**
 * src/services/oms/inventoryShadowService.js — Phase 6D-1 foundation.
 *
 * Owner directive:
 *   - Ledger-first: every inventory mutation is an immutable movement event
 *     in `inventory_movements` (081 extended by 089).
 *   - Shadow mode ONLY in Phase 6D-1: compute what movements would fire for
 *     existing orders WITHOUT writing to inventory_movements.
 *   - Never touch products.stock / ebay_products.stock / marketplace inventory API.
 *   - Reservation lifecycle: order paid → +reserved · cancelled → -reserved ·
 *     shipped → -reserved + -on_hand · returned (physical) → +on_hand ·
 *     refund without return → NO movement.
 *
 * This module provides:
 *   - proposeMovementForOrderItem(item, order) — pure calculation · no DB write
 *   - shadowForLatestOrders({limit}) — batch shadow calculation with mapping
 *   - getPhysicalInventoryState(physicalProductId) — SUM ledger (READ-ONLY)
 *   - getSellableAvailability(sellableUnitId) — floor(physical_available / qty_per_unit)
 *                                                for single-component sellable_units;
 *                                                MIN across components for bundles
 *   - buildIdempotencyKey(eventType, orderId, orderItemId, [extra])
 *
 * NO write functions exposed. Movement insertion is deliberately NOT provided
 * to guarantee Phase 6D-1 is truly shadow.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');

// ─────────────────────────────────────────────────────────────
// Event → movement contract
// ─────────────────────────────────────────────────────────────

/**
 * Map an OMS event to a proposed movement shape.
 *   event_type   → { movement_type, quantity_delta_multiplier, reservation_delta_multiplier }
 *
 *   order_paid       → reservation      (0, +1)
 *   order_cancelled  → reservation_release  (0, -1)   -- only if was previously reserved
 *   order_shipped    → shipment         (-1, -1)      -- consume both on_hand and reserved
 *   order_returned   → return           (+1, 0)       -- physical receipt required
 *   order_refunded   → no movement                    -- money-only
 *   quantity_changed → adjustment       (delta, 0)    -- rare
 */
const EVENT_CONTRACT = Object.freeze({
  order_paid:      { movementType: 'reservation',         qtyMul: 0,  resMul: +1 },
  order_cancelled: { movementType: 'reservation_release', qtyMul: 0,  resMul: -1 },
  order_shipped:   { movementType: 'shipment',            qtyMul: -1, resMul: -1 },
  order_returned:  { movementType: 'return',              qtyMul: +1, resMul:  0 },
  order_refunded:  null,   // no movement
});

/**
 * Deterministic idempotency key.
 * Same business event on same order+item → same key → INSERT NO-OP via UNIQUE.
 */
function buildIdempotencyKey(eventType, orderId, orderItemId, extra = null) {
  if (!eventType || !orderId || !orderItemId) {
    throw new Error('buildIdempotencyKey: eventType/orderId/orderItemId required');
  }
  const base = `${eventType}:order=${orderId}:item=${orderItemId}`;
  return extra ? `${base}:${extra}` : base;
}

// ─────────────────────────────────────────────────────────────
// Proposal (single item · pure calculation)
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProposedMovement
 * @property {'proposed'|'blocked'|'no_movement'} status
 * @property {string} [blocked_reason]
 * @property {string} [event_type]
 * @property {string} [movement_type]
 * @property {number} [physical_product_id]
 * @property {number} [quantity_delta]       — on_hand change
 * @property {number} [reservation_delta]    — reserved change
 * @property {number} [required_physical_qty] — |physical_change|
 * @property {string} [idempotency_key]
 * @property {number} [sellable_unit_id]
 * @property {number} [order_id]
 * @property {number} [order_item_id]
 * @property {number} [order_qty]
 * @property {number} [qty_per_unit]
 */

/**
 * Compute proposed movement for one (order, order_item) given:
 *   - the sellable_unit + component that this order_item maps to (through
 *     sku_master → sku_master_link)
 *   - the OMS event we want to model
 *
 * NEVER writes.
 *
 * @param {Object} args
 * @param {Object} args.order            oms_orders row (id, channel, order_status, cancelled_at, shipped_at)
 * @param {Object} args.item             oms_order_items row (id, order_id, sku_master_id, quantity)
 * @param {'order_paid'|'order_cancelled'|'order_shipped'|'order_returned'|'order_refunded'} args.eventType
 * @param {Object} args.lookups          { sellableByS kuMasterId: Map, componentsBySellable: Map<id, {physicalId, qtyPerUnit}[]> }
 * @returns {ProposedMovement[]}         — usually 1 movement per (order_item, component) · bundle 은 여러 개
 */
function proposeMovementForOrderItem({ order, item, eventType, lookups }) {
  const orderId = order?.id;
  const orderItemId = item?.id;
  const orderQty = Number(item?.quantity) || 0;

  if (!orderId || !orderItemId) {
    return [{ status: 'blocked', blocked_reason: 'missing_order_or_item_id' }];
  }
  if (orderQty <= 0) {
    return [{ status: 'blocked', blocked_reason: 'order_qty_not_positive', order_id: orderId, order_item_id: orderItemId }];
  }

  if (!(eventType in EVENT_CONTRACT)) {
    return [{ status: 'blocked', blocked_reason: `unknown_event_type:${eventType}`, order_id: orderId, order_item_id: orderItemId }];
  }
  const contract = EVENT_CONTRACT[eventType];
  if (contract === null) {
    return [{ status: 'no_movement', event_type: eventType, order_id: orderId, order_item_id: orderItemId, reason: 'money_only_no_physical_change' }];
  }

  if (!item.sku_master_id) {
    return [{ status: 'blocked', blocked_reason: 'unmapped_sku_master', order_id: orderId, order_item_id: orderItemId }];
  }
  const sellableId = lookups?.sellableBySkuMasterId?.get(item.sku_master_id) ?? null;
  if (!sellableId) {
    return [{ status: 'blocked', blocked_reason: 'sku_master_not_linked_to_sellable_unit', order_id: orderId, order_item_id: orderItemId, sku_master_id: item.sku_master_id }];
  }
  const components = lookups?.componentsBySellable?.get(sellableId) ?? [];
  if (components.length === 0) {
    return [{ status: 'blocked', blocked_reason: 'sellable_unit_has_no_components', order_id: orderId, order_item_id: orderItemId, sellable_unit_id: sellableId }];
  }

  // One proposed movement per component (bundle → N movements)
  return components.map((c) => {
    const requiredPhysicalQty = orderQty * c.quantityPerUnit;
    const qty = requiredPhysicalQty * contract.qtyMul;
    const res = requiredPhysicalQty * contract.resMul;
    return {
      status: 'proposed',
      event_type: eventType,
      movement_type: contract.movementType,
      order_id: orderId,
      order_item_id: orderItemId,
      order_qty: orderQty,
      sellable_unit_id: sellableId,
      physical_product_id: c.physicalProductId,
      qty_per_unit: c.quantityPerUnit,
      required_physical_qty: requiredPhysicalQty,
      quantity_delta: qty,
      reservation_delta: res,
      idempotency_key: buildIdempotencyKey(eventType, orderId, orderItemId, `phys=${c.physicalProductId}`),
    };
  });
}

// ─────────────────────────────────────────────────────────────
// Batch shadow — compute expected movements for latest OMS orders
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {'ebay'|'shopify'|null} [opts.channel]
 * @param {number} [opts.latestIngest=10]  N most recent oms_orders (by imported_at desc)
 * @param {'order_paid'|'order_shipped'|'order_cancelled'|'order_returned'} [opts.eventType='order_paid']
 */
async function shadowForLatestOrders({ channel = null, latestIngest = 10, eventType = 'order_paid' } = {}) {
  const n = Math.max(1, Math.min(500, parseInt(latestIngest, 10) || 10));
  const db = getClient();

  let orderQ = db.from('oms_orders')
    .select('id, channel, external_order_id, external_order_number, order_status, payment_status, fulfillment_status, cancelled_at, shipped_at, imported_at')
    .order('imported_at', { ascending: false })
    .limit(n);
  if (channel) orderQ = orderQ.eq('channel', channel);
  const { data: orders, error: eO } = await orderQ;
  if (eO) throw eO;

  const orderIds = (orders || []).map(o => o.id);
  if (orderIds.length === 0) return { generatedAt: new Date().toISOString(), eventType, orders: [], proposals: [] };

  const { data: items, error: eI } = await db.from('oms_order_items')
    .select('id, order_id, external_line_id, marketplace_sku, listing_id, variant_id, quantity, sku_master_id, product_id, match_status')
    .in('order_id', orderIds);
  if (eI) throw eI;

  const skuMasterIds = [...new Set((items || []).map(i => i.sku_master_id).filter(Boolean))];

  // Lookup 1: sku_master → sellable_unit
  const sellableBySkuMasterId = new Map();
  if (skuMasterIds.length) {
    const { data: links } = await db.from('sku_master_link')
      .select('sku_master_id, sellable_unit_id')
      .in('sku_master_id', skuMasterIds);
    (links || []).forEach(l => sellableBySkuMasterId.set(l.sku_master_id, l.sellable_unit_id));
  }

  // Lookup 2: sellable_unit → components (physical_product_id, quantity_per_unit)
  const sellableIds = [...new Set([...sellableBySkuMasterId.values()])];
  const componentsBySellable = new Map();
  if (sellableIds.length) {
    const { data: comps } = await db.from('sellable_unit_components')
      .select('sellable_unit_id, physical_product_id, quantity_per_unit, role')
      .in('sellable_unit_id', sellableIds);
    for (const c of (comps || [])) {
      const arr = componentsBySellable.get(c.sellable_unit_id) || [];
      arr.push({ physicalProductId: c.physical_product_id, quantityPerUnit: c.quantity_per_unit, role: c.role });
      componentsBySellable.set(c.sellable_unit_id, arr);
    }
  }

  const lookups = { sellableBySkuMasterId, componentsBySellable };
  const orderById = new Map((orders || []).map(o => [o.id, o]));

  const proposals = [];
  for (const it of (items || [])) {
    const order = orderById.get(it.order_id);
    const rows = proposeMovementForOrderItem({ order, item: it, eventType, lookups });
    for (const r of rows) proposals.push(r);
  }

  return {
    generatedAt: new Date().toISOString(),
    eventType,
    channelFilter: channel,
    latestIngest: n,
    ordersFetched: orders.length,
    itemsFetched: items?.length ?? 0,
    proposals,
  };
}

// ─────────────────────────────────────────────────────────────
// Read-only state (Σ ledger)
// ─────────────────────────────────────────────────────────────

/**
 * Sum inventory_movements for a physical_product.
 * on_hand   = Σ quantity_delta      where physical_product_id = X
 * reserved  = Σ reservation_delta   where physical_product_id = X
 * available = on_hand - reserved
 *
 * @param {number} physicalProductId
 */
async function getPhysicalInventoryState(physicalProductId) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const { data, error } = await getClient().from('inventory_movements')
    .select('quantity_delta, reservation_delta')
    .eq('physical_product_id', physicalProductId);
  if (error) throw error;
  const rows = data || [];
  const on_hand = rows.reduce((a, r) => a + (Number(r.quantity_delta) || 0), 0);
  const reserved = rows.reduce((a, r) => a + (Number(r.reservation_delta) || 0), 0);
  return {
    physical_product_id: physicalProductId,
    on_hand,
    reserved,
    available: on_hand - reserved,
    movement_count: rows.length,
  };
}

/**
 * Sellable availability = floor(physical_available / quantity_per_unit)
 *   single-component : direct division
 *   bundle           : MIN across components (bottleneck)
 */
async function getSellableAvailability(sellableUnitId) {
  if (!Number.isInteger(sellableUnitId) || sellableUnitId <= 0) {
    throw new Error('sellableUnitId required');
  }
  const { data: comps, error } = await getClient().from('sellable_unit_components')
    .select('physical_product_id, quantity_per_unit')
    .eq('sellable_unit_id', sellableUnitId);
  if (error) throw error;
  const components = comps || [];
  if (components.length === 0) return { sellable_unit_id: sellableUnitId, available: 0, blocked_reason: 'no_components' };

  const perComponent = [];
  for (const c of components) {
    const st = await getPhysicalInventoryState(c.physical_product_id);
    const capForThis = Math.floor(st.available / c.quantity_per_unit);
    perComponent.push({
      physical_product_id: c.physical_product_id,
      quantity_per_unit: c.quantity_per_unit,
      physical_available: st.available,
      capForThis,
    });
  }
  const available = perComponent.reduce((min, p) => Math.min(min, p.capForThis), Number.POSITIVE_INFINITY);
  return {
    sellable_unit_id: sellableUnitId,
    available: available === Number.POSITIVE_INFINITY ? 0 : available,
    components: perComponent,
  };
}

/**
 * Marketplace listing cap projection (safety_buffer subtracted from available).
 * Returns non-negative integer count of sellable units the channel can advertise.
 */
async function computeChannelListingCap({ sellableUnitId, safetyBuffer = 0 }) {
  const av = await getSellableAvailability(sellableUnitId);
  const cap = Math.max(0, av.available - Math.max(0, safetyBuffer));
  return { sellable_unit_id: sellableUnitId, projected_channel_cap: cap, physical_availability: av };
}

module.exports = {
  EVENT_CONTRACT,
  buildIdempotencyKey,
  proposeMovementForOrderItem,
  shadowForLatestOrders,
  getPhysicalInventoryState,
  getSellableAvailability,
  computeChannelListingCap,
};
