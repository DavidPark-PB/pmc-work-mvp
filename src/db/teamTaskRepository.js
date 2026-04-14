/**
 * team_tasks 테이블 — 업무 지시
 * (레거시 tasks 테이블과 별개. ccorea-auto Phase 1에서 생성됨)
 */
const { getClient } = require('./supabaseClient');

/**
 * 목록 조회
 * @param {object} opts
 *   - user: { id, isAdmin } — 권한 분기
 *   - status?: 'pending'|'in_progress'|'done'
 *   - scope?: 'mine' (사장 본인 할 일만)
 *   - assigneeId?: number (사장이 특정 직원 필터)
 */
async function listTasks(opts) {
  const { user, status, scope, assigneeId } = opts;
  let q = getClient()
    .from('team_tasks')
    .select(`
      id, title, assignee_id, assignee_scope, due_date, priority, status, memo,
      created_by, created_at, completed_at, completion_note,
      assignee:users!team_tasks_assignee_id_users_id_fk ( id, display_name )
    `);

  if (!user.isAdmin) {
    // staff: 본인 할당 + 전체 공지
    q = q.or(`assignee_id.eq.${user.id},assignee_scope.eq.all`);
  } else {
    if (scope === 'mine') q = q.eq('assignee_id', user.id);
    else if (assigneeId) q = q.eq('assignee_id', assigneeId);
  }
  if (status) q = q.eq('status', status);

  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw error;

  // 정렬: 긴급 먼저 → 미완료 먼저 → 마감 임박
  return (data || []).sort((a, b) => {
    const aDone = a.status === 'done' ? 1 : 0;
    const bDone = b.status === 'done' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const aUrgent = a.priority === 'urgent' ? 0 : 1;
    const bUrgent = b.priority === 'urgent' ? 0 : 1;
    if (aUrgent !== bUrgent) return aUrgent - bUrgent;
    if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

async function getTask(id) {
  const { data, error } = await getClient()
    .from('team_tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createTask(values) {
  const { data, error } = await getClient()
    .from('team_tasks')
    .insert(values)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateTask(id, values) {
  const { data, error } = await getClient()
    .from('team_tasks')
    .update(values)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteTask(id) {
  const { error } = await getClient().from('team_tasks').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 오늘 통계 (사장 대시보드용)
 * @returns { today: {total,pending,in_progress,done}, perStaff: [{id, displayName, platform, pending, in_progress, done, total, completionRate}] }
 */
async function getTodayStats() {
  // 오늘 범위: 로컬 00:00 ~ 내일 00:00
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const c = getClient();

  // 오늘 업무 = 오늘 마감이거나 오늘 생성
  const [tasksRes, staffRes] = await Promise.all([
    c.from('team_tasks')
      .select('assignee_id, status, due_date, created_at')
      .or(`and(due_date.gte.${todayStart},due_date.lt.${todayEnd}),and(created_at.gte.${todayStart},created_at.lt.${todayEnd})`),
    c.from('users')
      .select('id, display_name, platform')
      .eq('role', 'staff')
      .eq('is_active', true)
      .order('display_name', { ascending: true }),
  ]);
  if (tasksRes.error) throw tasksRes.error;
  if (staffRes.error) throw staffRes.error;

  const tasks = tasksRes.data || [];
  const staff = staffRes.data || [];

  const today = { total: tasks.length, pending: 0, in_progress: 0, done: 0 };
  const perStaffMap = new Map();
  for (const s of staff) perStaffMap.set(s.id, { id: s.id, displayName: s.display_name, platform: s.platform, pending: 0, in_progress: 0, done: 0 });

  for (const t of tasks) {
    today[t.status] = (today[t.status] || 0) + 1;
    if (t.assignee_id && perStaffMap.has(t.assignee_id)) {
      perStaffMap.get(t.assignee_id)[t.status]++;
    }
  }

  const perStaff = [...perStaffMap.values()].map(s => {
    const total = s.pending + s.in_progress + s.done;
    return { ...s, total, completionRate: total > 0 ? Math.round((s.done / total) * 100) : 0 };
  });

  return { today, perStaff };
}

module.exports = {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  getTodayStats,
};
