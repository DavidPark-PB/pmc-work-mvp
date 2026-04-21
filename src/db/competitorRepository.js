/**
 * competitors — 수동 경쟁업체 관리 테이블.
 * 플랫폼별로 쭉 명단 관리. 가격은 추적 안 하고 notes·strengths에 자유 기입.
 */
const { getClient } = require('./supabaseClient');

const MISSING = new Set(['42P01', 'PGRST205']);
const MISSING_MSG = '경쟁업체 DB 마이그레이션이 적용되지 않았습니다 (028).';

function isMissing(err) {
  if (!err) return false;
  if (MISSING.has(err.code)) return true;
  const msg = String(err.message || '');
  return /competitors/i.test(msg) && /not\s+found|does not exist|schema cache/i.test(msg);
}

function throwFriendly(err) {
  if (isMissing(err)) throw new Error(MISSING_MSG);
  throw err;
}

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    storeUrl: row.store_url,
    country: row.country,
    productFocus: row.product_focus,
    strengths: row.strengths,
    weaknesses: row.weaknesses,
    threatLevel: row.threat_level,
    lastCheckedAt: row.last_checked_at,
    tags: Array.isArray(row.tags) ? row.tags : [],
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VALID_THREAT = new Set(['low', 'medium', 'high']);

function sanitize(updates) {
  const row = {};
  if (updates.name !== undefined) row.name = String(updates.name).trim().slice(0, 200);
  if (updates.platform !== undefined) row.platform = String(updates.platform).toLowerCase().slice(0, 40);
  if (updates.storeUrl !== undefined) row.store_url = updates.storeUrl ? String(updates.storeUrl).trim().slice(0, 2000) : null;
  if (updates.country !== undefined) row.country = updates.country ? String(updates.country).trim().slice(0, 40) : null;
  if (updates.productFocus !== undefined) row.product_focus = updates.productFocus ? String(updates.productFocus).trim().slice(0, 200) : null;
  if (updates.strengths !== undefined) row.strengths = updates.strengths ? String(updates.strengths).trim().slice(0, 2000) : null;
  if (updates.weaknesses !== undefined) row.weaknesses = updates.weaknesses ? String(updates.weaknesses).trim().slice(0, 2000) : null;
  if (updates.threatLevel !== undefined) row.threat_level = VALID_THREAT.has(updates.threatLevel) ? updates.threatLevel : 'medium';
  if (updates.lastCheckedAt !== undefined) row.last_checked_at = updates.lastCheckedAt || null;
  if (updates.tags !== undefined) row.tags = Array.isArray(updates.tags) ? updates.tags.slice(0, 20) : [];
  if (updates.notes !== undefined) row.notes = updates.notes ? String(updates.notes).trim().slice(0, 4000) : null;
  return row;
}

async function list({ platform, threatLevel, search, limit = 500 } = {}) {
  let q = getClient().from('competitors').select('*')
    .order('threat_level', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (platform) q = q.eq('platform', platform);
  if (threatLevel) q = q.eq('threat_level', threatLevel);
  if (search) {
    const s = String(search).trim();
    if (s) q = q.or(`name.ilike.%${s}%,product_focus.ilike.%${s}%,notes.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error && isMissing(error)) return [];
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('competitors').select('*').eq('id', id).maybeSingle();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function create(values, createdBy) {
  if (!values.name || !String(values.name).trim()) throw new Error('이름을 입력하세요');
  if (!values.platform) throw new Error('플랫폼을 선택하세요');
  const row = sanitize(values);
  row.created_by = createdBy || null;
  const { data, error } = await getClient().from('competitors').insert(row).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function update(id, updates) {
  const patch = sanitize(updates);
  patch.updated_at = new Date().toISOString();
  const { data, error } = await getClient().from('competitors').update(patch).eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function touchChecked(id) {
  const { data, error } = await getClient().from('competitors')
    .update({ last_checked_at: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throwFriendly(error);
  return decorate(data);
}

async function remove(id) {
  const { error } = await getClient().from('competitors').delete().eq('id', id);
  if (error) throwFriendly(error);
}

async function getStats() {
  const { data, error } = await getClient().from('competitors').select('platform, threat_level');
  if (error && isMissing(error)) return { byPlatform: {}, byThreat: {}, total: 0 };
  if (error) throw error;
  const byPlatform = {};
  const byThreat = { low: 0, medium: 0, high: 0 };
  for (const r of data || []) {
    byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
    if (byThreat[r.threat_level] !== undefined) byThreat[r.threat_level]++;
  }
  return { byPlatform, byThreat, total: (data || []).length };
}

module.exports = { list, getById, create, update, touchChecked, remove, getStats };
