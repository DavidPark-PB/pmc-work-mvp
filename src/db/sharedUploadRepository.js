/**
 * shared_uploads — 자료실 직접 업로드 파일 메타.
 * Drive 동기화와 분리해서 운영.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '자료실 업로드 DB 마이그레이션이 적용되지 않았습니다 (031).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  return /shared_uploads/i.test(err.message || '') && /not\s+found|does not exist|schema cache/i.test(err.message || '');
}

function decorate(row, now = Date.now()) {
  if (!row) return null;
  const expiresAt = row.expires_at;
  const expMs = expiresAt ? new Date(expiresAt).getTime() : null;
  const daysLeft = expMs ? Math.max(0, Math.ceil((expMs - now) / 86400000)) : null;
  return {
    id: row.id,
    storagePath: row.storage_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    description: row.description || '',
    tags: row.tags || [],
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    expiresAt,
    daysLeft,
    uploaderName: row.uploader_name || null,
  };
}

async function create({ storagePath, originalName, mimeType, sizeBytes, description, tags, userId, expiresAt }) {
  const db = getClient();
  const { data, error } = await db.from('shared_uploads').insert({
    storage_path: String(storagePath).slice(0, 500),
    original_name: String(originalName).slice(0, 300),
    mime_type: mimeType ? String(mimeType).slice(0, 100) : null,
    size_bytes: Number(sizeBytes) || 0,
    description: description ? String(description).slice(0, 2000) : null,
    tags: Array.isArray(tags) ? tags.slice(0, 20) : [],
    uploaded_by: userId || null,
    expires_at: expiresAt,
  }).select().single();
  if (error) {
    if (isMissing(error)) throw new Error(MISSING_MSG);
    throw error;
  }
  return decorate(data);
}

async function listActive({ search, tag, limit = 200 } = {}) {
  const db = getClient();
  let query = db.from('shared_uploads')
    .select('*, users:uploaded_by(name)')
    .gt('expires_at', new Date().toISOString())
    .order('uploaded_at', { ascending: false })
    .limit(limit);
  if (search) {
    const p = `%${String(search).replace(/%/g, '')}%`;
    query = query.or(`original_name.ilike.${p},description.ilike.${p}`);
  }
  if (tag) query = query.contains('tags', [tag]);
  const { data, error } = await query;
  if (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const now = Date.now();
  return (data || []).map(row => ({
    ...decorate(row, now),
    uploaderName: row.users?.name || null,
  }));
}

async function getById(id) {
  const db = getClient();
  const { data, error } = await db.from('shared_uploads').select('*').eq('id', id).maybeSingle();
  if (error) {
    if (isMissing(error)) throw new Error(MISSING_MSG);
    throw error;
  }
  return decorate(data);
}

async function remove(id) {
  const db = getClient();
  const { error } = await db.from('shared_uploads').delete().eq('id', id);
  if (error && !isMissing(error)) throw error;
  return true;
}

async function deleteExpired() {
  const db = getClient();
  const { data, error } = await db.from('shared_uploads')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('id, storage_path');
  if (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return data || [];
}

module.exports = { create, listActive, getById, remove, deleteExpired };
