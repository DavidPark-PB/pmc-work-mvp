/**
 * 플랫폼 상품 동기화 수동 트리거 API
 * POST /api/sync/naver/list
 * POST /api/sync/naver/enrich-details
 * POST /api/sync/shopee/all
 * POST /api/sync/alibaba/all
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const sync = require('../../services/platformSync');

const router = express.Router();

function wrap(fn, label) {
  return async (req, res) => {
    const t0 = Date.now();
    try {
      const result = await fn(req);
      const elapsed = Date.now() - t0;
      console.log(`[${label}] ${elapsed}ms`, result);
      res.json({ ok: true, elapsedMs: elapsed, result });
    } catch (e) {
      console.error(`[${label}] error:`, e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  };
}

router.post('/naver/list', requireAdmin, wrap(() => sync.syncNaverList(), 'naver:list'));
router.post('/naver/enrich-details', requireAdmin, wrap((req) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  return sync.enrichNaverDetails(limit);
}, 'naver:enrich'));
router.post('/shopee/all', requireAdmin, wrap(() => sync.syncShopeeAll(), 'shopee:all'));
router.post('/alibaba/all', requireAdmin, wrap(() => sync.syncAlibabaAll(), 'alibaba:all'));

module.exports = router;
