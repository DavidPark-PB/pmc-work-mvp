/**
 * src/services/oms/replacementLandedCost.js — Phase 7C.
 *
 * Convert a normalized supplier offer into a KRW-native per-physical-unit
 * product cost + attempt a landed-cost estimate.
 *
 *   PRODUCT COST      = quoted_price_per_physical_unit (source-currency → KRW)
 *   LANDED COST       = product + freight + duty + tax + fees   (all KRW)
 *
 * If ANY landed-cost component is unavailable, `landed_cost.status='INCOMPLETE'`
 * and `landed_cost.amount=null`. NEVER substitute 0 (Owner Part F).
 *
 * FX conversion is provenance-aware: source_currency / target_currency /
 * fx_rate / fx_source / fx_observed_at (Owner Part G).
 */
'use strict';

/**
 * @param {Object} normalizedOffer  output of replacementOfferNormalizer.normalizeOffer
 * @param {Object} opts
 * @param {number} opts.usdKrw                   KRW per 1 USD (from getPricingSafetyExchangeRate)
 * @param {string} opts.usdKrwSource             e.g. 'pricing_safety_sot'
 * @param {string} opts.usdKrwObservedAt         ISO
 * @param {number|null} [opts.freightKrwPerOffer]        optional real freight
 * @param {number|null} [opts.dutyKrwPerOffer]           optional duty
 * @param {number|null} [opts.taxKrwPerOffer]            optional VAT / tax
 * @param {number|null} [opts.feesKrwPerOffer]           optional payment / forwarding fees
 * @param {number|null} [opts.krwJpyRate]                additional FX if source currency is JPY
 */
function computeReplacementLandedCost(normalizedOffer, opts = {}) {
  const currency = String(normalizedOffer.currency || '').toUpperCase();
  const perOffer = Number(normalizedOffer.quoted_price_per_offer);
  const perPhysical = Number(normalizedOffer.quoted_price_per_physical_unit);
  const physicalUnits = Number(normalizedOffer.physical_units_per_offer) || 0;

  const fx = _resolveFx(currency, opts);
  let productCostKrwPerOffer = null;
  let productCostKrwPerPhysical = null;
  const productCostMissing = [];

  if (!Number.isFinite(perOffer) || perOffer <= 0) productCostMissing.push('quoted_price_per_offer');
  if (physicalUnits <= 0) productCostMissing.push('physical_units_per_offer');
  if (!fx.available) productCostMissing.push(`fx_${currency}_to_KRW`);

  if (productCostMissing.length === 0) {
    productCostKrwPerOffer = perOffer * fx.rate;
    productCostKrwPerPhysical = productCostKrwPerOffer / physicalUnits;
    productCostKrwPerOffer = Math.round(productCostKrwPerOffer * 100) / 100;
    productCostKrwPerPhysical = Math.round(productCostKrwPerPhysical * 100) / 100;
  }

  // Landed cost — every input must be present or status = INCOMPLETE
  const landedMissing = [];
  const freight = _numOrNull(opts.freightKrwPerOffer);
  const duty    = _numOrNull(opts.dutyKrwPerOffer);
  const tax     = _numOrNull(opts.taxKrwPerOffer);
  const fees    = _numOrNull(opts.feesKrwPerOffer);
  if (productCostKrwPerOffer == null) landedMissing.push('product_cost_krw');
  if (freight == null) landedMissing.push('freight_krw');
  if (duty    == null) landedMissing.push('duty_krw');
  if (tax     == null) landedMissing.push('tax_krw');
  if (fees    == null) landedMissing.push('fees_krw');

  let landedTotalKrwPerOffer = null;
  let landedTotalKrwPerPhysical = null;
  let landedStatus = 'INCOMPLETE';
  if (landedMissing.length === 0) {
    landedTotalKrwPerOffer = productCostKrwPerOffer + freight + duty + tax + fees;
    landedTotalKrwPerPhysical = landedTotalKrwPerOffer / physicalUnits;
    landedTotalKrwPerOffer = Math.round(landedTotalKrwPerOffer * 100) / 100;
    landedTotalKrwPerPhysical = Math.round(landedTotalKrwPerPhysical * 100) / 100;
    landedStatus = 'COMPLETE';
  }

  return {
    product_cost: {
      status: productCostMissing.length === 0 ? 'AVAILABLE' : 'UNKNOWN',
      amount_krw_per_offer: productCostKrwPerOffer,
      amount_krw_per_physical: productCostKrwPerPhysical,
      source_currency: currency,
      source_quoted_price_per_offer: normalizedOffer.quoted_price_per_offer ?? null,
      source_quoted_price_per_physical: normalizedOffer.quoted_price_per_physical_unit ?? null,
      fx: fx.available ? {
        source_currency: currency,
        target_currency: 'KRW',
        fx_rate: fx.rate,
        fx_source: fx.source,
        fx_observed_at: fx.observed_at,
      } : null,
      missing: productCostMissing,
    },
    landed_cost: {
      status: landedStatus,   // 'COMPLETE' | 'INCOMPLETE'
      amount_krw_per_offer: landedTotalKrwPerOffer,
      amount_krw_per_physical: landedTotalKrwPerPhysical,
      components: {
        product_cost_krw: productCostKrwPerOffer,
        freight_krw: freight,
        duty_krw: duty,
        tax_krw: tax,
        fees_krw: fees,
      },
      missing: landedMissing,
    },
  };
}

function _resolveFx(currency, opts) {
  const c = String(currency || '').toUpperCase();
  if (c === 'KRW') {
    return { available: true, rate: 1, source: 'identity', observed_at: opts.usdKrwObservedAt || null };
  }
  if (c === 'USD') {
    if (opts.usdKrw && Number(opts.usdKrw) > 0) {
      return { available: true, rate: Number(opts.usdKrw), source: opts.usdKrwSource || 'pricing_safety_sot', observed_at: opts.usdKrwObservedAt || null };
    }
  }
  if (c === 'JPY' && opts.krwJpyRate && Number(opts.krwJpyRate) > 0) {
    return { available: true, rate: Number(opts.krwJpyRate), source: 'caller_provided', observed_at: opts.usdKrwObservedAt || null };
  }
  if (c === 'CNY' && opts.krwCnyRate && Number(opts.krwCnyRate) > 0) {
    return { available: true, rate: Number(opts.krwCnyRate), source: 'caller_provided', observed_at: opts.usdKrwObservedAt || null };
  }
  return { available: false, rate: null, source: null, observed_at: null };
}

function _numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { computeReplacementLandedCost };
