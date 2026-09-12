/**
 * src/web/routes/omsOrders.js — PMC-OMS-CONSOLE-1B (2026-09-12).
 *
 * READ-ONLY canonical OMS order queue.
 *
 *   GET /api/oms/orders/pending-action?limit=50&offset=0
 *     → { ok, scope:"pending-action", total, rows, limit, offset }
 *
 *   Source-of-truth: PENDING_ACTION_STATUSES is imported verbatim from
 *   src/services/oms/omsBriefingCounts.js — the exact same frozen array
 *   consumed by briefing.countPendingAction. Both count and list
 *   consequently describe the same cohort by construction; changing the
 *   umbrella means changing exactly one file.
 *
 *   No wms_orders fallback. If the canonical query fails, this route
 *   returns a non-2xx error so the UI can render "확인 실패" — never a
 *   fake `{total:0, rows:[]}` (UNKNOWN ≠ ZERO ≠ WRONG_TABLE).
 *
 *   Field allowlist enforced by the repository. No buyer email, no phone,
 *   no address. Marketplace mutation surface is intentionally absent.
 */
'use strict';

const express = require('express');
const router = express.Router();

const { requireAdmin } = require('../../middleware/auth');
const { PENDING_ACTION_STATUSES } = require('../../services/oms/omsBriefingCounts');
const repo = require('../../services/oms/omsOrderRepository');

//   Owner-only (Phase 8I / DRILL-2 pattern — admin === owner in current tier model).
router.use(requireAdmin);

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

//   GET /pending-action — the canonical 미처리 cohort.
//   Mounted under /api/oms/orders in server.js.
router.get('/pending-action', async (req, res) => {
  const limit  = clampInt(req.query.limit,  50, 1, 200);
  const offset = clampInt(req.query.offset,  0, 0, Number.MAX_SAFE_INTEGER);
  try {
    const { total, rows } = await repo.listOrders({
      statuses: PENDING_ACTION_STATUSES.slice(),
      limit,
      offset,
    });
    res.json({
      ok: true,
      scope: 'pending-action',
      total,
      rows,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[omsOrders] pending-action failed:', err.message || err);
    //   Explicit failure envelope — UI renders "주문 정보를 확인하지 못했습니다."
    //   Never a fake success with an empty list (Unknown ≠ Zero).
    res.status(500).json({
      ok: false,
      error: 'oms_orders_query_failed',
      message: err.message || String(err),
    });
  }
});

module.exports = router;
