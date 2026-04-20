/**
 * 자료실 API (/api/resources)
 *
 * - 모든 로그인 직원: 파일 열람, 태그 검색
 * - admin: 폴더 등록/수정/삭제, 동기화 트리거, 파일 태그 수정
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/resourceRepository');
const sync = require('../../services/resourceSync');

const router = express.Router();

// ── 폴더 ──
router.get('/folders', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.listFolders({ activeOnly: req.query.activeOnly === 'true' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/folders', requireAdmin, async (req, res) => {
  try {
    const created = await repo.createFolder({ ...req.body, createdBy: req.user.id });
    // 자동 첫 동기화 시도 (실패해도 폴더는 등록됨)
    try { await sync.syncFolder(created.id); } catch (e) { console.warn('[resources] first sync fail:', e.message); }
    const fresh = await repo.getFolder(created.id);
    res.json({ data: fresh });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/folders/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await repo.updateFolder(parseInt(req.params.id, 10), req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/folders/:id', requireAdmin, async (req, res) => {
  try {
    await repo.deleteFolder(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 수동 동기화 트리거
router.post('/folders/:id/sync', requireAdmin, async (req, res) => {
  try {
    const result = await sync.syncFolder(parseInt(req.params.id, 10));
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync-all', requireAdmin, async (req, res) => {
  try {
    const results = await sync.syncAll();
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 파일 ──
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.listResources({
      folderId: req.query.folderId ? parseInt(req.query.folderId, 10) : undefined,
      search: req.query.search || undefined,
      tag: req.query.tag || undefined,
      limit: Math.min(2000, parseInt(req.query.limit, 10) || 500),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tags', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const tags = await repo.listAllTags();
    res.json({ tags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/tags', requireAdmin, async (req, res) => {
  try {
    const tags = req.body?.tags;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags 배열을 보내세요' });
    const updated = await repo.updateResourceTags(parseInt(req.params.id, 10), tags);
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
