/**
 * src/services/oms/statusMapper.js — Platform raw status → Canonical 3-axis status.
 *
 * Owner directive §10:
 *   Adapter 또는 별도 mapper 에서 명시적으로 관리한다.
 *   generic string guessing 하지 않는다.
 *   raw status 는 반드시 그대로 보존한다.
 *
 * 이 파일은 순수 함수. DB 접근 X.
 */
'use strict';

/**
 * @typedef {import('./canonicalOrder').OrderStatus} OrderStatus
 * @typedef {import('./canonicalOrder').PaymentStatus} PaymentStatus
 * @typedef {import('./canonicalOrder').FulfillmentStatus} FulfillmentStatus
 */

/**
 * @typedef {Object} CanonicalStatusTriple
 * @property {OrderStatus} orderStatus
 * @property {PaymentStatus} paymentStatus
 * @property {FulfillmentStatus} fulfillmentStatus
 */

// ─────────────────────────────────────────────────────────────
// eBay Trading API OrderStatus + shipped/paid flags
// Ref: OrderStatus values from ebayAPI.getAwaitingShipmentOrders
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object} rawEbayOrder
 * @param {string|null} rawEbayOrder.orderStatus     'Active' | 'Completed' | 'Cancelled' | 'InProcess'
 * @param {string|null} [rawEbayOrder.checkoutStatus] 'Complete' | 'Incomplete'
 * @param {string|null} [rawEbayOrder.paidTime]      ISO
 * @param {string|null} [rawEbayOrder.shippedTime]   ISO
 * @param {string|null} [rawEbayOrder.cancelStatus]  'CancelClosedForCommitment' 등
 * @returns {CanonicalStatusTriple}
 */
function mapEbayStatus(rawEbayOrder) {
  const os = String(rawEbayOrder?.orderStatus ?? '').toLowerCase();
  const paid = !!rawEbayOrder?.paidTime;
  const shipped = !!rawEbayOrder?.shippedTime;
  const cancelStatus = String(rawEbayOrder?.cancelStatus ?? '').toLowerCase();

  // Cancelled first
  if (os === 'cancelled' || cancelStatus.includes('cancel')) {
    return { orderStatus: 'cancelled', paymentStatus: paid ? 'refunded' : 'failed', fulfillmentStatus: 'unfulfilled' };
  }

  // Completed = shipped + paid + delivered on eBay's side
  if (os === 'completed' && shipped) {
    return { orderStatus: 'completed', paymentStatus: 'paid', fulfillmentStatus: 'fulfilled' };
  }
  if (shipped) {
    return { orderStatus: 'shipped', paymentStatus: paid ? 'paid' : 'pending', fulfillmentStatus: 'fulfilled' };
  }

  // AwaitingShipment / Active + paid = ready to ship
  if (paid) {
    return { orderStatus: 'ready_to_ship', paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled' };
  }

  // InProcess / Active but not paid
  if (os === 'inprocess' || os === 'active') {
    return { orderStatus: 'processing', paymentStatus: 'pending', fulfillmentStatus: 'unfulfilled' };
  }

  return { orderStatus: 'new', paymentStatus: 'pending', fulfillmentStatus: 'unfulfilled' };
}

// ─────────────────────────────────────────────────────────────
// Shopify Order — financial_status × fulfillment_status × cancelled_at
// ─────────────────────────────────────────────────────────────
/**
 * @param {Object} rawShopifyOrder
 * @param {string|null} rawShopifyOrder.financialStatus    'paid'|'pending'|'partially_paid'|'refunded'|'partially_refunded'|'voided'
 * @param {string|null} rawShopifyOrder.fulfillmentStatus  'fulfilled'|'partial'|null
 * @param {string|null} rawShopifyOrder.cancelledAt        ISO or null
 * @param {string|null} [rawShopifyOrder.status]           'open'|'closed'|'cancelled'
 * @returns {CanonicalStatusTriple}
 */
function mapShopifyStatus(rawShopifyOrder) {
  const fin = String(rawShopifyOrder?.financialStatus ?? '').toLowerCase();
  const ful = String(rawShopifyOrder?.fulfillmentStatus ?? '').toLowerCase();
  const cancelled = !!rawShopifyOrder?.cancelledAt;
  const status = String(rawShopifyOrder?.status ?? '').toLowerCase();

  // Payment status mapping
  let paymentStatus = 'pending';
  if (fin === 'paid') paymentStatus = 'paid';
  else if (fin === 'partially_paid') paymentStatus = 'partially_paid';
  else if (fin === 'refunded') paymentStatus = 'refunded';
  else if (fin === 'partially_refunded') paymentStatus = 'partially_refunded';
  else if (fin === 'voided') paymentStatus = 'failed';

  // Fulfillment status mapping
  let fulfillmentStatus = 'unfulfilled';
  if (ful === 'fulfilled') fulfillmentStatus = 'fulfilled';
  else if (ful === 'partial' || ful === 'partially_fulfilled') fulfillmentStatus = 'partially_fulfilled';

  // Order status
  if (cancelled || status === 'cancelled') {
    return { orderStatus: 'cancelled', paymentStatus, fulfillmentStatus };
  }
  if (fulfillmentStatus === 'fulfilled') {
    return { orderStatus: paymentStatus === 'paid' ? 'completed' : 'shipped', paymentStatus, fulfillmentStatus };
  }
  if (fulfillmentStatus === 'partially_fulfilled') {
    return { orderStatus: 'processing', paymentStatus, fulfillmentStatus };
  }
  if (paymentStatus === 'paid') {
    return { orderStatus: 'ready_to_ship', paymentStatus, fulfillmentStatus };
  }
  if (status === 'open') {
    return { orderStatus: 'new', paymentStatus, fulfillmentStatus };
  }
  return { orderStatus: 'new', paymentStatus, fulfillmentStatus };
}

module.exports = {
  mapEbayStatus,
  mapShopifyStatus,
};
