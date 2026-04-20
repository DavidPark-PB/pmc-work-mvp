/**
 * weekly_meetings — 관리자 주도 주간 회의 기록 + AI 액션아이템 분배.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '회의 DB 마이그레이션이 적용되지 않았습니다 (023).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /weekly_meetings/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    meetingDate: row.meeting_date,
    cycleWeeks: row.cycle_weeks,
    title: row.title,
    summary: row.summary,
    rawNotes: row.raw_notes,
    actionItems: Array.isArray(row.action_items) ? row.action_items : [],
    status: row.status,
    extractedAt: row.extracted_at,
    distributedAt: row.distributed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(it => ({
    id: it.id || Math.random().toString(36).slice(2, 10),
    userId: Number.isFinite(Number(it.userId)) ? Number(it.userId) : null,
    userName: String(it.userName || '').trim().slice(0, 100) || null,
    title: String(it.title || '').trim().slice(0, 300),
    priority: ['high', 'normal', 'low'].includes(it.priority) ? it.priority : 'normal',
    notes: it.notes ? String(it.notes).trim().slice(0, 1000) : null,
  })).filter(it => it.title && (it.userId || it.userName));
}

async function list({ from, to, status, limit = 30 } = {}) {
  let q = getClient().from('weekly_meetings').select('*')
    .order('meeting_date', { ascending: false }).limit(limit);
  if (from) q = q.gte('meeting_date', from);
  if (to) q = q.lte('meeting_date', to);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('weekly_meetings')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function create({ meetingDate, cycleWeeks = 2, title, summary, rawNotes, createdBy }) {
  if (!meetingDate) throw new Error('회의 날짜를 입력하세요');
  const cw = [1, 2].includes(Number(cycleWeeks)) ? Number(cycleWeeks) : 2;
  const { data, error } = await getClient().from('weekly_meetings').insert({
    meeting_date: meetingDate,
    cycle_weeks: cw,
    title: title ? String(title).trim().slice(0, 200) : null,
    summary: summary || null,
    raw_notes: rawNotes || null,
    created_by: createdBy || null,
  }).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function update(id, updates) {
  const patch = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) patch.title = updates.title ? String(updates.title).trim().slice(0, 200) : null;
  if (updates.summary !== undefined) patch.summary = updates.summary || null;
  if (updates.rawNotes !== undefined) patch.raw_notes = updates.rawNotes || null;
  if (updates.meetingDate !== undefined) patch.meeting_date = updates.meetingDate;
  if (updates.cycleWeeks !== undefined) {
    patch.cycle_weeks = [1, 2].includes(Number(updates.cycleWeeks)) ? Number(updates.cycleWeeks) : 2;
  }
  if (updates.actionItems !== undefined) patch.action_items = sanitizeItems(updates.actionItems);
  if (updates.status !== undefined) {
    if (!['draft', 'extracted', 'distributed'].includes(updates.status)) throw new Error('status 값이 올바르지 않습니다');
    patch.status = updates.status;
  }
  const { data, error } = await getClient().from('weekly_meetings')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id) {
  const { error } = await getClient().from('weekly_meetings').delete().eq('id', id);
  if (error) throwFriendly(error);
}

async function markExtracted(id, actionItems) {
  const { data, error } = await getClient().from('weekly_meetings').update({
    action_items: sanitizeItems(actionItems),
    status: 'extracted',
    extracted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function markDistributed(id) {
  const { data, error } = await getClient().from('weekly_meetings').update({
    status: 'distributed',
    distributed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

module.exports = {
  list, getById, create, update, remove, markExtracted, markDistributed,
  sanitizeItems,
};
