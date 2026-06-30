/**
 * src/web/routes/opportunityInbox.js — Opportunity Inbox API (PR R0)
 *
 * 라우트:
 *   POST    /api/opportunity-inbox            후보 생성 (직원/admin)
 *   GET     /api/opportunity-inbox            목록 (staff: 본인 only, admin: 전체)
 *   GET     /api/opportunity-inbox/:id        단건 (staff: 본인 only)
 *   PATCH   /api/opportunity-inbox/:id        수정 (staff: notes 등 일부, admin: 모든 필드)
 *   POST    /api/opportunity-inbox/:id/approve  admin only
 *   POST    /api/opportunity-inbox/:id/reject   admin only (body: { reason })
 *
 * 권한: requireAuth (staff/admin 모두 진입 — service 단에서 user.isAdmin 분기)
 *
 * 정책:
 *   - console.log 로 req.body 전체 출력 금지
 *   - metadata / token / secret / password / raw_payload 출력 금지
 *   - 외부 API 호출 0 (eBay/Shopify/Telegram/Kakao/Alibaba 등)
 *   - schema / migration / Safety Foundation 무수정
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const opp = require('../../services/opportunityInbox');

const router = express.Router();

router.use(requireAuth);

// service 에러 코드 → HTTP status
function statusForError(err) {
  if (err?.code === 'opportunityInbox/validation') return 400;
  if (err?.code === 'opportunityInbox/not_found')  return 404;
  if (err?.code === 'opportunityInbox/forbidden')  return 403;
  return 500;
}

// 로그 룰: actionName / userId / message / err.code 만. body / metadata 출력 금지.
function logErr(action, req, err) {
  console.error('[opportunityInbox] ' + action + ' error:', {
    userId:  req.user?.id,
    code:    err?.code,
    message: err?.message,
  });
}

// POST /api/opportunity-inbox
router.post('/', async (req, res) => {
  try {
    const data = await opp.createOpportunity({ user: req.user, body: req.body || {} });
    res.status(201).json({ data });
  } catch (e) {
    logErr('create', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// GET /api/opportunity-inbox
router.get('/', async (req, res) => {
  try {
    const data = await opp.listOpportunities({ user: req.user, filters: req.query || {} });
    res.json({ data });
  } catch (e) {
    logErr('list', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// GET /api/opportunity-inbox/hermes — Hermes-generated review rows only
router.get('/hermes', async (req, res) => {
  try {
    const data = await opp.listHermesOpportunities({
      sku: req.query?.sku,
      status: req.query?.status,
      opportunity_type: req.query?.opportunity_type || req.query?.type,
      limit: req.query?.limit || 100,
    });
    res.json(data);
  } catch (e) {
    logErr('hermes-list', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// POST /api/opportunity-inbox/hermes/:id/review — review-only Hermes status action
router.post('/hermes/:id/review', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const data = await opp.reviewHermesOpportunity({
      id,
      action: req.body?.action,
      reason: req.body?.reason,
      reviewed_by: req.user?.id,
      dryRun: req.body?.dry_run === true,
    });
    res.json(data);
  } catch (e) {
    logErr('hermes-review', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// GET /api/opportunity-inbox/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const data = await opp.getOpportunity({ user: req.user, id });
    res.json({ data });
  } catch (e) {
    logErr('get', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// PATCH /api/opportunity-inbox/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const data = await opp.updateOpportunity({ user: req.user, id, body: req.body || {} });
    res.json({ data });
  } catch (e) {
    logErr('update', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// POST /api/opportunity-inbox/:id/approve  (admin only — service 단 가드)
router.post('/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const data = await opp.approveOpportunity({ user: req.user, id });
    res.json({ data });
  } catch (e) {
    logErr('approve', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// POST /api/opportunity-inbox/:id/reject  (admin only)
router.post('/:id/reject', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const reason = req.body?.reason;
    const data = await opp.rejectOpportunity({ user: req.user, id, reason });
    res.json({ data });
  } catch (e) {
    logErr('reject', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

module.exports = router;
