/**
 * purchase_request_attachments — 발주요청 이미지 첨부 메타데이터.
 * 실제 파일은 Supabase Storage 'task-attachments' 버킷.
 * 발주 삭제 시 CASCADE로 row 자동 제거 (파일은 route 핸들러에서 수동 cleanup).
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '발주요청 첨부 DB 마이그레이션이 적용되지 않았습니다 (024).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /purchase_request_attachments/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    uploadedBy: row.uploaded_by,
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

async function list(requestId) {
  const { data, error } = await getClient()
    .from('purchase_request_attachments')
    .select('*')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient()
    .from('purchase_request_attachments')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function create({ requestId, uploadedBy, filePath, fileName, mimeType, sizeBytes, width, height }) {
  const { data, error } = await getClient()
    .from('purchase_request_attachments')
    .insert({
      request_id: requestId,
      uploaded_by: uploadedBy || null,
      file_path: filePath,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      width: width || null,
      height: height || null,
    })
    .select()
    .single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id) {
  const { error } = await getClient()
    .from('purchase_request_attachments')
    .delete()
    .eq('id', id);
  if (error) throwFriendly(error);
}

async function countByRequest(requestId) {
  const { count, error } = await getClient()
    .from('purchase_request_attachments')
    .select('*', { count: 'exact', head: true })
    .eq('request_id', requestId);
  if (error && isMissing(error)) return 0;
  if (error) throw error;
  return count || 0;
}

/** 여러 request_id에 대한 count map 반환 { requestId: count } */
async function listByRequests(requestIds) {
  if (!Array.isArray(requestIds) || requestIds.length === 0) return {};
  const { data, error } = await getClient()
    .from('purchase_request_attachments')
    .select('request_id')
    .in('request_id', requestIds);
  if (error && isMissing(error)) return {};
  if (error) throw error;
  const map = {};
  for (const row of data || []) {
    map[row.request_id] = (map[row.request_id] || 0) + 1;
  }
  return map;
}

module.exports = { list, getById, create, remove, countByRequest, listByRequests };
