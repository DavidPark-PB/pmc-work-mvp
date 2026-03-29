/**
 * Keyword Repository — CRUD for keyword_trends table
 */
const { getClient } = require('./supabaseClient');

class KeywordRepository {
  get db() { return getClient(); }

  async upsertKeyword(kw) {
    const { data, error } = await this.db
      .from('keyword_trends').insert({
        keyword: kw.keyword,
        platform: kw.platform,
        category: kw.category || '',
        search_volume: kw.search_volume || 0,
        trend_direction: kw.trend_direction || 'stable',
        competition: kw.competition || 'medium',
        our_coverage: kw.our_coverage || false,
        related_skus: kw.related_skus || [],
        data_source: kw.data_source || '',
      }).select().single();
    if (error) throw error;
    return data;
  }

  async getTrendingKeywords(platform, limit = 20) {
    let q = this.db.from('keyword_trends').select('*')
      .eq('trend_direction', 'rising');
    if (platform) q = q.eq('platform', platform);
    q = q.order('search_volume', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async getUncoveredKeywords(limit = 20) {
    const { data, error } = await this.db
      .from('keyword_trends').select('*')
      .eq('our_coverage', false)
      .eq('trend_direction', 'rising')
      .order('search_volume', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }
}

module.exports = { KeywordRepository };
