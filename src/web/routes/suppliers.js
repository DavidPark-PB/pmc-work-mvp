'use strict';

/**
 * suppliers 마스터 API — SKU 마스터 화면 드롭다운 소스.
 *
 * 계약서 §Engine 5 예약 스키마 (migration 069) 활용:
 *   GET  /api/suppliers          목록 (active 우선 정렬)
 *   POST /api/suppliers          새 소싱처 추가 (사장님이 UI 에서 자유롭게 추가)
 *   PATCH /api/suppliers/:id     이름/채널/notes 편집, is_active 토글
 */

const express = require('express');
const router = express.Router();
const { getClient } = require('../../db/supabaseClient');

const trim = (v, max = 200) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, max) : null;
};

// GET /api/suppliers?active=true|false
router.get('/', async (req, res) => {
  try {
    const db = getClient();
    let q = db.from('suppliers').select('id, name, channel, contact, default_lead_time_days, reliability, is_active, notes, created_at, updated_at');
    if (req.query.active === 'true') q = q.eq('is_active', true);
    else if (req.query.active === 'false') q = q.eq('is_active', false);
    const { data, error } = await q.order('is_active', { ascending: false }).order('name', { ascending: true }).limit(500);
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/suppliers { name, channel?, notes? }
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const name = trim(body.name);
    if (!name) return res.status(400).json({ error: 'name 필수' });
    const row = {
      name,
      channel: trim(body.channel, 50),
      notes: trim(body.notes, 500),
      default_lead_time_days: Number.isFinite(parseInt(body.default_lead_time_days)) ? parseInt(body.default_lead_time_days) : null,
      is_active: true,
    };
    const db = getClient();
    const { data, error } = await db.from('suppliers').insert(row).select().single();
    if (error) {
      // 중복 이름은 기존 재활성화로 처리
      if (error.code === '23505' || /duplicate/i.test(error.message || '')) {
        const { data: exist } = await db.from('suppliers').select().eq('name', name).single();
        if (exist) {
          await db.from('suppliers').update({ is_active: true }).eq('id', exist.id);
          return res.json({ data: { ...exist, is_active: true }, reused: true });
        }
      }
      throw error;
    }
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/suppliers/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) {
      const v = trim(body.name);
      if (!v) return res.status(400).json({ error: 'name 필수' });
      updates.name = v;
    }
    if (body.channel !== undefined) updates.channel = trim(body.channel, 50);
    if (body.notes !== undefined) updates.notes = trim(body.notes, 500);
    if (body.is_active !== undefined) updates.is_active = body.is_active === true;
    if (body.default_lead_time_days !== undefined) {
      const n = parseInt(body.default_lead_time_days);
      updates.default_lead_time_days = Number.isFinite(n) ? n : null;
    }
    const db = getClient();
    const { data, error } = await db.from('suppliers').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
