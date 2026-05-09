/**
 * src/web/routes/mockOrderImport.js — mock order import (Phase 2 PR 2 + Phase 3 PR S audit)
 *
 * 라우트:
 *   POST /api/orders/mock-import
 *
 * 권한: 로그인한 모든 사용자 (admin / staff). admin 전용 아님.
 *   - 권한 차단보다 실행자 기록을 우선한다 — wms_orders.imported_by = req.user.id 로 저장.
 *   - Phase 3 PR S — 추가로 automation_runs 에 audit row 기록 (executed_by_user_id, action_name,
 *     before/after snapshot, status, rollback metadata). 실패 케이스 (validation/duplicate/unknown)
 *     도 audit 에 남아 향후 '📜 실행 로그' 에서 분석 가능.
 *
 * 동작:
 *   - 로그인 인증 (requireAuth)
 *   - safetyExec.runAction(status='pending') 으로 pre-audit row 생성 (strict — 실패 시 500)
 *   - orderImporter.importMockOrder 호출 (req.user.id 를 createdBy 로)
 *   - 결과별 status mapping:
 *       201 → succeeded   + targetId + afterSnapshot
 *       400 (ValidationError)    → failed    + errorCode='validation'
 *       409 (DuplicateOrderError) → cancelled + errorCode='duplicate' (failed 아님 — 부수효과 없음)
 *       500 (unknown)              → failed    + errorCode='unknown'
 *   - secret/stack 미노출
 *
 * 로그 룰 (PR S):
 *   - audit 실패 시 actionName / executedBy / error.message 만 console 출력.
 *   - payload, raw_payload, snapshot 내용, token, secret 류 절대 console 출력 금지.
 *
 * 기존 public.orders 와 무관. 모든 저장은 wms_orders / wms_order_lines.
 * 응답 JSON shape 은 Phase 2 와 100% 동일 — UI / 검증 가이드 영향 0.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const orderImporter = require('../../services/orderImporter');
const wmsRepo = require('../../db/wmsOrderRepository');
const safetyExec = require('../../services/safetyExec');

const ROLLBACK_HINT_SQL =
  'DELETE FROM wms_order_lines WHERE order_id = <target_id>; ' +
  'DELETE FROM wms_orders WHERE id = <target_id>; ' +
  '-- 부수효과로 생성된 SKU_MATCH_FAILED auto cards 도 함께 close 검토.';

const router = express.Router();

router.use(requireAuth);

// POST /api/orders/mock-import
router.post('/', async (req, res) => {
  const createdBy = req.user?.id;
  if (!Number.isFinite(createdBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  // ── pre-action audit (strict — 실패 시 500) ──
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'mock_order_import',
      executedBy:       createdBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'wms_orders',
      targetId:         null,           // post 에 채움
      beforeSnapshot:   null,           // CREATE — before 없음
      rollbackMethod:   'manual',
      rollbackHint:     ROLLBACK_HINT_SQL,
      status:           'pending',
    });
  } catch (auditErr) {
    // 로그 룰: actionName / executedBy / error.message 만. payload / req.body / secret 금지.
    console.error('[mockOrderImport] safetyExec.runAction failed:', {
      actionName: 'mock_order_import',
      executedBy: createdBy,
      message:    auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  // ── 실 작업 ──
  try {
    const result = await orderImporter.importMockOrder(req.body || {}, { createdBy });

    // post-action audit (best-effort — fire-and-forget)
    safetyExec.updateRun(run.id, {
      status:    'succeeded',
      targetId:  result.order.id,
      afterSnapshot: {
        id:                result.order.id,
        marketplace:       result.order.marketplace,
        external_order_id: result.order.external_order_id,
        line_count:        result.totals?.line_count,
        matched_count:     result.totals?.matched_count,
        failed_count:      result.totals?.failed_count,
        cards_created:     result.totals?.cards_created,
        capped_line_count: result.totals?.capped_line_count,
      },
    });

    return res.status(201).json({
      success: true,
      order_id: result.order.id,
      marketplace: result.order.marketplace,
      external_order_id: result.order.external_order_id,
      totals: result.totals,
      // line 상세 — UI 디버깅 + 자동 카드 링크 표시용
      lines: result.lines.map((l) => ({
        id:               l.id,
        external_line_id: l.external_line_id,
        match_status:     l.match_status,
        match_confidence: l.match_confidence,
        match_reason:     l.match_reason,
        matched_sku_id:   l.matched_sku_id,
      })),
    });
  } catch (e) {
    if (e instanceof orderImporter.ValidationError) {
      safetyExec.updateRun(run.id, {
        status: 'failed', errorCode: 'validation', errorMessage: e.message,
      });
      return res.status(400).json({ error: e.message });
    }
    if (e instanceof wmsRepo.DuplicateOrderError) {
      // 중복 = 부수효과 없는 거부 → 'cancelled' (failed 아님)
      safetyExec.updateRun(run.id, {
        status: 'cancelled',
        errorCode: 'duplicate',
        errorMessage: e.message,
        targetId: e.existing?.id ?? null,
      });
      return res.status(409).json({
        error: e.message,
        code: 'DUPLICATE_ORDER',
        existing_order_id: e.existing?.id ?? null,
      });
    }
    // unknown — 메시지만 노출, secret/stack 미노출
    safetyExec.updateRun(run.id, {
      status: 'failed', errorCode: 'unknown', errorMessage: e.message,
    });
    console.error('[mockOrderImport] unexpected error:', {
      actionName: 'mock_order_import',
      executedBy: createdBy,
      message:    e.message,
    });
    return res.status(500).json({ error: 'mock import 처리 중 오류' });
  }
});

module.exports = router;
