/**
 * Sourcing Agent — "Our SKU vs Competitor Sellers" Price Battle Report
 *
 * Compares our eBay listings against tracked competitor prices,
 * finds where we're losing, winning, or could optimize.
 *
 * Data sources:
 * - ebay_products: our active listings (5,000+)
 * - competitor_prices: tracked competitor data (850+ records, 821 SKUs)
 *
 * Schedule: Daily at 03:00
 */
const { AgentBase } = require('./core/agent-base');
const { getClient } = require('../db/supabaseClient');
const { EXCHANGE_RATE, PLATFORM_FEES } = require('../services/pricingEngine');

const AGENT_NAME = 'sourcing-agent';

const THRESHOLDS = {
  LOSING_BY_USD: 2.0,       // we're $2+ more expensive → losing
  WINNING_BY_USD: 2.0,      // we're $2+ cheaper → winning (maybe raise price?)
  PRICE_CRASH_PCT: 30,      // competitor dropped 30%+ → suspicious
  DEDUP_HOURS: 48,
};

class SourcingAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
  }

  /**
   * Step 1: Load our products + all competitor data, join by SKU
   */
  async analyze() {
    const db = getClient();

    // Load our eBay products
    let ourProducts = [];
    let from = 0;
    while (true) {
      const { data } = await db.from('ebay_products')
        .select('sku, title, item_id, price_usd, shipping_usd, sales_count, stock, status')
        .eq('status', 'active')
        .gt('price_usd', 0)
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      ourProducts = ourProducts.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Build our product map
    const ourMap = {};
    for (const p of ourProducts) {
      ourMap[p.sku] = p;
    }

    // Load all competitor prices
    let allComps = [];
    from = 0;
    while (true) {
      const { data } = await db.from('competitor_prices')
        .select('sku, competitor_price, competitor_shipping, competitor_id, seller_id, prev_price, status, tracked_at')
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      allComps = allComps.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Group competitors by our SKU
    const battleMap = {}; // sku → { our, competitors[] }
    for (const c of allComps) {
      const ourProduct = ourMap[c.sku];
      if (!ourProduct) continue; // only care about SKUs we're selling

      if (!battleMap[c.sku]) {
        battleMap[c.sku] = {
          our: ourProduct,
          competitors: [],
        };
      }
      battleMap[c.sku].competitors.push(c);
    }

    console.log(`[${this.name}] ${ourProducts.length} our products, ${Object.keys(battleMap).length} with competitor data`);
    return Object.values(battleMap);
  }

  /**
   * Step 2: Compare our price vs each competitor, classify battles
   */
  async decide(analysis) {
    const decisions = [];
    const report = {
      totalBattles: analysis.length,
      losing: [],
      winning: [],
      competitive: [],
      suspicious: [],
    };

    for (const battle of analysis) {
      const our = battle.our;
      const ourTotal = parseFloat(our.price_usd) + parseFloat(our.shipping_usd || 3.9);

      // Find cheapest active competitor
      const activeComps = battle.competitors.filter(c => c.status !== 'ended');
      if (activeComps.length === 0) continue;

      const compTotals = activeComps.map(c => ({
        ...c,
        total: parseFloat(c.competitor_price) + parseFloat(c.competitor_shipping || 0),
      }));
      compTotals.sort((a, b) => a.total - b.total);

      const cheapest = compTotals[0];
      const diff = ourTotal - cheapest.total; // positive = we're more expensive

      // Suspicious: competitor crashed price
      if (cheapest.prev_price > 0) {
        const dropPct = (cheapest.prev_price - cheapest.competitor_price) / cheapest.prev_price * 100;
        if (dropPct > THRESHOLDS.PRICE_CRASH_PCT) {
          report.suspicious.push({
            sku: our.sku,
            seller: cheapest.seller_id,
            oldPrice: cheapest.prev_price,
            newPrice: cheapest.competitor_price,
            dropPct: +dropPct.toFixed(0),
          });
        }
      }

      const battleResult = {
        sku: our.sku,
        title: our.title,
        ourTotal: +ourTotal.toFixed(2),
        ourPrice: parseFloat(our.price_usd),
        cheapestTotal: +cheapest.total.toFixed(2),
        cheapestSeller: cheapest.seller_id || cheapest.competitor_id,
        diff: +diff.toFixed(2),
        competitorCount: activeComps.length,
        salesCount: parseInt(our.sales_count) || 0,
        itemId: our.item_id,
      };

      // We're LOSING (more expensive by $2+)
      if (diff > THRESHOLDS.LOSING_BY_USD) {
        report.losing.push(battleResult);
        decisions.push({
          ...battleResult,
          category: 'losing_battle',
          priority: diff > 5 ? 'critical' : 'high',
          message: `[패배] ${our.sku} — 우리 $${ourTotal.toFixed(2)} vs 경쟁 $${cheapest.total.toFixed(2)} (${cheapest.seller_id}). $${diff.toFixed(2)} 비쌈. 판매 ${battleResult.salesCount}건`,
        });
      }
      // We're WINNING (cheaper by $2+) with sales → maybe raise price
      else if (diff < -THRESHOLDS.WINNING_BY_USD && battleResult.salesCount > 0) {
        report.winning.push(battleResult);
        decisions.push({
          ...battleResult,
          category: 'winning_opportunity',
          priority: 'medium',
          message: `[가격인상기회] ${our.sku} — 우리 $${ourTotal.toFixed(2)} vs 경쟁 $${cheapest.total.toFixed(2)}. $${Math.abs(diff).toFixed(2)} 저렴. 매출 ${battleResult.salesCount}건. 가격 인상 여지.`,
        });
      }
      // Competitive (within $2)
      else {
        report.competitive.push(battleResult);
      }
    }

    // Store full report in audit log
    await this.logger.logAction(AGENT_NAME, 'battle_report', {
      output: {
        totalBattles: report.totalBattles,
        losing: report.losing.length,
        winning: report.winning.length,
        competitive: report.competitive.length,
        suspicious: report.suspicious.length,
        topLosing: report.losing.slice(0, 10),
        topWinning: report.winning.slice(0, 10),
        suspicious: report.suspicious.slice(0, 5),
      },
      result: 'success',
    });

    console.log(`[${this.name}] Battle report: ${report.losing.length} losing, ${report.winning.length} winning, ${report.competitive.length} competitive, ${report.suspicious.length} suspicious`);
    return decisions;
  }

  /**
   * Step 3: Save recommendations
   */
  async recommend(decisions) {
    const saved = [];

    for (const d of decisions) {
      const exists = await this.logger.hasPendingRecommendation(
        AGENT_NAME, d.sku, 'ebay', THRESHOLDS.DEDUP_HOURS
      );
      if (exists) continue;

      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: d.category === 'losing_battle' ? 'price_competitive' : 'price_increase',
        sku: d.sku,
        platform: 'ebay',
        priority: d.priority,
        current_value: {
          title: d.title,
          ourTotal: d.ourTotal,
          ourPrice: d.ourPrice,
          salesCount: d.salesCount,
          ebayItemId: d.itemId,
        },
        recommended_value: {
          cheapestTotal: d.cheapestTotal,
          cheapestSeller: d.cheapestSeller,
          diff: d.diff,
          competitorCount: d.competitorCount,
          category: d.category,
        },
        reason: d.message,
        confidence: d.category === 'losing_battle' ? 0.85 : 0.70,
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);
    }

    // Push detailed notification
    try {
      const losing = decisions.filter(d => d.category === 'losing_battle');
      const winning = decisions.filter(d => d.category === 'winning_opportunity');

      const imessage = require('../services/imessage');
      if (imessage.isConfigured()) {
        // Get battle report from audit log (just saved above in decide())
        const reportLogs = await this.logger.getAuditLog({ agent_name: AGENT_NAME, action_type: 'battle_report', limit: 1 });
        const reportData = reportLogs[0]?.output_data || {};
        await imessage.sendBattleReport({
          losing: losing.length,
          winning: winning.length,
          competitive: reportData.competitive || 0,
          suspicious: reportData.suspicious?.length || 0,
          topLosing: (reportData.topLosing || losing).slice(0, 5),
          topWinning: (reportData.topWinning || winning).slice(0, 3),
          suspicious: reportData.suspicious || [],
        });
      }

      const telegram = require('../services/telegramBot');
      if (telegram.isConfigured()) {
        const lines = [`⚔️ *경쟁사 가격 비교*`, '', `🔴 패배: ${losing.length} | 🟢 인상: ${winning.length}`];
        losing.slice(0, 5).forEach(d => lines.push(`• \`${d.sku}\` $${d.ourTotal} vs $${d.cheapestTotal}`));
        await telegram.sendMessage(lines.join('\n'));
      }
    } catch (e) { console.log(`[${this.name}] Notify skip:`, e.message); }

    console.log(`[${this.name}] Saved ${saved.length} battle recommendations`);
    return saved;
  }

  /**
   * Get the latest battle report
   */
  async getLatestBattleReport() {
    const logs = await this.logger.getAuditLog({
      agent_name: AGENT_NAME,
      action_type: 'battle_report',
      limit: 1,
    });
    if (logs.length === 0) return null;
    return logs[0].output_data;
  }
}

module.exports = { SourcingAgent };
