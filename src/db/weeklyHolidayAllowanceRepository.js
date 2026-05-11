/**
 * weekly_holiday_allowances — 주별 주휴수당 (PR W-G2-B)
 *
 * 사장님 spec:
 *   - 수동 OFF: amount=0 + isExcluded=true + excludeReason + excludedBy + excludedAt 보존 (감사)
 */
'use strict';

const { getClient } = require('./supabaseClient');

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    payrollPeriodId: row.payroll_period_id,
    weekStartDate: row.week_start_date,
    weekEndDate: row.week_end_date,
    totalWorkHours: row.total_work_hours != null ? Number(row.total_work_hours) : 0,
    workDays: row.work_days || 0,
    averageDailyHours: row.average_daily_hours != null ? Number(row.average_daily_hours) : 0,
    hourlyWageUsed: row.hourly_wage_used != null ? Number(row.hourly_wage_used) : 0,
    amount: row.amount != null ? Number(row.amount) : 0,
    isExcluded: !!row.is_excluded,
    excludeReason: row.exclude_reason || null,
    excludedBy: row.excluded_by || null,
    excludedAt: row.excluded_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listByPeriod(periodId) {
  const { data, error } = await getClient().from('weekly_holiday_allowances')
    .select('*').eq('payroll_period_id', periodId)
    .order('employee_id', { ascending: true })
    .order('week_start_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(decorate);
}

async function listByPeriodAndEmployee(periodId, employeeId) {
  const { data, error } = await getClient().from('weekly_holiday_allowances')
    .select('*').eq('payroll_period_id', periodId).eq('employee_id', employeeId)
    .order('week_start_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(decorate);
}

/**
 * 수동 OFF: amount=0 으로 변경 + isExcluded=true + excludeReason 보존.
 * employee_payrolls.holiday_allowance_total / total_wage 는 별도로 재계산해야 함 (호출자 책임).
 */
async function exclude(id, { excludeReason, excludedBy }) {
  const { data, error } = await getClient().from('weekly_holiday_allowances').update({
    amount: 0,
    is_excluded: true,
    exclude_reason: excludeReason || null,
    excluded_by: excludedBy,
    excluded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single();
  if (error) throw error;
  return decorate(data);
}

/**
 * 한 weekly row 의 amount 변경 후, 같은 (period, employee) 의 employee_payrolls 합계 재계산.
 */
async function recalcEmployeePayrollAfterExclude(periodId, employeeId) {
  const c = getClient();
  // 모든 활성 weekly amount 합계 (is_excluded=true 는 amount=0 이라 포함해도 동일)
  const weeks = await listByPeriodAndEmployee(periodId, employeeId);
  const newTotal = weeks.reduce((s, w) => s + (w.amount || 0), 0);

  // 현재 employee_payrolls 의 wage_total + 새 holiday total
  const { data: ep, error: e1 } = await c.from('employee_payrolls')
    .select('id, wage_total')
    .eq('payroll_period_id', periodId)
    .eq('employee_id', employeeId)
    .maybeSingle();
  if (e1) throw e1;
  if (!ep) return;

  const newTotalWage = Number(ep.wage_total || 0) + newTotal;
  const { error: e2 } = await c.from('employee_payrolls').update({
    holiday_allowance_total: Math.round(newTotal * 100) / 100,
    total_wage: Math.round(newTotalWage * 100) / 100,
    updated_at: new Date().toISOString(),
  }).eq('id', ep.id);
  if (e2) throw e2;

  // payroll_periods.total_amount 도 재계산
  const { data: allEps, error: e3 } = await c.from('employee_payrolls')
    .select('total_wage').eq('payroll_period_id', periodId);
  if (e3) throw e3;
  const newGrandTotal = (allEps || []).reduce((s, x) => s + Number(x.total_wage || 0), 0);
  await c.from('payroll_periods').update({
    total_amount: Math.round(newGrandTotal * 100) / 100,
    updated_at: new Date().toISOString(),
  }).eq('id', periodId);

  // 연결된 expense 의 amount 도 갱신 (status='예정' 일 때만)
  const { data: period } = await c.from('payroll_periods')
    .select('expense_item_id, status').eq('id', periodId).maybeSingle();
  if (period?.expense_item_id && period.status === '확정됨') {
    await c.from('expenses').update({
      amount: Math.round(newGrandTotal * 100) / 100,
    }).eq('id', period.expense_item_id);
  }
}

module.exports = {
  listByPeriod, listByPeriodAndEmployee, exclude,
  recalcEmployeePayrollAfterExclude,
};
