/**
 * 지출 관리 API (/api/expenses)
 *
 * 현재 범위 (Phase 1 Day 1): 수동 지출 등록/조회/편집/삭제, 월별 카테고리 합계, 카테고리 목록.
 * 다음 증분: CSV 업로드(Day 2), 정기결제(Day 3).
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/expenseRepository');
const { CATEGORIES } = require('../../services/expenseCategories');

const router = express.Router();

// GET /api/expenses/categories — UI 드롭다운 + 색상
router.get('/categories', (req, res) => {
  res.json({ categories: CATEGORIES });
});

// GET /api/expenses?from=YYYY-MM-DD&to=&category=&source=&limit=
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.listExpenses({
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      category: req.query.category || undefined,
      source: req.query.source || undefined,
      limit: Math.min(2000, parseInt(req.query.limit, 10) || 500),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/summary?month=YYYY-MM
router.get('/summary', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const now = new Date();
    const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : defMonth;
    const summary = await repo.summaryByMonth(month);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/:id
router.get('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const data = await repo.getExpense(id);
    if (!data) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/expenses — 수동 등록 (로그인 사용자 누구나, 기록에는 작성자 남음)
router.post('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const {
      paidAt, amount, currency, category, merchant, memo, cardLast4, taskId,
    } = req.body || {};
    if (!paidAt) return res.status(400).json({ error: '결제일(paidAt)을 입력하세요' });
    const num = Number(amount);
    if (!Number.isFinite(num) || num === 0) return res.status(400).json({ error: '금액을 입력하세요' });
    const created = await repo.createExpense({
      paidAt, amount: num, currency, category, merchant, memo, cardLast4, taskId,
      source: 'manual',
      createdBy: req.user.id,
    });
    // 머천트-카테고리 학습 캐시에도 저장 (수동=confidence 100)
    if (created.merchant) {
      await repo.saveCachedCategory({
        merchant: created.merchant,
        category: created.category,
        confidence: 100,
        createdBy: req.user.id,
      });
    }
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/expenses/:id — 편집 (admin 또는 작성자 본인)
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.isAdmin && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 지출만 수정할 수 있습니다' });
    }
    const updated = await repo.updateExpense(id, req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/expenses/:id — 삭제 (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    await repo.deleteExpense(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
