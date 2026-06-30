'use strict';

/**
 * SKU Context Builder v1
 *
 * Builds a read-only SKU-centered context from Hermes canonical platform sync output,
 * with DB read fallback for exact SKU lookup and competitor enrichment.
 *
 * No DB writes and no marketplace write APIs are called from this module.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');
const ebayConnector = require('../connectors/ebay');
const { generateSignals } = require('../engines/signalEngine');
const { generateRecommendations } = require('../engines/recommendationEngine');

function toNumber(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInteger(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSku(sku) {
  return String(sku || '').trim();
}

function normalizeStockStatus(available) {
  if (available > 0) return 'in_stock';
  if (available === 0) return 'out_of_stock';
  return 'unknown';
}

function emptyContext(sku) {
  return {
    sku,
    platforms: {},
    sales: {
      orders_30d: 0,
      units_30d: 0,
      revenue_30d: 0,
    },
    inventory: {
      total_available: 0,
      stock_status: 'unknown',
    },
    pricing: {
      current_price: 0,
      estimated_margin_pct: null,
      needs_cost_data: true,
    },
    competitors: [],
    signals: [],
    recommendations: [],
    raw_refs: {},
  };
}

function isWithinLastDays(value, days = 30) {
  if (!value) return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  return time >= Date.now() - days * 86400000;
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildSkuContextFromCanonical({ sku, products = [], orders = [], inventory = [], competitors = [] }) {
  const targetSku = normalizeSku(sku);
  if (!targetSku) throw new Error('sku is required');

  const context = emptyContext(targetSku);
  const matchingProducts = (products || []).filter(p => normalizeSku(p.internal_sku) === targetSku);
  const matchingInventory = (inventory || []).filter(i => normalizeSku(i.internal_sku) === targetSku);
  const matchingOrders = (orders || []).filter(o => normalizeSku(o.internal_sku) === targetSku && isWithinLastDays(o.ordered_at, 30));

  const product = matchingProducts[0] || null;
  const inv = matchingInventory[0] || null;

  if (product || inv) {
    const available = toInteger(inv?.available_quantity, 0);
    const sold = toInteger(inv?.sold_quantity, 0);
    context.platforms.ebay = {
      listing_id: product?.platform_listing_id || inv?.platform_listing_id || '',
      title: product?.title || '',
      price: toNumber(product?.price),
      currency: product?.currency || 'USD',
      status: product?.status || inv?.stock_status || 'active',
      available_quantity: available,
      sold_quantity: sold,
    };
    context.inventory.total_available = available;
    context.inventory.stock_status = inv?.stock_status || normalizeStockStatus(available);
    context.pricing.current_price = toNumber(product?.price);
  }

  const orderIds = new Set();
  let units = 0;
  let revenue = 0;
  for (const order of matchingOrders) {
    if (order.platform_order_id) orderIds.add(order.platform_order_id);
    const quantity = toInteger(order.quantity, 1);
    units += quantity;
    revenue += toNumber(order.sold_price) * quantity;
  }

  context.sales = {
    orders_30d: orderIds.size || matchingOrders.length,
    units_30d: units,
    revenue_30d: +revenue.toFixed(2),
  };

  context.competitors = (competitors || []).map(c => ({
    seller_id: c.seller_id || '',
    listing_id: c.listing_id || c.ebay_item_id || c.competitor_item_id || '',
    title: c.title || '',
    price: toNumber(c.price),
    shipping: toNumber(c.shipping),
    total_price: toNumber(c.total_price, toNumber(c.price) + toNumber(c.shipping)),
    status: c.status || 'active',
    confidence: c.confidence == null ? null : toNumber(c.confidence),
    match_status: c.match_status || c.product_match_status || '',
  }));

  context.raw_refs = {
    source: 'canonical',
    product_count: matchingProducts.length,
    order_count: matchingOrders.length,
    inventory_count: matchingInventory.length,
    ebay_listing_ids: uniqueBy([product, inv].filter(Boolean), x => x.platform_listing_id).map(x => x.platform_listing_id),
    platform_order_ids: [...orderIds],
    competitor_listing_ids: context.competitors.map(c => c.listing_id).filter(Boolean),
  };

  context.signals = generateSignals(context);
  context.recommendations = generateRecommendations(context);
  return context;
}

function dbProductToCanonical(row) {
  if (!row) return null;
  return {
    platform: 'ebay',
    platform_listing_id: String(row.item_id || ''),
    internal_sku: row.sku || String(row.item_id || ''),
    title: row.title || '',
    price: toNumber(row.price_usd),
    currency: 'USD',
    status: row.status || 'active',
    raw: row,
  };
}

function dbOrderToCanonical(row) {
  if (!row) return null;
  return {
    platform: 'ebay',
    platform_order_id: String(row.order_no || ''),
    internal_sku: row.sku || '',
    quantity: toInteger(row.quantity, 1),
    sold_price: toNumber(row.payment_amount),
    currency: row.currency || 'USD',
    buyer_country: row.country_code || row.country || '',
    ordered_at: row.order_date || row.created_at || '',
    raw: {
      order_no: row.order_no,
      platform: row.platform,
      sku: row.sku,
      quantity: row.quantity,
      payment_amount: row.payment_amount,
      currency: row.currency,
      country: row.country,
      country_code: row.country_code,
      status: row.status,
      order_date: row.order_date,
    },
  };
}

function dbInventoryToCanonical(row) {
  if (!row) return null;
  const available = toInteger(row.ebay_api_stock ?? row.stock, 0);
  const sold = toInteger(row.sales_count, 0);
  return {
    platform: 'ebay',
    platform_listing_id: String(row.item_id || ''),
    internal_sku: row.sku || String(row.item_id || ''),
    available_quantity: available,
    sold_quantity: sold,
    stock_status: normalizeStockStatus(available),
    raw: row,
  };
}

async function loadDbFallbackForSku(sku) {
  const db = getClient();
  const sinceDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [productResult, ordersResult, matchesResult] = await Promise.all([
    db.from('ebay_products')
      .select('*')
      .eq('sku', sku)
      .limit(5),
    db.from('orders')
      .select('order_no, platform, sku, quantity, payment_amount, currency, country, country_code, status, order_date, created_at')
      .eq('sku', sku)
      .gte('order_date', sinceDate)
      .order('order_date', { ascending: false })
      .limit(500),
    db.from('product_matches')
      .select('our_sku, our_item_id, competitor_item_id, seller_id, confidence, status')
      .eq('our_sku', sku)
      .in('status', ['approved', 'pending'])
      .limit(50),
  ]);

  const products = (productResult.data || []).map(dbProductToCanonical).filter(Boolean);
  const inventory = (productResult.data || []).map(dbInventoryToCanonical).filter(Boolean);
  const orders = (ordersResult.data || [])
    .filter(o => String(o.platform || '').toLowerCase().includes('ebay'))
    .map(dbOrderToCanonical)
    .filter(Boolean);

  const matches = matchesResult.data || [];
  let competitors = [];
  const itemIds = uniqueBy(matches, m => m.competitor_item_id).map(m => m.competitor_item_id).filter(Boolean);
  if (itemIds.length > 0) {
    const compResult = await db.from('competitor_listings')
      .select('seller_id, ebay_item_id, title, price, shipping, total_price, quantity, sold, status, last_seen')
      .in('ebay_item_id', itemIds)
      .limit(100);
    const matchMap = new Map(matches.map(m => [m.competitor_item_id, m]));
    competitors = (compResult.data || []).map(row => {
      const match = matchMap.get(row.ebay_item_id) || {};
      return {
        seller_id: row.seller_id || match.seller_id || '',
        listing_id: row.ebay_item_id,
        title: row.title || '',
        price: row.price,
        shipping: row.shipping,
        total_price: row.total_price,
        status: row.status,
        confidence: match.confidence,
        match_status: match.status,
      };
    });
  }

  const errors = [productResult.error, ordersResult.error, matchesResult.error]
    .filter(Boolean)
    .map(e => e.message);

  return { products, orders, inventory, competitors, errors };
}

async function buildSkuContext({ sku, readOnly = false, skipConnector = false } = {}) {
  const targetSku = normalizeSku(sku);
  if (!targetSku) throw new Error('sku is required');
  const useConnector = !(readOnly || skipConnector);

  // First try a small read-only canonical sync snapshot. This keeps Phase 1B wired
  // to the connector contract without requiring full 9k+ listing scans for one SKU.
  let canonical = { products: [], orders: [], inventory: [] };
  let connectorError = null;
  let connectorSkipped = null;
  if (useConnector) {
    try {
      canonical = await ebayConnector.syncAll({ days: 30, limit: 200 });
    } catch (e) {
      connectorError = e.message;
    }
  } else {
    connectorSkipped = readOnly ? 'read_only' : 'skip_connector';
  }

  let context = buildSkuContextFromCanonical({
    sku: targetSku,
    products: canonical.products || [],
    orders: canonical.orders || [],
    inventory: canonical.inventory || [],
  });

  if (context.platforms.ebay) {
    context.raw_refs.source = 'connector';
    if (connectorError) context.raw_refs.connector_error = connectorError;
    return context;
  }

  // Exact SKU fallback from existing DB mirror tables.
  const fallback = await loadDbFallbackForSku(targetSku);
  context = buildSkuContextFromCanonical({
    sku: targetSku,
    products: fallback.products,
    orders: fallback.orders,
    inventory: fallback.inventory,
    competitors: fallback.competitors,
  });
  context.raw_refs.source = 'db_fallback';
  if (connectorError) context.raw_refs.connector_error = connectorError;
  if (connectorSkipped) context.raw_refs.connector_skipped = connectorSkipped;
  if (fallback.errors.length > 0) context.raw_refs.db_errors = fallback.errors;
  return context;
}

async function buildSkuContexts({ limit = 5 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, toInteger(limit, 5)));
  const canonical = await ebayConnector.syncAll({ days: 30, limit: safeLimit });
  const skus = uniqueBy(canonical.products || [], p => normalizeSku(p.internal_sku))
    .map(p => normalizeSku(p.internal_sku))
    .filter(Boolean)
    .slice(0, safeLimit);

  return skus.map(sku => buildSkuContextFromCanonical({
    sku,
    products: canonical.products || [],
    orders: canonical.orders || [],
    inventory: canonical.inventory || [],
  }));
}

module.exports = {
  buildSkuContext,
  buildSkuContextFromCanonical,
  buildSkuContexts,
};
