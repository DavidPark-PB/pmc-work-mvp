/**
 * attendance 테이블 — 출퇴근 기록
 * date 컬럼은 'YYYY-MM-DD' varchar (timezone 이슈 방지)
 */
const { getClient } = require('./supabaseClient');

function timeToMinutes(t) {
  if (!t) return null;
  const parts = String(t).split(':').map(Number);
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
  const [h, m, s = 0] = parts;
  return h * 60 + m + Math.floor(s / 60);
}

function calcWorkHours(inT, outT) {
  const inMin = timeToMinutes(inT);
  const outMin = timeToMinutes(outT);
  if (inMin == null || outMin == null) return null;
  if (outMin <= inMin) return null;
  return Math.round(((outMin - inMin) / 60) * 100) / 100;
}

function todayDateStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function isValidDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

/** 근태 유형 */
const VALID_STATUSES = ['regular', 'late', 'early_leave', 'day_off', 'absence'];
const STATUS_LABELS = {
  regular: '정상',
  late: '지각',
  early_leave: '조퇴',
  day_off: '휴무',
  absence: '결근',
};
/** 사유(note) 필수인 상태 */
const REASON_REQUIRED = ['late', 'early_leave', 'absence'];
/** 시각 입력 없이 기록 가능한 상태 (clock_in/out 없음) */
const NO_TIMES = ['day_off', 'absence'];
/** 일급 0원인 상태 */
const ZERO_PAY = ['day_off', 'absence'];

async function listAttendance({ user, employeeId, month, from, to }) {
  let q = getClient()
    .from('attendance')
    .select(`
      id, employee_id, date, clock_in, clock_out, work_hours,
      hourly_rate_snapshot, daily_pay, note, status, created_at, updated_at,
      employee:users!attendance_employee_id_users_id_fk ( id, display_name )
    `);

  if (!user.isAdmin) q = q.eq('employee_id', user.id);
  else if (employeeId) q = q.eq('employee_id', employeeId);

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    q = q.gte('date', `${month}-01`).lte('date', `${month}-31`);
  } else {
    if (from && isValidDateStr(from)) q = q.gte('date', from);
    if (to && isValidDateStr(to)) q = q.lte('date', to);
  }

  const { data, error } = await q.order('date', { ascending: false }).order('employee_id', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getById(id) {
  const { data, error } = await getClient().from('attendance').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getUserHourlyRate(userId) {
  const { data, error } = await getClient().from('users').select('hourly_rate').eq('id', userId).maybeSingle();
  if (error) throw error;
  return Number(data?.hourly_rate || 0);
}

async function createAttendance({ employeeId, date, clockIn, clockOut, note, status, hourlyRateSnapshot }) {
  const st = VALID_STATUSES.includes(status) ? status : 'regular';

  // day_off/absence는 시각 무시, 일급 0원
  const actualIn = NO_TIMES.includes(st) ? null : (clockIn || null);
  const actualOut = NO_TIMES.includes(st) ? null : (clockOut || null);

  const rate = hourlyRateSnapshot != null ? hourlyRateSnapshot : await getUserHourlyRate(employeeId);
  const workHours = ZERO_PAY.includes(st) ? null : calcWorkHours(actualIn, actualOut);
  const dailyPay = ZERO_PAY.includes(st) ? 0 : (workHours != null ? Math.round(workHours * rate * 100) / 100 : null);

  const { data, error } = await getClient().from('attendance').insert({
    employee_id: employeeId,
    date,
    clock_in: actualIn,
    clock_out: actualOut,
    work_hours: workHours != null ? String(workHours) : null,
    hourly_rate_snapshot: String(rate),
    daily_pay: dailyPay != null ? String(dailyPay) : null,
    note: note || null,
    status: st,
  }).select().single();

  if (error) throw error;
  return data;
}

async function updateAttendance(id, existing, { clockIn, clockOut, note, status }) {
  const st = status !== undefined && VALID_STATUSES.includes(status) ? status : existing.status || 'regular';
  const rate = Number(existing.hourly_rate_snapshot || 0);

  // 새 status가 NO_TIMES면 시각을 null로 강제
  let newIn = clockIn !== undefined ? (clockIn || null) : existing.clock_in;
  let newOut = clockOut !== undefined ? (clockOut || null) : existing.clock_out;
  if (NO_TIMES.includes(st)) { newIn = null; newOut = null; }

  const workHours = ZERO_PAY.includes(st) ? null : calcWorkHours(newIn, newOut);
  const dailyPay = ZERO_PAY.includes(st) ? 0 : (workHours != null ? Math.round(workHours * rate * 100) / 100 : null);

  const updates = { updated_at: new Date().toISOString() };
  updates.clock_in = newIn;
  updates.clock_out = newOut;
  if (note !== undefined) updates.note = note || null;
  if (status !== undefined) updates.status = st;
  updates.work_hours = workHours != null ? String(workHours) : null;
  updates.daily_pay = dailyPay != null ? String(dailyPay) : null;

  const { data, error } = await getClient().from('attendance').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function deleteAttendance(id) {
  const { error } = await getClient().from('attendance').delete().eq('id', id);
  if (error) throw error;
}

module.exports = {
  listAttendance, getById, createAttendance, updateAttendance, deleteAttendance,
  calcWorkHours, todayDateStr, isValidDateStr, getUserHourlyRate,
  VALID_STATUSES, STATUS_LABELS, REASON_REQUIRED, NO_TIMES, ZERO_PAY,
};
