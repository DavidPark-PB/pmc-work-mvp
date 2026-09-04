/**
 * 직원 일정 · CRUD (Owner Directive 2026-09-04)
 *
 * 조회 정책: 모두 서로 다 봄 (all employees see all)
 * 편집 정책: 본인 or admin
 *
 * Endpoints:
 *   GET    /api/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD   — 기간 · 모든 직원
 *   GET    /api/schedules/mine                            — 본인 일정만
 *   POST   /api/schedules                                 — 등록
 *   PATCH  /api/schedules/:id                             — 수정 (본인 or admin)
 *   DELETE /api/schedules/:id                             — 삭제 (본인 or admin)
 */
'use strict';

const express = require('express');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

const VALID_TYPES = new Set(['vacation', 'half_day', 'outside', 'meeting', 'task', 'other']);

function sanitizeType(t) {
  const s = String(t || 'other').toLowerCase().trim();
  return VALID_TYPES.has(s) ? s : 'other';
}

function validateDate(s) {
  if (!s) return null;
  const d = String(s).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d;
}
function validateTime(s) {
  if (!s) return null;
  const t = String(s).slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(t)) return null;
  return t + ':00';
}

// GET /api/schedules?from=&to=&user_id=
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: '로그인 필요' });
    const from = validateDate(req.query.from);
    const to = validateDate(req.query.to);
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const db = getClient();
    // 조회: 이벤트가 · [from, to] 범위와 겹치는 것 (event_date <= to · (end_date IS NULL AND event_date >= from) OR end_date >= from)
    let q = db.from('employee_schedules').select('*').order('event_date', { ascending: true });
    if (from) q = q.or(`end_date.gte.${from},and(end_date.is.null,event_date.gte.${from})`);
    if (to)   q = q.lte('event_date', to);
    if (Number.isFinite(userId)) q = q.eq('user_id', userId);
    const { data, error } = await q.limit(2000);
    if (error) return res.status(500).json({ success: false, error: error.message });

    // user 정보 join (display_name · username)
    const userIds = [...new Set((data || []).map(r => r.user_id).filter(Boolean))];
    let userMap = new Map();
    if (userIds.length) {
      const { data: users } = await db.from('users').select('id, display_name, username').in('id', userIds);
      (users || []).forEach(u => userMap.set(u.id, u));
    }
    const enriched = (data || []).map(r => ({
      ...r,
      user_display_name: userMap.get(r.user_id)?.display_name || null,
      user_username: userMap.get(r.user_id)?.username || null,
    }));

    res.json({ success: true, data: enriched });
  } catch (e) {
    console.error('[schedules/list] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/schedules/mine
router.get('/mine', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: '로그인 필요' });
    const from = validateDate(req.query.from);
    const to = validateDate(req.query.to);
    const db = getClient();
    let q = db.from('employee_schedules').select('*').eq('user_id', req.user.id)
      .order('event_date', { ascending: false }).limit(200);
    if (from) q = q.gte('event_date', from);
    if (to)   q = q.lte('event_date', to);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error('[schedules/mine] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/schedules
router.post('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: '로그인 필요' });
    const body = req.body || {};
    const eventDate = validateDate(body.event_date);
    if (!eventDate) return res.status(400).json({ success: false, error: 'event_date 필요 (YYYY-MM-DD)' });
    const endDate = validateDate(body.end_date);
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ success: false, error: 'title 필요' });
    const type = sanitizeType(body.event_type);
    const description = body.description ? String(body.description).slice(0, 1000) : null;
    const allDay = body.all_day === false ? false : true;
    const startTime = allDay ? null : validateTime(body.start_time);
    const endTime = allDay ? null : validateTime(body.end_time);
    const color = body.color ? String(body.color).slice(0, 20) : null;

    const db = getClient();
    const { data, error } = await db.from('employee_schedules').insert({
      user_id: req.user.id,
      event_type: type,
      title,
      description,
      event_date: eventDate,
      end_date: endDate,
      all_day: allDay,
      start_time: startTime,
      end_time: endTime,
      color,
    }).select('*').single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[schedules/create] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/schedules/:id
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: '로그인 필요' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
    const db = getClient();
    const { data: existing, error: eGet } = await db.from('employee_schedules').select('user_id').eq('id', id).maybeSingle();
    if (eGet) return res.status(500).json({ success: false, error: eGet.message });
    if (!existing) return res.status(404).json({ success: false, error: '일정 없음' });
    if (existing.user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ success: false, error: '본인 or admin 만 수정 가능' });
    }
    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (body.event_type !== undefined) updates.event_type = sanitizeType(body.event_type);
    if (body.title !== undefined) {
      const t = String(body.title || '').trim().slice(0, 200);
      if (!t) return res.status(400).json({ success: false, error: 'title 비워둘 수 없음' });
      updates.title = t;
    }
    if (body.description !== undefined) updates.description = body.description ? String(body.description).slice(0, 1000) : null;
    if (body.event_date !== undefined) {
      const d = validateDate(body.event_date);
      if (!d) return res.status(400).json({ success: false, error: 'event_date invalid' });
      updates.event_date = d;
    }
    if (body.end_date !== undefined) updates.end_date = validateDate(body.end_date);
    if (body.all_day !== undefined) updates.all_day = body.all_day === false ? false : true;
    if (body.start_time !== undefined) updates.start_time = validateTime(body.start_time);
    if (body.end_time !== undefined) updates.end_time = validateTime(body.end_time);
    if (body.color !== undefined) updates.color = body.color ? String(body.color).slice(0, 20) : null;

    const { data, error } = await db.from('employee_schedules').update(updates).eq('id', id).select('*').single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[schedules/update] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/schedules/:id
router.delete('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: '로그인 필요' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
    const db = getClient();
    const { data: existing, error: eGet } = await db.from('employee_schedules').select('user_id').eq('id', id).maybeSingle();
    if (eGet) return res.status(500).json({ success: false, error: eGet.message });
    if (!existing) return res.status(404).json({ success: false, error: '일정 없음' });
    if (existing.user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ success: false, error: '본인 or admin 만 삭제 가능' });
    }
    const { error } = await db.from('employee_schedules').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) {
    console.error('[schedules/delete] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
