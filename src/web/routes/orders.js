/**
 * src/web/routes/orders.js — admin only WMS 주문 조회 (Phase 2 PR 2)
 *
 * 라우트:
 *   GET /api/orders            wms_orders 목록 (filter + pagination)
 *   GET /api/orders/:id        wms_orders 단건 + lines 포함
 *
 * 중요:
 *   - 모든 from() 인자는 wms_orders / wms_order_lines 만.
 *   - 기존 public.orders (eBay 주문 sync 용) 는 일체 참조하지 않는다 — 별 라우트 / 별 흐름.
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const wmsRepo = require('../../db/wmsOrderRepository');

const router = express.Router();

router.use(requireAdmin);

// GET /api/orders?marketplace=ebay&status=paid&limit=100&offset=0
router.get('/', async (req, res) => {
  try {
    const marketplace = req.query.marketplace || undefined;
    const status      = req.query.status      || undefined;
    const limit       = Number(req.query.limit)  || 100;
    const offset      = Number(req.query.offset) || 0;

    const { data, total } = await wmsRepo.listWmsOrders({ marketplace, status, limit, offset });

    // 매칭 통계는 GET / 에서는 생략 (목록 가벼움 우선). 상세는 GET /:id 에서.
    res.json({
      data,
      total,
      limit,
      offset,
    });
  } catch (e) {
    console.error('[orders] list error:', e.message);
    res.status(500).json({ error: '주문 목록 조회 실패' });
  }
});

// GET /api/orders/:id  → order + lines + 매칭 통계
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const order = await wmsRepo.getWmsOrderWithLines(id);
    if (!order) return res.status(404).json({ error: 'not found' });

    const lines = order.lines || [];
    const stats = {
      line_count:    lines.length,
      matched_count: lines.filter((l) => l.match_status && l.match_status.startsWith('matched_')).length,
      failed_count:  lines.filter((l) => l.match_status === 'failed').length,
      pending_count: lines.filter((l) => l.match_status === 'pending').length,
    };

    res.json({ data: { ...order, stats } });
  } catch (e) {
    console.error('[orders] detail error:', e.message);
    res.status(500).json({ error: '주문 상세 조회 실패' });
  }
});

module.exports = router;
