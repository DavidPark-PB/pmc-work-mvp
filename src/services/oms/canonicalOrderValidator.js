/**
 * src/services/oms/canonicalOrderValidator.js — CanonicalOrder runtime validation.
 *
 * Owner directive §2: 외부 API 데이터는 신뢰하지 않는다.
 *                     Canonical DTO persistence 전에 validation layer 를 통과시킨다.
 *                     invalid order 는 canonical table 에 억지로 넣지 않는다.
 *                     raw event 에는 보존하고 processing_status 를 failed 로 남긴다.
 *
 * 이 파일은 순수 함수. throw 하지 않고 { ok, errors } 반환.
 */
'use strict';

const { CANONICAL_ENUMS } = require('./canonicalOrder');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNumberOrNull(v) {
  return v == null || (typeof v === 'number' && Number.isFinite(v));
}

function isPositiveInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isIsoDateOrNull(v) {
  if (v == null) return true;
  if (typeof v !== 'string') return false;
  if (!ISO_DATE_RE.test(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

function isInEnumOrNull(v, list) {
  return v == null || list.includes(v);
}

/**
 * @param {import('./canonicalOrder').CanonicalOrderItem} item
 * @param {number} idx
 * @returns {string[]}
 */
function validateItem(item, idx) {
  const errs = [];
  const prefix = `items[${idx}]`;
  if (!item || typeof item !== 'object') {
    errs.push(`${prefix}: not an object`);
    return errs;
  }
  if (!isNonEmptyString(item.externalLineId)) {
    errs.push(`${prefix}.externalLineId: required non-empty string (use lineId.resolveExternalLineId)`);
  }
  if (!isPositiveInteger(item.quantity)) {
    errs.push(`${prefix}.quantity: must be positive integer, got ${item.quantity}`);
  }
  if (!isFiniteNumberOrNull(item.unitPrice)) {
    errs.push(`${prefix}.unitPrice: must be finite number or null`);
  }
  if (!isFiniteNumberOrNull(item.discount)) {
    errs.push(`${prefix}.discount: must be finite number or null`);
  }
  if (item.currency != null && !isNonEmptyString(item.currency)) {
    errs.push(`${prefix}.currency: must be non-empty string or null`);
  }
  if (!isInEnumOrNull(item.matchStatus, CANONICAL_ENUMS.matchStatus)) {
    errs.push(`${prefix}.matchStatus: invalid`);
  }
  if (!isInEnumOrNull(item.matchConfidence, CANONICAL_ENUMS.matchConfidence)) {
    errs.push(`${prefix}.matchConfidence: invalid`);
  }
  if (item.productId != null && !isPositiveInteger(item.productId)) {
    errs.push(`${prefix}.productId: must be positive integer or null`);
  }
  if (item.skuMasterId != null && !isPositiveInteger(item.skuMasterId)) {
    errs.push(`${prefix}.skuMasterId: must be positive integer or null`);
  }
  if (!isFiniteNumberOrNull(item.unitCostSnapshot)) {
    errs.push(`${prefix}.unitCostSnapshot: must be finite number or null`);
  }
  if (!isFiniteNumberOrNull(item.landedCostSnapshot)) {
    errs.push(`${prefix}.landedCostSnapshot: must be finite number or null`);
  }
  return errs;
}

/**
 * Validate a CanonicalOrder.
 * @param {import('./canonicalOrder').CanonicalOrder} order
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateCanonicalOrder(order) {
  const errors = [];
  if (!order || typeof order !== 'object') {
    return { ok: false, errors: ['order: not an object'] };
  }

  // Identity
  if (!CANONICAL_ENUMS.channel.includes(order.channel)) {
    errors.push(`channel: must be one of ${CANONICAL_ENUMS.channel.join('|')}, got ${order.channel}`);
  }
  if (!isNonEmptyString(order.externalOrderId)) {
    errors.push('externalOrderId: required non-empty string');
  }
  if (!CANONICAL_ENUMS.orderType.includes(order.orderType)) {
    errors.push(`orderType: must be one of ${CANONICAL_ENUMS.orderType.join('|')}`);
  }
  if (!isNonEmptyString(order.importSource)) {
    errors.push('importSource: required non-empty string');
  }

  // Statuses
  if (!CANONICAL_ENUMS.orderStatus.includes(order.orderStatus)) {
    errors.push(`orderStatus: invalid (${order.orderStatus})`);
  }
  if (!CANONICAL_ENUMS.paymentStatus.includes(order.paymentStatus)) {
    errors.push(`paymentStatus: invalid (${order.paymentStatus})`);
  }
  if (!CANONICAL_ENUMS.fulfillmentStatus.includes(order.fulfillmentStatus)) {
    errors.push(`fulfillmentStatus: invalid (${order.fulfillmentStatus})`);
  }
  if (!isInEnumOrNull(order.holdReason, CANONICAL_ENUMS.holdReason)) {
    errors.push(`holdReason: invalid (${order.holdReason})`);
  }
  if (!isInEnumOrNull(order.cancellationReason, CANONICAL_ENUMS.cancellationReason)) {
    errors.push(`cancellationReason: invalid (${order.cancellationReason})`);
  }

  // Financial
  for (const f of ['subtotal','shippingCharged','discount','tax','total']) {
    if (!isFiniteNumberOrNull(order[f])) errors.push(`${f}: must be finite number or null`);
  }
  if (order.currency != null && !isNonEmptyString(order.currency)) {
    errors.push('currency: must be non-empty string or null');
  }

  // Timestamps
  for (const f of ['orderedAt','paidAt','confirmedAt','readyToShipAt','shippedAt','completedAt','cancelledAt','returnedAt']) {
    if (!isIsoDateOrNull(order[f])) errors.push(`${f}: must be ISO date string or null (got ${order[f]})`);
  }

  // Items
  if (!Array.isArray(order.items)) {
    errors.push('items: must be array');
  } else {
    if (order.items.length === 0) {
      errors.push('items: must have at least one item');
    }
    order.items.forEach((item, i) => {
      errors.push(...validateItem(item, i));
    });
    // Deterministic line id uniqueness within order
    const ids = new Set();
    order.items.forEach((item, i) => {
      if (item && item.externalLineId) {
        if (ids.has(item.externalLineId)) {
          errors.push(`items[${i}].externalLineId: duplicate '${item.externalLineId}' within order`);
        }
        ids.add(item.externalLineId);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateCanonicalOrder,
  // exported for tests only
  _internals: { isIsoDateOrNull, isPositiveInteger, ISO_DATE_RE },
};
