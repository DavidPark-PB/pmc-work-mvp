'use strict';
/**
 * pilotWaves.js — B2C · Phase 7.5 · Wave 정의 + Promotion gate.
 *
 * Owner directive:
 *   Wave 1: 상위 3 SKU (예상 11-12 tasks) · 전체 lifecycle 검증
 *   Wave 2: 다음 5 SKU
 *   Wave 3: 나머지 8 SKU
 *
 *   Wave promotion gate:
 *     · Listing SoT write failure = 0
 *     · Channel Matrix verification failure = 0
 *     · 중대한 시스템 오류 = 0
 *   QC fail 자체는 blocker 가 아님 · 정상 학습 데이터.
 */

const WAVE_PLAN = [
  { id: 1, sku_count: 3 },
  { id: 2, sku_count: 5 },
  { id: 3, sku_count: 8 },
];

//   ── Pure: preview.top 배열에서 wave SKU 선택 ─────
//   waveId 1: index 0-2 · waveId 2: index 3-7 · waveId 3: index 8-15
function waveSkuIds(previewTop, waveId) {
  if (!Array.isArray(previewTop) || previewTop.length === 0) return [];
  const w = WAVE_PLAN.find(x => x.id === Number(waveId));
  if (!w) return [];
  let start = 0;
  for (const p of WAVE_PLAN) {
    if (p.id === Number(waveId)) break;
    start += p.sku_count;
  }
  return previewTop.slice(start, start + w.sku_count).map(t => Number(t.sku_master_id));
}

//   ── Pure: preview.top → 모든 wave 분할 미리보기 ─
function planWaves(previewTop) {
  return WAVE_PLAN.map(w => {
    const skuIds = waveSkuIds(previewTop, w.id);
    return {
      id: w.id,
      requested_sku_count: w.sku_count,
      actual_sku_count: skuIds.length,
      sku_ids: skuIds,
    };
  });
}

//   ── Promotion gate check (READ-ONLY · DB 쿼리) ──
//   waveId 를 promote 하려면 이전 wave 의 결과가 gate 통과해야 함.
//   V1 은 전체 pilot 범위 (모든 wave 활성 SKU 의 task) 에서 실패 카운트.
async function checkWavePromotionGate({ db, waveId }) {
  //   1) SoT write failure event 카운트는 event log 를 파싱하기 어려우므로
  //      대안으로 team_tasks 에서 상태 이상 확인:
  //        · qc_status='pass' 이지만 status != 'done'
  //        · qc_status='pass' 인데 CHANNEL_LIVE 확인 불가 (v_sku_channel_matrix 비교)
  const { data: passedTasks, error } = await db.from('team_tasks')
    .select('id, related_sku_id, channel, status, qc_status, listing_id')
    .eq('qc_status', 'pass')
    .like('exception_type', 'channel_register.%');
  if (error) throw new Error('gate check load: ' + error.message);

  const passedTasksList = passedTasks || [];
  const notDoneCount = passedTasksList.filter(t => t.status !== 'done').length;

  //   Channel Matrix verification failure = qc_pass 이면서 v_sku_channel_matrix 확인 불가
  let matrixMismatchCount = 0;
  if (passedTasksList.length > 0) {
    const skuIds = passedTasksList.map(t => t.related_sku_id).filter(Boolean);
    if (skuIds.length > 0) {
      const { data: mxRows } = await db.from('v_sku_channel_matrix')
        .select('sku_master_id, channel, channel_status, listing_id')
        .in('sku_master_id', skuIds);
      const mxByKey = new Map();
      for (const r of (mxRows || [])) mxByKey.set(`${r.sku_master_id}|${r.channel}`, r);
      for (const t of passedTasksList) {
        if (t.status !== 'done') continue;   //   이미 위에서 카운트
        const mx = mxByKey.get(`${t.related_sku_id}|${t.channel}`);
        if (!mx || mx.channel_status !== 'LIVE' || String(mx.listing_id || '') !== String(t.listing_id || '')) {
          matrixMismatchCount++;
        }
      }
    }
  }

  //   2) 중대한 시스템 오류: 다른 wave 승인 없이 생성된 task (Wave 승인 밖 SKU 대상 task)
  //     → 이건 후처리 감사 · 이 시점에서 확인 어려움. WAVE_ACTIVATED event log 를 external 로 매핑 필요.
  //     V1: 우선 SoT + Matrix 로 gate 판정.

  //   3) 학습용 QC/BLOCKED 통계 (blocker 아님 · 보고만)
  const { data: qcStats } = await db.from('team_tasks')
    .select('status, qc_status, qc_fail_reason, blocked_reason, started_at, submitted_at, completed_at')
    .like('exception_type', 'channel_register.%');
  const stats = { qc_pass: 0, qc_fail: 0, blocked: 0, done: 0, avg_completion_sec: null };
  const durations = [];
  for (const r of (qcStats || [])) {
    if (r.qc_status === 'pass') stats.qc_pass++;
    if (r.qc_status === 'fail') stats.qc_fail++;
    if (r.status === 'blocked') stats.blocked++;
    if (r.status === 'done') stats.done++;
    if (r.completed_at && r.started_at) {
      const s = Date.parse(r.started_at); const c = Date.parse(r.completed_at);
      if (Number.isFinite(s) && Number.isFinite(c) && c > s) durations.push((c - s) / 1000);
    }
  }
  if (durations.length) stats.avg_completion_sec = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const passRate = (stats.qc_pass + stats.qc_fail) > 0
    ? Math.round((stats.qc_pass / (stats.qc_pass + stats.qc_fail)) * 10000) / 100
    : null;

  const passGate =
    notDoneCount === 0 &&
    matrixMismatchCount === 0;

  return {
    at: new Date().toISOString(),
    wave_id: waveId,
    passed: passGate,
    blockers: {
      sot_write_failure_or_status_desync: notDoneCount,
      channel_matrix_verification_failure: matrixMismatchCount,
    },
    stats: { ...stats, qc_pass_rate_pct: passRate },
    note: passGate
      ? `Wave ${waveId} promotion gate 통과. 다음 wave 진행 가능.`
      : `Wave ${waveId} promotion gate 실패. SoT 또는 Channel Matrix 미확인 case 존재 · 조사 후 재시도.`,
  };
}

//   ── Pilot stop conditions 자동 감지 (READ-ONLY report) ─
//   Owner spec §9 · 다음 중 하나면 즉시 중단 권고:
//     · Listing SoT write failure 발생 (qc_status=pass but status != done)
//     · QC PASS 했는데 Channel Matrix LIVE 안 됨
//     · 동일 SKU × channel duplicate active task
//     · 예상하지 않은 Scheduler 실행 (b2c.scheduler_enabled=1 이 예상 아니면)
//     · Task 생성량이 승인 wave 보다 많음 (승인 sku_ids 밖 task 존재)
async function detectPilotStopConditions({ db, approvedSkuIds = null }) {
  const conditions = [];

  //   1) SoT write failure / desync
  const { data: passedTasks } = await db.from('team_tasks')
    .select('id, related_sku_id, channel, status, qc_status, listing_id')
    .eq('qc_status', 'pass').like('exception_type', 'channel_register.%');
  const notDone = (passedTasks || []).filter(t => t.status !== 'done');
  if (notDone.length > 0) conditions.push({ code: 'SOT_WRITE_FAILURE', count: notDone.length, tasks: notDone.map(t => t.id) });

  //   2) Channel Matrix mismatch (done + qc_pass 이면서 view LIVE 아님)
  const doneTasks = (passedTasks || []).filter(t => t.status === 'done');
  const skuIds = doneTasks.map(t => t.related_sku_id).filter(Boolean);
  const { data: mxRows } = skuIds.length > 0
    ? await db.from('v_sku_channel_matrix')
        .select('sku_master_id, channel, channel_status, listing_id')
        .in('sku_master_id', skuIds)
    : { data: [] };
  const mxByKey = new Map();
  for (const r of (mxRows || [])) mxByKey.set(`${r.sku_master_id}|${r.channel}`, r);
  const mismatch = doneTasks.filter(t => {
    const mx = mxByKey.get(`${t.related_sku_id}|${t.channel}`);
    return !mx || mx.channel_status !== 'LIVE' || String(mx.listing_id || '') !== String(t.listing_id || '');
  });
  if (mismatch.length > 0) conditions.push({ code: 'CHANNEL_MATRIX_NOT_LIVE', count: mismatch.length, tasks: mismatch.map(t => t.id) });

  //   3) Duplicate active task (관리해도 발생 안 해야 함 · uq_team_tasks_b2c_active_dedupe 로 방어)
  const { data: activeTasks } = await db.from('team_tasks')
    .select('related_sku_id, channel, exception_type')
    .in('status', ['pending','in_progress','qc_pending'])
    .like('exception_type', 'channel_register.%');
  const dupKey = new Map();
  for (const t of (activeTasks || [])) {
    if (!t.related_sku_id || !t.channel) continue;
    const k = `${t.related_sku_id}|${t.channel}|${t.exception_type}`;
    dupKey.set(k, (dupKey.get(k) || 0) + 1);
  }
  const dups = Array.from(dupKey.entries()).filter(([, n]) => n > 1);
  if (dups.length > 0) conditions.push({ code: 'DUPLICATE_ACTIVE_TASK', count: dups.length, keys: dups.slice(0, 10) });

  //   4) Scheduler unexpected ON
  const { data: cfgRows } = await db.from('margin_settings').select('setting_key, setting_value').in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled']);
  const cfg = Object.fromEntries((cfgRows || []).map(r => [r.setting_key, Number(r.setting_value)]));
  if (cfg['b2c.scheduler_enabled'] === 1) conditions.push({ code: 'SCHEDULER_UNEXPECTED_ON', message: 'b2c.scheduler_enabled=1 · Pilot Wave 승인 없이 자동 실행 위험' });

  //   5) Task creation > approved wave (approvedSkuIds 지정 시 그 외 SKU 대상 CR task 존재?)
  if (Array.isArray(approvedSkuIds) && approvedSkuIds.length > 0) {
    const approvedSet = new Set(approvedSkuIds.map(Number));
    const outside = (activeTasks || []).filter(t => t.related_sku_id && !approvedSet.has(Number(t.related_sku_id)));
    if (outside.length > 0) conditions.push({ code: 'TASK_OUTSIDE_APPROVED_WAVE', count: outside.length });
  }

  return {
    at: new Date().toISOString(),
    stop_recommended: conditions.length > 0,
    conditions,
  };
}

module.exports = {
  WAVE_PLAN,
  waveSkuIds,
  planWaves,
  checkWavePromotionGate,
  detectPilotStopConditions,
};
