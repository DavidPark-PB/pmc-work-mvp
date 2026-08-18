/**
 * src/services/oms/replacementEvidenceTypes.js — Phase 7C-5 · pure.
 *
 * Distinct evidence classes for replacement observations (Owner §1/§2):
 *
 *   ACTUAL_PURCHASE      — PMC actually bought at this price/quantity (strongest history)
 *   EXECUTABLE_QUOTE     — seller/supplier explicitly confirmed price + qty + availability
 *   SUPPLIER_QUOTE       — real distributor/wholesaler quote (not yet confirmed executable)
 *   SECONDARY_MARKET_ASK — ephemeral listing on Bunjang/Junggonara/Karrot (asking price)
 *
 * These are stored in `physical_market_observations.evidence.evidence_type`.
 * The row's `confidence` column continues to reflect IDENTITY match confidence.
 *
 * For CURRENT-supply curve allocation (Owner §8), ACTUAL_PURCHASE is
 * excluded — historical evidence only. Ordering:
 *     EXECUTABLE_QUOTE > SUPPLIER_QUOTE > SECONDARY_MARKET_ASK
 */
'use strict';

const EVIDENCE_TYPES = Object.freeze({
  ACTUAL_PURCHASE: 'ACTUAL_PURCHASE',
  EXECUTABLE_QUOTE: 'EXECUTABLE_QUOTE',
  SUPPLIER_QUOTE: 'SUPPLIER_QUOTE',
  SECONDARY_MARKET_ASK: 'SECONDARY_MARKET_ASK',
  // 7C-5 hotfix (Owner §1): non-current staff/owner recollection of typical
  // supplier pattern (price + range + MOQ + lead-time). NEVER current supply.
  TYPICAL_SUPPLIER_REFERENCE: 'TYPICAL_SUPPLIER_REFERENCE',
});

const EVIDENCE_TYPE_ENUM = Object.freeze([
  EVIDENCE_TYPES.ACTUAL_PURCHASE,
  EVIDENCE_TYPES.EXECUTABLE_QUOTE,
  EVIDENCE_TYPES.SUPPLIER_QUOTE,
  EVIDENCE_TYPES.SECONDARY_MARKET_ASK,
  EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
]);

// Types that REQUIRE explicit --current-quote-confirmed to be persisted (Owner §2).
const REQUIRES_CURRENT_QUOTE_CONFIRMATION = Object.freeze(new Set([
  EVIDENCE_TYPES.SUPPLIER_QUOTE,
  EVIDENCE_TYPES.EXECUTABLE_QUOTE,
]));

// Types that MUST NOT carry currentQuoteConfirmed=true (semantic mismatch).
const FORBIDS_CURRENT_QUOTE_CONFIRMATION = Object.freeze(new Set([
  EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
  EVIDENCE_TYPES.ACTUAL_PURCHASE,
]));

// evidence_origin enum (Owner §5)
const EVIDENCE_ORIGIN = Object.freeze({
  SUPPLIER_CONFIRMED_CURRENT: 'supplier_confirmed_current',
  OWNER_STAFF_TYPICAL_REFERENCE: 'owner_staff_typical_reference',
  SECONDARY_MARKET_OBSERVATION: 'secondary_market_observation',
  ACTUAL_PURCHASE: 'actual_purchase',
});

function deriveEvidenceOrigin(evidenceType, currentQuoteConfirmed) {
  switch (evidenceType) {
    case EVIDENCE_TYPES.SUPPLIER_QUOTE:
    case EVIDENCE_TYPES.EXECUTABLE_QUOTE:
      return currentQuoteConfirmed ? EVIDENCE_ORIGIN.SUPPLIER_CONFIRMED_CURRENT : null;
    case EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE:
      return EVIDENCE_ORIGIN.OWNER_STAFF_TYPICAL_REFERENCE;
    case EVIDENCE_TYPES.SECONDARY_MARKET_ASK:
      return EVIDENCE_ORIGIN.SECONDARY_MARKET_OBSERVATION;
    case EVIDENCE_TYPES.ACTUAL_PURCHASE:
      return EVIDENCE_ORIGIN.ACTUAL_PURCHASE;
    default:
      return null;
  }
}

/** observed_at semantic meaning per evidence type (Owner §4). */
function deriveReferenceTimeSemantics(evidenceType) {
  switch (evidenceType) {
    case EVIDENCE_TYPES.SUPPLIER_QUOTE:
    case EVIDENCE_TYPES.EXECUTABLE_QUOTE:
      return 'supplier_confirmed_at_observed_at';
    case EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE:
      return 'staff_recorded_typical_reference';
    case EVIDENCE_TYPES.SECONDARY_MARKET_ASK:
      return 'listing_observed_at_observed_at';
    case EVIDENCE_TYPES.ACTUAL_PURCHASE:
      return 'purchased_at_observed_at';
    default:
      return null;
  }
}

const SOURCE_CLASS_ENUM = Object.freeze([
  'primary_distributor',
  'other_distributor',
  'secondary_market',
  'internal',
  'other',
]);

/** Historical trust ranking (Owner §2). TYPICAL_SUPPLIER_REFERENCE=0 (never current). */
const TRUST_RANK = Object.freeze({
  ACTUAL_PURCHASE: 4,
  EXECUTABLE_QUOTE: 3,
  SUPPLIER_QUOTE: 2,
  SECONDARY_MARKET_ASK: 1,
  TYPICAL_SUPPLIER_REFERENCE: 0,
});

/** Ordering for CURRENT-supply-curve allocation (ACTUAL_PURCHASE excluded). */
const CURRENT_SUPPLY_ORDER = Object.freeze([
  EVIDENCE_TYPES.EXECUTABLE_QUOTE,
  EVIDENCE_TYPES.SUPPLIER_QUOTE,
  EVIDENCE_TYPES.SECONDARY_MARKET_ASK,
]);

/**
 * Provisional freshness policy (days). Owner has not confirmed any of these
 * — Phase 7B/7C policy source stays 'provisional'.
 */
const PROVISIONAL_FRESHNESS_DAYS = Object.freeze({
  EXECUTABLE_QUOTE: 3,
  SECONDARY_MARKET_ASK: 3,
  SUPPLIER_QUOTE: 14,
  ACTUAL_PURCHASE: 30,                // audit-only "recently purchased" view · never current-supply
  TYPICAL_SUPPLIER_REFERENCE: 365,    // reference · used only for historical view, not current supply
});

function getFreshnessDays(evidenceType) {
  return PROVISIONAL_FRESHNESS_DAYS[evidenceType] ?? 14;
}

module.exports = {
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_ENUM,
  SOURCE_CLASS_ENUM,
  TRUST_RANK,
  CURRENT_SUPPLY_ORDER,
  PROVISIONAL_FRESHNESS_DAYS,
  REQUIRES_CURRENT_QUOTE_CONFIRMATION,
  FORBIDS_CURRENT_QUOTE_CONFIRMATION,
  EVIDENCE_ORIGIN,
  getFreshnessDays,
  deriveEvidenceOrigin,
  deriveReferenceTimeSemantics,
};
