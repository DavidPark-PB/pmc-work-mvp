/**
 * Users API — 유저 목록 조회 (admin 전용) + 생성/수정 (Phase 2에서 추가)
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const userRepo = require('../../db/userRepository');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

/** GET /api/users/staff — 활성 직원 목록 (admin 전용) */
router.get('/staff', requireAdmin, async (req, res) => {
  try {
    const data = await userRepo.listActiveStaff();
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/users/all — 전체 유저 (admin 전용) — 직원관리 화면용 */
router.get('/all', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getClient()
      .from('users')
      .select('id, username, display_name, role, is_active, platform, work_type, hourly_rate, default_due_time, shopee_bonus_rate, ui_mode, notes, last_login_at, created_at')
      .order('role', { ascending: true })
      .order('display_name', { ascending: true });
    if (error) throw error;
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/users — 신규 계정 생성 (admin 전용) */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { username, displayName, password, role, platform, workType, hourlyRate, defaultDueTime, shopeeBonusRate, uiMode, notes } = req.body || {};
    if (!username || !displayName || !password) {
      return res.status(400).json({ error: 'username, displayName, password는 필수입니다' });
    }
    if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다' });

    const existing = await userRepo.findByUsername(username);
    if (existing) return res.status(409).json({ error: '이미 존재하는 아이디입니다' });

    const hash = await userRepo.hashPassword(password);
    const { data, error } = await getClient()
      .from('users')
      .insert({
        username: username.trim(),
        display_name: displayName.trim(),
        password_hash: hash,
        role: role === 'admin' ? 'admin' : 'staff',
        platform: platform || null,
        work_type: workType || null,
        hourly_rate: hourlyRate != null && hourlyRate !== '' ? String(hourlyRate) : '0',
        default_due_time: defaultDueTime || null,
        shopee_bonus_rate: shopeeBonusRate != null && shopeeBonusRate !== '' ? String(shopeeBonusRate) : null,
        ui_mode: uiMode || 'normal',
        notes: notes || null,
        is_active: true,
      })
      .select('id, username, display_name, role, platform, is_active, created_at')
      .single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** PATCH /api/users/:id — 유저 정보 수정 (admin 전용) */
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['display_name', 'role', 'platform', 'work_type', 'hourly_rate', 'default_due_time', 'shopee_bonus_rate', 'ui_mode', 'notes', 'is_active'];
    const body = req.body || {};
    const updates = {};
    const map = {
      displayName: 'display_name',
      workType: 'work_type',
      hourlyRate: 'hourly_rate',
      defaultDueTime: 'default_due_time',
      shopeeBonusRate: 'shopee_bonus_rate',
      uiMode: 'ui_mode',
      isActive: 'is_active',
    };
    for (const [k, v] of Object.entries(body)) {
      const dbKey = map[k] || k;
      if (allowed.includes(dbKey)) updates[dbKey] = v;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '변경할 내용이 없습니다' });

    const { data, error } = await getClient()
      .from('users')
      .update(updates)
      .eq('id', id)
      .select('id, username, display_name, role, platform, is_active')
      .single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
