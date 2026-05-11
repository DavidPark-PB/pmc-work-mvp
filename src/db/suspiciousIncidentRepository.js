/**
 * suspicious_incidents — 진상 바이어 사건 기록 (PR CS-G2-B)
 *
 * 정책:
 *   - 사건 등록 = 모든 직원
 *   - soft delete (admin only — route 단)
 *   - deleted_by = 실행자 (NOT 원 작성자)
 */
'use strict';

const { getClient } = require('./supabaseClient');

function decorate(row) {
  if (!row) return null;
  return {
    id:             row.id,
    buyerId:        row.buyer_id,
    date:           row.date || null,
    platform:       row.platform || null,
    orderNumber:    row.order_number || null,
    incidentType:   row.incident_type || null,
    description:    row.description || null,
    amount:         row.amount != null ? Number(row.amount) : null,
    resolution:     row.resolution || null,
    screenshotUrls: row.screenshot_urls || [],
    createdBy:      row.created_by,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
    deletedAt:      row.deleted_at || null,
  };
}

async function create(values) {
  const { data, error } = await getClient().from('suspicious_incidents').insert({
    buyer_id:         values.buyerId,
    date:             values.date || null,
    platform:         values.platform || null,
    order_number:     values.orderNumber || null,
    incident_type:    values.incidentType || null,
    description:      values.description || null,
    amount:           values.amount != null && values.amount !== '' ? Number(values.amount) : null,
    resolution:       values.resolution || null,
    screenshot_urls:  Array.isArray(values.screenshotUrls) ? values.screenshotUrls : null,
    created_by:       values.createdBy,
  }).select().single();
  if (error) throw error;
  return decorate(data);
}

async function listByBuyer(buyerId, { includeDeleted = false } = {}) {
  let q = getClient().from('suspicious_incidents').select('*')
    .eq('buyer_id', buyerId)
    .order('date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (!includeDeleted) q = q.is('deleted_at', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(decorate);
}

async function softDelete(id, deletedBy) {
  const { error } = await getClient().from('suspicious_incidents').update({
    deleted_at: new Date().toISOString(),
    deleted_by: deletedBy ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}

module.exports = { create, listByBuyer, softDelete };
