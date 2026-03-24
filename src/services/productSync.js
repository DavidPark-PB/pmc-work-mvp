'use strict';

const { getClient } = require('../db/supabaseClient');

/**
 * Multi-platform product sync → platform-specific tables
 * ebay_products, shopify_products, naver_products, alibaba_products
 */

async function syncPlatformProducts(platforms = ['ebay', 'shopify']) {
  const db = getClient();
  const results = {};

  for (const platform of platforms) {
    try {
      const rawItems = await fetchPlatformItems(platform);
      if (!rawItems || rawItems.length === 0) {
        results[platform] = { synced: 0, error: null };
        continue;
      }

      // Deduplicate by itemId
      const seen = new Set();
      const items = rawItems.filter(item => {
        const key = String(item.itemId);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      let synced = 0;
      const tableName = getTableName(platform);

      // Batch upsert in chunks of 50
      for (let i = 0; i < items.length; i += 50) {
        const batch = items.slice(i, i + 50);
        const rows = batch.map(item => mapToRow(platform, item));
        const conflict = getConflictColumn(platform);

        const { error } = await db.from(tableName)
          .upsert(rows, { onConflict: conflict });
        if (error) {
          console.error(`[ProductSync] ${platform} batch error:`, error.message);
        } else {
          synced += batch.length;
        }
      }

      results[platform] = { synced, total: items.length, error: null };
      console.log(`[ProductSync] ${platform}: ${synced}/${items.length} synced`);
    } catch (err) {
      console.error(`[ProductSync] ${platform} error:`, err.message);
      results[platform] = { synced: 0, error: err.message };
    }
  }

  return results;
}

function getTableName(platform) {
  const map = { ebay: 'ebay_products', shopify: 'shopify_products', alibaba: 'alibaba_products' };
  return map[platform] || `${platform}_products`;
}

function getConflictColumn(platform) {
  if (platform === 'ebay') return 'item_id';
  if (platform === 'shopify') return 'sku';
  return 'sku';
}

function mapToRow(platform, item) {
  if (platform === 'ebay') {
    return {
      item_id: String(item.itemId),
      sku: item.sku || String(item.itemId),
      title: (item.title || '').slice(0, 500),
      price_usd: parseFloat(item.price) || 0,
      shipping_usd: parseFloat(item.shippingCost) || 0,
      stock: parseInt(item.quantity) || 0,
      sales_count: parseInt(item.salesCount) || 0,
      status: 'active',
      image_url: item.imageUrl || '',
    };
  }
  if (platform === 'shopify') {
    return {
      sku: item.sku || String(item.itemId),
      title: (item.title || '').slice(0, 500),
      price_usd: parseFloat(item.price) || 0,
      status: item.status || 'active',
    };
  }
  if (platform === 'alibaba') {
    return {
      sku: item.sku || String(item.itemId),
      title: (item.title || '').slice(0, 500),
    };
  }
  return { sku: item.sku || String(item.itemId), title: item.title || '' };
}

// ─── Platform Fetchers ───

async function fetchPlatformItems(platform) {
  switch (platform) {
    case 'ebay': return fetchEbayItems();
    case 'shopify': return fetchShopifyItems();
    case 'alibaba': return fetchAlibabaItems();
    default: return [];
  }
}

async function fetchEbayItems() {
  const EbayAPI = require('../api/ebayAPI');
  const ebay = new EbayAPI();
  const allItems = [];
  let page = 1;

  while (page <= 25) {
    const result = await ebay.getActiveListings(page, 200);
    if (!result.items || result.items.length === 0) break;

    for (const item of result.items) {
      allItems.push({
        itemId: item.itemId,
        sku: item.sku || '',
        title: item.title || '',
        price: item.price || 0,
        shippingCost: item.shippingCost || 0,
        quantity: (parseInt(item.quantity) || 0) - (parseInt(item.quantitySold) || 0),
        salesCount: parseInt(item.quantitySold) || 0,
        imageUrl: item.imageUrl || '',
      });
    }

    if (!result.hasMore) break;
    page++;
    await sleep(300);
  }

  return allItems;
}

async function fetchShopifyItems() {
  const ShopifyAPI = require('../api/shopifyAPI');
  const shopify = new ShopifyAPI();
  const products = await shopify.getAllProducts(250);
  const items = [];

  for (const p of products) {
    const variant = p.variants && p.variants[0];
    if (!variant) continue;
    items.push({
      itemId: String(p.id),
      sku: variant.sku || String(p.id),
      title: p.title || '',
      price: parseFloat(variant.price) || 0,
      status: p.status || 'active',
    });
  }

  return items;
}

async function fetchAlibabaItems() {
  const AlibabaAPI = require('../api/alibabaAPI');
  const alibaba = new AlibabaAPI();

  try {
    const result = await alibaba.getProductList(1, 50);
    if (!result || !result.products) return [];
    return result.products.map(p => ({
      itemId: String(p.id || p.productId),
      sku: '',
      title: p.subject || p.title || '',
    }));
  } catch (err) {
    console.warn('[ProductSync] Alibaba error:', err.message);
    return [];
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { syncPlatformProducts };
