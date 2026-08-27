'use strict';
/**
 * b2cTasks.js — B2C · Phase 5 · Controlled Task Queue admin API.
 *
 * server.js mount: /api/b2c/tasks
 *
 * Endpoints (모두 requireAdmin · Owner spec §18-§19):
 *   POST /channel-register/refill/preview   ← dryRun 결과만 반환 · DB write 없음
 *   POST /channel-register/refill           ← 실제 INSERT · target/max_per_refill hard limit
 *   POST /data-quality/cost-missing/refill/preview
 *   POST /data-quality/cost-missing/refill
 *   POST /:id/data-quality-complete         ← cost_krw NOT NULL 재검증 후 done 처리
 *   POST /eligibility/preview               ← bulk eligibility preview (DB write 없음)
 *   POST /eligibility/bulk                  ← bulk eligibility execute
 *   GET  /purchase-signals                  ← OUT_OF_STOCK_WITH_SALES 목록 (read-only signal)
 *
 * Body 예:
 *   /channel-register/refill/preview        {}                                          (config default 사용)
 *   /channel-register/refill/preview        { what_if_mode: 1 }                         (default_eligibility_mode 재정의 · 메모리에서만)
 *   /channel-register/refill                {}                                          (실제 INSERT)
 *   /eligibility/preview                    { filters: {...}, action: { type: 'korea_all' } }
 *   /eligibility/bulk                       { filters: {...}, action: { type: 'set_channels', channels: [...] } }
 *
 * Response · 감사 로그 필드 (Owner spec §17): run_id · dry_run · started_at · finished_at
 *   · active_before · target · slots_available · candidates_evaluated · filtered · errors
 *   · channel_tasks_planned/created · data_quality_tasks_planned/created
 */

const express = require('express');
const router = express.Router();
const { getClient } = require('../../db/supabaseClient');
const { authGuard, requireAdmin } = require('../../middleware/auth');
const queueRefill = require('../../services/b2cInventory/queueRefill');
const dq = require('../../services/b2cInventory/dataQualityTasks');
const elig = require('../../services/b2cInventory/eligibilityBulk');
const ps = require('../../services/b2cInventory/purchaseSignals');
const pilot = require('../../services/b2cInventory/pilotSelection');
const autoAssign = require('../../services/b2cInventory/autoAssignment');
const metrics = require('../../services/b2cInventory/pilotMetrics');
const events = require('../../services/b2cInventory/executionEvents');
const waves = require('../../services/b2cInventory/pilotWaves');

//   preview 는 read-heavy (전 scorecard load) 지만 write 없음. admin 만 사용하도록 통제.
router.use(authGuard);
router.use(requireAdmin);

//   ── Channel Register queue ─────────────────────────────
//   Body 옵션 (모두 optional):
//     what_if_mode          0 | 1 (메모리에서만 default_eligibility_mode 재정의)
//     allocation_strategy   'GLOBAL_PRIORITY' (default) | 'BALANCED_CHANNEL'
//     pilot_max_tasks       정수 (global max 보다 작을 때만 유효)
//     auto_assign           true | false (config 값 override · 기본은 config 사용)
router.post('/channel-register/refill/preview', async (req, res) => {
  try {
    const db = getClient();
    const b = req.body || {};
    const result = await queueRefill.refillChannelRegistrationQueue({
      db, dryRun: true,
      whatIfMode:         b.what_if_mode != null ? Number(b.what_if_mode) : null,
      allocationStrategy: b.allocation_strategy || 'GLOBAL_PRIORITY',
      pilotMaxTasks:      b.pilot_max_tasks != null ? Number(b.pilot_max_tasks) : null,
      autoAssignEnabled:  typeof b.auto_assign === 'boolean' ? b.auto_assign : null,
      skuIds:             Array.isArray(b.sku_ids) ? b.sku_ids : null,
      assignmentMode:     b.assignment_mode || null,
      channelOwners:      b.channel_owners || null,
    });
    //   Phase 7.6: Wave 실행 전 all_assigned readiness gate
    const summary = result.assignment_summary;
    const readyForExecute =
      (result.assignment_mode !== 'UNASSIGNED') &&
      summary && summary.all_assigned === true &&
      (result.assignment_errors == null || result.assignment_errors.length === 0);
    result.execute_ready = !!readyForExecute;
    result.plan_preview = (result.plan || []).slice(0, 30);
    delete result.plan;
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] refill preview error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/channel-register/refill', async (req, res) => {
  try {
    const db = getClient();
    const b = req.body || {};
    const result = await queueRefill.refillChannelRegistrationQueue({
      db, dryRun: false,
      whatIfMode:         b.what_if_mode != null ? Number(b.what_if_mode) : null,
      allocationStrategy: b.allocation_strategy || 'GLOBAL_PRIORITY',
      pilotMaxTasks:      b.pilot_max_tasks != null ? Number(b.pilot_max_tasks) : null,
      autoAssignEnabled:  typeof b.auto_assign === 'boolean' ? b.auto_assign : null,
      userId:             req.user?.id,
      skuIds:             Array.isArray(b.sku_ids) ? b.sku_ids : null,
      assignmentMode:     b.assignment_mode || null,
      channelOwners:      b.channel_owners || null,
    });
    //   Phase 7.6: validation 실패 → 400 · 부분 생성 방지 (아무 것도 INSERT 안 됨)
    if (result.ok === false && result.code === 'ASSIGNMENT_VALIDATION_FAILED') {
      return res.status(400).json({ error: result.code, details: result });
    }
    delete result.plan;
    console.log('[b2cTasks] channel_register refill EXECUTED', {
      run_id: result.run_id, created: result.channel_tasks_created,
      allocation_strategy: result.allocation_strategy,
      assignment_mode: result.assignment_mode,
      assignment: result.assignment,
      by_user_id: req.user?.id, by_user: req.user?.username,
    });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] refill execute error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── Pilot endpoints (Phase 6) ──────────────────────────
router.post('/pilot/preview', async (req, res) => {
  try {
    const db = getClient();
    const size = Number((req.body || {}).size) || 50;
    const result = await pilot.pilotPreview({ db, size });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] pilot preview error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/pilot/activate', async (req, res) => {
  try {
    const db = getClient();
    const size = Number((req.body || {}).size) || 50;
    //   Phase 7.5 · sku_ids 지정 시 Wave 특정 SKU 만 activate
    const skuIds = Array.isArray((req.body || {}).sku_ids) ? (req.body || {}).sku_ids : null;
    const waveLabel = (req.body || {}).wave || null;
    const result = await pilot.pilotActivate({ db, size, userId: req.user?.id, skuIds, waveLabel });
    events.log('PILOT_ELIGIBILITY_ACTIVATED', {
      size, wave: waveLabel,
      requested: result.results?.requested,
      activated: result.results?.activated, unchanged: result.results?.unchanged,
      skipped_due_to_drift: result.results?.skipped_due_to_drift,
      errors: result.results?.errors?.length || 0, by_user: req.user?.username,
    });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] pilot activate error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── Wave endpoints (Phase 7.5) ─────────────────────────
router.get('/pilot/wave-plan', async (req, res) => {
  try {
    const db = getClient();
    const size = Number(req.query.size) || 50;
    const preview = await pilot.pilotPreview({ db, size });
    const plan = waves.planWaves(preview.top);
    res.json({ data: {
      pilot_size: size,
      preview_matched: preview.total_pilot_matched,
      preview_selected: preview.selected,
      wave_plan: plan,
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pilot/wave/:waveId/preview', async (req, res) => {
  try {
    const waveId = parseInt(req.params.waveId, 10);
    if (!Number.isFinite(waveId) || waveId < 1 || waveId > waves.WAVE_PLAN.length) {
      return res.status(400).json({ error: `invalid wave id (1..${waves.WAVE_PLAN.length})` });
    }
    const db = getClient();
    const size = Number((req.body || {}).size) || 50;
    const preview = await pilot.pilotPreview({ db, size });
    const skuIds = waves.waveSkuIds(preview.top, waveId);
    //   preview 필터
    const waveTop = preview.top.filter(t => skuIds.includes(Number(t.sku_master_id)));
    //   예상 Task refill dry-run (skuIds 제한)
    const refill = await require('../../services/b2cInventory/queueRefill').refillChannelRegistrationQueue({
      db, dryRun: true, whatIfMode: null,
      allocationStrategy: 'GLOBAL_PRIORITY', pilotMaxTasks: 100,
      skuIds,
    });
    res.json({ data: {
      wave_id: waveId, sku_ids: skuIds,
      wave_top: waveTop,
      expected_channel_tasks: refill.channel_tasks_planned,
      refill_filtered: refill.filtered,
      plan_preview: refill.plan.slice(0, 30),
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pilot/wave/:waveId/activate', async (req, res) => {
  try {
    const waveId = parseInt(req.params.waveId, 10);
    if (!Number.isFinite(waveId) || waveId < 1 || waveId > waves.WAVE_PLAN.length) {
      return res.status(400).json({ error: `invalid wave id (1..${waves.WAVE_PLAN.length})` });
    }
    const db = getClient();
    const size = Number((req.body || {}).size) || 50;
    const preview = await pilot.pilotPreview({ db, size });
    const skuIds = waves.waveSkuIds(preview.top, waveId);
    const result = await pilot.pilotActivate({
      db, size, userId: req.user?.id, skuIds, waveLabel: `wave_${waveId}`,
    });
    res.json({ data: { wave_id: waveId, sku_ids: skuIds, ...result } });
  } catch (e) {
    console.error('[b2cTasks] pilot wave activate error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/pilot/wave/:waveId/gate', async (req, res) => {
  try {
    const waveId = parseInt(req.params.waveId, 10);
    const db = getClient();
    const gate = await waves.checkWavePromotionGate({ db, waveId });
    res.json({ data: gate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/pilot/stop-conditions', async (req, res) => {
  try {
    const db = getClient();
    const approved = req.query.approved_sku_ids
      ? String(req.query.approved_sku_ids).split(',').map(s => Number(s.trim())).filter(Number.isFinite)
      : null;
    const result = await waves.detectPilotStopConditions({ db, approvedSkuIds: approved });
    res.json({ data: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

//   ── Assignment simulation (READ-ONLY) ─────────────────
router.post('/assignment/simulate', async (req, res) => {
  try {
    const db = getClient();
    const b = req.body || {};
    //   1) plan 을 dry-run 으로 만들어서
    const refill = await queueRefill.refillChannelRegistrationQueue({
      db, dryRun: true,
      whatIfMode:         b.what_if_mode != null ? Number(b.what_if_mode) : null,
      allocationStrategy: b.allocation_strategy || 'GLOBAL_PRIORITY',
      pilotMaxTasks:      b.pilot_max_tasks != null ? Number(b.pilot_max_tasks) : null,
      autoAssignEnabled:  false,   //   simulation 은 assignee 부여 안 함 (분리)
    });
    //   2) plan 에 대해 배정 시뮬레이션
    const sim = await autoAssign.simulateAssignment({ db, plan: refill.plan });
    res.json({ data: {
      run_id: refill.run_id, allocation_strategy: refill.allocation_strategy,
      pilot_max_tasks: refill.pilot_max_tasks,
      plan_size: refill.plan.length,
      assignment_simulation: sim,
    }});
  } catch (e) {
    console.error('[b2cTasks] assignment sim error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── Pilot metrics (READ-ONLY) ─────────────────────────
router.get('/metrics', async (req, res) => {
  try {
    const db = getClient();
    const result = await metrics.computePilotMetrics({ db });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] metrics error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── DATA_QUALITY (cost_missing) queue ──────────────────
router.post('/data-quality/cost-missing/refill/preview', async (req, res) => {
  try {
    const db = getClient();
    const result = await dq.refillDataQualityCostMissingQueue({ db, dryRun: true });
    result.plan_preview = result.plan.slice(0, 30);
    delete result.plan;
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] dq preview error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/data-quality/cost-missing/refill', async (req, res) => {
  try {
    const db = getClient();
    const result = await dq.refillDataQualityCostMissingQueue({ db, dryRun: false });
    delete result.plan;
    console.log('[b2cTasks] data_quality.cost_missing refill EXECUTED', {
      run_id: result.run_id, created: result.data_quality_tasks_created,
      by_user_id: req.user?.id, by_user: req.user?.username,
    });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] dq execute error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/data-quality-complete', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'invalid id' });
    const db = getClient();
    const result = await dq.completeDataQualityCostMissing({ db, taskId, userId: req.user?.id });
    if (!result.ok) return res.status(400).json({ error: result.message || result.code, code: result.code, details: result });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] dq complete error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── Eligibility bulk ────────────────────────────────────
router.post('/eligibility/preview', async (req, res) => {
  try {
    const db = getClient();
    const { filters = {}, action = { type: 'korea_all' } } = req.body || {};
    const result = await elig.previewBulkEligibility({ db, filters, action });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] eligibility preview error:', e);
    res.status(400).json({ error: e.message });
  }
});

router.post('/eligibility/bulk', async (req, res) => {
  try {
    const db = getClient();
    const { filters = {}, action = { type: 'korea_all' } } = req.body || {};
    const result = await elig.executeBulkEligibility({ db, filters, action, userId: req.user?.id });
    console.log('[b2cTasks] eligibility bulk EXECUTED', {
      updated: result.results?.updated, unchanged: result.results?.unchanged,
      by_user_id: req.user?.id, by_user: req.user?.username,
    });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] eligibility bulk error:', e);
    res.status(400).json({ error: e.message });
  }
});

//   ── Purchase signals ────────────────────────────────────
router.get('/purchase-signals', async (req, res) => {
  try {
    const db = getClient();
    const threshold = req.query.threshold ? Number(req.query.threshold) : 3;
    const result = await ps.listPurchaseSignals({ db, threshold });
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cTasks] purchase signals error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
