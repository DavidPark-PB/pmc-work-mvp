/**
 * Google Sheets 카탈로그 가격 관리 API
 *   GET  /api/catalog/prices?tab=<tab>   — 상품 목록 + 현재 환율 + 계산값
 *   PUT  /api/catalog/prices             — { tab, rowIndex, side, usdPrice } → 3시트 동시 업데이트
 *   GET  /api/catalog/tabs               — 사용 가능한 시트 탭 목록
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const service = require('../../services/catalogService');

const router = express.Router();

router.get('/prices', async (req, res) => {
  try {
    const data = await service.getCatalog(req.query.tab);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tabs', async (req, res) => {
  try {
    const tabs = await service.listTabs();
    res.json({ tabs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/prices', requireAdmin, async (req, res) => {
  try {
    const { tab, rowIndex, side, usdPrice } = req.body || {};
    const result = await service.updatePrice({
      tab,
      rowIndex: parseInt(rowIndex, 10),
      side,
      usdPrice: Number(usdPrice),
    });
    res.json({ ok: true, result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
