/**
 * /api/sku-master/search — 발주 폼 SKU 자동완성 (PR P-1A-B)
 *
 * 기존 /api/sku-master 라우터는 requireAdmin (CRUD).
 * 본 라우터는 read-only autocomplete 라 모든 직원 (requireAuth) 허용.
 *
 * fallback (사장님 짚은점 2):
 *   - sku_master 미존재 / 0건 매칭 → 빈 배열 반환. caller(UI) 에서 "일치 SKU 없음" 표시 + 직접 입력 허용.
 *   - 발주 저장 시 sku_master 미존재 SKU 도 거부 X — UI 에서 "SKU 미연결" 뱃지.
 *
 * rate limit: server.js /api/ 상위 (300/15min). 별도 추가 X.
 */
'use strict';

const express = require('express');
const matcher = require('../../services/purchaseSkuMatcher');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const recentDays = req.query.recentDays ? parseInt(req.query.recentDays, 10) : undefined;
    const data = await matcher.searchByQuery(q, { limit, recentDays });
    res.json({ data });
  } catch (e) {
    console.error('[skuMasterSearch] error:', { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
