/**
 * Platform Registry — Data-driven platform configuration loaded from DB.
 * Singleton with 5-minute cache. Replaces all hardcoded platform arrays.
 */
const CACHE_TTL = 300000; // 5 minutes

let _instance = null;

class PlatformRegistry {
  constructor() {
    this._platforms = null;
    this._settings = null;
    this._platformsLoadedAt = 0;
    this._settingsLoadedAt = 0;
  }

  _getRepo() {
    const PlatformRepository = require('../db/platformRepository');
    return new PlatformRepository();
  }

  async _ensurePlatformsLoaded() {
    if (this._platforms && Date.now() - this._platformsLoadedAt < CACHE_TTL) return;
    this._platforms = await this._getRepo().getActivePlatforms();
    this._platformsLoadedAt = Date.now();
  }

  async _ensureSettingsLoaded() {
    if (this._settings && Date.now() - this._settingsLoadedAt < CACHE_TTL) return;
    this._settings = await this._getRepo().getAllSettings();
    this._settingsLoadedAt = Date.now();
  }

  // ===== Platform queries =====

  async getActivePlatforms() {
    await this._ensurePlatformsLoaded();
    return this._platforms;
  }

  async getPlatform(key) {
    await this._ensurePlatformsLoaded();
    return this._platforms.find(p => p.key === key) || null;
  }

  async getDomesticPlatforms() {
    await this._ensurePlatformsLoaded();
    return this._platforms.filter(p => p.market_type === 'domestic');
  }

  async getGlobalPlatforms() {
    await this._ensurePlatformsLoaded();
    return this._platforms.filter(p => p.market_type === 'global');
  }

  /**
   * Returns fee rates keyed by platform key: {ebay: 0.18, shopify: 0.033, ...}
   */
  async getFeeRates() {
    await this._ensurePlatformsLoaded();
    const rates = {};
    this._platforms.forEach(p => { rates[p.key] = parseFloat(p.fee_rate); });
    return rates;
  }

  /**
   * Returns exchange rates from margin_settings:
   * {usd: 1400, jpy: 1000, local: 1000}
   */
  async getExchangeRates() {
    await this._ensureSettingsLoaded();
    return {
      usd: this._settings.exchange_rate_usd || 1400,
      jpy: this._settings.exchange_rate_jpy || 1000,
      local: this._settings.exchange_rate_local || 1000,
    };
  }

  /**
   * Returns all margin settings as a flat object
   */
  async getMarginSettings() {
    await this._ensureSettingsLoaded();
    return { ...this._settings };
  }

  /**
   * Returns a specific setting value
   */
  async getSetting(key, defaultValue = 0) {
    await this._ensureSettingsLoaded();
    return this._settings[key] !== undefined ? this._settings[key] : defaultValue;
  }

  /**
   * Returns platform status list for dashboard UI.
   * Replaces hardcoded array in api.js.
   */
  async getPlatformStatusList() {
    await this._ensurePlatformsLoaded();
    return this._platforms.map(p => ({
      name: p.name,
      key: p.key,
      displayName: p.display_name,
      color: p.color,
      apiModule: p.api_module,
      marketType: p.market_type,
      feeRate: parseFloat(p.fee_rate),
      currency: p.currency,
    }));
  }

  /**
   * Lazy-load a platform API instance by key.
   * Maps platform key to the API module file in src/api/.
   */
  getApiInstance(key) {
    const moduleMap = {
      ebay: () => { const E = require('../api/ebayAPI'); return new E(); },
      shopify: () => { const S = require('../api/shopifyAPI'); return new S(); },
      naver: () => { const N = require('../api/naverAPI'); return new N(); },
      qoo10: () => { const Q = require('../api/qoo10API'); return new Q(); },
      shopee: () => { const S = require('../api/shopeeAPI'); return new S(); },
      alibaba: () => { const A = require('../api/alibabaAPI'); return new A(); },
      coupang: () => { const C = require('../api/coupangAPI'); return new C(); },
    };
    const factory = moduleMap[key];
    if (!factory) throw new Error(`Unknown platform API: ${key}`);
    return factory();
  }

  /**
   * Update a margin setting value in DB and invalidate cache.
   */
  async updateSetting(key, value) {
    await this._getRepo().updateSetting(key, value);
    this._settings = null; // invalidate
  }

  invalidateCache() {
    this._platforms = null;
    this._settings = null;
  }
}

// Singleton
function getInstance() {
  if (!_instance) _instance = new PlatformRegistry();
  return _instance;
}

module.exports = getInstance();
module.exports.PlatformRegistry = PlatformRegistry;
