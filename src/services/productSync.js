'use strict';

const { getClient } = require('../db/supabaseClient');

/**
 * Multi-platform product sync → platform_listings table
 * Fetches products from eBay, Shopify, Shopee, Alibaba and upserts to Supabase
 */

async function syncPlatformProducts(platforms = ['ebay', 'shopify', 'shopee', 'alibaba']) {
  const db = getClient();
  const results = {};

  for (const platform of platforms) {
    try {
      const items = await fetchPlatformItems(platform);
      if (!items || items.length === 0) {
        results[platform] = { synced: 0, error: null };
        continue;
      }

      let synced = 0;
      // Batch upsert in chunks of 50
      for (let i = 0; i < items.length; i += 50) {
        const batch = items.slice(i, i + 50);
        const rows = batch.map(item => ({
          platform,
          platform_item_id: String(item.itemId),
          platform_sku: item.sku || '',
          title: (item.title || '').slice(0, 500),
          price: parseFloat(item.price) || 0,
          shipping_cost: parseFloat(item.shippingCost) || 0,
          quantity: parseInt(item.quantity) || 0,
          status: 'active',
          listing_url: item.url || '',
          image_url: item.imageUrl || '',
          currency: item.currency || 'USD',
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));

        const { error } = await db.from('platform_listings')
          .upsert(rows, { onConflict: 'platform,platform_item_id' });
        if (error) {
          console.error(`[ProductSync] ${platform} batch upsert error:`, error.message);
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

async function fetchPlatformItems(platform) {
  switch (platform) {
    case 'ebay': return fetchEbayItems();
    case 'shopify': return fetchShopifyItems();
    case 'shopee': return fetchShopeeItems();
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
        url: item.viewUrl || '',
        imageUrl: item.imageUrl || '',
        currency: 'USD',
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
    const variant = p.variants?.[0];
    if (!variant) continue;
    items.push({
      itemId: String(p.id),
      sku: variant.sku || '',
      title: p.title || '',
      price: parseFloat(variant.price) || 0,
      shippingCost: 0,
      quantity: variant.inventory_quantity || 0,
      url: p.handle ? `https://${process.env.SHOPIFY_STORE_URL}/products/${p.handle}` : '',
      imageUrl: p.image?.src || '',
      currency: 'USD',
    });
  }

  return items;
}

async function fetchShopeeItems() {
  const ShopeeAPI = require('../api/shopeeAPI');
  const shopee = new ShopeeAPI();
  const allItems = [];

  try {
    const shopIds = shopee.shopIds || [];
    for (const shopId of shopIds.slice(0, 2)) { // Limit to 2 shops to avoid timeout
      try {
        const result = await shopee.getProducts(0, 50, 'NORMAL', shopId);
        const shopItems = result?.response?.item || result?.items || [];
        for (const item of shopItems) {
          allItems.push({
            itemId: String(item.item_id),
            sku: '',
            title: item.item_name || '',
            price: 0,
            shippingCost: 0,
            quantity: 0,
            url: '',
            imageUrl: '',
            currency: 'SGD',
          });
        }
      } catch (shopErr) {
        console.warn(`[ProductSync] Shopee shop ${shopId} error:`, shopErr.message);
      }
      await sleep(500);
    }
  } catch (err) {
    console.warn('[ProductSync] Shopee error:', err.message);
  }

  return allItems;
}

async function fetchAlibabaItems() {
  const AlibabaAPI = require('../api/alibabaAPI');
  const alibaba = new AlibabaAPI();
  const allItems = [];

  try {
    const result = await alibaba.getProductList(1, 50);
    if (result?.products) {
      for (const p of result.products) {
        allItems.push({
          itemId: String(p.id || p.productId),
          sku: '',
          title: p.subject || p.title || '',
          price: parseFloat(p.price) || 0,
          shippingCost: 0,
          quantity: 999,
          url: p.productUrl || '',
          imageUrl: p.imageUrl || '',
          currency: 'USD',
        });
      }
    }
  } catch (err) {
    console.warn('[ProductSync] Alibaba error:', err.message);
  }

  return allItems;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { syncPlatformProducts };
