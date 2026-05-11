/**
 * payroll_periods — 2주 급여 기간 (PR W-G2-B)
 *
 * write 는 Postgres RPC (payroll_finalize_period / cancel / mark_paid) 가 처리.
 * 본 repo 는 read 전용 + 수동 holiday allowance 토글 (RPC 외부 부분 update).
 */
'use strict';

const { getClient } = require('./supabaseClient');

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    paymentDate: row.payment_date,
    status: row.status,
    totalAmount: row.total_amount != null ? Number(row.total_amount) : 0,
    expenseItemId: row.expense_item_id || null,
    confirmedAt: row.confirmed_at || null,
    confirmedBy: row.confirmed_by || null,
    paidAt: row.paid_at || null,
    paidBy: row.paid_by || null,
    cancelledAt: row.cancelled_at || null,
    cancelledBy: row.cancelled_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function list({ limit = 50, status } = {}) {
  let q = getClient().from('payroll_periods').select('*')
    .order('start_date', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(decorate);
}

async function getById(id) {
  const { data, error } = await getClient().from('payroll_periods')
    .select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return decorate(data);
}

/**
 * 마지막 endDate (cancelled 무관) — UI prefill 용 (사장님 짚을 점 5).
 * 다음 startDate = 마지막 endDate + 1.
 */
async function getLastEndDate() {
  const { data, error } = await getClient().from('payroll_periods')
    .select('end_date').order('end_date', { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0]?.end_date || null;
}

module.exports = { list, getById, getLastEndDate };
