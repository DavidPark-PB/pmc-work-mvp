/**
 * purchase_requests 테이블 — 발주 요청
 */
const { getClient } = require('./supabaseClient');

async function listRequests({ user, status }) {
  let q = getClient()
    .from('purchase_requests')
    .select(`
      id, product_name, quantity, estimated_price, priority, reason,
      requested_by, requested_at, status, decision_by, decision_at,
      rejection_reason, rejection_note,
      requester:users!purchase_requests_requested_by_users_id_fk ( id, display_name )
    `);

  if (!user.isAdmin) q = q.eq('requested_by', user.id);
  if (status) q = q.eq('status', status);

  const { data, error } = await q.order('requested_at', { ascending: false });
  if (error) throw error;

  return (data || []).sort((a, b) => {
    const aPen = a.status === 'pending' ? 0 : 1;
    const bPen = b.status === 'pending' ? 0 : 1;
    if (aPen !== bPen) return aPen - bPen;
    const aUrg = a.priority === 'urgent' ? 0 : 1;
    const bUrg = b.priority === 'urgent' ? 0 : 1;
    if (aUrg !== bUrg) return aUrg - bUrg;
    return new Date(b.requested_at) - new Date(a.requested_at);
  });
}

async function getRequest(id) {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createRequest(values) {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .insert(values)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateRequest(id, values) {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .update(values)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getStats() {
  const { data, error } = await getClient()
    .from('purchase_requests')
    .select('status, priority');
  if (error) throw error;
  const counts = { pending: 0, pendingUrgent: 0, approved: 0, rejected: 0 };
  for (const r of data || []) {
    if (r.status === 'pending') {
      counts.pending++;
      if (r.priority === 'urgent') counts.pendingUrgent++;
    } else if (r.status === 'approved') counts.approved++;
    else if (r.status === 'rejected') counts.rejected++;
  }
  return counts;
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, getStats };
