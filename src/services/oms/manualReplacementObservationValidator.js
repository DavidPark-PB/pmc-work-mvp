/**
 * src/services/oms/manualReplacementObservationValidator.js — Phase 7C-4 · pure.
 *
 * Validate the manual staff-quote contract BEFORE the ingestor runs.
 * Reject silently-repairable inputs (Owner §3). Never fabricates values.
 */
'use strict';

const AVAILABILITY_ENUM = Object.freeze(['in_stock', 'limited', 'preorder', 'out_of_stock', 'unknown']);
const PRICE_BASIS_ENUM  = Object.freeze(['per_physical_unit', 'per_offer', 'per_box', 'per_case']);
const CURRENCY_MIN_LEN = 3;   // ISO-4217 3-letter (KRW/USD/CNY/JPY/…)
const { EVIDENCE_TYPE_ENUM, SOURCE_CLASS_ENUM } = require('./replacementEvidenceTypes');

const DEFAULT_FUTURE_TOLERANCE_MS = 60 * 60_000;   // 1h clock skew allowance

/**
 * @param {Object} obs        — manual observation input (see contract in Owner Part 2)
 * @param {Object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {number} [opts.futureToleranceMs=DEFAULT_FUTURE_TOLERANCE_MS]
 */
function validateManualObservation(obs, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const futTolMs = opts.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS;
  const errors = [];

  if (!obs || typeof obs !== 'object') {
    return { ok: false, errors: ['obs required object'] };
  }

  if (!Number.isInteger(obs.physicalProductId) || obs.physicalProductId <= 0) {
    errors.push('physicalProductId must be positive integer');
  }
  if (!obs.source || typeof obs.source !== 'string') errors.push('source required string');
  // 7C-6 (Owner §1/§6): SECONDARY_MARKET_ASK does not require supplier master —
  // the marketplace name (source) is the identity. supplierName remains optional
  // for a seller alias. Every other evidence type still requires supplierName.
  if (obs.evidenceType !== 'SECONDARY_MARKET_ASK') {
    if (!obs.supplierName || typeof obs.supplierName !== 'string') {
      errors.push('supplierName required string (unless evidenceType=SECONDARY_MARKET_ASK)');
    }
  }

  // currency
  if (!obs.currency || typeof obs.currency !== 'string' || obs.currency.trim().length < CURRENCY_MIN_LEN) {
    errors.push('currency required (ISO-4217 3-letter)');
  }

  // price
  const price = Number(obs.quotedPrice);
  if (!Number.isFinite(price) || price <= 0) errors.push('quotedPrice must be positive number');

  // price_basis whitelist
  if (!obs.priceBasis || !PRICE_BASIS_ENUM.includes(obs.priceBasis)) {
    errors.push(`priceBasis must be one of ${PRICE_BASIS_ENUM.join('/')}`);
  }

  // physical_units_per_offer
  const units = Number(obs.physicalUnitsPerOffer);
  if (!Number.isInteger(units) || units <= 0) errors.push('physicalUnitsPerOffer must be positive integer');

  // MOQ (optional but must be positive if provided)
  if (obs.minimumOrderQuantity != null) {
    const moq = Number(obs.minimumOrderQuantity);
    if (!Number.isFinite(moq) || moq <= 0 || !Number.isInteger(moq)) {
      errors.push('minimumOrderQuantity must be positive integer when provided');
    }
  }

  // availability
  if (obs.availabilityStatus != null && !AVAILABILITY_ENUM.includes(obs.availabilityStatus)) {
    errors.push(`availabilityStatus must be one of ${AVAILABILITY_ENUM.join('/')}`);
  }

  // lead time (optional non-negative integer)
  if (obs.leadTimeDays != null) {
    const lt = Number(obs.leadTimeDays);
    if (!Number.isFinite(lt) || lt < 0 || !Number.isInteger(lt)) {
      errors.push('leadTimeDays must be non-negative integer when provided');
    }
  }

  // observed_at required · not too far in the future
  const observedAt = obs.observedAt || null;
  if (!observedAt) errors.push('observedAt required (ISO timestamp)');
  else {
    const t = Date.parse(observedAt);
    if (!Number.isFinite(t)) errors.push('observedAt not a valid ISO timestamp');
    else if (t > nowMs + futTolMs) errors.push(`observedAt is in the future beyond ${Math.round(futTolMs / 60_000)}min clock tolerance`);
  }

  // 7C-5: evidence_type (optional but if provided must be in enum)
  if (obs.evidenceType != null && !EVIDENCE_TYPE_ENUM.includes(obs.evidenceType)) {
    errors.push(`evidenceType must be one of ${EVIDENCE_TYPE_ENUM.join('/')}`);
  }
  if (obs.sourceClass != null && !SOURCE_CLASS_ENUM.includes(obs.sourceClass)) {
    errors.push(`sourceClass must be one of ${SOURCE_CLASS_ENUM.join('/')}`);
  }

  // 7C-5: availability range semantics
  //   availableQuantityMin / availableQuantityMax / availableQuantityExact
  //   Owner §12: range MUST stay a range; never collapsed to max.
  if (obs.availableQuantityMin != null && (!Number.isInteger(obs.availableQuantityMin) || obs.availableQuantityMin < 0)) {
    errors.push('availableQuantityMin must be non-negative integer');
  }
  if (obs.availableQuantityMax != null && (!Number.isInteger(obs.availableQuantityMax) || obs.availableQuantityMax < 0)) {
    errors.push('availableQuantityMax must be non-negative integer');
  }
  if (obs.availableQuantityMin != null && obs.availableQuantityMax != null && obs.availableQuantityMin > obs.availableQuantityMax) {
    errors.push('availableQuantityMin must not exceed availableQuantityMax');
  }
  if (obs.availableQuantityExact != null && (!Number.isInteger(obs.availableQuantityExact) || obs.availableQuantityExact < 0)) {
    errors.push('availableQuantityExact must be non-negative integer');
  }
  if (obs.maxReplenishableQuantity != null && (!Number.isInteger(obs.maxReplenishableQuantity) || obs.maxReplenishableQuantity < 0)) {
    errors.push('maxReplenishableQuantity must be non-negative integer');
  }

  // 7C-5: carton normalization inputs (optional pair)
  if (obs.unitsPerCarton != null && (!Number.isInteger(obs.unitsPerCarton) || obs.unitsPerCarton <= 0)) {
    errors.push('unitsPerCarton must be positive integer when provided');
  }
  if (obs.cartonCount != null && (!Number.isInteger(obs.cartonCount) || obs.cartonCount < 0)) {
    errors.push('cartonCount must be non-negative integer when provided');
  }

  return { ok: errors.length === 0, errors, availability_enum: AVAILABILITY_ENUM, price_basis_enum: PRICE_BASIS_ENUM };
}

/**
 * Translate Owner-facing price_basis into the normalizer's price_basis.
 *   per_physical_unit / per_box → 'per_unit'  (quoted_price is per single unit of the offer)
 *   per_offer / per_case        → 'per_offer' (quoted_price is for the whole offer)
 */
function toNormalizerPriceBasis(priceBasis) {
  if (priceBasis === 'per_physical_unit' || priceBasis === 'per_box') return 'per_unit';
  if (priceBasis === 'per_offer' || priceBasis === 'per_case') return 'per_offer';
  return 'per_offer';
}

module.exports = {
  AVAILABILITY_ENUM,
  PRICE_BASIS_ENUM,
  DEFAULT_FUTURE_TOLERANCE_MS,
  validateManualObservation,
  toNormalizerPriceBasis,
};
