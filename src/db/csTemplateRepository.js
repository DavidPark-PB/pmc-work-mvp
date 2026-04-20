/**
 * cs_templates — CS 답변 템플릿 CRUD + 사용 카운트.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = 'CS 템플릿 DB 마이그레이션이 적용되지 않았습니다 (021).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /cs_templates/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    category: row.category,
    body: row.body,
    usageCount: row.usage_count || 0,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function list({ activeOnly = true, language, category } = {}) {
  let q = getClient().from('cs_templates').select('*')
    .order('usage_count', { ascending: false })
    .order('title', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  if (language) q = q.eq('language', language);
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('cs_templates')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function create({ title, language = 'en', category = 'general', body, createdBy }) {
  if (!title?.trim()) throw new Error('제목을 입력하세요');
  if (!body?.trim()) throw new Error('본문을 입력하세요');
  const { data, error } = await getClient().from('cs_templates').insert({
    title: title.trim().slice(0, 200),
    language: String(language).slice(0, 10),
    category: String(category).slice(0, 40),
    body: body.trim(),
    created_by: createdBy || null,
  }).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function update(id, updates) {
  const patch = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) patch.title = String(updates.title).trim().slice(0, 200);
  if (updates.language !== undefined) patch.language = String(updates.language).slice(0, 10);
  if (updates.category !== undefined) patch.category = String(updates.category).slice(0, 40);
  if (updates.body !== undefined) patch.body = String(updates.body).trim();
  if (updates.isActive !== undefined) patch.is_active = !!updates.isActive;
  const { data, error } = await getClient().from('cs_templates')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id) {
  const { error } = await getClient().from('cs_templates').delete().eq('id', id);
  if (error) throwFriendly(error);
}

async function bumpUsage(id) {
  try {
    const cur = await getById(id);
    if (!cur) return;
    await getClient().from('cs_templates').update({
      usage_count: (cur.usageCount || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  } catch { /* 사용 카운트 실패는 조용히 */ }
}

// 플레이스홀더 `{name}` 추출
function extractPlaceholders(body) {
  if (!body) return [];
  const set = new Set();
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) set.add(m[1]);
  return [...set];
}

module.exports = { list, getById, create, update, remove, bumpUsage, extractPlaceholders };
