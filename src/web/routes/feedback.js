/**
 * 피드백 API (/api/feedback)
 * 모두 로그인만 하면 작성/조회. 고정·삭제는 admin만.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/feedbackRepository');

const router = express.Router();

// GET /api/feedback — 목록 (원글)
router.get('/', async (req, res) => {
  try {
    const data = await repo.listPosts();
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/feedback/:id — 원글 + 답글
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await repo.getPostWithReplies(id);
    if (!data) return res.status(404).json({ error: '글을 찾을 수 없습니다' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/feedback — 작성
router.post('/', async (req, res) => {
  try {
    const { title, content, parentId } = req.body || {};
    const trimmed = content?.trim();
    if (!trimmed) return res.status(400).json({ error: '내용을 입력하세요' });

    const pid = parentId ? parseInt(parentId, 10) : null;
    let ttl = title?.trim() || null;
    if (!pid && !ttl) return res.status(400).json({ error: '제목을 입력하세요' });

    if (pid) {
      const parent = await repo.getById(pid);
      if (!parent) return res.status(404).json({ error: '답글 대상 글을 찾을 수 없습니다' });
      if (parent.parent_id) return res.status(400).json({ error: '답글에는 답글을 달 수 없습니다' });
      ttl = null; // 답글은 제목 없음
    }

    const created = await repo.createPost({ authorId: req.user.id, title: ttl, content: trimmed, parentId: pid });
    res.json({ data: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/feedback/:id/pin — admin only, 토글
router.patch('/:id/pin', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '글을 찾을 수 없습니다' });
    if (existing.parent_id) return res.status(400).json({ error: '답글은 고정할 수 없습니다' });
    const updated = await repo.togglePin(id, !existing.is_pinned);
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/feedback/:id — admin only
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '글을 찾을 수 없습니다' });
    await repo.deletePost(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
