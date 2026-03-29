/**
 * Message Repository — CRUD for platform_messages table
 */
const { getClient } = require('./supabaseClient');

class MessageRepository {
  get db() { return getClient(); }

  async upsertMessage(msg) {
    const { data, error } = await this.db
      .from('platform_messages')
      .upsert({
        platform: msg.platform,
        message_id: msg.message_id,
        thread_id: msg.thread_id || null,
        direction: msg.direction || 'inbound',
        sender: msg.sender || '',
        recipient: msg.recipient || '',
        subject: msg.subject || '',
        body: msg.body || '',
        item_id: msg.item_id || null,
        order_id: msg.order_id || null,
        sku: msg.sku || null,
        category: msg.category || 'general',
        language: msg.language || 'en',
        status: msg.status || 'new',
      }, { onConflict: 'platform,message_id' })
      .select().single();
    if (error) throw error;
    return data;
  }

  async getNewMessages(platform) {
    let q = this.db.from('platform_messages').select('*').eq('status', 'new');
    if (platform) q = q.eq('platform', platform);
    q = q.order('created_at', { ascending: true });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async getPendingMessages(filters = {}) {
    let q = this.db.from('platform_messages').select('*')
      .in('status', ['new', 'draft_ready']);
    if (filters.platform) q = q.eq('platform', filters.platform);
    q = q.order('created_at', { ascending: false });
    if (filters.limit) q = q.limit(filters.limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async updateMessage(id, updates) {
    const { data, error } = await this.db
      .from('platform_messages').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async getById(id) {
    const { data, error } = await this.db
      .from('platform_messages').select('*').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }
}

module.exports = { MessageRepository };
