/**
 * 인앱 알림 API — 본인 알림만 접근
 */
const express = require('express');
const { getClient } = require('../../db/supabaseClient');
const { requireAdmin } = require('../../middleware/auth');
const scheduler = require('../../services/scheduler');

const router = express.Router();

/** POST /api/notifications/trigger/morning — 관리자 수동 실행 (일일 다이제스트) */
router.post('/trigger/morning', requireAdmin, async (req, res) => {
  try {
    const result = await scheduler.sendMorningDigest();
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/notifications/trigger/evening — 관리자 수동 실행 */
router.post('/trigger/evening', requireAdmin, async (req, res) => {
  try {
    const result = await scheduler.sendEveningOwnerSummary();
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const { unreadOnly } = req.query;
    let q = getClient()
      .from('notifications')
      .select('*')
      .eq('recipient_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (unreadOnly === '1' || unreadOnly === 'true') q = q.eq('is_read', false);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/unread-count', async (req, res) => {
  try {
    const { count, error } = await getClient()
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', req.user.id)
      .eq('is_read', false);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: existing, error: e1 } = await getClient()
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .maybeSingle();
    if (e1) throw e1;
    if (!existing) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });
    if (existing.recipient_id !== req.user.id) return res.status(403).json({ error: '권한이 없습니다' });

    const { error: e2 } = await getClient()
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id);
    if (e2) throw e2;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/read-all', async (req, res) => {
  try {
    const { error } = await getClient()
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('recipient_id', req.user.id)
      .eq('is_read', false);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
