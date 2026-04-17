/**
 * team_tasks + team_task_recipients — 수신자별 완료 상태 추적
 *
 * 데이터 모델:
 *   team_tasks          — 업무 메타데이터 (title, priority, due, memo 등 + 집계용 status)
 *   team_task_recipients — 수신자별 개별 상태 (task_id, user_id, status, completed_at, completion_note)
 *
 * status 규칙:
 *   - 특정 담당자: recipient 1개 (assignee_id)
 *   - 전체 공지: 등록 시점 활성 staff 전원 recipient 생성 (사장 제외)
 *   - team_tasks.status는 전체 recipient 상태를 derived로 반영
 *     모두 done → 'done' / 아니면 누구든 done/in_progress 있으면 'in_progress' / 아니면 'pending'
 */
const { getClient } = require('./supabaseClient');

/** 수신자 전원 done 여부 기반으로 team_tasks.status 재계산 */
async function recomputeTaskStatus(taskId) {
  const c = getClient();
  const { data: recs, error } = await c
    .from('team_task_recipients')
    .select('status')
    .eq('task_id', taskId);
  if (error) throw error;
  if (!recs || recs.length === 0) return;

  const allDone = recs.every(r => r.status === 'done');
  const anyActive = recs.some(r => r.status !== 'pending');
  const nextStatus = allDone ? 'done' : (anyActive ? 'in_progress' : 'pending');

  const updates = { status: nextStatus };
  if (allDone) {
    // 마지막 완료 시각을 task.completed_at으로
    const { data: maxDone } = await c
      .from('team_task_recipients')
      .select('completed_at')
      .eq('task_id', taskId)
      .order('completed_at', { ascending: false })
      .limit(1);
    updates.completed_at = maxDone?.[0]?.completed_at || new Date().toISOString();
  } else {
    updates.completed_at = null;
  }

  await c.from('team_tasks').update(updates).eq('id', taskId);
}

/** 활성 staff id 목록 */
async function getActiveStaffIds() {
  const { data, error } = await getClient()
    .from('users')
    .select('id')
    .eq('role', 'staff')
    .eq('is_active', true);
  if (error) throw error;
  return (data || []).map(u => u.id);
}

/**
 * 목록 조회 — 사용자별 분기
 *
 * staff: 본인 recipient 있는 task만. 각 task에 myStatus/myCompletedAt/myCompletionNote 포함.
 * owner: 전체 task. 각 task에 aggregate {total, pending, in_progress, done} + recipients[] 포함.
 */
async function listTasks({ user, status, scope, assigneeId }) {
  const c = getClient();

  if (!user.isAdmin) {
    // staff: 본인 recipient 기반
    let q = c
      .from('team_task_recipients')
      .select(`
        status,
        completed_at,
        completion_note,
        task:team_tasks!inner (
          id, title, assignee_id, assignee_scope, due_date, priority, memo,
          created_by, created_at
        )
      `)
      .eq('user_id', user.id);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    const items = (data || []).map(r => ({
      id: r.task.id,
      title: r.task.title,
      assignee_id: r.task.assignee_id,
      assignee_scope: r.task.assignee_scope,
      due_date: r.task.due_date,
      priority: r.task.priority,
      memo: r.task.memo,
      created_by: r.task.created_by,
      created_at: r.task.created_at,
      myStatus: r.status,
      myCompletedAt: r.completed_at,
      myCompletionNote: r.completion_note,
      myAttachments: [],
    }));

    const myTaskIds = items.map(t => t.id);
    if (myTaskIds.length > 0) {
      const { data: atts, error: eA } = await c
        .from('team_task_attachments')
        .select('id, task_id, file_name, mime_type, size_bytes, uploaded_at')
        .eq('user_id', user.id)
        .in('task_id', myTaskIds);
      // Swallow "relation does not exist" (42P01) so the page still renders
      // before the 009 migration runs. Other errors still propagate.
      if (eA && eA.code !== '42P01') throw eA;
      const byTask = new Map();
      for (const a of atts || []) {
        if (!byTask.has(a.task_id)) byTask.set(a.task_id, []);
        byTask.get(a.task_id).push(a);
      }
      for (const t of items) t.myAttachments = byTask.get(t.id) || [];
    }

    return items.sort(sortTasks);
  }

  // owner: 전체 task + recipients
  let taskQ = c.from('team_tasks').select('*');
  if (scope === 'mine') taskQ = taskQ.eq('created_by', user.id);
  if (status) taskQ = taskQ.eq('status', status);
  const { data: tasks, error: e1 } = await taskQ;
  if (e1) throw e1;
  if (!tasks || tasks.length === 0) return [];

  const ids = tasks.map(t => t.id);
  const { data: recs, error: e2 } = await c
    .from('team_task_recipients')
    .select(`
      id, task_id, user_id, status, completed_at, completion_note,
      user:users!team_task_recipients_user_id_fkey ( id, display_name )
    `)
    .in('task_id', ids);
  if (e2) throw e2;

  const recsByTask = new Map();
  for (const r of recs || []) {
    if (!recsByTask.has(r.task_id)) recsByTask.set(r.task_id, []);
    recsByTask.get(r.task_id).push({
      id: r.id,
      userId: r.user_id,
      userName: r.user?.display_name || '-',
      status: r.status,
      completedAt: r.completed_at,
      completionNote: r.completion_note,
      attachments: [],
    });
  }

  // Attachments grouped by (task_id, user_id) — merge into each recipient
  const { data: atts, error: eA } = await c
    .from('team_task_attachments')
    .select('id, task_id, user_id, file_name, mime_type, size_bytes, uploaded_at')
    .in('task_id', ids);
  // Swallow missing-table error so owner view still works pre-migration
  if (eA && eA.code !== '42P01') throw eA;
  for (const a of atts || []) {
    const rs = recsByTask.get(a.task_id);
    if (!rs) continue;
    const r = rs.find(x => x.userId === a.user_id);
    if (r) r.attachments.push({
      id: a.id,
      fileName: a.file_name,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      uploadedAt: a.uploaded_at,
    });
  }

  let items = tasks.map(t => {
    const rs = recsByTask.get(t.id) || [];
    const agg = { total: rs.length, pending: 0, in_progress: 0, done: 0 };
    for (const r of rs) agg[r.status]++;
    return {
      id: t.id,
      title: t.title,
      assignee_id: t.assignee_id,
      assignee_scope: t.assignee_scope,
      due_date: t.due_date,
      priority: t.priority,
      status: t.status,
      memo: t.memo,
      created_by: t.created_by,
      created_at: t.created_at,
      completed_at: t.completed_at,
      completion_note: t.completion_note,
      aggregate: agg,
      recipients: rs,
    };
  });

  // owner assignee 필터 (특정 수신자에게 배정된 task만 보기)
  if (assigneeId) {
    items = items.filter(t => t.recipients.some(r => r.userId === assigneeId));
  }

  return items.sort(sortTasks);
}

function sortTasks(a, b) {
  const aStatus = a.myStatus || a.status;
  const bStatus = b.myStatus || b.status;
  const aDone = aStatus === 'done' ? 1 : 0;
  const bDone = bStatus === 'done' ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;
  const aUrg = a.priority === 'urgent' ? 0 : 1;
  const bUrg = b.priority === 'urgent' ? 0 : 1;
  if (aUrg !== bUrg) return aUrg - bUrg;
  if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
  return new Date(b.created_at) - new Date(a.created_at);
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

async function getRecipient(taskId, userId) {
  const { data, error } = await getClient()
    .from('team_task_recipients')
    .select('*')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** recipient 상태 업데이트 (없으면 에러) */
async function updateRecipient(taskId, userId, { status, completionNote }) {
  const existing = await getRecipient(taskId, userId);
  if (!existing) return null;

  const updates = {};
  if (status !== undefined) updates.status = status;
  if (status === 'done') {
    updates.completed_at = new Date().toISOString();
    if (completionNote !== undefined) updates.completion_note = completionNote;
  } else if (status !== undefined) {
    updates.completed_at = null;
  }
  if (completionNote !== undefined && status !== 'done') {
    updates.completion_note = completionNote;
  }

  const { data, error } = await getClient()
    .from('team_task_recipients')
    .update(updates)
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw error;

  await recomputeTaskStatus(taskId);
  return data;
}

/** task 메타데이터 업데이트 (owner 전용) */
async function updateTaskMeta(id, values) {
  const { data, error } = await getClient()
    .from('team_tasks')
    .update(values)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * 업무 생성
 * - specific: recipient 1개 (assignee_id)
 * - all: 활성 staff 전원 recipient 생성
 */
async function createTask(taskValues) {
  const c = getClient();
  const { data: task, error: e1 } = await c
    .from('team_tasks')
    .insert(taskValues)
    .select()
    .single();
  if (e1) throw e1;

  let recipientIds;
  if (taskValues.assignee_scope === 'all') {
    recipientIds = await getActiveStaffIds();
  } else if (taskValues.assignee_id) {
    recipientIds = [taskValues.assignee_id];
  } else {
    recipientIds = [];
  }

  if (recipientIds.length > 0) {
    const rows = recipientIds.map(uid => ({
      task_id: task.id,
      user_id: uid,
      status: 'pending',
    }));
    const { error: e2 } = await c.from('team_task_recipients').insert(rows);
    if (e2) throw e2;
  }

  return { task, recipientCount: recipientIds.length };
}

async function deleteTask(id) {
  // CASCADE로 recipients 함께 삭제
  const { error } = await getClient().from('team_tasks').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 오늘 통계 (owner 대시보드)
 * - today: recipient-row 기반 집계 (broadcast 1개 × N staff = N slot)
 * - perStaff: 본인 recipient 상태별 집계
 */
async function getTodayStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const c = getClient();

  // 오늘 범위의 task
  const { data: todayTasks, error: e1 } = await c
    .from('team_tasks')
    .select('id, due_date, created_at')
    .or(`and(due_date.gte.${todayStart},due_date.lt.${todayEnd}),and(created_at.gte.${todayStart},created_at.lt.${todayEnd})`);
  if (e1) throw e1;

  const taskIds = (todayTasks || []).map(t => t.id);

  const [recsRes, staffRes] = await Promise.all([
    taskIds.length > 0
      ? c.from('team_task_recipients').select('user_id, status').in('task_id', taskIds)
      : Promise.resolve({ data: [], error: null }),
    c.from('users')
      .select('id, display_name, platform')
      .eq('role', 'staff')
      .eq('is_active', true)
      .order('display_name', { ascending: true }),
  ]);
  if (recsRes.error) throw recsRes.error;
  if (staffRes.error) throw staffRes.error;

  const today = { total: 0, pending: 0, in_progress: 0, done: 0 };
  const perStaffMap = new Map();
  for (const s of staffRes.data || []) {
    perStaffMap.set(s.id, { id: s.id, displayName: s.display_name, platform: s.platform, pending: 0, in_progress: 0, done: 0 });
  }
  for (const r of recsRes.data || []) {
    today.total++;
    today[r.status] = (today[r.status] || 0) + 1;
    if (perStaffMap.has(r.user_id)) {
      perStaffMap.get(r.user_id)[r.status]++;
    }
  }

  const perStaff = [...perStaffMap.values()].map(s => {
    const total = s.pending + s.in_progress + s.done;
    return { ...s, total, completionRate: total > 0 ? Math.round((s.done / total) * 100) : 0 };
  });

  return { today, perStaff };
}

async function addAttachment({ taskId, userId, filePath, fileName, mimeType, sizeBytes }) {
  const { data, error } = await getClient()
    .from('team_task_attachments')
    .insert({
      task_id: taskId,
      user_id: userId,
      file_path: filePath,
      file_name: fileName,
      mime_type: mimeType || null,
      size_bytes: sizeBytes || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getAttachment(id) {
  const { data, error } = await getClient()
    .from('team_task_attachments')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function countAttachmentsForUser(taskId, userId) {
  const { count, error } = await getClient()
    .from('team_task_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId)
    .eq('user_id', userId);
  if (error) throw error;
  return count || 0;
}

module.exports = {
  listTasks,
  getTask,
  getRecipient,
  updateRecipient,
  updateTaskMeta,
  createTask,
  deleteTask,
  getTodayStats,
  recomputeTaskStatus,
  getActiveStaffIds,
  addAttachment,
  getAttachment,
  countAttachmentsForUser,
};
