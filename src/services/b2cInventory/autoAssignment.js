'use strict';
/**
 * autoAssignment.js — B2C · Phase 6 · LEAST_ACTIVE_TASKS 배정.
 *
 * Owner directive:
 *   · b2c.auto_assignment_enabled = 0 DEFAULT · OFF 이면 assignee_id=NULL, scope='operators'
 *   · ON 이면 eligible employees (users.b2c_operator=true AND is_active=true) 중
 *     현재 active B2C task (pending/in_progress/qc_pending) 이 가장 적은 직원 선택
 *   · 동률: user_id ASC (deterministic)
 *   · eligible employee 0 → unassigned fallback (assignee_id=NULL · scope='operators')
 *
 * Pure allocator + DB wrapper.
 */

const ACTIVE_STATUSES = ['pending', 'in_progress', 'qc_pending'];

//   ── Pure allocator ────────────────────────────────────
//   eligibles: [{ id, username, ... }]  · users.b2c_operator=true AND is_active=true
//   activeCounts: Map<user_id, active B2C task count>
//   plan: task rows (queueRefill/taskRowFromCandidate 결과)
//   returns: task rows with assignee_id/assignee_scope 갱신 · counts 도 in-place 증가시켜
//            같은 refill batch 안에서 균형 유지
//   ── Channel capability check (Phase 7 · users.b2c_channels) ──
//   NULL  = all B2C channels (default)
//   []    = no channel (배제)
//   [ch...] = whitelist
function userCanHandleChannel(user, channel) {
  const caps = user && user.b2c_channels;
  if (caps === null || caps === undefined) return true;   //   NULL = all
  if (!Array.isArray(caps)) return true;                  //   방어적: unknown type → all
  return caps.includes(channel);
}

function assignLeastActive({ eligibles, activeCounts, plan }) {
  if (!Array.isArray(eligibles) || eligibles.length === 0) {
    //   fallback — 모두 unassigned
    return plan.map(t => ({ ...t, assignee_id: null, assignee_scope: 'operators' }));
  }
  //   copy counts (mutate in loop)
  const counts = new Map(eligibles.map(u => [u.id, Number(activeCounts.get(u.id) || 0)]));
  const usersSorted = eligibles.slice().sort((a, b) => a.id - b.id);   //   deterministic tiebreak

  const out = [];
  for (const t of plan) {
    //   Phase 7: channel capability filter
    const capable = usersSorted.filter(u => userCanHandleChannel(u, t.channel));
    if (capable.length === 0) {
      //   이 채널 담당 가능한 직원 없음 → unassigned fallback
      out.push({ ...t, assignee_id: null, assignee_scope: 'operators' });
      continue;
    }
    //   pick least-active · tiebreak user_id ASC (among capable)
    let best = null;
    for (const u of capable) {
      const c = counts.get(u.id);
      if (best === null || c < counts.get(best.id)) best = u;
    }
    counts.set(best.id, counts.get(best.id) + 1);
    out.push({ ...t, assignee_id: best.id, assignee_scope: 'specific' });
  }
  return out;
}

//   ── DB helpers ────────────────────────────────────────
async function loadEligibleEmployees(db) {
  const { data, error } = await db.from('users')
    .select('id, username, display_name, role, is_active, b2c_operator, b2c_channels')
    .eq('b2c_operator', true).eq('is_active', true);
  if (error) throw new Error('eligible users load: ' + error.message);
  return data || [];
}

async function loadActiveB2cTaskCounts(db, userIds) {
  //   각 user 에 대해 active B2C task 갯수 (exception_type LIKE 'channel_register.%' OR 'data_quality.%')
  //   pagination 통해 전체 load 후 in-memory 집계 (Supabase 로 group by 는 표준 REST 로 제한적)
  if (!userIds.length) return new Map();
  const { data, error } = await db.from('team_tasks').select('assignee_id, status, exception_type')
    .in('assignee_id', userIds).in('status', ACTIVE_STATUSES);
  if (error) throw new Error('active tasks load: ' + error.message);
  const m = new Map();
  for (const r of (data || [])) {
    const et = String(r.exception_type || '');
    if (!et.startsWith('channel_register.') && !et.startsWith('data_quality.')) continue;
    m.set(r.assignee_id, (m.get(r.assignee_id) || 0) + 1);
  }
  return m;
}

//   ── Assignment simulation (READ-ONLY · production report 용) ──
async function simulateAssignment({ db, plan }) {
  const eligibles = await loadEligibleEmployees(db);
  const counts = eligibles.length
    ? await loadActiveB2cTaskCounts(db, eligibles.map(u => u.id))
    : new Map();
  const assigned = assignLeastActive({ eligibles, activeCounts: counts, plan });
  //   plan 이 unassigned 이면 eligible 없음
  const perUser = new Map();
  for (const t of assigned) {
    const uid = t.assignee_id;
    if (uid == null) continue;
    perUser.set(uid, (perUser.get(uid) || 0) + 1);
  }
  return {
    eligible_count: eligibles.length,
    eligibles: eligibles.map(u => ({
      id: u.id, username: u.username, display_name: u.display_name,
      active_b2c_before: Number(counts.get(u.id) || 0),
      would_receive: Number(perUser.get(u.id) || 0),
      total_after: Number(counts.get(u.id) || 0) + Number(perUser.get(u.id) || 0),
    })),
    unassigned_tasks: assigned.filter(t => t.assignee_id == null).length,
    total_tasks: assigned.length,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  userCanHandleChannel,
  assignLeastActive,
  loadEligibleEmployees,
  loadActiveB2cTaskCounts,
  simulateAssignment,
};
