/**
 * src/services/oms/replacementOfferNormalizer.js — Phase 7C · pure functions.
 *
 * Normalize a raw supplier offer into a comparable shape:
 *   - detect unit semantics (pack / box / case / bundle)
 *   - compute physical_units_per_offer
 *   - compute quoted_price_per_physical_unit
 *   - preserve original packaging semantics (never destructive)
 *
 * READ-ONLY. Pure. No I/O.
 */
'use strict';

const { _internals: sharedDiagnostic } = require('./physicalIdentityDiagnostic');

/**
 * @typedef {Object} RawOffer
 * @property {string}  source                'alibaba' | '1688' | ...
 * @property {string}  source_listing_id
 * @property {string=} source_url
 * @property {string}  title
 * @property {string=} supplier_name
 * @property {string=} supplier_id
 * @property {number}  quoted_price
 * @property {string}  currency
 * @property {number=} minimum_order_quantity
 * @property {string=} price_basis           'per_unit' | 'per_offer' | 'per_lot' (default per_offer)
 * @property {string=} observed_at           ISO
 * @property {Object=} raw
 */

/**
 * @param {RawOffer} offer
 * @param {Object}   physical  physical_products row (canonical_title/set_code/set_name/language/region/unit_type)
 * @returns normalized offer including price/unit semantics + preserved raw
 */
function normalizeOffer(offer, physical) {
  if (!offer || typeof offer !== 'object') throw new Error('normalizeOffer: offer required');
  if (!physical || typeof physical !== 'object') throw new Error('normalizeOffer: physical required');

  const title = String(offer.title || '');
  const signals = sharedDiagnostic.detectUnitSignals(title, offer.supplier_sku || '');
  const currency = String(offer.currency || '').toUpperCase() || 'UNKNOWN';
  const quotedPrice = Number(offer.quoted_price);
  const priceBasis = offer.price_basis || 'per_offer';
  const moq = offer.minimum_order_quantity != null ? Number(offer.minimum_order_quantity) : null;

  // Determine physical_units_per_offer.
  //   default = 1
  //   is_case OR boxes_quantity>1 → boxes_quantity (or 1 if unknown but is_case)
  //   is_bundle_with_promo → 1 (base physical) · flag extras
  //   is_booster_pack (and not is_booster_box) → NOT a physical booster_box; caller decides
  let physical_units_per_offer = 1;
  let packaging = 'unknown';
  const bundleFlags = [];

  if (signals.is_case || (signals.boxes_quantity != null && signals.boxes_quantity > 1)) {
    physical_units_per_offer = signals.boxes_quantity != null && signals.boxes_quantity > 1
      ? signals.boxes_quantity : (signals.is_case ? 1 : 1);
    packaging = signals.boxes_quantity != null && signals.boxes_quantity > 1
      ? `case_of_${signals.boxes_quantity}_boxes`
      : 'case';
  } else if (signals.is_bundle_with_promo) {
    physical_units_per_offer = 1;
    packaging = 'bundle_with_promo';
    bundleFlags.push('promo_extras_present');
  } else if (signals.is_booster_box) {
    physical_units_per_offer = 1;
    packaging = 'single_booster_box';
  } else if (signals.is_booster_pack && !signals.is_booster_box) {
    physical_units_per_offer = 0;   // 0 signals "not a physical booster_box unit"
    packaging = 'loose_booster_pack';
  } else if (signals.is_single_card) {
    physical_units_per_offer = 0;
    packaging = 'single_card';
  } else if (signals.is_accessory) {
    physical_units_per_offer = 0;
    packaging = 'accessory';
  }

  // Price interpretation.
  //   If price_basis='per_unit' the supplier's "unit" is the offer unit (a box, a case, etc.)
  //   We report:
  //     quoted_price_per_offer     = quotedPrice (if per_offer)  OR quotedPrice × ?  (if per_unit — impossible without qty)
  //     quoted_price_per_physical  = quoted_price_per_offer / physical_units_per_offer (if > 0 else null)
  let quoted_price_per_offer = null;
  if (Number.isFinite(quotedPrice) && quotedPrice > 0) {
    quoted_price_per_offer = priceBasis === 'per_unit' ? quotedPrice * (physical_units_per_offer || 1) : quotedPrice;
  }
  const quoted_price_per_physical_unit = (quoted_price_per_offer != null && physical_units_per_offer > 0)
    ? Math.round((quoted_price_per_offer / physical_units_per_offer) * 100) / 100 : null;

  return {
    source: offer.source ?? null,
    source_listing_id: offer.source_listing_id ?? null,
    source_url: offer.source_url ?? null,
    supplier_name: offer.supplier_name ?? null,
    supplier_id: offer.supplier_id ?? null,
    observed_at: offer.observed_at || new Date().toISOString(),
    title,
    unit_signals: signals,
    packaging,
    bundle_flags: bundleFlags,
    physical_units_per_offer,
    minimum_order_quantity: moq,
    currency,
    quoted_price: quotedPrice,
    price_basis: priceBasis,
    quoted_price_per_offer,
    quoted_price_per_physical_unit,
    raw: offer.raw ?? null,
  };
}

module.exports = { normalizeOffer };
