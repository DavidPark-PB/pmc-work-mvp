/**
 * SKU Score Repository — Supabase replacement for sku-scores.json + price-history.json
 */
const { getClient } = require('./supabaseClient');

class SkuScoreRepository {
  get db() { return getClient(); }

  // ─── SKU Scores ───

  async getAllScores() {
    const { data, error } = await this.db
      .from('sku_scores')
      .select('*')
      .order('normalized_score', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async getScoreBySku(sku) {
    const { data, error } = await this.db
      .from('sku_scores')
      .select('*')
      .eq('sku', sku)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async upsertScore(entry) {
    const row = {
      sku: entry.sku,
      title: entry.title || '',
      selling_price: entry.rawData?.sellingPrice || 0,
      purchase_price: entry.rawData?.purchasePrice || 0,
      platform_fees: entry.rawData?.platformFees || '',
      net_margin_pct: entry.rawData?.netMarginPct || 0,
      sales_30d: entry.rawData?.sales30d || 0,
      competitor_count: entry.rawData?.competitorCount || 0,
      bundle_item_count: entry.rawData?.bundleItemCount || 0,
      price_fluctuation_pct: entry.rawData?.priceFluctuationPct || 0,
      score_net_margin: entry.scores?.netMargin || {},
      score_turnover: entry.scores?.turnover || {},
      score_competition: entry.scores?.competition || {},
      score_shipping_eff: entry.scores?.shippingEfficiency || {},
      score_price_stability: entry.scores?.priceStability || {},
      total_score: entry.totalScore || 0,
      max_possible: entry.maxPossibleScore || 100,
      normalized_score: entry.normalizedScore || 0,
      classification: entry.classification || 'D',
      purchase_allowed: entry.purchaseDecision?.allowed || false,
      purchase_reason: entry.purchaseDecision?.reason || '',
      auto_retirement: entry.autoRetirement || {},
      manual_overrides: entry.manualOverrides || {},
      calculated_at: entry.calculatedAt || new Date().toISOString(),
    };

    const { error } = await this.db
      .from('sku_scores')
      .upsert(row, { onConflict: 'sku' });
    if (error) throw error;
  }

  async batchUpsertScores(entries) {
    if (!entries.length) return;
    const rows = entries.map(entry => ({
      sku: entry.sku,
      title: entry.title || '',
      selling_price: entry.rawData?.sellingPrice || 0,
      purchase_price: entry.rawData?.purchasePrice || 0,
      net_margin_pct: entry.rawData?.netMarginPct || 0,
      sales_30d: entry.rawData?.sales30d || 0,
      score_net_margin: entry.scores?.netMargin || {},
      score_turnover: entry.scores?.turnover || {},
      score_competition: entry.scores?.competition || {},
      score_shipping_eff: entry.scores?.shippingEfficiency || {},
      score_price_stability: entry.scores?.priceStability || {},
      total_score: entry.totalScore || 0,
      normalized_score: entry.normalizedScore || 0,
      classification: entry.classification || 'D',
      purchase_allowed: entry.purchaseDecision?.allowed || false,
      purchase_reason: entry.purchaseDecision?.reason || '',
      auto_retirement: entry.autoRetirement || {},
      manual_overrides: entry.manualOverrides || {},
      calculated_at: entry.calculatedAt || new Date().toISOString(),
    }));

    const { error } = await this.db
      .from('sku_scores')
      .upsert(rows, { onConflict: 'sku' });
    if (error) throw error;
  }

  async updateManualOverride(sku, overrides) {
    const { error } = await this.db
      .from('sku_scores')
      .update({ manual_overrides: overrides })
      .eq('sku', sku);
    if (error) throw error;
  }

  async getSummary() {
    const { data, error } = await this.db
      .from('sku_scores')
      .select('classification, normalized_score');
    if (error) throw error;

    const counts = { A: 0, B: 0, C: 0, D: 0 };
    let totalScore = 0;
    (data || []).forEach(r => {
      counts[r.classification] = (counts[r.classification] || 0) + 1;
      totalScore += parseFloat(r.normalized_score) || 0;
    });

    return {
      total: data?.length || 0,
      gradeDistribution: counts,
      avgScore: data?.length ? Math.round(totalScore / data.length * 10) / 10 : 0,
    };
  }

  // ─── Score History ───

  async addHistory(sku, entry) {
    const row = {
      sku,
      date: entry.date || new Date().toISOString().split('T')[0],
      total_score: entry.totalScore || 0,
      normalized_score: entry.normalizedScore || 0,
      classification: entry.classification || 'D',
    };

    const { error } = await this.db
      .from('sku_score_history')
      .upsert(row, { onConflict: 'sku,date' });
    if (error) throw error;
  }

  async getHistory(sku, limit = 90) {
    const { data, error } = await this.db
      .from('sku_score_history')
      .select('*')
      .eq('sku', sku)
      .order('date', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  // ─── Price History ───

  async addPriceSnapshot(sku, date, price, platform = 'ebay') {
    const { error } = await this.db
      .from('price_history')
      .upsert({
        sku, date, price: parseFloat(price), platform
      }, { onConflict: 'sku,date,platform' });
    if (error) throw error;
  }

  async batchAddPriceSnapshots(snapshots) {
    if (!snapshots.length) return;
    const { error } = await this.db
      .from('price_history')
      .upsert(snapshots, { onConflict: 'sku,date,platform' });
    if (error) throw error;
  }

  async getPriceHistory(sku, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await this.db
      .from('price_history')
      .select('*')
      .eq('sku', sku)
      .gte('date', since.toISOString().split('T')[0])
      .order('date', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async getPriceFluctuation(sku, days = 30) {
    const history = await this.getPriceHistory(sku, days);
    if (history.length < 2) return 0;

    const prices = history.map(h => parseFloat(h.price));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === 0) return 0;
    return Math.round((max - min) / min * 100 * 10) / 10;
  }
}

module.exports = SkuScoreRepository;
