/**
 * Audit Logger — Central logging for all agent actions
 * Tables: agent_audit_logs, agent_recommendations, agent_alerts
 */
const { getClient } = require('../../db/supabaseClient');

class AuditLogger {
  get db() { return getClient(); }

  // ===== agent_audit_logs =====

  async logAction(agentName, actionType, data = {}) {
    const row = {
      agent_name: agentName,
      action_type: actionType,
      sku: data.sku || null,
      platform: data.platform || null,
      decision: data.decision || '',
      reason: data.reason || '',
      confidence: data.confidence ?? null,
      input_data: data.input || {},
      output_data: data.output || {},
      result: data.result || 'success',
      duration_ms: data.duration_ms || 0,
    };
    const { error } = await this.db.from('agent_audit_logs').insert(row);
    if (error) console.error('[AuditLogger] logAction error:', error.message);
  }

  // ===== agent_recommendations =====

  async logRecommendation(rec) {
    const row = {
      agent_name: rec.agent_name,
      type: rec.type,
      sku: rec.sku || null,
      platform: rec.platform || null,
      priority: rec.priority || 'medium',
      current_value: rec.current_value || {},
      recommended_value: rec.recommended_value || {},
      reason: rec.reason || '',
      confidence: rec.confidence ?? 0.5,
      status: rec.status || 'pending',
      expires_at: rec.expires_at || null,
    };
    const { data, error } = await this.db
      .from('agent_recommendations').insert(row).select().single();
    if (error) {
      console.error('[AuditLogger] logRecommendation error:', error.message);
      return null;
    }
    return data;
  }

  async getRecommendations(filters = {}) {
    let q = this.db.from('agent_recommendations').select('*');
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.agent_name) q = q.eq('agent_name', filters.agent_name);
    if (filters.priority) q = q.eq('priority', filters.priority);
    if (filters.sku) q = q.eq('sku', filters.sku);
    q = q.order('created_at', { ascending: false });
    if (filters.limit) q = q.limit(filters.limit);
    if (filters.offset) q = q.range(filters.offset, filters.offset + (filters.limit || 20) - 1);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async getRecommendationById(id) {
    const { data, error } = await this.db
      .from('agent_recommendations').select('*').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async updateRecommendation(id, updates) {
    const { data, error } = await this.db
      .from('agent_recommendations').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async hasPendingRecommendation(agentName, sku, platform, withinHours = 24) {
    const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.db
      .from('agent_recommendations')
      .select('id')
      .eq('agent_name', agentName)
      .eq('sku', sku)
      .eq('status', 'pending')
      .gte('created_at', since);
    if (platform) {
      // re-query with platform filter
      const { data: d2, error: e2 } = await this.db
        .from('agent_recommendations')
        .select('id')
        .eq('agent_name', agentName)
        .eq('sku', sku)
        .eq('platform', platform)
        .eq('status', 'pending')
        .gte('created_at', since);
      if (e2) return false;
      return (d2 || []).length > 0;
    }
    if (error) return false;
    return (data || []).length > 0;
  }

  // ===== agent_alerts =====

  async logAlert(alert) {
    const row = {
      agent_name: alert.agent_name,
      type: alert.type,
      severity: alert.severity || 'warning',
      title: alert.title,
      message: alert.message || '',
      sku: alert.sku || null,
      platform: alert.platform || null,
      context_data: alert.context_data || {},
    };
    const { data, error } = await this.db
      .from('agent_alerts').insert(row).select().single();
    if (error) {
      console.error('[AuditLogger] logAlert error:', error.message);
      return null;
    }
    return data;
  }

  async getAlerts(filters = {}) {
    let q = this.db.from('agent_alerts').select('*');
    if (filters.severity) q = q.eq('severity', filters.severity);
    if (filters.is_read !== undefined) q = q.eq('is_read', filters.is_read);
    if (filters.agent_name) q = q.eq('agent_name', filters.agent_name);
    q = q.order('created_at', { ascending: false });
    if (filters.limit) q = q.limit(filters.limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async markAlertRead(id) {
    const { data, error } = await this.db
      .from('agent_alerts').update({ is_read: true }).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  // ===== audit log queries =====

  async getAuditLog(filters = {}) {
    let q = this.db.from('agent_audit_logs').select('*');
    if (filters.agent_name) q = q.eq('agent_name', filters.agent_name);
    if (filters.action_type) q = q.eq('action_type', filters.action_type);
    if (filters.sku) q = q.eq('sku', filters.sku);
    if (filters.from) q = q.gte('created_at', filters.from);
    if (filters.to) q = q.lte('created_at', filters.to);
    q = q.order('created_at', { ascending: false });
    if (filters.limit) q = q.limit(filters.limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // ===== summary =====

  async getSummary() {
    const [pending, critical, todayExecuted, lastRuns] = await Promise.all([
      this.db.from('agent_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      this.db.from('agent_alerts').select('id', { count: 'exact', head: true }).eq('severity', 'critical').eq('is_read', false),
      this.db.from('agent_recommendations').select('id', { count: 'exact', head: true })
        .eq('status', 'executed').gte('executed_at', new Date().toISOString().slice(0, 10)),
      this.db.from('agent_audit_logs').select('agent_name, created_at')
        .eq('action_type', 'run_complete').order('created_at', { ascending: false }).limit(10),
    ]);

    const lastRunMap = {};
    for (const row of (lastRuns.data || [])) {
      if (!lastRunMap[row.agent_name]) lastRunMap[row.agent_name] = row.created_at;
    }

    return {
      pendingCount: pending.count || 0,
      criticalAlerts: critical.count || 0,
      todayExecuted: todayExecuted.count || 0,
      lastRuns: lastRunMap,
    };
  }
}

module.exports = { AuditLogger };
