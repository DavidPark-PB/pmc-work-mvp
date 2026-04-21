/**
 * 경쟁업체 API (/api/competitors) — admin 전용.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/competitorRepository');

const router = express.Router();

router.use(requireAdmin);

router.get('/stats', async (req, res) => {
  try { res.json(await repo.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const data = await repo.list({
      platform: req.query.platform || undefined,
      threatLevel: req.query.threatLevel || undefined,
      search: req.query.search || undefined,
      limit: Math.min(1000, parseInt(req.query.limit, 10) || 500),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await repo.getById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: '경쟁업체를 찾을 수 없습니다' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const created = await repo.create(req.body || {}, req.user?.id);
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await repo.update(parseInt(req.params.id, 10), req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/checked', async (req, res) => {
  try {
    const updated = await repo.touchChecked(parseInt(req.params.id, 10));
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await repo.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
