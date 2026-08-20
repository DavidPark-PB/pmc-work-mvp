'use strict';

/**
 * omsIngestionFreshness.js — Phase 8P-20.
 *
 * Admin-only READ-ONLY dashboard route.
 * GET /admin/oms/ingestion-freshness
 *   → JSON list of per-channel freshness state:
 *     [{ channel, status, last_success_at, last_attempt_at, last_error,
 *        cadence_minutes, overlap_minutes, consecutive_failures,
 *        lag_minutes, stale_threshold_minutes, is_stale }]
 *
 * No mutation endpoints in this route.
 */

const express = require('express');
const { listFreshness } = require('../../services/oms/ingestionStateService');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const rows = await listFreshness();
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      channels: rows,
      any_stale: rows.some(r => r.is_stale || r.status === 'stale' || r.status === 'auth_failed'),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message.slice(0, 300) : String(e).slice(0, 300) });
  }
});

module.exports = router;
