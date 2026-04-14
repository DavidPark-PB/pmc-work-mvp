/**
 * 급여 + Shopee 보너스 API
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/payrollRepository');

const router = express.Router();

// GET /api/payroll/summary?month=YYYY-MM (admin only)
router.get('/summary', requireAdmin, async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !repo.isValidMonth(month)) return res.status(400).json({ error: '유효한 month (YYYY-MM)를 지정하세요' });
    res.json(await repo.getMonthlySummary(month));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/payroll/:employeeId?month=YYYY-MM
router.get('/:employeeId', async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (!req.user.isAdmin && employeeId !== req.user.id) {
      return res.status(403).json({ error: '본인 급여만 조회 가능합니다' });
    }
    const { month } = req.query;
    if (!month || !repo.isValidMonth(month)) return res.status(400).json({ error: '유효한 month (YYYY-MM)를 지정하세요' });
    const data = await repo.getEmployeeMonthly(employeeId, month);
    if (!data.employee) return res.status(404).json({ error: '직원을 찾을 수 없습니다' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/payroll/:employeeId/rate (admin)
router.patch('/:employeeId/rate', requireAdmin, async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    const rate = Number(req.body?.hourlyRate);
    if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: '시급은 0 이상의 숫자여야 합니다' });
    const data = await repo.setHourlyRate(employeeId, rate);
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
