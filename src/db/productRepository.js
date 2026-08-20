/**
 * Product Repository — Uses existing products + platform_listings tables
 * Return formats match existing readDashboardSheet(), readEbaySheetData(), etc.
 *
 * Table mapping:
 *   master_products (planned) → products (existing, extended)
 *   ebay/shopify/naver/alibaba_products (planned) → platform_listings (existing, extended)
 */
const { getClient } = require('./supabaseClient');

class ProductRepository {
  get db() { return getClient(); }

  // ─── Replaces readDashboardSheet() in api.js:1183 ───
  // Reads from extended `products` table
  async getDashboardProducts() {
    const { data, error } = await this.db
      .from('products')
      .select('*')
      .not('sku', 'is', null)
      .neq('sku', '')
      .order('sku');
    if (error) throw error;

    return (data || []).map(r => {
      const priceUSD = parseFloat(r.price_usd) || 0;
      const shipUSD = parseFloat(r.shipping_usd) || 0;
      const settlement = (priceUSD + shipUSD) * 0.82 * 1400;
      return {
        image: r.image_url || '',
        sku: r.sku || '',
        title: r.title_ko || r.title || '',
        weight: String(r.weight || ''),
        purchase: String(r.cost_price || ''),
        shippingKRW: String(r.shipping_krw || ''),
        fee: String(r.fee_krw || ''),
        tax: String(r.tax_krw || ''),
        totalCost: String(r.total_cost || ''),
        priceUSD: String(priceUSD || ''),
        shippingUSD: String(shipUSD || ''),
        profit: String(r.profit_krw || ''),
        margin: String(r.margin_pct || ''),
        itemId: r.ebay_item_id || '',
        salesCount: String(r.sales_count || ''),
        stock: String(r.stock || ''),
        ebayStatus: r.ebay_status || '',
        shopifyStatus: r.shopify_status || '',
        supplier: r.supplier || '',
        platform: '',
        settlement: Math.round(settlement),
      };
    });
  }

  // ─── Replaces readEbaySheetData() in api.js:1211 ───
  // Reads from platform_listings WHERE platform = 'ebay'
  async getEbayProducts() {
    const { data, error } = await this.db
      .from('platform_listings')
      .select('*')
      .eq('platform', 'ebay')
      .order('sku');
    if (error) throw error;

    return (data || []).map(r => {
      const priceUSD = parseFloat(r.price) || 0;
      const shipUSD = parseFloat(r.shipping_cost) || 0;
      const feeRate = parseFloat(r.fee_rate) || 13;
      const settlement = (priceUSD + shipUSD) * (1 - feeRate / 100) * 1400;
      return {
        image: r.image_url || '',
        sku: r.sku || r.platform_sku || '',
        title: r.title || '',
        weight: '', purchase: '', shippingKRW: '', fee: '', tax: '',
        totalCost: '',
        priceUSD: String(priceUSD || ''),
        shippingUSD: String(shipUSD || ''),
        profit: '', margin: '',
        itemId: r.platform_item_id || '',
        salesCount: String(r.sales_count || ''),
        stock: String(r.quantity || ''),
        ebayStatus: r.status || '',
        shopifyStatus: '',
        platform: 'eBay',
        settlement: Math.round(settlement),
      };
    }).filter(r => r.sku);
  }

  // ─── Replaces readShopifySheetData() in api.js:1237 ───
  async getShopifyProducts() {
    const { data, error } = await this.db
      .from('platform_listings')
      .select('*')
      .eq('platform', 'shopify')
      .order('sku');
    if (error) throw error;

    return (data || []).map(r => {
      const priceUSD = parseFloat(r.price) || 0;
      const exchangeRate = parseFloat(r.exchange_rate) || 1400;
      const feeRate = parseFloat(r.fee_rate) || 15;
      const settlement = priceUSD * exchangeRate * (1 - feeRate / 100);
      return {
        image: '', sku: r.sku || r.platform_sku || '', title: r.title || '',
        weight: '',
        purchase: String(r.purchase_price_krw || ''),
        shippingKRW: String(r.shipping_krw || ''),
        fee: '', tax: '', totalCost: '',
        priceUSD: String(priceUSD || ''), shippingUSD: '',
        profit: String(r.profit_krw || ''),
        margin: String(r.margin_pct || ''),
        itemId: '', salesCount: '', stock: '',
        ebayStatus: '', shopifyStatus: r.status || '',
        platform: 'Shopify',
        settlement: Math.round(settlement),
      };
    }).filter(r => r.sku);
  }

  // ─── Replaces readNaverSheetData() in api.js:1265 ───
  async getNaverProducts() {
    const { data, error } = await this.db
      .from('platform_listings')
      .select('*')
      .eq('platform', 'naver')
      .order('sku');
    if (error) throw error;

    return (data || []).map(r => {
      const priceKRW = parseInt(r.price) || 0;
      const feeRate = parseFloat(r.fee_rate) || 5.5;
      const settlement = priceKRW * (1 - feeRate / 100);
      return {
        image: r.image_url || '',
        sku: r.sku || r.platform_sku || r.platform_item_id || '',
        title: r.title || '',
        weight: '', purchase: '', shippingKRW: '', fee: '', tax: '',
        totalCost: '', priceUSD: '', shippingUSD: '',
        profit: '', margin: '',
        itemId: '', salesCount: '',
        stock: String(r.quantity || ''),
        ebayStatus: '', shopifyStatus: '',
        platform: 'Naver',
        settlement: Math.round(settlement),
        priceKRW: String(priceKRW || ''),
      };
    }).filter(r => r.sku);
  }

  // ─── Replaces readAlibabaSheetData() in api.js:1291 ───
  async getAlibabaProducts() {
    const { data, error } = await this.db
      .from('platform_listings')
      .select('*')
      .eq('platform', 'alibaba')
      .order('sku');
    if (error) throw error;

    return (data || []).map(r => ({
      image: r.image_url || '', sku: r.sku || r.platform_sku || '', title: r.title || '',
      weight: '', purchase: '', shippingKRW: '', fee: '', tax: '',
      totalCost: '', priceUSD: '', shippingUSD: '',
      profit: '', margin: '',
      itemId: '', salesCount: '', stock: '',
      ebayStatus: '', shopifyStatus: '',
      platform: 'Alibaba', settlement: 0,
    })).filter(r => r.sku);
  }

  // ─── Replaces updateGoogleSheet() in api.js:1600 ───
  async updateProductField(searchField, searchValue, updates) {
    // Update the products table
    const where = searchField === 'itemId'
      ? { ebay_item_id: String(searchValue) }
      : { sku: String(searchValue) };

    const dbUpdates = {};
    if (updates.priceUSD !== undefined) dbUpdates.price_usd = parseFloat(updates.priceUSD);
    if (updates.stock !== undefined) dbUpdates.stock = parseInt(updates.stock);
    if (updates.ebayStatus !== undefined) dbUpdates.ebay_status = updates.ebayStatus;
    if (updates.shopifyStatus !== undefined) dbUpdates.shopify_status = updates.shopifyStatus;
    if (updates.itemId !== undefined) dbUpdates.ebay_item_id = updates.itemId;
    if (updates.margin !== undefined) dbUpdates.margin_pct = parseFloat(updates.margin);
    if (updates.profit !== undefined) dbUpdates.profit_krw = parseInt(updates.profit);

    if (Object.keys(dbUpdates).length === 0) return { success: true };

    const [field, value] = Object.entries(where)[0];
    const { error } = await this.db
      .from('products')
      .update(dbUpdates)
      .eq(field, value);

    if (error) return { success: false, error: error.message };
    return { success: true };
  }

  // ─── Create/update product in products table ───
  async createProduct(product) {
    const row = {
      sku: product.sku,
      title: product.titleEn || product.title || '',
      title_ko: product.title || '',
      image_url: product.image || '',
      weight: parseFloat(product.weight) || 0,
      cost_price: parseInt(product.purchase) || 0,
      shipping_krw: parseInt(product.shippingKRW) || 0,
      fee_krw: parseInt(product.fee) || 0,
      tax_krw: parseInt(product.tax) || 0,
      total_cost: parseInt(product.totalCost) || 0,
      price_usd: parseFloat(product.priceUSD) || 0,
      shipping_usd: parseFloat(product.shippingUSD) || 0,
      profit_krw: parseInt(product.profit) || 0,
      margin_pct: parseFloat(product.margin) || 0,
      ebay_item_id: product.itemId || '',
      sales_count: parseInt(product.salesCount) || 0,
      stock: parseInt(product.stock) || 0,
      ebay_status: product.ebayStatus || '',
      shopify_status: product.shopifyStatus || '',
      supplier: product.supplier || '',
      status: product.status || 'active',
    };

    const { data, error } = await this.db
      .from('products')
      .upsert(row, { onConflict: 'sku' })
      .select();
    if (error) throw error;
    return data?.[0];
  }

  // ─── Upsert platform listing ───
  async upsertListing(listing) {
    const { error } = await this.db
      .from('platform_listings')
      .upsert(listing, { onConflict: 'platform,platform_item_id' });
    if (error) throw error;
  }

  // ─── Batch upsert for sync scripts ───
  async batchUpsertEbay(products) {
    if (!products.length) return;
    const rows = products.map(p => ({
      platform: 'ebay',
      platform_item_id: p.item_id || p.platform_item_id || '',
      platform_sku: p.sku || p.platform_sku || '',
      sku: p.sku || p.platform_sku || '',
      title: p.title || '',
      price: parseFloat(p.price_usd || p.price) || 0,
      currency: 'USD',
      shipping_cost: parseFloat(p.shipping_usd || p.shipping_cost) || 0,
      quantity: parseInt(p.stock || p.quantity) || 0,
      status: p.status || '',
      fee_rate: parseFloat(p.fee_rate) || 13,
      sales_count: parseInt(p.sales_count) || 0,
      image_url: p.image_url || '',
    }));
    const { error } = await this.db
      .from('platform_listings')
      .upsert(rows, { onConflict: 'platform,platform_item_id' });
    if (error) throw error;
  }

  async batchUpsertShopify(products) {
    if (!products.length) return;
    const rows = products.map(p => ({
      platform: 'shopify',
      platform_item_id: p.platform_item_id || p.sku || '',
      platform_sku: p.sku || '',
      sku: p.sku || '',
      title: p.title || '',
      price: parseFloat(p.price_usd || p.price) || 0,
      currency: 'USD',
      shipping_cost: 0,
      quantity: parseInt(p.stock || p.quantity) || 0,
      status: p.status || '',
      fee_rate: parseFloat(p.fee_rate) || 15,
      exchange_rate: parseFloat(p.exchange_rate) || 1400,
      purchase_price_krw: parseInt(p.purchase_price_krw) || 0,
      shipping_krw: parseInt(p.shipping_krw) || 0,
      profit_krw: parseInt(p.profit_krw) || 0,
      margin_pct: parseFloat(p.margin_pct) || 0,
    }));
    const { error } = await this.db
      .from('platform_listings')
      .upsert(rows, { onConflict: 'platform,platform_item_id' });
    if (error) throw error;
  }

  async batchUpsertNaver(products) {
    if (!products.length) return;
    const rows = products.map(p => ({
      platform: 'naver',
      platform_item_id: p.product_no || p.platform_item_id || '',
      platform_sku: p.sku || '',
      sku: p.sku || '',
      title: p.title || '',
      price: parseInt(p.price_krw || p.price) || 0,
      currency: 'KRW',
      quantity: parseInt(p.stock || p.quantity) || 0,
      status: p.status || '',
      fee_rate: parseFloat(p.fee_rate) || 5.5,
      image_url: p.image_url || '',
    }));
    const { error } = await this.db
      .from('platform_listings')
      .upsert(rows, { onConflict: 'platform,platform_item_id' });
    if (error) throw error;
  }

  async batchUpsertMaster(products) {
    if (!products.length) return;
    const rows = products.map(p => ({
      sku: p.sku,
      title: p.title || '',
      title_ko: p.title_ko || p.title || '',
      image_url: p.image_url || '',
      weight: parseFloat(p.weight_kg || p.weight) || 0,
      cost_price: parseInt(p.purchase_price || p.cost_price) || 0,
      shipping_krw: parseInt(p.shipping_krw) || 0,
      fee_krw: parseInt(p.fee_krw) || 0,
      tax_krw: parseInt(p.tax_krw) || 0,
      total_cost: parseInt(p.total_cost) || 0,
      price_usd: parseFloat(p.price_usd) || 0,
      shipping_usd: parseFloat(p.shipping_usd) || 0,
      profit_krw: parseInt(p.profit_krw) || 0,
      margin_pct: parseFloat(p.margin_pct) || 0,
      ebay_item_id: p.ebay_item_id || '',
      sales_count: parseInt(p.sales_count) || 0,
      stock: parseInt(p.stock) || 0,
      ebay_status: p.ebay_status || '',
      shopify_status: p.shopify_status || '',
      supplier: p.supplier || '',
      status: p.status || 'active',
    }));

    // Upsert on SKU — use partial unique index
    const { error } = await this.db
      .from('products')
      .upsert(rows, { onConflict: 'sku' });
    if (error) throw error;
  }

  // ─── Lookup product_id by SKU (for platform_listings FK) ───
  async getProductIdBySku(sku) {
    const { data, error } = await this.db
      .from('products')
      .select('id')
      .eq('sku', sku)
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data?.id || null;
  }

  async getSkuToIdMap() {
    const { data, error } = await this.db
      .from('products')
      .select('id, sku')
      .not('sku', 'is', null)
      .neq('sku', '');
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { map[r.sku] = r.id; });
    return map;
  }

  // ─── Products with platform export statuses (for new platform system) ───
  async getProductsWithExportStatus() {
    const { data, error } = await this.db
      .from('products')
      .select(`
        *,
        platform_export_status (
          platform_id,
          export_status,
          platform_item_id,
          exported_price,
          exported_at,
          last_error,
          platforms ( key, name, display_name, color )
        )
      `)
      .not('sku', 'is', null)
      .neq('sku', '')
      .order('sku');
    if (error) throw error;
    return data || [];
  }

  async getProductWithExportStatus(sku) {
    const { data, error } = await this.db
      .from('products')
      .select(`
        *,
        platform_export_status (
          platform_id,
          export_status,
          platform_item_id,
          exported_price,
          exported_at,
          last_error,
          platforms ( key, name, display_name, color )
        )
      `)
      .eq('sku', sku)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  // ─── Count helpers ───
  async countProducts() {
    const { count, error } = await this.db
      .from('products')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  }

  async countListings(platform) {
    let query = this.db
      .from('platform_listings')
      .select('*', { count: 'exact', head: true });
    if (platform) query = query.eq('platform', platform);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  async countByTable(table) {
    const { count, error } = await this.db
      .from(table)
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  }
}

module.exports = ProductRepository;
