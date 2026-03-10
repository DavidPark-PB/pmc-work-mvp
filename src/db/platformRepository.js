/**
 * Platform Repository — DB access for platforms, platform_mapping,
 * platform_export_status, margin_settings, competitor_prices, repricing_rules
 */
const { getClient } = require('./supabaseClient');

class PlatformRepository {
  constructor() {
    this.db = getClient();
  }

  // ===== platforms =====

  async getAllPlatforms() {
    const { data, error } = await this.db
      .from('platforms').select('*').order('sort_order');
    if (error) throw error;
    return data || [];
  }

  async getActivePlatforms() {
    const { data, error } = await this.db
      .from('platforms').select('*')
      .eq('is_active', true).order('sort_order');
    if (error) throw error;
    return data || [];
  }

  async getPlatformByKey(key) {
    const { data, error } = await this.db
      .from('platforms').select('*').eq('key', key).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async updatePlatform(id, updates) {
    const { data, error } = await this.db
      .from('platforms').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  // ===== margin_settings =====

  async getAllSettings() {
    const { data, error } = await this.db
      .from('margin_settings').select('*');
    if (error) throw error;
    const map = {};
    (data || []).forEach(s => { map[s.setting_key] = parseFloat(s.setting_value); });
    return map;
  }

  async getSettingsByCategory(category) {
    const { data, error } = await this.db
      .from('margin_settings').select('*').eq('category', category);
    if (error) throw error;
    const map = {};
    (data || []).forEach(s => { map[s.setting_key] = parseFloat(s.setting_value); });
    return map;
  }

  async updateSetting(key, value) {
    const { error } = await this.db
      .from('margin_settings').update({ setting_value: value, updated_at: new Date().toISOString() })
      .eq('setting_key', key);
    if (error) throw error;
  }

  // ===== platform_mapping =====

  async getMappingsForProduct(productId) {
    const { data, error } = await this.db
      .from('platform_mapping').select('*, platforms(key, name, color)')
      .eq('product_id', productId);
    if (error) throw error;
    return data || [];
  }

  async getMappingForProductPlatform(productId, platformId) {
    const { data, error } = await this.db
      .from('platform_mapping').select('*')
      .eq('product_id', productId).eq('platform_id', platformId).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async upsertMapping(productId, platformId, updates) {
    const { data, error } = await this.db
      .from('platform_mapping').upsert({
        product_id: productId,
        platform_id: platformId,
        ...updates,
      }, { onConflict: 'product_id,platform_id' }).select().single();
    if (error) throw error;
    return data;
  }

  // ===== platform_export_status =====

  async getExportStatus(productId, platformId) {
    const { data, error } = await this.db
      .from('platform_export_status').select('*, platforms(key, name)')
      .eq('product_id', productId).eq('platform_id', platformId).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async getAllExportStatuses(productId) {
    const { data, error } = await this.db
      .from('platform_export_status').select('*, platforms(key, name, color)')
      .eq('product_id', productId);
    if (error) throw error;
    return data || [];
  }

  async upsertExportStatus(productId, platformId, updates) {
    const { data, error } = await this.db
      .from('platform_export_status').upsert({
        product_id: productId,
        platform_id: platformId,
        ...updates,
      }, { onConflict: 'product_id,platform_id' }).select().single();
    if (error) throw error;
    return data;
  }

  async getFailedExports(maxRetries = 3) {
    const { data, error } = await this.db
      .from('platform_export_status').select('*, platforms(key, name), products(sku, title)')
      .eq('export_status', 'failed')
      .lt('retry_count', maxRetries);
    if (error) throw error;
    return data || [];
  }

  async getPendingExports() {
    const { data, error } = await this.db
      .from('platform_export_status').select('*, platforms(key, name), products(sku, title)')
      .eq('export_status', 'pending');
    if (error) throw error;
    return data || [];
  }

  // ===== translations =====

  async getTranslation(productId, targetLang) {
    const { data, error } = await this.db
      .from('translations').select('*')
      .eq('product_id', productId).eq('target_lang', targetLang).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async upsertTranslation(productId, targetLang, translation) {
    const { data, error } = await this.db
      .from('translations').upsert({
        product_id: productId,
        target_lang: targetLang,
        ...translation,
      }, { onConflict: 'product_id,target_lang' }).select().single();
    if (error) throw error;
    return data;
  }

  async getProductTranslations(productId) {
    const { data, error } = await this.db
      .from('translations').select('*').eq('product_id', productId);
    if (error) throw error;
    return data || [];
  }

  // ===== product_images =====

  async getProductImages(productId, imageType) {
    let query = this.db.from('product_images').select('*')
      .eq('product_id', productId).order('sort_order');
    if (imageType) query = query.eq('image_type', imageType);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async addProductImage(productId, imageType, imageUrl, sortOrder = 0, metadata = {}) {
    const { data, error } = await this.db
      .from('product_images').insert({
        product_id: productId,
        image_type: imageType,
        image_url: imageUrl,
        sort_order: sortOrder,
        processing_status: 'done',
        metadata,
      }).select().single();
    if (error) throw error;
    return data;
  }

  async updateImageStatus(imageId, status) {
    const { error } = await this.db
      .from('product_images').update({ processing_status: status }).eq('id', imageId);
    if (error) throw error;
  }

  // ===== competitor_prices =====

  async addCompetitorPrice(sku, price, shipping = 0, competitorId = '', url = '') {
    const { data, error } = await this.db
      .from('competitor_prices').insert({
        sku, competitor_price: price, competitor_shipping: shipping,
        competitor_id: competitorId, competitor_url: url,
      }).select().single();
    if (error) throw error;
    return data;
  }

  async getCompetitorPrices(sku, limit = 20) {
    const { data, error } = await this.db
      .from('competitor_prices').select('*')
      .eq('sku', sku).order('tracked_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  async getLatestCompetitorPrice(sku) {
    const { data, error } = await this.db
      .from('competitor_prices').select('*')
      .eq('sku', sku).order('tracked_at', { ascending: false }).limit(1).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  // ===== repricing_rules =====

  async getRepricingRules(sku) {
    const { data, error } = await this.db
      .from('repricing_rules').select('*')
      .eq('is_active', true)
      .or(`sku.eq.${sku},sku.is.null`);
    if (error) throw error;
    return data || [];
  }

  async getAllRepricingRules() {
    const { data, error } = await this.db
      .from('repricing_rules').select('*').order('created_at');
    if (error) throw error;
    return data || [];
  }

  async createRepricingRule(rule) {
    const { data, error } = await this.db
      .from('repricing_rules').insert(rule).select().single();
    if (error) throw error;
    return data;
  }

  // ===== price_change_log =====

  async logPriceChange(sku, platform, oldPrice, newPrice, reason, competitorPrice = null) {
    const { error } = await this.db
      .from('price_change_log').insert({
        sku, platform, old_price: oldPrice, new_price: newPrice,
        reason, competitor_price: competitorPrice,
      });
    if (error) throw error;
  }

  async getPriceChangeLog(sku, limit = 50) {
    const { data, error } = await this.db
      .from('price_change_log').select('*')
      .eq('sku', sku).order('changed_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }
}

module.exports = PlatformRepository;
