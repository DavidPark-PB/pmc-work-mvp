/**
 * src/services/safetyExec.js — Safety Foundation execution helper (Phase 3 PR S)
 *
 * 역할:
 *   automation_runs 테이블을 모든 user-initiated action (mock import, 향후 price_change,
 *   shipping_create, label_create, sku_link_manual 등) + 자동화 worker 의 단일 audit 로
 *   사용하기 위한 helper.
 *
 * 사용 패턴 (라우트 / 서비스 측):
 *   const run = await safetyExec.runAction({ status: 'pending', ... });   // pre  — strict
 *   try {
 *     const r = await actuallyDo();
 *     await safetyExec.updateRun(run.id, { status: 'succeeded', targetId: r.id, afterSnapshot: {...} });
 *   } catch (e) {
 *     await safetyExec.updateRun(run.id, { status: 'failed', errorMessage: e.message });
 *     throw e;
 *   }
 *
 *   // 별 undo 경로:
 *   await actuallyUndo(targetId);
 *   await safetyExec.rollbackAction({ runId: run.id, executedBy, reason: '...' });
 *
 * 핵심 정책 (plan §2):
 *   - helper 는 audit 기록만 — 실 undo SQL 은 호출자 책임 (rollbackAction 이 새 row 를 만들고
 *     원본 row 의 status / rolled_back_* 만 갱신).
 *   - rollback_run_id 는 단방향 포인터: 원본 row → rollback row id, rollback row → NULL.
 *     역방향 추적은 rollback row 의 input_snapshot.original_run_id.
 *   - pre-action (runAction) 은 strict — 실패 시 throw → 라우트가 500.
 *     post-action (updateRun) 은 best-effort — 실패 시 로그만, 절대 응답 가로막지 않음.
 *   - secret/PII 마스킹: input_snapshot / output_snapshot 은 src/lib/redact.js 통과 후 저장.
 *   - 로그 출력 룰 — actionName / executedBy / error.message 만 출력. payload, raw_payload,
 *     snapshot 내용, token, secret 류는 절대 console 출력 금지.
 *   - legacy admin (req.user.isLegacy) 매핑: executed_by_user_id = NULL,
 *     triggered_by = 'legacy_admin'. (실 운영에선 blockLegacyWrites 가 먼저 차단)
 */
'use strict';

const supabaseClient = require('../db/supabaseClient');
const { redact } = require('../lib/redact');

// ──────────────────────────────────────────────────────────────────────────
// 허용 enum 값 (varchar 컬럼이라 DB constraint 강제 X — 코드 가드만)
// ──────────────────────────────────────────────────────────────────────────
const ALLOWED_STATUSES = [
  'pending',           // pre-action insert — strict
  'started',           // (legacy — Phase 1 cron 호환)
  'succeeded',
  'failed',
  'aborted',           // (legacy — Phase 1 cron 호환)
  'cancelled',         // 사용자 취소 또는 무해한 거부 (예: 409 duplicate)
  'rollback_required',
  'rolled_back',
];

const ALLOWED_ROLLBACK_METHODS = ['auto', 'manual', 'irreversible'];

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'aborted', 'cancelled', 'rollback_required', 'rolled_back']);

const TABLE = 'automation_runs';

function assertStatus(s) {
  if (!ALLOWED_STATUSES.includes(s)) {
    const err = new Error(`safetyExec/invalid_status: ${s}`);
    err.code = 'safetyExec/invalid_status';
    throw err;
  }
}

function assertRollbackMethod(m) {
  if (m == null) return;
  if (!ALLOWED_ROLLBACK_METHODS.includes(m)) {
    const err = new Error(`safetyExec/invalid_rollback_method: ${m}`);
    err.code = 'safetyExec/invalid_rollback_method';
    throw err;
  }
}

/**
 * pre-action audit row 생성. 실 작업 전에 호출.
 * 실패 시 throw → 라우트가 500 응답하도록 (strict mode).
 *
 * @param {Object} opts
 * @param {string} opts.actionName        required — 'mock_order_import' 등
 * @param {number} opts.executedBy        required — req.user.id (legacy → null 자동 변환)
 * @param {boolean} [opts.isLegacyExecutor=false]  req.user.isLegacy
 * @param {string} [opts.targetTable]
 * @param {number} [opts.targetId]
 * @param {Object|null} [opts.beforeSnapshot]   redact 통과 후 input_snapshot 에 저장
 * @param {string} [opts.rollbackMethod]        'auto' | 'manual' | 'irreversible' | null
 * @param {string} [opts.rollbackHint]
 * @param {number} [opts.relatedTaskId]         team_tasks(id)
 * @param {number} [opts.relatedSkuId]          sku_master(id)
 * @param {string} [opts.status='pending']
 * @returns {Promise<{id:number, status:string}>}
 */
async function runAction(opts) {
  if (!opts || typeof opts !== 'object') {
    const err = new Error('safetyExec/missing_opts');
    err.code = 'safetyExec/missing_opts';
    throw err;
  }
  const {
    actionName,
    executedBy,
    isLegacyExecutor = false,
    targetTable = null,
    targetId = null,
    beforeSnapshot = null,
    rollbackMethod = null,
    rollbackHint = null,
    relatedTaskId = null,
    relatedSkuId = null,
    status = 'pending',
  } = opts;

  if (!actionName || typeof actionName !== 'string') {
    const err = new Error('safetyExec/missing_action_name');
    err.code = 'safetyExec/missing_action_name';
    throw err;
  }
  if (!Number.isFinite(executedBy)) {
    const err = new Error('safetyExec/missing_executed_by');
    err.code = 'safetyExec/missing_executed_by';
    throw err;
  }
  assertStatus(status);
  assertRollbackMethod(rollbackMethod);

  // legacy admin 매핑
  const executedByUserId = isLegacyExecutor === true ? null : executedBy;
  const triggeredBy = isLegacyExecutor === true ? 'legacy_admin' : `user:${executedBy}`;

  // snapshot 마스킹
  const safeBefore = beforeSnapshot == null ? null : redact(beforeSnapshot);

  const row = {
    automation_type:     actionName,                 // Phase 1 NOT NULL — action_name 과 동일값으로 채움
    triggered_by:        triggeredBy,
    status,
    input_snapshot:      safeBefore,
    started_at:          new Date().toISOString(),
    related_sku_id:      Number.isFinite(relatedSkuId)  ? relatedSkuId  : null,
    related_task_id:     Number.isFinite(relatedTaskId) ? relatedTaskId : null,
    // PR S 신규 컬럼
    executed_by_user_id: executedByUserId,
    action_name:         actionName,
    target_table:        targetTable,
    target_id:           Number.isFinite(targetId) ? targetId : null,
    rollback_method:     rollbackMethod,
    rollback_hint:       rollbackHint,
  };

  const supabase = supabaseClient.getClient();
  const { data, error } = await supabase.from(TABLE).insert(row).select('id, status').single();
  if (error) {
    const err = new Error(`safetyExec/insert_failed: ${error.message}`);
    err.code = 'safetyExec/insert_failed';
    err.cause = error;
    throw err;
  }
  return { id: data.id, status: data.status };
}

/**
 * post-action 갱신. best-effort — 실패 시 로그만 남기고 silent return.
 *
 * @param {number} runId
 * @param {Object} updates
 * @param {string} [updates.status]
 * @param {number} [updates.targetId]
 * @param {string} [updates.targetTable]
 * @param {Object|null} [updates.afterSnapshot]   redact 통과 후 output_snapshot 에 저장
 * @param {string} [updates.errorCode]
 * @param {string} [updates.errorMessage]
 * @returns {Promise<void>}
 */
async function updateRun(runId, updates = {}) {
  if (!Number.isFinite(runId)) {
    // best-effort path — throw 하지 않고 로그만
    console.error('[safetyExec] updateRun: invalid runId', { runId });
    return;
  }

  try {
    const patch = {};

    if (updates.status !== undefined) {
      assertStatus(updates.status);
      patch.status = updates.status;
      if (TERMINAL_STATUSES.has(updates.status)) {
        patch.completed_at = new Date().toISOString();
      }
    }
    if (updates.targetId    !== undefined && Number.isFinite(updates.targetId)) patch.target_id    = updates.targetId;
    if (updates.targetTable !== undefined && updates.targetTable != null)       patch.target_table = String(updates.targetTable);
    if (updates.afterSnapshot !== undefined) {
      patch.output_snapshot = updates.afterSnapshot == null ? null : redact(updates.afterSnapshot);
    }
    if (updates.errorCode    !== undefined) patch.error_code    = updates.errorCode == null ? null : String(updates.errorCode);
    if (updates.errorMessage !== undefined) patch.error_message = updates.errorMessage == null ? null : String(updates.errorMessage);

    if (Object.keys(patch).length === 0) return;

    const supabase = supabaseClient.getClient();
    const { error } = await supabase.from(TABLE).update(patch).eq('id', runId);
    if (error) {
      console.error('[safetyExec] updateRun failed:', { runId, message: error.message });
    }
  } catch (e) {
    console.error('[safetyExec] updateRun threw:', { runId, message: e.message });
  }
}

/**
 * 되돌리기 audit row 생성 + 원본 갱신. 실 undo 동작은 caller 책임.
 *
 * 동작 (plan §2-2 / §5):
 *   1. 원본 run 로드 — 없으면 throw 'safetyExec/run_not_found'.
 *   2. rollback_method='irreversible' 면 throw 'safetyExec/irreversible'.
 *   3. 새 automation_runs row 삽입 (= rollback run):
 *      - action_name      = 'rollback'
 *      - target_table/id  = 원본과 동일
 *      - input_snapshot   = { original_run_id, original_after }
 *      - status           = 'succeeded'
 *      - rollback_run_id  = NULL  (rollback row 자신은 NULL — 단방향 포인터 정책)
 *      - executed_by_user_id = executedBy
 *   4. 원본 run UPDATE:
 *      - status           = 'rolled_back'
 *      - rolled_back_at   = now()
 *      - rolled_back_by   = executedBy
 *      - rollback_run_id  = (방금 만든 rollback row.id)
 *      - rollback_reason  = reason
 *
 * @param {Object} opts
 * @param {number} opts.runId       원본 run id
 * @param {number} opts.executedBy  되돌리기 실행자 user.id
 * @param {string} [opts.reason]
 * @returns {Promise<{rollbackRunId:number}>}
 */
async function rollbackAction({ runId, executedBy, reason = null } = {}) {
  if (!Number.isFinite(runId)) {
    const err = new Error('safetyExec/missing_run_id');
    err.code = 'safetyExec/missing_run_id';
    throw err;
  }
  if (!Number.isFinite(executedBy)) {
    const err = new Error('safetyExec/missing_executed_by');
    err.code = 'safetyExec/missing_executed_by';
    throw err;
  }

  const supabase = supabaseClient.getClient();

  // 1) 원본 로드
  const { data: original, error: loadErr } = await supabase
    .from(TABLE)
    .select('id, action_name, target_table, target_id, output_snapshot, rollback_method, status')
    .eq('id', runId)
    .maybeSingle();
  if (loadErr) {
    const err = new Error(`safetyExec/load_failed: ${loadErr.message}`);
    err.code = 'safetyExec/load_failed';
    err.cause = loadErr;
    throw err;
  }
  if (!original) {
    const err = new Error(`safetyExec/run_not_found: ${runId}`);
    err.code = 'safetyExec/run_not_found';
    throw err;
  }
  if (original.rollback_method === 'irreversible') {
    const err = new Error(`safetyExec/irreversible: run ${runId} cannot be rolled back`);
    err.code = 'safetyExec/irreversible';
    throw err;
  }
  if (original.status === 'rolled_back') {
    const err = new Error(`safetyExec/already_rolled_back: run ${runId}`);
    err.code = 'safetyExec/already_rolled_back';
    throw err;
  }

  // 2) rollback row 삽입
  const rollbackInput = {
    original_run_id: original.id,
    original_after:  original.output_snapshot ?? null,
  };
  const rollbackRow = {
    automation_type:     'rollback',                  // Phase 1 NOT NULL
    triggered_by:        `user:${executedBy}`,
    status:              'succeeded',
    input_snapshot:      redact(rollbackInput),
    started_at:          new Date().toISOString(),
    completed_at:        new Date().toISOString(),
    executed_by_user_id: executedBy,
    action_name:         'rollback',
    target_table:        original.target_table,
    target_id:           original.target_id,
    rollback_method:     null,                        // rollback 자신은 되돌리기 메타 없음
    rollback_hint:       null,
    rollback_run_id:     null,                        // rollback row → NULL (단방향 포인터)
  };
  const { data: inserted, error: insErr } = await supabase
    .from(TABLE).insert(rollbackRow).select('id').single();
  if (insErr) {
    const err = new Error(`safetyExec/rollback_insert_failed: ${insErr.message}`);
    err.code = 'safetyExec/rollback_insert_failed';
    err.cause = insErr;
    throw err;
  }
  const rollbackRunId = inserted.id;

  // 3) 원본 갱신
  const { error: updErr } = await supabase
    .from(TABLE)
    .update({
      status:          'rolled_back',
      rolled_back_at:  new Date().toISOString(),
      rolled_back_by:  executedBy,
      rollback_run_id: rollbackRunId,
      rollback_reason: reason == null ? null : String(reason),
    })
    .eq('id', runId);
  if (updErr) {
    // rollback row 는 이미 들어갔는데 원본 갱신만 실패 — 운영 모순.
    // 로그 + throw 로 raise (caller 가 알아야 함).
    console.error('[safetyExec] rollbackAction: original update failed', {
      runId, rollbackRunId, message: updErr.message,
    });
    const err = new Error(`safetyExec/rollback_update_failed: ${updErr.message}`);
    err.code = 'safetyExec/rollback_update_failed';
    err.cause = updErr;
    throw err;
  }

  return { rollbackRunId };
}

/**
 * audit 조회. PR S 에서는 호출처 없음 — PR M 의 UI 가 사용 예정.
 * 시그니처만 정의 + Supabase SELECT 기본형 구현.
 *
 * @returns {Promise<{data:Array, total:number, limit:number, offset:number}>}
 */
async function listRuns({ executedBy, actionName, status, targetTable, targetId, limit = 100, offset = 0 } = {}) {
  const supabase = supabaseClient.getClient();
  let q = supabase.from(TABLE).select('*', { count: 'exact' });
  if (Number.isFinite(executedBy)) q = q.eq('executed_by_user_id', executedBy);
  if (actionName)                  q = q.eq('action_name', String(actionName));
  if (status)                      q = q.eq('status', String(status));
  if (targetTable)                 q = q.eq('target_table', String(targetTable));
  if (Number.isFinite(targetId))   q = q.eq('target_id', targetId);
  q = q.order('id', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) {
    const err = new Error(`safetyExec/list_failed: ${error.message}`);
    err.code = 'safetyExec/list_failed';
    err.cause = error;
    throw err;
  }
  return { data: data || [], total: count ?? 0, limit, offset };
}

module.exports = {
  ALLOWED_STATUSES,
  ALLOWED_ROLLBACK_METHODS,
  runAction,
  updateRun,
  rollbackAction,
  listRuns,
};
