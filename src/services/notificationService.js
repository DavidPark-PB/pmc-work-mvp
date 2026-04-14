/**
 * 알림 서비스 — notifications 테이블에 인앱 알림 생성
 *
 * 모든 함수 fire-and-forget 스타일 (await 가능하지만 실패해도 원 작업에 지장 없음).
 */
const { getClient } = require('../db/supabaseClient');

/** 단일 알림 생성 */
async function notify({ recipientId, type, title, body, linkUrl, relatedType, relatedId }) {
  if (!recipientId) return null;
  const { data, error } = await getClient()
    .from('notifications')
    .insert({
      recipient_id: recipientId,
      type,
      title,
      body: body || null,
      link_url: linkUrl || null,
      related_type: relatedType || null,
      related_id: relatedId || null,
    })
    .select()
    .single();
  if (error) {
    console.error('[notify]', type, error.message);
    return null;
  }
  return data;
}

/** 여러 수신자에게 동일 알림 대량 생성 */
async function notifyMany(recipientIds, payload) {
  if (!recipientIds || recipientIds.length === 0) return;
  const rows = recipientIds.map(rid => ({
    recipient_id: rid,
    type: payload.type,
    title: payload.title,
    body: payload.body || null,
    link_url: payload.linkUrl || null,
    related_type: payload.relatedType || null,
    related_id: payload.relatedId || null,
  }));
  const { error } = await getClient().from('notifications').insert(rows);
  if (error) console.error('[notifyMany]', payload.type, error.message);
}

/** 모든 활성 admin 유저 id 조회 */
async function getAdminIds() {
  const { data, error } = await getClient()
    .from('users')
    .select('id')
    .eq('role', 'admin')
    .eq('is_active', true);
  if (error) { console.error('[getAdminIds]', error.message); return []; }
  return (data || []).map(u => u.id);
}

/** 모든 활성 staff 유저 id 조회 */
async function getStaffIds() {
  const { data, error } = await getClient()
    .from('users')
    .select('id')
    .eq('role', 'staff')
    .eq('is_active', true);
  if (error) { console.error('[getStaffIds]', error.message); return []; }
  return (data || []).map(u => u.id);
}

async function notifyAdmins(payload) {
  const ids = await getAdminIds();
  return notifyMany(ids, payload);
}

module.exports = { notify, notifyMany, notifyAdmins, getAdminIds, getStaffIds };
