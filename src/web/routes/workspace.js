/**
 * 개인 워크스페이스 API (/api/workspace)
 * 모든 직원이 본인 것만 읽고 쓸 수 있음. admin도 타인 것 못 봄 (privacy).
 */
const express = require('express');
const repo = require('../../db/workspaceRepository');
const todoRepo = require('../../db/workspaceTodoRepository');

const router = express.Router();

// ── 할 일 체크리스트 (본인만) ──
router.get('/todos', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await todoRepo.listTodos(req.user.id);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/todos', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const { text, dueDate } = req.body || {};
    const created = await todoRepo.createTodo(req.user.id, { text, dueDate });
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/todos/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const updated = await todoRepo.updateTodo(req.user.id, id, req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/todos/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    await todoRepo.deleteTodo(req.user.id, id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/todos/clear-completed', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    await todoRepo.clearCompleted(req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const { tag, search } = req.query;
    const data = await repo.listNotes(req.user.id, { tag, search });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tags', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const tags = await repo.listTags(req.user.id);
    res.json({ tags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const note = await repo.getNote(req.user.id, parseInt(req.params.id, 10));
    if (!note) return res.status(404).json({ error: '노트를 찾을 수 없습니다' });
    res.json({ data: note });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const { title, content, tag, pinned } = req.body || {};
    if (!title?.trim() && !content?.trim()) {
      return res.status(400).json({ error: '제목이나 내용 중 하나는 입력하세요' });
    }
    const created = await repo.createNote(req.user.id, { title, content, tag, pinned });
    res.json({ data: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getNote(req.user.id, id);
    if (!existing) return res.status(404).json({ error: '노트를 찾을 수 없습니다' });
    const updated = await repo.updateNote(req.user.id, id, req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getNote(req.user.id, id);
    if (!existing) return res.status(404).json({ error: '노트를 찾을 수 없습니다' });
    await repo.deleteNote(req.user.id, id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
