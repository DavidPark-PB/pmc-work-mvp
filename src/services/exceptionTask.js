/**
 * src/services/exceptionTask.js — WMS 자동 예외 카드 생성 helper (Phase 1)
 *
 * 호출 주체:
 *   - Phase 2~3 의 worker (SKU 매칭 실패, 라벨 실패, 마진 위험 등)
 *   - Phase 1 mock trigger
 *
 * 동작 (createExceptionTask):
 *   1) context 를 src/lib/redact.js 로 마스킹.
 *   2) dedupe_key 로 활성 카드 조회. 있으면 context.last_seen_at 갱신만 하고 기존 카드 반환.
 *   3) 정적 라우팅 표 (DEFAULT_ROUTING) 로 assignee_scope 결정. 기본 'operators'.
 *   4) team_tasks 에 auto_generated=true 로 INSERT. teamTaskRepository.createTask 가
 *      assignee_scope 별로 recipient 자동 생성 ('operators' → 활성 admin 전원).
 *   5) DB notify + SSE 발송. 일반 직원은 recipient 가 아니므로 자연 차단.
 *   6) UNIQUE(dedupe_key WHERE active) 위반 (race) 시 기존 카드 다시 조회해서 반환.
 *
 * 정책:
 *   - LLM 추천이나 자동 실행 분기는 본 모듈에서 다루지 않는다.
 *   - 외부 API 호출 / 가격 변경 / 라벨 발급 모두 금지.
 *   - 본 모듈은 카드 생성과 알림 발송만 담당.
 */
'use strict';

const repo = require('../db/teamTaskRepository');
const { notify } = require('./notificationService');
const sseHub = require('./sseHub');
const { redact } = require('../lib/redact');

// 정적 라우팅 표 — Phase 1 기본값. Phase 2 이후 DB 룰 테이블로 이전 검토.
const DEFAULT_ROUTING = {
  SKU_MATCH_FAILED:           { scope: 'operators' },
  AUTOMATION_FAILED:          { scope: 'operators' },
  ADDRESS_INVALID:            { scope: 'operators' },
  MARGIN_RISK:                { scope: 'operators' },
  SUPPLIER_OUT_OF_STOCK:      { scope: 'operators' },
  PRICE_CHANGE_APPROVAL_REQUIRED: { scope: 'operators' },
  LABEL_FAILED:               { scope: 'operators' },
};

const DEFAULT_TITLE_BY_TYPE = {
  SKU_MATCH_FAILED:               '[자동] SKU 매칭 실패',
  AUTOMATION_FAILED:              '[자동] 자동화 실패',
  ADDRESS_INVALID:                '[자동] 배송지 오류',
  MARGIN_RISK:                    '[자동] 마진 위험',
  SUPPLIER_OUT_OF_STOCK:          '[자동] 도매처 품절',
  PRICE_CHANGE_APPROVAL_REQUIRED: '[자동] 가격변경 승인 필요',
  LABEL_FAILED:                   '[자동] 라벨 발급 실패',
};

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_SCOPES = new Set(['operators', 'specific', 'all']);

/**
 * 자동 예외 카드 생성.
 *
 * @param {Object} opts
 * @param {string} opts.exceptionType    필수. 예외 종류 enum (DEFAULT_ROUTING 키 권장).
 * @param {string} [opts.severity='medium']
 * @param {Object} [opts.context={}]     자동화 payload. redact() 로 마스킹 후 저장.
 * @param {string} [opts.dedupeKey]      중복 차단 키. 동일 key 활성 카드가 있으면 신규 생성 안 함.
 * @param {string} [opts.title]          미지정 시 DEFAULT_TITLE_BY_TYPE 사용.
 * @param {string} [opts.memo=null]      카드 본문 보조 텍스트.
 * @param {string} [opts.priority='normal']  'normal' | 'urgent'
 * @param {number} [opts.relatedSkuId=null]
 * @param {number} [opts.relatedOrderId=null]
 * @param {string} [opts.scope]          override. 미지정 시 DEFAULT_ROUTING 또는 'operators'.
 * @param {number} [opts.assigneeId]     scope='specific' 일 때 직접 배정.
 *
 * @returns {Promise<{task: Object, deduped: boolean, recipientCount: number}>}
 */
async function createExceptionTask(opts) {
  if (!opts || !opts.exceptionType) {
    throw new Error('exceptionType is required');
  }

  const exceptionType = String(opts.exceptionType);
  const severity = VALID_SEVERITIES.has(opts.severity) ? opts.severity : 'medium';
  const dedupeKey = opts.dedupeKey || null;
  const title = (opts.title && String(opts.title).trim()) || DEFAULT_TITLE_BY_TYPE[exceptionType] || `[자동] ${exceptionType}`;
  const memo = opts.memo ? String(opts.memo).trim() : null;
  const priority = opts.priority === 'urgent' ? 'urgent' : 'normal';
  const relatedSkuId = Number.isFinite(opts.relatedSkuId) ? opts.relatedSkuId : null;
  const relatedOrderId = Number.isFinite(opts.relatedOrderId) ? opts.relatedOrderId : null;

  // 1) dedupe 조회
  if (dedupeKey) {
    const existing = await repo.findActiveByDedupeKey(dedupeKey);
    if (existing) {
      const prevContext = existing.context || {};
      const newContext = { ...prevContext, last_seen_at: new Date().toISOString() };
      try {
        await repo.updateTaskMeta(existing.id, { context: newContext });
      } catch (_) { /* meta 갱신 실패는 무해 — 카드 자체는 살아있음 */ }
      return { task: existing, deduped: true, recipientCount: 0 };
    }
  }

  // 2) routing
  const routedScope = (opts.scope && VALID_SCOPES.has(opts.scope))
    ? opts.scope
    : (DEFAULT_ROUTING[exceptionType]?.scope || 'operators');
  const assigneeId = routedScope === 'specific'
    ? (Number.isFinite(opts.assigneeId) ? opts.assigneeId : null)
    : null;

  // 3) context redact (secret/PII 마스킹)
  const safeContext = redact(opts.context || {});

  // 4) team_tasks insert + recipient 자동 생성
  const taskValues = {
    title,
    assignee_id: assigneeId,
    assignee_scope: routedScope,
    priority,
    memo,
    auto_generated: true,
    exception_type: exceptionType,
    context: safeContext,
    dedupe_key: dedupeKey,
    severity,
    related_sku_id: relatedSkuId,
    related_order_id: relatedOrderId,
    created_by: null,  // system-generated
  };

  let task;
  let recipientCount;
  try {
    const result = await repo.createTask(taskValues);
    task = result.task;
    recipientCount = result.recipientCount;
  } catch (err) {
    // race: 다른 워커가 동일 dedupe_key 로 먼저 insert 했음 (partial unique 위반 23505)
    if (dedupeKey && (err.code === '23505' || /duplicate key|unique/i.test(err.message || ''))) {
      const existing = await repo.findActiveByDedupeKey(dedupeKey);
      if (existing) return { task: existing, deduped: true, recipientCount: 0 };
    }
    throw err;
  }

  // 5) 알림 + SSE — 자동 카드 recipient 만 (operators 면 활성 admin)
  let recipientIds = [];
  if (routedScope === 'operators') {
    recipientIds = await repo.getActiveAdminIds();
  } else if (routedScope === 'all') {
    recipientIds = await repo.getActiveStaffIds();
  } else if (assigneeId) {
    recipientIds = [assigneeId];
  }

  const ssePayload = {
    type: 'exception_created',
    taskId: task.id,
    exceptionType,
    severity,
    title,
    autoGenerated: true,
    linkUrl: '/?page=tasks&autoGenerated=true',
  };

  // 알림 — 동기 처리하되 개별 실패는 swallow (다른 수신자에게 영향 안 가도록)
  for (const uid of recipientIds) {
    try {
      await notify({
        recipientId: uid,
        type: 'exception_created',
        title,
        body: memo || `${exceptionType} · ${severity}`,
        linkUrl: '/?page=tasks&autoGenerated=true',
        relatedType: 'task',
        relatedId: task.id,
      });
    } catch (e) {
      console.warn('[exceptionTask] notify failed for user', uid, '-', e.message);
    }
  }

  try {
    sseHub.sendToMany(recipientIds, ssePayload);
  } catch (e) {
    console.warn('[exceptionTask] SSE broadcast failed:', e.message);
  }

  return { task, deduped: false, recipientCount };
}

module.exports = {
  createExceptionTask,
  DEFAULT_ROUTING,
  DEFAULT_TITLE_BY_TYPE,
};
