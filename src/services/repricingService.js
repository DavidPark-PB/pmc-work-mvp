/**
 * Repricing Service — eBay Combat Repricing System
 * Tracks competitor prices, applies repricing rules,
 * and auto-adjusts prices while protecting minimum margins.
 */
const platformRegistry = require('./platformRegistry');
const pricingEngine = require('./pricingEngine');
const { getClient } = require('../db/supabaseClient');

class RepricingService {
  _getPlatformRepo() {
    const PlatformRepository = require('../db/platformRepository');
    return new PlatformRepository();
  }

  /**
   * Record a competitor price observation
   */
  async trackCompetitorPrice(sku, price, shipping = 0, competitorId = '', url = '') {
    const repo = this._getPlatformRepo();
    return await repo.addCompetitorPrice(sku, price, shipping, competitorId, url);
  }

  /**
   * Evaluate repricing for a SKU based on rules and competitor data
   * Returns recommended price or null if no change needed
   */
  async evaluateRepricing(sku, platform = 'ebay') {
    const repo = this._getPlatformRepo();
    const db = getClient();

    // Load current product
    const { data: product } = await db
      .from('products').select('*').eq('sku', sku).single();
    if (!product) return null;

    // Load latest competitor price
    const competitor = await repo.getLatestCompetitorPrice(sku);
    if (!competitor) return { action: 'no_competitor_data', currentPrice: product.price_usd };

    // Load applicable repricing rules (SKU-specific first, then global)
    const rules = await repo.getRepricingRules(sku);
    if (rules.length === 0) return { action: 'no_rules', currentPrice: product.price_usd };

    // SKU-specific rule takes priority over global
    const rule = rules.find(r => r.sku === sku) || rules.find(r => !r.sku) || rules[0];

    const currentPrice = parseFloat(product.price_usd) || 0;
    const compTotal = parseFloat(competitor.competitor_price) + parseFloat(competitor.competitor_shipping || 0);

    // Calculate minimum allowed price based on margin floor
    const fees = await platformRegistry.getFeeRates();
    const rates = await platformRegistry.getExchangeRates();
    const purchasePrice = parseFloat(product.purchase_price || product.cost_price || 0);
    const weight = parseFloat(product.weight || 0);
    const shippingKRW = pricingEngine.estimateShippingKRW(weight);
    const tax = Math.round(purchasePrice * 0.15);
    const totalCostKRW = purchasePrice + shippingKRW + tax;

    const feeRate = fees[platform] || 0.18;
    const exchangeRate = rates.usd || 1400;
    const minMargin = parseFloat(rule.min_margin_pct) / 100 || 0.10;
    const minDivisor = 1 - feeRate - minMargin;
    const minPriceFromMargin = minDivisor > 0
      ? (totalCostKRW / minDivisor / exchangeRate - 3.9)
      : currentPrice;

    // Apply rule min/max price
    const ruleMinPrice = rule.min_price ? parseFloat(rule.min_price) : minPriceFromMargin;
    const ruleMaxPrice = rule.max_price ? parseFloat(rule.max_price) : Infinity;
    const floorPrice = Math.max(ruleMinPrice, minPriceFromMargin);

    // Calculate recommended price based on strategy
    let recommendedPrice;
    const undercut = parseFloat(rule.undercut_amount) || 0.01;

    switch (rule.strategy) {
      case 'undercut':
        recommendedPrice = compTotal - undercut;
        break;
      case 'match':
        recommendedPrice = compTotal;
        break;
      case 'margin_floor':
        recommendedPrice = floorPrice;
        break;
      default:
        recommendedPrice = compTotal - undercut;
    }

    // Apply floor and ceiling
    recommendedPrice = Math.max(recommendedPrice, floorPrice);
    recommendedPrice = Math.min(recommendedPrice, ruleMaxPrice);

    // Psychological pricing (x.99)
    recommendedPrice = Math.ceil(recommendedPrice) - 0.01;

    // Determine action
    const priceDiff = Math.abs(recommendedPrice - currentPrice);
    if (priceDiff < 0.02) {
      return {
        action: 'no_change',
        currentPrice,
        recommendedPrice,
        competitorTotal: compTotal,
        floorPrice,
      };
    }

    return {
      action: recommendedPrice < currentPrice ? 'decrease' : 'increase',
      currentPrice,
      recommendedPrice,
      competitorTotal: compTotal,
      floorPrice,
      strategy: rule.strategy,
      rule: { id: rule.id, sku: rule.sku, strategy: rule.strategy },
    };
  }

  /**
   * Execute repricing: evaluate + update price via platform API + log
   */
  async executeRepricing(sku, platform = 'ebay') {
    const evaluation = await this.evaluateRepricing(sku, platform);
    if (!evaluation || evaluation.action === 'no_change' ||
        evaluation.action === 'no_competitor_data' || evaluation.action === 'no_rules') {
      return { sku, ...evaluation, executed: false };
    }

    const repo = this._getPlatformRepo();
    const db = getClient();

    try {
      // Update price via platform API
      const api = platformRegistry.getApiInstance(platform);

      // Get platform item ID from export status
      const platformObj = await platformRegistry.getPlatform(platform);
      const { data: product } = await db.from('products').select('id').eq('sku', sku).single();
      if (!product || !platformObj) throw new Error('Product or platform not found');

      const exportStatus = await repo.getExportStatus(product.id, platformObj.id);
      const itemId = exportStatus?.platform_item_id;
      if (!itemId) throw new Error('No platform item ID found — product not yet exported');

      // Call API to update price
      if (platform === 'ebay') {
        await api.updatePrice(itemId, evaluation.recommendedPrice);
      }

      // Update product price in DB
      await db.from('products').update({ price_usd: evaluation.recommendedPrice })
        .eq('sku', sku);

      // Log price change
      await repo.logPriceChange(
        sku, platform,
        evaluation.currentPrice, evaluation.recommendedPrice,
        `${evaluation.strategy}_${evaluation.action}`,
        evaluation.competitorTotal
      );

      return {
        sku,
        ...evaluation,
        executed: true,
        newPrice: evaluation.recommendedPrice,
      };
    } catch (err) {
      return {
        sku,
        ...evaluation,
        executed: false,
        error: err.message,
      };
    }
  }

  /**
   * Get battle dashboard data: all SKUs with competitor tracking
   */
  async getBattleDashboard() {
    const db = getClient();

    // Get products with their latest competitor prices
    const { data: products } = await db
      .from('products')
      .select('sku, title, price_usd, purchase_price, cost_price, weight')
      .not('price_usd', 'is', null)
      .order('sku');

    if (!products || products.length === 0) return [];

    const repo = this._getPlatformRepo();
    const dashboard = [];

    for (const p of products.slice(0, 100)) { // Limit for performance
      const competitor = await repo.getLatestCompetitorPrice(p.sku);
      const recentChanges = await repo.getPriceChangeLog(p.sku, 5);

      dashboard.push({
        sku: p.sku,
        title: p.title,
        myPrice: parseFloat(p.price_usd) || 0,
        competitorPrice: competitor ? parseFloat(competitor.competitor_price) : null,
        competitorShipping: competitor ? parseFloat(competitor.competitor_shipping) : null,
        competitorTotal: competitor
          ? parseFloat(competitor.competitor_price) + parseFloat(competitor.competitor_shipping || 0)
          : null,
        lastTracked: competitor?.tracked_at || null,
        recentChanges: recentChanges.map(c => ({
          oldPrice: parseFloat(c.old_price),
          newPrice: parseFloat(c.new_price),
          reason: c.reason,
          changedAt: c.changed_at,
        })),
      });
    }

    return dashboard;
  }
}

module.exports = RepricingService;
