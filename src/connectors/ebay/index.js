'use strict';

/**
 * Hermes Platform Sync: eBay Connector
 *
 * Read-only connector that reuses the existing EbayAPI/tokenStore authentication path
 * and normalizes eBay data into Hermes canonical JSON models.
 *
 * No DB writes and no marketplace write APIs are called from this module.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../config/.env') });

const EbayAPI = require('../../api/ebayAPI');

const PLATFORM = 'ebay';
const DEFAULT_PRODUCT_PAGE_SIZE = 100;
const MAX_PRODUCT_PAGES = 100;

function toNumber(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInteger(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStatus(value, quantityAvailable = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ended' || raw === 'completed' || raw === 'inactive') return 'ended';
  if (raw === 'out_of_stock' || raw === 'outofstock') return 'out_of_stock';
  if (quantityAvailable === 0) return 'out_of_stock';
  return raw || 'active';
}

function redactOrderRaw(transaction) {
  if (!transaction || typeof transaction !== 'object') return transaction;
  const redacted = { ...transaction };
  const piiFields = [
    'buyerUserId',
    'buyerEmail',
    'shippingName',
    'shippingStreet',
    'shippingCity',
    'shippingState',
    'shippingZip',
    'shippingPhone',
  ];
  for (const field of piiFields) {
    if (redacted[field]) redacted[field] = '[redacted]';
  }
  return redacted;
}

function canonicalProduct(item) {
  return {
    platform: PLATFORM,
    platform_listing_id: String(item.itemId || ''),
    internal_sku: item.sku || String(item.itemId || ''),
    title: item.title || '',
    price: toNumber(item.price),
    currency: item.currency || 'USD',
    status: normalizeStatus(item.status || item.listingStatus),
    raw: item,
  };
}

function canonicalOrder(transaction) {
  return {
    platform: PLATFORM,
    platform_order_id: String(transaction.ebayOrderId || transaction.transactionId || ''),
    internal_sku: transaction.sku || '',
    quantity: toInteger(transaction.quantity, 1),
    sold_price: toNumber(transaction.price),
    currency: transaction.currency || 'USD',
    buyer_country: transaction.shippingCountry || transaction.country || '',
    ordered_at: transaction.createdDate || transaction.created_at || '',
    raw: redactOrderRaw(transaction),
  };
}

function canonicalInventory(item) {
  const quantity = toInteger(item.quantity, 0);
  const sold = toInteger(item.quantitySold ?? item.salesCount, 0);
  const status = normalizeStatus(item.status || item.listingStatus, quantity);
  return {
    platform: PLATFORM,
    platform_listing_id: String(item.itemId || ''),
    internal_sku: item.sku || String(item.itemId || ''),
    available_quantity: quantity,
    sold_quantity: sold,
    stock_status: status === 'out_of_stock' ? 'out_of_stock' : (quantity > 0 ? 'in_stock' : status),
    raw: item,
  };
}

async function fetchActiveListings({ limit = null, pageSize = DEFAULT_PRODUCT_PAGE_SIZE } = {}) {
  const ebay = new EbayAPI();
  const allItems = [];
  const targetLimit = limit == null ? null : Math.max(1, toInteger(limit, 50));
  const safePageSize = Math.max(1, Math.min(200, toInteger(pageSize, DEFAULT_PRODUCT_PAGE_SIZE)));

  for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
    const remaining = targetLimit == null ? safePageSize : Math.max(1, Math.min(safePageSize, targetLimit - allItems.length));
    const result = await ebay.getActiveListings(page, remaining);
    const items = Array.isArray(result.items) ? result.items : [];
    allItems.push(...items);

    if (targetLimit != null && allItems.length >= targetLimit) break;
    if (!result.hasMore || items.length === 0) break;
    await ebay.sleep(300);
  }

  return targetLimit == null ? allItems : allItems.slice(0, targetLimit);
}

async function syncProducts(options = {}) {
  const items = await fetchActiveListings(options);
  return items.map(canonicalProduct);
}

async function syncOrders({ days = 30, limit = null } = {}) {
  const ebay = new EbayAPI();
  const safeDays = Math.max(1, Math.min(30, toInteger(days, 30)));
  const transactions = await ebay.getSellerTransactions(safeDays);
  const rows = Array.isArray(transactions) ? transactions : [];
  const sliced = limit == null ? rows : rows.slice(0, Math.max(1, toInteger(limit, 50)));
  return sliced.map(canonicalOrder);
}

async function syncInventory(options = {}) {
  const items = await fetchActiveListings(options);
  return items.map(canonicalInventory);
}

async function syncAll({ days = 30, limit = null } = {}) {
  const [products, orders, inventory] = await Promise.all([
    syncProducts({ limit }),
    syncOrders({ days, limit }),
    syncInventory({ limit }),
  ]);
  return { products, orders, inventory };
}

module.exports = {
  syncProducts,
  syncOrders,
  syncInventory,
  syncAll,
  canonicalProduct,
  canonicalOrder,
  canonicalInventory,
};
