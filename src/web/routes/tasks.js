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
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/teamTaskRepository');
const { notify, notifyMany, notifyAdmins, getStaffIds } = require('../../services/notificationService');
const sseHub = require('../../services/sseHub');

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
