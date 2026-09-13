'use strict';

/**
 * src/web/routes/shippingInternal.js — PMC-CCOREA-SHIPPING-1B correction (2026-09-13).
 *
 * Server-to-server shipping endpoints for the automation subproject.
 * ALL routes require the SHIPPING_QUOTE_INTERNAL_TOKEN bearer token —
 * admin browser cookies are NOT accepted here.
 *
 *   POST /api/internal/shipping/quote          — one-shot listing preview
 *   POST /api/internal/shipping/shadow-result  — persist a shadow comparison row
 *
 * These endpoints intentionally live OUTSIDE the requireAdmin surface used
 * by /api/shipping/rate-admin/*. The two are strictly separated.
 */

const express = require('express');
const router  = express.Router();

const { requireInternalToken } = require('../../middleware/internalToken');
const { getClient }            = require('../../db/supabaseClient');
const adapter                  = require('../../services/shipping/autoListingPricingAdapter');
const recorder                 = require('../../services/shipping/shadowRecorder');

router.use(requireInternalToken);

//   POST /quote — dry-run auto-listing preview. READ-only against the DB.
router.post('/quote', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const out = await adapter.buildAutoListingPreview(req.body || {}, { supabase: getClient() });
    res.json(out);
  } catch (e) {
    console.error('[shippingInternal] quote failed:', e.message);
    res.status(500).json({ ok: false, error: 'internal_quote_failed' });
  }
});

//   POST /shadow-result — write the legacy-vs-new comparison for owner review.
//   Idempotent on (listing_job_id, product_ref) — a duplicate POST is a no-op.
router.post('/shadow-result', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const out = await recorder.recordShadowResult(req.body || {}, { supabase: getClient() });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[shippingInternal] shadow-result failed:', e.message);
    res.status(500).json({ ok: false, error: 'shadow_write_failed' });
  }
});

module.exports = router;
