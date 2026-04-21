/**
 * prospects — TCG 셀러 리드 관리.
 * cold(리스트업) → contacted/replied/negotiating(활성) → converted(B2B) | dead
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '리드 DB 마이그레이션이 적용되지 않았습니다 (029).';
const VALID_STATUS = new Set(['cold', 'contacted', 'replied', 'negotiating', 'converted', 'dead']);
const ACTIVE_STATUSES = ['contacted', 'replied', 'negotiating'];

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /prospects/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(baseIso, days) {
  const d = baseIso ? new Date(baseIso + 'T00:00:00') : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    sourcePlatform: row.source_platform,
    sourceUrl: row.source_url,
    country: row.country,
    email: row.email,
    whatsapp: row.whatsapp,
    dmHandle: row.dm_handle,
    phone: row.phone,
    productFocus: row.product_focus,
    status: row.status,
    convertedBuyerId: row.converted_buyer_id,
    lastContactedAt: row.last_contacted_at,
    nextFollowUpAt: row.next_follow_up_at,
    lastMessageSummary: row.last_message_summary,
    deadReason: row.dead_reason,
    notes: row.notes,
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitize(updates) {
  const row = {};
  if (updates.name !== undefined) row.name = String(updates.name).trim().slice(0, 200);
  if (updates.company !== undefined) row.company = updates.company ? String(updates.company).trim().slice(0, 200) : null;
  if (updates.sourcePlatform !== undefined) row.source_platform = String(updates.sourcePlatform).toLowerCase().slice(0, 40);
  if (updates.sourceUrl !== undefined) row.source_url = updates.sourceUrl ? String(updates.sourceUrl).trim().slice(0, 2000) : null;
  if (updates.country !== undefined) row.country = updates.country ? String(updates.country).trim().slice(0, 40) : null;
  if (updates.email !== undefined) row.email = updates.email ? String(updates.email).trim().slice(0, 200) : null;
  if (updates.whatsapp !== undefined) row.whatsapp = updates.whatsapp ? String(updates.whatsapp).trim().slice(0, 50) : null;
  if (updates.dmHandle !== undefined) row.dm_handle = updates.dmHandle ? String(updates.dmHandle).trim().slice(0, 100) : null;
  if (updates.phone !== undefined) row.phone = updates.phone ? String(updates.phone).trim().slice(0, 50) : null;
  if (updates.productFocus !== undefined) row.product_focus = updates.productFocus ? String(updates.productFocus).trim().slice(0, 200) : null;
  if (updates.status !== undefined && VALID_STATUS.has(updates.status)) row.status = updates.status;
  if (updates.lastContactedAt !== undefined) row.last_contacted_at = updates.lastContactedAt || null;
  if (updates.nextFollowUpAt !== undefined) row.next_follow_up_at = updates.nextFollowUpAt || null;
  if (updates.lastMessageSummary !== undefined) row.last_message_summary = updates.lastMessageSummary ? String(updates.lastMessageSummary).trim().slice(0, 1000) : null;
  if (updates.deadReason !== undefined) row.dead_reason = updates.deadReason ? String(updates.deadReason).trim().slice(0, 500) : null;
  if (updates.notes !== undefined) row.notes = updates.notes ? String(updates.notes).trim().slice(0, 4000) : null;
  if (updates.tags !== undefined) row.tags = Array.isArray(updates.tags) ? updates.tags.slice(0, 20) : [];
  return row;
}

async function list({ statusGroup, status, platform, search, limit = 500 } = {}) {
  let q = getClient().from('prospects').select('*')
    .order('next_follow_up_at', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (statusGroup === 'cold') q = q.eq('status', 'cold');
  else if (statusGroup === 'active') q = q.in('status', ACTIVE_STATUSES);
  else if (statusGroup === 'converted') q = q.eq('status', 'converted');
  else if (statusGroup === 'dead') q = q.eq('status', 'dead');
  if (status) q = q.eq('status', status);
  if (platform) q = q.eq('source_platform', platform);
  if (search) {
    const s = String(search).trim();
    if (s) q = q.or(`name.ilike.%${s}%,company.ilike.%${s}%,notes.ilike.%${s}%,product_focus.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('prospects').select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function create(values, createdBy) {
  if (!values.name || !String(values.name).trim()) throw new Error('이름을 입력하세요');
  if (!values.sourcePlatform) throw new Error('출처 플랫폼을 선택하세요');
  const row = sanitize(values);
  row.created_by = createdBy || null;
  if (!row.status) row.status = 'cold';
  const { data, error } = await getClient().from('prospects').insert(row).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function update(id, updates) {
  const patch = sanitize(updates);
  patch.updated_at = new Date().toISOString();
  const { data, error } = await getClient().from('prospects').update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id) {
  const { error } = await getClient().from('prospects').delete().eq('id', id);
  if (error) throwFriendly(error);
}

/** cold → contacted 전이. 오늘 연락한 것으로 기록 + 7일 후 팔로업 기본값 */
async function activate(id) {
  const patch = {
    status: 'contacted',
    last_contacted_at: today(),
    next_follow_up_at: addDays(today(), 7),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getClient().from('prospects').update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

/** 연락 기록 (상태 수동 지정 가능; 기본 replied) */
async function logContact(id, { status = 'replied', summary, nextFollowUp } = {}) {
  const patch = {
    last_contacted_at: today(),
    last_message_summary: summary ? String(summary).trim().slice(0, 1000) : null,
    updated_at: new Date().toISOString(),
  };
  if (VALID_STATUS.has(status)) patch.status = status;
  if (nextFollowUp) patch.next_follow_up_at = nextFollowUp;
  const { data, error } = await getClient().from('prospects').update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function markDead(id, reason) {
  const { data, error } = await getClient().from('prospects').update({
    status: 'dead',
    dead_reason: reason ? String(reason).trim().slice(0, 500) : null,
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function markConverted(id, buyerId) {
  const { data, error } = await getClient().from('prospects').update({
    status: 'converted',
    converted_buyer_id: buyerId,
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function getStats() {
  const { data, error } = await getClient().from('prospects').select('status, next_follow_up_at');
  if (error && isMissing(error)) return { byStatus: {}, today: 0, overdue: 0, total: 0 };
  if (error) throw error;
  const byStatus = {};
  const t = today();
  let followupToday = 0;
  let followupOverdue = 0;
  for (const r of data || []) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (ACTIVE_STATUSES.includes(r.status) && r.next_follow_up_at) {
      if (r.next_follow_up_at === t) followupToday++;
      else if (r.next_follow_up_at < t) followupOverdue++;
    }
  }
  return { byStatus, today: followupToday, overdue: followupOverdue, total: (data || []).length };
}

async function listFollowups() {
  const t = today();
  const { data, error } = await getClient().from('prospects')
    .select('*')
    .in('status', ACTIVE_STATUSES)
    .lte('next_follow_up_at', t)
    .order('next_follow_up_at', { ascending: true });
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

module.exports = {
  list, getById, create, update, remove,
  activate, logContact, markDead, markConverted,
  getStats, listFollowups,
  ACTIVE_STATUSES,
};
