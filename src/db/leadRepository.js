/**
 * Lead Repository — CRUD for b2b_leads + email_outreach tables
 */
const { getClient } = require('./supabaseClient');

class LeadRepository {
  get db() { return getClient(); }

  // ===== b2b_leads =====

  async upsertLead(lead) {
    const { data, error } = await this.db
      .from('b2b_leads')
      .upsert({
        email: lead.email,
        source: lead.source || 'manual',
        company_name: lead.company_name || '',
        contact_name: lead.contact_name || '',
        phone: lead.phone || '',
        country: lead.country || '',
        platform: lead.platform || '',
        interest: lead.interest || '',
        stage: lead.stage || 'new',
        score: lead.score || 0,
        notes: lead.notes || '',
      }, { onConflict: 'email', ignoreDuplicates: false })
      .select().single();
    if (error && error.code !== '23505') throw error;
    return data;
  }

  async getLeadsByStage(stage) {
    const { data, error } = await this.db
      .from('b2b_leads').select('*').eq('stage', stage).order('score', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async getLeadsNeedingFollowUp() {
    const { data, error } = await this.db
      .from('b2b_leads').select('*')
      .lte('next_follow_up', new Date().toISOString())
      .not('stage', 'in', '("lost","repeat")');
    if (error) throw error;
    return data || [];
  }

  async updateLead(id, updates) {
    const { data, error } = await this.db
      .from('b2b_leads').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async getPipeline() {
    const { data, error } = await this.db
      .from('b2b_leads').select('stage, count:id');
    if (error) throw error;
    const pipeline = {};
    (data || []).forEach(r => { pipeline[r.stage] = (pipeline[r.stage] || 0) + 1; });
    return pipeline;
  }

  // ===== email_outreach =====

  async createEmailDraft(draft) {
    const { data, error } = await this.db
      .from('email_outreach').insert({
        lead_id: draft.lead_id || null,
        buyer_id: draft.buyer_id || null,
        type: draft.type,
        to_email: draft.to_email,
        subject: draft.subject,
        body_html: draft.body_html || '',
        body_text: draft.body_text || '',
        status: 'draft',
      }).select().single();
    if (error) throw error;
    return data;
  }

  async getEmailDrafts(type) {
    let q = this.db.from('email_outreach').select('*').eq('status', 'draft');
    if (type) q = q.eq('type', type);
    q = q.order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async updateEmail(id, updates) {
    const { data, error } = await this.db
      .from('email_outreach').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
}

module.exports = { LeadRepository };
