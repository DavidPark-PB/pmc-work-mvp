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

router.post('/', async (req, res) => {
  try {
    const { date, clockIn, clockOut, note, employeeId: bodyEmpId } = req.body || {};
    const targetDate = date || repo.todayDateStr();
    if (!repo.isValidDateStr(targetDate)) return res.status(400).json({ error: '날짜 형식은 YYYY-MM-DD여야 합니다' });

    const targetEmployeeId = req.user.isAdmin && bodyEmpId ? parseInt(bodyEmpId, 10) : req.user.id;

    try {
      const created = await repo.createAttendance({
        employeeId: targetEmployeeId,
        date: targetDate,
        clockIn, clockOut, note,
      });
      res.json({ data: created });
    } catch (e) {
      if (String(e.message).includes('attendance_employee_date_idx') || String(e.message).includes('duplicate')) {
        return res.status(409).json({ error: '해당 날짜에 이미 기록이 있습니다. 수정을 사용하세요' });
      }
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다' });

    if (!req.user.isAdmin) {
      if (existing.employee_id !== req.user.id) return res.status(403).json({ error: '본인 기록만 수정 가능합니다' });
      if (existing.date !== repo.todayDateStr()) return res.status(403).json({ error: '당일 기록만 수정 가능합니다' });
    }

    const { clockIn, clockOut, note } = req.body || {};
    const updated = await repo.updateAttendance(id, existing, { clockIn, clockOut, note });
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
