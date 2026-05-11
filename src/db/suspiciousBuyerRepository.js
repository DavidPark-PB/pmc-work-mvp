/**
 * suspicious_buyers — 진상/사기 바이어 DB (PR CS-G2-B)
 *
 * 정책:
 *   - 외부 공유 안전선: shape helper 2개 분리 (internal vs public)
 *     · internalShape: admin / 내부 직원 응답. 모든 필드.
 *     · publicShape:   외부 (그룹 3 의 public-view API). 실명/이메일/전화/주소/플랫폼ID/evidenceUrls 절대 미포함.
 *   - soft delete (deleted_at IS NULL 만 활성)
 *   - admin only 수정 필드 (route 레벨에서 enforce):
 *     suspicion_level / anonymized_id / country / region / is_public_shareable
 *     / is_blocked_on_* (6개) / is_verified_by_admin
 *
 * 사장님 짚을 점:
 *   - deleted_by = 삭제 실행자 (NOT 원 신고자; that is reported_by)
 */
'use strict';

const { getClient } = require('./supabaseClient');

// ── shape helpers (외부 공유 안전선 — 사장님 spec) ──

/** 내부용 (admin/staff). 모든 필드. */
function internalShape(row) {
  if (!row) return null;
  return {
    id:                       row.id,
    realName:                 row.real_name || null,
    email:                    row.email || null,
    phone:                    row.phone || null,
    address:                  row.address || null,
    platformIds:              row.platform_ids || null,
    anonymizedId:             row.anonymized_id || null,
    country:                  row.country || null,
    region:                   row.region || null,
    suspicionLevel:           row.suspicion_level,
    incidentTypes:            row.incident_types || [],
    patternDescription:       row.pattern_description || null,
    redFlags:                 row.red_flags || [],
    evidenceUrls:             row.evidence_urls || [],
    notes:                    row.notes || null,
    reportedBy:               row.reported_by,
    isVerifiedByAdmin:        !!row.is_verified_by_admin,
    communityVoteCount:       row.community_vote_count || 0,
    isPublicShareable:        !!row.is_public_shareable,
    isBlockedOnEbay:          !!row.is_blocked_on_ebay,
    isBlockedOnShopify:       !!row.is_blocked_on_shopify,
    isBlockedOnQoo10:         !!row.is_blocked_on_qoo10,
    isBlockedOnCoupang:       !!row.is_blocked_on_coupang,
    isBlockedOnSmartstore:    !!row.is_blocked_on_smartstore,
    isBlockedOnAlibaba:       !!row.is_blocked_on_alibaba,
    createdAt:                row.created_at,
    updatedAt:                row.updated_at,
    deletedAt:                row.deleted_at || null,
  };
}

/**
 * 공개용 (그룹 3 의 public-view API + 마케팅 에이전트).
 * 절대 미포함: realName, email, phone, address, platformIds, evidenceUrls, notes, reportedBy, deleted*
 */
function publicShape(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    anonymizedId:        row.anonymized_id || null,
    country:             row.country || null,
    region:              row.region || null,
    suspicionLevel:      row.suspicion_level,
    incidentTypes:       row.incident_types || [],
    patternDescription:  row.pattern_description || null,
    redFlags:            row.red_flags || [],
    isPublicShareable:   !!row.is_public_shareable,
    createdAt:           row.created_at,
  };
}

// ── CRUD ──

const ALLOWED_LEVELS = ['의심', '주의', '블랙리스트'];

async function create(values) {
  const level = ALLOWED_LEVELS.includes(values.suspicionLevel) ? values.suspicionLevel : '의심';
  const { data, error } = await getClient().from('suspicious_buyers').insert({
    real_name:                values.realName || null,
    email:                    values.email || null,
    phone:                    values.phone || null,
    address:                  values.address || null,
    platform_ids:             values.platformIds || null,
    anonymized_id:            values.anonymizedId || null,
    country:                  values.country || null,
    region:                   values.region || null,
    suspicion_level:          level,
    incident_types:           Array.isArray(values.incidentTypes) ? values.incidentTypes : null,
    pattern_description:      values.patternDescription || null,
    red_flags:                Array.isArray(values.redFlags) ? values.redFlags : null,
    evidence_urls:            Array.isArray(values.evidenceUrls) ? values.evidenceUrls : null,
    notes:                    values.notes || null,
    reported_by:              values.reportedBy,
    is_verified_by_admin:     !!values.isVerifiedByAdmin,
    is_public_shareable:      !!values.isPublicShareable,
  }).select().single();
  if (error) throw error;
  return internalShape(data);
}

async function list({ includeDeleted = false, suspicionLevel, q, limit = 100 } = {}) {
  let query = getClient().from('suspicious_buyers').select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (!includeDeleted) query = query.is('deleted_at', null);
  if (suspicionLevel) query = query.eq('suspicion_level', suspicionLevel);
  const { data, error } = await query;
  if (error) throw error;
  let rows = (data || []).map(internalShape);
  if (q) {
    const ql = String(q).toLowerCase().trim();
    if (ql) {
      rows = rows.filter(r =>
        (r.realName || '').toLowerCase().includes(ql) ||
        (r.email || '').toLowerCase().includes(ql) ||
        (r.anonymizedId || '').toLowerCase().includes(ql) ||
        (r.country || '').toLowerCase().includes(ql) ||
        JSON.stringify(r.platformIds || {}).toLowerCase().includes(ql)
      );
    }
  }
  return rows;
}

async function getById(id, { includeDeleted = false } = {}) {
  const { data, error } = await getClient().from('suspicious_buyers')
    .select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (!includeDeleted && data.deleted_at) return null;
  return internalShape(data);
}

/**
 * Patch.
 *
 * adminOnlyFieldsBlocked = false 면 모든 필드 허용 (admin route).
 * adminOnlyFieldsBlocked = true 면 admin only 필드 제외 (staff route).
 */
const ADMIN_ONLY_FIELDS = new Set([
  'suspicion_level', 'anonymized_id', 'country', 'region', 'is_public_shareable',
  'is_verified_by_admin',
  'is_blocked_on_ebay', 'is_blocked_on_shopify', 'is_blocked_on_qoo10',
  'is_blocked_on_coupang', 'is_blocked_on_smartstore', 'is_blocked_on_alibaba',
]);

function _normalizePatch(updates, { adminOnlyFieldsBlocked }) {
  const patch = { updated_at: new Date().toISOString() };
  const map = {
    realName: 'real_name', email: 'email', phone: 'phone', address: 'address',
    platformIds: 'platform_ids',
    anonymizedId: 'anonymized_id', country: 'country', region: 'region',
    suspicionLevel: 'suspicion_level',
    incidentTypes: 'incident_types',
    patternDescription: 'pattern_description',
    redFlags: 'red_flags',
    evidenceUrls: 'evidence_urls',
    notes: 'notes',
    isVerifiedByAdmin: 'is_verified_by_admin',
    isPublicShareable: 'is_public_shareable',
    isBlockedOnEbay: 'is_blocked_on_ebay',
    isBlockedOnShopify: 'is_blocked_on_shopify',
    isBlockedOnQoo10: 'is_blocked_on_qoo10',
    isBlockedOnCoupang: 'is_blocked_on_coupang',
    isBlockedOnSmartstore: 'is_blocked_on_smartstore',
    isBlockedOnAlibaba: 'is_blocked_on_alibaba',
  };
  const blocked = [];
  for (const [k, v] of Object.entries(updates || {})) {
    const dbCol = map[k];
    if (!dbCol) continue;
    if (adminOnlyFieldsBlocked && ADMIN_ONLY_FIELDS.has(dbCol)) {
      blocked.push(k);
      continue;
    }
    if (dbCol === 'suspicion_level' && v && !ALLOWED_LEVELS.includes(v)) continue;
    patch[dbCol] = v;
  }
  return { patch, blocked };
}

async function update(id, updates, { adminOnlyFieldsBlocked = false } = {}) {
  const { patch, blocked } = _normalizePatch(updates, { adminOnlyFieldsBlocked });
  if (blocked.length > 0) {
    const e = new Error('admin 전용 필드 수정 권한 없음: ' + blocked.join(', '));
    e.code = 'forbidden_fields';
    throw e;
  }
  if (Object.keys(patch).length <= 1) {
    return getById(id); // updated_at only — no-op
  }
  const { data, error } = await getClient().from('suspicious_buyers')
    .update(patch).eq('id', id).select().single();
  if (error) throw error;
  return internalShape(data);
}

/** Soft delete (admin only — route 단에서 enforce). deletedBy = 실행자. */
async function softDelete(id, deletedBy) {
  const { error } = await getClient().from('suspicious_buyers').update({
    deleted_at: new Date().toISOString(),
    deleted_by: deletedBy ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}

/**
 * 매칭 query (suspiciousBuyerMatcher 가 사용).
 *
 * @param {Object} criteria — { email, platformIds: { ebay, shopify, ... }, name }
 * @returns {Promise<Array>} active rows (internal shape)
 */
async function findMatches(criteria) {
  const c = getClient();
  const found = new Map();

  // 1) email 정확 매칭 (lower)
  if (criteria.email) {
    const eml = String(criteria.email).toLowerCase();
    const { data, error } = await c.from('suspicious_buyers')
      .select('*').is('deleted_at', null).ilike('email', eml).limit(20);
    if (!error) for (const r of data || []) found.set(r.id, r);
  }

  // 2) platform_ids 매칭 (jsonb @>)
  if (criteria.platformIds && typeof criteria.platformIds === 'object') {
    for (const [platform, pid] of Object.entries(criteria.platformIds)) {
      if (!pid) continue;
      const filter = { [platform]: String(pid) };
      const { data, error } = await c.from('suspicious_buyers')
        .select('*').is('deleted_at', null).contains('platform_ids', filter).limit(20);
      if (!error) for (const r of data || []) found.set(r.id, r);
    }
  }

  // 3) real_name 부분 매칭 (lower) — 정확하지 않으니 길이 ≥3 만
  if (criteria.name && String(criteria.name).trim().length >= 3) {
    const nm = String(criteria.name).toLowerCase().trim();
    const { data, error } = await c.from('suspicious_buyers')
      .select('*').is('deleted_at', null).ilike('real_name', `%${nm}%`).limit(20);
    if (!error) for (const r of data || []) found.set(r.id, r);
  }

  return Array.from(found.values()).map(internalShape);
}

module.exports = {
  internalShape, publicShape,
  create, list, getById, update, softDelete, findMatches,
  ALLOWED_LEVELS, ADMIN_ONLY_FIELDS,
};
