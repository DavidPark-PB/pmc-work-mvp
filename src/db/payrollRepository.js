/**
 * 급여 집계 + Shopee 보너스 관리
 */
const { getClient } = require('./supabaseClient');
const holidayCalc = require('../services/payroll/holidayAllowanceCalc');

function isValidMonth(s) { return /^\d{4}-\d{2}$/.test(s); }

/**
 * 직원 1명의 월 attendance records → 주휴수당 총합 (사장님 요청 2026-05).
 * holidayAllowanceCalc (W-G2 와 동일 로직) 재사용 — 월~일 주 단위, ≥15h + 결근 0회 조건.
 * 월 경계 걸친 주는 그 달 records 만으로 계산 (참고 추정치 — 정밀 정산은 2주 급여 확정 화면).
 */
function _holidayAllowanceTotal(records) {
  const weeks = holidayCalc.calcAllWeeksForEmployee(records || []);
  return weeks.reduce((s, w) => s + (Number(w.amount) || 0), 0);
}

/** 월 전체 요약 (사장 대시보드) */
async function getMonthlySummary(month) {
  const c = getClient();
  const [attRes, bonusRes, staffRes] = await Promise.all([
    c.from('attendance')
      // 주휴수당 계산 위해 date / hourly_rate_snapshot 추가 (사장님 요청 2026-05)
      .select('employee_id, date, work_hours, daily_pay, status, hourly_rate_snapshot')
      .gte('date', `${month}-01`)
      .lte('date', `${month}-31`),
    c.from('shopee_bonuses')
      .select('employee_id, bonus_amount')
      .eq('month', month),
    c.from('users')
      .select('id, display_name, platform, hourly_rate, shopee_bonus_rate')
      .eq('role', 'staff')
      .eq('is_active', true)
      .order('display_name', { ascending: true }),
  ]);
  if (attRes.error) throw attRes.error;
  if (bonusRes.error) throw bonusRes.error;
  if (staffRes.error) throw staffRes.error;

  const attMap = new Map();
  const recordsMap = new Map();   // employee_id → attendance records[] (주휴수당 계산용)
  for (const a of attRes.data || []) {
    const cur = attMap.get(a.employee_id) || {
      totalHours: 0, totalBase: 0, workDays: 0,
      late: 0, earlyLeave: 0, dayOff: 0, absence: 0,
    };
    cur.totalHours += Number(a.work_hours || 0);
    cur.totalBase += Number(a.daily_pay || 0);
    // 실근무일 = 시각이 찍힌 날 (regular/late/early_leave)
    if (a.status !== 'day_off' && a.status !== 'absence') cur.workDays += 1;
    if (a.status === 'late') cur.late += 1;
    else if (a.status === 'early_leave') cur.earlyLeave += 1;
    else if (a.status === 'day_off') cur.dayOff += 1;
    else if (a.status === 'absence') cur.absence += 1;
    attMap.set(a.employee_id, cur);

    if (!recordsMap.has(a.employee_id)) recordsMap.set(a.employee_id, []);
    recordsMap.get(a.employee_id).push(a);
  }
  const bonusMap = new Map((bonusRes.data || []).map(b => [b.employee_id, Number(b.bonus_amount)]));

  const summary = (staffRes.data || []).map(s => {
    const att = attMap.get(s.id) || {
      totalHours: 0, totalBase: 0, workDays: 0,
      late: 0, earlyLeave: 0, dayOff: 0, absence: 0,
    };
    const bonus = bonusMap.get(s.id) || 0;
    const holidayAllowance = Math.round(_holidayAllowanceTotal(recordsMap.get(s.id)) * 100) / 100;
    return {
      id: s.id,
      displayName: s.display_name,
      platform: s.platform,
      hourlyRate: Number(s.hourly_rate || 0),
      totalHours: Math.round(att.totalHours * 100) / 100,
      workDays: att.workDays,
      basePay: att.totalBase,
      holidayAllowance,                                   // 주휴수당 (사장님 요청 2026-05)
      shopeeBonus: bonus,
      totalPay: att.totalBase + holidayAllowance + bonus, // 주휴수당 포함
      late: att.late,
      earlyLeave: att.earlyLeave,
      dayOff: att.dayOff,
      absence: att.absence,
    };
  });
  const grandTotal = summary.reduce((a, s) => a + s.totalPay, 0);
  return { month, summary, grandTotal };
}

/** 개인 월 집계 */
async function getEmployeeMonthly(employeeId, month) {
  const c = getClient();
  const [empRes, recsRes, bonusRes] = await Promise.all([
    c.from('users').select('id, display_name, platform, hourly_rate, shopee_bonus_rate').eq('id', employeeId).maybeSingle(),
    c.from('attendance').select('*').eq('employee_id', employeeId).gte('date', `${month}-01`).lte('date', `${month}-31`).order('date', { ascending: true }),
    c.from('shopee_bonuses').select('*').eq('employee_id', employeeId).eq('month', month).maybeSingle(),
  ]);
  if (empRes.error) throw empRes.error;
  if (recsRes.error) throw recsRes.error;
  if (bonusRes.error) throw bonusRes.error;

  const employee = empRes.data;
  const records = recsRes.data || [];
  const totalHours = records.reduce((a, r) => a + Number(r.work_hours || 0), 0);
  const basePay = records.reduce((a, r) => a + Number(r.daily_pay || 0), 0);
  const bonus = bonusRes.data;
  const bonusAmount = bonus ? Number(bonus.bonus_amount) : 0;

  // 주휴수당 (사장님 요청 2026-05) — 주별 발생 내역 + 총합
  const weeks = holidayCalc.calcAllWeeksForEmployee(records);
  const holidayAllowance = Math.round(weeks.reduce((s, w) => s + (Number(w.amount) || 0), 0) * 100) / 100;

  return {
    employee,
    month,
    records,
    totalHours: Math.round(totalHours * 100) / 100,
    workDays: records.length,
    basePay,
    holidayAllowance,                  // 주휴수당 총합
    holidayWeeks: weeks,               // 주별 상세 (eligible / amount / 사유)
    shopeeBonus: bonus ? {
      monthlyRevenue: Number(bonus.monthly_revenue),
      bonusRate: Number(bonus.bonus_rate),
      bonusAmount,
    } : null,
    totalPay: basePay + holidayAllowance + bonusAmount,  // 주휴수당 포함
  };
}

/** 시급 설정 */
async function setHourlyRate(employeeId, rate) {
  const { data, error } = await getClient()
    .from('users')
    .update({ hourly_rate: String(rate) })
    .eq('id', employeeId)
    .select('id, display_name, hourly_rate')
    .single();
  if (error) throw error;
  return data;
}

/** 인센티브/상여 upsert — bonusAmount 직접 입력 */
async function upsertBonus({ employeeId, month, bonusAmount, enteredBy }) {
  const c = getClient();
  const amount = Number(bonusAmount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('상여 금액은 0 이상의 숫자여야 합니다');

  const { data: existing, error: e2 } = await c
    .from('shopee_bonuses')
    .select('id')
    .eq('employee_id', employeeId).eq('month', month)
    .maybeSingle();
  if (e2) throw e2;

  const payload = {
    employee_id: employeeId,
    month,
    monthly_revenue: '0',
    bonus_rate: '0',
    bonus_amount: String(amount),
    entered_by: enteredBy,
  };

  if (existing) {
    const { data, error } = await c.from('shopee_bonuses').update(payload).eq('id', existing.id).select().single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await c.from('shopee_bonuses').insert(payload).select().single();
    if (error) throw error;
    return data;
  }
}

async function listBonusesByEmployee(employeeId) {
  const { data, error } = await getClient()
    .from('shopee_bonuses')
    .select('*')
    .eq('employee_id', employeeId)
    .order('month', { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  isValidMonth,
  getMonthlySummary,
  getEmployeeMonthly,
  setHourlyRate,
  upsertBonus,
  listBonusesByEmployee,
};
