/**
 * 급여 집계 + Shopee 보너스 관리
 */
const { getClient } = require('./supabaseClient');

function isValidMonth(s) { return /^\d{4}-\d{2}$/.test(s); }

/** 월 전체 요약 (사장 대시보드) */
async function getMonthlySummary(month) {
  const c = getClient();
  const [attRes, bonusRes, staffRes] = await Promise.all([
    c.from('attendance')
      .select('employee_id, work_hours, daily_pay, status')
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
  }
  const bonusMap = new Map((bonusRes.data || []).map(b => [b.employee_id, Number(b.bonus_amount)]));

  const summary = (staffRes.data || []).map(s => {
    const att = attMap.get(s.id) || {
      totalHours: 0, totalBase: 0, workDays: 0,
      late: 0, earlyLeave: 0, dayOff: 0, absence: 0,
    };
    const bonus = bonusMap.get(s.id) || 0;
    return {
      id: s.id,
      displayName: s.display_name,
      platform: s.platform,
      hourlyRate: Number(s.hourly_rate || 0),
      totalHours: Math.round(att.totalHours * 100) / 100,
      workDays: att.workDays,
      basePay: att.totalBase,
      shopeeBonus: bonus,
      totalPay: att.totalBase + bonus,
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

  return {
    employee,
    month,
    records,
    totalHours: Math.round(totalHours * 100) / 100,
    workDays: records.length,
    basePay,
    shopeeBonus: bonus ? {
      monthlyRevenue: Number(bonus.monthly_revenue),
      bonusRate: Number(bonus.bonus_rate),
      bonusAmount: Number(bonus.bonus_amount),
    } : null,
    totalPay: basePay + (bonus ? Number(bonus.bonus_amount) : 0),
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

/** Shopee 보너스 upsert */
async function upsertShopeeBonus({ employeeId, month, monthlyRevenue, enteredBy }) {
  const c = getClient();
  const { data: emp, error: e1 } = await c.from('users').select('shopee_bonus_rate, display_name').eq('id', employeeId).maybeSingle();
  if (e1) throw e1;
  if (!emp) throw new Error('직원을 찾을 수 없습니다');
  if (!emp.shopee_bonus_rate) throw new Error('해당 직원은 Shopee 보너스 대상이 아닙니다 (bonusRate 미설정)');

  const bonusRate = Number(emp.shopee_bonus_rate);
  const bonusAmount = Math.round(Number(monthlyRevenue) * bonusRate * 100) / 100;

  const { data: existing, error: e2 } = await c
    .from('shopee_bonuses')
    .select('id')
    .eq('employee_id', employeeId).eq('month', month)
    .maybeSingle();
  if (e2) throw e2;

  const payload = {
    employee_id: employeeId,
    month,
    monthly_revenue: String(monthlyRevenue),
    bonus_rate: String(bonusRate),
    bonus_amount: String(bonusAmount),
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
  upsertShopeeBonus,
  listBonusesByEmployee,
};
