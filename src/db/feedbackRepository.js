/**
 * feedback 테이블 — 피드백 게시판 (스레드 + 고정)
 * ccorea-auto Phase 4 마이그레이션으로 재설계된 구조 그대로 사용:
 *   id, author_id, title, content, parent_id (self FK), is_pinned, created_at
 */
const { getClient } = require('./supabaseClient');

/** 원글 목록 (pinned 먼저 → 최신순) + 답글 수 */
async function listPosts() {
  // Supabase raw SQL via rpc is complex; use client-side aggregation.
  const c = getClient();
  const [postsRes, repliesRes, usersRes] = await Promise.all([
    c.from('feedback').select('*').is('parent_id', null),
    c.from('feedback').select('parent_id').not('parent_id', 'is', null),
    c.from('users').select('id, display_name, role'),
  ]);
  if (postsRes.error) throw postsRes.error;
  if (repliesRes.error) throw repliesRes.error;
  if (usersRes.error) throw usersRes.error;

  const userMap = new Map((usersRes.data || []).map(u => [u.id, u]));
  const replyCount = new Map();
  for (const r of repliesRes.data || []) {
    replyCount.set(r.parent_id, (replyCount.get(r.parent_id) || 0) + 1);
  }

  const posts = (postsRes.data || []).map(p => ({
    id: p.id,
    title: p.title,
    content: p.content,
    isPinned: p.is_pinned,
    createdAt: p.created_at,
    authorId: p.author_id,
    authorName: userMap.get(p.author_id)?.display_name || '-',
    authorRole: userMap.get(p.author_id)?.role || 'staff',
    replyCount: replyCount.get(p.id) || 0,
  }));

  return posts.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

/** 원글 + 답글들 */
async function getPostWithReplies(id) {
  const c = getClient();
  const [postRes, repliesRes, usersRes] = await Promise.all([
    c.from('feedback').select('*').eq('id', id).maybeSingle(),
    c.from('feedback').select('*').eq('parent_id', id).order('created_at', { ascending: true }),
    c.from('users').select('id, display_name, role'),
  ]);
  if (postRes.error) throw postRes.error;
  if (repliesRes.error) throw repliesRes.error;
  if (usersRes.error) throw usersRes.error;

  const post = postRes.data;
  if (!post || post.parent_id) return null; // 원글만
  const userMap = new Map((usersRes.data || []).map(u => [u.id, u]));
  const decorate = r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    parentId: r.parent_id,
    isPinned: r.is_pinned,
    createdAt: r.created_at,
    authorId: r.author_id,
    authorName: userMap.get(r.author_id)?.display_name || '-',
    authorRole: userMap.get(r.author_id)?.role || 'staff',
  });
  return {
    post: decorate(post),
    replies: (repliesRes.data || []).map(decorate),
  };
}

async function getById(id) {
  const { data, error } = await getClient().from('feedback').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function createPost({ authorId, title, content, parentId }) {
  const { data, error } = await getClient().from('feedback').insert({
    author_id: authorId,
    title: title || null,
    content,
    parent_id: parentId || null,
    is_pinned: false,
  }).select().single();
  if (error) throw error;
  return data;
}

async function updatePost(id, { title, content }) {
  const updates = {};
  if (title !== undefined) updates.title = title;
  if (content !== undefined) updates.content = content;
  if (Object.keys(updates).length === 0) return null;
  const { data, error } = await getClient()
    .from('feedback')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function togglePin(id, nextValue) {
  const { data, error } = await getClient().from('feedback').update({ is_pinned: nextValue }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function deletePost(id) {
  // FK CASCADE로 답글 함께 삭제됨
  const { error } = await getClient().from('feedback').delete().eq('id', id);
  if (error) throw error;
}

module.exports = { listPosts, getPostWithReplies, getById, createPost, updatePost, togglePin, deletePost };
