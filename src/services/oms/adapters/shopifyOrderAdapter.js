/**
 * src/services/oms/adapters/shopifyOrderAdapter.js — Shopify raw → CanonicalOrder.
 *
 * Owner directive §17: mock/raw fixture 로 adapter → Canonical 검증만.
 * Owner directive §20 성공 기준 (Shopify):
 *   실제 line_item 3개 있는 주문 → CanonicalOrder 1 · CanonicalOrderItem 3.
 *
 * Shopify Admin API Order shape (2024-01+):
 *   { id, order_number, name, financial_status, fulfillment_status, cancelled_at,
 *     currency, subtotal_price, total_price, total_shipping_price_set, total_tax,
 *     total_discounts, created_at, processed_at, updated_at, closed_at,
 *     customer: { email, first_name, last_name, phone, ... },
 *     shipping_address: { name, address1, address2, city, province, zip, country, country_code, phone, ... },
 *     line_items: [ { id, sku, variant_id, product_id, title, quantity, price, total_discount, ... } ]
 *   }
 */
'use strict';

const { emptyCanonicalOrder, emptyBuyer, emptyAddress } = require('../canonicalOrder');
const { resolveExternalLineId } = require('../lineId');
const { mapShopifyStatus } = require('../statusMapper');

function nz(v) { return v == null || v === '' ? null : v; }
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {Object} raw    Shopify order JSON (as returned by REST /orders/{id}.json)
 * @returns {import('../canonicalOrder').CanonicalOrder}
 */
function toCanonicalOrder(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('shopifyOrderAdapter.toCanonicalOrder: raw object required');
  }

  const externalOrderId = String(raw.id ?? '').trim();
  if (!externalOrderId) {
    throw new Error('shopifyOrderAdapter: order id required');
  }

  const status = mapShopifyStatus({
    financialStatus: raw.financial_status ?? null,
    fulfillmentStatus: raw.fulfillment_status ?? null,
    cancelledAt: raw.cancelled_at ?? null,
    status: raw.cancelled_at ? 'cancelled' : (raw.closed_at ? 'closed' : 'open'),
  });

  // Buyer
  const cust = raw.customer || {};
  const buyerName = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() || null;
  const buyer = {
    ...emptyBuyer(),
    name: buyerName,
    email: nz(cust.email ?? raw.email),
    phone: nz(cust.phone ?? raw.phone),
    country: nz(raw.shipping_address?.country),
    countryCode: nz(raw.shipping_address?.country_code),
  };

  // Shipping address
  const shipObj = raw.shipping_address || {};
  const shippingAddress = {
    ...emptyAddress(),
    recipientName: nz(shipObj.name || [shipObj.first_name, shipObj.last_name].filter(Boolean).join(' ') || null),
    street1: nz(shipObj.address1),
    street2: nz(shipObj.address2),
    city: nz(shipObj.city),
    state: nz(shipObj.province),
    postalCode: nz(shipObj.zip),
    country: nz(shipObj.country),
    countryCode: nz(shipObj.country_code),
    phone: nz(shipObj.phone),
  };

  // Line items — CRITICAL §20 grain: N line_items → N items
  const rawLines = Array.isArray(raw.line_items) ? raw.line_items : [];
  const currency = nz(raw.currency ?? 'USD');

  const items = rawLines.map((li, idx) => {
    const marketplaceSku = nz(li.sku);
    const variantId = li.variant_id != null ? String(li.variant_id) : null;
    const listingId = li.product_id != null ? String(li.product_id) : null;
    const quantity = Math.max(1, parseInt(li.quantity ?? 1, 10) || 1);
    const unitPrice = num(li.price);
    const discount = num(li.total_discount);

    const externalLineId = resolveExternalLineId(
      li.id != null ? String(li.id) : null,
      { externalOrderId, marketplaceSku, variantId, quantity, unitPrice, rowIndex: idx },
    );

    return {
      externalLineId,
      marketplaceSku,
      listingId,
      variantId,
      title: nz(li.title),
      quantity,
      unitPrice,
      discount,
      currency,
      productId: null,
      skuMasterId: null,
      unitCostSnapshot: null,
      landedCostSnapshot: null,
      costCurrency: null,
      costSource: null,
      matchStatus: 'pending',
      matchReason: null,
      matchConfidence: null,
      rawPayload: li,
    };
  });

  return emptyCanonicalOrder({
    channel: 'shopify',
    externalOrderId,
    externalOrderNumber: nz(raw.name ?? (raw.order_number != null ? `#${raw.order_number}` : null)),
    orderType: 'b2c',
    importSource: 'api:shopify',
    orderStatus: status.orderStatus,
    paymentStatus: status.paymentStatus,
    fulfillmentStatus: status.fulfillmentStatus,
    rawOrderStatus: raw.cancelled_at ? 'cancelled' : (raw.closed_at ? 'closed' : 'open'),
    rawPaymentStatus: nz(raw.financial_status),
    rawFulfillmentStatus: nz(raw.fulfillment_status),
    buyer,
    shippingAddress,
    currency,
    subtotal: num(raw.subtotal_price),
    shippingCharged: num(raw.total_shipping_price_set?.shop_money?.amount ?? raw.total_shipping_price),
    discount: num(raw.total_discounts),
    tax: num(raw.total_tax),
    total: num(raw.total_price),
    orderedAt: iso(raw.processed_at ?? raw.created_at),
    paidAt: raw.financial_status === 'paid' ? iso(raw.processed_at ?? raw.created_at) : null,
    shippedAt: raw.fulfillment_status === 'fulfilled' ? iso(raw.updated_at) : null,
    cancelledAt: iso(raw.cancelled_at),
    items,
    rawPayload: raw,
  });
}

module.exports = { toCanonicalOrder };
