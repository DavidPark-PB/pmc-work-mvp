'use strict';

/**
 * src/web/routes/shippingInternal.js — PMC-CCOREA-SHIPPING-1B correction (2026-09-13),
 * raw-quote contract split (2026-09-14).
 *
 * Server-to-server shipping endpoints for the automation subproject.
 * ALL routes require the SHIPPING_QUOTE_INTERNAL_TOKEN bearer token —
 * admin browser cookies are NOT accepted here.
 *
 *   POST /api/internal/shipping/quote            — RAW shipping cost (auto-listing price input)
 *   POST /api/internal/shipping/listing-preview  — shadow listing-price preview (policy band + margin)
 *   POST /api/internal/shipping/shadow-result    — persist a shadow comparison row
 *
 * /quote contract (automation listing price):
 *   request  { provider, serviceCode, destinationCountry, actualWeightKg,
 *              lengthCm, widthCm, heightCm, saleType, marketplace,
 *              uniqueHsCodeCount?, declaredValueKrw?, eurKrwRate?, quotePurpose? }
 *   response 200 { ok, mode: 'raw', quote: <shippingQuoteService result>, blockedReason }
 *            ok === quote.ok. Policy bands, listing-price and margin formulas are
 *            NOT consulted, so an empty shipping_policy_bands table never blocks a quote.
 *
 * These endpoints intentionally live OUTSIDE the requireAdmin surface used
 * by /api/shipping/rate-admin/*. The two are strictly separated.
 */

const express = require('express');
const router  = express.Router();

const { requireInternalToken } = require('../../middleware/internalToken');
const { getClient }            = require('../../db/supabaseClient');
const quoteService             = require('../../services/shipping/shippingQuoteService');
const adapter                  = require('../../services/shipping/autoListingPricingAdapter');
const recorder                 = require('../../services/shipping/shadowRecorder');

router.use(requireInternalToken);

//   Only shipping-cost inputs reach the quote engine. Listing-price inputs
//   (productCostKrw, platformFeeRate, targetMarginRate, sellingCurrencyKrwRate,
//   shippingPolicyFeeKrw) are dropped so they can never influence a raw quote.
const RAW_QUOTE_FIELDS = [
  'provider', 'serviceCode', 'destinationCountry',
  'actualWeightKg', 'lengthCm', 'widthCm', 'heightCm',
  'saleType', 'marketplace',
  'uniqueHsCodeCount', 'declaredValueKrw', 'eurKrwRate',
];

function pickRawQuoteInput(body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const input = {};
  for (const key of RAW_QUOTE_FIELDS) {
    if (src[key] !== undefined) input[key] = src[key];
  }
  input.quotePurpose = src.quotePurpose === 'FULFILLMENT' ? 'FULFILLMENT' : 'LISTING';
  return input;
}

//   POST /quote — raw shipping cost. READ-only against the DB.
router.post('/quote', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const quote = await quoteService.calculateShippingQuote(pickRawQuoteInput(req.body), { supabase: getClient() });
    const ok = !!(quote && quote.ok === true);
    res.json({
      ok,
      mode: 'raw',
      quote,
      blockedReason: ok ? null : (quote && quote.blockedReason) || 'QUOTE_BLOCKED',
    });
  } catch (e) {
    console.error('[shippingInternal] quote failed:', e.message);
    res.status(500).json({ ok: false, error: 'internal_quote_failed' });
  }
});

//   POST /listing-preview — shadow auto-listing preview (quote + policy band +
//   listing price formula). READ-only against the DB.
router.post('/listing-preview', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const out = await adapter.buildAutoListingPreview(req.body || {}, { supabase: getClient() });
    res.json(out);
  } catch (e) {
    console.error('[shippingInternal] listing-preview failed:', e.message);
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
module.exports.pickRawQuoteInput = pickRawQuoteInput;
