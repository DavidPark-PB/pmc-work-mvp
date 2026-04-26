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

    // DB 기반 조회 — ebay_products 테이블 (productSync로 주기적 갱신됨).
    // 이전에는 eBay API를 요청마다 25페이지 호출해서 Fly 프록시 60초 타임아웃에
    // 걸려 502가 반복 발생했음. DB 조회는 1초 내로 끝남.
    let ebayItems = [];
    try {
      // Supabase default row limit은 1000 → range()로 페이지 끝까지 수집.
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await db
          .from('ebay_products')
          .select('item_id, sku, title, price_usd, shipping_usd, stock')
          .neq('status', 'ended')
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        ebayItems = ebayItems.concat(data);
        if (data.length < PAGE) break;
      }
      console.log('[BattleDashboard] Loaded', ebayItems.length, 'ebay_products rows');
    } catch (e) {
      console.error('[BattleDashboard] ebay_products 조회 오류:', e.message);
      return [];
    }

    if (ebayItems.length === 0) return [];

    const normalizedListings = ebayItems.map(r => ({
      sku: r.sku || r.item_id || '',
      itemId: r.item_id || '',
      title: r.title || r.item_id || '',
      price: parseFloat(r.price_usd) || 0,
      shipping: parseFloat(r.shipping_usd) || 0,
      quantity: parseInt(r.stock) || 0,
    })).filter(l => l.sku && l.price > 0);

    if (normalizedListings.length === 0) return [];

    // Batch-fetch all competitor prices by SKU and itemId (split into chunks of 500)
    const skus = normalizedListings.map(l => l.sku).filter(Boolean);
    const itemIds = normalizedListings.map(l => l.itemId).filter(Boolean);
    const allKeys = [...new Set([...skus, ...itemIds])];
    let compRows = [];
    // 신규 컬럼 (price_min/max, status, override) 함께 조회. 마이그레이션 034 미적용 시 fallback.
    const FULL_SELECT = 'id, sku, competitor_id, competitor_price, competitor_shipping, competitor_url, seller_id, seller_feedback, tracked_at, price_min, price_max, variant_count, quantity_available, status, manual_price_override, manual_shipping_override';
    const LEGACY_SELECT = 'id, sku, competitor_id, competitor_price, competitor_shipping, competitor_url, seller_id, seller_feedback, tracked_at';
    for (let i = 0; i < allKeys.length; i += 500) {
      const chunk = allKeys.slice(i, i + 500);
      let { data, error } = await db.from('competitor_prices')
        .select(FULL_SELECT).in('sku', chunk).order('tracked_at', { ascending: false });
      if (error && error.code === '42703') {
        ({ data } = await db.from('competitor_prices')
          .select(LEGACY_SELECT).in('sku', chunk).order('tracked_at', { ascending: false }));
      }
      if (data) compRows = compRows.concat(data);
    }

    // 헬퍼: override 가 있으면 그 값을 effective price/shipping 으로 사용.
    // 주의: Number(null) === 0 + isFinite(0) === true 라서 null 체크를 명시적으로 해야
    //       null override 가 0 으로 잘못 매핑되지 않음.
    const effPrice = (c) => {
      const o = c.manual_price_override;
      if (o != null && Number.isFinite(Number(o)) && Number(o) > 0) return Number(o);
      return Number(c.competitor_price) || 0;
    };
    const effShipping = (c) => {
      const o = c.manual_shipping_override;
      if (o != null && Number.isFinite(Number(o))) return Number(o);
      return Number(c.competitor_shipping) || 0;
    };
    const isAlive = (c) => {
      const s = String(c.status || 'active');
      return s !== 'out_of_stock' && s !== 'ended';
    };

    // Fetch Korean product titles from products table
    const { data: productRows } = await db
      .from('products')
      .select('sku, title, title_ko')
      .in('sku', skus);

    // quantity는 ebay_products.stock을 그대로 사용하므로 별도 조회 불필요.
    const productTitleMap = {};
    (productRows || []).forEach(p => {
      productTitleMap[p.sku] = p.title_ko || p.title || null;
    });

    // Build competitor list: sku → collect all, sort by EFFECTIVE total asc (override > raw),
    // keep top 3 (포함 모두 — 품절도 표시용으로는 유지, 단 cheapest 계산은 활성만)
    const compListAll = {};
    (compRows || []).forEach(c => {
      if (!compListAll[c.sku]) compListAll[c.sku] = [];
      compListAll[c.sku].push(c);
    });
    const compList = {};
    Object.keys(compListAll).forEach(sku => {
      compListAll[sku].sort((a, b) =>
        (effPrice(a) + effShipping(a)) - (effPrice(b) + effShipping(b))
      );
      compList[sku] = compListAll[sku].slice(0, 3);
    });

    const dashboard = normalizedListings.map(p => {
      const competitors = compList[p.sku] || compList[p.itemId] || [];
      // 활성(품절 아닌) 경쟁사 중 최저가 사용
      const aliveComps = competitors.filter(isAlive);
      const cheapest = aliveComps[0] || null;
      const allOutOfStock = competitors.length > 0 && aliveComps.length === 0;
      return {
        sku: p.sku,
        itemId: p.itemId,
        title: productTitleMap[p.sku] || p.title,
        myPrice: p.price,
        myShipping: p.shipping,
        quantity: p.quantity ?? 0,
        competitors: competitors.map(c => ({
          id: c.id,
          itemId: c.competitor_id || null,
          price: effPrice(c),
          shipping: effShipping(c),
          total: effPrice(c) + effShipping(c),
          rawPrice: Number(c.competitor_price) || 0,
          rawShipping: Number(c.competitor_shipping || 0),
          url: c.competitor_url || null,
          seller: c.seller_id || '',
          // 신규: 변형 + 재고
          priceMin: c.price_min != null ? Number(c.price_min) : null,
          priceMax: c.price_max != null ? Number(c.price_max) : null,
          variantCount: Number(c.variant_count || 1),
          quantityAvailable: c.quantity_available != null ? Number(c.quantity_available) : null,
          status: c.status || 'active',
          hasOverride: c.manual_price_override != null,
        })),
        cheapestTotal: cheapest ? effPrice(cheapest) + effShipping(cheapest) : null,
        allOutOfStock,
        lastTracked: cheapest?.tracked_at || null,
        recentChanges: [],
      };
    });

    return dashboard;
  }
}

module.exports = RepricingService;
