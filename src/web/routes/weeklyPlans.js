/**
 * 주간 업무 API (/api/weekly-plans)
 *
 * - 모든 직원: 본인 주간 플랜 조회/수정, 본인 월별 KPI 조회
 * - admin: 전 직원 특정 주 조회, 월별 KPI 조회
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/weeklyPlanRepository');

const router = express.Router();

// GET /api/weekly-plans/current?weekStart=YYYY-MM-DD — 본인 이번주 (없으면 draft 생성)
router.get('/current', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.getOrCreateCurrent(req.user.id, req.query.weekStart);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly-plans — 본인 최근 주간 플랜 히스토리 (admin은 userId 지정 가능)
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const userId = req.user.isAdmin && req.query.userId ? parseInt(req.query.userId, 10) : req.user.id;
    const data = await repo.listForUser(userId, {
      from: req.query.from, to: req.query.to,
      limit: Math.min(52, parseInt(req.query.limit, 10) || 12),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly-plans/week/:weekStart — admin용: 해당 주 전체 직원 플랜
router.get('/week/:weekStart', requireAdmin, async (req, res) => {
  try {
    const data = await repo.listForWeek(req.params.weekStart);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/weekly-plans/kpi?month=YYYY-MM — admin용 월별 KPI
router.get('/kpi', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const def = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : def;
    const data = await repo.monthlyKpi(month);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/weekly-plans/:id — 본인 것만 수정 (admin은 아무거나 ok)
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const userIdGate = req.user.isAdmin ? undefined : req.user.id;
    const updated = await repo.update(id, req.body || {}, userIdGate);
    if (!updated) return res.status(404).json({ error: '주간 플랜을 찾을 수 없거나 권한이 없습니다' });
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/weekly-plans/:id — admin만
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await repo.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
