/**
 * Operations Agent — Keywords, Inventory Intelligence, Task Management
 *
 * Analyzes: trending keywords, inventory health, employee workload
 * Generates: reorder alerts, discontinue suggestions, keyword opportunities, auto-tasks
 *
 * Schedule: Daily at 06:00 KST
 */
const { AgentBase } = require('./core/agent-base');
const { KeywordRepository } = require('../db/keywordRepository');
const { TaskRepository } = require('../db/taskRepository');
const { getClient } = require('../db/supabaseClient');

const AGENT_NAME = 'operations-agent';

class OperationsAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
    this.keywordRepo = new KeywordRepository();
    this.taskRepo = new TaskRepository();
  }

  /**
   * Step 1: Collect keywords, inventory data, workload
   */
  async analyze() {
    const db = getClient();

    // --- Keyword extraction from our titles ---
    let ebayProducts = [];
    let from = 0;
    while (true) {
      const { data } = await db.from('ebay_products')
        .select('sku, title, price_usd, sales_count, stock, status')
        .eq('status', 'active')
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      ebayProducts = ebayProducts.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Extract keywords from our titles
    const ourKeywords = this.extractKeywords(ebayProducts.map(p => p.title));

    // --- Competitor keywords ---
    const { data: compData } = await db.from('competitor_prices')
      .select('sku, competitor_id')
      .limit(500);

    // Load competitor titles from ebay_products where we matched
    const compSkus = (compData || []).map(c => c.sku);

    // --- Inventory analysis ---
    const inventoryAnalysis = ebayProducts.map(p => {
      const salesRate = (parseInt(p.sales_count) || 0) / 30; // daily rate
      const stock = parseInt(p.stock) || 0;
      const daysOfInventory = salesRate > 0 ? Math.floor(stock / salesRate) : (stock > 0 ? 999 : 0);

      return {
        sku: p.sku,
        title: p.title,
        price: parseFloat(p.price_usd) || 0,
        stock,
        salesCount: parseInt(p.sales_count) || 0,
        salesRate: +salesRate.toFixed(2),
        daysOfInventory,
      };
    });

    // --- Pending recommendations & messages count ---
    const { count: pendingRecs } = await db.from('agent_recommendations')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending');
    let pendingMessages = 0;
    try {
      const pmResult = await db.from('platform_messages')
        .select('id', { count: 'exact', head: true }).in('status', ['new', 'draft_ready']);
      pendingMessages = pmResult.count || 0;
    } catch (e) { /* table may be empty */ }

    // --- Workload ---
    const workload = await this.taskRepo.getWorkloadSummary();

    console.log(`[${this.name}] ${ebayProducts.length} products, ${ourKeywords.size} unique keywords, ${inventoryAnalysis.length} inventory items`);

    return {
      ebayProducts,
      ourKeywords,
      inventoryAnalysis,
      pendingRecs: pendingRecs || 0,
      pendingMessages: pendingMessages || 0,
      workload,
    };
  }

  /**
   * Step 2: Find opportunities + generate tasks
   */
  async decide(analysis) {
    const decisions = [];

    // --- Inventory: Stockout risk (< 14 days) ---
    const stockoutRisk = analysis.inventoryAnalysis
      .filter(p => p.daysOfInventory < 14 && p.daysOfInventory > 0 && p.salesCount > 0)
      .sort((a, b) => a.daysOfInventory - b.daysOfInventory);

    for (const item of stockoutRisk.slice(0, 20)) {
      decisions.push({
        type: 'reorder_needed',
        priority: item.daysOfInventory < 7 ? 'critical' : 'high',
        sku: item.sku,
        title: item.title,
        stock: item.stock,
        daysLeft: item.daysOfInventory,
        dailyRate: item.salesRate,
        message: `[재주문] ${item.sku} — 재고 ${item.stock}개, ${item.daysOfInventory}일 후 소진 (일 판매 ${item.salesRate}개)`,
      });
    }

    // --- Dead stock (0 sales, 90+ days if stock > 0) ---
    const deadStock = analysis.inventoryAnalysis
      .filter(p => p.salesCount === 0 && p.stock > 0 && p.daysOfInventory === 999)
      .sort((a, b) => b.price - a.price); // most expensive dead stock first

    for (const item of deadStock.slice(0, 10)) {
      decisions.push({
        type: 'discontinue_candidate',
        priority: 'low',
        sku: item.sku,
        title: item.title,
        stock: item.stock,
        price: item.price,
        message: `[퇴출후보] ${item.sku} — $${item.price}, 재고 ${item.stock}개, 판매 0건`,
      });
    }

    // --- Top selling keywords ---
    const keywordOpportunities = [];
    const topKeywords = [...analysis.ourKeywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);

    for (const [keyword, count] of topKeywords) {
      keywordOpportunities.push({
        keyword,
        count,
        platform: 'ebay',
        trend_direction: count > 20 ? 'rising' : 'stable',
        our_coverage: true,
      });
    }

    // --- Auto-generate tasks ---
    if (analysis.pendingRecs > 10) {
      decisions.push({
        type: 'task',
        category: 'general',
        title: `에이전트 제안 ${analysis.pendingRecs}건 검토 필요`,
        priority: 'high',
        message: `[업무] 대기 중 에이전트 제안 ${analysis.pendingRecs}건 — 대시보드에서 승인/기각하세요`,
      });
    }

    if (analysis.pendingMessages > 0) {
      decisions.push({
        type: 'task',
        category: 'cs',
        title: `CS 메시지 ${analysis.pendingMessages}건 응답 필요`,
        priority: 'high',
        message: `[업무] 고객 메시지 ${analysis.pendingMessages}건 초안 준비됨 — 승인 후 발송`,
      });
    }

    if (stockoutRisk.length > 0) {
      decisions.push({
        type: 'task',
        category: 'sourcing',
        title: `재주문 필요 ${stockoutRisk.length}건 (품절 임박)`,
        priority: 'critical',
        message: `[업무] ${stockoutRisk.length}개 상품 14일 내 소진 예상 — 발주 필요`,
      });
    }

    // Store keyword data
    this._keywordData = keywordOpportunities;

    console.log(`[${this.name}] ${decisions.length} ops decisions (${stockoutRisk.length} reorder, ${deadStock.length} dead stock)`);
    return decisions;
  }

  /**
   * Step 3: Save recommendations + keywords + tasks
   */
  async recommend(decisions) {
    const saved = [];

    // Save keyword trends
    for (const kw of (this._keywordData || []).slice(0, 100)) {
      try {
        await this.keywordRepo.upsertKeyword(kw);
      } catch (e) { /* skip dupes */ }
    }

    for (const d of decisions) {
      // Create tasks
      if (d.type === 'task') {
        try {
          await this.taskRepo.createTask({
            title: d.title,
            description: d.message,
            created_by: AGENT_NAME,
            category: d.category || 'general',
            priority: d.priority,
            due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          });
        } catch (e) { /* skip */ }
        continue;
      }

      // Save recommendation
      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: d.type,
        sku: d.sku,
        platform: 'ebay',
        priority: d.priority,
        current_value: {
          title: d.title,
          stock: d.stock,
          daysLeft: d.daysLeft,
          price: d.price,
        },
        recommended_value: {
          type: d.type,
          dailyRate: d.dailyRate,
        },
        reason: d.message,
        confidence: d.type === 'reorder_needed' ? 0.90 : 0.60,
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      if (rec) saved.push(rec);
    }

    // Detailed notification
    const reorderItems = decisions.filter(d => d.type === 'reorder_needed');
    const taskItems = decisions.filter(d => d.type === 'task');
    const deadItems = decisions.filter(d => d.type === 'discontinue_candidate');
    const topKw = (this._keywordData || []).sort((a, b) => b.count - a.count).slice(0, 10);
    try {
      const imessage = require('../services/imessage');
      if (imessage.isConfigured()) {
        await imessage.sendOpsReport({
          reorderCount: reorderItems.length,
          deadStockCount: deadItems.length,
          keywordCount: (this._keywordData || []).length,
          topKeywords: topKw,
          reorderItems: reorderItems.map(d => ({ sku: d.sku, title: d.title, stock: d.stock, daysLeft: d.daysLeft, dailyRate: d.dailyRate })),
          taskCount: taskItems.length,
        });
      }
      const telegram = require('../services/telegramBot');
      if (telegram.isConfigured()) {
        await telegram.sendMessage(`⚙️ *Operations 리포트*\n재주문: ${reorderItems.length}건\n데드스탁: ${deadItems.length}건\n키워드: ${(this._keywordData || []).length}개\n업무: ${taskItems.length}건`);
      }
    } catch (e) { /* skip */ }

    console.log(`[${this.name}] ${saved.length} ops recommendations, ${(this._keywordData || []).length} keywords tracked`);
    return saved;
  }

  /**
   * Extract meaningful keywords from product titles
   */
  extractKeywords(titles) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'been', 'be', 'have', 'has',
      'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
      'new', 'set', 'pack', 'pcs', 'pc', 'lot', 'box', 'size', 'free', 'shipping',
      'korea', 'korean', 'japan', 'japanese', 'us', 'usa', 'uk', '']);

    const keywords = new Map();
    for (const title of titles) {
      if (!title) continue;
      const words = title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w) && !/^\d+$/.test(w));

      for (const word of words) {
        keywords.set(word, (keywords.get(word) || 0) + 1);
      }
    }
    return keywords;
  }
}

module.exports = { OperationsAgent };
