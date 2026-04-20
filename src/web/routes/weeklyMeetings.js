/**
 * 주간 회의 API (/api/weekly-meetings) — admin 전용.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/weeklyMeetingRepository');
const extractor = require('../../services/weeklyMeetingExtractor');

const router = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const data = await repo.list({
      from: req.query.from, to: req.query.to, status: req.query.status,
      limit: Math.min(100, parseInt(req.query.limit, 10) || 30),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await repo.getById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: '회의를 찾을 수 없습니다' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const created = await repo.create({ ...req.body, createdBy: req.user.id });
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await repo.update(parseInt(req.params.id, 10), req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await repo.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/extract — AI 추출 (Gemini)
router.post('/:id/extract', async (req, res) => {
  try {
    const updated = await extractor.extractActionItems(parseInt(req.params.id, 10));
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/distribute — 주간 플랜에 배포
router.post('/:id/distribute', async (req, res) => {
  try {
    const result = await extractor.distributeToPlans(parseInt(req.params.id, 10));
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
