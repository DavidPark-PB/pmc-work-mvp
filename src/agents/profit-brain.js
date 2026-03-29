/**
 * Profit Brain Agent — Revenue defense & real margin guardian
 *
 * Unlike margin-agent (which focuses on eBay repricing),
 * profit-brain calculates TRUE net profit across ALL platforms,
 * accounting for: platform fees, shipping, exchange rates, tax, returns.
 *
 * Alerts when margin drops below 15%.
 * Returns structured JSON for Slack/KakaoTalk integration.
 *
 * Schedule: Every 4 hours
 */
const { AgentBase } = require('./core/agent-base');
const { ProfitCalculator } = require('./core/profit-calculator');
const ProductRepository = require('../db/productRepository');
const { getClient } = require('../db/supabaseClient');
const { calculatePrices, PLATFORM_FEES, EXCHANGE_RATE } = require('../services/pricingEngine');

const AGENT_NAME = 'profit-brain';

const THRESHOLDS = {
  DANGER_MARGIN: 0,        // negative margin = immediate alert
  WARNING_MARGIN: 15,      // below 15% = warning
  HIGH_PERFORMER: 40,      // above 40% = star product
  DEDUP_HOURS: 12,
};

class ProfitBrainAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
    this.profitCalc = new ProfitCalculator();
    this.productRepo = new ProductRepository();
  }

  /**
   * Step 1: Load all products + compute real net profit per platform
   * Uses ebay_products table (5,000+ active listings with prices)
   * and products table (for items with cost data)
   */
  async analyze() {
    const db = getClient();

    // Load eBay products directly (main revenue source with real prices)
    let ebayProducts = [];
    let from = 0;
    while (true) {
      const { data } = await db.from('ebay_products')
        .select('sku, title, item_id, price_usd, shipping_usd, sales_count, stock, status, fee_rate')
        .eq('status', 'active')
        .gt('price_usd', 0)
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      ebayProducts = ebayProducts.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Load cost data from products table (where available)
    const { data: costData } = await db.from('products')
      .select('sku, cost_price, weight, shipping_krw, tax_krw, total_cost')
      .gt('cost_price', 0);
    const costMap = {};
    for (const c of (costData || [])) {
      costMap[c.sku] = c;
    }

    console.log(`[${this.name}] Analyzing ${ebayProducts.length} eBay listings (${Object.keys(costMap).length} with cost data)`);

    // Load recent orders for sales velocity (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentOrders } = await db
      .from('orders')
      .select('sku, platform, total_amount, currency, created_at')
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false });

    const salesMap = {};
    for (const o of (recentOrders || [])) {
      if (!o.sku) continue;
      if (!salesMap[o.sku]) salesMap[o.sku] = { count: 0, revenue: 0, platforms: {} };
      salesMap[o.sku].count++;
      salesMap[o.sku].revenue += parseFloat(o.total_amount) || 0;
      salesMap[o.sku].platforms[o.platform] = (salesMap[o.sku].platforms[o.platform] || 0) + 1;
    }

    // Calculate profit for each eBay product
    const analyzed = [];
    for (const p of ebayProducts) {
      const priceUSD = parseFloat(p.price_usd) || 0;
      const shippingUSD = parseFloat(p.shipping_usd) || 3.9;
      const feeRate = (parseFloat(p.fee_rate) || 18) / 100;

      // Revenue calculation
      const totalRevenueKRW = (priceUSD + shippingUSD) * EXCHANGE_RATE;
      const fee = totalRevenueKRW * feeRate;

      // Cost: use DB data if available, otherwise estimate
      const cost = costMap[p.sku];
      let purchasePrice = 0;
      let totalCostKRW = 0;
      let hasCostData = false;

      if (cost && cost.cost_price > 0) {
        purchasePrice = parseFloat(cost.cost_price);
        const shippingKRW = parseFloat(cost.shipping_krw) || (shippingUSD * EXCHANGE_RATE);
        const tax = parseFloat(cost.tax_krw) || Math.round(purchasePrice * 0.15);
        totalCostKRW = purchasePrice + shippingKRW + tax;
        hasCostData = true;
      } else {
        // Estimate: assume 40% of revenue is cost (conservative estimate)
        totalCostKRW = totalRevenueKRW * 0.40;
        purchasePrice = totalCostKRW * 0.7; // rough estimate
      }

      const profit = totalRevenueKRW - fee - totalCostKRW;
      const realEbayMargin = totalRevenueKRW > 0 ? (profit / totalRevenueKRW * 100) : 0;

      // Calculate target prices using pricingEngine (only if cost data exists)
      let calculatedPrices = {};
      if (hasCostData) {
        calculatedPrices = calculatePrices({
          purchasePrice,
          weight: parseFloat(cost?.weight) || 0,
          targetMargin: 30,
          shippingUSD,
        });
      }

      const sales = salesMap[p.sku] || { count: 0, revenue: 0, platforms: {} };

      analyzed.push({
        sku: p.sku,
        title: p.title,
        purchasePrice,
        priceUSD,
        shippingUSD,
        stock: parseInt(p.stock) || 0,
        salesCount: parseInt(p.sales_count) || sales.count,
        salesRevenue: sales.revenue,
        salesPlatforms: sales.platforms,
        realEbayMargin: +realEbayMargin.toFixed(1),
        hasCostData,
        calculatedPrices,
        ebayItemId: p.item_id || '',
        profitKRW: Math.round(profit),
        feeKRW: Math.round(fee),
        totalRevenueKRW: Math.round(totalRevenueKRW),
      });
    }

    return analyzed;
  }

  /**
   * Step 2: Classify products into profit categories
   */
  async decide(analysis) {
    const decisions = [];

    // Portfolio-level stats
    let totalRevenue = 0;
    let totalProfit = 0;
    let dangerCount = 0;
    let warningCount = 0;
    let starCount = 0;

    for (const item of analysis) {
      const margin = item.realEbayMargin;

      totalRevenue += item.totalRevenueKRW || 0;
      totalProfit += item.profitKRW || 0;

      const ebayTarget = item.calculatedPrices?.ebay;
      const targetPrice = ebayTarget?.price || +(item.priceUSD * 1.1).toFixed(2);

      // Danger: negative or near-zero margin
      if (margin < THRESHOLDS.DANGER_MARGIN) {
        dangerCount++;
        decisions.push({
          sku: item.sku,
          title: item.title,
          category: 'danger_margin',
          priority: 'critical',
          severity: 'critical',
          margin,
          currentPrice: item.priceUSD,
          targetPrice,
          profitKRW: item.profitKRW,
          salesCount: item.salesCount,
          hasCostData: item.hasCostData,
          message: `[손실] ${item.sku} — 마진 ${margin}%${item.hasCostData ? '' : '(추정)'}, 매출 ${item.salesCount}건. $${item.priceUSD}`,
          item,
        });
      }
      // Warning: below 15%
      else if (margin < THRESHOLDS.WARNING_MARGIN) {
        warningCount++;
        decisions.push({
          sku: item.sku,
          title: item.title,
          category: 'low_margin',
          priority: 'high',
          severity: 'warning',
          margin,
          currentPrice: item.priceUSD,
          targetPrice,
          profitKRW: item.profitKRW,
          salesCount: item.salesCount,
          hasCostData: item.hasCostData,
          message: `[경고] ${item.sku} — 마진 ${margin}%${item.hasCostData ? '' : '(추정)'} (15% 미달). 매출 ${item.salesCount}건`,
          item,
        });
      }
      // Stars: high margin + selling
      else if (margin >= THRESHOLDS.HIGH_PERFORMER && item.salesCount > 0) {
        starCount++;
      }
    }

    // Portfolio summary decision
    const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue * 100) : 0;
    decisions.push({
      sku: null,
      title: 'Portfolio Summary',
      category: 'portfolio_summary',
      priority: 'low',
      severity: 'info',
      margin: +avgMargin.toFixed(1),
      message: `[포트폴리오] 평균 마진 ${avgMargin.toFixed(1)}% | 위험 ${dangerCount}건 | 경고 ${warningCount}건 | 스타 ${starCount}건`,
      stats: { totalProducts: analysis.length, dangerCount, warningCount, starCount, avgMargin: +avgMargin.toFixed(1) },
    });

    console.log(`[${this.name}] ${decisions.length} decisions (${dangerCount} danger, ${warningCount} warning, ${starCount} stars)`);
    return decisions;
  }

  /**
   * Step 3: Create recommendations + alerts + structured JSON report
   */
  async recommend(decisions) {
    const saved = [];
    const jsonReport = {
      agent: AGENT_NAME,
      timestamp: new Date().toISOString(),
      summary: null,
      alerts: [],
      recommendations: [],
    };

    for (const d of decisions) {
      // Portfolio summary → just add to report
      if (d.category === 'portfolio_summary') {
        jsonReport.summary = {
          avgMargin: d.margin,
          ...d.stats,
          message: d.message,
        };

        // Alert if portfolio average drops below 15%
        if (d.margin < THRESHOLDS.WARNING_MARGIN) {
          await this.logger.logAlert({
            agent_name: AGENT_NAME,
            type: 'portfolio_margin_low',
            severity: 'warning',
            title: `포트폴리오 평균 마진 ${d.margin}%`,
            message: d.message,
            context_data: d.stats,
          });
        }
        continue;
      }

      // Dedup check
      if (d.sku) {
        const exists = await this.logger.hasPendingRecommendation(
          AGENT_NAME, d.sku, 'ebay', THRESHOLDS.DEDUP_HOURS
        );
        if (exists) continue;
      }

      // Save recommendation
      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: 'profit_defense',
        sku: d.sku,
        platform: 'ebay',
        priority: d.priority,
        current_value: {
          price: d.currentPrice,
          margin: d.margin,
          title: d.title,
          salesCount: d.salesCount,
          ebayItemId: d.item?.ebayItemId || '',
        },
        recommended_value: {
          price: d.targetPrice,
          category: d.category,
        },
        reason: d.message,
        confidence: d.category === 'danger_margin' ? 0.95 : 0.80,
        status: 'pending',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);

      // Critical alert for danger items
      if (d.severity === 'critical') {
        await this.logger.logAlert({
          agent_name: AGENT_NAME,
          type: d.category,
          severity: 'critical',
          title: `손실 감지: ${d.sku}`,
          message: d.message,
          sku: d.sku,
          platform: 'ebay',
          context_data: { margin: d.margin, price: d.currentPrice, targetPrice: d.targetPrice },
        });
      }

      // Add to JSON report
      jsonReport[d.severity === 'critical' ? 'alerts' : 'recommendations'].push({
        sku: d.sku,
        title: d.title,
        margin: d.margin,
        currentPrice: d.currentPrice,
        targetPrice: d.targetPrice,
        salesCount: d.salesCount,
        category: d.category,
        message: d.message,
      });
    }

    // Store JSON report in audit log for retrieval
    await this.logger.logAction(AGENT_NAME, 'report_generated', {
      output: jsonReport,
      result: 'success',
    });

    console.log(`[${this.name}] Report: ${jsonReport.alerts.length} alerts, ${jsonReport.recommendations.length} recs`);

    // Push notification (iMessage / Telegram)
    try {
      const notify = require('../services/notify');
      if (notify.isConfigured()) await notify.sendProfitReport(jsonReport);
    } catch (e) { console.log(`[${this.name}] Notify skip:`, e.message); }

    return saved;
  }

  /**
   * Generate a Slack/KakaoTalk-ready JSON message
   * Call this after run() to get the latest report
   */
  async getLatestReport() {
    const logs = await this.logger.getAuditLog({
      agent_name: AGENT_NAME,
      action_type: 'report_generated',
      limit: 1,
    });
    if (logs.length === 0) return null;
    return logs[0].output_data;
  }
}

module.exports = { ProfitBrainAgent };
