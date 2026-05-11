/**
 * cs_responses — CS 답변 기록 (PR CS-G1)
 *
 * 정책 (사장님 spec + 짚을 점):
 *   - soft delete (deleted_at IS NULL 만 활성)
 *   - admin = 전체 / staff = 본인 (created_by) 만
 *   - 의심 케이스 자동 판정 (사장님 짚을 점 4):
 *       (manual_category || detected_category) IN ('fraud_suspect','complaint')
 *       OR suspicious_buyer_id IS NOT NULL
 *     → needs_result_entry = true
 *   - deleted_by = 삭제 실행자, NOT 원 작성자 (사장님 짚을 점 E)
 */
'use strict';

const { getClient } = require('./supabaseClient');

const SUSPICIOUS_CATEGORIES = ['fraud_suspect', 'complaint'];

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerMessage: row.customer_message,
    detectedCategory: row.detected_category || null,
    manualCategory: row.manual_category || null,
    buyerUsername: row.buyer_username || null,
    buyerPlatform: row.buyer_platform || null,
    orderId: row.order_id || null,
    productName: row.product_name || null,
    trackingNumber: row.tracking_number || null,
    selectedTemplateId: row.selected_template_id || null,
    selectedSalesOptions: row.selected_sales_options || [],
    finalResponseText: row.final_response_text || null,
    aiToneAdjusted: !!row.ai_tone_adjusted,
    suspiciousBuyerId: row.suspicious_buyer_id || null,
    resultStatus: row.result_status || null,
    resultEnteredBy: row.result_entered_by || null,
    resultEnteredAt: row.result_entered_at || null,
    needsResultEntry: !!row.needs_result_entry,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

/**
 * 의심 케이스 자동 판정.
 *  manualCategory 가 있으면 그 값, 없으면 detectedCategory 가 fraud_suspect/complaint 인지.
 *  또는 suspiciousBuyerId 가 있으면.
 */
function _isSuspiciousCase({ detectedCategory, manualCategory, suspiciousBuyerId }) {
  const cat = manualCategory || detectedCategory;
  if (cat && SUSPICIOUS_CATEGORIES.includes(cat)) return true;
  if (suspiciousBuyerId != null) return true;
  return false;
}

async function create(values) {
  const needsResultEntry = _isSuspiciousCase({
    detectedCategory: values.detectedCategory,
    manualCategory:   values.manualCategory,
    suspiciousBuyerId: values.suspiciousBuyerId,
  });

  const { data, error } = await getClient().from('cs_responses').insert({
    customer_message:        values.customerMessage,
    detected_category:       values.detectedCategory || null,
    manual_category:         values.manualCategory || null,
    buyer_username:          values.buyerUsername || null,
    buyer_platform:          values.buyerPlatform || null,
    order_id:                values.orderId || null,
    product_name:            values.productName || null,
    tracking_number:         values.trackingNumber || null,
    selected_template_id:    values.selectedTemplateId || null,
    selected_sales_options:  Array.isArray(values.selectedSalesOptionIds) ? values.selectedSalesOptionIds : null,
    final_response_text:     values.finalResponseText || null,
    ai_tone_adjusted:        !!values.aiToneAdjusted,
    suspicious_buyer_id:     values.suspiciousBuyerId || null,
    needs_result_entry:      needsResultEntry,
    created_by:              values.createdBy,
  }).select().single();
  if (error) throw error;
  return decorate(data);
}

async function list({ user, includeDeleted = false, needsResultOnly = false, limit = 100 } = {}) {
  let q = getClient().from('cs_responses')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (!includeDeleted) q = q.is('deleted_at', null);
  if (user && !user.isAdmin) q = q.eq('created_by', user.id);
  if (needsResultOnly) q = q.eq('needs_result_entry', true).is('result_status', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('cs_responses')
    .select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return decorate(data);
}

/**
 * Soft delete. deletedBy = 실행자 user id (NOT 원 작성자 — 사장님 짚을 점 E).
 */
async function softDelete(id, deletedBy) {
  const { error } = await getClient().from('cs_responses').update({
    deleted_at: new Date().toISOString(),
    deleted_by: deletedBy ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}

/**
 * 결과 입력 (그룹 3 활성 — 그룹 1 에선 미사용). resultStatus 7종 화이트리스트.
 */
const VALID_RESULT_STATUS = [
  'converted', 'repurchased', 'positive_review', 'refunded',
  'case_opened', 'confirmed_fraud', 'blocked',
];
async function setResultStatus(id, { resultStatus, enteredBy }) {
  if (!VALID_RESULT_STATUS.includes(resultStatus)) {
    throw new Error('invalid result status');
  }
  const { error } = await getClient().from('cs_responses').update({
    result_status: resultStatus,
    result_entered_by: enteredBy,
    result_entered_at: new Date().toISOString(),
    needs_result_entry: false,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}

module.exports = {
  create, list, getById, softDelete, setResultStatus,
  VALID_RESULT_STATUS, SUSPICIOUS_CATEGORIES,
};
