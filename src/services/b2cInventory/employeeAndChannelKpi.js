'use strict';
/**
 * employeeAndChannelKpi.js — B2C · Phase 7 · Employee + Channel KPI.
 *
 * Owner directive (§17-§18):
 *   · Employee KPI: assigned / started / submitted / qc_passed / qc_failed / blocked
 *                   + QC pass rate + average completion time
 *   · BLOCKED 는 실패로 계산 금지 (별도 operational bottleneck)
 *   · Channel KPI: created / started / submitted / qc_pass / qc_fail / blocked
 *                  + avg work time + QC pass rate · Phase 8 병목 판단용
 */

const B2C_CHANNEL_REGISTER = new Set([
  'channel_register.coupang','channel_register.naver','channel_register.11st','channel_register.gmarket',
  'channel_register.ebay','channel_register.shopify','channel_register.auction',
]);
const B2C_ANY = new Set([
  ...B2C_CHANNEL_REGISTER,
  'data_quality.cost_missing',
  'listing_error',
]);

function isB2c(et) { return B2C_ANY.has(et); }

//   ── Pure: Employee KPI from task list ─────────────
function computeEmployeeKpi(tasks) {
  //   returns Map<user_id, kpi>
  const byUser = new Map();
  for (const t of tasks) {
    if (!isB2c(t.exception_type)) continue;
    const uid = t.assignee_id;
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, empty());
    const k = byUser.get(uid);
    k.assigned++;
    if (t.started_at) k.started++;
    if (t.submitted_at) k.submitted++;
    if (t.qc_status === 'pass') k.qc_passed++;
    if (t.qc_status === 'fail') k.qc_failed++;
    if (t.status === 'blocked') k.blocked++;
    //   완료 시간 계산 (started → completed)
    if (t.completed_at && t.started_at) {
      const s = Date.parse(t.started_at); const c = Date.parse(t.completed_at);
      if (Number.isFinite(s) && Number.isFinite(c) && c > s) {
        k._durations.push((c - s) / 1000);
      }
    }
  }
  for (const [, k] of byUser.entries()) finalize(k);
  return byUser;
}

//   ── Pure: Channel KPI ─────────────────────────────
function computeChannelKpi(tasks) {
  const byCh = new Map();
  for (const t of tasks) {
    if (!B2C_CHANNEL_REGISTER.has(t.exception_type)) continue;
    const ch = t.channel || 'unknown';
    if (!byCh.has(ch)) byCh.set(ch, empty());
    const k = byCh.get(ch);
    k.created++;
    if (t.started_at) k.started++;
    if (t.submitted_at) k.submitted++;
    if (t.qc_status === 'pass') k.qc_pass++;
    if (t.qc_status === 'fail') k.qc_fail++;
    if (t.status === 'blocked') k.blocked++;
    if (t.completed_at && t.started_at) {
      const s = Date.parse(t.started_at); const c = Date.parse(t.completed_at);
      if (Number.isFinite(s) && Number.isFinite(c) && c > s) {
        k._durations.push((c - s) / 1000);
      }
    }
  }
  for (const [, k] of byCh.entries()) finalize(k, { channelKey: true });
  return byCh;
}

function empty() {
  return {
    assigned: 0, started: 0, submitted: 0, qc_passed: 0, qc_failed: 0, blocked: 0,
    //   channel KPI 는 assigned 대신 created 사용 → mirror keys
    created: 0, qc_pass: 0, qc_fail: 0,
    _durations: [],
    qc_pass_rate_pct: 0,
    avg_completion_seconds: null,
  };
}
function finalize(k, opts = {}) {
  //   QC pass rate: BLOCKED 는 분모 제외 (Owner spec §17)
  //     employee: pass / (pass+fail)
  //     channel : qc_pass / (qc_pass + qc_fail)
  const passE = k.qc_passed || 0;
  const failE = k.qc_failed || 0;
  const passC = k.qc_pass || 0;
  const failC = k.qc_fail || 0;
  const p = opts.channelKey ? passC : passE;
  const f = opts.channelKey ? failC : failE;
  const denom = p + f;
  k.qc_pass_rate_pct = denom > 0 ? Math.round((p / denom) * 10000) / 100 : 0;
  k.avg_completion_seconds = k._durations.length
    ? Math.round(k._durations.reduce((a, b) => a + b, 0) / k._durations.length)
    : null;
  delete k._durations;
}

//   ── DB layer ─────────────────────────────────────
async function loadAllB2cTasks(db, sinceIso) {
  const out = []; let off = 0;
  while (true) {
    let q = db.from('team_tasks')
      .select('id, assignee_id, channel, exception_type, status, qc_status, qc_fail_reason, blocked_reason, started_at, submitted_at, completed_at, created_at, qc_at')
      .range(off, off + 999);
    if (sinceIso) q = q.gte('created_at', sinceIso);
    const { data, error } = await q;
    if (error) throw new Error('tasks load: ' + error.message);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  //   B2C filter · in-memory (더 안전)
  return out.filter(t => isB2c(t.exception_type));
}

async function getEmployeeKpi({ db, sinceDays = 90 } = {}) {
  const sinceIso = new Date(Date.now() - Number(sinceDays) * 86400e3).toISOString();
  const tasks = await loadAllB2cTasks(db, sinceIso);
  const kpiMap = computeEmployeeKpi(tasks);
  //   join users
  const uids = Array.from(kpiMap.keys());
  const { data: users } = uids.length
    ? await db.from('users').select('id, username, display_name, b2c_operator, b2c_channels').in('id', uids)
    : { data: [] };
  const byId = new Map((users || []).map(u => [u.id, u]));
  return {
    since_days: sinceDays,
    at: new Date().toISOString(),
    employees: uids.map(uid => ({
      user_id: uid,
      username: byId.get(uid)?.username || null,
      display_name: byId.get(uid)?.display_name || null,
      b2c_operator: byId.get(uid)?.b2c_operator ?? null,
      b2c_channels: byId.get(uid)?.b2c_channels ?? null,
      ...kpiMap.get(uid),
    })),
  };
}

async function getChannelKpi({ db, sinceDays = 90 } = {}) {
  const sinceIso = new Date(Date.now() - Number(sinceDays) * 86400e3).toISOString();
  const tasks = await loadAllB2cTasks(db, sinceIso);
  const kpiMap = computeChannelKpi(tasks);
  return {
    since_days: sinceDays,
    at: new Date().toISOString(),
    channels: Array.from(kpiMap.entries()).map(([channel, k]) => ({ channel, ...k })),
  };
}

module.exports = {
  isB2c,
  computeEmployeeKpi,
  computeChannelKpi,
  getEmployeeKpi,
  getChannelKpi,
};
