/**
 * exception_routing — 자동 예외 라우팅 표 + admin mock trigger (Phase 1 + Phase 3 PR L audit)
 *
 * 권한: 모두 admin 전용 (requireAdmin).
 *
 * 엔드포인트:
 *   GET  /                exception_type → routing/title 정적 표 노출 (UI 용)
 *   POST /mock            mock 자동 카드 생성 — Week 3 E2E 검증용   [audit: exception_task_mock_create]
 *
 * 정책:
 *   - 본 모듈은 라우팅 룰 결정/실행을 추가하지 않는다.
 *     Phase 1 의 정적 표는 src/services/exceptionTask.js 가 보유.
 *   - mock 엔드포인트는 외부 API 를 절대 호출하지 않는다.
 *     자동 카드 생성 + recipient + DB notify + SSE 만 트리거.
 *   - secret 값을 응답/로그에 인쇄하지 않는다 (redact 는 helper 가 담당).
 *
 * PR L audit 정책:
 *   - pre-action audit (runAction) strict — 실패 시 실 작업 안 하고 500.
 *   - post-action updateRun best-effort.
 *   - dedupe 는 정상 응답 — succeeded + afterSnapshot.deduped=true.
 *   - 기타 실패 = status='failed'.
 *   - body 의 context 등 raw payload 를 snapshot 에 그대로 저장 X — 명시 컬럼만.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const {
  createExceptionTask,
  DEFAULT_ROUTING,
  DEFAULT_TITLE_BY_TYPE,
} = require('../../services/exceptionTask');
const safetyExec = require('../../services/safetyExec');

const router = express.Router();
router.use(requireAdmin);

// ── routing 표 조회 ─────────────────────────────────────
// GET /api/exception-routing
router.get('/', (req, res) => {
  const exceptionTypes = Array.from(new Set([
    ...Object.keys(DEFAULT_ROUTING),
    ...Object.keys(DEFAULT_TITLE_BY_TYPE),
  ]));
  const items = exceptionTypes.map((t) => ({
    exception_type: t,
    scope: DEFAULT_ROUTING[t]?.scope || 'operators',
    title: DEFAULT_TITLE_BY_TYPE[t] || `[자동] ${t}`,
  }));
  res.json({ data: items });
});

// ── mock trigger (admin only) ───────────────────────────
// POST /api/exception-routing/mock
//   body 예: {
//     exceptionType: 'SKU_MATCH_FAILED',
//     severity: 'high',
//     dedupeKey: 'sku_match_failed:ebay:ORD-001:line1',
//     context: { marketplace: 'ebay', external_order_id: 'ORD-001', ... },
//     title?: '...', memo?: '...', priority?: 'urgent',
//     relatedSkuId?: 42, relatedOrderId?: null,
//     scope?: 'operators'|'specific'|'all', assigneeId?: 7
//   }
router.post('/mock', async (req, res) => {
  // pre-validation (audit row 생성 전 — 실패 시 audit 기록 X)
  const body = req.body || {};
  if (!body.exceptionType || !String(body.exceptionType).trim()) {
    return res.status(400).json({ error: 'exceptionType 필수' });
  }

  // created_by — mock trigger 는 admin 본인이 호출하므로 req.user.id 사용.
  // team_tasks.created_by 가 NOT NULL 이라 null 전달 금지 (운영 admin 1명 이상 보장됨).
  const createdBy = req.user?.id;
  // 진단 로그 — user id 존재 여부만 (secret/token/key 등 민감값은 절대 출력 안 함).
  console.log('[exceptionRouting] mock trigger — createdBy resolved:',
    Number.isFinite(createdBy) ? `id=${createdBy} (admin)` : `MISSING (typeof=${typeof createdBy})`);
  if (!Number.isFinite(createdBy)) {
    return res.status(401).json({ error: '인증된 admin 사용자가 아닙니다 (req.user.id 부재)' });
  }

  // 명시 인자 추출 (snapshot 에 raw body / context 일체 미포함)
  const exceptionType  = String(body.exceptionType).trim();
  const severity       = body.severity;
  const dedupeKey      = body.dedupeKey || null;
  const scope          = body.scope;
  const assigneeId     = body.assigneeId   !== undefined ? Number(body.assigneeId)   : null;
  const relatedSkuId   = body.relatedSkuId   !== undefined ? Number(body.relatedSkuId)   : null;
  const relatedOrderId = body.relatedOrderId !== undefined ? Number(body.relatedOrderId) : null;

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'exception_task_mock_create',
      executedBy:       createdBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'team_tasks',
      targetId:         null,                                       // post 에 채움
      beforeSnapshot: {
        exception_type:   exceptionType,
        severity:         severity,
        dedupe_key:       dedupeKey,
        related_sku_id:   Number.isFinite(relatedSkuId)   ? relatedSkuId   : null,
        related_order_id: Number.isFinite(relatedOrderId) ? relatedOrderId : null,
        scope:            scope,
        assignee_id:      Number.isFinite(assigneeId) ? assigneeId : null,
      },
      relatedSkuId: Number.isFinite(relatedSkuId) ? relatedSkuId : null,
      rollbackMethod: 'manual',
      rollbackHint:
        "UPDATE team_tasks SET status='done', resolved_at=now() WHERE id=<target_id>; -- auto card close.",
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[exceptionRouting] runAction failed (exception_task_mock_create):', {
      actionName: 'exception_task_mock_create', executedBy: createdBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const result = await createExceptionTask({
      exceptionType,
      severity,
      context: body.context || {},
      dedupeKey,
      title: body.title,
      memo: body.memo,
      priority: body.priority,
      relatedSkuId,
      relatedOrderId,
      scope,
      assigneeId,
      createdBy,
    });

    // post-action audit (best-effort) — 명시 필드만, context/secret 미포함
    safetyExec.updateRun(run.id, {
      status:   'succeeded',
      targetId: result.task.id,
      afterSnapshot: {
        task_id:         result.task.id,
        deduped:         result.deduped,
        recipient_count: result.recipientCount,
        task_status:     result.task.status,
        task_title:      result.task.title,
      },
    });

    // 응답에는 task row 만 — context 는 이미 redact() 통과했으므로 그대로 반환해도 안전.
    res.status(201).json({
      taskId: result.task.id,
      task: result.task,
      deduped: result.deduped,
      recipientCount: result.recipientCount,
    });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    console.error('[exceptionRouting] mock trigger failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
