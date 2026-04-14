/**
 * 업무 관리 API (/api/tasks, /api/tasks/stats)
 *
 * 권한:
 *   owner: 전체 조회/등록/수정/삭제
 *   staff: 본인 할당 + 전체 공지만 조회, 상태 변경 가능
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/teamTaskRepository');
const { notify, notifyMany, notifyAdmins, getStaffIds } = require('../../services/notificationService');

const router = express.Router();

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

// GET /api/tasks/stats (owner only)
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
    if (!title || !title.trim()) {
      return res.status(400).json({ error: '업무 내용을 입력하세요' });
    }

    const scope = assigneeScope === 'all' ? 'all' : 'specific';
    const assignee = scope === 'all' ? null : (assigneeId ? parseInt(assigneeId, 10) : null);
    if (scope === 'specific' && !assignee) {
      return res.status(400).json({ error: '담당자를 선택하거나 전체 공지로 지정하세요' });
    }

    const created = await repo.createTask({
      title: title.trim(),
      assignee_id: assignee,
      assignee_scope: scope,
      due_date: dueDate ? new Date(dueDate).toISOString() : null,
      priority: priority === 'urgent' ? 'urgent' : 'normal',
      memo: memo?.trim() || null,
      created_by: req.user.id,
    });

    // 알림
    if (assignee && assignee !== req.user.id) {
      await notify({
        recipientId: assignee,
        type: 'task_assigned',
        title: priority === 'urgent' ? '[긴급] 새 업무 지시' : '새 업무 지시',
        body: created.title,
        linkUrl: '/?page=tasks',
        relatedType: 'task',
        relatedId: created.id,
      });
    } else if (scope === 'all') {
      const staffIds = await getStaffIds();
      await notifyMany(staffIds, {
        type: 'task_assigned',
        title: '전체 공지 업무',
        body: created.title,
        linkUrl: '/?page=tasks',
        relatedType: 'task',
        relatedId: created.id,
      });
    }

    res.json({ data: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/tasks/:id — 상태 변경 등
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getTask(id);
    if (!existing) return res.status(404).json({ error: '업무를 찾을 수 없습니다' });

    const isOwner = req.user.isAdmin;
    const isAssignee = existing.assignee_id === req.user.id;
    const isBroadcast = existing.assignee_scope === 'all';
    if (!isOwner && !isAssignee && !isBroadcast) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }

    const { title, assigneeId, assigneeScope, dueDate, priority, memo, status, completionNote } = req.body || {};
    const updates = {};

    if (isOwner) {
      if (title !== undefined) updates.title = title.trim();
      if (assigneeScope !== undefined) updates.assignee_scope = assigneeScope;
      if (assigneeId !== undefined) updates.assignee_id = assigneeId;
      if (dueDate !== undefined) updates.due_date = dueDate ? new Date(dueDate).toISOString() : null;
      if (priority !== undefined) updates.priority = priority;
      if (memo !== undefined) updates.memo = memo?.trim() || null;
    }

    if (status !== undefined && ['pending', 'in_progress', 'done'].includes(status)) {
      updates.status = status;
      if (status === 'done') {
        updates.completed_at = new Date().toISOString();
        if (!isOwner && (!completionNote || !completionNote.trim())) {
          return res.status(400).json({ error: '완료 코멘트를 입력하세요' });
        }
        if (completionNote !== undefined) updates.completion_note = completionNote.trim();
      } else {
        updates.completed_at = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '변경할 내용이 없습니다' });
    }

    const updated = await repo.updateTask(id, updates);

    // 직원이 완료 시 → 사장에게
    if (status === 'done' && !isOwner) {
      await notifyAdmins({
        type: 'task_completed',
        title: `${req.user.displayName} 업무 완료`,
        body: `${existing.title}${updated.completion_note ? ' — ' + updated.completion_note : ''}`,
        linkUrl: '/?page=tasks',
        relatedType: 'task',
        relatedId: id,
      });
    }

    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tasks/:id (owner only)
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
