/**
 * workspace_notes — 본인 전용 (다른 직원 열람 불가)
 * 모든 함수는 userId를 받아서 본인 것만 다룸
 */
const { getClient } = require('./supabaseClient');

async function listNotes(userId, { tag, search } = {}) {
  let q = getClient()
    .from('workspace_notes')
    .select('*')
    .eq('user_id', userId);
  if (tag) q = q.eq('tag', tag);
  if (search) q = q.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
  const { data, error } = await q
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getNote(userId, id) {
  const { data, error } = await getClient()
    .from('workspace_notes')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createNote(userId, { title, content, tag, pinned }) {
  const { data, error } = await getClient()
    .from('workspace_notes')
    .insert({
      user_id: userId,
      title: title?.trim() || null,
      content: content?.trim() || null,
      tag: tag?.trim() || null,
      pinned: !!pinned,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateNote(userId, id, updates) {
  const payload = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) payload.title = updates.title?.trim() || null;
  if (updates.content !== undefined) payload.content = updates.content?.trim() || null;
  if (updates.tag !== undefined) payload.tag = updates.tag?.trim() || null;
  if (updates.pinned !== undefined) payload.pinned = !!updates.pinned;

  const { data, error } = await getClient()
    .from('workspace_notes')
    .update(payload)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteNote(userId, id) {
  const { error } = await getClient()
    .from('workspace_notes')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
}

async function listTags(userId) {
  const { data, error } = await getClient()
    .from('workspace_notes')
    .select('tag')
    .eq('user_id', userId)
    .not('tag', 'is', null)
    .neq('tag', '');
  if (error) throw error;
  const set = new Set((data || []).map(r => r.tag).filter(Boolean));
  return [...set].sort();
}

module.exports = { listNotes, getNote, createNote, updateNote, deleteNote, listTags };
