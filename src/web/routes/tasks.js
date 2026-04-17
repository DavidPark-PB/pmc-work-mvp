/**
 * 업무 관리 API (/api/tasks, /api/tasks/stats)
 *
 * 권한:
 *   owner: 전체 조회/등록/수정/삭제. 수신자 상태 force-complete 가능.
 *   staff: 본인 recipient 있는 task만. 본인 상태만 변경.
 *
 * PATCH body:
 *   - 메타데이터 변경 (title/assigneeId/assigneeScope/dueDate/priority/memo) — admin only
 *   - 상태 변경 (status/completionNote/userId?) — recipient 기준
 *     - userId 생략 시 req.user.id (본인) 대상
 *     - userId 지정은 admin만 허용 (직원 대신 완료 처리)
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/teamTaskRepository');
const { notify, notifyMany, notifyAdmins, getStaffIds } = require('../../services/notificationService');
const sseHub = require('../../services/sseHub');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

const ATTACHMENT_BUCKET = 'task-attachments';
const MAX_FILES_PER_COMPLETE = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'application/zip', 'application/x-zip-compressed',
]);

const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_COMPLETE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`허용되지 않는 파일 형식: ${file.mimetype}`));
  },
});

function sanitizeFileName(name) {
  return (name || 'file')
    .replace(/[\\/\x00-\x1f]/g, '_')
    .slice(0, 150);
}

// GET /api/tasks
router.get('/', async (req, res) => {
  try {
    const { status, scope, assigneeId } = req.query;
    const data = await repo.listTasks({
      user: req.user,
      status,
      scope,
      assigneeId: assigneeId ? parseInt(assigneeId, 10) : undefined,
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tasks/stats
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await repo.getTodayStats();
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tasks (owner only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { title, assigneeId, assigneeScope, dueDate, priority, memo } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: '업무 내용을 입력하세요' });

    const scope = assigneeScope === 'all' ? 'all' : 'specific';
    const assignee = scope === 'all' ? null : (assigneeId ? parseInt(assigneeId, 10) : null);
    if (scope === 'specific' && !assignee) {
      return res.status(400).json({ error: '담당자를 선택하거나 전체 공지로 지정하세요' });
    }

    const { task, recipientCount } = await repo.createTask({
      title: title.trim(),
      assignee_id: assignee,
      assignee_scope: scope,
      due_date: dueDate ? new Date(dueDate).toISOString() : null,
      priority: priority === 'urgent' ? 'urgent' : 'normal',
      memo: memo?.trim() || null,
      created_by: req.user.id,
    });

    // 알림 (DB) + SSE 실시간 이벤트
    const ssePayload = {
      type: 'task_assigned',
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      urgent: task.priority === 'urgent',
      scope,
      linkUrl: '/?page=tasks',
    };

    if (scope === 'specific' && assignee && assignee !== req.user.id) {
      await notify({
        recipientId: assignee,
        type: 'task_assigned',
        title: priority === 'urgent' ? '[긴급] 새 업무 지시' : '새 업무 지시',
        body: task.title,
        linkUrl: '/?page=tasks',
        relatedType: 'task',
        relatedId: task.id,
      });
      sseHub.sendTo(assignee, ssePayload);
    } else if (scope === 'all') {
      const staffIds = await getStaffIds();
      await notifyMany(staffIds, {
        type: 'task_assigned',
        title: '전체 공지 업무',
        body: task.title,
        linkUrl: '/?page=tasks',
        relatedType: 'task',
        relatedId: task.id,
      });
      sseHub.sendToMany(staffIds, ssePayload);
    }

    res.json({ data: task, recipientCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/tasks/:id
// 2가지 모드 자동 분기:
//   메타 필드 (title/due/priority/memo/assigneeId/assigneeScope) → admin만, team_tasks update
//   status/completionNote → recipient 업데이트
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const task = await repo.getTask(id);
    if (!task) return res.status(404).json({ error: '업무를 찾을 수 없습니다' });

    const body = req.body || {};
    const isMetaUpdate = body.title !== undefined || body.assigneeScope !== undefined ||
                         body.assigneeId !== undefined || body.dueDate !== undefined ||
                         body.priority !== undefined || body.memo !== undefined;
    const isStatusUpdate = body.status !== undefined || body.completionNote !== undefined;

    // 메타 업데이트
    if (isMetaUpdate) {
      if (!req.user.isAdmin) return res.status(403).json({ error: '메타데이터 수정은 사장만 가능합니다' });
      const metaUpdates = {};
      if (body.title !== undefined) metaUpdates.title = body.title.trim();
      if (body.dueDate !== undefined) metaUpdates.due_date = body.dueDate ? new Date(body.dueDate).toISOString() : null;
      if (body.priority !== undefined) metaUpdates.priority = body.priority;
      if (body.memo !== undefined) metaUpdates.memo = body.memo?.trim() || null;
      // assignee 재배정은 지금은 비활성 (recipient 재구성 필요 — 추후)
      if (Object.keys(metaUpdates).length === 0 && !isStatusUpdate) {
        return res.status(400).json({ error: '변경할 내용이 없습니다' });
      }
      if (Object.keys(metaUpdates).length > 0) {
        await repo.updateTaskMeta(id, metaUpdates);
      }
    }

    // 상태 업데이트 (recipient 기준)
    if (isStatusUpdate) {
      const targetUserId = req.user.isAdmin && body.userId ? parseInt(body.userId, 10) : req.user.id;

      // 본인이 아닌 recipient 대상은 admin만 가능
      if (targetUserId !== req.user.id && !req.user.isAdmin) {
        return res.status(403).json({ error: '타인 상태 변경은 사장만 가능합니다' });
      }

      // recipient 존재 확인
      const rec = await repo.getRecipient(id, targetUserId);
      if (!rec) return res.status(404).json({ error: '해당 직원의 업무 수신 기록이 없습니다' });

      // 상태 validation
      const newStatus = body.status;
      if (newStatus !== undefined && !['pending', 'in_progress', 'done'].includes(newStatus)) {
        return res.status(400).json({ error: '올바른 상태가 아닙니다' });
      }

      // done인데 본인 완료 + 사장 아님 → 코멘트 필수
      if (newStatus === 'done' && targetUserId === req.user.id && !req.user.isAdmin) {
        const note = body.completionNote;
        if (!note || !String(note).trim()) {
          return res.status(400).json({ error: '완료 코멘트를 입력하세요' });
        }
      }

      await repo.updateRecipient(id, targetUserId, {
        status: newStatus,
        completionNote: body.completionNote !== undefined ? (body.completionNote?.trim() || null) : undefined,
      });

      // 직원이 본인 완료 → 사장에게 알림
      if (newStatus === 'done' && !req.user.isAdmin) {
        await notifyAdmins({
          type: 'task_completed',
          title: `${req.user.displayName} 업무 완료`,
          body: `${task.title}${body.completionNote ? ' — ' + body.completionNote : ''}`,
          linkUrl: '/?page=tasks',
          relatedType: 'task',
          relatedId: id,
        });
      }
    }

    const updated = await repo.getTask(id);
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tasks/:id/complete — 본인 완료 + 파일 첨부 (multipart)
// 필드: completionNote(text, 직원 필수), files[]
router.post('/:id/complete', (req, res, next) => {
  uploadAttachments.array('files', MAX_FILES_PER_COMPLETE)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `파일이 너무 큽니다 (최대 ${MAX_FILE_BYTES / 1024 / 1024}MB)`
        : err.code === 'LIMIT_FILE_COUNT'
        ? `파일이 너무 많습니다 (최대 ${MAX_FILES_PER_COMPLETE}개)`
        : err.message || '업로드 오류';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const files = req.files || [];
  const uploadedPaths = [];

  try {
    const task = await repo.getTask(taskId);
    if (!task) return res.status(404).json({ error: '업무를 찾을 수 없습니다' });

    const targetUserId = req.user.id;
    const rec = await repo.getRecipient(taskId, targetUserId);
    if (!rec) return res.status(404).json({ error: '해당 업무의 수신자가 아닙니다' });

    const note = (req.body?.completionNote || '').trim();
    if (!req.user.isAdmin && !note) {
      return res.status(400).json({ error: '완료 코멘트를 입력하세요' });
    }

    const existingCount = await repo.countAttachmentsForUser(taskId, targetUserId);
    if (existingCount + files.length > MAX_FILES_PER_COMPLETE) {
      return res.status(400).json({ error: `업무당 최대 ${MAX_FILES_PER_COMPLETE}개까지 첨부 가능합니다 (현재 ${existingCount}개)` });
    }

    const storage = getClient().storage.from(ATTACHMENT_BUCKET);

    for (const f of files) {
      const rand = crypto.randomBytes(6).toString('hex');
      const clean = sanitizeFileName(f.originalname);
      const path = `${taskId}/${targetUserId}/${Date.now()}-${rand}-${clean}`;
      const { error: upErr } = await storage.upload(path, f.buffer, {
        contentType: f.mimetype,
        upsert: false,
      });
      if (upErr) throw new Error(`Storage 업로드 실패: ${upErr.message}`);
      uploadedPaths.push(path);
      await repo.addAttachment({
        taskId,
        userId: targetUserId,
        filePath: path,
        fileName: clean,
        mimeType: f.mimetype,
        sizeBytes: f.size,
      });
    }

    await repo.updateRecipient(taskId, targetUserId, {
      status: 'done',
      completionNote: note || rec.completion_note || null,
    });

    if (!req.user.isAdmin) {
      await notifyAdmins({
        type: 'task_completed',
        title: `${req.user.displayName} 업무 완료`,
        body: `${task.title}${note ? ' — ' + note : ''}${files.length ? ` (📎 ${files.length})` : ''}`,
        linkUrl: '/?page=tasks',
        relatedType: 'task',
        relatedId: taskId,
      });
    }

    const updated = await repo.getTask(taskId);
    res.json({ data: updated, attachmentsAdded: files.length });
  } catch (e) {
    // rollback: delete any files uploaded in this request
    if (uploadedPaths.length > 0) {
      try { await getClient().storage.from(ATTACHMENT_BUCKET).remove(uploadedPaths); } catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tasks/:id/attachments/:attId/url — 서명 다운로드 URL 발급
router.get('/:id/attachments/:attId/url', async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const attId = parseInt(req.params.attId, 10);
    const att = await repo.getAttachment(attId);
    if (!att || att.task_id !== taskId) return res.status(404).json({ error: '첨부를 찾을 수 없습니다' });

    if (!req.user.isAdmin && att.user_id !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }

    const { data, error } = await getClient().storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(att.file_path, 300, { download: att.file_name });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, fileName: att.file_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tasks/:id (owner only) — CASCADE로 recipients 함께 삭제
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getTask(id);
    if (!existing) return res.status(404).json({ error: '업무를 찾을 수 없습니다' });
    await repo.deleteTask(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
