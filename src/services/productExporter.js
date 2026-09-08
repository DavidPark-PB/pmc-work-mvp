/**
 * Product Exporter — Orchestrates exporting products to platforms.
 * Replaces the hardcoded if/else blocks in api.js for eBay/Shopify/Naver registration.
 *
 * Flow:
 * 1. Load product from Supabase
 * 2. Load platform config from platformRegistry (DB-driven)
 * 3. Load/auto-generate translations
 * 4. Calculate prices using DB-driven fees and exchange rates
 * 5. Optimize data for each platform using platformOptimizer
 * 6. Call platform API
 * 7. Record export status in platform_export_status
 */
const platformRegistry = require('./platformRegistry');
const pricingEngine = require('./pricingEngine');
const platformOptimizer = require('./platformOptimizer');
const TranslationService = require('./translationService');
const { getClient } = require('../db/supabaseClient');

class ProductExporter {
  constructor() {
    this.translationService = new TranslationService();
  }

  _getPlatformRepo() {
    const PlatformRepository = require('../db/platformRepository');
    return new PlatformRepository();
  }

  /**
   * Export a product to multiple platforms.
   *
   * PMC-EXPORT-SAFETY-2B (2026-09-08) · dry-run is the default.
   *   The caller must explicitly pass `options.dryRun === false` to reach the
   *   real marketplace `createProduct` path. Any other value — undefined,
   *   `true`, `null`, `0`, `"false"` — resolves to dry-run. This is a
   *   fail-closed default so future internal callers cannot accidentally
   *   trigger a real marketplace write by forgetting the options argument.
   *
   *   Dry-run computes: product lookup, fees/rates/settings lookup, cached
   *   translation lookup (auto-translate is skipped — it writes DB), price
   *   calculation, optimizer output. It stops BEFORE:
   *     - platRepo.upsertExportStatus(...)   (DB write)
   *     - api.createProduct(...)              (marketplace write)
   *     - translationService.translateProduct (DB write via upsertTranslation)
   *
   * @param {string}   sku                  Product SKU
   * @param {string[]} targetPlatformKeys   e.g. ['ebay', 'shopify', 'naver']
   * @param {object}   options              { dryRun?, skipTranslation?, skipImages? }
   */
  async exportProduct(sku, targetPlatformKeys, options = {}) {
    //   Fail-closed: only strict boolean `false` enables execution.
    const dryRun = options.dryRun !== false;
    const db = getClient();
    const platRepo = this._getPlatformRepo();

    // 1. Load product
    const { data: product, error } = await db
      .from('products').select('*').eq('sku', sku).single();
    if (error || !product) throw new Error(`Product not found: ${sku}`);

    // 2. Load platform fees and exchange rates from DB
    const fees = await platformRegistry.getFeeRates();
    const rates = await platformRegistry.getExchangeRates();
    const settings = await platformRegistry.getMarginSettings();

    // 3. Auto-translate if needed (for global platforms)
    let translation = null;
    if (!options.skipTranslation) {
      try {
        translation = await this.translationService.getTranslation(product.id, 'en');
        //   Auto-translation writes to DB via translationService.upsertTranslation,
        //   so it is EXECUTE-only. Dry-run uses whatever cached translation
        //   already exists and surfaces the absence as a warning downstream.
        if (!dryRun && !translation && (product.title_ko || product.title)) {
          translation = await this.translationService.translateProduct(product.id, 'en');
        }
      } catch (err) {
        console.error('Translation error (non-fatal):', err.message);
      }
    }

    // 4. Build product data with translations applied
    const enrichedProduct = this._enrichProduct(product, translation);

    // 5. Calculate prices
    const prices = pricingEngine.calculatePrices({
      purchasePrice: product.purchase_price || product.cost_price || 0,
      weight: product.weight || 0,
      targetMargin: product.target_margin || settings.default_margin_pct || 30,
      shippingUSD: settings.default_shipping_usd || 3.9,
    }, fees, rates);

    // 6. Export (or preview) each platform
    const results = {};
    for (const key of targetPlatformKeys) {
      if (dryRun) {
        results[key] = await this._previewSinglePlatform(
          enrichedProduct, key, prices, platRepo, { translationLoaded: !!translation }
        );
      } else {
        results[key] = await this._exportToSinglePlatform(
          enrichedProduct, key, prices, platRepo, options
        );
      }
    }

    return { sku, results, prices, dryRun };
  }

  //   Read-only per-platform preview. Must NOT invoke platform API and must
  //   NOT write platform_export_status. See PMC-EXPORT-SAFETY-2B §6/§7.
  async _previewSinglePlatform(product, platformKey, prices, platRepo, ctx = {}) {
    const platform = await platformRegistry.getPlatform(platformKey);
    if (!platform) {
      return {
        platform: platformKey,
        supported: false,
        would_execute: false,
        warnings: [],
        blockers: ['Platform not found or inactive'],
      };
    }

    const warnings = [];
    const blockers = [];

    if (prices[platformKey]?.error) {
      blockers.push(prices[platformKey].error);
    }
    if (!ctx.translationLoaded) {
      warnings.push('영어 번역이 캐시에 없습니다. 실행 시 자동 번역이 발생합니다.');
    }

    //   Read-only lookup of any custom platform_mapping row (title/description/
    //   price override). getMappingForProductPlatform is a SELECT.
    const mapping = await platRepo.getMappingForProductPlatform(product.id, platform.id);
    const productForPlatform = { ...product };
    let effectivePrices = prices;
    if (mapping) {
      if (mapping.platform_title) productForPlatform.titleEn = mapping.platform_title;
      if (mapping.platform_description) productForPlatform.descriptionEn = mapping.platform_description;
      if (mapping.platform_price) {
        effectivePrices = {
          ...prices,
          [platformKey]: { ...prices[platformKey], price: parseFloat(mapping.platform_price) },
        };
      }
    }

    return {
      platform: platformKey,
      supported: true,
      would_execute: false,
      computed_price: effectivePrices[platformKey]?.price ?? null,
      currency: effectivePrices[platformKey]?.currency ?? null,
      computed_quantity: product.quantity ?? null,
      title: productForPlatform.titleEn || productForPlatform.title || '',
      category_id: mapping?.platform_category_id ?? null,
      warnings,
      blockers,
    };
  }

  async _exportToSinglePlatform(product, platformKey, prices, platRepo, options) {
    const platform = await platformRegistry.getPlatform(platformKey);
    if (!platform) return { success: false, error: 'Platform not found or inactive' };

    if (prices[platformKey]?.error) {
      return { success: false, error: prices[platformKey].error };
    }

    // Mark as exporting
    await platRepo.upsertExportStatus(product.id, platform.id, {
      export_status: 'exporting',
    });

    try {
      // Load platform_mapping for custom overrides
      const mapping = await platRepo.getMappingForProductPlatform(product.id, platform.id);

      // Apply mapping overrides
      const productForPlatform = { ...product };
      if (mapping) {
        if (mapping.platform_title) productForPlatform.titleEn = mapping.platform_title;
        if (mapping.platform_description) productForPlatform.descriptionEn = mapping.platform_description;
        if (mapping.platform_price) prices[platformKey] = { ...prices[platformKey], price: parseFloat(mapping.platform_price) };
      }

      // Optimize data for platform
      const platformConfig = platform.config || {};
      const optimizedData = platformOptimizer.optimize(platformKey, productForPlatform, prices, {
        categoryId: mapping?.platform_category_id,
        customFields: mapping?.custom_fields,
        platformConfig,
      });

      if (!optimizedData) {
        throw new Error('Platform optimizer returned null');
      }

      // Call platform API
      const api = platformRegistry.getApiInstance(platformKey);
      if (platformKey === 'naver' && typeof api.getToken === 'function') {
        await api.getToken();
      }

      const apiResult = await api.createProduct(optimizedData);
      const itemId = apiResult.itemId || apiResult.productId || apiResult.originProductNo || '';

      // Record success
      await platRepo.upsertExportStatus(product.id, platform.id, {
        export_status: 'success',
        platform_item_id: String(itemId),
        exported_price: prices[platformKey]?.price || 0,
        exported_at: new Date().toISOString(),
        last_error: '',
      });

      return {
        success: true,
        itemId,
        price: prices[platformKey]?.price,
        currency: prices[platformKey]?.currency,
      };
    } catch (err) {
      // Record failure
      await platRepo.upsertExportStatus(product.id, platform.id, {
        export_status: 'failed',
        last_error: err.message,
        exported_at: new Date().toISOString(),
      });

      return { success: false, error: err.message };
    }
  }

  /**
   * Enrich product with translation data
   */
  _enrichProduct(product, translation) {
    const enriched = { ...product };

    if (translation) {
      enriched.titleEn = translation.title || product.title || '';
      enriched.descriptionEn = translation.description || product.description || '';
      enriched.keywordsEn = translation.keywords || product.keywords || [];
    } else {
      enriched.titleEn = product.title || product.title_ko || '';
      enriched.descriptionEn = product.description || product.description_ko || '';
      enriched.keywordsEn = product.keywords || [];
    }

    // Map Supabase column names to existing platformOptimizer field names
    enriched.title = enriched.titleEn;
    enriched.description = enriched.descriptionEn;
    enriched.purchasePrice = product.purchase_price || product.cost_price || 0;
    enriched.targetMargin = product.target_margin || 30;
    enriched.imageUrls = product.image_urls || (product.image_url ? [product.image_url] : []);
    enriched.condition = product.condition || 'new';
    enriched.quantity = product.quantity || 1;

    return enriched;
  }

  /**
   * Retry all failed exports
   */
  async retryFailedExports() {
    const platRepo = this._getPlatformRepo();
    const failed = await platRepo.getFailedExports(3);
    const results = [];

    for (const record of failed) {
      const sku = record.products?.sku;
      const platformKey = record.platforms?.key;
      if (!sku || !platformKey) continue;

      // Increment retry count
      await platRepo.upsertExportStatus(record.product_id, record.platform_id, {
        retry_count: (record.retry_count || 0) + 1,
      });

      try {
        //   PMC-EXPORT-SAFETY-2B: retry historically executed writes. Preserve
        //   that behavior by opting out of the new fail-closed dry-run default.
        //   Full retry redesign (idempotency, ambiguous-timeout UNKNOWN state,
        //   per-sku body-driven retry) is deferred to EXPORT-SAFETY-2D.
        const result = await this.exportProduct(sku, [platformKey], { dryRun: false });
        results.push({ sku, platform: platformKey, ...result.results[platformKey] });
      } catch (err) {
        results.push({ sku, platform: platformKey, success: false, error: err.message });
      }
    }

    return results;
  }

  /**
   * Get export statuses for a product
   */
  async getExportStatusForProduct(productId) {
    const platRepo = this._getPlatformRepo();
    return await platRepo.getAllExportStatuses(productId);
  }
}

module.exports = ProductExporter;
