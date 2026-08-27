'use strict';
/**
 * b2cWork.js — B2C · Phase 7 · Employee Work OS routes.
 *
 * server.js mount: /api/b2c/work
 *
 * Endpoints:
 *   GET  /my-tasks                         · 직원 · 자기 배정 tasks + summary + next_task
 *   GET  /next-task                        · 직원 · NEXT TASK 하나만
 *   POST /:id/start                        · 직원 · 자기 task 만
 *   POST /:id/submit                       · 직원 · CHANNEL_REGISTER 은 listing_id/url/price 필수
 *   POST /:id/blocked                      · 직원 · blocked_reason 필수
 *   POST /:id/qc-pass                      · admin/reviewer · SoT 자동 반영
 *   POST /:id/qc-fail                      · admin/reviewer · qc_fail_reason 필수
 *   GET  /qc/queue                         · admin · qc_pending tasks
 *   GET  /pilot/readiness                  · admin · Pilot readiness check
 *   GET  /control/state                    · admin · Control Panel state
 *   GET  /kpi/employee                     · admin · Employee KPI
 *   GET  /kpi/channel                      · admin · Channel KPI
 *   POST /operators/:userId                · admin · b2c_operator toggle + b2c_channels
 */

const express = require('express');
const router = express.Router();
const { getClient } = require('../../db/supabaseClient');
const { authGuard, requireAdmin } = require('../../middleware/auth');
const nextTask = require('../../services/b2cInventory/nextTask');
const actions = require('../../services/b2cInventory/taskActions');
const pilotReady = require('../../services/b2cInventory/pilotReadiness');
const kpi = require('../../services/b2cInventory/employeeAndChannelKpi');
const events = require('../../services/b2cInventory/executionEvents');

router.use(authGuard);

//   ── My Tasks (직원 · 본인 배정) ───────────────────
router.get('/my-tasks', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
    const db = getClient();
    const result = await nextTask.getMyTasksView(db, req.user.id);
    res.json({ data: result });
  } catch (e) {
    console.error('[b2cWork] my-tasks error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/next-task', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
    const db = getClient();
    const task = await nextTask.getNextTaskForUser(db, req.user.id);
    res.json({ data: task });
  } catch (e) {
    console.error('[b2cWork] next-task error:', e);
    res.status(500).json({ error: e.message });
  }
});

//   ── Task actions ─────────────────────────────────
router.post('/:id/start', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getClient();
    const r = await actions.startTask({ db, taskId: id, user: req.user });
    if (!r.ok) return res.status(r.code === 'NOT_YOUR_TASK' ? 403 : 400).json({ error: r.code, details: r });
    res.json({ data: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getClient();
    //   qc_fail 후 in_progress 인 task 는 resubmit · 그 외는 첫 submit
    const { data: cur } = await db.from('team_tasks').select('qc_status').eq('id', id).maybeSingle();
    const isResubmit = cur && cur.qc_status === 'fail';
    const r = isResubmit
      ? await actions.resubmitTask({ db, taskId: id, user: req.user, body: req.body })
      : await actions.submitTask({ db, taskId: id, user: req.user, body: req.body });
    if (!r.ok) return res.status(r.code === 'NOT_YOUR_TASK' ? 403 : 400).json({ error: r.code, details: r });
    res.json({ data: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/blocked', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getClient();
    const r = await actions.blockTask({ db, taskId: id, user: req.user, body: req.body });
    if (!r.ok) return res.status(r.code === 'NOT_YOUR_TASK' ? 403 : 400).json({ error: r.code, details: r });
    res.json({ data: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

//   ── QC (admin/reviewer) ──────────────────────────
router.post('/:id/qc-pass', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getClient();
    const r = await actions.qcPass({ db, taskId: id, user: req.user });
    if (!r.ok) return res.status(400).json({ error: r.code, details: r });
    res.json({ data: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/qc-fail', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getClient();
    const r = await actions.qcFail({ db, taskId: id, user: req.user, body: req.body });
    if (!r.ok) return res.status(400).json({ error: r.code, details: r });
    res.json({ data: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/qc/queue', requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db.from('team_tasks')
      .select('*').eq('status', 'qc_pending')
      .like('exception_type', 'channel_register.%')
      .order('created_at', { ascending: true }).limit(200);
    if (error) throw error;
    res.json({ data: { count: data?.length || 0, tasks: data || [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

//   ── Pilot readiness + Control Panel + KPI ───────
router.get('/pilot/readiness', requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const size = req.query.size ? Number(req.query.size) : 50;
    const pilotMax = req.query.pilot_max_tasks ? Number(req.query.pilot_max_tasks) : 100;
    const result = await pilotReady.checkPilotReadiness({ db, size, pilotMaxTasks: pilotMax });
    res.json({ data: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/control/state', requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const [{ data: cfgRows }, activeCr, activeDq, doneToday, blockedCount] = await Promise.all([
      db.from('margin_settings').select('setting_key, setting_value').like('setting_key', 'b2c.%'),
      db.from('team_tasks').select('*', { count: 'exact', head: true })
        .in('status', ['pending','in_progress','qc_pending']).like('exception_type', 'channel_register.%'),
      db.from('team_tasks').select('*', { count: 'exact', head: true })
        .in('status', ['pending','in_progress','qc_pending']).eq('exception_type', 'data_quality.cost_missing'),
      db.from('team_tasks').select('*', { count: 'exact', head: true })
        .eq('status', 'done').gte('completed_at', new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
        .like('exception_type', 'channel_register.%'),
      db.from('team_tasks').select('*', { count: 'exact', head: true })
        .eq('status', 'blocked').like('exception_type', 'channel_register.%'),
    ]);
    const cfg = {};
    for (const r of (cfgRows || [])) cfg[r.setting_key.replace(/^b2c\./,'')] = Number(r.setting_value);
    //   status breakdown for channel_register
    const [pendingRes, inProgRes, qcRes] = await Promise.all([
      db.from('team_tasks').select('*', { count: 'exact', head: true }).eq('status', 'pending').like('exception_type', 'channel_register.%'),
      db.from('team_tasks').select('*', { count: 'exact', head: true }).eq('status', 'in_progress').like('exception_type', 'channel_register.%'),
      db.from('team_tasks').select('*', { count: 'exact', head: true }).eq('status', 'qc_pending').like('exception_type', 'channel_register.%'),
    ]);
    res.json({ data: {
      at: new Date().toISOString(),
      config: cfg,
      channel_register: {
        active_total: Number(activeCr.count) || 0,
        pending: Number(pendingRes.count) || 0,
        in_progress: Number(inProgRes.count) || 0,
        qc_pending: Number(qcRes.count) || 0,
        blocked: Number(blockedCount.count) || 0,
        done_today: Number(doneToday.count) || 0,
      },
      data_quality: {
        active_total: Number(activeDq.count) || 0,
      },
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/kpi/employee', requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const sinceDays = req.query.since_days ? Number(req.query.since_days) : 90;
    const result = await kpi.getEmployeeKpi({ db, sinceDays });
    res.json({ data: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/kpi/channel', requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const sinceDays = req.query.since_days ? Number(req.query.since_days) : 90;
    const result = await kpi.getChannelKpi({ db, sinceDays });
    res.json({ data: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

//   ── Operator management (admin only) ─────────────
//   PATCH: { b2c_operator: true/false, b2c_channels: array|null }
router.post('/operators/:userId', requireAdmin, async (req, res) => {
  try {
    const uid = parseInt(req.params.userId, 10);
    if (!Number.isFinite(uid)) return res.status(400).json({ error: 'invalid userId' });
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (typeof b.b2c_operator === 'boolean') patch.b2c_operator = b.b2c_operator;
    //   b2c_channels validation
    if (b.b2c_channels === null) patch.b2c_channels = null;
    else if (Array.isArray(b.b2c_channels)) {
      const KNOWN = new Set(['coupang','naver','11st','gmarket','ebay','shopify','auction','shopee','alibaba','qoo10']);
      const cleaned = [];
      for (const v of b.b2c_channels) {
        if (typeof v !== 'string') return res.status(400).json({ error: 'b2c_channels 원소는 문자열' });
        const norm = v.trim().toLowerCase();
        if (!KNOWN.has(norm)) return res.status(400).json({ error: `unknown channel: ${v}` });
        if (!cleaned.includes(norm)) cleaned.push(norm);
      }
      patch.b2c_channels = cleaned;
    } else if (b.b2c_channels !== undefined) {
      return res.status(400).json({ error: 'b2c_channels 는 배열 또는 null' });
    }
    const { data: before } = await db_getClientBeforeAfter(uid);
    const db = getClient();
    const { data: updated, error } = await db.from('users').update(patch).eq('id', uid)
      .select('id, username, display_name, role, is_active, b2c_operator, b2c_channels').maybeSingle();
    if (error) throw error;
    console.log('[b2cWork] operator toggle', { userId: uid, patch, before, by_user: req.user?.username });
    res.json({ data: updated, before });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function db_getClientBeforeAfter(uid) {
  const db = getClient();
  const { data } = await db.from('users').select('id, username, b2c_operator, b2c_channels').eq('id', uid).maybeSingle();
  return { data };
}

//   List operators (admin)
router.get('/operators', requireAdmin, async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db.from('users')
      .select('id, username, display_name, role, is_active, b2c_operator, b2c_channels')
      .eq('is_active', true).order('id');
    if (error) throw error;
    res.json({ data: { count: data?.length || 0, users: data || [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
