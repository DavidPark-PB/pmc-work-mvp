/**
 * Sync History Repository — persistent sync log (replaces in-memory)
 */
const { getClient } = require('./supabaseClient');

class SyncRepository {
  get db() { return getClient(); }

  async logSync(platform, action, status, itemsSynced = 0, details = {}, errorMessage = '') {
    const { error } = await this.db
      .from('sync_history')
      .insert({
        platform,
        action,
        status,
        items_synced: itemsSynced,
        error_message: errorMessage,
        details,
      });
    if (error) console.error('Sync log error:', error.message);
  }

  async getHistory(limit = 20) {
    const { data, error } = await this.db
      .from('sync_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async getByPlatform(platform, limit = 10) {
    const { data, error } = await this.db
      .from('sync_history')
      .select('*')
      .eq('platform', platform)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async getLatestByPlatform(platform) {
    const { data, error } = await this.db
      .from('sync_history')
      .select('*')
      .eq('platform', platform)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }
}

module.exports = SyncRepository;
