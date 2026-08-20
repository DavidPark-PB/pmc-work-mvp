/**
 * src/services/oms/adapters/ebayOrderAdapter.js — eBay raw payload → CanonicalOrder.
 *
 * Owner directive §17: 이번 phase 는 mock/raw fixture 로 adapter → Canonical 까지만.
 *                       실제 production OrderSync wiring 은 Step 4.
 *
 * Input shape:
 *   raw = { orderStatus, orderId, orderIdRaw, ..., transactions: [...], shippingAddress: {...}, ... }
 *   여러 채널 형태 지원:
 *     A. src/api/ebayAPI.js getAwaitingShipmentOrders() 반환 형태 (normalize 완료).
 *     B. raw XML → JSON 변환 형태.
 *   본 adapter 는 A 형태를 기본으로 하고, 없는 필드는 null 처리.
 */
'use strict';

const { emptyCanonicalOrder, emptyBuyer, emptyAddress } = require('../canonicalOrder');
const { resolveExternalLineId } = require('../lineId');
const { mapEbayStatus } = require('../statusMapper');

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
 * Map an eBay order object → CanonicalOrder.
 *
 * Supports TWO input shapes:
 *   A. Fixture / future shape: { orderId, orderStatus, transactions:[{transactionId,item:{itemId,title},sku,quantity,transactionPrice,...}], shippingAddress:{...}, ... }
 *   B. Legacy sync shape from src/api/ebayAPI.js `getAwaitingShipmentOrders()`:
 *      { ebayOrderId, createdDate, buyerUserId, buyerEmail, price, quantity, title, sku, itemId,
 *        shippingName/Street/City/State/Zip/Country/Phone,
 *        _shippedTime, _cancelStatus, _checkoutStatus, _paidTime, _orderStatus }
 *      Note: legacy shape is 1 order = 1 first-transaction only. Canonical grain becomes
 *      1 order → 1 item. Multi-transaction eBay orders are rare; when they occur the
 *      reconciliation report will surface the missing lines.
 *
 * @param {Object} raw
 * @returns {import('../canonicalOrder').CanonicalOrder}
 */
function toCanonicalOrder(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('ebayOrderAdapter.toCanonicalOrder: raw object required');
  }

  // Detect legacy sync shape by presence of ebayOrderId + no transactions array.
  const isLegacyShape = raw.ebayOrderId != null && !Array.isArray(raw.transactions) && !Array.isArray(raw.Transactions);
  if (isLegacyShape) return _fromLegacySyncShape(raw);

  const externalOrderId = String(raw.orderId ?? raw.OrderID ?? raw.orderIdRaw ?? '').trim();
  if (!externalOrderId) {
    throw new Error('ebayOrderAdapter: cannot resolve external order id (orderId/OrderID)');
  }

  const status = mapEbayStatus({
    orderStatus: raw.orderStatus ?? raw.OrderStatus ?? null,
    checkoutStatus: raw.checkoutStatus ?? null,
    paidTime: raw.paidTime ?? raw.PaidTime ?? null,
    shippedTime: raw.shippedTime ?? raw.ShippedTime ?? null,
    cancelStatus: raw.cancelStatus ?? null,
  });

  // Buyer
  const buyer = {
    ...emptyBuyer(),
    name: nz(raw.buyerName ?? raw.BuyerUserID ?? raw.buyerUserId),
    email: nz(raw.buyerEmail ?? raw.Email),
    phone: nz(raw.buyerPhone),
    country: nz(raw.buyerCountry),
    countryCode: nz(raw.buyerCountryCode ?? raw.CountryCode),
  };

  // Shipping address
  const shipObj = raw.shippingAddress || raw.ShippingAddress || {};
  const shippingAddress = {
    ...emptyAddress(),
    recipientName: nz(shipObj.name ?? shipObj.Name ?? shipObj.recipientName),
    street1: nz(shipObj.street1 ?? shipObj.Street1 ?? shipObj.street),
    street2: nz(shipObj.street2 ?? shipObj.Street2),
    city: nz(shipObj.city ?? shipObj.CityName),
    state: nz(shipObj.state ?? shipObj.StateOrProvince),
    postalCode: nz(shipObj.postalCode ?? shipObj.PostalCode ?? shipObj.zip),
    country: nz(shipObj.country ?? shipObj.Country),
    countryCode: nz(shipObj.countryCode ?? shipObj.CountryCode ?? buyer.countryCode),
    phone: nz(shipObj.phone ?? shipObj.Phone),
  };

  // Items (eBay uses "transactions" array; each transaction = one line)
  const rawItems = Array.isArray(raw.transactions) ? raw.transactions
                  : Array.isArray(raw.items) ? raw.items
                  : Array.isArray(raw.Transactions) ? raw.Transactions
                  : [];

  const items = rawItems.map((tx, idx) => {
    const itemInfo = tx.item || tx.Item || {};
    const marketplaceSku = nz(tx.sku ?? tx.SKU ?? itemInfo.sku ?? itemInfo.SKU);
    const listingId = nz(itemInfo.itemId ?? itemInfo.ItemID ?? tx.itemId);
    const variantId = nz(tx.variationId ?? tx.VariationSpecifics ?? tx.variantId);
    const quantity = Math.max(1, parseInt(tx.quantity ?? tx.QuantityPurchased ?? 1, 10) || 1);
    const unitPrice = num(tx.transactionPrice ?? tx.TransactionPrice ?? tx.unitPrice);

    const externalLineId = resolveExternalLineId(
      nz(tx.transactionId ?? tx.TransactionID ?? tx.lineItemId),
      { externalOrderId, marketplaceSku, variantId, quantity, unitPrice, rowIndex: idx },
    );

    return {
      externalLineId,
      marketplaceSku,
      listingId,
      variantId,
      title: nz(itemInfo.title ?? itemInfo.Title ?? tx.title),
      quantity,
      unitPrice,
      discount: null,
      currency: nz(tx.currency ?? raw.currency ?? 'USD'),
      productId: null,
      skuMasterId: null,
      unitCostSnapshot: null,
      landedCostSnapshot: null,
      costCurrency: null,
      costSource: null,
      matchStatus: 'pending',
      matchReason: null,
      matchConfidence: null,
      rawPayload: tx,
    };
  });

  return emptyCanonicalOrder({
    channel: 'ebay',
    externalOrderId,
    externalOrderNumber: nz(raw.orderNumber ?? raw.ExtendedOrderID) || externalOrderId,
    orderType: 'b2c',
    importSource: 'api:ebay',
    orderStatus: status.orderStatus,
    paymentStatus: status.paymentStatus,
    fulfillmentStatus: status.fulfillmentStatus,
    rawOrderStatus: nz(raw.orderStatus ?? raw.OrderStatus),
    rawPaymentStatus: raw.paidTime ? 'paid' : (nz(raw.checkoutStatus) || null),
    rawFulfillmentStatus: raw.shippedTime ? 'shipped' : null,
    buyer,
    shippingAddress,
    currency: nz(raw.currency ?? 'USD'),
    subtotal: num(raw.subtotal),
    shippingCharged: num(raw.shippingCost ?? raw.ShippingServiceSelected?.ShippingServiceCost),
    discount: num(raw.discount),
    tax: num(raw.tax ?? raw.SalesTax?.SalesTaxAmount),
    total: num(raw.total ?? raw.Total ?? raw.amountPaid),
    orderedAt: iso(raw.orderCreatedTime ?? raw.CreatedTime ?? raw.orderedAt),
    paidAt: iso(raw.paidTime ?? raw.PaidTime),
    shippedAt: iso(raw.shippedTime ?? raw.ShippedTime),
    cancelledAt: iso(raw.cancelledTime ?? raw.CancelledTime),
    items,
    rawPayload: raw,
  });
}

// ─────────────────────────────────────────────────────────────
// Legacy sync shape (src/api/ebayAPI.js getAwaitingShipmentOrders() output)
// ─────────────────────────────────────────────────────────────
function _fromLegacySyncShape(raw) {
  const externalOrderId = String(raw.ebayOrderId).trim();
  if (!externalOrderId) throw new Error('ebayOrderAdapter: ebayOrderId required');

  const status = mapEbayStatus({
    orderStatus: raw._orderStatus ?? null,
    checkoutStatus: raw._checkoutStatus ?? null,
    paidTime: raw._paidTime ?? null,
    shippedTime: raw._shippedTime ?? null,
    cancelStatus: raw._cancelStatus ?? null,
  });

  const buyer = {
    ...emptyBuyer(),
    name: nz(raw.shippingName ?? raw.buyerUserId),
    email: nz(raw.buyerEmail),
    phone: nz(raw.shippingPhone),
    country: nz(raw.shippingCountry),
    countryCode: nz(raw.shippingCountry),
  };

  const shippingAddress = {
    ...emptyAddress(),
    recipientName: nz(raw.shippingName),
    street1: nz(raw.shippingStreet),
    street2: null,
    city: nz(raw.shippingCity),
    state: nz(raw.shippingState),
    postalCode: nz(raw.shippingZip),
    country: nz(raw.shippingCountry),
    countryCode: nz(raw.shippingCountry),
    phone: nz(raw.shippingPhone),
  };

  const quantity = Math.max(1, parseInt(raw.quantity ?? 1, 10) || 1);
  const totalNum = num(raw.price);
  // legacy 'price' = order total (Total in eBay API). unit price unknown from this shape.
  const unitPrice = quantity > 0 && totalNum != null ? totalNum / quantity : null;

  const externalLineId = resolveExternalLineId(
    nz(raw.itemId),   // legacy shape doesn't preserve TransactionID separately — use itemId
    { externalOrderId, marketplaceSku: nz(raw.sku), variantId: null, quantity, unitPrice, rowIndex: 0 },
  );

  const items = [{
    externalLineId,
    marketplaceSku: nz(raw.sku),
    listingId: nz(raw.itemId),
    variantId: null,
    title: nz(raw.title),
    quantity,
    unitPrice,
    discount: null,
    currency: 'USD',
    productId: null,
    skuMasterId: null,
    unitCostSnapshot: null,
    landedCostSnapshot: null,
    costCurrency: null,
    costSource: null,
    matchStatus: 'pending',
    matchReason: null,
    matchConfidence: null,
    rawPayload: null,   // legacy sync shape is already normalised, no per-item raw
  }];

  return emptyCanonicalOrder({
    channel: 'ebay',
    externalOrderId,
    externalOrderNumber: externalOrderId,
    orderType: 'b2c',
    importSource: 'api:ebay',
    orderStatus: status.orderStatus,
    paymentStatus: status.paymentStatus,
    fulfillmentStatus: status.fulfillmentStatus,
    rawOrderStatus: nz(raw._orderStatus),
    rawPaymentStatus: raw._paidTime ? 'paid' : nz(raw._checkoutStatus),
    rawFulfillmentStatus: raw._shippedTime ? 'shipped' : null,
    buyer,
    shippingAddress,
    currency: 'USD',
    subtotal: null,
    shippingCharged: null,
    discount: null,
    tax: null,
    total: totalNum,
    orderedAt: iso(raw.createdDate),
    paidAt: iso(raw._paidTime),
    shippedAt: iso(raw._shippedTime),
    cancelledAt: null,
    items,
    rawPayload: raw,
  });
}

module.exports = { toCanonicalOrder, _fromLegacySyncShape };
