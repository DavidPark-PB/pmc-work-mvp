/**
 * src/services/safetyUndo.js — Safety Foundation auto-undo helper (Phase 3 PR U2)
 *
 * 역할:
 *   - rollback 대상 run 로드 (automation_runs)
 *   - allowlist (AUTO_ROLLBACK_ACTIONS) 검증 + rollback_method='auto' 검증
 *   - action 별 실 DB undo 실행
 *   - 성공 후 safetyExec.rollbackAction 호출 (audit chain 기록)
 *   - 실패 시 caller 에 throw — 원본 row 무변경 (idempotency 정책)
 *
 * 정책 (PR U1 plan §2):
 *   - 기본값 manual-only — 본 service 는 allowlist 등록 action 만 처리
 *   - rollbackAction 책임 분리 — DB undo 가 먼저, audit row 는 그 후
 *   - PR U2 1차 = sku_listing_link_create 1개만 (단일 row DELETE, FK cascade 없음)
 *   - 다른 action 추가는 PR U4+ 에서 점진 도입
 *   - 로그 룰: actionName / runId / executedBy / message 만. snapshot/payload/secret 출력 금지
 *
 * 무수정 약속:
 *   - safetyExec.js 무수정 — 본 service 가 rollbackAction 호출하는 유일한 신규 caller
 *   - migration 0 — 단일 row DELETE 만 (Supabase JS row-level atomic 보장)
 *
 * 후속 RPC 검토 (PR U-RPC):
 *   - 복수 row atomic 이 필요한 액션 (mock_order_import 등) 은 PostgreSQL function +
 *     supabase.rpc() 로 도입. 1차 PR U2 범위 외 — handler 추가 시 transaction 한계
 *     검토 후 RPC 또는 manual 유지 결정.
 */
'use strict';

const supabaseClient = require('../db/supabaseClient');
const safetyExec = require('./safetyExec');

// PR U2 1차 — 가장 안전한 단일 row DELETE 1개만
const AUTO_ROLLBACK_ACTIONS = new Set(['sku_listing_link_create']);

const TABLE = 'automation_runs';

class UndoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * rollback 진입점.
 * 1) load original run, 2) validate, 3) action 별 handler 실행, 4) rollbackAction.
 *
 * @param {Object} opts
 * @param {number} opts.runId
 * @param {number} opts.executedBy
 * @param {string|null} [opts.reason=null]
 * @returns {Promise<{rollbackRunId:number, undone:object}>}
 */
async function rollbackRun({ runId, executedBy, reason = null } = {}) {
  if (!Number.isFinite(runId)) {
    throw new UndoError('safetyUndo/invalid_run_id', `invalid runId: ${runId}`);
  }
  if (!Number.isFinite(executedBy)) {
    throw new UndoError('safetyUndo/invalid_executed_by', `invalid executedBy: ${executedBy}`);
  }

  const supabase = supabaseClient.getClient();

  // 1) 원본 run 로드 — 필요 컬럼만
  const { data: original, error: loadErr } = await supabase
    .from(TABLE)
    .select('id, action_name, status, target_table, target_id, rollback_method, rollback_run_id, input_snapshot, output_snapshot')
    .eq('id', runId)
    .maybeSingle();
  if (loadErr) {
    throw new UndoError('safetyUndo/load_failed', loadErr.message);
  }
  if (!original) {
    throw new UndoError('safetyUndo/run_not_found', `run ${runId} not found`);
  }

  // 2) idempotency / 정책 검증
  if (original.status === 'rolled_back' || original.rollback_run_id != null) {
    throw new UndoError('safetyUndo/already_rolled_back', `run ${runId} 은 이미 되돌려졌습니다`);
  }
  if (original.rollback_method !== 'auto') {
    throw new UndoError('safetyUndo/not_auto', `rollback_method='${original.rollback_method || 'null'}' — auto 가 아니므로 자동 되돌리기 불가`);
  }
  if (!AUTO_ROLLBACK_ACTIONS.has(original.action_name)) {
    throw new UndoError('safetyUndo/not_allowed', `action '${original.action_name}' 은 자동 되돌리기 미지원 (allowlist 외)`);
  }

  // 3) action 별 실 DB undo
  let undone;
  if (original.action_name === 'sku_listing_link_create') {
    undone = await undoSkuListingLinkCreate(original, supabase);
  } else {
    // 위 allowlist 체크에서 걸리므로 도달 불가지만 방어
    throw new UndoError('safetyUndo/handler_missing', `no handler for action '${original.action_name}'`);
  }

  // 4) audit chain 기록 — DB undo 성공 후에만
  let rollbackRunId;
  try {
    const r = await safetyExec.rollbackAction({ runId, executedBy, reason });
    rollbackRunId = r.rollbackRunId;
  } catch (auditErr) {
    // 운영 모순: 실 데이터는 이미 undo 됐는데 audit chain 만 실패.
    // 보상 insert 는 본 PR 범위 외 (RPC 도입 후 검토). 로그 + throw.
    // 로그 룰: snapshot/payload 출력 금지, runId / target / message 만.
    console.error('[safetyUndo] rollbackAction failed AFTER db undo (operational drift):', {
      runId,
      target_table: original.target_table,
      target_id:    original.target_id,
      message:      auditErr.message,
    });
    throw new UndoError('safetyUndo/audit_rollback_failed', auditErr.message);
  }

  return { rollbackRunId, undone };
}

// ──────────────────────────────────────────────────────────────────────────
// action 별 handler
// ──────────────────────────────────────────────────────────────────────────

/**
 * sku_listing_link_create undo = sku_listing_link 단일 row DELETE.
 * 단일 row 라 row-level atomic. FK cascade 없음. 가장 안전한 1차 후보.
 */
async function undoSkuListingLinkCreate(original, supabase) {
  if (original.target_table !== 'sku_listing_link') {
    throw new UndoError('safetyUndo/invalid_target_table', `expected target_table='sku_listing_link', got '${original.target_table}'`);
  }
  if (!Number.isFinite(original.target_id)) {
    throw new UndoError('safetyUndo/invalid_target_id', `target_id is not a finite number`);
  }

  const { data, error } = await supabase
    .from('sku_listing_link')
    .delete()
    .eq('id', original.target_id)
    .select('id, sku_id, marketplace, listing_id, option_id')
    .maybeSingle();
  if (error) {
    throw new UndoError('safetyUndo/delete_failed', error.message);
  }
  if (!data) {
    // 누군가 이미 삭제했거나 row 가 사라짐. 본 PR 은 재발견 시도 안 함 — 명확히 실패 처리.
    throw new UndoError('safetyUndo/target_not_found', `sku_listing_link id=${original.target_id} not found (이미 삭제됐을 수 있음)`);
  }

  return {
    actionName:  original.action_name,
    targetTable: original.target_table,
    targetId:    original.target_id,
    deletedLink: data,
  };
}

module.exports = {
  AUTO_ROLLBACK_ACTIONS,
  UndoError,
  rollbackRun,
};
