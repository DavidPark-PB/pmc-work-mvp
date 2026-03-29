/**
 * Profit Calculator — Wraps pricingEngine for agent-level analysis
 * Does NOT duplicate formulas; imports and extends pricingEngine.
 */
const { calculatePrices, calculateMargins } = require('../../services/pricingEngine');
const { getClient } = require('../../db/supabaseClient');

class ProfitCalculator {
  get db() { return getClient(); }

  /**
   * Load a single product from DB by SKU
   */
  async getProduct(sku) {
    const { data, error } = await this.db
      .from('products').select('*').eq('sku', sku).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  /**
   * Calculate net profit for a single SKU across all platforms
   * Returns { sku, purchasePrice, platforms: { ebay: { price, margin, profit }, ... } }
   */
  async calculateNetProfit(sku) {
    const product = await this.getProduct(sku);
    if (!product) return null;

    const purchasePrice = parseFloat(product.cost_price) || 0;
    if (purchasePrice <= 0) return { sku, purchasePrice: 0, platforms: {}, error: 'no_cost_price' };

    const prices = calculatePrices({
      purchasePrice,
      weight: parseFloat(product.weight) || 0,
      targetMargin: parseFloat(product.target_margin) || 30,
      shippingUSD: parseFloat(product.shipping_usd) || undefined,
    });

    return {
      sku,
      title: product.title_ko || product.title || '',
      purchasePrice,
      platforms: prices,
    };
  }

  /**
   * Calculate ROI (Return on Investment) for a SKU
   * ROI = profit / purchasePrice × 100
   */
  async calculateROI(sku) {
    const result = await this.calculateNetProfit(sku);
    if (!result || result.error) return result;

    const roi = {};
    for (const [platform, data] of Object.entries(result.platforms)) {
      if (data.error) continue;
      const profit = data.estimatedProfit || 0;
      roi[platform] = {
        ...data,
        roi: result.purchasePrice > 0
          ? +(profit / result.purchasePrice * 100).toFixed(1)
          : 0,
      };
    }
    return { sku: result.sku, title: result.title, purchasePrice: result.purchasePrice, platforms: roi };
  }

  /**
   * Batch calculate profit for multiple products
   * Input: array of product rows (from getDashboardProducts or similar)
   * Returns: array of { sku, title, purchasePrice, platforms, bestPlatform, worstPlatform }
   */
  batchCalculate(products) {
    return products.map(p => {
      const purchasePrice = parseFloat(p.purchase || p.cost_price) || 0;
      if (purchasePrice <= 0) {
        return { sku: p.sku, title: p.title || '', purchasePrice: 0, platforms: {}, error: 'no_cost_price' };
      }

      const prices = calculatePrices({
        purchasePrice,
        weight: parseFloat(p.weight) || 0,
        targetMargin: parseFloat(p.targetMargin || p.target_margin) || 30,
        shippingUSD: parseFloat(p.shippingUSD || p.shipping_usd) || undefined,
      });

      let bestPlatform = null;
      let worstPlatform = null;
      let bestMargin = -Infinity;
      let worstMargin = Infinity;

      for (const [platform, data] of Object.entries(prices)) {
        if (data.error) continue;
        const margin = data.margin || 0;
        if (margin > bestMargin) { bestMargin = margin; bestPlatform = platform; }
        if (margin < worstMargin) { worstMargin = margin; worstPlatform = platform; }
      }

      return {
        sku: p.sku,
        title: p.title || p.title_ko || '',
        purchasePrice,
        platforms: prices,
        bestPlatform,
        worstPlatform,
      };
    });
  }

  /**
   * Analyze margin for a product on a specific platform against a competitor
   */
  analyzeVsCompetitor(product, platform, competitorPrice, competitorShipping) {
    const purchasePrice = parseFloat(product.purchase || product.cost_price) || 0;
    return calculateMargins({
      purchasePrice,
      weight: parseFloat(product.weight) || 0,
      targetMargin: parseFloat(product.targetMargin || product.target_margin) || 30,
      competitorPrice: parseFloat(competitorPrice) || 0,
      competitorShipping: parseFloat(competitorShipping) || 0,
    });
  }
}

module.exports = { ProfitCalculator };
