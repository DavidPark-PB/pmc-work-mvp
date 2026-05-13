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
 *   - PR U2 1차 = sku_listing_link_create 1개 (단일 row DELETE, FK cascade 없음)
 *   - PR U4 2차 = sku_listing_link_delete 추가 (input_snapshot 기반 단일 row INSERT,
 *                 PK 재사용 X 로 sequence 충돌 회피, UNIQUE 충돌은 명시 에러로 거절)
 *   - PR U5 3차 = sku_master_update 추가 (input_snapshot 의 허용 필드만 patch.
 *                 internal_sku / id / created_by / created_at 등 시스템 필드 보호)
 *   - PR U6 4차 = sku_master_soft_delete 추가 (status flip 만 하는 update 라
 *                 PR U5 의 undoSkuMasterUpdate 핸들러 재사용)
 *   - PR U7 5차 = purchase_request_approve / reject / ordered 3개 동시 추가
 *                 (모두 status / decision / ordered_* 필드만 변경 — 단일 row patch.
 *                  status 변경 알림 (notify/SSE) 은 비가역 — 응답 비고만 표시)
 *   - 다른 action 추가는 PR U8+ 에서 점진 도입
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

// PR U2 1차 (sku_listing_link_create) + PR U4 2차 (sku_listing_link_delete) +
// PR U5 3차 (sku_master_update) + PR U6 4차 (sku_master_soft_delete) +
// PR U7 5차 (purchase_request_approve / reject / ordered).
// 모두 단일 row 만 다루며 FK cascade 없음. 추가 action 은 PR U8+ 검토.
const AUTO_ROLLBACK_ACTIONS = new Set([
  'sku_listing_link_create',
  'sku_listing_link_delete',
  'sku_master_update',
  'sku_master_soft_delete',
  'purchase_request_approve',
  'purchase_request_reject',
  'purchase_request_ordered',
]);

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
  } else if (original.action_name === 'sku_listing_link_delete') {
    undone = await undoSkuListingLinkDelete(original, supabase);
  } else if (original.action_name === 'sku_master_update') {
    undone = await undoSkuMasterUpdate(original, supabase);
  } else if (original.action_name === 'sku_master_soft_delete') {
    undone = await undoSkuMasterSoftDelete(original, supabase);
  } else if (
    original.action_name === 'purchase_request_approve' ||
    original.action_name === 'purchase_request_reject'  ||
    original.action_name === 'purchase_request_ordered'
  ) {
    undone = await undoPurchaseRequestStatusChange(original, supabase);
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

/**
 * sku_listing_link_delete undo = input_snapshot 의 삭제 전 row 로 단일 INSERT.
 *
 * 정책:
 *   - PK (id) 는 재사용 X — 신규 sequence 값 사용 (sequence 충돌 회피).
 *     원본 link 의 id 는 audit row 의 target_id 에 보존돼서 추적 가능.
 *   - input_snapshot 우선 (PR L-1 의 beforeRow 가 들어있음). 없으면 output_snapshot fallback.
 *   - 필수 필드 (sku_id / marketplace / listing_id) 부재 → invalid_snapshot 거절.
 *   - UNIQUE (marketplace, listing_id, option_id) 충돌 → unique_conflict 거절
 *     (그 사이 다른 SKU 가 같은 link 차지한 케이스. 운영자 수동 정리 필요).
 */
async function undoSkuListingLinkDelete(original, supabase) {
  if (original.target_table !== 'sku_listing_link') {
    throw new UndoError('safetyUndo/invalid_target_table', `expected target_table='sku_listing_link', got '${original.target_table}'`);
  }
  if (!Number.isFinite(original.target_id)) {
    throw new UndoError('safetyUndo/invalid_target_id', `target_id is not a finite number`);
  }

  const snap = (original.input_snapshot && typeof original.input_snapshot === 'object')
    ? original.input_snapshot
    : (original.output_snapshot && typeof original.output_snapshot === 'object')
      ? original.output_snapshot
      : null;
  if (!snap) {
    throw new UndoError('safetyUndo/invalid_snapshot', 'input/output snapshot 부재 — 재생성 데이터 없음');
  }

  const sku_id          = Number(snap.sku_id);
  const marketplace     = snap.marketplace;
  const listing_id      = snap.listing_id;
  const option_id       = snap.option_id !== undefined ? snap.option_id : null;
  const marketplace_sku = snap.marketplace_sku !== undefined ? snap.marketplace_sku : null;
  const is_primary      = snap.is_primary === true;

  if (!Number.isFinite(sku_id) || !marketplace || !listing_id) {
    throw new UndoError('safetyUndo/invalid_snapshot',
      'snapshot 필수 필드 부족 — sku_id / marketplace / listing_id 확인 필요');
  }

  // PK 재사용 X — DB sequence 가 새 id 발행
  const insertRow = { sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary };

  const { data, error } = await supabase
    .from('sku_listing_link')
    .insert(insertRow)
    .select('id, sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary')
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new UndoError('safetyUndo/unique_conflict',
        '동일 (marketplace, listing_id, option_id) 가 이미 다른 SKU 에 존재 — 수동 확인 필요');
    }
    throw new UndoError('safetyUndo/insert_failed', error.message);
  }

  return {
    actionName:    original.action_name,
    targetTable:   original.target_table,
    targetId:      original.target_id,
    recreatedLink: data,
  };
}

/**
 * sku_master_update undo = input_snapshot 의 허용 필드만 patch.
 *
 * 정책 (PR U5):
 *   - ALLOWED_FIELDS 외 컬럼은 절대 patch X
 *   - internal_sku 는 patch 금지 (식별자 안정성 — skuMaster route 의 update 정책 정합)
 *   - id / created_by / created_at 등 시스템 필드 보호
 *   - updated_at 만 helper 측에서 갱신 (감사 추적용)
 *   - input_snapshot 부재 또는 허용 필드 0개 → invalid_snapshot 거절
 *   - target_id 가 그 사이 삭제됐으면 target_not_found 거절
 */
async function undoSkuMasterUpdate(original, supabase) {
  if (original.target_table !== 'sku_master') {
    throw new UndoError('safetyUndo/invalid_target_table', `expected target_table='sku_master', got '${original.target_table}'`);
  }
  if (!Number.isFinite(original.target_id)) {
    throw new UndoError('safetyUndo/invalid_target_id', `target_id is not a finite number`);
  }

  const snap = original.input_snapshot;
  if (!snap || typeof snap !== 'object') {
    throw new UndoError('safetyUndo/invalid_snapshot', 'input snapshot 부재 — 복구 데이터 없음');
  }

  // PR U5 spec — 허용 필드. internal_sku / id / created_by / created_at 제외.
  // Phase 1 (2026-05-13) 배송 컬럼 6개 추가.
  const ALLOWED_FIELDS = [
    'title', 'product_type', 'brand', 'category', 'status',
    'automation_enabled', 'cost_krw', 'weight_gram', 'hs_code', 'notes',
    // 배송 컬럼
    'default_packaging_weight_g', 'width_cm', 'height_cm', 'length_cm',
    'shipping_group', 'weight_status',
  ];

  const patch = { updated_at: new Date().toISOString() };
  for (const f of ALLOWED_FIELDS) {
    if (snap[f] !== undefined) patch[f] = snap[f];
  }
  if (Object.keys(patch).length <= 1) {
    // updated_at 만 있고 복구할 허용 필드 0개
    throw new UndoError('safetyUndo/invalid_snapshot', 'snapshot 에 복구 가능한 허용 필드가 없음');
  }

  const { data, error } = await supabase
    .from('sku_master')
    .update(patch)
    .eq('id', original.target_id)
    .select('id, internal_sku, title, status, automation_enabled')
    .maybeSingle();
  if (error) {
    throw new UndoError('safetyUndo/update_failed', error.message);
  }
  if (!data) {
    throw new UndoError('safetyUndo/target_not_found', `sku_master id=${original.target_id} not found`);
  }

  return {
    actionName:  original.action_name,
    targetTable: original.target_table,
    targetId:    original.target_id,
    restoredSku: data,
  };
}

/**
 * sku_master_soft_delete undo = soft delete 직전 snapshot 의 허용 필드로 복구.
 *
 * 정책 (PR U6):
 *   - skuMaster route 의 soft delete 는 status='discontinued' + automation_enabled=false
 *     로 필드 2개만 변경하는 update — 본질이 sku_master_update 와 동일.
 *   - 따라서 PR U5 의 undoSkuMasterUpdate 핸들러 그대로 재사용 (코드 중복 회피).
 *   - ALLOWED_FIELDS / internal_sku 보호 / system 필드 보호 / target_not_found 처리
 *     모두 PR U5 와 동일.
 *   - 별도 deleted_at 컬럼 미존재 (status 만 'discontinued' 로 flip 하는 방식).
 */
async function undoSkuMasterSoftDelete(original, supabase) {
  return undoSkuMasterUpdate(original, supabase);
}

/**
 * purchase_request_approve / reject / ordered undo = 상태 변경 전 snapshot 의
 * 허용 필드만 patch. 3 액션 모두 동일 패턴 (status / decision_* / ordered_* flip)
 * 이라 단일 handler 로 통합.
 *
 * 정책 (PR U7):
 *   - purchase_requests 의 실 컬럼 기준 ALLOWED_FIELDS 만 patch.
 *     (실제 컬럼: status / decision_by / decision_at / rejection_reason /
 *      rejection_note / ordered_by / ordered_at)
 *   - id / requested_by / product_name / quantity / estimated_price 등
 *     요청 본문 / 식별자 / 외부 영향 컬럼 절대 patch X.
 *   - 알림 (notify) / SSE broadcast 는 비가역 — undo 후에도 사용자에게 도착한 알림은
 *     되돌릴 수 없음. 응답의 restoredPurchaseRequest 로 운영자 확인.
 *   - 외부 주문/결제/재고 연동은 본 handler 가 건드리지 않음.
 *
 * 반환의 approved_x / rejected_x 는 spec 추상화 — 실 컬럼 decision_by / decision_at 을
 * 복구 후 status 에 따라 mapping (status='approved' → approved_x, 그 외 null).
 */
async function undoPurchaseRequestStatusChange(original, supabase) {
  if (original.target_table !== 'purchase_requests') {
    throw new UndoError('safetyUndo/invalid_target_table', `expected target_table='purchase_requests', got '${original.target_table}'`);
  }
  if (!Number.isFinite(original.target_id)) {
    throw new UndoError('safetyUndo/invalid_target_id', `target_id is not a finite number`);
  }

  const snap = original.input_snapshot;
  if (!snap || typeof snap !== 'object') {
    throw new UndoError('safetyUndo/invalid_snapshot', 'input snapshot 부재 — 복구 데이터 없음');
  }

  // 실 컬럼 기준 ALLOWED_FIELDS — id / requested_by / product_name / quantity /
  // estimated_price 등 요청 본문 필드는 절대 X
  const ALLOWED_FIELDS = [
    'status',
    'decision_by',
    'decision_at',
    'rejection_reason',
    'rejection_note',
    'ordered_by',
    'ordered_at',
  ];

  const patch = { updated_at: new Date().toISOString() };
  for (const f of ALLOWED_FIELDS) {
    if (snap[f] !== undefined) patch[f] = snap[f];
  }
  if (Object.keys(patch).length <= 1) {
    throw new UndoError('safetyUndo/invalid_snapshot', 'snapshot 에 복구 가능한 허용 필드가 없음');
  }

  const { data, error } = await supabase
    .from('purchase_requests')
    .update(patch)
    .eq('id', original.target_id)
    .select('id, status, decision_by, decision_at, ordered_by, ordered_at')
    .maybeSingle();
  if (error) {
    throw new UndoError('safetyUndo/update_failed', error.message);
  }
  if (!data) {
    throw new UndoError('safetyUndo/target_not_found', `purchase_requests id=${original.target_id} not found`);
  }

  // spec 의 approved_x / rejected_x 추상화 — 실 컬럼 decision_x 을 status 기반 mapping
  const isApproved = data.status === 'approved';
  const isRejected = data.status === 'rejected';

  return {
    actionName:  original.action_name,
    targetTable: original.target_table,
    targetId:    original.target_id,
    restoredPurchaseRequest: {
      id:          data.id,
      status:      data.status,
      approved_by: isApproved ? data.decision_by : null,
      approved_at: isApproved ? data.decision_at : null,
      rejected_by: isRejected ? data.decision_by : null,
      rejected_at: isRejected ? data.decision_at : null,
      ordered_by:  data.ordered_by,
      ordered_at:  data.ordered_at,
    },
  };
}

module.exports = {
  AUTO_ROLLBACK_ACTIONS,
  UndoError,
  rollbackRun,
};
