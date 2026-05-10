/**
 * src/web/routes/opportunityDrafts.js — AI Draft Generator API (PR R1)
 *
 * 라우트:
 *   POST   /api/opportunity-drafts         body: { opportunity_id, platform, language } — admin only
 *   GET    /api/opportunity-drafts?opportunity_id=N
 *   GET    /api/opportunity-drafts/:id
 *   POST   /api/opportunity-drafts/:id/approve   — admin only
 *
 * 권한:
 *   - 생성 / approve = admin only (cost 통제 + 콘텐츠 책임)
 *   - 조회 = 로그인 사용자 누구나 (단순 read)
 *
 * 정책:
 *   - 외부 API key / response token / raw 응답 절대 출력 X
 *   - request body 전체 console 출력 금지
 *   - schema/migration 변경 0
 *   - safetyExec audit 는 service 단에서 자동
 */
'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const aiDraft = require('../../services/aiDraftGenerator');

const router = express.Router();

router.use(requireAuth);

// service 에러 코드 → HTTP status
function statusForError(err) {
  switch (err?.code) {
    case 'aiDraft/validation':          return 400;
    case 'aiDraft/usage_cap_exceeded':  return 429;
    case 'aiDraft/config_error':        return 503;
    case 'aiDraft/provider_failed':     return 502;
    default:                             return 500;
  }
}

function logErr(action, req, err) {
  console.error('[opportunityDrafts] ' + action + ' error:', {
    userId:  req.user?.id,
    code:    err?.code,
    message: err?.message,
  });
}

// POST /api/opportunity-drafts — admin only
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { opportunity_id, platform, language } = req.body || {};
    const result = await aiDraft.generateDraft({
      user: req.user,
      opportunityId: parseInt(opportunity_id, 10),
      platform,
      language,
    });
    res.status(201).json({
      data: result.draft,
      cost_usd: result.costUsd,
      mock: result.mock,
    });
  } catch (e) {
    logErr('generate', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// GET /api/opportunity-drafts?opportunity_id=N
router.get('/', async (req, res) => {
  try {
    const opportunityId = parseInt(req.query.opportunity_id, 10);
    if (!Number.isFinite(opportunityId)) {
      return res.status(400).json({ error: 'opportunity_id required' });
    }
    const data = await aiDraft.listDrafts({ user: req.user, opportunityId });
    res.json({ data });
  } catch (e) {
    logErr('list', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// GET /api/opportunity-drafts/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await aiDraft.getDraft({ user: req.user, id });
    res.json({ data });
  } catch (e) {
    logErr('get', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

// POST /api/opportunity-drafts/:id/approve — admin only
router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await aiDraft.approveDraft({ user: req.user, id });
    res.json({ data });
  } catch (e) {
    logErr('approve', req, e);
    res.status(statusForError(e)).json({ error: e.message, code: e.code || 'unknown' });
  }
});

module.exports = router;
