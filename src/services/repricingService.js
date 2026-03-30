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
   * Get battle dashboard data: fetch real eBay listings from API, compare with competitor prices
   */
  async getBattleDashboard() {
    const db = getClient();

    // Fetch active eBay listings from eBay API (page 1, up to 200 items)
    const EbayAPI = require('../api/ebayAPI');
    const ebayApi = new EbayAPI();
    let ebayItems = [];
    try {
      // Fetch all pages (up to 25 pages x 200 = 5000 items)
      const seenIds = new Set();
      for (let page = 1; page <= 25; page++) {
        const result = await ebayApi.getActiveListings(page, 200);
        if (!result.items || result.items.length === 0) break;
        let newCount = 0;
        for (const item of result.items) {
          const id = item.itemId || item.sku;
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            ebayItems.push(item);
            newCount++;
          }
        }
        if (newCount === 0) break; // No new items = we've seen them all
      }
      console.log('[BattleDashboard] Loaded', ebayItems.length, 'unique eBay listings');
    } catch (e) {
      console.error('[BattleDashboard] eBay API 오류:', e.message);
      return [];
    }

    if (ebayItems.length === 0) return [];

    // itemId를 식별자로, sku가 있으면 sku도 사용
    const normalizedListings = ebayItems.map(item => ({
      sku: item.sku || item.itemId || '',
      itemId: item.itemId || '',
      title: item.title || item.itemId || '',
      price: parseFloat(item.price) || 0,
      shipping: parseFloat(item.shippingCost) || 0,
      quantity: parseInt(item.quantity) || 0,
    })).filter(l => l.sku && l.price > 0);

    if (normalizedListings.length === 0) return [];

    // Batch-fetch all competitor prices by SKU and itemId (split into chunks of 500)
    const skus = normalizedListings.map(l => l.sku).filter(Boolean);
    const itemIds = normalizedListings.map(l => l.itemId).filter(Boolean);
    const allKeys = [...new Set([...skus, ...itemIds])];
    let compRows = [];
    for (let i = 0; i < allKeys.length; i += 500) {
      const chunk = allKeys.slice(i, i + 500);
      const { data } = await db
        .from('competitor_prices')
        .select('sku, competitor_id, competitor_price, competitor_shipping, competitor_url, seller_id, seller_feedback, tracked_at')
        .in('sku', chunk)
        .order('tracked_at', { ascending: false });
      if (data) compRows = compRows.concat(data);
    }

    // Fetch Korean product titles from products table
    const { data: productRows } = await db
      .from('products')
      .select('sku, title, title_ko')
      .in('sku', skus);

    // Fetch DB stock from ebay_products (more reliable than API quantity)
    const dbStockMap = {};
    for (let i = 0; i < allKeys.length; i += 500) {
      const chunk = allKeys.slice(i, i + 500);
      const { data: stockData } = await db.from('ebay_products').select('item_id, sku, stock').in('sku', chunk);
      (stockData || []).forEach(s => { dbStockMap[s.sku] = s.stock; dbStockMap[s.item_id] = s.stock; });
    }
    const productTitleMap = {};
    (productRows || []).forEach(p => {
      productTitleMap[p.sku] = p.title_ko || p.title || null;
    });

    // Build competitor list: sku → collect all, sort by total asc, keep top 3
    const compListAll = {};
    (compRows || []).forEach(c => {
      if (!compListAll[c.sku]) compListAll[c.sku] = [];
      compListAll[c.sku].push(c);
    });
    const compList = {};
    Object.keys(compListAll).forEach(sku => {
      compListAll[sku].sort((a, b) =>
        (parseFloat(a.competitor_price) + parseFloat(a.competitor_shipping || 0)) -
        (parseFloat(b.competitor_price) + parseFloat(b.competitor_shipping || 0))
      );
      compList[sku] = compListAll[sku].slice(0, 3); // Keep cheapest 3
    });

    const dashboard = normalizedListings.map(p => {
      // Match by SKU or itemId (CSV imports use eBay item ID as SKU)
      const competitors = compList[p.sku] || compList[p.itemId] || [];
      const cheapest = competitors[0] || null;
      return {
        sku: p.sku,
        itemId: p.itemId,
        // title_ko (DB 한국어) → title (DB 영어) → eBay listing title
        title: productTitleMap[p.sku] || p.title,
        myPrice: p.price,
        myShipping: p.shipping,
        quantity: (dbStockMap[p.sku] !== undefined ? dbStockMap[p.sku] : null) ?? (dbStockMap[p.itemId] !== undefined ? dbStockMap[p.itemId] : null) ?? p.quantity ?? 0,
        competitors: competitors.map(c => ({
          itemId: c.competitor_id || null,
          price: parseFloat(c.competitor_price),
          shipping: parseFloat(c.competitor_shipping || 0),
          total: parseFloat(c.competitor_price) + parseFloat(c.competitor_shipping || 0),
          url: c.competitor_url || null,
          seller: c.seller_id || '',
        })),
        cheapestTotal: cheapest
          ? parseFloat(cheapest.competitor_price) + parseFloat(cheapest.competitor_shipping || 0)
          : null,
        lastTracked: cheapest?.tracked_at || null,
        recentChanges: [],
      };
    });

    return dashboard;
  }
}

module.exports = RepricingService;
