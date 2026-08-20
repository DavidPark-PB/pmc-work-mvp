/**
 * src/services/oms/canonicalOrder.js — Canonical OMS Order DTO (typedef only).
 *
 * Owner directive §1: 채널 adapter 가 DB schema 를 직접 알게 하지 마라.
 *                     공통 DTO/contract 를 만들고 어댑터는 이것만 반환한다.
 *
 * JSDoc typedef + 소형 helper 만. runtime validation 은 canonicalOrderValidator.js.
 *
 * Field naming: camelCase (JS 관습). DB column 은 snake_case — mapping 은
 * omsOrderRepository.js 가 담당. Adapter/service 는 절대 snake_case 사용 X.
 */
'use strict';

/**
 * @typedef {'ebay'|'shopify'|'shopee'|'naver'|'coupang'|'qoo10'|'alibaba'|'b2b'|'manual'} Channel
 * @typedef {'b2c'|'b2b'|'manual'} OrderType
 * @typedef {'new'|'confirmed'|'processing'|'on_hold'|'ready_to_ship'|'shipped'|'completed'|'cancelled'|'returned'} OrderStatus
 * @typedef {'pending'|'paid'|'partially_paid'|'partially_refunded'|'refunded'|'failed'} PaymentStatus
 * @typedef {'unfulfilled'|'partially_fulfilled'|'fulfilled'|'returned'} FulfillmentStatus
 * @typedef {'high'|'medium'|'low'} MatchConfidence
 * @typedef {'pending'|'matched_link'|'matched_marketplace_sku'|'matched_internal_sku'|'failed'} MatchStatus
 */

/**
 * @typedef {Object} CanonicalBuyer
 * @property {string|null} name
 * @property {string|null} email
 * @property {string|null} phone
 * @property {string|null} country
 * @property {string|null} countryCode        ISO 2-letter (US/KR/JP/…)
 */

/**
 * @typedef {Object} CanonicalAddress
 * @property {string|null} recipientName
 * @property {string|null} street1
 * @property {string|null} street2
 * @property {string|null} city
 * @property {string|null} state
 * @property {string|null} postalCode
 * @property {string|null} country
 * @property {string|null} countryCode
 * @property {string|null} phone
 */

/**
 * @typedef {Object} CanonicalOrderItem
 * @property {string}      externalLineId          채널 line id · 없으면 deterministic hash (lineId.js)
 * @property {string|null} marketplaceSku
 * @property {string|null} listingId               eBay ItemID / Shopify product_id
 * @property {string|null} variantId               옵션/variant id
 * @property {string|null} title
 * @property {number}      quantity                > 0
 * @property {number|null} unitPrice
 * @property {number|null} discount
 * @property {string|null} currency
 * @property {number|null} [productId]             매칭 결과 · products.id
 * @property {number|null} [skuMasterId]           매칭 결과 · sku_master.id
 * @property {number|null} [unitCostSnapshot]      per-unit cost at match time
 * @property {number|null} [landedCostSnapshot]    landed cost (shipping+duty 포함)
 * @property {string|null} [costCurrency]          'KRW' | 'USD' | 'JPY' | 'CNY' | …
 * @property {string|null} [costSource]            'sku_master' | 'products' | 'manual' | 'ai_estimate'
 * @property {MatchStatus} [matchStatus]           기본 'pending'
 * @property {string|null} [matchReason]
 * @property {MatchConfidence|null} [matchConfidence]
 * @property {Object}      [rawPayload]            원본 line payload
 */

/**
 * @typedef {Object} CanonicalOrder
 * @property {Channel}     channel
 * @property {string}      externalOrderId         채널 측 주문 id (eBay OrderID, Shopify id …)
 * @property {string|null} externalOrderNumber     채널 표시용 번호 (Shopify '#1001' 등)
 * @property {OrderType}   orderType               기본 'b2c'
 * @property {string|null} sourceSystem            기본 'pmc-work-mvp'
 * @property {string}      importSource            'api:ebay' | 'api:shopify' | 'csv' | 'mock' | 'manual'
 *
 * @property {OrderStatus}       orderStatus
 * @property {PaymentStatus}     paymentStatus
 * @property {FulfillmentStatus} fulfillmentStatus
 * @property {string|null}       rawOrderStatus
 * @property {string|null}       rawPaymentStatus
 * @property {string|null}       rawFulfillmentStatus
 *
 * @property {CanonicalBuyer}   buyer
 * @property {CanonicalAddress} shippingAddress
 *
 * @property {string|null} currency
 * @property {number|null} subtotal
 * @property {number|null} shippingCharged
 * @property {number|null} discount
 * @property {number|null} tax
 * @property {number|null} total
 *
 * @property {string|null} orderedAt               ISO string
 * @property {string|null} paidAt
 * @property {string|null} confirmedAt
 * @property {string|null} readyToShipAt
 * @property {string|null} shippedAt
 * @property {string|null} completedAt
 * @property {string|null} cancelledAt
 * @property {string|null} returnedAt
 *
 * @property {string|null} holdReason              allowlist enforced by canonicalOrderValidator
 * @property {string|null} holdNote
 * @property {string|null} cancellationReason
 * @property {string|null} cancellationNote
 * @property {string|null} notes
 *
 * @property {CanonicalOrderItem[]} items
 * @property {Object|null} rawPayload
 */

/**
 * Return a CanonicalOrder skeleton with safe defaults. Adapters extend this.
 * @param {Partial<CanonicalOrder>} overrides
 * @returns {CanonicalOrder}
 */
function emptyCanonicalOrder(overrides = {}) {
  const base = {
    channel: overrides.channel,
    externalOrderId: overrides.externalOrderId,
    externalOrderNumber: null,
    orderType: 'b2c',
    sourceSystem: 'pmc-work-mvp',
    importSource: overrides.importSource || 'manual',

    orderStatus: 'new',
    paymentStatus: 'pending',
    fulfillmentStatus: 'unfulfilled',
    rawOrderStatus: null,
    rawPaymentStatus: null,
    rawFulfillmentStatus: null,

    buyer: emptyBuyer(),
    shippingAddress: emptyAddress(),

    currency: null,
    subtotal: null,
    shippingCharged: null,
    discount: null,
    tax: null,
    total: null,

    orderedAt: null,
    paidAt: null,
    confirmedAt: null,
    readyToShipAt: null,
    shippedAt: null,
    completedAt: null,
    cancelledAt: null,
    returnedAt: null,

    holdReason: null,
    holdNote: null,
    cancellationReason: null,
    cancellationNote: null,
    notes: null,

    items: [],
    rawPayload: null,
  };
  return { ...base, ...overrides };
}

function emptyBuyer() {
  return { name: null, email: null, phone: null, country: null, countryCode: null };
}

function emptyAddress() {
  return {
    recipientName: null, street1: null, street2: null,
    city: null, state: null, postalCode: null,
    country: null, countryCode: null, phone: null,
  };
}

/**
 * Allowlist references (single source of truth for validators + tests).
 */
const CANONICAL_ENUMS = Object.freeze({
  channel: ['ebay','shopify','shopee','naver','coupang','qoo10','alibaba','b2b','manual'],
  orderType: ['b2c','b2b','manual'],
  orderStatus: ['new','confirmed','processing','on_hold','ready_to_ship','shipped','completed','cancelled','returned'],
  paymentStatus: ['pending','paid','partially_paid','partially_refunded','refunded','failed'],
  fulfillmentStatus: ['unfulfilled','partially_fulfilled','fulfilled','returned'],
  holdReason: [
    'out_of_stock','insufficient_stock','address_issue','payment_issue',
    'customs_issue','fraud_risk','damaged_item','supplier_issue','manual_review','other',
  ],
  cancellationReason: [
    'buyer_request','out_of_stock','price_issue','shipping_cost','payment_failed',
    'customs_issue','unavailable_product','fraud','other',
  ],
  matchStatus: ['pending','matched_link','matched_marketplace_sku','matched_internal_sku','failed'],
  matchConfidence: ['high','medium','low'],
});

module.exports = {
  emptyCanonicalOrder,
  emptyBuyer,
  emptyAddress,
  CANONICAL_ENUMS,
};
