/**
 * Task Repository — CRUD for tasks table (employee assignments)
 */
const { getClient } = require('./supabaseClient');

class TaskRepository {
  get db() { return getClient(); }

  async createTask(task) {
    const { data, error } = await this.db
      .from('tasks').insert({
        title: task.title,
        description: task.description || '',
        assigned_to: task.assigned_to || '',
        created_by: task.created_by || 'system',
        category: task.category || 'general',
        priority: task.priority || 'medium',
        status: 'pending',
        due_date: task.due_date || null,
        related_sku: task.related_sku || null,
        related_order: task.related_order || null,
        agent_recommendation_id: task.agent_recommendation_id || null,
      }).select().single();
    if (error) throw error;
    return data;
  }

  async getTasksByAssignee(assignee, status) {
    let q = this.db.from('tasks').select('*').eq('assigned_to', assignee);
    if (status) q = q.eq('status', status);
    q = q.order('priority', { ascending: true }).order('due_date', { ascending: true });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async getPendingTasks(category) {
    let q = this.db.from('tasks').select('*').eq('status', 'pending');
    if (category) q = q.eq('category', category);
    q = q.order('priority', { ascending: true }).order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async updateTask(id, updates) {
    if (updates.status === 'done') updates.completed_at = new Date().toISOString();
    const { data, error } = await this.db
      .from('tasks').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async getWorkloadSummary() {
    const { data, error } = await this.db
      .from('tasks').select('assigned_to, status');
    if (error) throw error;
    const summary = {};
    (data || []).forEach(t => {
      if (!summary[t.assigned_to]) summary[t.assigned_to] = { pending: 0, in_progress: 0, done: 0 };
      summary[t.assigned_to][t.status] = (summary[t.assigned_to][t.status] || 0) + 1;
    });
    return summary;
  }
}

module.exports = { TaskRepository };
