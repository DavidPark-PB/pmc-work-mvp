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
          .select('item_id, sku, title, price_usd, shipping_usd, stock, updated_at')
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
      lastSyncedAt: r.updated_at || null,
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

    // ── AI 매칭 (product_matches approved) + competitor_listings 병합 ──────
    // 사장님 지침 (2026-07-09): 매일 크롤 + AI 매칭 결과를 전투 현황에 반영.
    //   competitor_prices 는 수동 등록 (셀러 스캔/경쟁사 가져오기 버튼) 만 담고 있어
    //   자동 크롤로 채워지는 competitor_listings 를 놓치고 있었음.
    const matchesBySku = new Map();  // sku → [ {competitorItemId, confidence, sellerId} ]
    try {
      for (let i = 0; i < skus.length; i += 500) {
        const chunk = skus.slice(i, i + 500);
        const { data: matches } = await db
          .from('product_matches')
          .select('our_sku, competitor_item_id, seller_id, confidence, status')
          .in('our_sku', chunk)
          .eq('status', 'approved');
        (matches || []).forEach(m => {
          if (!matchesBySku.has(m.our_sku)) matchesBySku.set(m.our_sku, []);
          matchesBySku.get(m.our_sku).push(m);
        });
      }
    } catch (e) {
      console.warn('[BattleDashboard] product_matches 조회 실패:', e.message);
    }

    // competitor_listings 배치 조회 (매칭된 경쟁 리스팅만)
    const allMatchedItemIds = [];
    matchesBySku.forEach(list => list.forEach(m => allMatchedItemIds.push(m.competitor_item_id)));
    const uniqueMatchedIds = [...new Set(allMatchedItemIds)];
    const listingByItemId = new Map();
    try {
      for (let i = 0; i < uniqueMatchedIds.length; i += 500) {
        const chunk = uniqueMatchedIds.slice(i, i + 500);
        const { data: listings } = await db
          .from('competitor_listings')
          .select('ebay_item_id, seller_id, title, price, shipping, image_url, url, status, quantity, quantity_sold, last_seen')
          .in('ebay_item_id', chunk);
        (listings || []).forEach(l => listingByItemId.set(l.ebay_item_id, l));
      }
    } catch (e) {
      console.warn('[BattleDashboard] competitor_listings 조회 실패:', e.message);
    }

    // AI 매칭 결과를 compRows 스키마로 변환해서 병합 (competitor_prices 와 동일 형식)
    const seenKey = new Set(compRows.map(c => `${c.sku}::${c.competitor_id}`));
    matchesBySku.forEach((matches, sku) => {
      matches.forEach(m => {
        const key = `${sku}::${m.competitor_item_id}`;
        if (seenKey.has(key)) return; // 이미 competitor_prices 에 있음
        const listing = listingByItemId.get(m.competitor_item_id);
        if (!listing) return; // competitor_listings 에 없으면 스킵
        compRows.push({
          id: null,
          sku,
          competitor_id: m.competitor_item_id,
          competitor_price: listing.price,
          competitor_shipping: listing.shipping,
          competitor_url: listing.url || `https://www.ebay.com/itm/${m.competitor_item_id}`,
          seller_id: m.seller_id || listing.seller_id || '',
          seller_feedback: 0,
          tracked_at: listing.last_seen,
          price_min: null,
          price_max: null,
          variant_count: 1,
          quantity_available: listing.quantity,
          status: listing.status || 'active',
          manual_price_override: null,
          manual_shipping_override: null,
          // 신규 필드 — 소스 구분 + AI 매칭 정보
          _source: 'ai',
          _matchConfidence: Number(m.confidence) || 0,
          _title: listing.title || '',
          _imageUrl: listing.image_url || null,
        });
        seenKey.add(key);
      });
    });

    // 셀러 티어 정보 로드 (핵심 F/D 셀러 최상단 정렬용)
    const tierBySeller = new Map();
    try {
      const uniqueSellers = [...new Set(compRows.map(c => c.seller_id).filter(Boolean))];
      for (let i = 0; i < uniqueSellers.length; i += 500) {
        const chunk = uniqueSellers.slice(i, i + 500);
        const { data: sellers, error: se } = await db
          .from('competitor_sellers')
          .select('seller_id, crawl_tier')
          .in('seller_id', chunk);
        if (se && se.code === '42703') break; // migration 070 미적용
        (sellers || []).forEach(s => tierBySeller.set(s.seller_id, s.crawl_tier || 'B'));
      }
    } catch (e) {
      console.warn('[BattleDashboard] competitor_sellers 티어 조회 실패:', e.message);
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

    // 티어 우선순위 (숫자 작을수록 상단)
    const TIER_RANK = { F: 0, D: 1, C: 2, B: 3, A: 4 };
    const now = Date.now();
    const STALE_THRESHOLD_DAYS = 7; // 사장님 지침 2026-07-09: 7일 넘으면 오래된 가격

    const dashboard = normalizedListings.map(p => {
      const competitors = compList[p.sku] || compList[p.itemId] || [];
      // 활성(품절 아닌) 경쟁사 중 최저가 사용 — 킬프라이스 기준
      // 품절 경쟁사도 표시 (사장님 지침 2026-07-09): 소싱 어려움 신호
      const aliveComps = competitors.filter(isAlive);
      const cheapest = aliveComps[0] || null;
      const allOutOfStock = competitors.length > 0 && aliveComps.length === 0;

      // 이 상품의 최고 티어 (F 가장 급함)
      const bestTier = competitors.reduce((best, c) => {
        const t = tierBySeller.get(c.seller_id) || 'B';
        return TIER_RANK[t] < TIER_RANK[best] ? t : best;
      }, 'A');
      const bestTierRank = TIER_RANK[bestTier];

      return {
        sku: p.sku,
        itemId: p.itemId,
        title: productTitleMap[p.sku] || p.title,
        myPrice: p.price,
        myShipping: p.shipping,
        myLastSyncedAt: p.lastSyncedAt,
        quantity: p.quantity ?? 0,
        // 정렬용
        bestTier,
        bestTierRank,
        competitors: competitors.map(c => {
          const tier = tierBySeller.get(c.seller_id) || 'B';
          const trackedMs = c.tracked_at ? new Date(c.tracked_at).getTime() : 0;
          const ageDays = trackedMs > 0 ? Math.floor((now - trackedMs) / 86400000) : null;
          const isStale = ageDays != null && ageDays >= STALE_THRESHOLD_DAYS;
          const isOutOfStock = !isAlive(c);
          return {
            id: c.id,
            itemId: c.competitor_id || null,
            price: effPrice(c),
            shipping: effShipping(c),
            total: effPrice(c) + effShipping(c),
            rawPrice: Number(c.competitor_price) || 0,
            rawShipping: Number(c.competitor_shipping || 0),
            url: c.competitor_url || null,
            seller: c.seller_id || '',
            title: c._title || null,
            imageUrl: c._imageUrl || null,
            // 변형 + 재고
            priceMin: c.price_min != null ? Number(c.price_min) : null,
            priceMax: c.price_max != null ? Number(c.price_max) : null,
            variantCount: Number(c.variant_count || 1),
            quantityAvailable: c.quantity_available != null ? Number(c.quantity_available) : null,
            status: c.status || 'active',
            hasOverride: c.manual_price_override != null,
            // 신규 (사장님 지침 2026-07-09)
            source: c._source || 'manual',        // 'ai' | 'manual'
            matchConfidence: c._matchConfidence || null,  // 0~1 (AI 매칭 신뢰도)
            tier,                                  // F | D | C | B | A
            trackedAt: c.tracked_at || null,
            ageDays,
            isStale,                               // 7일 이상 오래됨
            isOutOfStock,
          };
        }),
        cheapestTotal: cheapest ? effPrice(cheapest) + effShipping(cheapest) : null,
        allOutOfStock,
        lastTracked: cheapest?.tracked_at || null,
        recentChanges: [],
      };
    });

    // 정렬: 지고 있는 상품 우선 → 티어 F/D 우선 → 차이 큰 순
    // (사장님 지침 2026-07-09: 직원이 위에서부터 처리하면 됨)
    dashboard.sort((a, b) => {
      const aMyTotal = a.myPrice + (a.myShipping || 0);
      const bMyTotal = b.myPrice + (b.myShipping || 0);
      const aLosing = a.cheapestTotal != null && aMyTotal > a.cheapestTotal;
      const bLosing = b.cheapestTotal != null && bMyTotal > b.cheapestTotal;
      if (aLosing !== bLosing) return aLosing ? -1 : 1;  // losing 위로
      if (a.bestTierRank !== b.bestTierRank) return a.bestTierRank - b.bestTierRank; // F/D 위로
      const aDiff = a.cheapestTotal != null ? aMyTotal - a.cheapestTotal : -Infinity;
      const bDiff = b.cheapestTotal != null ? bMyTotal - b.cheapestTotal : -Infinity;
      return bDiff - aDiff;  // 차이 큰 순
    });

    return dashboard;
  }
}

module.exports = RepricingService;
