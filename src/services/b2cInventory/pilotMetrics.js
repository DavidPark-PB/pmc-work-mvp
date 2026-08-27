'use strict';
/**
 * pilotMetrics.js — B2C · Phase 6 · Pilot 실행 이후 metrics 계산.
 *
 * Owner spec §18 · Phase 7 Dashboard 에서 사용될 계산 함수.
 * READ-ONLY · pure aggregation.
 */

const B2C_EXCEPTION_TYPES = new Set([
  'channel_register.ebay','channel_register.shopify','channel_register.coupang',
  'channel_register.naver','channel_register.11st','channel_register.gmarket',
  'channel_register.auction',
  'listing_error', 'qc',
  'data_quality.cost_missing',
]);
const CHANNEL_REGISTER_TYPES = new Set([
  'channel_register.coupang','channel_register.naver','channel_register.11st','channel_register.gmarket',
]);

async function loadAll(db, table, select, filter) {
  const out = []; let off = 0;
  while (true) {
    let q = db.from(table).select(select).range(off, off + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return out;
}

//   compute over already-loaded team_tasks list
function computeMetricsFromTasks(tasks) {
  const b2c = tasks.filter(t => B2C_EXCEPTION_TYPES.has(t.exception_type));
  const cr = b2c.filter(t => CHANNEL_REGISTER_TYPES.has(t.exception_type));

  const byStatus = {};
  for (const t of b2c) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  const byChannel = {};
  for (const t of cr) {
    const ch = t.channel || 'unknown';
    byChannel[ch] = byChannel[ch] || { created: 0, completed: 0, live: 0, error: 0 };
    byChannel[ch].created++;
    if (t.status === 'done') byChannel[ch].completed++;
    if (t.qc_status === 'pass') byChannel[ch].live++;
    if (t.qc_status === 'fail' || t.status === 'failed') byChannel[ch].error++;
  }

  //   avg completion time (seconds)
  const completed = b2c.filter(t => t.status === 'done' && t.created_at && t.completed_at);
  const avgSec = completed.length
    ? Math.round(completed.reduce((s, t) => s + (Date.parse(t.completed_at) - Date.parse(t.created_at)) / 1000, 0) / completed.length)
    : null;

  const errCount = b2c.filter(t => t.status === 'failed' || t.qc_status === 'fail').length;
  const errRate  = b2c.length > 0 ? Math.round((errCount / b2c.length) * 10000) / 100 : 0;

  return {
    tasks_total: b2c.length,
    tasks_by_status: byStatus,
    tasks_created:    b2c.length,
    tasks_started:    b2c.filter(t => t.status === 'in_progress' || t.status === 'qc_pending' || t.status === 'done').length,
    tasks_completed:  byStatus.done || 0,
    tasks_qc_pending: byStatus.qc_pending || 0,
    live_count:       b2c.filter(t => t.qc_status === 'pass').length,
    average_completion_seconds: avgSec,
    error_count:      errCount,
    error_rate_pct:   errRate,
    by_channel:       byChannel,
  };
}

async function computePilotMetrics({ db }) {
  //   activated SKUs · channel_eligibility 가 array (non-null non-empty) 인 SKU
  const scRows = await loadAll(db, 'sku_master', 'id, channel_eligibility, status', q => q.eq('status', 'active'));
  const activated = scRows.filter(r => Array.isArray(r.channel_eligibility) && r.channel_eligibility.length > 0);

  const tasks = await loadAll(db, 'team_tasks',
    'id, exception_type, channel, status, qc_status, created_at, completed_at, assignee_id');
  const metrics = computeMetricsFromTasks(tasks);

  return {
    at: new Date().toISOString(),
    activated_skus: activated.length,
    ...metrics,
  };
}

module.exports = {
  B2C_EXCEPTION_TYPES,
  CHANNEL_REGISTER_TYPES,
  computeMetricsFromTasks,
  computePilotMetrics,
};
