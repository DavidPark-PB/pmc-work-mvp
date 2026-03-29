/**
 * Margin Agent — Monitors margins, detects reverse-margin,
 * recommends price adjustments across all platforms.
 *
 * Runs every 4 hours via setInterval in server.js.
 * Reuses: pricingEngine, productRepository, competitor_prices table.
 */
const { AgentBase } = require('./core/agent-base');
const { ProfitCalculator } = require('./core/profit-calculator');
const ProductRepository = require('../db/productRepository');
const { getClient } = require('../db/supabaseClient');
const { calculatePrices } = require('../services/pricingEngine');

const AGENT_NAME = 'margin-agent';

// Decision thresholds
const THRESHOLDS = {
  REVERSE_MARGIN: 0,        // margin < 0%
  CRITICAL_LOW: 5,           // margin < 5%
  DEFAULT_TARGET: 30,        // default target margin %
  NO_SALES_DAYS: 30,         // days without sales → overpriced
  AUTO_APPROVE_MAX_PCT: 5,   // auto-approve if price change ≤ 5%
  DEDUP_HOURS: 24,           // skip if pending recommendation exists within N hours
};

class MarginAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
    this.profitCalc = new ProfitCalculator();
    this.productRepo = new ProductRepository();
  }

  /**
   * Step 1: Load all products + calculate margins + load competitor data
   */
  async analyze() {
    const products = await this.productRepo.getDashboardProducts();
    console.log(`[${this.name}] Loaded ${products.length} products`);

    // Batch calculate margins for all products
    const analyzed = this.profitCalc.batchCalculate(products);

    // Load latest competitor prices (grouped by SKU)
    const db = getClient();
    const { data: competitors } = await db
      .from('competitor_prices')
      .select('sku, competitor_price, competitor_shipping, tracked_at')
      .order('tracked_at', { ascending: false });

    // Build map: sku → latest competitor entry
    const compMap = {};
    for (const c of (competitors || [])) {
      if (!compMap[c.sku]) compMap[c.sku] = c;
    }

    // Attach competitor data and raw product data
    for (const item of analyzed) {
      item.competitor = compMap[item.sku] || null;
      const raw = products.find(p => p.sku === item.sku);
      if (raw) {
        item.salesCount = parseInt(raw.salesCount) || 0;
        item.stock = parseInt(raw.stock) || 0;
        item.currentPriceUSD = parseFloat(raw.priceUSD) || 0;
        item.currentShippingUSD = parseFloat(raw.shippingUSD) || 0;
        item.ebayItemId = raw.itemId || '';
      }
    }

    return analyzed;
  }

  /**
   * Step 2: Classify each product into decision categories
   */
  async decide(analysis) {
    const decisions = [];

    for (const item of analysis) {
      if (item.error || !item.platforms) continue;

      // Check eBay margin (primary platform)
      const ebay = item.platforms.ebay;
      if (!ebay || ebay.error) continue;

      const margin = ebay.margin || 0;
      const currentTotal = item.currentPriceUSD + item.currentShippingUSD;
      const compTotal = item.competitor
        ? parseFloat(item.competitor.competitor_price) + parseFloat(item.competitor.competitor_shipping || 0)
        : null;

      // Reverse margin (selling at a loss)
      if (margin < THRESHOLDS.REVERSE_MARGIN) {
        decisions.push({
          sku: item.sku,
          title: item.title,
          category: 'reverse_margin',
          priority: 'critical',
          margin,
          currentPrice: item.currentPriceUSD,
          recommendedPrice: ebay.price,
          confidence: 0.95,
          reason: `역마진 ${margin.toFixed(1)}% — 현재 가격 $${item.currentPriceUSD}로 손실 발생. 목표마진 가격 $${ebay.price} 제안.`,
          platform: 'ebay',
          item,
        });
        continue;
      }

      // Critical low margin
      if (margin < THRESHOLDS.CRITICAL_LOW) {
        decisions.push({
          sku: item.sku,
          title: item.title,
          category: 'critical_low_margin',
          priority: 'high',
          margin,
          currentPrice: item.currentPriceUSD,
          recommendedPrice: ebay.price,
          confidence: 0.85,
          reason: `위험 마진 ${margin.toFixed(1)}% (최소 기준 5% 미달). 가격 조정 $${ebay.price} 제안.`,
          platform: 'ebay',
          item,
        });
        continue;
      }

      // Competitor undercut (we're more expensive)
      if (compTotal && currentTotal > compTotal && compTotal > 0) {
        const priceDiff = currentTotal - compTotal;
        if (priceDiff > 0.5) {
          // Calculate a competitive price (match competitor - $0.01)
          const competitivePrice = Math.max(
            parseFloat(item.competitor.competitor_price) - 0.01,
            ebay.price * 0.7  // floor at 70% of target-margin price
          );
          decisions.push({
            sku: item.sku,
            title: item.title,
            category: 'competitor_undercut',
            priority: 'high',
            margin,
            currentPrice: item.currentPriceUSD,
            recommendedPrice: +competitivePrice.toFixed(2),
            competitorTotal: compTotal,
            confidence: 0.80,
            reason: `경쟁사 총가격 $${compTotal.toFixed(2)} vs 우리 $${currentTotal.toFixed(2)} — $${priceDiff.toFixed(2)} 비쌈. $${competitivePrice.toFixed(2)} 제안.`,
            platform: 'ebay',
            item,
          });
          continue;
        }
      }

      // Below target margin (not urgent)
      if (margin < THRESHOLDS.DEFAULT_TARGET && margin >= THRESHOLDS.CRITICAL_LOW) {
        // Only flag if price can be improved
        if (ebay.price > item.currentPriceUSD * 1.02) {
          decisions.push({
            sku: item.sku,
            title: item.title,
            category: 'below_target',
            priority: 'medium',
            margin,
            currentPrice: item.currentPriceUSD,
            recommendedPrice: ebay.price,
            confidence: 0.70,
            reason: `마진 ${margin.toFixed(1)}% (목표 30% 미달). 가격 인상 $${item.currentPriceUSD} → $${ebay.price} 제안.`,
            platform: 'ebay',
            item,
          });
          continue;
        }
      }

      // Overpriced with no sales
      if (item.salesCount === 0 && margin > 40) {
        decisions.push({
          sku: item.sku,
          title: item.title,
          category: 'overpriced_no_sales',
          priority: 'medium',
          margin,
          currentPrice: item.currentPriceUSD,
          recommendedPrice: +(item.currentPriceUSD * 0.9).toFixed(2),
          confidence: 0.60,
          reason: `마진 ${margin.toFixed(1)}%로 높지만 판매 0건. 10% 인하 $${(item.currentPriceUSD * 0.9).toFixed(2)} 제안.`,
          platform: 'ebay',
          item,
        });
      }
    }

    console.log(`[${this.name}] ${decisions.length} decisions made`);
    return decisions;
  }

  /**
   * Step 3: Save recommendations to DB (with dedup + auto-approve logic)
   */
  async recommend(decisions) {
    const saved = [];

    for (const d of decisions) {
      // Dedup: skip if pending recommendation exists for same SKU+platform
      const exists = await this.logger.hasPendingRecommendation(
        AGENT_NAME, d.sku, d.platform, THRESHOLDS.DEDUP_HOURS
      );
      if (exists) {
        console.log(`[${this.name}] Skip duplicate: ${d.sku}`);
        continue;
      }

      // Determine auto-approve eligibility
      const priceChangePct = d.currentPrice > 0
        ? Math.abs(d.recommendedPrice - d.currentPrice) / d.currentPrice * 100
        : 100;
      const isSmallDecrease = d.recommendedPrice < d.currentPrice && priceChangePct <= THRESHOLDS.AUTO_APPROVE_MAX_PCT;
      const status = (isSmallDecrease && d.category === 'competitor_undercut')
        ? 'auto_approved'
        : 'pending';

      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: 'price_adjustment',
        sku: d.sku,
        platform: d.platform,
        priority: d.priority,
        current_value: {
          price: d.currentPrice,
          margin: d.margin,
          title: d.title,
          ebayItemId: d.item?.ebayItemId || '',
        },
        recommended_value: {
          price: d.recommendedPrice,
          priceChangePct: +priceChangePct.toFixed(1),
          category: d.category,
        },
        reason: d.reason,
        confidence: d.confidence,
        status,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);

      // Critical items also generate alerts
      if (d.priority === 'critical') {
        await this.logger.logAlert({
          agent_name: AGENT_NAME,
          type: d.category,
          severity: 'critical',
          title: `역마진 감지: ${d.sku}`,
          message: d.reason,
          sku: d.sku,
          platform: d.platform,
          context_data: {
            currentPrice: d.currentPrice,
            recommendedPrice: d.recommendedPrice,
            margin: d.margin,
          },
        });
      }

      // Log each recommendation action
      await this.logger.logAction(AGENT_NAME, 'recommend', {
        sku: d.sku,
        platform: d.platform,
        decision: d.category,
        reason: d.reason,
        confidence: d.confidence,
        output: { recommendedPrice: d.recommendedPrice, status },
      });
    }

    console.log(`[${this.name}] Saved ${saved.length} recommendations (${decisions.length - saved.length} deduplicated)`);
    return saved;
  }
}

module.exports = { MarginAgent };
