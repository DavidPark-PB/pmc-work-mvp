/**
 * team_task_comments — 업무 카드 한줄 댓글 + 첨부파일
 *
 * PR T-1.
 *
 * attachments 컬럼 (jsonb): [{file_path, file_name, mime_type, size}] 배열, 0~3개.
 * 실 파일은 'task-attachments' bucket 의 ${taskId}/comments/${ts}-${rand}-${name} 경로.
 *
 * 권한 / 가시성 정책은 route 단에서 처리 (본인 recipient 또는 admin).
 */
'use strict';

const { getClient } = require('./supabaseClient');

const MAX_ATTACHMENTS_PER_COMMENT = 3;

async function listComments({ taskId, limit }) {
  const c = getClient();
  let q = c
    .from('team_task_comments')
    .select('id, task_id, author_id, content, attachments, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });

  if (Number.isFinite(limit) && limit > 0) q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function countByTask(taskId) {
  const { count, error } = await getClient()
    .from('team_task_comments')
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId);
  if (error) throw error;
  return count || 0;
}

async function createComment({ taskId, authorId, content, attachments }) {
  const trimmed = String(content || '').trim();
  if (!trimmed) throw new Error('댓글 내용을 입력하세요');

  const atts = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS_PER_COMMENT) : null;

  const { data, error } = await getClient()
    .from('team_task_comments')
    .insert({
      task_id: taskId,
      author_id: authorId,
      content: trimmed,
      attachments: atts,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  MAX_ATTACHMENTS_PER_COMMENT,
  listComments,
  countByTask,
  createComment,
};
