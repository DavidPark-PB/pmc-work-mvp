/**
 * src/services/oms/strategicHoldPolicy.js — Phase 7B · READ-ONLY.
 *
 * Owner directive (Part D):
 *   Business policy MUST be centralized and explainable. No magic numbers
 *   buried in service code. Every threshold declared here, and every value
 *   labeled either OWNER_CONFIRMED or PROVISIONAL.
 *
 * Owner has NOT yet confirmed thresholds for Strategic Hold, so all defaults
 * ship as `policy_source: 'provisional'`. Consumers must forward this flag.
 */
'use strict';

const OWNER_CONFIRMED_POLICY = Object.freeze({
  // (empty) — Owner has not confirmed any Strategic Hold thresholds yet.
});

/**
 * Provisional engineering defaults. Named, explainable, all conservative.
 * These SHOULD be overwritten by Owner-confirmed values before production
 * use as an autonomous decision surface.
 */
const PROVISIONAL_DEFAULTS = Object.freeze({
  // Minimum days of stock coverage the operating business needs before
  // considering ANY strategic hold. Conservative default: about 2 weeks.
  minimum_operating_stock_days: 14,

  // Absolute cap on the fraction of `available` that may be recommended
  // for strategic hold. Guards against pathological over-hold.
  max_strategic_hold_pct: 30,

  // Minimum identity_universe_confidence required before a hold decision
  // is even attempted. 'medium' matches Phase 7A-4e trust gate output.
  minimum_confidence_required: 'medium',

  // Replacement price observation older than this is stale (not current).
  replacement_price_freshness_days: 30,

  // scarcityObservationService score at/above which supply is 'scarce'.
  // Provisional — Owner has not confirmed this threshold.
  scarcity_threshold: 70,

  // Enable/disable strategic hold recommendation entirely.
  // Default OFF — Phase 7B is decision support only; not enabled until
  // replacement/scarcity evidence sources actually exist.
  strategic_hold_enabled: false,

  // Concentration heuristics for demand-shock detection (Part E).
  // `largest_shipment_share_30d` above this ratio triggers concentrated pattern.
  concentration_share_threshold: 0.6,
  // AND the number of shipment events must be <= this count for it to be
  // considered a concentrated large-order pattern (few big orders).
  concentration_max_events: 3,
  // velocity_ratio_7d_to_30d above this ratio triggers accelerating pattern.
  acceleration_ratio_threshold: 2.0,
});

function getPolicy(overrides = {}) {
  const merged = { ...PROVISIONAL_DEFAULTS, ...OWNER_CONFIRMED_POLICY, ...(overrides || {}) };
  // policy_source reflects whether ANY owner-confirmed key exists AND was applied
  const ownerKeys = Object.keys(OWNER_CONFIRMED_POLICY);
  const hasOwnerConfirmed = ownerKeys.length > 0;
  return {
    ...merged,
    policy_source: hasOwnerConfirmed ? 'owner_confirmed_with_provisional_fallback' : 'provisional',
    owner_confirmed_keys: ownerKeys,
    provisional_keys: Object.keys(PROVISIONAL_DEFAULTS).filter(k => !ownerKeys.includes(k)),
  };
}

module.exports = {
  PROVISIONAL_DEFAULTS,
  OWNER_CONFIRMED_POLICY,
  getPolicy,
};
