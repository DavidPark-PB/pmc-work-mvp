/**
 * src/web/routes/mockOrderImport.js — admin only mock order import (Phase 2 PR 2)
 *
 * 라우트:
 *   POST /api/orders/mock-import
 *
 * 동작:
 *   - admin 인증 (requireAdmin)
 *   - req.user.id 를 createdBy 로 orderImporter.importMockOrder 호출
 *   - validation error → 400
 *   - duplicate order → 409
 *   - 기타 → 500 (secret 출력 금지)
 *
 * 기존 public.orders 와 무관. 모든 저장은 wms_orders / wms_order_lines.
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const orderImporter = require('../../services/orderImporter');
const wmsRepo = require('../../db/wmsOrderRepository');

const router = express.Router();

router.use(requireAdmin);

// POST /api/orders/mock-import
router.post('/', async (req, res) => {
  try {
    const createdBy = req.user?.id;
    if (!Number.isFinite(createdBy)) {
      return res.status(401).json({ error: '인증된 admin 사용자가 아닙니다 (req.user.id 부재)' });
    }

    const result = await orderImporter.importMockOrder(req.body || {}, { createdBy });

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
      return res.status(400).json({ error: e.message });
    }
    if (e instanceof wmsRepo.DuplicateOrderError) {
      return res.status(409).json({
        error: e.message,
        code: 'DUPLICATE_ORDER',
        existing_order_id: e.existing?.id ?? null,
      });
    }
    // unknown — 메시지만 노출, secret/stack 미노출
    console.error('[mockOrderImport] unexpected error:', e.message);
    return res.status(500).json({ error: 'mock import 처리 중 오류' });
  }
});

module.exports = router;
