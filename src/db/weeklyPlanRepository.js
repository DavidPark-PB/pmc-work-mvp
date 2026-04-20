/**
 * weekly_plans — 직원 주간 업무 계획 + 회고.
 * 한 주(월요일 시작) 당 한 row. items는 JSONB로 계획 항목 리스트.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '주간 업무 DB 마이그레이션이 적용되지 않았습니다 (020).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /weekly_plans/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 주어진 날짜가 속한 월요일 반환 (날짜 문자열 YYYY-MM-DD) */
function weekStartOf(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const dow = d.getDay(); // 0=일, 1=월...6=토
  const offset = dow === 0 ? -6 : 1 - dow; // 지난 월요일
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return toIsoDate(d);
}

function decorate(row) {
  if (!row) return null;
  const items = Array.isArray(row.items) ? row.items : [];
  const total = items.length;
  const done = items.filter(i => i.status === 'done').length;
  const inProgress = items.filter(i => i.status === 'in_progress').length;
  const dropped = items.filter(i => i.status === 'dropped').length;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    id: row.id,
    userId: row.user_id,
    weekStart: row.week_start,
    items,
    reflectionWins: row.reflection_wins,
    reflectionBlockers: row.reflection_blockers,
    reflectionNextWeek: row.reflection_next_week,
    status: row.status,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agg: { total, done, inProgress, dropped, completionPct },
  };
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(it => ({
    id: it.id || Math.random().toString(36).slice(2, 10),
    title: String(it.title || '').trim().slice(0, 300),
    priority: ['high', 'normal', 'low'].includes(it.priority) ? it.priority : 'normal',
    status: ['pending', 'in_progress', 'done', 'dropped'].includes(it.status) ? it.status : 'pending',
    result: it.result ? String(it.result).trim().slice(0, 1000) : null,
    createdAt: it.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })).filter(it => it.title);
}

/** 특정 사용자의 특정 주 — 없으면 null */
async function getByUserWeek(userId, weekStart) {
  const ws = weekStart || weekStartOf();
  const { data, error } = await getClient().from('weekly_plans')
    .select('*').eq('user_id', userId).eq('week_start', ws).maybeSingle();
  if (error && isMissing(error)) return null;
  if (error) throw error;
  return decorate(data);
}

/** 없으면 빈 draft 생성해서 반환 — 프론트에서 "이번주 플랜" 열 때 사용 */
async function getOrCreateCurrent(userId, weekStart) {
  const ws = weekStart || weekStartOf();
  const existing = await getByUserWeek(userId, ws);
  if (existing) return existing;
  const { data, error } = await getClient().from('weekly_plans').insert({
    user_id: userId,
    week_start: ws,
    items: [],
    status: 'draft',
  }).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function listForUser(userId, { from, to, limit = 26 } = {}) {
  let q = getClient().from('weekly_plans').select('*')
    .eq('user_id', userId).order('week_start', { ascending: false }).limit(limit);
  if (from) q = q.gte('week_start', from);
  if (to) q = q.lte('week_start', to);
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

/** 전체 직원 특정 주 (admin용) */
async function listForWeek(weekStart) {
  const ws = weekStart || weekStartOf();
  const { data, error } = await getClient().from('weekly_plans').select('*')
    .eq('week_start', ws);
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

/** 특정 user의 특정 월 전체 주 (KPI용) */
async function listForUserMonth(userId, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  const [y, m] = month.split('-').map(n => parseInt(n, 10));
  const from = toIsoDate(new Date(y, m - 1, 1));
  const to = toIsoDate(new Date(y, m, 0));
  return listForUser(userId, { from, to, limit: 10 });
}

async function update(id, updates, userId) {
  const patch = { updated_at: new Date().toISOString() };
  if (updates.items !== undefined) patch.items = sanitizeItems(updates.items);
  if (updates.reflectionWins !== undefined) patch.reflection_wins = updates.reflectionWins || null;
  if (updates.reflectionBlockers !== undefined) patch.reflection_blockers = updates.reflectionBlockers || null;
  if (updates.reflectionNextWeek !== undefined) patch.reflection_next_week = updates.reflectionNextWeek || null;
  if (updates.status !== undefined) {
    if (!['draft', 'submitted'].includes(updates.status)) throw new Error('status 값이 올바르지 않습니다');
    patch.status = updates.status;
    if (updates.status === 'submitted') patch.submitted_at = new Date().toISOString();
    if (updates.status === 'draft') patch.submitted_at = null;
  }
  let q = getClient().from('weekly_plans').update(patch).eq('id', id);
  if (userId !== undefined) q = q.eq('user_id', userId);  // 본인 것만
  const { data, error } = await q.select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id, userId) {
  let q = getClient().from('weekly_plans').delete().eq('id', id);
  if (userId !== undefined) q = q.eq('user_id', userId);
  const { error } = await q;
  if (error) throwFriendly(error);
}

/**
 * 월별 KPI 집계 (admin):
 * 지정 월의 모든 user 주간 플랜을 집계해 직원별 완료율/건수 반환.
 */
async function monthlyKpi(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  const [y, m] = month.split('-').map(n => parseInt(n, 10));
  const from = toIsoDate(new Date(y, m - 1, 1));
  const to = toIsoDate(new Date(y, m, 0));
  const db = getClient();
  const [plansRes, usersRes] = await Promise.all([
    db.from('weekly_plans').select('*').gte('week_start', from).lte('week_start', to),
    db.from('users').select('id, display_name, role, is_active, platform').eq('is_active', true),
  ]);
  if (plansRes.error && isMissing(plansRes.error)) return { month, perStaff: [] };
  if (plansRes.error) throw plansRes.error;
  if (usersRes.error) throw usersRes.error;

  const perUser = new Map();
  for (const u of usersRes.data || []) {
    perUser.set(u.id, {
      userId: u.id, displayName: u.display_name, platform: u.platform || null,
      weekCount: 0, submittedCount: 0,
      itemsTotal: 0, itemsDone: 0, itemsInProgress: 0, itemsDropped: 0,
    });
  }
  for (const p of plansRes.data || []) {
    const s = perUser.get(p.user_id);
    if (!s) continue;
    s.weekCount++;
    if (p.status === 'submitted') s.submittedCount++;
    const items = Array.isArray(p.items) ? p.items : [];
    for (const it of items) {
      s.itemsTotal++;
      if (it.status === 'done') s.itemsDone++;
      else if (it.status === 'in_progress') s.itemsInProgress++;
      else if (it.status === 'dropped') s.itemsDropped++;
    }
  }
  const perStaff = [...perUser.values()].map(s => ({
    ...s,
    completionPct: s.itemsTotal > 0 ? Math.round((s.itemsDone / s.itemsTotal) * 100) : 0,
  })).sort((a, b) => b.itemsDone - a.itemsDone);
  return { month, perStaff };
}

module.exports = {
  weekStartOf, getByUserWeek, getOrCreateCurrent, listForUser, listForWeek,
  listForUserMonth, update, remove, monthlyKpi,
};
