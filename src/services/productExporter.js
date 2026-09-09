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
const schedulerLock = require('./schedulerLock');
const { getClient } = require('../db/supabaseClient');

//   PMC-EXPORT-SAFETY-2C · per-(SKU, platform) distributed lease.
//     TTL: 180s covers the worst observed adapter runtime — Shopify _request
//     retries up to 4× (shopifyAPI.js:36) at 30s timeout with 1+2+4+8s backoff
//     ≈ 135s. eBay Trading callTradingAPI is 30s + optional 30s token-refresh
//     retry = 60s. Naver/Qoo10/Alibaba adapters are 10–15s. Heartbeat every
//     30s renews the TTL during long adapter calls; if the process dies the
//     lease frees within 180s so a legitimate retry can proceed.
const LEASE_TTL_SEC       = 180;
const LEASE_HEARTBEAT_SEC = 30;

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

  //   Deterministic per-(SKU, platform) lease key. Same SKU + platform →
  //   same key across processes and Railway instances. platformKey is
  //   lower-cased for defensive normalization; SKU is trimmed. No random,
  //   no request-specific component (§7).
  _buildExportLeaseKey(sku, platformKey) {
    const safeSku  = String(sku ?? '').trim();
    const safePlat = String(platformKey ?? '').trim().toLowerCase();
    return `export:${safePlat}:${safeSku}`;
  }

  async _exportToSinglePlatform(product, platformKey, prices, platRepo, options) {
    //   Pre-lease guards · avoid burning a lease on a doomed operation.
    const platform = await platformRegistry.getPlatform(platformKey);
    if (!platform) return { success: false, error: 'Platform not found or inactive' };

    if (prices[platformKey]?.error) {
      return { success: false, error: prices[platformKey].error };
    }

    //   PMC-EXPORT-SAFETY-2C · per-(SKU, platform) distributed lease.
    //   ONE concurrent execution reaches api.createProduct across (a) the
    //   same Node process (event-loop interleaving), (b) concurrent requests,
    //   and (c) multiple Railway instances. Fail-closed: if lease infra
    //   itself errors, the caller does not proceed.
    //
    //   NON-GOAL: This lease does NOT make export idempotent. A sequential
    //   retry after the lease is released can still duplicate. Ambiguous
    //   marketplace timeouts (marketplace committed but response lost) are
    //   deferred to EXPORT-SAFETY-2D (UNKNOWN state + retry exclusion).
    const leaseKey = this._buildExportLeaseKey(product.sku, platformKey);
    const leaseResult = await schedulerLock.withLease(
      leaseKey,
      { ttlSec: LEASE_TTL_SEC, heartbeatSec: LEASE_HEARTBEAT_SEC, failPolicy: 'closed' },
      async (ctx) => this._executeUnderLease(product, platform, platformKey, prices, platRepo, ctx),
    );

    if (!leaseResult.acquired) {
      //   Two distinct fail-closed reasons collapse into caller-facing codes:
      //     · SKIP_LOCKED (acquired:false, ran:false, no error): another
      //       export owns the key right now → CONCURRENT_EXPORT_IN_PROGRESS.
      //     · ACQUIRE_ERROR under failPolicy:'closed' (acquired:false,
      //       ran:false, error present): lease infrastructure itself failed
      //       → LEASE_INFRA_FAILURE. Neither wrote platform_export_status;
      //       neither called createProduct.
      if (leaseResult.error) {
        return {
          success: false,
          code:  'LEASE_INFRA_FAILURE',
          error: 'LEASE_INFRA_FAILURE',
        };
      }
      return {
        success: false,
        code:  'CONCURRENT_EXPORT_IN_PROGRESS',
        error: 'CONCURRENT_EXPORT_IN_PROGRESS',
      };
    }
    return leaseResult.value;
  }

  async _executeUnderLease(product, platform, platformKey, prices, platRepo, ctx) {
    //   Mark as exporting — inside the lease, so a losing concurrent caller
    //   cannot see or overwrite this transitional state.
    await platRepo.upsertExportStatus(product.id, platform.id, {
      export_status: 'exporting',
    });

    //   PMC-EXPORT-SAFETY-2D · outcome classification fence.
    //     Track whether we crossed the marketplace-call boundary. A throw
    //     while `false` = pre-send local failure = confirmed_failure (safe
    //     to auto-retry). A throw while `true` = we don't know whether the
    //     marketplace committed = unknown_may_have_created (NEVER auto-retry).
    //     Do NOT parse err.message strings to downgrade UNKNOWN — adapters
    //     drop HTTP status / err.code, so message text is not truth.
    let marketplaceCallStarted = false;

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

      // Load API + refresh token if needed
      const api = platformRegistry.getApiInstance(platformKey);
      if (platformKey === 'naver' && typeof api.getToken === 'function') {
        await api.getToken();
      }

      //   Ownership fence: fresh DB round-trip immediately before the
      //   marketplace write. verifyOwnership() returns true only if this
      //   run still holds the lease; throws on RPC infra failure — treat
      //   any non-true outcome as ownership-lost (fail-closed §10).
      let stillOwned = false;
      try {
        stillOwned = await ctx.verifyOwnership();
      } catch (_verifyErr) {
        stillOwned = false;
      }
      if (!stillOwned) {
        //   Do NOT call createProduct. Do NOT classify as marketplace failure.
        //   Revert the transitional 'exporting' state to 'pending' with a
        //   distinct last_error tag. 2D: this outcome carries NO outcome_class
        //   — it is a lease-state signal, not a marketplace evidence signal.
        await platRepo.upsertExportStatus(product.id, platform.id, {
          export_status: 'pending',
          last_error:    'LEASE_LOST_BEFORE_MARKETPLACE_WRITE',
        });
        return {
          success: false,
          code:  'LEASE_LOST_BEFORE_MARKETPLACE_WRITE',
          error: 'LEASE_LOST_BEFORE_MARKETPLACE_WRITE',
        };
      }

      //   PMC-EXPORT-SAFETY-2D · Cross the boundary. Any throw from here on
      //   means the marketplace call was attempted; PMC cannot know the
      //   remote outcome from a thrown local error.
      marketplaceCallStarted = true;
      const apiResult = await api.createProduct(optimizedData);

      //   PMC-EXPORT-SAFETY-2D · Strict success contract.
      //     CONFIRMED_SUCCESS requires BOTH:
      //       (a) explicit positive signal: apiResult.success === true
      //       (b) durable marketplace identifier — non-empty
      //     eBay uses `.itemId`, Shopify `.productId`, Naver `.originProductNo`.
      //     Qoo10 returns raw QSM JSON with neither `.success` nor a normalized
      //     durable ID; that case naturally falls to UNKNOWN below.
      //     Any missing signal ⇒ UNKNOWN (not success). No message-string
      //     parsing. No inference from Promise resolution alone.
      const durableId =
        (apiResult && (apiResult.itemId ?? apiResult.productId ?? apiResult.originProductNo)) ?? null;
      const isConfirmedSuccess =
        apiResult
        && apiResult.success === true
        && durableId != null
        && String(durableId).length > 0;

      if (isConfirmedSuccess) {
        await platRepo.upsertExportStatus(product.id, platform.id, {
          export_status:   'success',
          outcome_class:   'confirmed_success',
          platform_item_id: String(durableId),
          exported_price:   prices[platformKey]?.price || 0,
          exported_at:      new Date().toISOString(),
          last_error:       '',
        });
        return {
          success:  true,
          itemId:   durableId,
          price:    prices[platformKey]?.price,
          currency: prices[platformKey]?.currency,
        };
      }

      //   Adapter returned but the outcome is not confirmably success:
      //   either apiResult.success !== true (adapter reported failure or
      //   omitted the signal — Qoo10) OR the durable ID is missing (eBay
      //   Ack=Success without <ItemID>, Shopify variant missing id, etc.).
      //   The marketplace MAY have committed the listing. Under 2D fail-
      //   closed principle we quarantine this row: never auto-retry.
      //   platform_item_id is left blank (do NOT write literal "null").
      await platRepo.upsertExportStatus(product.id, platform.id, {
        export_status: 'failed',
        outcome_class: 'unknown_may_have_created',
        last_error:    'MARKETPLACE_RESULT_UNCONFIRMED',
        exported_at:   new Date().toISOString(),
      });
      return {
        success: false,
        code:    'MARKETPLACE_RESULT_UNCONFIRMED',
        error:   (apiResult && apiResult.error) || 'MARKETPLACE_RESULT_UNCONFIRMED',
      };
    } catch (err) {
      //   PMC-EXPORT-SAFETY-2D · Thrown-error classification.
      //     BEFORE createProduct was reached  → confirmed_failure (auto-retry OK)
      //     AFTER createProduct was reached   → unknown_may_have_created (never
      //     auto-retry — the marketplace may have committed and returned an
      //     error we cannot verify)
      const outcomeClass = marketplaceCallStarted
        ? 'unknown_may_have_created'
        : 'confirmed_failure';
      await platRepo.upsertExportStatus(product.id, platform.id, {
        export_status: 'failed',
        outcome_class: outcomeClass,
        last_error:    err.message,
        exported_at:   new Date().toISOString(),
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
