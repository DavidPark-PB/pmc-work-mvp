'use strict';

/**
 * src/services/oms/financialMetricsOrchestrator.js — Phase 8O.
 *
 * Assembles the input bag for buildFinancialMetrics(ownerDecision, opts).
 *
 * Priority (Owner rule §5):
 *   1. Manual override (Owner-supplied opts.expected_sale_price_krw / _shipping_krw)
 *   2. Auto observation (salePriceObservationService · shippingCandidateService)
 *   3. UNKNOWN
 *
 * SAFETY:
 *   • Zero DB writes · zero marketplace calls · zero notification sends
 *   • Uses caller-supplied db so tests inject a stub
 *   • Secondary market ask is NEVER used as sale-price fallback
 *   • FX unavailable / freshness UNKNOWN / listing not ACTIVE → still
 *     surfaces the observation but flags it in the resolution audit so
 *     the caller can decide whether to trust it downstream
 */

const salePriceSvc = require('./salePriceObservationService');
const shippingSvc = require('./shippingCandidateService');
const soldPriceSvc = require('./recentSoldPriceService');
const { buildFinancialMetrics } = require('./financialMetricsAssembler');

/**
 * @param {Object} args
 * @param {Object} args.ownerDecision                 result of buildOwnerDecision
 * @param {Object} args.db                             Supabase-like client
 * @param {Object} [args.manual]                       Owner manual override
 * @param {number|null} [args.manual.expected_sale_price_krw]
 * @param {string|null} [args.manual.expected_sale_price_source]
 * @param {number|null} [args.manual.seller_borne_shipping_krw]
 * @param {string|null} [args.manual.shipping_source]
 * @param {number|null} [args.manual.marketplace_fee_pct]
 * @param {number|null} [args.manual.marketplace_fixed_fee_krw]
 * @param {Object} [args.autoSalePriceOpts]           passed to salePriceObservationService
 * @param {Object} [args.autoShippingOpts]            passed to shippingCandidateService
 * @param {boolean} [args.autoDisabled=false]         short-circuit auto observations
 * @returns {Promise<Object>} {
 *   financial_metrics: {...},                        result of buildFinancialMetrics
 *   inputs_resolution: {sale_price, shipping},       audit trail
 * }
 */
async function buildFinancialMetricsWithAutoInputs(args = {}) {
  const {
    ownerDecision, db,
    manual = {}, autoSalePriceOpts = {}, autoShippingOpts = {},
    autoDisabled = false,
  } = args;
  if (!ownerDecision || typeof ownerDecision !== 'object') {
    throw new Error('buildFinancialMetricsWithAutoInputs: ownerDecision required');
  }
  const physicalId = ownerDecision.physical_product_id;

  // ── Sale price resolution ──────────────────────────
  const salePriceResolution = await _resolveSalePrice({
    manual, physicalId, db,
    disabled: autoDisabled || !db,
    autoOpts: autoSalePriceOpts,
  });

  // ── Shipping resolution ───────────────────────────
  const shippingResolution = await _resolveShipping({
    manual, physicalId, db,
    disabled: autoDisabled || !db,
    autoOpts: autoShippingOpts,
  });

  const financial_metrics = buildFinancialMetrics(ownerDecision, {
    expected_sale_price_krw: salePriceResolution.value,
    expected_sale_price_source: salePriceResolution.source,
    seller_borne_shipping_krw: shippingResolution.value,
    shipping_source: shippingResolution.source,
    marketplace_fee_pct: _finiteOrNull(manual.marketplace_fee_pct),
    marketplace_fixed_fee_krw: _finiteOrNull(manual.marketplace_fixed_fee_krw),
  });

  return {
    financial_metrics,
    inputs_resolution: {
      sale_price: salePriceResolution,
      shipping: shippingResolution,
    },
  };
}

async function _resolveSalePrice({ manual, physicalId, db, disabled, autoOpts }) {
  //   Priority (Phase 8P Owner Part 7):
  //     1. MANUAL              (Owner-typed sale price)
  //     2. RECENT_SOLD_MEDIAN  (canonical completed-sales evidence)
  //     3. OBSERVED_LISTING    (ebay_products.price_usd candidate)
  //     4. UNKNOWN
  //   Secondary market ask is NEVER a sale-price candidate here.

  const manualVal = _finiteOrNull(manual.expected_sale_price_krw);
  if (manualVal != null && manualVal > 0) {
    return {
      resolution: 'MANUAL',
      value: manualVal,
      source: manual.expected_sale_price_source || 'owner_manual',
      auto_observation: null,
      candidates_seen: [],
      note: 'Owner manual override (priority 1 · Owner rule §5)',
    };
  }
  if (disabled || !Number.isInteger(physicalId) || physicalId <= 0) {
    return {
      resolution: 'UNKNOWN',
      value: null, source: null,
      auto_observation: null,
      candidates_seen: [],
      note: disabled ? 'auto observations disabled by caller' : 'physicalProductId missing',
    };
  }

  //   Phase 8P · Try SOLD MEDIAN first (stronger evidence than listing)
  let sold;
  try {
    sold = await soldPriceSvc.getRecentSoldPriceCandidate({
      physicalProductId: physicalId, db,
      usdKrw: autoOpts.usdKrw ?? null,
      usdKrwSource: autoOpts.usdKrwSource ?? null,
      usdKrwObservedAt: autoOpts.usdKrwObservedAt ?? null,
      krwJpyRate: autoOpts.krwJpyRate ?? null,
      krwCnyRate: autoOpts.krwCnyRate ?? null,
      lookbackDays: autoOpts.soldLookbackDays,
      minSamples: autoOpts.soldMinSamples,
      channels: autoOpts.soldChannels,
    });
  } catch (err) {
    sold = { status: 'UNKNOWN', reason: `sold_service_error:${err.message}` };
  }
  if (sold.status === soldPriceSvc.CANDIDATE_STATUS.RECENT_SOLD_PRICE_MEDIAN && sold.value != null) {
    return {
      resolution: 'AUTO_SOLD_MEDIAN',
      value: sold.value,
      source: `recent_sold_median:${sold.sample_count}_samples`,
      auto_observation: sold,
      candidates_seen: [{ type: 'RECENT_SOLD_PRICE_MEDIAN', status: sold.status, value: sold.value }],
      note: `RECENT SOLD MEDIAN · ${sold.sample_count} completed sales · last ${sold.lookback_days}d · confidence=${sold.confidence} · one observation per line (not weighted by qty)`,
    };
  }

  //   Fallback · OBSERVED LISTING PRICE (asking price only)
  let obs;
  try {
    obs = await salePriceSvc.observeSalePriceCandidate({ physicalProductId: physicalId, db, ...autoOpts });
  } catch (err) {
    return {
      resolution: 'UNKNOWN', value: null, source: null,
      auto_observation: { error: err.message },
      candidates_seen: [{ type: 'RECENT_SOLD_PRICE_MEDIAN', status: sold?.status || 'UNKNOWN', reason: sold?.reason }],
      note: 'auto observation threw',
    };
  }
  if (obs.status === salePriceSvc.CANDIDATE_STATUS.OBSERVED_LISTING_PRICE && obs.amount_krw != null) {
    return {
      resolution: 'AUTO_OBSERVED',
      value: obs.amount_krw,
      source: `ebay_listing:${obs.listing_id || 'unknown'}`,
      auto_observation: obs,
      candidates_seen: [
        { type: 'RECENT_SOLD_PRICE_MEDIAN', status: sold?.status || 'UNKNOWN', reason: sold?.reason || null },
        { type: 'OBSERVED_LISTING_PRICE', status: obs.status, value: obs.amount_krw },
      ],
      note: `Fallback: OBSERVED_LISTING_PRICE · freshness=${obs.freshness_status} · listing_status=${obs.listing_status || 'unknown'} · NOT a verified sale price · reason sold median unavailable: ${sold?.reason || 'unknown'}`,
    };
  }
  return {
    resolution: 'UNKNOWN',
    value: null, source: null,
    auto_observation: obs,
    candidates_seen: [
      { type: 'RECENT_SOLD_PRICE_MEDIAN', status: sold?.status || 'UNKNOWN', reason: sold?.reason || null },
      { type: 'OBSERVED_LISTING_PRICE', status: obs.status, reason: obs.reason || null },
    ],
    note: `no auto sale-price candidate available (sold=${sold?.reason || 'unknown'} · listing=${obs.reason || 'unknown'})`,
  };
}

async function _resolveShipping({ manual, physicalId, db, disabled, autoOpts }) {
  const manualVal = _finiteOrNull(manual.seller_borne_shipping_krw);
  if (manualVal != null && manualVal >= 0) {
    return {
      resolution: 'MANUAL',
      value: manualVal,
      source: manual.shipping_source || 'owner_manual',
      auto_observation: null,
      note: 'Owner manual override (priority 1)',
    };
  }
  if (disabled || !Number.isInteger(physicalId) || physicalId <= 0) {
    return {
      resolution: 'UNKNOWN',
      value: null, source: null,
      auto_observation: null,
      note: disabled ? 'auto observations disabled by caller' : 'physicalProductId missing',
    };
  }
  let cand;
  try {
    cand = await shippingSvc.assembleShippingCandidate({ physicalProductId: physicalId, db, ...autoOpts });
  } catch (err) {
    return { resolution: 'UNKNOWN', value: null, source: null, auto_observation: { error: err.message }, note: 'auto shipping threw' };
  }
  if (cand.status === shippingSvc.CANDIDATE_STATUS.ESTIMATED && cand.amount_krw != null) {
    return {
      resolution: 'AUTO_ESTIMATED',
      value: cand.amount_krw,
      source: `${cand.rate_engine}:${cand.carrier || 'unknown'}`,
      auto_observation: cand,
      note: `ESTIMATED · rate_engine=${cand.rate_engine} · destination=${cand.destination_country}`,
    };
  }
  return {
    resolution: 'UNKNOWN',
    value: null, source: null,
    auto_observation: cand,
    note: `no auto shipping candidate (reason=${cand.reason || 'unknown'})`,
  };
}

function _finiteOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  buildFinancialMetricsWithAutoInputs,
};
