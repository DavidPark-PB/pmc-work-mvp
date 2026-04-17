/**
 * workspace_todos — 직원 개인 할 일 체크리스트 (본인만 조회/수정).
 * 미완료 먼저, 완료는 뒤로. 완료된 항목도 계속 보여서 하루 진행률 체감 가능.
 */
const { getClient } = require('./supabaseClient');

async function listTodos(userId) {
  const { data, error } = await getClient()
    .from('workspace_todos')
    .select('*')
    .eq('user_id', userId)
    .order('done', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  // 테이블 없으면 (마이그레이션 미실행) graceful fallback
  if (error && error.code !== '42P01') throw error;
  return data || [];
}

async function createTodo(userId, { text, dueDate = null }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('할 일 내용을 입력하세요');
  const { data, error } = await getClient()
    .from('workspace_todos')
    .insert({
      user_id: userId,
      text: trimmed.slice(0, 500),
      due_date: dueDate || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateTodo(userId, id, updates) {
  const patch = { updated_at: new Date().toISOString() };
  if (updates.text !== undefined) {
    const t = String(updates.text || '').trim();
    if (!t) throw new Error('할 일 내용이 비어있습니다');
    patch.text = t.slice(0, 500);
  }
  if (updates.done !== undefined) {
    patch.done = !!updates.done;
    patch.done_at = patch.done ? new Date().toISOString() : null;
  }
  if (updates.dueDate !== undefined) patch.due_date = updates.dueDate || null;
  if (updates.sortOrder !== undefined) patch.sort_order = parseInt(updates.sortOrder, 10) || 0;

  const { data, error } = await getClient()
    .from('workspace_todos')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteTodo(userId, id) {
  const { error } = await getClient()
    .from('workspace_todos')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
}

async function clearCompleted(userId) {
  const { error } = await getClient()
    .from('workspace_todos')
    .delete()
    .eq('user_id', userId)
    .eq('done', true);
  if (error) throw error;
}

module.exports = { listTodos, createTodo, updateTodo, deleteTodo, clearCompleted };
