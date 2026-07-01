/**
 * src/web/routes/hermesExecutionRequests.js — Hermes execution request read-only API (Phase 5F)
 *
 * Routes:
 *   GET /api/hermes-execution/summary?limit=50
 *   GET /api/hermes-execution/requests?status=approved&sku=<SKU>&limit=20
 *   GET /api/hermes-execution/requests/:id
 *   GET /api/hermes-execution/requests/:id/events?limit=20
 *
 * Policy:
 *   - requireAuth for normal protected API access
 *   - read-only only: no approval/rejection/cancellation/execution actions
 *   - no DB writes, marketplace APIs, price/inventory/listing changes, AI calls, or schedulers
 *   - do not log request bodies or metadata blobs
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const {
  summarizeExecutionRequests,
  listExecutionRequests,
  getExecutionRequestDetail,
  listExecutionEvents,
} = require('../../services/hermesExecutionApproval');

const router = express.Router();

router.use(requireAuth);

function intParam(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusForError(err) {
  const message = err?.message || '';
  if (/id is required|invalid id|invalid .*limit/i.test(message)) return 400;
  if (/invalid status|invalid risk_level|invalid execution_type/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

// Log only route/action, user id, code, and short message. Never log request body or metadata blobs.
function logErr(action, req, err) {
  console.error('[hermesExecutionRequests] ' + action + ' error:', {
    userId: req.user?.id,
    code: err?.code,
    message: err?.message,
  });
}

function sendError(res, err) {
  res.status(statusForError(err)).json({
    error: err?.message || 'unknown error',
    code: err?.code || 'unknown',
    read_only: true,
  });
}

// GET /api/hermes-execution/summary?limit=50
router.get('/summary', async (req, res) => {
  try {
    const data = await summarizeExecutionRequests({
      limit: req.query?.limit || 50,
    });
    res.json({ data, read_only: true });
  } catch (e) {
    logErr('summary', req, e);
    sendError(res, e);
  }
});

// GET /api/hermes-execution/requests?status=approved&sku=<SKU>&limit=20
router.get('/requests', async (req, res) => {
  try {
    const data = await listExecutionRequests({
      status: req.query?.status || null,
      sku: req.query?.sku || null,
      limit: req.query?.limit || 20,
    });
    res.json({ data, read_only: true });
  } catch (e) {
    logErr('requests-list', req, e);
    sendError(res, e);
  }
});

// GET /api/hermes-execution/requests/:id
router.get('/requests/:id', async (req, res) => {
  try {
    const requestId = intParam(req.params.id);
    if (requestId == null) return res.status(400).json({ error: 'invalid id', read_only: true });
    const data = await getExecutionRequestDetail({ requestId });
    res.json({ data, read_only: true });
  } catch (e) {
    logErr('requests-detail', req, e);
    sendError(res, e);
  }
});

// GET /api/hermes-execution/requests/:id/events?limit=20
router.get('/requests/:id/events', async (req, res) => {
  try {
    const requestId = intParam(req.params.id);
    if (requestId == null) return res.status(400).json({ error: 'invalid id', read_only: true });
    const data = await listExecutionEvents({
      requestId,
      limit: req.query?.limit || 20,
    });
    res.json({ data, read_only: true });
  } catch (e) {
    logErr('requests-events', req, e);
    sendError(res, e);
  }
});

module.exports = router;
