/**
 * exception_routing — 자동 예외 라우팅 표 + admin mock trigger (Phase 1)
 *
 * 권한: 모두 admin 전용 (requireAdmin).
 *
 * 엔드포인트:
 *   GET  /                exception_type → routing/title 정적 표 노출 (UI 용)
 *   POST /mock            mock 자동 카드 생성 — Week 3 E2E 검증용
 *
 * 정책:
 *   - 본 모듈은 라우팅 룰 결정/실행을 추가하지 않는다.
 *     Phase 1 의 정적 표는 src/services/exceptionTask.js 가 보유.
 *   - mock 엔드포인트는 외부 API 를 절대 호출하지 않는다.
 *     자동 카드 생성 + recipient + DB notify + SSE 만 트리거.
 *   - secret 값을 응답/로그에 인쇄하지 않는다 (redact 는 helper 가 담당).
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const {
  createExceptionTask,
  DEFAULT_ROUTING,
  DEFAULT_TITLE_BY_TYPE,
} = require('../../services/exceptionTask');

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
  try {
    const body = req.body || {};
    if (!body.exceptionType || !String(body.exceptionType).trim()) {
      return res.status(400).json({ error: 'exceptionType 필수' });
    }

    const result = await createExceptionTask({
      exceptionType: String(body.exceptionType).trim(),
      severity: body.severity,
      context: body.context || {},
      dedupeKey: body.dedupeKey || null,
      title: body.title,
      memo: body.memo,
      priority: body.priority,
      relatedSkuId: body.relatedSkuId !== undefined ? Number(body.relatedSkuId) : null,
      relatedOrderId: body.relatedOrderId !== undefined ? Number(body.relatedOrderId) : null,
      scope: body.scope,
      assigneeId: body.assigneeId !== undefined ? Number(body.assigneeId) : null,
    });

    // 응답에는 task row 만 — context 는 이미 redact() 통과했으므로 그대로 반환해도 안전.
    res.status(201).json({
      taskId: result.task.id,
      task: result.task,
      deduped: result.deduped,
      recipientCount: result.recipientCount,
    });
  } catch (e) {
    console.error('[exceptionRouting] mock trigger failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
