/**
 * workspace_todos — 직원 개인 할 일 체크리스트 (본인만 조회/수정).
 * 미완료 먼저, 완료는 뒤로. 완료된 항목도 계속 보여서 하루 진행률 체감 가능.
 */
const { getClient } = require('./supabaseClient');

// PostgreSQL "relation does not exist" + PostgREST "schema cache miss".
// 마이그레이션 012가 적용 안 된 환경에서 raw Supabase 에러가 사용자에게 노출되지 않도록.
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);
const MISSING_TABLE_MSG = '할 일 기능 DB 마이그레이션이 적용되지 않았습니다. 관리자에게 문의하세요.';

function isMissingTable(err) {
  if (!err) return false;
  if (MISSING_TABLE_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return msg.includes('workspace_todos') && /not\s+found|does not exist|schema cache/i.test(msg);
}

async function listTodos(userId) {
  const { data, error } = await getClient()
    .from('workspace_todos')
    .select('*')
    .eq('user_id', userId)
    .order('done', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error && !isMissingTable(error)) throw error;
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
  if (error) {
    if (isMissingTable(error)) throw new Error(MISSING_TABLE_MSG);
    throw error;
  }
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
  if (error) {
    if (isMissingTable(error)) throw new Error(MISSING_TABLE_MSG);
    throw error;
  }
  return data;
}

async function deleteTodo(userId, id) {
  const { error } = await getClient()
    .from('workspace_todos')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    if (isMissingTable(error)) throw new Error(MISSING_TABLE_MSG);
    throw error;
  }
}

async function clearCompleted(userId) {
  const { error } = await getClient()
    .from('workspace_todos')
    .delete()
    .eq('user_id', userId)
    .eq('done', true);
  if (error) {
    if (isMissingTable(error)) throw new Error(MISSING_TABLE_MSG);
    throw error;
  }
}

module.exports = { listTodos, createTodo, updateTodo, deleteTodo, clearCompleted };
