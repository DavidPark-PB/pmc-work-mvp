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
   * Get battle dashboard data via v_battle_dashboard_rows view.
   *
   * 뷰 (migration 071) 가 ebay_products / product_matches / competitor_listings /
   * competitor_sellers / competitor_prices / products 를 SQL JOIN 으로 이미
   * 병합하므로 여기서는 단순 select 만. Railway 프록시 60 초 타임아웃 회피.
   *
   * 뷰 미적용 (마이그레이션 안 됨) → legacy 흐름으로 폴백.
   */
  async getBattleDashboard() {
    const db = getClient();

    // ── 뷰 기반 신규 흐름 ────────────────────────────────────────────────────
    try {
      return await this._getBattleDashboardViaView(db);
    } catch (e) {
      // 뷰 없음 (42P01: relation does not exist) 또는 컬럼 없음 (42703) → 폴백
      const code = e?.code || '';
      const missing = code === '42P01' || code === '42703' ||
        /v_battle_dashboard_rows/i.test(e?.message || '');
      if (!missing) {
        console.error('[BattleDashboard] 뷰 조회 오류:', e.message);
      } else {
        console.warn('[BattleDashboard] 뷰 없음 → legacy 흐름 폴백');
      }
      return await this._getBattleDashboardLegacy(db);
    }
  }

  /**
   * 뷰 기반 (신규, 2026-07-09 사장님 지침).
   * v_battle_dashboard_rows 를 select → JS 에서 SKU 별 그룹핑 + 정렬만 담당.
   */
  async _getBattleDashboardViaView(db) {
    const now = Date.now();
    const STALE_THRESHOLD_DAYS = 7; // 사장님 지침: 7일 넘으면 오래된 가격

    // ── 1. 매칭 있는 SKU 로우 로드 (뷰) ──────────────────────────────────
    let rows = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from('v_battle_dashboard_rows')
        .select('*')
        .range(offset, offset + 999);
      if (error) throw error;
      if (!data || data.length === 0) break;
      rows = rows.concat(data);
      if (data.length < 1000) break;
    }
    console.log('[BattleDashboard/view] 뷰 로우 수:', rows.length);

    // ── 2. 매칭 없는 내 리스팅 (뷰) ──────────────────────────────────────
    let unmatched = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from('v_battle_unmatched_listings')
        .select('*')
        .range(offset, offset + 999);
      if (error) throw error;
      if (!data || data.length === 0) break;
      unmatched = unmatched.concat(data);
      if (data.length < 1000) break;
    }
    console.log('[BattleDashboard/view] 매칭 없는 리스팅:', unmatched.length);

    // ── 3. SKU 별 그룹핑 ─────────────────────────────────────────────────
    // rows 는 (내 SKU × 경쟁사 1명) 조합의 곱. 같은 (sku, competitor_item_id)
    // 가 AI/manual 양쪽에 있으면 AI 우선.
    const sku2listing = new Map(); // sku → { my info + competitors[] }
    const seenPair   = new Set();  // sku::competitor_item_id (중복 방지)

    // AI 우선: source='ai' 먼저 처리, 그 다음 manual
    rows.sort((a, b) => (a.source === 'ai' ? -1 : 1));

    for (const r of rows) {
      const sku = r.our_sku;
      if (!sku) continue;
      const key = `${sku}::${r.competitor_item_id || ''}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);

      let entry = sku2listing.get(sku);
      if (!entry) {
        entry = {
          sku,
          itemId: r.our_item_id || '',
          title:  r.title || sku,
          myPrice:    Number(r.my_price) || 0,
          myShipping: Number(r.my_shipping) || 0,
          myLastSyncedAt: r.my_last_synced_at || null,
          quantity: Number(r.my_stock) || 0,
          competitors: [],
        };
        sku2listing.set(sku, entry);
      }

      const compPrice    = Number(r.competitor_price) || 0;
      const compShipping = Number(r.competitor_shipping) || 0;
      const trackedMs    = r.tracked_at ? new Date(r.tracked_at).getTime() : 0;
      const ageDays      = trackedMs > 0 ? Math.floor((now - trackedMs) / 86400000) : null;
      const status       = r.competitor_status || 'active';

      entry.competitors.push({
        id:              r.manual_row_id,          // manual 만 값 있음
        itemId:          r.competitor_item_id || null,
        price:           compPrice,
        shipping:        compShipping,
        total:           +(compPrice + compShipping).toFixed(2),
        rawPrice:        compPrice,
        rawShipping:     compShipping,
        url:             r.competitor_url || (r.competitor_item_id ? `https://www.ebay.com/itm/${r.competitor_item_id}` : null),
        seller:          r.competitor_seller_id || '',
        title:           r.competitor_title || null,
        imageUrl:        r.competitor_image || null,
        priceMin:        r.price_min != null ? Number(r.price_min) : null,
        priceMax:        r.price_max != null ? Number(r.price_max) : null,
        variantCount:    Number(r.variant_count || 1),
        quantityAvailable: r.competitor_quantity != null ? Number(r.competitor_quantity) : null,
        status,
        hasOverride:     !!r.has_override,
        source:          r.source || 'manual',
        matchConfidence: r.match_confidence != null ? Number(r.match_confidence) : null,
        tier:            r.competitor_tier || 'B',
        trackedAt:       r.tracked_at || null,
        ageDays,
        isStale:         ageDays != null && ageDays >= STALE_THRESHOLD_DAYS,
        isOutOfStock:    status === 'out_of_stock' || status === 'ended',
      });
    }

    // ── 4. 매칭 없는 리스팅도 dashboard 에 (no-comp 필터용) ───────────
    for (const u of unmatched) {
      if (sku2listing.has(u.our_sku)) continue;
      sku2listing.set(u.our_sku, {
        sku:            u.our_sku,
        itemId:         u.our_item_id || '',
        title:          u.title || u.our_sku,
        myPrice:        Number(u.my_price) || 0,
        myShipping:     Number(u.my_shipping) || 0,
        myLastSyncedAt: u.my_last_synced_at || null,
        quantity:       Number(u.my_stock) || 0,
        competitors:    [],
      });
    }

    // ── 5. 각 SKU 마다 경쟁사 3명 top + 정렬 메타 ────────────────────────
    const TIER_RANK = { F: 0, D: 1, C: 2, B: 3, A: 4 };
    const dashboard = [];
    for (const entry of sku2listing.values()) {
      // 경쟁사 total 오름차순 (가장 싼 것 top)
      entry.competitors.sort((a, b) => a.total - b.total);
      entry.competitors = entry.competitors.slice(0, 3);

      const aliveComps = entry.competitors.filter(c => !c.isOutOfStock);
      const cheapest = aliveComps[0] || null;

      // 이 상품의 최고 티어 (F 가장 급함)
      const bestTier = entry.competitors.reduce((best, c) => {
        const t = c.tier || 'B';
        return TIER_RANK[t] < TIER_RANK[best] ? t : best;
      }, 'A');

      dashboard.push({
        sku:              entry.sku,
        itemId:           entry.itemId,
        title:            entry.title,
        myPrice:          entry.myPrice,
        myShipping:       entry.myShipping,
        myLastSyncedAt:   entry.myLastSyncedAt,
        quantity:         entry.quantity,
        competitors:      entry.competitors,
        cheapestTotal:    cheapest ? cheapest.total : null,
        allOutOfStock:    entry.competitors.length > 0 && aliveComps.length === 0,
        lastTracked:      cheapest?.trackedAt || null,
        bestTier,
        bestTierRank:     TIER_RANK[bestTier],
        recentChanges:    [],
      });
    }

    // ── 5.5. 원가 정보 붙이기 (마진 표시용) ─────────────────────────────
    //   2026-07-15 사장님: 킬프라이스 옆에 예상 마진 표시 요청.
    //   sku_master.cost_krw 배치 로드 → USD 환산 (KRW_PER_USD=1350 상수).
    //   원가 없으면 costKrw=null → 프론트에서 "원가 미입력" 뱃지.
    const KRW_PER_USD = 1350;
    const allSkus = [...sku2listing.keys()];
    const costBySku = new Map();
    for (let i = 0; i < allSkus.length; i += 500) {
      const chunk = allSkus.slice(i, i + 500);
      const { data } = await db.from('sku_master')
        .select('internal_sku, cost_krw').in('internal_sku', chunk);
      (data || []).forEach(r => {
        if (r.cost_krw != null && r.cost_krw > 0) costBySku.set(r.internal_sku, Number(r.cost_krw));
      });
    }

    // 각 dashboard entry 에 cost 필드 추가
    for (const d of dashboard) {
      const krw = costBySku.get(d.sku);
      d.costKrw = krw != null ? krw : null;
      d.costUsd = krw != null ? +(krw / KRW_PER_USD).toFixed(2) : null;
    }

    // ── 6. 정렬 — 지고 있는 상품 우선 → F/D 티어 우선 → 차이 큰 순 ────────
    dashboard.sort((a, b) => {
      const aMyTotal = a.myPrice + (a.myShipping || 0);
      const bMyTotal = b.myPrice + (b.myShipping || 0);
      const aLosing  = a.cheapestTotal != null && aMyTotal > a.cheapestTotal;
      const bLosing  = b.cheapestTotal != null && bMyTotal > b.cheapestTotal;
      if (aLosing !== bLosing) return aLosing ? -1 : 1;
      if (a.bestTierRank !== b.bestTierRank) return a.bestTierRank - b.bestTierRank;
      const aDiff = a.cheapestTotal != null ? aMyTotal - a.cheapestTotal : -Infinity;
      const bDiff = b.cheapestTotal != null ? bMyTotal - b.cheapestTotal : -Infinity;
      return bDiff - aDiff;
    });

    return dashboard;
  }

  /**
   * Legacy 흐름 (뷰 미적용 시 폴백).
   * Migration 071 이 실행 안 됐어도 대시보드가 계속 뜨도록 유지.
   */
  async _getBattleDashboardLegacy(db) {
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
        myLastSyncedAt: p.lastSyncedAt,
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
