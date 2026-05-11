/**
 * payrollFinalize — 2주 급여 확정 + 취소 + 지급완료 wrapper (PR W-G2-B)
 *
 * 사장님 spec:
 *   - 단일 트랜잭션 (Postgres RPC payroll_finalize_period / payroll_cancel_period / payroll_mark_paid)
 *   - preview 풍부화: 이상 데이터 + 시급 NULL 기록 + 예상 총액 + 직원별 금액 (사장님 짚을 점 10)
 *   - 시급 미등록 직원 skip (사장님 짚을 점 1)
 *   - 잠긴 기록 자동 제외 (045 의 payroll_period_id IS NULL 필터)
 *   - 이상 데이터 무시 옵션 (ignoreAnomalies — route 단 검증)
 *   - 시급 NULL 기록 차단 (사장님 spec — "시급 없는 기록 N건. 먼저 재계산하세요")
 *
 * 의존:
 *   - holidayAllowanceCalc (주별 주휴수당 계산)
 *   - attendanceRepository (재사용 — 045 W-G1 추가 패턴)
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const holidayCalc = require('./holidayAllowanceCalc');

const STATUS_WORK = ['regular', 'late', 'early_leave'];
const STATUS_ZERO_PAY = ['day_off', 'absence'];

class ValidationError extends Error {
  constructor(message, code) { super(message); this.code = code || 'payroll/validation'; }
}

// ──────────────────────────────────────────────────────────────────────────
// 이상 데이터 감지 (PR W-G1 의 frontend 뱃지 룰을 backend 로 옮겨 옴)
// ──────────────────────────────────────────────────────────────────────────
function detectAnomalies(records) {
  const list = [];
  for (const r of records || []) {
    const wh = r.work_hours != null ? Number(r.work_hours) : null;
    if (Number.isFinite(wh) && wh > 12) {
      list.push({ type: 'over_12h', recordId: r.id, employeeId: r.employee_id, date: r.date, value: wh });
    }
    if (r.clock_in && r.clock_out && r.clock_in === r.clock_out) {
      list.push({ type: 'check_in_equals_out', recordId: r.id, employeeId: r.employee_id, date: r.date });
    }
    if (r.clock_in && !r.clock_out && r.status !== 'day_off' && r.status !== 'absence') {
      list.push({ type: 'missing_check_out', recordId: r.id, employeeId: r.employee_id, date: r.date });
    }
  }
  return list;
}

// ──────────────────────────────────────────────────────────────────────────
// 시급 미등록 (snapshot NULL/0) 기록 식별
// ──────────────────────────────────────────────────────────────────────────
function detectNullSnapshots(records) {
  const list = [];
  for (const r of records || []) {
    if (STATUS_ZERO_PAY.includes(r.status)) continue;  // 휴무/결근은 0원 정상
    const snap = r.hourly_rate_snapshot != null ? Number(r.hourly_rate_snapshot) : NaN;
    if (!Number.isFinite(snap) || snap <= 0) {
      list.push({ recordId: r.id, employeeId: r.employee_id, date: r.date });
    }
  }
  return list;
}

// ──────────────────────────────────────────────────────────────────────────
// 직원별 정산 (employee_payrolls 후보)
// ──────────────────────────────────────────────────────────────────────────
function buildEmployeePayrolls(records, weeklyByEmployee) {
  // 직원별 grouping
  const byEmp = new Map();
  for (const r of records) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push(r);
  }

  const out = [];
  for (const [empId, recs] of byEmp.entries()) {
    let totalWorkHours = 0;
    let workDays = 0;
    let wageTotal = 0;
    const recordIds = [];
    for (const r of recs) {
      recordIds.push(r.id);
      if (STATUS_WORK.includes(r.status)) {
        workDays++;
        const wh = r.work_hours != null ? Number(r.work_hours) : 0;
        const dp = r.daily_pay != null ? Number(r.daily_pay) : 0;
        if (Number.isFinite(wh)) totalWorkHours += wh;
        if (Number.isFinite(dp)) wageTotal += dp;
      }
    }
    const weeks = weeklyByEmployee.get(empId) || [];
    const holidayAllowanceTotal = weeks.reduce((s, w) => s + (w.amount || 0), 0);

    out.push({
      employee_id: empId,
      total_work_hours: Math.round(totalWorkHours * 100) / 100,
      work_days: workDays,
      wage_total: Math.round(wageTotal * 100) / 100,
      holiday_allowance_total: Math.round(holidayAllowanceTotal * 100) / 100,
      total_wage: Math.round((wageTotal + holidayAllowanceTotal) * 100) / 100,
      attendance_record_ids: recordIds,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 주휴수당 계산 (직원별 → 주별)
// ──────────────────────────────────────────────────────────────────────────
function buildWeeklyAllowances(records) {
  // 직원별 grouping
  const byEmp = new Map();
  for (const r of records) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push(r);
  }

  const allWeeks = [];
  const weeklyByEmployee = new Map();  // employee_id → [week...]

  for (const [empId, recs] of byEmp.entries()) {
    const weeks = holidayCalc.calcAllWeeksForEmployee(recs);
    weeklyByEmployee.set(empId, weeks);
    for (const w of weeks) {
      allWeeks.push({
        employee_id: empId,
        week_start_date: w.weekStartDate,
        week_end_date: w.weekEndDate,
        total_work_hours: w.totalWorkHours,
        work_days: w.workDays,
        average_daily_hours: w.averageDailyHours,
        hourly_wage_used: w.hourlyWageUsed,
        amount: w.amount,
      });
    }
  }
  return { weeklyAllowances: allWeeks, weeklyByEmployee };
}

// ──────────────────────────────────────────────────────────────────────────
// 미리보기 (사장님 짚을 점 10 — 풍부화)
// ──────────────────────────────────────────────────────────────────────────
async function preview({ startDate, endDate }) {
  if (!startDate || !endDate) {
    throw new ValidationError('startDate / endDate 필수');
  }
  const c = getClient();
  // 잠긴 기록 자동 제외 (045 — payroll_period_id IS NULL)
  const { data: records, error } = await c
    .from('attendance')
    .select(`
      id, employee_id, date, clock_in, clock_out, work_hours,
      hourly_rate_snapshot, daily_pay, status,
      employee:users!attendance_employee_id_users_id_fk ( id, display_name )
    `)
    .gte('date', startDate)
    .lte('date', endDate)
    .is('payroll_period_id', null)
    .order('date', { ascending: true });
  if (error) throw error;

  const recs = records || [];
  const anomalies = detectAnomalies(recs);
  const nullSnapshots = detectNullSnapshots(recs);

  const { weeklyAllowances, weeklyByEmployee } = buildWeeklyAllowances(recs);
  const employeePayrolls = buildEmployeePayrolls(recs, weeklyByEmployee);

  // 직원 이름 보강
  const empNames = new Map();
  for (const r of recs) {
    if (r.employee?.id) empNames.set(r.employee.id, r.employee.display_name);
  }
  const perEmployee = employeePayrolls.map(ep => ({
    ...ep,
    employee_name: empNames.get(ep.employee_id) || `#${ep.employee_id}`,
  }));

  const totalAmount = perEmployee.reduce((s, ep) => s + (ep.total_wage || 0), 0);

  return {
    startDate,
    endDate,
    recordCount: recs.length,
    anomalies,           // 12h / 출=퇴 / 퇴근 미입력
    nullSnapshots,       // 시급 NULL 기록
    perEmployee,
    weeklyAllowances,    // 주별 주휴수당
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 확정 (Postgres RPC 호출 — 단일 트랜잭션)
// ──────────────────────────────────────────────────────────────────────────
async function confirm({ startDate, endDate, paymentDate, executedBy, ignoreAnomalies }) {
  const prev = await preview({ startDate, endDate });

  // 시급 NULL 기록 차단 (사장님 spec — "시급 없는 기록 N건. 먼저 재계산하세요")
  if (prev.nullSnapshots.length > 0) {
    throw new ValidationError(
      `시급 미등록 기록 ${prev.nullSnapshots.length}건이 있습니다. "🔄 시급 없는 기록 재계산" 을 먼저 실행하세요.`,
      'payroll/null_snapshots'
    );
  }
  // 이상 데이터 — ignoreAnomalies 면 통과
  if (!ignoreAnomalies && prev.anomalies.length > 0) {
    const err = new ValidationError(
      `이상 데이터 ${prev.anomalies.length}건이 있습니다. 확인 후 ignoreAnomalies=true 로 다시 호출하세요.`,
      'payroll/anomalies'
    );
    err.anomalies = prev.anomalies;
    throw err;
  }

  // RPC 호출 — 단일 트랜잭션
  const employeePayrolls = prev.perEmployee.map(({ employee_name, ...rest }) => rest);
  const allAttendanceIds = prev.perEmployee
    .flatMap(ep => ep.attendance_record_ids || [])
    .filter(Number.isFinite);

  const c = getClient();
  const { data, error } = await c.rpc('payroll_finalize_period', {
    p_start_date:        startDate,
    p_end_date:          endDate,
    p_payment_date:      paymentDate,
    p_executed_by:       executedBy,
    p_total_amount:      prev.totalAmount,
    p_employee_payrolls: employeePayrolls,
    p_weekly_allowances: prev.weeklyAllowances,
    p_attendance_ids:    allAttendanceIds,
  });
  if (error) throw error;

  return { periodId: data, totalAmount: prev.totalAmount };
}

async function cancel({ periodId, executedBy }) {
  const c = getClient();
  const { error } = await c.rpc('payroll_cancel_period', {
    p_period_id:   periodId,
    p_executed_by: executedBy,
  });
  if (error) throw error;
}

async function markPaid({ periodId, executedBy }) {
  const c = getClient();
  const { error } = await c.rpc('payroll_mark_paid', {
    p_period_id:   periodId,
    p_executed_by: executedBy,
  });
  if (error) throw error;
}

module.exports = {
  preview, confirm, cancel, markPaid,
  detectAnomalies, detectNullSnapshots,
  ValidationError,
};
