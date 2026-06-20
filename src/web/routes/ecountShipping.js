'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const EcountShippingService = require('../../services/ecountShipping');
const EcountAPI = require('../../api/ecountAPI');

const router = express.Router();
router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const api = new EcountAPI();
    await api.getSession();
    res.json({ ok: true, message: '이카운트 연결 정상', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/shipping/preview', async (req, res) => {
  try {
    const { days = 1, platform } = req.query;
    const svc    = new EcountShippingService();
    const result = await svc.run({ days: Number(days), platform: platform || undefined, dryRun: true });
    res.json({ ok: true, dryRun: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/shipping/run', async (req, res) => {
  try {
    const { days = 1, platform, orderIds, startDate } = req.body;
    const svc    = new EcountShippingService();
    const result = await svc.run({
      days:      Number(days),
      platform:  platform  || undefined,
      orderIds:  orderIds  || undefined,
      startDate: startDate || undefined,
      dryRun:    false,
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
