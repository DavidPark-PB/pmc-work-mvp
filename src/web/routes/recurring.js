/**
 * 정기결제 관리 (/api/recurring) — 재무 권한자 전용.
 * 정기결제 CRUD + 수동 발행(run-now) 엔드포인트.
 */
const express = require('express');
const repo = require('../../db/recurringRepository');
const expenseRepo = require('../../db/expenseRepository');

const router = express.Router();

function requireFinance(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  if (!req.user.canManageFinance) return res.status(403).json({ error: '재무 권한이 필요합니다' });
  next();
}

router.use(requireFinance);

router.get('/', async (req, res) => {
  try {
    const data = await repo.list({ activeOnly: req.query.active === 'true' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await repo.getById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: '정기결제를 찾을 수 없습니다' });
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

// POST /api/recurring/:id/run — 해당 정기결제 1건을 지금 즉시 expense로 발행 + 다음 일자 전진.
router.post('/:id/run', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await repo.getById(id);
    if (!r) return res.status(404).json({ error: '정기결제를 찾을 수 없습니다' });
    const result = await repo.fire(r, { expenseRepo });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recurring/fire-due — 도래한 모든 정기결제 즉시 발행 (테스트/수동 트리거용)
router.post('/fire-due', async (req, res) => {
  try {
    const due = await repo.listDue();
    let fired = 0;
    for (const r of due) {
      try {
        await repo.fire(r, { expenseRepo });
        fired++;
      } catch (e) {
        console.warn(`[recurring] fire fail id=${r.id}:`, e.message);
      }
    }
    res.json({ ok: true, due: due.length, fired });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
