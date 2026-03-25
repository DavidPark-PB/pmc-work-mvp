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
    const sku = variant.sku || String(p.id);
    // Skip 번개장터 API products (numeric-only SKU = Shopify product ID)
    if (/^\d+$/.test(sku)) continue;
    items.push({
      itemId: String(p.id),
      sku,
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

/**
 * Sync ebay_products + shopify_products → master products table
 */
async function syncToMaster() {
  const db = getClient();
  const results = { ebay: 0, shopify: 0, errors: [] };

  // 1. eBay → products
  try {
    const { data: ebayItems } = await db.from('ebay_products').select('*');
    if (ebayItems && ebayItems.length > 0) {
      for (const item of ebayItems) {
        const sku = item.sku || `EBAY-${item.item_id}`;
        try {
          // Check if exists by ebay_item_id or sku
          const { data: existing } = await db.from('products')
            .select('id')
            .or(`ebay_item_id.eq.${item.item_id},sku.eq.${sku}`)
            .limit(1);

          if (existing && existing.length > 0) {
            // Update
            await db.from('products').update({
              title: item.title || undefined,
              price_usd: item.price_usd || undefined,
              stock: item.stock || 0,
              updated_at: new Date().toISOString(),
            }).eq('id', existing[0].id);
          } else {
            // Insert
            await db.from('products').insert({
              sku,
              title: item.title || '',
              price_usd: item.price_usd || 0,
              stock: item.stock || 0,
              ebay_item_id: item.item_id,
              status: 'active',
              workflow_status: 'listed',
            });
          }
          results.ebay++;
        } catch (e) {
          // Skip duplicates silently
        }
      }
    }
  } catch (e) {
    results.errors.push('eBay: ' + e.message);
  }

  // 2. Shopify → products
  try {
    const { data: shopifyItems } = await db.from('shopify_products').select('*');
    if (shopifyItems && shopifyItems.length > 0) {
      for (const item of shopifyItems) {
        const sku = item.sku || `SHOP-${Date.now()}`;
        if (/^\d+$/.test(sku)) continue; // Skip 번개장터
        try {
          const { data: existing } = await db.from('products')
            .select('id')
            .eq('sku', sku)
            .limit(1);

          if (existing && existing.length > 0) {
            await db.from('products').update({
              title: item.title || undefined,
              price_usd: item.price_usd || undefined,
              updated_at: new Date().toISOString(),
            }).eq('id', existing[0].id);
          } else {
            await db.from('products').insert({
              sku,
              title: item.title || '',
              price_usd: item.price_usd || 0,
              stock: 0,
              status: 'active',
              workflow_status: 'listed',
            });
          }
          results.shopify++;
        } catch (e) {
          // Skip duplicates silently
        }
      }
    }
  } catch (e) {
    results.errors.push('Shopify: ' + e.message);
  }

  return results;
}

module.exports = { syncPlatformProducts, syncToMaster };
