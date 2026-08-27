'use strict';
/**
 * nextTask.js — B2C · Phase 7 · NEXT TASK picker + My Tasks 조회.
 *
 * Owner directive:
 *   · 직원 로그인 → NEXT TASK 중심 UX
 *   · 정렬: priority_level (P0<P1<P2<P3) → priority_score DESC → created_at ASC → id ASC
 *   · 직원이 임의로 쉬운 것만 처리 못 하게 · 전체 목록도 볼 수 있으나 NEXT TASK 는 시스템 지정
 */

const ACTIVE_STATUSES = ['pending', 'in_progress', 'qc_pending'];
const LEVEL_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const CHANNEL_REGISTER_TYPES = new Set([
  'channel_register.coupang','channel_register.naver','channel_register.11st','channel_register.gmarket',
  'channel_register.ebay','channel_register.shopify','channel_register.auction',
]);
const B2C_EXCEPTION_PREFIXES = ['channel_register.', 'data_quality.', 'listing_error'];

function isB2cException(et) {
  if (!et) return false;
  if (et === 'listing_error') return true;
  return B2C_EXCEPTION_PREFIXES.some(p => et.startsWith(p));
}

//   ── Pure sort · NEXT TASK 순서 ─────────────────────
function sortTasksNextOrder(tasks) {
  tasks.sort((a, b) => {
    const ra = LEVEL_RANK[a.priority_level] ?? 9;
    const rb = LEVEL_RANK[b.priority_level] ?? 9;
    if (ra !== rb) return ra - rb;
    const sa = Number(a.priority_score) || 0;
    const sb = Number(b.priority_score) || 0;
    if (sa !== sb) return sb - sa;
    const ca = a.created_at ? Date.parse(a.created_at) : 0;
    const cb = b.created_at ? Date.parse(b.created_at) : 0;
    if (ca !== cb) return ca - cb;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  return tasks;
}

//   ── Pure pick · NEXT TASK ─────────────────────────
//   OrderBy: 위 sort 순서에서 status 우선순위:
//     - in_progress 가 있으면 그 중 최상위 → 이미 진행 중인 것 이어서 처리
//     - 그 다음 pending 최상위
//     - qc_pending 은 NEXT TASK 로 뽑히지 않음 (QC 는 admin/reviewer 대상)
function pickNextTask(tasks) {
  const b2c = tasks.filter(t => isB2cException(t.exception_type));
  const inProg = b2c.filter(t => t.status === 'in_progress');
  const pend = b2c.filter(t => t.status === 'pending');
  if (inProg.length) return sortTasksNextOrder(inProg.slice())[0];
  if (pend.length)   return sortTasksNextOrder(pend.slice())[0];
  return null;
}

//   ── My Tasks summary counts (오늘 완료 · 진행중 · QC 대기 · 남음 · 오류) ─
function summarizeMyTasks(tasks, todayIsoDate) {
  const b2c = tasks.filter(t => isB2cException(t.exception_type));
  const dayStart = new Date(todayIsoDate + 'T00:00:00Z').getTime();
  const summary = {
    completed_today: b2c.filter(t => t.status === 'done' && t.completed_at && Date.parse(t.completed_at) >= dayStart).length,
    in_progress:     b2c.filter(t => t.status === 'in_progress').length,
    qc_pending:      b2c.filter(t => t.status === 'qc_pending').length,
    remaining:       b2c.filter(t => t.status === 'pending').length,
    blocked:         b2c.filter(t => t.status === 'blocked').length,
    qc_failed_active: b2c.filter(t => t.qc_status === 'fail' && ACTIVE_STATUSES.includes(t.status)).length,
    total_active:    b2c.filter(t => ACTIVE_STATUSES.includes(t.status)).length,
  };
  return summary;
}

//   ── DB layer ─────────────────────────────────────
async function loadTasksForUser(db, userId) {
  //   본인에게 배정된 task + assignee_scope='operators' (fanout) 로 배정 안 된 task 도 포함
  //   V1 은 본인 배정 task 만 (fanout 은 관리자 refill 방식에 따라 다름). 명확화 위해 명시:
  //     · assignee_id == userId  → 내 것
  //     · assignee_id IS NULL AND assignee_scope='operators' → 공용 큐 (관리자 승인 후 낚아채기 가능 · V1 은 표시만)
  const [own, pool] = await Promise.all([
    db.from('team_tasks').select('*').eq('assignee_id', userId).limit(500),
    db.from('team_tasks').select('*').is('assignee_id', null).eq('assignee_scope', 'operators').limit(200),
  ]);
  if (own.error) throw new Error(`own tasks: ${own.error.message}`);
  if (pool.error) throw new Error(`pool tasks: ${pool.error.message}`);
  return { ownTasks: own.data || [], poolTasks: pool.data || [] };
}

async function getNextTaskForUser(db, userId) {
  const { ownTasks } = await loadTasksForUser(db, userId);
  return pickNextTask(ownTasks);
}

async function getMyTasksView(db, userId, todayIsoDate = new Date().toISOString().slice(0, 10)) {
  const { ownTasks, poolTasks } = await loadTasksForUser(db, userId);
  const own = ownTasks.filter(t => isB2cException(t.exception_type));
  sortTasksNextOrder(own);
  const summary = summarizeMyTasks(ownTasks, todayIsoDate);
  const nextTask = pickNextTask(ownTasks);
  return {
    at: new Date().toISOString(),
    user_id: userId,
    summary,
    next_task: nextTask,
    tasks: own,                    //   본인 배정 task 전체 (정렬됨)
    pool_size: poolTasks.filter(t => isB2cException(t.exception_type)).length,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  LEVEL_RANK,
  CHANNEL_REGISTER_TYPES,
  isB2cException,
  sortTasksNextOrder,
  pickNextTask,
  summarizeMyTasks,
  loadTasksForUser,
  getNextTaskForUser,
  getMyTasksView,
};
