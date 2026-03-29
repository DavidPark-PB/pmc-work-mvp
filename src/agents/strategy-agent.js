/**
 * Strategy Agent — Morning Briefing & Cross-Agent Coordinator
 *
 * Aggregates reports from all other agents and generates
 * a daily executive briefing in JSON format.
 *
 * Output: structured briefing ready for Slack/KakaoTalk push.
 *
 * Schedule: Daily at 08:00 KST
 */
const { AgentBase } = require('./core/agent-base');
const { getClient } = require('../db/supabaseClient');
const ProductRepository = require('../db/productRepository');
const { EXCHANGE_RATE, PLATFORM_FEES } = require('../services/pricingEngine');

const AGENT_NAME = 'strategy-agent';

class StrategyAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
    this.productRepo = new ProductRepository();
  }

  /**
   * Step 1: Gather data from all agent outputs + business metrics
   */
  async analyze() {
    const db = getClient();
    const now = new Date();
    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const lastWeek = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Pending recommendations from all agents
    const { data: pendingRecs, count: pendingCount } = await db
      .from('agent_recommendations')
      .select('agent_name, type, priority, sku', { count: 'exact' })
      .eq('status', 'pending');

    // 2. Unread alerts
    const { data: unreadAlerts, count: alertCount } = await db
      .from('agent_alerts')
      .select('agent_name, type, severity, title, sku', { count: 'exact' })
      .eq('is_read', false);

    // 3. Yesterday's executed actions
    const { data: executedYesterday } = await db
      .from('agent_recommendations')
      .select('agent_name, type, sku, execution_result')
      .eq('status', 'executed')
      .gte('executed_at', yesterday);

    // 4. Recent agent run logs
    const { data: recentRuns } = await db
      .from('audit_logs')
      .select('agent_name, action_type, created_at, output_data, result')
      .in('action_type', ['run_complete', 'run_error', 'report_generated'])
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false });

    // 5. Business metrics — recent orders
    const { data: recentOrders } = await db
      .from('orders')
      .select('platform, total_amount, currency, created_at')
      .gte('created_at', lastWeek);

    // 6. Product stats
    const products = await this.productRepo.getDashboardProducts();

    // 7. Competitor activity
    const { data: compAlerts } = await db
      .from('competitor_alerts')
      .select('type, sku, data, created_at')
      .gte('created_at', yesterday)
      .limit(20);

    return {
      pendingRecs: pendingRecs || [],
      pendingCount: pendingCount || 0,
      unreadAlerts: unreadAlerts || [],
      alertCount: alertCount || 0,
      executedYesterday: executedYesterday || [],
      recentRuns: recentRuns || [],
      recentOrders: recentOrders || [],
      products,
      compAlerts: compAlerts || [],
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Step 2: Synthesize into an executive briefing
   */
  async decide(analysis) {
    // Revenue summary (last 7 days)
    let totalRevenueUSD = 0;
    let orderCount = 0;
    const platformRevenue = {};
    for (const o of analysis.recentOrders) {
      const amt = parseFloat(o.total_amount) || 0;
      orderCount++;
      if (o.currency === 'USD') totalRevenueUSD += amt;
      else if (o.currency === 'KRW') totalRevenueUSD += amt / EXCHANGE_RATE;
      else totalRevenueUSD += amt;
      platformRevenue[o.platform] = (platformRevenue[o.platform] || 0) + 1;
    }

    // Product health
    let activeProducts = 0;
    let zeroStockCount = 0;
    let totalMargin = 0;
    let marginCount = 0;
    for (const p of analysis.products) {
      if (parseInt(p.stock) > 0) activeProducts++;
      else zeroStockCount++;
      const margin = parseFloat(p.margin);
      if (!isNaN(margin) && margin !== 0) {
        totalMargin += margin;
        marginCount++;
      }
    }
    const avgMargin = marginCount > 0 ? totalMargin / marginCount : 0;

    // Agent status
    const agentStatus = {};
    for (const run of analysis.recentRuns) {
      if (!agentStatus[run.agent_name]) {
        agentStatus[run.agent_name] = {
          lastRun: run.created_at,
          result: run.result,
          output: run.output_data,
        };
      }
    }

    // Priority actions (from pending recommendations)
    const priorityBuckets = { critical: [], high: [], medium: [] };
    for (const rec of analysis.pendingRecs) {
      if (priorityBuckets[rec.priority]) {
        priorityBuckets[rec.priority].push(rec);
      }
    }

    // Competitor threats
    const competitorThreats = analysis.compAlerts.filter(a => a.type === 'price_crash' || a.type === 'price_change');

    return [{
      category: 'morning_briefing',
      briefing: {
        date: new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),

        // Revenue
        revenue: {
          last7days: +totalRevenueUSD.toFixed(2),
          orderCount,
          topPlatform: Object.entries(platformRevenue).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A',
          platformBreakdown: platformRevenue,
        },

        // Product health
        products: {
          total: analysis.products.length,
          active: activeProducts,
          outOfStock: zeroStockCount,
          avgMargin: +avgMargin.toFixed(1),
        },

        // Agent reports
        agentTeam: {
          totalPending: analysis.pendingCount,
          unreadAlerts: analysis.alertCount,
          executedYesterday: analysis.executedYesterday.length,
          status: agentStatus,
        },

        // Top priority actions
        actionItems: {
          critical: priorityBuckets.critical.length,
          high: priorityBuckets.high.length,
          medium: priorityBuckets.medium.length,
          topActions: [
            ...priorityBuckets.critical.slice(0, 3).map(r => `[긴급] ${r.agent_name}: ${r.sku} — ${r.type}`),
            ...priorityBuckets.high.slice(0, 3).map(r => `[중요] ${r.agent_name}: ${r.sku} — ${r.type}`),
          ],
        },

        // Competitor intelligence
        competitors: {
          alertsToday: competitorThreats.length,
          highlights: competitorThreats.slice(0, 3).map(a => `${a.sku}: ${a.type}`),
        },
      },
    }];
  }

  /**
   * Step 3: Store briefing and create notification
   */
  async recommend(decisions) {
    const saved = [];

    for (const d of decisions) {
      if (d.category !== 'morning_briefing') continue;

      // Store briefing as a special recommendation
      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: 'daily_briefing',
        sku: null,
        platform: null,
        priority: d.briefing.actionItems.critical > 0 ? 'high' : 'medium',
        current_value: {
          revenue: d.briefing.revenue,
          products: d.briefing.products,
        },
        recommended_value: {
          actionItems: d.briefing.actionItems,
          competitors: d.briefing.competitors,
          agentTeam: d.briefing.agentTeam,
        },
        reason: this.formatBriefingText(d.briefing),
        confidence: 0.90,
        status: 'pending',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);

      // Store full JSON report in audit log
      await this.logger.logAction(AGENT_NAME, 'briefing_generated', {
        output: d.briefing,
        result: 'success',
      });

      // Alert if there are critical items
      if (d.briefing.actionItems.critical > 0) {
        await this.logger.logAlert({
          agent_name: AGENT_NAME,
          type: 'morning_briefing',
          severity: 'warning',
          title: `아침 브리핑: 긴급 ${d.briefing.actionItems.critical}건`,
          message: this.formatBriefingText(d.briefing),
          context_data: d.briefing,
        });
      }

      // Push notification (iMessage / Telegram)
      try {
        const notify = require('../services/notify');
        if (notify.isConfigured()) await notify.sendMorningBriefing(d.briefing);
      } catch (e) { console.log(`[${this.name}] Notify skip:`, e.message); }
    }

    return saved;
  }

  /**
   * Format briefing as readable text (for Slack/KakaoTalk)
   */
  formatBriefingText(b) {
    const lines = [
      `PMC 아침 브리핑 — ${b.date}`,
      ``,
      `[매출] 최근 7일: $${b.revenue.last7days} (${b.revenue.orderCount}건)`,
      `[상품] 총 ${b.products.total}개 | 재고있음 ${b.products.active}개 | 품절 ${b.products.outOfStock}개 | 평균마진 ${b.products.avgMargin}%`,
      ``,
      `[에이전트] 대기 ${b.agentTeam.totalPending}건 | 미읽음 알림 ${b.agentTeam.unreadAlerts}건 | 어제 실행 ${b.agentTeam.executedYesterday}건`,
      ``,
      `[오늘 할 일]`,
      `  긴급: ${b.actionItems.critical}건 | 중요: ${b.actionItems.high}건 | 보통: ${b.actionItems.medium}건`,
    ];

    if (b.actionItems.topActions.length > 0) {
      lines.push(...b.actionItems.topActions.map(a => `  → ${a}`));
    }

    if (b.competitors.alertsToday > 0) {
      lines.push(``, `[경쟁사] ${b.competitors.alertsToday}건 가격변동`);
      lines.push(...b.competitors.highlights.map(h => `  → ${h}`));
    }

    return lines.join('\n');
  }

  /**
   * Get the latest briefing JSON (for external push services)
   */
  async getLatestBriefing() {
    const logs = await this.logger.getAuditLog({
      agent_name: AGENT_NAME,
      action_type: 'briefing_generated',
      limit: 1,
    });
    if (logs.length === 0) return null;
    return logs[0].output_data;
  }
}

module.exports = { StrategyAgent };
