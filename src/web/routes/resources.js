/**
 * 자료실 API (/api/resources)
 *
 * - 모든 로그인 직원: 파일 열람, 태그 검색
 * - admin: 폴더 등록/수정/삭제, 동기화 트리거, 파일 태그 수정
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/resourceRepository');
const uploadRepo = require('../../db/sharedUploadRepository');
const sync = require('../../services/resourceSync');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

// ── 직접 업로드 ──────────────────────────────────────────────
const UPLOAD_BUCKET = 'shared-uploads';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const SIZE_THRESHOLD_LARGE = 10 * 1024 * 1024; // 10 MB 기준
const DEFAULT_DAYS_SMALL = 30;
const DEFAULT_DAYS_LARGE = 7;
const MAX_DAYS = 90;

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 },
});

function sanitizeFileName(name) {
  return (name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
}

function pickRetentionDays(sizeBytes, override) {
  if (override != null) {
    const n = Math.floor(Number(override));
    if (Number.isFinite(n) && n > 0 && n <= MAX_DAYS) return n;
  }
  return sizeBytes >= SIZE_THRESHOLD_LARGE ? DEFAULT_DAYS_LARGE : DEFAULT_DAYS_SMALL;
}

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

// ── 직접 업로드 API ─────────────────────────────────────────
// POST /api/resources/uploads — 파일 업로드 (multipart/form-data)
router.post('/uploads', uploadMw.array('files', 10), async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '파일을 선택하세요' });

    const description = (req.body?.description || '').toString().trim() || null;
    const tagsRaw = (req.body?.tags || '').toString();
    const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
    const daysOverride = req.body?.days ? Number(req.body.days) : null;

    const db = getClient();
    const saved = [];
    for (const f of files) {
      const days = pickRetentionDays(f.size, daysOverride);
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const cleanName = sanitizeFileName(f.originalname);
      const id = crypto.randomBytes(8).toString('hex');
      const storagePath = `${new Date().toISOString().slice(0, 10)}/${id}-${cleanName}`;

      const { error: upErr } = await db.storage.from(UPLOAD_BUCKET).upload(storagePath, f.buffer, {
        contentType: f.mimetype || 'application/octet-stream',
        upsert: false,
      });
      if (upErr) {
        console.error('[uploads] storage upload:', upErr.message);
        return res.status(500).json({ error: `Storage 업로드 실패: ${upErr.message} (Supabase 에 '${UPLOAD_BUCKET}' 버킷 만들어주세요)` });
      }

      const rec = await uploadRepo.create({
        storagePath,
        originalName: f.originalname,
        mimeType: f.mimetype,
        sizeBytes: f.size,
        description,
        tags,
        userId: req.user.id,
        expiresAt,
      });
      saved.push(rec);
    }
    res.json({ data: saved });
  } catch (e) {
    console.error('[uploads] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/resources/uploads — 활성(미만료) 업로드 목록
router.get('/uploads', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await uploadRepo.listActive({
      search: req.query.search || undefined,
      tag: req.query.tag || undefined,
      limit: Math.min(500, parseInt(req.query.limit, 10) || 200),
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/resources/uploads/:id/download — signed URL 리다이렉트
router.get('/uploads/:id/download', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const rec = await uploadRepo.getById(parseInt(req.params.id, 10));
    if (!rec) return res.status(404).json({ error: '파일을 찾을 수 없습니다' });
    const db = getClient();
    const { data, error } = await db.storage.from(UPLOAD_BUCKET).createSignedUrl(rec.storagePath, 300, {
      download: rec.originalName,
    });
    if (error || !data?.signedUrl) throw error || new Error('signed URL 생성 실패');
    res.redirect(data.signedUrl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/resources/uploads/:id — uploader 본인 또는 admin
router.delete('/uploads/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const rec = await uploadRepo.getById(id);
    if (!rec) return res.status(404).json({ error: '파일을 찾을 수 없습니다' });
    const isOwner = rec.uploadedBy === req.user.id;
    if (!isOwner && !req.user.isAdmin) return res.status(403).json({ error: '본인 업로드 또는 관리자만 삭제 가능' });

    // Storage 먼저 지운 뒤 DB 삭제 (역순이면 고아 파일 남음)
    try {
      const db = getClient();
      await db.storage.from(UPLOAD_BUCKET).remove([rec.storagePath]);
    } catch (e) { console.warn('[uploads] storage remove:', e.message); }
    await uploadRepo.remove(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
