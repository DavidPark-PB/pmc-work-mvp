/**
 * DataSource — Supabase-only data access layer
 * All Google Sheets fallbacks removed. Supabase is the single source of truth.
 */

// Lazy-load repositories
let _productRepo, _orderRepo, _syncRepo, _skuScoreRepo, _b2bRepo, _platformRepo;

function getProductRepo() {
  if (!_productRepo) {
    const ProductRepository = require('../db/productRepository');
    _productRepo = new ProductRepository();
  }
  return _productRepo;
}

function getOrderRepo() {
  if (!_orderRepo) {
    const OrderRepository = require('../db/orderRepository');
    _orderRepo = new OrderRepository();
  }
  return _orderRepo;
}

function getSyncRepo() {
  if (!_syncRepo) {
    const SyncRepository = require('../db/syncRepository');
    _syncRepo = new SyncRepository();
  }
  return _syncRepo;
}

function getSkuScoreRepo() {
  if (!_skuScoreRepo) {
    const SkuScoreRepository = require('../db/skuScoreRepository');
    _skuScoreRepo = new SkuScoreRepository();
  }
  return _skuScoreRepo;
}

function getB2BRepo() {
  if (!_b2bRepo) {
    const B2BRepository = require('../db/b2bRepository');
    _b2bRepo = new B2BRepository();
  }
  return _b2bRepo;
}

function getPlatformRepo() {
  if (!_platformRepo) {
    const PlatformRepository = require('../db/platformRepository');
    _platformRepo = new PlatformRepository();
  }
  return _platformRepo;
}

// ─── Platform tagging logic ───
function tagPlatforms(data) {
  (data || []).forEach(item => {
    const platforms = [];
    const ebay = (item.ebayStatus || '').trim();
    const shopify = (item.shopifyStatus || '').trim();
    if (item.itemId && item.itemId.trim()) platforms.push('eBay');
    if (shopify.includes('✅') || (shopify.includes('등록') && !shopify.includes('미등록'))) {
      platforms.push('Shopify');
    }
    item.platform = platforms.length > 0 ? platforms.join(', ') : '미분류';
    item.ebayActive = ebay.includes('✅') || (ebay.includes('등록') && !ebay.includes('미등록'));
    item.shopifyActive = shopify.includes('✅') || (shopify.includes('등록') && !shopify.includes('미등록'));
  });
  return data;
}

// ─── Dashboard data ───
async function getDashboardData() {
  const data = await getProductRepo().getDashboardProducts();
  return tagPlatforms(data);
}

// ─── All platform data (for product registration views) ───
async function getAllPlatformData() {
  const [dashboard, ebay, shopify, naver, alibaba] = await Promise.all([
    getProductRepo().getDashboardProducts(),
    getProductRepo().getEbayProducts(),
    getProductRepo().getShopifyProducts(),
    getProductRepo().getNaverProducts(),
    getProductRepo().getAlibabaProducts(),
  ]);

  // Cross-reference merge
  const ebayMap = {};
  ebay.forEach(e => { if (e.sku) ebayMap[e.sku] = e; });
  const shopifyMap = {};
  shopify.forEach(s => { if (s.sku) shopifyMap[s.sku] = s; });
  const naverMap = {};
  naver.forEach(n => { if (n.sku) naverMap[n.sku] = n; });
  const alibabaMap = {};
  alibaba.forEach(a => { if (a.sku) alibabaMap[a.sku] = a; });

  const merged = dashboard.map(item => {
    const platforms = [];
    const eItem = ebayMap[item.sku];
    const sItem = shopifyMap[item.sku];
    const nItem = naverMap[item.sku];
    const aItem = alibabaMap[item.sku];

    if (eItem) { platforms.push('eBay'); delete ebayMap[item.sku]; }
    else if (item.itemId && item.itemId.trim()) { platforms.push('eBay'); }
    if (sItem) { platforms.push('Shopify'); delete shopifyMap[item.sku]; }
    if (nItem) { platforms.push('Naver'); delete naverMap[item.sku]; }
    if (aItem) { platforms.push('Alibaba'); delete alibabaMap[item.sku]; }

    item.platform = platforms.length > 0 ? platforms.join(', ') : '미분류';

    if (eItem && eItem.settlement) item.settlement = eItem.settlement;
    else if (sItem && sItem.settlement) item.settlement = sItem.settlement;
    if (!item.profit && sItem && sItem.profit) item.profit = sItem.profit;
    if (!item.margin && sItem && sItem.margin) item.margin = sItem.margin;

    return item;
  });

  // Add platform-only items not in dashboard
  const addPlatformOnly = (map, label) => {
    Object.values(map).forEach(item => {
      item.platform = label;
      merged.push(item);
    });
  };
  addPlatformOnly(ebayMap, 'eBay');
  addPlatformOnly(shopifyMap, 'Shopify');
  addPlatformOnly(naverMap, 'Naver');
  addPlatformOnly(alibabaMap, 'Alibaba');

  return merged;
}

// ─── Update product (price/stock) ───
async function updateProduct(searchField, searchValue, updates, altSku) {
  let result = await getProductRepo().updateProductField(searchField, searchValue, updates);
  if (!result.success && altSku) {
    result = await getProductRepo().updateProductField('sku', altSku, updates);
  }
  return result;
}

// ─── Sync history ───
async function getSyncHistory() {
  const data = await getSyncRepo().getHistory(20);
  return data.map(r => ({
    platform: r.platform,
    action: r.action,
    status: r.status,
    itemsSynced: r.items_synced,
    error: r.error_message,
    timestamp: r.created_at,
    details: r.details,
  }));
}

// ─── Platform product count ───
async function getPlatformProductCount(platform) {
  const { count, error } = await getProductRepo().db
    .from('platform_listings')
    .select('*', { count: 'exact', head: true })
    .eq('platform', platform);
  if (error) return 0;
  return count || 0;
}

// ─── Orders ───
async function getRecentOrders(limit = 50) {
  const data = await getOrderRepo().getRecent(limit);
  return {
    orders: data.map(o => ({
      rowIndex: o.id,
      orderDate: o.order_date,
      platform: o.platform,
      orderNo: o.order_no,
      sku: o.sku,
      title: o.title,
      quantity: o.quantity,
      paymentAmount: o.payment_amount,
      currency: o.currency,
      buyerName: o.buyer_name,
      country: o.country,
      carrier: o.carrier,
      trackingNo: o.tracking_no,
      status: o.status,
      street: o.street,
      city: o.city,
      province: o.province,
      zipCode: o.zip_code,
      phone: o.phone,
      countryCode: o.country_code,
      email: o.email,
    })),
    total: data.length,
  };
}

// ─── SKU Scores ───
async function getAllSkuScores() {
  return await getSkuScoreRepo().getAllScores();
}

async function getSkuScoreSummary() {
  return await getSkuScoreRepo().getSummary();
}

async function getSkuScoreBySku(sku) {
  return await getSkuScoreRepo().getScoreBySku(sku);
}

module.exports = {
  getDashboardData,
  getAllPlatformData,
  updateProduct,
  getSyncHistory,
  getPlatformProductCount,
  getRecentOrders,
  getAllSkuScores,
  getSkuScoreSummary,
  getSkuScoreBySku,
  getProductRepo,
  getOrderRepo,
  getSyncRepo,
  getSkuScoreRepo,
  getB2BRepo,
  getPlatformRepo,
};
