/**
 * src/services/oms/skuMappingService.js — Manual Shopify (and other channel)
 * SKU mapping foundation.
 *
 * Owner directive Step 5.3:
 *   Root cause D confirmed for CC3051 — Shopify ↔ sku_master mapping does not
 *   yet exist in `sku_listing_link`. Do NOT auto-match by title / fuzzy / AI.
 *   Instead: staff makes ONE precise mapping · this service persists it into
 *   `sku_listing_link` · same variant on future orders auto-matches via existing
 *   `skuMatcher.matchByLink()` · existing unmatched OMS items for the same
 *   variant are safely backfilled (never overwriting different mappings).
 *
 * SoT: existing `sku_listing_link` table (§1) — no new table created.
 *
 * Backfill rules (§4):
 *   - failed / pending → matched_link OK
 *   - already matched to the SAME sku_master → idempotent (no-op)
 *   - already matched to a DIFFERENT sku_master → conflict · report only ·
 *     never overwrite. Caller decides.
 *
 * Cost snapshot rules (§5):
 *   - Fill on newly matched items only when sku_master.cost_krw is present
 *     AND unit_cost_snapshot is currently NULL.
 *   - Never overwrite an existing snapshot.
 *
 * Activity log (§2):
 *   - Emits business events via oms/activityLogger — sanitizeActivityData
 *     strips PII automatically.
 *
 * NO deletes. NO overwrites of internal-owned fields. NO auto-run background jobs.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { logActivity } = require('./activityLogger');

/**
 * @typedef {Object} LinkResult
 * @property {'linked'|'idempotent'|'conflict'|'invalid'|'error'} status
 * @property {number|null} linkId            sku_listing_link.id (existing or newly created)
 * @property {boolean}     linkCreated       true if a new sku_listing_link row was inserted
 * @property {number}      itemsUpgraded     unmatched items upgraded to matched_link
 * @property {number}      itemsAlreadyOk    items already correctly matched to this sku
 * @property {number}      itemsInConflict   items matched to a different sku (untouched)
 * @property {Array<{ orderItemId:number, existingSkuMasterId:number, existingMatchStatus:string }>} conflicts
 * @property {number}      costSnapshotsWritten
 * @property {string[]}    errors
 */

/**
 * Link one OMS order item to a sku_master, creating (or reusing) the underlying
 * sku_listing_link row and backfilling other unmatched items for the same
 * (channel, listing_id, option_id) mapping.
 *
 * @param {Object} args
 * @param {number} args.orderItemId
 * @param {number} args.skuMasterId
 * @param {number|null} [args.actorId]
 * @returns {Promise<LinkResult>}
 */
async function linkOrderItemToSku({ orderItemId, skuMasterId, actorId = null }) {
  const out = _emptyResult();

  if (!_isPositiveInt(orderItemId)) {
    out.status = 'invalid';
    out.errors.push('orderItemId: required positive integer');
    return out;
  }
  if (!_isPositiveInt(skuMasterId)) {
    out.status = 'invalid';
    out.errors.push('skuMasterId: required positive integer');
    return out;
  }

  const db = getClient();

  // 1) Load target item + its parent order (channel needed)
  const { data: item, error: e1 } = await db.from('oms_order_items')
    .select('id, order_id, external_line_id, marketplace_sku, listing_id, variant_id, product_id, sku_master_id, match_status, unit_cost_snapshot, cost_source')
    .eq('id', orderItemId)
    .maybeSingle();
  if (e1) return _errorResult(out, e1.message);
  if (!item) {
    out.status = 'invalid';
    out.errors.push(`orderItemId ${orderItemId} not found`);
    return out;
  }

  const { data: order, error: e2 } = await db.from('oms_orders')
    .select('id, channel')
    .eq('id', item.order_id)
    .maybeSingle();
  if (e2) return _errorResult(out, e2.message);
  if (!order) {
    out.status = 'invalid';
    out.errors.push(`parent oms_orders row ${item.order_id} not found`);
    return out;
  }

  const channel = String(order.channel || '').trim();
  if (!channel) {
    out.status = 'invalid';
    out.errors.push('parent order.channel empty');
    return out;
  }

  // 2) Verify sku_master exists · capture cost + internal_sku (for product_id fallback)
  const { data: master, error: e3 } = await db.from('sku_master')
    .select('id, internal_sku, cost_krw')
    .eq('id', skuMasterId)
    .maybeSingle();
  if (e3) return _errorResult(out, e3.message);
  if (!master) {
    out.status = 'invalid';
    out.errors.push(`sku_master ${skuMasterId} not found`);
    return out;
  }

  // 3) Resolve the mapping key. Requires listing_id at minimum.
  const listingId = item.listing_id != null ? String(item.listing_id) : null;
  const optionId = item.variant_id != null ? String(item.variant_id) : null;
  const marketplaceSku = item.marketplace_sku != null ? String(item.marketplace_sku) : null;

  if (!listingId && !marketplaceSku) {
    out.status = 'invalid';
    out.errors.push(`item ${orderItemId} has neither listing_id nor marketplace_sku — cannot create sku_listing_link`);
    return out;
  }

  // 4) Check existing sku_listing_link · idempotent path
  //    UNIQUE is (marketplace, listing_id, option_id) per 038 migration.
  let existingLink = null;
  if (listingId) {
    let q = db.from('sku_listing_link')
      .select('id, sku_id, marketplace, listing_id, option_id, marketplace_sku')
      .eq('marketplace', channel)
      .eq('listing_id', listingId);
    q = (optionId == null) ? q.is('option_id', null) : q.eq('option_id', optionId);
    const { data: linkRows, error: e4 } = await q.limit(2);
    if (e4) return _errorResult(out, e4.message);
    if (linkRows && linkRows.length > 1) {
      out.status = 'error';
      out.errors.push(`sku_listing_link UNIQUE violated for (${channel}, ${listingId}, ${optionId}) — data corruption suspected`);
      return out;
    }
    existingLink = linkRows && linkRows[0] ? linkRows[0] : null;
  }

  if (existingLink && existingLink.sku_id !== skuMasterId) {
    // §4 conflict — do not overwrite. Caller decides (perhaps delete link manually).
    out.status = 'conflict';
    out.linkId = existingLink.id;
    out.errors.push(`sku_listing_link already maps (${channel}, ${listingId}, ${optionId}) → sku_master ${existingLink.sku_id}, refusing to overwrite with ${skuMasterId}`);
    return out;
  }

  // 5) Create link if missing
  let linkId;
  let linkCreated = false;
  if (existingLink) {
    linkId = existingLink.id;
  } else {
    const insertRow = {
      sku_id: skuMasterId,
      marketplace: channel,
      listing_id: listingId,
      option_id: optionId,
      marketplace_sku: marketplaceSku,
      is_primary: false,
    };
    const { data: inserted, error: e5 } = await db.from('sku_listing_link')
      .insert(insertRow)
      .select('id')
      .single();
    if (e5) {
      // Race: another concurrent link insert. Re-read.
      if (e5.code === '23505' || /duplicate|unique/i.test(e5.message || '')) {
        let q2 = db.from('sku_listing_link')
          .select('id, sku_id')
          .eq('marketplace', channel)
          .eq('listing_id', listingId);
        q2 = (optionId == null) ? q2.is('option_id', null) : q2.eq('option_id', optionId);
        const { data: r2 } = await q2.maybeSingle();
        if (!r2) return _errorResult(out, e5.message);
        if (r2.sku_id !== skuMasterId) {
          out.status = 'conflict';
          out.linkId = r2.id;
          out.errors.push(`race: link now maps to sku_master ${r2.sku_id}, refusing to overwrite with ${skuMasterId}`);
          return out;
        }
        linkId = r2.id;
      } else {
        return _errorResult(out, e5.message);
      }
    } else {
      linkId = inserted.id;
      linkCreated = true;
    }
  }

  // 6) Backfill: find all unmatched OMS items sharing (channel, listing_id, option_id)
  //    · fetch channel-scoped candidates first (join via oms_orders.channel)
  const backfill = await _backfillItems({
    db, channel, listingId, optionId,
    targetSkuMasterId: skuMasterId,
    masterInternalSku: master.internal_sku,
    masterCostKrw: master.cost_krw,
  });
  out.itemsUpgraded = backfill.upgraded;
  out.itemsAlreadyOk = backfill.alreadyOk;
  out.itemsInConflict = backfill.conflicts.length;
  out.conflicts = backfill.conflicts;
  out.costSnapshotsWritten = backfill.costSnapshotsWritten;

  out.status = linkCreated ? 'linked' : (out.itemsUpgraded === 0 && out.itemsAlreadyOk > 0 ? 'idempotent' : 'linked');
  out.linkId = linkId;
  out.linkCreated = linkCreated;

  // 7) Activity log (PII-free — the requested item id + counts only)
  await _safeLog({
    action: 'manual_sku_link',
    entityType: 'order_item',
    entityId: orderItemId,
    actorId,
    actorType: actorId ? 'user' : 'system',
    metadata: {
      channel,
      listing_id: listingId,
      option_id: optionId,
      target_sku_master_id: skuMasterId,
      link_id: linkId,
      link_created: linkCreated,
      items_upgraded: out.itemsUpgraded,
      items_already_ok: out.itemsAlreadyOk,
      items_in_conflict: out.itemsInConflict,
      cost_snapshots_written: out.costSnapshotsWritten,
    },
  });

  return out;
}

// ─────────────────────────────────────────────────────────────
// Backfill helper
// ─────────────────────────────────────────────────────────────
async function _backfillItems({ db, channel, listingId, optionId, targetSkuMasterId, masterInternalSku, masterCostKrw }) {
  const summary = { upgraded: 0, alreadyOk: 0, conflicts: [], costSnapshotsWritten: 0 };
  if (!listingId) return summary;

  // 1) Find channel orders (so we can scope items to this marketplace)
  const { data: orderRows, error: eo } = await db.from('oms_orders')
    .select('id')
    .eq('channel', channel);
  if (eo) throw eo;
  const orderIds = (orderRows || []).map(r => r.id);
  if (orderIds.length === 0) return summary;

  // 2) Find items matching (listing_id, option_id)
  let itemQ = db.from('oms_order_items')
    .select('id, order_id, sku_master_id, product_id, match_status, unit_cost_snapshot')
    .eq('listing_id', listingId)
    .in('order_id', orderIds);
  itemQ = (optionId == null)
    ? itemQ.is('variant_id', null)
    : itemQ.eq('variant_id', optionId);
  const { data: items, error: ei } = await itemQ;
  if (ei) throw ei;

  // 3) Resolve products.id (best-effort) once for reuse
  let resolvedProductId = null;
  if (masterInternalSku) {
    try {
      const { data: p } = await db.from('products').select('id').eq('sku', masterInternalSku).maybeSingle();
      if (p) resolvedProductId = p.id;
    } catch { /* leave null */ }
  }

  for (const it of (items || [])) {
    if (it.sku_master_id != null && it.sku_master_id === targetSkuMasterId) {
      summary.alreadyOk += 1;
      // still fill product_id if empty AND we resolved one
      if (resolvedProductId && it.product_id == null) {
        await db.from('oms_order_items')
          .update({ product_id: resolvedProductId, updated_at: new Date().toISOString() })
          .eq('id', it.id);
      }
      // fill cost snapshot if missing and master cost exists
      if (masterCostKrw != null && it.unit_cost_snapshot == null) {
        const patched = await _writeCostSnapshot(db, it.id, masterCostKrw);
        if (patched) summary.costSnapshotsWritten += 1;
      }
      continue;
    }
    if (it.sku_master_id != null && it.sku_master_id !== targetSkuMasterId) {
      // §4 conflict — never overwrite
      summary.conflicts.push({
        orderItemId: it.id,
        existingSkuMasterId: it.sku_master_id,
        existingMatchStatus: it.match_status || null,
      });
      continue;
    }

    // Upgrade path: failed / pending → matched_link
    const patch = {
      sku_master_id: targetSkuMasterId,
      match_status: 'matched_link',
      match_confidence: 'high',
      match_reason: 'manual_mapping',
      updated_at: new Date().toISOString(),
    };
    if (resolvedProductId && it.product_id == null) patch.product_id = resolvedProductId;
    if (masterCostKrw != null && it.unit_cost_snapshot == null) {
      patch.unit_cost_snapshot = masterCostKrw;
      patch.cost_currency = 'KRW';
      patch.cost_source = 'sku_master';
    }

    const { error: eu } = await db.from('oms_order_items').update(patch).eq('id', it.id);
    if (eu) {
      // isolate: skip this item · surface as conflict-ish · but do not abort
      summary.conflicts.push({
        orderItemId: it.id,
        existingSkuMasterId: null,
        existingMatchStatus: `update_failed:${(eu.message || '').slice(0, 80)}`,
      });
      continue;
    }
    summary.upgraded += 1;
    if (patch.unit_cost_snapshot != null) summary.costSnapshotsWritten += 1;
  }
  return summary;
}

async function _writeCostSnapshot(db, itemId, costKrw) {
  const { error } = await db.from('oms_order_items').update({
    unit_cost_snapshot: costKrw,
    cost_currency: 'KRW',
    cost_source: 'sku_master',
    updated_at: new Date().toISOString(),
  }).eq('id', itemId);
  return !error;
}

// ─────────────────────────────────────────────────────────────
// Read: unmatched items list (for the API)
// ─────────────────────────────────────────────────────────────
/**
 * List OMS order items with no sku_master + no product mapping.
 * PII-free (no buyer / shipping fields).
 *
 * @param {Object} [opts]
 * @param {string} [opts.channel]      filter by channel
 * @param {number} [opts.limit=100]
 * @param {number} [opts.offset=0]
 */
async function listUnmatchedItems({ channel = null, limit = 100, offset = 0 } = {}) {
  const db = getClient();
  const safeLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

  // fetch channel-scoped order ids (if channel filter given) first for efficiency
  let orderIdSet = null;
  if (channel) {
    const { data: orderRows, error: e0 } = await db.from('oms_orders')
      .select('id, external_order_number, external_order_id')
      .eq('channel', channel);
    if (e0) throw e0;
    orderIdSet = new Map((orderRows || []).map(r => [r.id, r]));
  }

  let itemQ = db.from('oms_order_items')
    .select('id, order_id, external_line_id, marketplace_sku, listing_id, variant_id, title, quantity, match_status, match_reason')
    .is('sku_master_id', null)
    .is('product_id', null)
    .order('id', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);
  if (orderIdSet) itemQ = itemQ.in('order_id', [...orderIdSet.keys()]);

  const { data: items, error } = await itemQ;
  if (error) throw error;

  // enrich with external_order_number / channel if not already loaded
  let orderMap = orderIdSet;
  if (!orderMap && items && items.length) {
    const ids = [...new Set(items.map(i => i.order_id))];
    const { data: orderRows } = await db.from('oms_orders')
      .select('id, channel, external_order_number, external_order_id')
      .in('id', ids);
    orderMap = new Map((orderRows || []).map(r => [r.id, r]));
  }

  return (items || []).map(i => ({
    orderItemId: i.id,
    channel: channel || (orderMap?.get(i.order_id)?.channel ?? null),
    externalOrderNumber: orderMap?.get(i.order_id)?.external_order_number ?? null,
    externalOrderId: orderMap?.get(i.order_id)?.external_order_id ?? null,
    externalLineId: i.external_line_id,
    marketplaceSku: i.marketplace_sku,
    listingId: i.listing_id,
    variantId: i.variant_id,
    title: i.title,
    quantity: i.quantity,
    matchStatus: i.match_status,
    matchReason: i.match_reason,
  }));
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────
function _isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function _emptyResult() {
  return {
    status: 'linked',
    linkId: null,
    linkCreated: false,
    itemsUpgraded: 0,
    itemsAlreadyOk: 0,
    itemsInConflict: 0,
    conflicts: [],
    costSnapshotsWritten: 0,
    errors: [],
  };
}
function _errorResult(out, msg) {
  out.status = 'error';
  out.errors.push(String(msg || 'unknown').slice(0, 200));
  return out;
}
async function _safeLog(args) {
  try { await logActivity(args); } catch { /* never break mapping */ }
}

module.exports = {
  linkOrderItemToSku,
  listUnmatchedItems,
};
