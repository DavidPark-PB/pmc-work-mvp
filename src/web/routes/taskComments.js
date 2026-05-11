/**
 * 업무 카드 한줄 댓글 API (PR T-1)
 *
 * 라우트:
 *   GET   /api/tasks/:id/comments?limit=N      — 본인 recipient or admin
 *   POST  /api/tasks/:id/comments              — multipart, content + 0~3 files
 *   GET   /api/tasks/:id/comments/:cid/attachments/:idx/url — 서명 다운로드 URL
 *
 * 정책:
 *   - 권한: admin = 모든 task. staff = 본인 recipient 가 있는 task.
 *   - 첨부: 댓글당 최대 3개, 각 5MB. 기존 task-attachments bucket 재사용.
 *   - 경로: ${taskId}/comments/${ts}-${rand}-${name}
 *   - audit 무 (low-stake 댓글 — Safety Foundation 부담 최소화).
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const repo = require('../../db/teamTaskRepository');
const commentsRepo = require('../../db/teamTaskCommentsRepository');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router({ mergeParams: true });

const ATTACHMENT_BUCKET = 'task-attachments';
const MAX_FILES_PER_COMMENT = commentsRepo.MAX_ATTACHMENTS_PER_COMMENT;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/zip', 'application/x-zip-compressed',
]);

const uploadComments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_COMMENT },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`허용되지 않는 파일 형식: ${file.mimetype}`));
  },
});

function sanitizeFileName(name) {
  return (name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
}

async function ensureAccess(taskId, user) {
  if (user.isAdmin) return true;
  const rec = await repo.getRecipient(taskId, user.id);
  return !!rec;
}

// GET /api/tasks/:id/comments
router.get('/', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'invalid id' });

    const allowed = await ensureAccess(taskId, req.user);
    if (!allowed) return res.status(403).json({ error: '권한이 없습니다' });

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const data = await commentsRepo.listComments({ taskId, limit });
    const total = await commentsRepo.countByTask(taskId);
    res.json({ data, total });
  } catch (e) {
    console.error('[taskComments] list error:', { id: req.params.id, message: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tasks/:id/comments  (multipart)
router.post('/', (req, res, next) => {
  uploadComments.array('files', MAX_FILES_PER_COMMENT)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `파일이 너무 큽니다 (최대 ${MAX_FILE_BYTES / 1024 / 1024}MB)`
        : err.code === 'LIMIT_FILE_COUNT'
        ? `파일이 너무 많습니다 (최대 ${MAX_FILES_PER_COMMENT}개)`
        : err.message || '업로드 오류';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'invalid id' });

  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '댓글 내용을 입력하세요' });

  try {
    const allowed = await ensureAccess(taskId, req.user);
    if (!allowed) return res.status(403).json({ error: '권한이 없습니다' });

    const task = await repo.getTask(taskId);
    if (!task) return res.status(404).json({ error: '업무를 찾을 수 없습니다' });

    const files = req.files || [];
    const uploadedPaths = [];
    const attachments = [];

    if (files.length > 0) {
      const storage = getClient().storage.from(ATTACHMENT_BUCKET);
      try {
        for (const f of files) {
          const rand = crypto.randomBytes(6).toString('hex');
          const clean = sanitizeFileName(f.originalname);
          const path = `${taskId}/comments/${Date.now()}-${rand}-${clean}`;
          const { error: upErr } = await storage.upload(path, f.buffer, {
            contentType: f.mimetype,
            upsert: false,
          });
          if (upErr) throw new Error(`Storage 업로드 실패: ${upErr.message}`);
          uploadedPaths.push(path);
          attachments.push({
            file_path: path,
            file_name: clean,
            mime_type: f.mimetype,
            size: f.size,
          });
        }
      } catch (e) {
        if (uploadedPaths.length > 0) {
          try { await storage.remove(uploadedPaths); } catch {}
        }
        throw e;
      }
    }

    const created = await commentsRepo.createComment({
      taskId,
      authorId: req.user.id,
      content,
      attachments: attachments.length ? attachments : null,
    });

    res.status(201).json({ data: created });
  } catch (e) {
    console.error('[taskComments] create error:', {
      id: req.params.id, userId: req.user?.id, message: e.message,
    });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tasks/:id/comments/:cid/attachments/:idx/url
router.get('/:cid/attachments/:idx/url', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const cid = parseInt(req.params.cid, 10);
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isFinite(taskId) || !Number.isFinite(cid) || !Number.isFinite(idx)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const allowed = await ensureAccess(taskId, req.user);
    if (!allowed) return res.status(403).json({ error: '권한이 없습니다' });

    const list = await commentsRepo.listComments({ taskId, limit: null });
    const c = list.find(x => x.id === cid);
    if (!c) return res.status(404).json({ error: '댓글을 찾을 수 없습니다' });

    const att = (c.attachments || [])[idx];
    if (!att) return res.status(404).json({ error: '첨부를 찾을 수 없습니다' });

    const { data, error } = await getClient().storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(att.file_path, 300, { download: att.file_name });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, fileName: att.file_name });
  } catch (e) {
    console.error('[taskComments] signed url error:', { message: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
