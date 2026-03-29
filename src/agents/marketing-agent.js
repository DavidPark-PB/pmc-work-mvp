/**
 * Marketing Agent — Listing Optimization + Competitive Strategy
 *
 * Analyzes: title quality, pricing strategy, category performance, cross-platform gaps
 * Generates: title rewrites, promoted listing candidates, seasonal alerts
 *
 * Schedule: Weekly Monday 07:00 KST
 */
const { AgentBase } = require('./core/agent-base');
const { getClient } = require('../db/supabaseClient');
const { EXCHANGE_RATE, PLATFORM_FEES } = require('../services/pricingEngine');

const AGENT_NAME = 'marketing-agent';

const EBAY_TITLE_MAX = 80;

class MarketingAgent extends AgentBase {
  constructor() {
    super(AGENT_NAME);
  }

  /**
   * Step 1: Audit listings, analyze categories, find gaps
   */
  async analyze() {
    const db = getClient();

    // Load eBay products
    let ebayProducts = [];
    let from = 0;
    while (true) {
      const { data } = await db.from('ebay_products')
        .select('sku, title, price_usd, shipping_usd, sales_count, stock, status, image_url')
        .eq('status', 'active')
        .gt('price_usd', 0)
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      ebayProducts = ebayProducts.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // Load Shopify products for cross-platform comparison
    const { data: shopifyProducts } = await db.from('shopify_products')
      .select('sku, title, price, status')
      .eq('status', 'active');

    const shopifySkus = new Set((shopifyProducts || []).map(p => p.sku));

    // Load competitor titles for keyword analysis
    const { data: compData } = await db.from('competitor_prices')
      .select('sku, competitor_price, competitor_shipping, seller_id')
      .order('tracked_at', { ascending: false })
      .limit(1000);

    // Categorize products by keywords
    const categories = this.categorizeProducts(ebayProducts);

    console.log(`[${this.name}] ${ebayProducts.length} eBay products, ${shopifySkus.size} Shopify, ${Object.keys(categories).length} categories`);

    return { ebayProducts, shopifySkus, compData: compData || [], categories };
  }

  /**
   * Step 2: Generate optimization recommendations
   */
  async decide(analysis) {
    const decisions = [];

    // --- 1. Title Optimization ---
    for (const p of analysis.ebayProducts) {
      const issues = this.auditTitle(p.title);
      if (issues.length > 0) {
        decisions.push({
          type: 'title_optimization',
          priority: issues.includes('too_short') ? 'high' : 'medium',
          sku: p.sku,
          title: p.title,
          issues,
          suggestedTitle: this.optimizeTitle(p.title, issues),
          salesCount: parseInt(p.sales_count) || 0,
          message: `[제목최적화] ${p.sku} — 문제: ${issues.join(', ')}. "${p.title.substring(0, 50)}..."`,
        });
      }
    }

    // Limit title suggestions to top 20 (most impactful)
    const titleDecisions = decisions.filter(d => d.type === 'title_optimization');
    const keptTitles = titleDecisions
      .sort((a, b) => b.salesCount - a.salesCount)
      .slice(0, 20);
    const removedTitleSkus = new Set(titleDecisions.filter(d => !keptTitles.includes(d)).map(d => d.sku));
    const filteredDecisions = decisions.filter(d => d.type !== 'title_optimization' || !removedTitleSkus.has(d.sku));

    // --- 2. Promoted Listings Candidates ---
    // High margin + stock > 0 + low sales → needs promotion
    const promoCandidates = analysis.ebayProducts
      .filter(p => {
        const price = parseFloat(p.price_usd) || 0;
        const sales = parseInt(p.sales_count) || 0;
        const stock = parseInt(p.stock) || 0;
        return price > 10 && stock > 5 && sales < 3; // high value, in stock, low sales
      })
      .sort((a, b) => parseFloat(b.price_usd) - parseFloat(a.price_usd))
      .slice(0, 15);

    for (const p of promoCandidates) {
      filteredDecisions.push({
        type: 'promoted_listing',
        priority: 'medium',
        sku: p.sku,
        title: p.title,
        price: parseFloat(p.price_usd),
        stock: parseInt(p.stock),
        salesCount: parseInt(p.sales_count) || 0,
        suggestedAdRate: parseFloat(p.price_usd) > 50 ? 2 : 3, // % of sale price
        message: `[광고추천] ${p.sku} — $${p.price_usd}, 재고 ${p.stock}, 판매 ${p.sales_count}. 추천 광고비율 ${parseFloat(p.price_usd) > 50 ? 2 : 3}%`,
      });
    }

    // --- 3. Cross-platform gaps ---
    const gapProducts = analysis.ebayProducts
      .filter(p => {
        const sales = parseInt(p.sales_count) || 0;
        return sales >= 5 && !analysis.shopifySkus.has(p.sku);
      })
      .sort((a, b) => parseInt(b.sales_count) - parseInt(a.sales_count))
      .slice(0, 10);

    for (const p of gapProducts) {
      filteredDecisions.push({
        type: 'cross_platform_gap',
        priority: 'medium',
        sku: p.sku,
        title: p.title,
        ebaySales: parseInt(p.sales_count),
        missingOn: 'shopify',
        message: `[크로스플랫폼] ${p.sku} — eBay ${p.sales_count}건 판매, Shopify 미등록`,
      });
    }

    // --- 4. Category Performance Summary ---
    for (const [cat, products] of Object.entries(analysis.categories)) {
      const totalSales = products.reduce((s, p) => s + (parseInt(p.sales_count) || 0), 0);
      const avgPrice = products.reduce((s, p) => s + (parseFloat(p.price_usd) || 0), 0) / products.length;
      const totalStock = products.reduce((s, p) => s + (parseInt(p.stock) || 0), 0);

      if (totalSales > 10) {
        filteredDecisions.push({
          type: 'category_insight',
          priority: 'low',
          category: cat,
          productCount: products.length,
          totalSales,
          avgPrice: +avgPrice.toFixed(2),
          totalStock,
          message: `[카테고리] ${cat}: ${products.length}개 상품, ${totalSales}건 판매, 평균 $${avgPrice.toFixed(0)}, 재고 ${totalStock}`,
        });
      }
    }

    console.log(`[${this.name}] ${filteredDecisions.length} marketing recommendations`);
    return filteredDecisions;
  }

  /**
   * Step 3: Save recommendations
   */
  async recommend(decisions) {
    const saved = [];

    for (const d of decisions) {
      if (d.type === 'category_insight') {
        // Log insight but don't create recommendation
        await this.logger.logAction(AGENT_NAME, 'category_analysis', {
          decision: d.category,
          output: { productCount: d.productCount, totalSales: d.totalSales, avgPrice: d.avgPrice },
        });
        continue;
      }

      const rec = await this.logger.logRecommendation({
        agent_name: AGENT_NAME,
        type: d.type,
        sku: d.sku,
        platform: d.type === 'cross_platform_gap' ? d.missingOn : 'ebay',
        priority: d.priority,
        current_value: {
          title: d.title,
          price: d.price,
          salesCount: d.salesCount || d.ebaySales,
          stock: d.stock,
        },
        recommended_value: {
          suggestedTitle: d.suggestedTitle,
          issues: d.issues,
          suggestedAdRate: d.suggestedAdRate,
          missingOn: d.missingOn,
          type: d.type,
        },
        reason: d.message,
        confidence: d.type === 'cross_platform_gap' ? 0.85 : 0.70,
        status: 'pending',
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 2 weeks
      });

      if (rec) saved.push(rec);
    }

    // Detailed weekly notification
    const titleFixes = decisions.filter(d => d.type === 'title_optimization');
    const promoItems = decisions.filter(d => d.type === 'promoted_listing');
    const gapItems = decisions.filter(d => d.type === 'cross_platform_gap');
    const catInsights = decisions.filter(d => d.type === 'category_insight');
    try {
      const imessage = require('../services/imessage');
      if (imessage.isConfigured()) {
        await imessage.sendMarketingReport({
          titleCount: titleFixes.length,
          promoCount: promoItems.length,
          gapCount: gapItems.length,
          categories: catInsights.map(c => ({ name: c.category, productCount: c.productCount, totalSales: c.totalSales, avgPrice: c.avgPrice })),
          topTitleFixes: titleFixes.slice(0, 3).map(d => ({ before: d.title, after: d.suggestedTitle })),
          topPromos: promoItems.slice(0, 3).map(d => ({ title: d.title, price: d.price, stock: d.stock })),
        });
      }
      const telegram = require('../services/telegramBot');
      if (telegram.isConfigured()) {
        await telegram.sendMessage(`📢 *Marketing 주간*\n제목: ${titleFixes.length}건\n광고: ${promoItems.length}건\n크로스플랫폼: ${gapItems.length}건`);
      }
    } catch (e) { /* skip */ }

    console.log(`[${this.name}] ${saved.length} marketing recommendations saved`);
    return saved;
  }

  // ===== Helpers =====

  auditTitle(title) {
    const issues = [];
    if (!title) return ['empty'];
    if (title.length < 40) issues.push('too_short');
    if (title.length > EBAY_TITLE_MAX) issues.push('too_long');
    if (title === title.toUpperCase()) issues.push('all_caps');
    if (/[!]{2,}|[?]{2,}|FREE|SALE|DISCOUNT/i.test(title)) issues.push('spammy_words');
    if (!/\d/.test(title) && title.length < 60) issues.push('no_specifics'); // no numbers (size, count, etc.)
    return issues;
  }

  optimizeTitle(title, issues) {
    let optimized = title;
    if (issues.includes('all_caps')) {
      optimized = title.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    if (issues.includes('too_long')) {
      optimized = optimized.substring(0, EBAY_TITLE_MAX);
    }
    if (issues.includes('spammy_words')) {
      optimized = optimized.replace(/FREE|SALE|DISCOUNT|!!+|\?\?+/gi, '').replace(/\s{2,}/g, ' ').trim();
    }
    // Add "Korean" or "Authentic" if room
    if (optimized.length < 65 && !/korean|authentic|official|genuine/i.test(optimized)) {
      optimized = 'Korean ' + optimized;
    }
    return optimized.substring(0, EBAY_TITLE_MAX);
  }

  categorizeProducts(products) {
    const categories = {};
    const patterns = {
      'K-POP': /bts|blackpink|twice|exo|nct|stray kids|seventeen|newjeans|aespa|ive|le sserafim|txt|enhypen|ateez|kpop|k-pop|photocard|album/i,
      'Pokemon': /pokemon|pikachu|charizard|tcg|booster|pok[eé]mon/i,
      'Sanrio': /sanrio|hello kitty|kuromi|cinnamoroll|my melody|pompompurin|pochacco/i,
      'Anime': /anime|manga|one piece|naruto|dragon ball|demon slayer|jujutsu|spy.*family/i,
      'Character': /disney|marvel|snoopy|minion|shin.?chan|doraemon|pororo|pinkfong/i,
      'Beauty': /skincare|mask|serum|cream|cosmetic|beauty|makeup/i,
      'Food': /ramen|noodle|snack|candy|tea|coffee|kimchi/i,
    };

    for (const p of products) {
      let matched = false;
      for (const [cat, regex] of Object.entries(patterns)) {
        if (regex.test(p.title)) {
          if (!categories[cat]) categories[cat] = [];
          categories[cat].push(p);
          matched = true;
          break;
        }
      }
      if (!matched) {
        if (!categories['Other']) categories['Other'] = [];
        categories['Other'].push(p);
      }
    }
    return categories;
  }
}

module.exports = { MarketingAgent };
