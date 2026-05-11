/**
 * employee_payrolls — 직원별 정산 (PR W-G2-B)
 * write 는 RPC. 본 repo 는 read 전용.
 */
'use strict';

const { getClient } = require('./supabaseClient');

function decorate(row) {
  if (!row) return null;
  return {
    id: row.id,
    payrollPeriodId: row.payroll_period_id,
    employeeId: row.employee_id,
    totalWorkHours: row.total_work_hours != null ? Number(row.total_work_hours) : 0,
    workDays: row.work_days || 0,
    wageTotal: row.wage_total != null ? Number(row.wage_total) : 0,
    holidayAllowanceTotal: row.holiday_allowance_total != null ? Number(row.holiday_allowance_total) : 0,
    totalWage: row.total_wage != null ? Number(row.total_wage) : 0,
    attendanceRecordIds: row.attendance_record_ids || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listByPeriod(periodId) {
  const { data, error } = await getClient().from('employee_payrolls')
    .select(`
      *,
      employee:users!employee_payrolls_employee_id_fkey ( id, display_name, platform )
    `)
    .eq('payroll_period_id', periodId)
    .order('employee_id', { ascending: true });
  // FK 이름이 schema 에서 자동 생성 안 됐을 수 있으므로 fallback
  if (error && (error.code === 'PGRST200' || /relationship/i.test(error.message))) {
    const { data: data2, error: e2 } = await getClient().from('employee_payrolls')
      .select('*').eq('payroll_period_id', periodId).order('employee_id', { ascending: true });
    if (e2) throw e2;
    return (data2 || []).map(decorate);
  }
  if (error) throw error;
  return (data || []).map(r => ({
    ...decorate(r),
    employeeName: r.employee?.display_name || null,
    employeePlatform: r.employee?.platform || null,
  }));
}

module.exports = { listByPeriod };
