/**
 * resource_folders + resources — 구글 드라이브 동기화 자료실.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '자료실 DB 마이그레이션이 적용되지 않았습니다 (022).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /(resource_folders|resources)/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorateFolder(r) {
  if (!r) return null;
  return {
    id: r.id,
    driveFolderId: r.drive_folder_id,
    name: r.name,
    description: r.description,
    tags: Array.isArray(r.tags) ? r.tags : [],
    lastSyncedAt: r.last_synced_at,
    lastSyncFileCount: r.last_sync_file_count,
    active: r.active,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function decorateResource(r) {
  if (!r) return null;
  return {
    id: r.id,
    folderId: r.folder_id,
    driveFileId: r.drive_file_id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes ? Number(r.size_bytes) : null,
    webViewLink: r.web_view_link,
    modifiedAt: r.modified_at,
    tags: Array.isArray(r.tags) ? r.tags : [],
    deleted: r.deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── 폴더 CRUD ──
async function listFolders({ activeOnly = false } = {}) {
  let q = getClient().from('resource_folders').select('*').order('created_at', { ascending: false });
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorateFolder);
}

async function getFolder(id) {
  const { data, error } = await getClient().from('resource_folders')
    .select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorateFolder(data);
}

async function createFolder({ driveFolderId, name, description, tags = [], createdBy }) {
  if (!driveFolderId?.trim()) throw new Error('Drive 폴더 ID를 입력하세요');
  if (!name?.trim()) throw new Error('이름을 입력하세요');
  const { data, error } = await getClient().from('resource_folders').insert({
    drive_folder_id: driveFolderId.trim(),
    name: name.trim().slice(0, 200),
    description: description || null,
    tags: Array.isArray(tags) ? tags : [],
    created_by: createdBy || null,
  }).select().single();
  if (error) throwFriendly(error);
  return decorateFolder(data);
}

async function updateFolder(id, updates) {
  const patch = {};
  if (updates.name !== undefined) patch.name = String(updates.name).trim().slice(0, 200);
  if (updates.description !== undefined) patch.description = updates.description || null;
  if (updates.tags !== undefined) patch.tags = Array.isArray(updates.tags) ? updates.tags : [];
  if (updates.active !== undefined) patch.active = !!updates.active;
  const { data, error } = await getClient().from('resource_folders')
    .update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorateFolder(data);
}

async function deleteFolder(id) {
  const { error } = await getClient().from('resource_folders').delete().eq('id', id);
  if (error) throwFriendly(error);
}

async function recordSync(id, fileCount) {
  await getClient().from('resource_folders').update({
    last_synced_at: new Date().toISOString(),
    last_sync_file_count: fileCount,
  }).eq('id', id);
}

// ── 파일 CRUD ──
async function listResources({ folderId, search, tag, limit = 500 } = {}) {
  let q = getClient().from('resources')
    .select('*, folder:resource_folders(id, name, tags)')
    .eq('deleted', false)
    .order('modified_at', { ascending: false })
    .limit(limit);
  if (folderId) q = q.eq('folder_id', folderId);
  if (search) q = q.ilike('file_name', `%${search}%`);
  if (tag) q = q.contains('tags', JSON.stringify([tag]));
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(r => ({
    ...decorateResource(r),
    folderName: r.folder?.name || null,
    folderTags: Array.isArray(r.folder?.tags) ? r.folder.tags : [],
  }));
}

async function upsertResources(folderId, files) {
  if (!files?.length) return { inserted: 0, updated: 0 };
  const rows = files.map(f => ({
    folder_id: folderId,
    drive_file_id: f.id,
    file_name: f.name,
    mime_type: f.mimeType || null,
    size_bytes: f.size ? parseInt(f.size, 10) : null,
    web_view_link: f.webViewLink || null,
    modified_at: f.modifiedTime || null,
    deleted: false,
    updated_at: new Date().toISOString(),
  }));
  const { data, error } = await getClient().from('resources')
    .upsert(rows, { onConflict: 'folder_id,drive_file_id' })
    .select('id');
  if (error) throwFriendly(error);
  return { upserted: (data || []).length };
}

/** Drive에 없는 기존 행은 deleted=true로 soft-delete */
async function markMissingAsDeleted(folderId, presentDriveIds) {
  if (!presentDriveIds?.length) {
    // Drive가 비었으면 이 폴더 전체 deleted=true
    await getClient().from('resources').update({ deleted: true })
      .eq('folder_id', folderId).eq('deleted', false);
    return;
  }
  const { data, error } = await getClient().from('resources')
    .select('id, drive_file_id')
    .eq('folder_id', folderId).eq('deleted', false);
  if (error) { if (isMissing(error)) return; throw error; }
  const toDelete = (data || []).filter(r => !presentDriveIds.includes(r.drive_file_id)).map(r => r.id);
  if (toDelete.length > 0) {
    await getClient().from('resources').update({ deleted: true }).in('id', toDelete);
  }
}

async function updateResourceTags(id, tags) {
  const arr = Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : [];
  const { data, error } = await getClient().from('resources')
    .update({ tags: arr, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorateResource(data);
}

/** 검색/필터용 — 등록된 모든 태그 */
async function listAllTags() {
  const [foldersRes, resourcesRes] = await Promise.all([
    getClient().from('resource_folders').select('tags'),
    getClient().from('resources').select('tags').eq('deleted', false),
  ]);
  const all = new Set();
  for (const r of foldersRes.data || []) {
    for (const t of r.tags || []) all.add(t);
  }
  for (const r of resourcesRes.data || []) {
    for (const t of r.tags || []) all.add(t);
  }
  return [...all].sort();
}

module.exports = {
  listFolders, getFolder, createFolder, updateFolder, deleteFolder, recordSync,
  listResources, upsertResources, markMissingAsDeleted, updateResourceTags,
  listAllTags,
};
