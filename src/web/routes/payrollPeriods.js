/**
 * Payroll Periods API (/api/payroll/periods) — PR W-G2-B
 *
 * 사장님 spec:
 *   - 모든 endpoint admin only
 *   - startDate 월요일 강제 (KST 기준 — 사장님 짚을 점 11)
 *   - 단일 트랜잭션 (Postgres RPC)
 *   - preview 풍부화 (이상 + 시급 NULL + 직원별 + 총액)
 *   - 이상 데이터 ignoreAnomalies 옵션
 *   - 시급 NULL 차단
 *   - 주휴수당 수동 OFF (감사 보존)
 *
 * Endpoints:
 *   GET    /                                                     목록 (이전 endDate prefill 지원)
 *   GET    /:id                                                  상세 (employee_payrolls + weekly_holiday_allowances)
 *   POST   /preview                                              확정 전 미리보기
 *   POST   /confirm                                              확정 (RPC)
 *   POST   /:id/cancel                                           취소 (RPC)
 *   POST   /:id/paid                                             지급완료 (RPC)
 *   POST   /:id/holiday-allowances/:weeklyId/exclude             주휴수당 수동 OFF
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const periodRepo = require('../../db/payrollPeriodRepository');
const empRepo = require('../../db/employeePayrollRepository');
const weeklyRepo = require('../../db/weeklyHolidayAllowanceRepository');
const finalize = require('../../services/payroll/payrollFinalize');

const router = express.Router();
router.use(requireAdmin);

// ──────────────────────────────────────────────────────────────────────────
// Helper: KST 기준 요일 검증 (월요일 = 1)
// ──────────────────────────────────────────────────────────────────────────
function _kstWeekday(yyyymmdd) {
  // YYYY-MM-DD 를 KST 정오로 파싱 (DST 영향 없는 안전 시각)
  const d = new Date(`${yyyymmdd}T12:00:00+09:00`);
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(d);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[dayName] ?? -1;
}

function _isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ──────────────────────────────────────────────────────────────────────────
// GET / — 목록 + nextSuggestedStart (사장님 짚을 점 5)
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const data = await periodRepo.list({
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      status: req.query.status || undefined,
    });
    const lastEnd = await periodRepo.getLastEndDate();
    let nextSuggestedStart = null;
    if (lastEnd) {
      // lastEnd + 1 일
      const d = new Date(`${lastEnd}T12:00:00+09:00`);
      d.setDate(d.getDate() + 1);
      const nextStart = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d);
      nextSuggestedStart = nextStart;
    }
    res.json({ data, nextSuggestedStart });
  } catch (e) {
    console.error('[payroll-periods] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:id — 상세
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const period = await periodRepo.getById(id);
    if (!period) return res.status(404).json({ error: 'period not found' });
    const [employeePayrolls, weeklyAllowances] = await Promise.all([
      empRepo.listByPeriod(id),
      weeklyRepo.listByPeriod(id),
    ]);
    res.json({ data: period, employeePayrolls, weeklyAllowances });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /preview — 확정 전 미리보기 (이상 데이터 + 시급 NULL + 직원별 + 총액)
router.post('/preview', async (req, res) => {
  try {
    const { startDate, endDate } = req.body || {};
    if (!_isValidDate(startDate) || !_isValidDate(endDate)) {
      return res.status(400).json({ error: 'startDate / endDate (YYYY-MM-DD) 필수' });
    }
    if (_kstWeekday(startDate) !== 1) {
      return res.status(400).json({ error: 'startDate 는 월요일이어야 합니다 (KST 기준)' });
    }
    if (endDate <= startDate) {
      return res.status(400).json({ error: 'endDate 는 startDate 보다 뒤여야 합니다' });
    }
    const result = await finalize.preview({ startDate, endDate });
    res.json(result);
  } catch (e) {
    if (e?.code?.startsWith('payroll/')) return res.status(400).json({ error: e.message, code: e.code });
    console.error('[payroll-periods] preview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /confirm — 확정 (RPC 단일 트랜잭션)
router.post('/confirm', async (req, res) => {
  try {
    const { startDate, endDate, paymentDate, ignoreAnomalies } = req.body || {};
    if (!_isValidDate(startDate) || !_isValidDate(endDate) || !_isValidDate(paymentDate)) {
      return res.status(400).json({ error: 'startDate / endDate / paymentDate 모두 필수 (YYYY-MM-DD)' });
    }
    if (_kstWeekday(startDate) !== 1) {
      return res.status(400).json({ error: 'startDate 는 월요일이어야 합니다 (KST 기준)' });
    }
    try {
      const out = await finalize.confirm({
        startDate, endDate, paymentDate,
        executedBy: req.user.id,
        ignoreAnomalies: !!ignoreAnomalies,
      });
      res.status(201).json(out);
    } catch (e) {
      if (e?.code === 'payroll/null_snapshots') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      if (e?.code === 'payroll/anomalies') {
        return res.status(409).json({ error: e.message, code: e.code, anomalies: e.anomalies });
      }
      throw e;
    }
  } catch (e) {
    console.error('[payroll-periods] confirm error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/cancel — 취소 (RPC)
router.post('/:id/cancel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await finalize.cancel({ periodId: id, executedBy: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[payroll-periods] cancel error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/paid — 지급완료 (RPC)
router.post('/:id/paid', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await finalize.markPaid({ periodId: id, executedBy: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[payroll-periods] paid error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/holiday-allowances/:weeklyId/exclude — 수동 OFF
router.post('/:id/holiday-allowances/:weeklyId/exclude', async (req, res) => {
  try {
    const periodId = parseInt(req.params.id, 10);
    const weeklyId = parseInt(req.params.weeklyId, 10);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '제외 사유 필수' });

    // 존재 + period 확인
    const list = await weeklyRepo.listByPeriod(periodId);
    const target = list.find(w => w.id === weeklyId);
    if (!target) return res.status(404).json({ error: 'weekly allowance not found' });

    const updated = await weeklyRepo.exclude(weeklyId, { excludeReason: reason, excludedBy: req.user.id });
    // employee_payrolls / payroll_periods.total_amount / expense.amount 재계산
    await weeklyRepo.recalcEmployeePayrollAfterExclude(periodId, target.employeeId);

    res.json({ data: updated });
  } catch (e) {
    console.error('[payroll-periods] exclude error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
