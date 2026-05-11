/**
 * holidayAllowanceCalc — 주휴수당 자동 계산 (PR W-G2-B)
 *
 * 사장님 spec:
 *   1주 기준 = 월~일 (격주 급여 기간과 정렬)
 *   발생 조건:
 *     - 1주 총 근무시간 ≥ 15시간
 *     - 그 주에 결근(absence) 0회
 *     - "지각/조퇴"는 출근으로 인정
 *     - "휴무"는 소정근로일 아님 (출근일수에서 제외, 주휴 영향 없음)
 *   계산:
 *     - 출근일수 = 정상/지각/조퇴 카운트
 *     - 1일 평균 = min(8, 주간 근무시간 / 출근일수)
 *     - 주휴수당 = 1일 평균 × 시급(주중 평균 hourly_wage_snapshot)
 *
 * 정책:
 *   - 모든 계산은 KST (Asia/Seoul) 가정. attendance.date 가 'YYYY-MM-DD' varchar 라 timezone 무관.
 *   - hourly_wage_snapshot 이 NULL/0 인 record 는 평균에서 제외 (시급 미등록 직원 영향 0)
 *   - 출근일수 0 이면 주휴수당 0 (안전 분모)
 */
'use strict';

const MIN_WEEKLY_HOURS = 15;
const MAX_DAILY_HOURS_FOR_ALLOWANCE = 8;

const STATUS_WORK = ['regular', 'late', 'early_leave'];
const STATUS_ABSENCE = 'absence';
const STATUS_DAY_OFF = 'day_off';

/**
 * YYYY-MM-DD → Date (KST midnight 가정).
 */
function _parseDate(s) {
  return new Date(`${s}T00:00:00+09:00`);
}

/**
 * Date → YYYY-MM-DD (KST).
 */
function _formatDate(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(d).reduce((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * 주어진 date 의 그 주 월요일 (KST).
 * getDay(): 0=Sun, 1=Mon, ..., 6=Sat
 */
function _mondayOfWeek(dateStr) {
  const d = _parseDate(dateStr);
  // KST 기준 요일 — date 가 '2026-05-12' 면 d 는 KST 월요일 0시 정확.
  // Intl 로 KST weekday 계산
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(d);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = map[dayName] ?? 0;
  const offset = dow === 0 ? -6 : (1 - dow);  // Sun → 다음 월요일이 아닌 지난 월요일 (-6)
  const monday = new Date(d.getTime() + offset * 86400 * 1000);
  return _formatDate(monday);
}

function _addDays(dateStr, days) {
  const d = _parseDate(dateStr);
  return _formatDate(new Date(d.getTime() + days * 86400 * 1000));
}

/**
 * 주별 그룹화. 같은 주의 records 만 모음.
 * @param {Array} records — attendance row 배열
 * @returns {Map<string, Array>} key='YYYY-MM-DD' (월요일), value=records
 */
function groupByWeek(records) {
  const map = new Map();
  for (const r of records || []) {
    if (!r.date) continue;
    const monday = _mondayOfWeek(r.date);
    if (!map.has(monday)) map.set(monday, []);
    map.get(monday).push(r);
  }
  return map;
}

/**
 * 1주 records → 주휴수당 계산.
 * @returns {{
 *   weekStartDate, weekEndDate, totalWorkHours, workDays,
 *   averageDailyHours, hourlyWageUsed, amount, eligible
 * }}
 *
 * eligible=false 면 amount=0 + 미발생 (조건 불충족: <15h OR 결근 OR work_days=0).
 */
function calcOneWeek(weekStartDate, records) {
  const weekEndDate = _addDays(weekStartDate, 6);
  let totalWorkHours = 0;
  let workDays = 0;
  let hasAbsence = false;
  let wageSum = 0;
  let wageCount = 0;

  for (const r of records || []) {
    if (r.status === STATUS_ABSENCE) hasAbsence = true;
    if (r.status === STATUS_DAY_OFF) continue;  // 휴무 = 소정근로일 아님

    if (STATUS_WORK.includes(r.status)) {
      workDays++;
      const wh = r.work_hours != null ? Number(r.work_hours) : 0;
      if (Number.isFinite(wh)) totalWorkHours += wh;
      const wage = r.hourly_rate_snapshot != null ? Number(r.hourly_rate_snapshot) : 0;
      if (Number.isFinite(wage) && wage > 0) {
        wageSum += wage;
        wageCount++;
      }
    }
  }

  const eligible = totalWorkHours >= MIN_WEEKLY_HOURS && !hasAbsence && workDays > 0;
  const averageDailyHours = workDays > 0
    ? Math.min(MAX_DAILY_HOURS_FOR_ALLOWANCE, totalWorkHours / workDays)
    : 0;
  const hourlyWageUsed = wageCount > 0 ? Math.round(wageSum / wageCount) : 0;
  const amount = eligible
    ? Math.round(averageDailyHours * hourlyWageUsed * 100) / 100
    : 0;

  return {
    weekStartDate,
    weekEndDate,
    totalWorkHours: Math.round(totalWorkHours * 100) / 100,
    workDays,
    averageDailyHours: Math.round(averageDailyHours * 100) / 100,
    hourlyWageUsed,
    amount,
    eligible,
    hasAbsence,
  };
}

/**
 * 직원 1명의 주별 주휴수당 list.
 * @param {Array} records — 해당 직원의 attendance records (특정 period 안)
 * @returns {Array} 주별 결과 (eligible 무관 모두 포함)
 */
function calcAllWeeksForEmployee(records) {
  const grouped = groupByWeek(records);
  const sorted = Array.from(grouped.entries()).sort(([a], [b]) => a < b ? -1 : 1);
  return sorted.map(([weekStart, weekRecords]) => calcOneWeek(weekStart, weekRecords));
}

module.exports = {
  groupByWeek,
  calcOneWeek,
  calcAllWeeksForEmployee,
  MIN_WEEKLY_HOURS, MAX_DAILY_HOURS_FOR_ALLOWANCE,
};
