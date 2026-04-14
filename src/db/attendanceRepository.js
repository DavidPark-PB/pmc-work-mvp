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

async function listAttendance({ user, employeeId, month, from, to }) {
  let q = getClient()
    .from('attendance')
    .select(`
      id, employee_id, date, clock_in, clock_out, work_hours,
      hourly_rate_snapshot, daily_pay, note, created_at, updated_at,
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

async function createAttendance({ employeeId, date, clockIn, clockOut, note, hourlyRateSnapshot }) {
  const workHours = calcWorkHours(clockIn, clockOut);
  const rate = hourlyRateSnapshot != null ? hourlyRateSnapshot : await getUserHourlyRate(employeeId);
  const dailyPay = workHours != null ? Math.round(workHours * rate * 100) / 100 : null;

  const { data, error } = await getClient().from('attendance').insert({
    employee_id: employeeId,
    date,
    clock_in: clockIn || null,
    clock_out: clockOut || null,
    work_hours: workHours != null ? String(workHours) : null,
    hourly_rate_snapshot: String(rate),
    daily_pay: dailyPay != null ? String(dailyPay) : null,
    note: note || null,
  }).select().single();

  if (error) throw error;
  return data;
}

async function updateAttendance(id, existing, { clockIn, clockOut, note }) {
  const newIn = clockIn !== undefined ? clockIn : existing.clock_in;
  const newOut = clockOut !== undefined ? clockOut : existing.clock_out;
  const workHours = calcWorkHours(newIn, newOut);
  const rate = Number(existing.hourly_rate_snapshot || 0);
  const dailyPay = workHours != null ? Math.round(workHours * rate * 100) / 100 : null;

  const updates = { updated_at: new Date().toISOString() };
  if (clockIn !== undefined) updates.clock_in = clockIn || null;
  if (clockOut !== undefined) updates.clock_out = clockOut || null;
  if (note !== undefined) updates.note = note || null;
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
};
