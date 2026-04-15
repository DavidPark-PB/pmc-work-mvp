/**
 * Shopee 보너스 API
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/payrollRepository');

const router = express.Router();

// GET /api/bonuses/:employeeId — 본인 또는 사장
router.get('/:employeeId', async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId, 10);
    if (!req.user.isAdmin && employeeId !== req.user.id) {
      return res.status(403).json({ error: '본인 보너스만 조회 가능합니다' });
    }
    const data = await repo.listBonusesByEmployee(employeeId);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bonuses (admin only) — 상여/인센티브 금액 직접 입력
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { employeeId, month, bonusAmount } = req.body || {};
    if (!employeeId) return res.status(400).json({ error: 'employeeId가 필요합니다' });
    if (!month || !repo.isValidMonth(month)) return res.status(400).json({ error: 'month 형식 오류 (YYYY-MM)' });
    const amount = Number(bonusAmount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: '상여 금액은 0 이상의 숫자여야 합니다' });

    const data = await repo.upsertBonus({
      employeeId: parseInt(employeeId, 10),
      month,
      bonusAmount: amount,
      enteredBy: req.user.id,
    });
    res.json({ data });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
