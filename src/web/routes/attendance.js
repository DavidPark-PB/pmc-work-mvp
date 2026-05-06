/**
 * 출퇴근 API — row-level security
 * staff: 본인 기록만 (당일만 수정 가능)
 * owner: 전체
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/attendanceRepository');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { employeeId, month, from, to } = req.query;
    const data = await repo.listAttendance({
      user: req.user,
      employeeId: employeeId ? parseInt(employeeId, 10) : undefined,
      month, from, to,
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/attendance/clock-in — 오늘 출근 (본인, 현재 시각 — Asia/Seoul)
router.post('/clock-in', async (req, res) => {
  try {
    const today = repo.todayDateStr();
    const existing = await repo.findByEmployeeDate(req.user.id, today);
    if (existing) {
      return res.status(409).json({ error: '오늘 이미 출근 기록이 있습니다', data: existing });
    }
    const created = await repo.createAttendance({
      employeeId: req.user.id,
      date: today,
      clockIn: repo.nowHhmmKr(),
      clockOut: null,
      status: 'regular',
    });
    res.json({ data: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/attendance/clock-out — 오늘 퇴근 (본인, 현재 시각 — Asia/Seoul; 오늘 open 기록 업데이트)
router.post('/clock-out', async (req, res) => {
  try {
    const today = repo.todayDateStr();
    const existing = await repo.findByEmployeeDate(req.user.id, today);
    if (!existing) {
      return res.status(404).json({ error: '오늘 출근 기록이 없습니다. 먼저 출근을 찍으세요' });
    }
    if (existing.clock_out) {
      return res.status(409).json({ error: '오늘 이미 퇴근 기록이 있습니다', data: existing });
    }
    if (repo.NO_TIMES.includes(existing.status)) {
      return res.status(400).json({ error: '휴무/결근 기록은 퇴근 시각을 찍을 수 없습니다' });
    }
    const updated = await repo.updateAttendance(existing.id, existing, { clockOut: repo.nowHhmmKr() });
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { date, clockIn, clockOut, note, status, employeeId: bodyEmpId } = req.body || {};
    const targetDate = date || repo.todayDateStr();
    if (!repo.isValidDateStr(targetDate)) return res.status(400).json({ error: '날짜 형식은 YYYY-MM-DD여야 합니다' });

    const st = status || 'regular';
    if (!repo.VALID_STATUSES.includes(st)) {
      return res.status(400).json({ error: '올바른 근태 유형이 아닙니다' });
    }
    if (repo.REASON_REQUIRED.includes(st) && !(note && note.trim())) {
      return res.status(400).json({ error: `${repo.STATUS_LABELS[st]}은(는) 사유를 입력해야 합니다` });
    }
    // 시각 찍혀야 하는 상태 체크
    if (!repo.NO_TIMES.includes(st) && !clockIn) {
      return res.status(400).json({ error: '출근 시각을 입력하세요' });
    }

    const targetEmployeeId = req.user.isAdmin && bodyEmpId ? parseInt(bodyEmpId, 10) : req.user.id;

    try {
      const created = await repo.createAttendance({
        employeeId: targetEmployeeId,
        date: targetDate,
        clockIn, clockOut, note, status: st,
      });
      res.json({ data: created });
    } catch (e) {
      if (String(e.message).includes('attendance_employee_date_idx') || String(e.message).includes('duplicate')) {
        return res.status(409).json({ error: '해당 날짜에 이미 기록이 있습니다. 수정이 필요하면 사장님께 요청하세요' });
      }
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 수정은 admin만 — 직원 자신이 실수한 경우 사장님께 요청해서 변경
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: '출퇴근 기록 수정은 관리자만 가능합니다. 사장님께 요청하세요.' });
    }
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다' });

    const { clockIn, clockOut, note, status } = req.body || {};
    if (status !== undefined && !repo.VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: '올바른 근태 유형이 아닙니다' });
    }
    const finalStatus = status || existing.status || 'regular';
    if (repo.REASON_REQUIRED.includes(finalStatus)) {
      const finalNote = note !== undefined ? note : existing.note;
      if (!(finalNote && String(finalNote).trim())) {
        return res.status(400).json({ error: `${repo.STATUS_LABELS[finalStatus]}은(는) 사유를 입력해야 합니다` });
      }
    }
    const updated = await repo.updateAttendance(id, existing, { clockIn, clockOut, note, status });
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다' });
    await repo.deleteAttendance(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
