'use strict';

/**
 * src/services/shipping/shadowRecorder.js — PMC-CCOREA-SHIPPING-1B correction (2026-09-13).
 *
 * Writes one row per (listing_job_id, product_ref) into
 * shipping_quote_shadow_results (mig 115). Failure is caught by the caller —
 * this file only throws in truly exceptional cases (bad supabase client).
 *
 * Redacts nothing on its own: the caller is responsible for stripping
 * secrets from `calculation_details` before invoking.
 */

const { getClient } = require('../../db/supabaseClient');

//   Payload contract (matches migration 115 columns).
//     · legacyListingPrice / newListingPrice: KRW numeric or null
//     · difference is computed if both sides present, else null
//     · calculation_details expected to be a JSON-safe object
async function recordShadowResult(input, opts = {}) {
  const db = opts.supabase || getClient();
  const {
    listingJobId,
    productRef,
    marketplace,
    destinationCountry = null,
    legacyListingPrice   = null,
    newListingPrice      = null,
    legacyShippingCost   = null,
    newShippingCost      = null,
    chargeableWeightKg   = null,
    serviceCode          = null,
    rateVersionId        = null,
    policyBandId         = null,
    status               = 'ok',
    blockedReason        = null,
    calculationDetails   = {},
  } = input || {};

  if (!listingJobId || !productRef || !marketplace) {
    throw new Error('recordShadowResult: listingJobId, productRef, marketplace required');
  }
  const legacy = _num(legacyListingPrice);
  const neu    = _num(newListingPrice);
  const diffAmount = (legacy != null && neu != null) ? Math.round((neu - legacy) * 100) / 100 : null;
  const diffPct    = (legacy != null && legacy !== 0 && neu != null)
    ? Math.round(((neu - legacy) / legacy) * 10000) / 10000
    : null;

  const payload = {
    listing_job_id:       String(listingJobId).slice(0, 200),
    product_ref:          String(productRef).slice(0, 200),
    marketplace:          String(marketplace).slice(0, 50),
    destination_country:  destinationCountry ? String(destinationCountry).slice(0, 2).toUpperCase() : null,
    legacy_listing_price: legacy,
    new_listing_price:    neu,
    difference_amount:    diffAmount,
    difference_pct:       diffPct,
    legacy_shipping_cost: _num(legacyShippingCost),
    new_shipping_cost:    _num(newShippingCost),
    chargeable_weight_kg: _num(chargeableWeightKg),
    service_code:         serviceCode ? String(serviceCode).slice(0, 50) : null,
    rate_version_id:      _int(rateVersionId),
    policy_band_id:       _int(policyBandId),
    status:               status === 'blocked' ? 'blocked' : 'ok',
    blocked_reason:       blockedReason ? String(blockedReason).slice(0, 80) : null,
    calculation_details:  calculationDetails || {},
  };

  //   Idempotency: unique (listing_job_id, product_ref). Use upsert semantics
  //   by INSERT ... ON CONFLICT DO NOTHING (Supabase 'onConflict' shortcut).
  const r = await db
    .from('shipping_quote_shadow_results')
    .upsert(payload, { onConflict: 'listing_job_id,product_ref', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  if (r.error) {
    //   Wrap the Supabase error object in a real Error so downstream error
    //   handling (assert.rejects / console.error / try-catch) sees a message
    //   string. The caller (automation subproject) must still swallow this
    //   so a shadow-write failure NEVER fails the listing flow.
    const err = new Error(r.error.message || String(r.error));
    err.cause = r.error;
    throw err;
  }
  return { id: r.data ? r.data.id : null, deduped: !r.data };
}

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _int(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = { recordShadowResult };
