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

// PATCH /api/feedback/:id — 제목/내용 수정 (작성자 본인 또는 admin)
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '글을 찾을 수 없습니다' });

    const isOwner = existing.author_id === req.user.id;
    if (!isOwner && !req.user.isAdmin) {
      return res.status(403).json({ error: '본인 글만 수정할 수 있습니다' });
    }

    const { title, content } = req.body || {};
    const isReply = !!existing.parent_id;

    const updates = {};
    if (content !== undefined) {
      if (!String(content).trim()) return res.status(400).json({ error: '내용을 입력하세요' });
      updates.content = String(content).trim();
    }
    if (title !== undefined && !isReply) {
      if (!String(title).trim()) return res.status(400).json({ error: '제목을 입력하세요' });
      updates.title = String(title).trim();
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '변경할 내용이 없습니다' });

    const updated = await repo.updatePost(id, updates);
    res.json({ data: updated });
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

// DELETE /api/feedback/:id — 작성자 본인 또는 admin (CASCADE로 답글 함께 삭제)
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '글을 찾을 수 없습니다' });

    const isOwner = existing.author_id === req.user.id;
    if (!isOwner && !req.user.isAdmin) {
      return res.status(403).json({ error: '본인 글만 삭제할 수 있습니다' });
    }

    await repo.deletePost(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
