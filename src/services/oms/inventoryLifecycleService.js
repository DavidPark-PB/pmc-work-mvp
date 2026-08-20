/**
 * src/services/oms/inventoryLifecycleService.js — Phase 6D-3.
 *
 * Owner directive:
 *   Order lifecycle → inventory ledger foundation. MANUAL APPLY only —
 *   automation hook is not wired in this phase.
 *
 *   Movement contract (Owner §2):
 *     order_paid                   → reservation           (0, +N)
 *     order_cancelled BEFORE ship  → reservation_release   (0, -N)
 *     order_shipped                → shipment              (-N, -N)
 *     order_returned + physical    → return                (+N, 0)
 *     order_refunded               → NO movement
 *
 *   Semantics NOT to confuse (Owner §2):
 *     refund ≠ return
 *     label_created ≠ shipped
 *     tracking_created ≠ shipped   (FedEx auto-sets `orders.status=SHIPPED` on label — DO NOT use)
 *     cancelled_after_shipment ≠ reservation_release
 *
 *   State machine (per order_item × physical_product):
 *     UNRESERVED → RESERVED       (order_paid)
 *     RESERVED   → CANCELLED_RELEASED  (order_cancelled BEFORE ship)
 *     RESERVED   → SHIPPED         (order_shipped)
 *     SHIPPED    → RETURNED        (order_returned)
 *     UNRESERVED → SHIPPED         (recovery: shipped_at seen without prior reservation)
 *
 *   Illegal transitions blocked (never negative reserved):
 *     SHIPPED → CANCELLED_RELEASED — cancel after ship does not restore stock
 *     UNRESERVED → CANCELLED_RELEASED — nothing to release
 *     Any → RESERVED again after RESERVED — duplicate is idempotent
 *
 *   Oversell protection:
 *     reservation requires available_to_promise >= required
 *     baseline (initial_baseline receipt) must exist
 *
 *   Idempotency:
 *     key = '<event>:order=<oid>:item=<iid>:phys=<pid>'
 *     UNIQUE partial index (089) is the DB-level defense.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const shadow = require('./inventoryShadowService');
const { logActivity } = require('./activityLogger');

const EVENT_TO_MOVEMENT_TYPE = Object.freeze({
  order_paid: 'reservation',
  order_cancelled: 'reservation_release',
  order_shipped: 'shipment',
  order_returned: 'return',
});

// ─────────────────────────────────────────────────────────────
// Ledger state derivation (per order_item × physical)
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all movements ever recorded for one (order_item, physical) tuple.
 * Also lists baseline movements for the physical (idempotency_key='initial_baseline:physical=X')
 * so we can enforce "baseline must exist before any reservation/shipment".
 *
 * @returns {Promise<{
 *   movements: Array<{id,movement_type,quantity_delta,reservation_delta,idempotency_key,occurred_at,metadata}>,
 *   hasBaseline: boolean,
 *   stateFlags: { reserved:boolean, released:boolean, shipped:boolean, returned:boolean },
 * }>}
 */
async function getItemPhysicalLedger({ orderItemId, physicalProductId }) {
  const db = getClient();

  // (a) baseline for this physical (any 'initial_baseline:*' movement)
  const baselineKey = `initial_baseline:physical=${physicalProductId}`;
  const { data: baseline, error: eB } = await db.from('inventory_movements')
    .select('id, quantity_delta, occurred_at, idempotency_key')
    .eq('idempotency_key', baselineKey)
    .maybeSingle();
  if (eB) throw eB;

  // (b) movements tied to this specific order_item + physical
  const { data: itemMoves, error: eM } = await db.from('inventory_movements')
    .select('id, movement_type, quantity_delta, reservation_delta, idempotency_key, occurred_at, metadata')
    .eq('related_order_item_id', orderItemId)
    .eq('physical_product_id', physicalProductId);
  if (eM) throw eM;

  const rows = itemMoves || [];
  const flags = {
    reserved: rows.some(r => r.movement_type === 'reservation'),
    released: rows.some(r => r.movement_type === 'reservation_release'),
    shipped: rows.some(r => r.movement_type === 'shipment'),
    returned: rows.some(r => r.movement_type === 'return'),
  };
  return { movements: rows, hasBaseline: !!baseline, stateFlags: flags };
}

/**
 * Derive the observed state for one (order_item, physical) from movement flags.
 *
 * @returns {'UNRESERVED'|'RESERVED'|'CANCELLED_RELEASED'|'SHIPPED'|'RETURNED'}
 */
function deriveState({ stateFlags }) {
  if (stateFlags.returned) return 'RETURNED';
  if (stateFlags.shipped) return 'SHIPPED';
  if (stateFlags.released && !stateFlags.shipped) return 'CANCELLED_RELEASED';
  if (stateFlags.reserved && !stateFlags.released && !stateFlags.shipped) return 'RESERVED';
  return 'UNRESERVED';
}

// ─────────────────────────────────────────────────────────────
// Order canonical status evidence
// ─────────────────────────────────────────────────────────────

async function getOrderStatusEvidence(orderId) {
  const { data, error } = await getClient().from('oms_orders')
    .select('id, channel, external_order_id, external_order_number, order_status, payment_status, fulfillment_status, paid_at, shipped_at, cancelled_at, returned_at, raw_order_status, raw_payment_status, raw_fulfillment_status')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Does the canonical order status support the requested lifecycle event?
 *   order_paid       → payment_status ∈ {paid, partially_paid}   OR paid_at NOT NULL
 *   order_cancelled  → cancelled_at NOT NULL                     OR order_status='cancelled'
 *   order_shipped    → fulfillment_status ∈ {fulfilled, partially_fulfilled}
 *                                                                OR shipped_at NOT NULL
 *   order_returned   → returned_at NOT NULL                      OR fulfillment_status='returned'
 *   order_refunded   → payment_status ∈ {refunded, partially_refunded}
 *
 * @returns {{ supported:boolean, reason:string, evidence:object }}
 */
function orderStatusSupportsEvent(order, eventType) {
  if (!order) return { supported: false, reason: 'order_not_found', evidence: {} };
  const os = String(order.order_status || '').toLowerCase();
  const ps = String(order.payment_status || '').toLowerCase();
  const fs = String(order.fulfillment_status || '').toLowerCase();
  const evidence = {
    order_status: order.order_status, payment_status: order.payment_status, fulfillment_status: order.fulfillment_status,
    paid_at: order.paid_at, shipped_at: order.shipped_at, cancelled_at: order.cancelled_at, returned_at: order.returned_at,
    raw_payment_status: order.raw_payment_status, raw_fulfillment_status: order.raw_fulfillment_status,
    raw_order_status: order.raw_order_status,
  };
  switch (eventType) {
    case 'order_paid':
      if (ps === 'paid' || ps === 'partially_paid' || order.paid_at) return { supported: true, reason: `payment_status=${ps}${order.paid_at ? ' · paid_at set' : ''}`, evidence };
      return { supported: false, reason: `payment_status=${ps} · paid_at=${order.paid_at ?? 'null'}`, evidence };
    case 'order_cancelled':
      if (order.cancelled_at || os === 'cancelled') return { supported: true, reason: `cancelled_at=${order.cancelled_at ?? 'null'} · order_status=${os}`, evidence };
      return { supported: false, reason: `order_status=${os} · cancelled_at=${order.cancelled_at ?? 'null'}`, evidence };
    case 'order_shipped':
      if (fs === 'fulfilled' || fs === 'partially_fulfilled' || order.shipped_at) return { supported: true, reason: `fulfillment_status=${fs}${order.shipped_at ? ' · shipped_at set' : ''}`, evidence };
      return { supported: false, reason: `fulfillment_status=${fs} · shipped_at=${order.shipped_at ?? 'null'}`, evidence };
    case 'order_returned':
      if (order.returned_at || fs === 'returned') return { supported: true, reason: `returned_at=${order.returned_at ?? 'null'} · fulfillment_status=${fs}`, evidence };
      return { supported: false, reason: `returned_at=${order.returned_at ?? 'null'} · fulfillment_status=${fs}`, evidence };
    case 'order_refunded':
      if (ps === 'refunded' || ps === 'partially_refunded') return { supported: true, reason: `payment_status=${ps} · money-only · NO inventory movement`, evidence };
      return { supported: false, reason: `payment_status=${ps}`, evidence };
    default:
      return { supported: false, reason: `unknown_event_type:${eventType}`, evidence };
  }
}

// ─────────────────────────────────────────────────────────────
// Propose (dry-run) — one order · one event · N (item × physical) proposals
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LifecycleProposal
 * @property {'proposed_apply'|'proposed_no_movement'|'proposed_recovery'|'blocked'|'idempotent_no_op'} status
 * @property {number} order_id
 * @property {number} order_item_id
 * @property {number} physical_product_id
 * @property {string} channel
 * @property {string} external_order_id
 * @property {string} event_type
 * @property {string|null} movement_type
 * @property {number} order_qty
 * @property {number} qty_per_unit
 * @property {number} required_physical_qty
 * @property {number} current_on_hand
 * @property {number} current_reserved
 * @property {number} current_available
 * @property {number} quantity_delta
 * @property {number} reservation_delta
 * @property {string} current_ledger_state
 * @property {string} idempotency_key
 * @property {object} source_status_evidence
 * @property {string[]} reason
 * @property {string} decision
 */

async function proposeLifecycleForOrder({ orderId, eventType }) {
  if (!Number.isInteger(orderId) || orderId <= 0) throw new Error('orderId required positive integer');
  if (!eventType) throw new Error('eventType required');

  const db = getClient();
  const order = await getOrderStatusEvidence(orderId);
  const evidence = orderStatusSupportsEvent(order, eventType);
  if (!order) return { orderId, eventType, blocked: 'order_not_found', proposals: [] };

  // Base proposals from shadow service (handles unmapped sku_master / missing components / unknown event)
  const { data: items } = await db.from('oms_order_items')
    .select('id, order_id, external_line_id, sku_master_id, quantity, listing_id, variant_id, marketplace_sku, match_status')
    .eq('order_id', orderId);

  const skuMasterIds = [...new Set((items || []).map(i => i.sku_master_id).filter(Boolean))];
  const sellableBySkuMasterId = new Map();
  if (skuMasterIds.length) {
    const { data: links } = await db.from('sku_master_link')
      .select('sku_master_id, sellable_unit_id').in('sku_master_id', skuMasterIds);
    (links || []).forEach(l => sellableBySkuMasterId.set(l.sku_master_id, l.sellable_unit_id));
  }
  const sellableIds = [...new Set([...sellableBySkuMasterId.values()])];
  const componentsBySellable = new Map();
  if (sellableIds.length) {
    const { data: comps } = await db.from('sellable_unit_components')
      .select('sellable_unit_id, physical_product_id, quantity_per_unit, role').in('sellable_unit_id', sellableIds);
    for (const c of (comps || [])) {
      const arr = componentsBySellable.get(c.sellable_unit_id) || [];
      arr.push({ physicalProductId: c.physical_product_id, quantityPerUnit: c.quantity_per_unit, role: c.role });
      componentsBySellable.set(c.sellable_unit_id, arr);
    }
  }
  const lookups = { sellableBySkuMasterId, componentsBySellable };

  const proposals = [];
  for (const it of (items || [])) {
    const rows = shadow.proposeMovementForOrderItem({ order, item: it, eventType, lookups });
    for (const r of rows) {
      // Refund case (no_movement)
      if (r.status === 'no_movement') {
        proposals.push({
          status: 'proposed_no_movement',
          order_id: orderId, order_item_id: it.id,
          physical_product_id: null,
          channel: order.channel, external_order_id: order.external_order_id,
          event_type: eventType, movement_type: null,
          order_qty: it.quantity, qty_per_unit: null, required_physical_qty: 0,
          current_on_hand: null, current_reserved: null, current_available: null,
          quantity_delta: 0, reservation_delta: 0,
          current_ledger_state: 'n/a', idempotency_key: null,
          source_status_evidence: evidence,
          reason: [r.reason || 'no_inventory_impact'],
          decision: 'refund is money-only · no movement',
        });
        continue;
      }
      if (r.status === 'blocked') {
        proposals.push({
          status: 'blocked',
          order_id: orderId, order_item_id: it.id,
          physical_product_id: r.physical_product_id ?? null,
          channel: order.channel, external_order_id: order.external_order_id,
          event_type: eventType, movement_type: null,
          order_qty: it.quantity, qty_per_unit: null, required_physical_qty: 0,
          current_on_hand: null, current_reserved: null, current_available: null,
          quantity_delta: 0, reservation_delta: 0,
          current_ledger_state: 'n/a', idempotency_key: null,
          source_status_evidence: evidence,
          reason: [r.blocked_reason || 'unknown'],
          decision: 'blocked · no write',
        });
        continue;
      }

      // r.status === 'proposed' — evaluate state machine + oversell
      const ledger = await getItemPhysicalLedger({ orderItemId: it.id, physicalProductId: r.physical_product_id });
      const currentState = deriveState({ stateFlags: ledger.stateFlags });
      const phyState = await shadow.getPhysicalInventoryState(r.physical_product_id);
      const available = phyState.available;

      const reasons = [];
      let decision = 'proposed_apply';
      let status = 'proposed_apply';
      let movementType = r.movement_type;
      let quantityDelta = r.quantity_delta;
      let reservationDelta = r.reservation_delta;

      // Source status evidence must support the requested event
      if (!evidence.supported) {
        status = 'blocked';
        reasons.push(`canonical_status_does_not_support_event: ${evidence.reason}`);
        decision = 'blocked · order state does not support event';
      }

      // Baseline requirement — reservation / shipment / return all require a baseline for the physical.
      if (status !== 'blocked' && !ledger.hasBaseline) {
        status = 'blocked';
        reasons.push('missing_physical_baseline');
        decision = 'blocked · initial_baseline movement not found for this physical';
      }

      // State machine transitions
      if (status !== 'blocked') {
        if (eventType === 'order_paid') {
          if (currentState === 'RESERVED' || currentState === 'SHIPPED' || currentState === 'RETURNED') {
            status = 'idempotent_no_op';
            decision = `already ${currentState} · reservation not repeated`;
            reasons.push(`state=${currentState}`);
          }
        } else if (eventType === 'order_cancelled') {
          if (currentState === 'SHIPPED' || currentState === 'RETURNED') {
            status = 'blocked';
            reasons.push('cancel_after_shipment_or_return_does_not_restore_stock');
            decision = 'blocked · SHIPPED/RETURNED cannot be released';
          } else if (currentState === 'UNRESERVED' || currentState === 'CANCELLED_RELEASED') {
            status = 'idempotent_no_op';
            decision = `nothing to release · state=${currentState}`;
            reasons.push(`state=${currentState}`);
          }
        } else if (eventType === 'order_shipped') {
          if (currentState === 'SHIPPED' || currentState === 'RETURNED') {
            status = 'idempotent_no_op';
            decision = `already ${currentState}`;
            reasons.push(`state=${currentState}`);
          } else if (currentState === 'CANCELLED_RELEASED') {
            status = 'blocked';
            reasons.push('cannot_ship_after_release');
            decision = 'blocked · state was CANCELLED_RELEASED';
          } else if (currentState === 'UNRESERVED') {
            // Recovery semantics — ship without prior reservation. Do NOT release reserved (would go negative).
            status = 'proposed_recovery';
            reservationDelta = 0;   // override — no reserved to release
            reasons.push('recovery_shipment_without_prior_reservation');
            decision = 'proposed · shipment applied WITHOUT reservation release (recovery mode)';
          }
        } else if (eventType === 'order_returned') {
          if (currentState !== 'SHIPPED') {
            status = 'blocked';
            reasons.push('return_requires_prior_shipment');
            decision = `blocked · state=${currentState} · return only valid after SHIPPED`;
          } else if (currentState === 'RETURNED') {
            status = 'idempotent_no_op';
            decision = 'already RETURNED';
          }
        }
      }

      // Oversell check — only relevant when this movement would DECREASE availability (reservation or recovery shipment)
      if (status === 'proposed_apply' && eventType === 'order_paid') {
        if (available < r.required_physical_qty) {
          status = 'blocked';
          reasons.push(`insufficient_available_to_promise: available=${available} < required=${r.required_physical_qty}`);
          decision = 'blocked_insufficient_available';
        }
      }
      if (status === 'proposed_recovery' && eventType === 'order_shipped') {
        // Recovery shipment consumes on_hand only (no prior reservation to release).
        if (phyState.on_hand < r.required_physical_qty) {
          status = 'blocked';
          reasons.push(`insufficient_on_hand_for_recovery_shipment: on_hand=${phyState.on_hand} < required=${r.required_physical_qty}`);
          decision = 'blocked_insufficient_on_hand';
        }
      }

      proposals.push({
        status,
        order_id: orderId, order_item_id: it.id,
        physical_product_id: r.physical_product_id,
        channel: order.channel, external_order_id: order.external_order_id,
        event_type: eventType, movement_type: movementType,
        order_qty: r.order_qty, qty_per_unit: r.qty_per_unit, required_physical_qty: r.required_physical_qty,
        current_on_hand: phyState.on_hand, current_reserved: phyState.reserved, current_available: available,
        quantity_delta: status === 'idempotent_no_op' || status === 'blocked' ? 0 : quantityDelta,
        reservation_delta: status === 'idempotent_no_op' || status === 'blocked' ? 0 : reservationDelta,
        current_ledger_state: currentState,
        idempotency_key: r.idempotency_key,
        source_status_evidence: evidence,
        reason: reasons.length ? reasons : ['ok'],
        decision,
      });
    }
  }

  return { orderId, eventType, order, order_status_evidence: evidence, proposals };
}

// ─────────────────────────────────────────────────────────────
// Apply (write) — gated · idempotent
// ─────────────────────────────────────────────────────────────

/**
 * Apply lifecycle event for one order. Iterates proposals, writes movements
 * only for status='proposed_apply' or 'proposed_recovery'. Skips no_op/blocked/no_movement.
 *
 * @param {Object} args
 * @param {number} args.orderId
 * @param {string} args.eventType
 * @param {number|null} args.actorId
 * @param {boolean} args.confirm
 * @returns {Promise<{status:'applied'|'dry_run'|'invalid', proposals:LifecycleProposal[], writes:Array}>}
 */
async function applyLifecycleForOrder({ orderId, eventType, actorId = null, confirm = false }) {
  const dryRun = confirm !== true;
  const { orderId: oid, eventType: et, order, order_status_evidence, proposals } = await proposeLifecycleForOrder({ orderId, eventType });

  if (dryRun) {
    return { status: 'dry_run', orderId: oid, eventType: et, order_status_evidence, proposals, writes: [] };
  }

  const writes = [];
  const db = getClient();
  for (const p of proposals) {
    if (p.status !== 'proposed_apply' && p.status !== 'proposed_recovery') continue;

    const row = {
      physical_product_id: p.physical_product_id,
      movement_type: p.movement_type,
      quantity_delta: p.quantity_delta,
      reservation_delta: p.reservation_delta,
      idempotency_key: p.idempotency_key,
      reason_code: p.event_type,
      actor_id: actorId,
      related_order_id: p.order_id,
      related_order_item_id: p.order_item_id,
      metadata: {
        event_type: p.event_type,
        channel: p.channel,
        external_order_id: p.external_order_id,
        order_qty: p.order_qty,
        qty_per_unit: p.qty_per_unit,
        recovery: p.status === 'proposed_recovery',
        source_status_evidence: p.source_status_evidence,
        decision: p.decision,
        applied_at: new Date().toISOString(),
      },
      occurred_at: new Date().toISOString(),
    };

    const { data: inserted, error } = await db.from('inventory_movements').insert(row).select('id').single();
    if (error) {
      if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
        writes.push({ order_item_id: p.order_item_id, physical: p.physical_product_id, status: 'idempotent', idempotency_key: p.idempotency_key });
        continue;
      }
      writes.push({ order_item_id: p.order_item_id, physical: p.physical_product_id, status: 'error', error: error.message });
      continue;
    }
    writes.push({ order_item_id: p.order_item_id, physical: p.physical_product_id, status: 'applied', movement_id: inserted.id, idempotency_key: p.idempotency_key });

    try {
      await logActivity({
        action: p.event_type,
        entityType: 'inventory_movement',
        entityId: inserted.id,
        actorId, actorType: actorId ? 'user' : 'system',
        metadata: {
          order_id: p.order_id, order_item_id: p.order_item_id,
          physical_product_id: p.physical_product_id,
          quantity_delta: p.quantity_delta, reservation_delta: p.reservation_delta,
          idempotency_key: p.idempotency_key, recovery: p.status === 'proposed_recovery',
        },
      });
    } catch { /* never break write */ }
  }

  return { status: 'applied', orderId, eventType, order_status_evidence, proposals, writes };
}

module.exports = {
  EVENT_TO_MOVEMENT_TYPE,
  getItemPhysicalLedger,
  deriveState,
  getOrderStatusEvidence,
  orderStatusSupportsEvent,
  proposeLifecycleForOrder,
  applyLifecycleForOrder,
};
