/**
 * src/services/oms/omsOrderService.js — Single OMS persistence entrypoint.
 *
 * Owner directives implemented here:
 *   §4  모든 channel 은 upsertCanonicalOrder(canonicalOrder) 를 통과한다.
 *   §5  Idempotency: (channel, external_order_id) 로 찾아 update. 새 row 반복 생성 X.
 *   §6  Field ownership: external re-sync 가 internal-owned field 를 overwrite 하지 않는다.
 *   §8  Item 매칭 실패해도 주문 자체 ingestion 은 성공.
 *   §9  Cost snapshot: 기존 값 있으면 overwrite 하지 않는다.
 *  §13  Error isolation: 한 item 실패로 전체 batch 중단 X.
 *  §14  부분 실패가 조용히 성공으로 처리되면 안 된다. → 결과 객체 명시적.
 *  §16  Activity log: raw_event_received / order_created / order_updated /
 *       order_item_matched / order_item_unmatched / normalization_failed
 */
'use strict';

const validator = require('./canonicalOrderValidator');
const repo = require('./omsOrderRepository');
const matcher = require('./omsSkuMatcher');
const { logActivity, diffFields } = require('./activityLogger');
const { shouldWriteCostSnapshot } = require('./costResolver');

// ─────────────────────────────────────────────────────────────
// Field ownership rules (§6)
// ─────────────────────────────────────────────────────────────
// external-owned (re-sync 시 덮어써도 됨)
const EXTERNAL_OWNED_FIELDS = [
  'raw_order_status', 'raw_payment_status', 'raw_fulfillment_status',
  'order_status', 'payment_status', 'fulfillment_status',
  'ship_recipient_name', 'ship_street1', 'ship_street2', 'ship_city',
  'ship_state', 'ship_postal_code', 'ship_country', 'ship_country_code', 'ship_phone',
  'currency', 'subtotal', 'shipping_charged', 'discount', 'tax', 'total',
  'ordered_at', 'paid_at', 'shipped_at', 'cancelled_at', 'completed_at', 'returned_at',
  'external_order_number', 'raw_payload',
];

// buyer contact: external-owned but only fill if empty (지속 sync 시 사람이 CS 로 수정할 수 있음)
const BUYER_FIELDS_FILL_IF_EMPTY = [
  'buyer_name', 'buyer_email', 'buyer_phone', 'buyer_country', 'buyer_country_code',
];

// internal-owned (사람이 입력) → 절대 external sync 로 덮어쓰지 않는다
const INTERNAL_OWNED_FIELDS = [
  'assigned_to', 'hold_reason', 'hold_note', 'cancellation_note', 'notes',
];

/**
 * Build the update patch by respecting field ownership.
 *
 * @param {Object} existingRow    existing oms_orders row
 * @param {Object} freshRow       row derived from a fresh canonical order (orderToRow)
 * @returns {Object}              partial patch (may be empty {})
 */
function buildOwnershipRespectingPatch(existingRow, freshRow) {
  const patch = {};

  // External-owned fields → always adopt fresh
  for (const f of EXTERNAL_OWNED_FIELDS) {
    if (freshRow[f] !== undefined && freshRow[f] !== existingRow[f]) {
      patch[f] = freshRow[f];
    }
  }

  // Buyer fields → only fill if currently empty
  for (const f of BUYER_FIELDS_FILL_IF_EMPTY) {
    if ((existingRow[f] == null || existingRow[f] === '') && freshRow[f] != null && freshRow[f] !== '') {
      patch[f] = freshRow[f];
    }
  }

  // cancellation_reason: fill only if empty (staff may have set it manually)
  if (freshRow.cancellation_reason != null && existingRow.cancellation_reason == null) {
    patch.cancellation_reason = freshRow.cancellation_reason;
  }

  // Internal-owned → never overwrite from external sync
  for (const f of INTERNAL_OWNED_FIELDS) {
    // do NOT copy freshRow[f] into patch — external sync must not touch these
  }

  return patch;
}

/**
 * Upsert one CanonicalOrder into oms_orders + oms_order_items.
 *
 * Returns a structured outcome so callers can distinguish success/partial/failure.
 * NEVER throws for domain errors (validation / match / duplicate line) —
 * only for infrastructure errors (DB fatal).
 *
 * @param {import('./canonicalOrder').CanonicalOrder} canonicalOrder
 * @param {Object} [opts]
 * @param {number|null} [opts.actorId]         who initiated (user id)
 * @param {'user'|'system'|'automation'|'external'} [opts.actorType='automation']
 * @param {number|null} [opts.channelEventId]  channel_order_events.id · linked_order_id 업데이트용 (호출자 책임)
 * @returns {Promise<{
 *   status: 'created'|'updated'|'skipped'|'invalid'|'error',
 *   orderId: number|null,
 *   validation: { ok:boolean, errors:string[] },
 *   itemsInserted: number,
 *   itemsUpdated: number,
 *   itemsSkipped: number,
 *   itemsMatched: number,
 *   itemsUnmatched: number,
 *   error?: string,
 * }>}
 */
async function upsertCanonicalOrder(canonicalOrder, opts = {}) {
  const actorId = opts.actorId ?? null;
  const actorType = opts.actorType || 'automation';

  // 1) Validate (§2)
  const validation = validator.validateCanonicalOrder(canonicalOrder);
  if (!validation.ok) {
    return {
      status: 'invalid',
      orderId: null,
      validation,
      itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0, itemsMatched: 0, itemsUnmatched: 0,
    };
  }

  // 2) Match items BEFORE persistence (so first insert has correct product/sku ids and cost)
  //    Errors here do NOT abort — item just stays unmatched (§8).
  let matched = [];
  try {
    matched = await matcher.matchCanonicalItems({ channel: canonicalOrder.channel, items: canonicalOrder.items });
  } catch (_err) {
    // matcher module already swallows per-item errors; safety net for module-level failure.
    matched = canonicalOrder.items.map((item) => ({
      item, match: { skuMasterId: null, productId: null, matchStatus: 'pending', matchConfidence: null, matchReason: 'matcher_module_error' },
    }));
  }

  const enrichedItems = matched.map(({ item, match }) => ({
    ...item,
    productId: match.productId,
    skuMasterId: match.skuMasterId,
    matchStatus: match.matchStatus,
    matchConfidence: match.matchConfidence,
    matchReason: match.matchReason,
  }));

  const matchedCount = enrichedItems.filter((i) => i.skuMasterId != null || i.productId != null).length;
  const unmatchedCount = enrichedItems.length - matchedCount;

  // 3) Find existing order
  let existing;
  try {
    existing = await repo.findByChannelExternalId(canonicalOrder.channel, canonicalOrder.externalOrderId);
  } catch (err) {
    return _errorResult(validation, err);
  }

  let orderId = null;
  let created = false;
  let itemsInserted = 0, itemsUpdated = 0, itemsSkipped = 0;

  if (!existing) {
    // 4a) CREATE new
    let inserted;
    try {
      const freshRow = repo.orderToRow({ ...canonicalOrder });
      // Race safety: another request may have just inserted the same key.
      inserted = await repo.insertOrder({ ...canonicalOrder });
    } catch (err) {
      // Duplicate race → retry as update path
      if (err && (err.code === '23505' || /duplicate|unique/i.test(err.message || ''))) {
        try {
          existing = await repo.findByChannelExternalId(canonicalOrder.channel, canonicalOrder.externalOrderId);
        } catch (err2) {
          return _errorResult(validation, err2);
        }
      } else {
        return _errorResult(validation, err);
      }
    }

    if (inserted) {
      orderId = inserted.id;
      created = true;
      try {
        const itemInsertResult = await _insertNewItems(orderId, enrichedItems);
        itemsInserted = itemInsertResult.inserted;
      } catch (err) {
        // Item batch insert failed. Order exists — surface partial state.
        return {
          status: 'error',
          orderId,
          validation,
          itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
          itemsMatched: matchedCount, itemsUnmatched: unmatchedCount,
          error: `item_insert_failed:${err.message || 'unknown'}`,
        };
      }

      await _safeLog({
        action: 'order_created',
        entityType: 'order', entityId: orderId,
        actorId, actorType,
        newData: { channel: canonicalOrder.channel, external_order_id: canonicalOrder.externalOrderId,
                   items_count: enrichedItems.length, items_matched: matchedCount },
      });
      await _logItemMatchOutcomes(orderId, enrichedItems, actorId, actorType);

      return {
        status: 'created',
        orderId, validation,
        itemsInserted, itemsUpdated: 0, itemsSkipped: 0,
        itemsMatched: matchedCount, itemsUnmatched: unmatchedCount,
      };
    }
  }

  // 4b) UPDATE existing (§5 §6)
  orderId = existing.id;
  const freshRow = repo.orderToRow(canonicalOrder);
  const patch = buildOwnershipRespectingPatch(existing, freshRow);

  let orderChanged = false;
  if (Object.keys(patch).length > 0) {
    try {
      const before = existing;
      const updated = await repo.updateOrderPartial(orderId, patch);
      orderChanged = true;
      // Diff for activity log (business fields only — no PII by construction)
      const businessFields = [
        'order_status', 'payment_status', 'fulfillment_status',
        'total', 'shipped_at', 'cancelled_at', 'paid_at',
      ];
      const diff = diffFields(before, updated, businessFields);
      if (diff) {
        await _safeLog({
          action: 'order_updated',
          entityType: 'order', entityId: orderId,
          actorId, actorType,
          previousData: diff.previous, newData: diff.next,
        });
      }
    } catch (err) {
      return _errorResult(validation, err, orderId);
    }
  }

  // Items upsert
  try {
    const itemResult = await _upsertItems(orderId, enrichedItems);
    itemsInserted = itemResult.inserted;
    itemsUpdated = itemResult.updated;
    itemsSkipped = itemResult.skipped;
  } catch (err) {
    return {
      status: 'error',
      orderId, validation,
      itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
      itemsMatched: matchedCount, itemsUnmatched: unmatchedCount,
      error: `item_upsert_failed:${err.message || 'unknown'}`,
    };
  }

  await _logItemMatchOutcomes(orderId, enrichedItems, actorId, actorType, { newlyMatchedOnly: true });

  return {
    status: orderChanged || itemsInserted > 0 || itemsUpdated > 0 ? 'updated' : 'skipped',
    orderId, validation,
    itemsInserted, itemsUpdated, itemsSkipped,
    itemsMatched: matchedCount, itemsUnmatched: unmatchedCount,
  };
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

async function _insertNewItems(orderId, enrichedItems) {
  const rows = await repo.insertItems(orderId, enrichedItems);
  return { inserted: rows.length };
}

async function _upsertItems(orderId, enrichedItems) {
  const existingItems = await repo.listItemsByOrderId(orderId);
  const byLineId = new Map(existingItems.map((r) => [String(r.external_line_id), r]));

  const toInsert = [];
  let updated = 0, skipped = 0;

  for (const item of enrichedItems) {
    const existing = byLineId.get(String(item.externalLineId));
    if (!existing) {
      toInsert.push(item);
      continue;
    }
    // Update path (per-item field ownership)
    const patch = _itemPatch(existing, item);
    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }
    try {
      await repo.updateItemPartial(existing.id, patch);
      updated++;
    } catch (err) {
      // Isolate per-item error (§13)
      skipped++;
    }
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    try {
      const rows = await repo.insertItems(orderId, toInsert);
      inserted = rows.length;
    } catch (err) {
      // Batch item insert failure → try per-row insert to salvage the rest.
      for (const item of toInsert) {
        try {
          const rows = await repo.insertItems(orderId, [item]);
          if (rows.length) inserted++;
        } catch (_e) { /* skip */ }
      }
    }
  }

  return { inserted, updated, skipped };
}

function _itemPatch(existingRow, freshItem) {
  const patch = {};

  // Content — fill if empty, otherwise leave (title may have been manually corrected)
  if ((!existingRow.title || existingRow.title === '') && freshItem.title) patch.title = freshItem.title;

  // Quantity / price / discount / currency — external-owned
  if (freshItem.quantity != null && freshItem.quantity !== existingRow.quantity) patch.quantity = freshItem.quantity;
  if (freshItem.unitPrice != null && Number(freshItem.unitPrice) !== Number(existingRow.unit_price)) patch.unit_price = freshItem.unitPrice;
  if (freshItem.discount != null && Number(freshItem.discount) !== Number(existingRow.discount)) patch.discount = freshItem.discount;
  if (freshItem.currency && freshItem.currency !== existingRow.currency) patch.currency = freshItem.currency;

  // Match result — only tighten (don't downgrade a good match to 'pending')
  if (freshItem.skuMasterId != null && freshItem.skuMasterId !== existingRow.sku_master_id) {
    patch.sku_master_id = freshItem.skuMasterId;
  }
  if (freshItem.productId != null && freshItem.productId !== existingRow.product_id) {
    patch.product_id = freshItem.productId;
  }
  const matchOrder = ['pending','failed','matched_internal_sku','matched_marketplace_sku','matched_link'];
  const freshRank = Math.max(0, matchOrder.indexOf(freshItem.matchStatus || 'pending'));
  const existRank = Math.max(0, matchOrder.indexOf(existingRow.match_status || 'pending'));
  if (freshRank > existRank) {
    patch.match_status = freshItem.matchStatus;
    patch.match_confidence = freshItem.matchConfidence;
    patch.match_reason = freshItem.matchReason;
  }

  // Cost snapshot — write only if not yet set (§9)
  const fresh = {
    unitCostSnapshot: freshItem.unitCostSnapshot,
    landedCostSnapshot: freshItem.landedCostSnapshot,
  };
  if (shouldWriteCostSnapshot(existingRow, fresh)) {
    if (freshItem.unitCostSnapshot != null) patch.unit_cost_snapshot = freshItem.unitCostSnapshot;
    if (freshItem.landedCostSnapshot != null) patch.landed_cost_snapshot = freshItem.landedCostSnapshot;
    if (freshItem.costCurrency) patch.cost_currency = freshItem.costCurrency;
    if (freshItem.costSource) patch.cost_source = freshItem.costSource;
  }

  return patch;
}

async function _logItemMatchOutcomes(orderId, enrichedItems, actorId, actorType, { newlyMatchedOnly = false } = {}) {
  // Note: on update path we don't know per-item "did the match state change vs previous?"
  // without another SELECT. Cheap approach: log every current match state on create;
  // on update, log only unmatched items so we surface staff attention (opportunity).
  for (const item of enrichedItems) {
    if (item.skuMasterId != null || item.productId != null) {
      if (!newlyMatchedOnly) {
        await _safeLog({
          action: 'order_item_matched',
          entityType: 'order', entityId: orderId,
          actorId, actorType,
          metadata: { external_line_id: item.externalLineId, match_status: item.matchStatus },
        });
      }
    } else {
      await _safeLog({
        action: 'order_item_unmatched',
        entityType: 'order', entityId: orderId,
        actorId, actorType,
        metadata: { external_line_id: item.externalLineId, marketplace_sku: item.marketplaceSku,
                    listing_id: item.listingId, match_reason: item.matchReason },
      });
    }
  }
}

async function _safeLog(args) {
  try { await logActivity(args); } catch (_err) { /* logging must never break ingestion */ }
}

function _errorResult(validation, err, orderId = null) {
  return {
    status: 'error',
    orderId,
    validation,
    itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
    itemsMatched: 0, itemsUnmatched: 0,
    error: err && err.message ? err.message : String(err),
  };
}

module.exports = {
  upsertCanonicalOrder,
  // exported for tests
  _internals: { buildOwnershipRespectingPatch, _itemPatch, EXTERNAL_OWNED_FIELDS, INTERNAL_OWNED_FIELDS, BUYER_FIELDS_FILL_IF_EMPTY },
};
