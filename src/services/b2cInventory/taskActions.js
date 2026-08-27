'use strict';
/**
 * taskActions.js — B2C · Phase 7 · Task lifecycle actions.
 *
 * Owner directive:
 *   · START · SUBMIT · BLOCKED · QC_PASS · QC_FAIL · QC_RESUBMIT
 *   · 다른 직원 task 시작 금지 (assignee 검증)
 *   · SUBMIT 시 CHANNEL_REGISTER 는 listing_id/listing_url/selling_price 필수
 *   · SUBMIT → status=qc_pending · qc_status=pending
 *   · QC PASS → done · sku_listing_link/platform_listings 반영 (listingSot.js)
 *   · QC FAIL → in_progress · qc_fail_reason 필수 · qc_resubmit_count 증가
 *   · BLOCKED → status=blocked · blocked_reason 필수
 *   · 이벤트 로그: TASK_STARTED · TASK_SUBMITTED · QC_FAILED · QC_PASSED · BLOCKED
 */

const events = require('./executionEvents');
const listingSot = require('./listingSot');

const BLOCKED_REASONS = new Set([
  'BRAND_RESTRICTION','CATEGORY_UNKNOWN','MISSING_CERTIFICATION',
  'MISSING_PRODUCT_INFO','PLATFORM_ERROR','ACCOUNT_PERMISSION','PRICE_PROBLEM','OTHER',
]);
const QC_FAIL_REASONS = new Set([
  'WRONG_PRODUCT','WRONG_PRICE','BROKEN_URL','WRONG_CHANNEL',
  'MISSING_REQUIRED_DATA','LISTING_NOT_LIVE','OTHER',
]);

//   ── Pure validators ─────────────────────────────────
function validateSubmitBody(body, task) {
  const b = body || {};
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  const et = String(task.exception_type || '');
  if (et.startsWith('channel_register.')) {
    if (!b.listing_id || String(b.listing_id).trim() === '') return { ok: false, code: 'LISTING_ID_REQUIRED' };
    if (!b.listing_url || !/^https?:\/\//i.test(String(b.listing_url))) return { ok: false, code: 'LISTING_URL_INVALID' };
    const price = Number(b.selling_price);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, code: 'SELLING_PRICE_INVALID' };
    return { ok: true, value: {
      listing_id: String(b.listing_id).trim(),
      listing_url: String(b.listing_url).trim(),
      selling_price: price,
      marketplace_sku: b.marketplace_sku ? String(b.marketplace_sku).trim() : null,
    }};
  }
  //   data_quality.* 는 submit 없이 별도 endpoint 로 완료 (completeDataQualityCostMissing)
  return { ok: true, value: {} };
}

function validateBlockedBody(body) {
  const b = body || {};
  if (!b.reason || !BLOCKED_REASONS.has(String(b.reason))) {
    return { ok: false, code: 'BLOCKED_REASON_INVALID', allowed: Array.from(BLOCKED_REASONS) };
  }
  return { ok: true, value: { reason: b.reason, memo: b.memo ? String(b.memo).slice(0, 500) : null } };
}

function validateQcFailBody(body) {
  const b = body || {};
  if (!b.reason || !QC_FAIL_REASONS.has(String(b.reason))) {
    return { ok: false, code: 'QC_FAIL_REASON_INVALID', allowed: Array.from(QC_FAIL_REASONS) };
  }
  return { ok: true, value: { reason: b.reason, memo: b.memo ? String(b.memo).slice(0, 500) : null } };
}

//   ── Authorization ──────────────────────────────────
function canUserActOnTask(user, task) {
  if (!user || !task) return false;
  if (user.isAdmin) return true;
  //   본인 배정만 · fanout pool (assignee_id=NULL, scope=operators) 은 admin 만 배정/시작 가능
  return Number(task.assignee_id) === Number(user.id);
}

//   ── DB actions ─────────────────────────────────────
async function startTask({ db, taskId, user }) {
  const { data: task, error: e1 } = await db.from('team_tasks').select('*').eq('id', taskId).maybeSingle();
  if (e1) throw new Error(`task load: ${e1.message}`);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  if (!canUserActOnTask(user, task)) return { ok: false, code: 'NOT_YOUR_TASK' };
  if (task.status !== 'pending' && task.status !== 'qc_pending') {
    //   qc_pending → in_progress 는 QC FAIL 이후 resubmit 흐름. 여기서는 pending 만 허용
    return { ok: false, code: 'BAD_STATUS_FOR_START', current: task.status };
  }
  const patch = {
    status: 'in_progress',
    started_at: task.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: updated, error: e2 } = await db.from('team_tasks').update(patch).eq('id', taskId).select('*').maybeSingle();
  if (e2) return { ok: false, code: 'UPDATE_FAILED', message: e2.message };
  events.log('TASK_STARTED', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, by_user: user?.username });
  return { ok: true, code: 'STARTED', task: updated };
}

async function submitTask({ db, taskId, user, body }) {
  const { data: task, error: e1 } = await db.from('team_tasks').select('*').eq('id', taskId).maybeSingle();
  if (e1) throw new Error(`task load: ${e1.message}`);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  if (!canUserActOnTask(user, task)) return { ok: false, code: 'NOT_YOUR_TASK' };
  if (task.status !== 'in_progress') return { ok: false, code: 'MUST_BE_IN_PROGRESS', current: task.status };
  const v = validateSubmitBody(body, task);
  if (!v.ok) return v;
  const now = new Date().toISOString();
  const patch = {
    status: 'qc_pending',
    qc_status: 'pending',
    submitted_at: now,
    updated_at: now,
    ...v.value,
  };
  const { data: updated, error: e2 } = await db.from('team_tasks').update(patch).eq('id', taskId).select('*').maybeSingle();
  if (e2) return { ok: false, code: 'UPDATE_FAILED', message: e2.message };
  events.log('TASK_SUBMITTED', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, by_user: user?.username });
  return { ok: true, code: 'SUBMITTED', task: updated };
}

async function blockTask({ db, taskId, user, body }) {
  const { data: task, error: e1 } = await db.from('team_tasks').select('*').eq('id', taskId).maybeSingle();
  if (e1) throw new Error(`task load: ${e1.message}`);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  if (!canUserActOnTask(user, task)) return { ok: false, code: 'NOT_YOUR_TASK' };
  if (!['pending','in_progress'].includes(task.status)) return { ok: false, code: 'BAD_STATUS_FOR_BLOCK', current: task.status };
  const v = validateBlockedBody(body);
  if (!v.ok) return v;
  const now = new Date().toISOString();
  const patch = {
    status: 'blocked',
    blocked_reason: v.value.reason,
    blocked_at: now,
    memo: v.value.memo ? (task.memo ? `${task.memo}\n[BLOCKED] ${v.value.memo}` : `[BLOCKED] ${v.value.memo}`) : task.memo,
    updated_at: now,
  };
  const { data: updated, error: e2 } = await db.from('team_tasks').update(patch).eq('id', taskId).select('*').maybeSingle();
  if (e2) return { ok: false, code: 'UPDATE_FAILED', message: e2.message };
  events.log('TASK_BLOCKED', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, reason: v.value.reason, by_user: user?.username });
  return { ok: true, code: 'BLOCKED', task: updated };
}

//   ── QC actions (admin/reviewer) ───────────────────
function canQc(user) {
  return !!(user && user.isAdmin);
}

//   Phase 7.5 · fail-closed atomic-ish QC PASS
//   순서:
//     1) task load + idempotency check (이미 done/pass 이면 no-op success)
//     2) SoT write (sku_listing_link + platform_listings)
//     3) SoT 결과 재조회 (v_sku_channel_matrix 에서 channel_status=LIVE + listing_id 일치)
//     4) 3단계 모두 성공하면 task done · 실패 시 task 상태 유지 (qc_pending)
//
//   Supabase 는 multi-table 원자 transaction 이 REST 로 어려움 → fail-closed 순서로 보증.
//   idempotency: (sku, channel, listing_id) 동일 재실행 안전 · double-click 방어.
async function qcPass({ db, taskId, user }) {
  if (!canQc(user)) return { ok: false, code: 'QC_ADMIN_ONLY' };
  const { data: task, error: e1 } = await db.from('team_tasks').select('*').eq('id', taskId).maybeSingle();
  if (e1) throw new Error(`task load: ${e1.message}`);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };

  //   ── 1) IDEMPOTENCY: 이미 done + qc_status=pass 인 task 에 대한 재요청은 no-op ─
  if (task.status === 'done' && task.qc_status === 'pass') {
    events.log('QC_PASS_IDEMPOTENT_NOOP', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, by_user: user?.username });
    return { ok: true, code: 'QC_PASSED_IDEMPOTENT', task, sot_result: { ok: true, code: 'ALREADY_DONE' } };
  }
  if (task.status !== 'qc_pending') return { ok: false, code: 'MUST_BE_QC_PENDING', current: task.status };

  const isChannelRegister = String(task.exception_type || '').startsWith('channel_register.');
  const now = new Date().toISOString();

  //   ── 2) SoT write (CHANNEL_REGISTER 만) ─────────────
  let sotResult = null;
  if (isChannelRegister) {
    if (!task.related_sku_id || !task.channel || !task.listing_id) {
      return { ok: false, code: 'TASK_MISSING_REQUIRED_FIELDS', details: {
        related_sku_id: task.related_sku_id, channel: task.channel, listing_id: task.listing_id,
      }};
    }
    try {
      sotResult = await listingSot.upsertListingFromTask({
        db,
        sku_master_id: task.related_sku_id,
        channel: task.channel,
        listing_id: task.listing_id,
        listing_url: task.listing_url,
        selling_price: task.selling_price,
      });
    } catch (e) {
      sotResult = { ok: false, code: 'SOT_EXCEPTION', error: e.message };
    }
    if (!sotResult || !sotResult.ok) {
      //   FAIL-CLOSED: task 상태 유지 · 관리자에게 명확한 오류 반환
      events.log('LISTING_SOT_WRITE_FAILED', {
        task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel,
        listing_id: task.listing_id, sot: sotResult, by_user: user?.username,
      });
      return {
        ok: false,
        code: 'LISTING_SOT_WRITE_FAILED',
        message: 'Listing SoT (sku_listing_link + platform_listings) UPSERT 실패. task 상태 qc_pending 유지 · 재시도 필요.',
        sot_result: sotResult,
      };
    }
    events.log('LISTING_SOT_WRITTEN', {
      task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel,
      listing_id: task.listing_id, sot: sotResult, by_user: user?.username,
    });

    //   ── 3) Channel Matrix verification 재조회 ─────
    //     v_sku_channel_matrix 에서 (sku_master_id, channel) row 재조회 · channel_status=LIVE + listing_id 일치
    const { data: mxRows, error: mxErr } = await db.from('v_sku_channel_matrix')
      .select('channel, channel_status, listing_id, raw_status')
      .eq('sku_master_id', task.related_sku_id)
      .eq('channel', task.channel);
    if (mxErr) {
      events.log('CHANNEL_LIVE_VERIFICATION_FAILED', { task_id: taskId, error: mxErr.message });
      return {
        ok: false, code: 'CHANNEL_MATRIX_VERIFICATION_ERROR',
        message: `Channel Matrix 재조회 실패: ${mxErr.message}`, sot_result: sotResult,
      };
    }
    const mxRow = (mxRows || []).find(r => r.channel === task.channel);
    const verifyOk = mxRow && mxRow.channel_status === 'LIVE' && String(mxRow.listing_id || '') === String(task.listing_id || '');
    if (!verifyOk) {
      events.log('CHANNEL_LIVE_VERIFICATION_FAILED', {
        task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel,
        listing_id_expected: task.listing_id, matrix_row: mxRow,
      });
      return {
        ok: false, code: 'CHANNEL_MATRIX_NOT_LIVE',
        message: `SoT UPSERT 는 성공했지만 v_sku_channel_matrix 재조회에서 channel_status=LIVE + listing_id 일치 확인 실패.`,
        matrix_row: mxRow, sot_result: sotResult,
      };
    }
    events.log('CHANNEL_LIVE_VERIFIED', {
      task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel,
      listing_id: task.listing_id, matrix_row: mxRow,
    });
  }

  //   ── 4) 모두 성공 → task done ────────────────────
  const patch = {
    status: 'done',
    qc_status: 'pass',
    qc_user_id: user.id,
    qc_at: now,
    completed_at: now,
    completion_note: `QC PASS by ${user.username}`,
    updated_at: now,
  };
  const { data: updated, error: e2 } = await db.from('team_tasks').update(patch).eq('id', taskId).select('*').maybeSingle();
  if (e2) {
    //   Note: 여기서 실패해도 SoT 는 이미 반영됨. task 만 재시도 안전 (idempotent · 재실행 시 no-op).
    return { ok: false, code: 'UPDATE_FAILED', message: e2.message, sot_result: sotResult };
  }
  events.log('QC_PASSED', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, by_user: user?.username, sot: sotResult });
  events.log('CHANNEL_LIVE', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, listing_id: task.listing_id });
  return { ok: true, code: 'QC_PASSED', task: updated, sot_result: sotResult };
}

async function qcFail({ db, taskId, user, body }) {
  if (!canQc(user)) return { ok: false, code: 'QC_ADMIN_ONLY' };
  const v = validateQcFailBody(body);
  if (!v.ok) return v;
  const { data: task, error: e1 } = await db.from('team_tasks').select('*').eq('id', taskId).maybeSingle();
  if (e1) throw new Error(`task load: ${e1.message}`);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  if (task.status !== 'qc_pending') return { ok: false, code: 'MUST_BE_QC_PENDING', current: task.status };
  const now = new Date().toISOString();
  //   Owner spec §12: QC FAIL 이후 → in_progress (직원에게 돌아감) · qc_status=fail 유지
  const patch = {
    status: 'in_progress',
    qc_status: 'fail',
    qc_fail_reason: v.value.reason,
    qc_at: now,
    qc_user_id: user.id,
    qc_resubmit_count: (Number(task.qc_resubmit_count) || 0),   //   증가는 다음 resubmit 시
    memo: v.value.memo ? (task.memo ? `${task.memo}\n[QC FAIL] ${v.value.memo}` : `[QC FAIL] ${v.value.memo}`) : task.memo,
    updated_at: now,
  };
  const { data: updated, error: e2 } = await db.from('team_tasks').update(patch).eq('id', taskId).select('*').maybeSingle();
  if (e2) return { ok: false, code: 'UPDATE_FAILED', message: e2.message };
  events.log('QC_FAILED', { task_id: taskId, sku_master_id: task.related_sku_id, channel: task.channel, reason: v.value.reason, by_user: user?.username });
  return { ok: true, code: 'QC_FAILED', task: updated };
}

//   ── Resubmit · 직원이 QC_FAIL 된 task 를 수정 후 다시 SUBMIT ───
//   기존 submitTask 를 호출하면 status=in_progress → qc_pending 정상 · qc_status=pending 재설정
//   여기서는 qc_resubmit_count 만 증가시키는 helper wrapper.
async function resubmitTask({ db, taskId, user, body }) {
  const { data: task, error } = await db.from('team_tasks').select('qc_resubmit_count').eq('id', taskId).maybeSingle();
  if (error) throw new Error(`task pre-load: ${error.message}`);
  const cur = Number(task?.qc_resubmit_count) || 0;
  //   먼저 count 증가 · 실패시 submit 도 skip
  const { error: uErr } = await db.from('team_tasks').update({ qc_resubmit_count: cur + 1 }).eq('id', taskId);
  if (uErr) return { ok: false, code: 'UPDATE_FAILED', message: uErr.message };
  const r = await submitTask({ db, taskId, user, body });
  if (r.ok) events.log('QC_RESUBMITTED', { task_id: taskId, count: cur + 1, by_user: user?.username });
  return r;
}

module.exports = {
  BLOCKED_REASONS: Array.from(BLOCKED_REASONS),
  QC_FAIL_REASONS: Array.from(QC_FAIL_REASONS),
  validateSubmitBody,
  validateBlockedBody,
  validateQcFailBody,
  canUserActOnTask,
  canQc,
  startTask,
  submitTask,
  blockTask,
  qcPass,
  qcFail,
  resubmitTask,
};
