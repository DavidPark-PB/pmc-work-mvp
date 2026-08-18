/**
 * src/services/oms/judgmentConfidencePolicy.js — Phase 8K · pure explainability.
 *
 * Owner-approved DETERMINISTIC DERIVED explainability value.
 *
 *   IMPORTANT — this is NOT a projection of an upstream confidence field.
 *   It is a separate explainability derivation from concrete upstream signals
 *   (demand.trusted, supply.evidence_confidence, cost/identity metadata).
 *   Existing `headline.confidence_level` is preserved verbatim by Phase 8E
 *   and is NEVER modified by this policy. If the derived `overall_tier`
 *   differs from `headline.confidence_level`, both are exposed side-by-side.
 *
 * Owner rule 5 — tier ordering:
 *   UNKNOWN < LOW < MEDIUM < HIGH
 *
 * Owner rules 7-8:
 *   Cost tier is HIGH/MEDIUM ONLY when upstream confirms freshness + source
 *   quality. Otherwise UNKNOWN. All-3-categories-present alone does NOT
 *   bump the tier.
 *
 *   Identity tier is HIGH ONLY when verified identity evidence is present.
 *   LOW when blockers exist. UNKNOWN otherwise.
 *
 * Recommended evidence actions reuse Phase 8F `ACTION` enum verbatim — no
 * new enum. `recommended_evidence_actions` is Owner-facing review guidance
 * for closing evidence gaps · it does NOT promise confidence will rise.
 */
'use strict';

const { ACTION } = require('./inventoryOwnerDecisionService');

const TIER = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});
const TIER_ORDER = Object.freeze({ UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });

function _minTier(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return TIER.UNKNOWN;
  let min = TIER.HIGH;
  for (const t of tiers) {
    const norm = TIER_ORDER[t] != null ? t : TIER.UNKNOWN;
    if (TIER_ORDER[norm] < TIER_ORDER[min]) min = norm;
  }
  return min;
}

// ─── Per-dimension tier derivation ──────────────────────

function _deriveDemandTier(holdSrc) {
  const trusted = holdSrc?.demand?.trusted;
  if (trusted === true) return TIER.HIGH;
  if (trusted === false) return TIER.LOW;
  return TIER.UNKNOWN;
}

function _deriveSupplyTier(holdSrc) {
  // Upstream `supply_risk.evidence_confidence` values (from Phase 7A strategicHoldService):
  //   'none'   → no current supply layer at all
  //   'low'    → layers exist but not EXECUTABLE_QUOTE
  //   'medium' → at least one EXECUTABLE_QUOTE layer
  //   (upstream never emits 'high' today; mapping kept explicit anyway)
  const ec = holdSrc?.supply_risk?.evidence_confidence;
  if (ec === 'none') return TIER.UNKNOWN;
  if (ec === 'low') return TIER.LOW;
  if (ec === 'medium') return TIER.MEDIUM;
  if (ec === 'high') return TIER.HIGH;
  return TIER.UNKNOWN;
}

// ─── Cost breakdown per category (Owner-approved policy · rev.2) ───────
//
//   Owner rules (rev.2 · 2026-08-18):
//     · supplier / accounting / secondary categories are evaluated INDEPENDENTLY
//     · category counts are NOT summed to inflate a tier
//     · supplier HIGH requires (a) current executable quote AND (b) freshness verified
//     · supplier_quote (non-executable) or historical typical only → MEDIUM ceiling
//     · secondary market ask → LOW ceiling regardless of observation count
//     · accounting cost without freshness → MEDIUM ceiling
//     · If freshness cannot be verified for a category, that category is capped
//       BELOW HIGH.
//     · overall_cost tier = supplier if !UNKNOWN
//                          else accounting if !UNKNOWN
//                          else secondary_market if !UNKNOWN
//                          else UNKNOWN
//       (priority-by-importance · NOT max/min · NOT sum)

function _hasCurrentSupplyFreshness(holdSrc) {
  // Freshness signal upstream: replacement_price_observed_at is stamped by
  // strategicHoldService when a fresh supply-side observation feeds the
  // strategic hold calculation. If missing or not a valid ISO → not verified.
  const ts = holdSrc?.historical_reference_context?.replacement_price_observed_at;
  if (!ts || typeof ts !== 'string') return false;
  const t = Date.parse(ts);
  return Number.isFinite(t);
}

function _deriveCostBreakdown(holdSrc) {
  const supplyRisk = holdSrc?.supply_risk || {};
  const quality = supplyRisk.current_supply_quality;
  const hasCurrent = supplyRisk.has_current_supplier_or_executable === true;
  const refCost = holdSrc?.historical_reference_product_cost;
  const accounting = holdSrc?.historical_accounting_cost;
  const secondaryDepth = supplyRisk.secondary_market_depth;
  const secondaryFresh = Array.isArray(secondaryDepth)
    ? secondaryDepth.reduce((sum, b) => sum + (Number(b?.fresh_observations) || 0), 0)
    : 0;
  const observedSecondaryAsk = supplyRisk.observed_secondary_market_unit_cost_min;
  const freshnessVerified = _hasCurrentSupplyFreshness(holdSrc);

  // ── SUPPLIER category ────────────────────────────────
  //   current executable → HIGH only with freshness · else MEDIUM
  //   current supplier_quote → MEDIUM (never HIGH without executable)
  //   no current supplier but historical typical reference exists → MEDIUM
  //   nothing → UNKNOWN
  let supplierTier;
  if (quality === 'executable' && hasCurrent) {
    supplierTier = freshnessVerified ? TIER.HIGH : TIER.MEDIUM;
  } else if (quality === 'supplier_quote' && hasCurrent) {
    supplierTier = TIER.MEDIUM;
  } else if (refCost && Number(refCost.observation_count) > 0) {
    // historical typical reference only (Owner rule: cap at MEDIUM)
    supplierTier = TIER.MEDIUM;
  } else {
    supplierTier = TIER.UNKNOWN;
  }

  // ── ACCOUNTING category ──────────────────────────────
  //   cost_krw present + freshness verified → HIGH
  //   cost_krw present without freshness → MEDIUM (Owner: HIGH 금지 without freshness)
  //   absent → UNKNOWN
  //
  //   Note: current upstream does not stamp accounting-cost freshness. Until
  //   Phase 6D exposes an observed_at on historical_accounting_cost, this
  //   category can only reach MEDIUM.
  let accountingTier;
  const acctPresent = accounting && accounting.cost_krw != null;
  const acctFreshness = accounting && (accounting.observed_at || accounting.freshest_observed_at);
  if (acctPresent && acctFreshness && Number.isFinite(Date.parse(acctFreshness))) {
    accountingTier = TIER.HIGH;
  } else if (acctPresent) {
    accountingTier = TIER.MEDIUM;
  } else {
    accountingTier = TIER.UNKNOWN;
  }

  // ── SECONDARY_MARKET category ────────────────────────
  //   Owner rule: secondary ask NEVER raises supplier/accounting confidence.
  //   secondary observation exists → LOW (Owner: "secondary ask만 있으면 LOW")
  //   nothing → UNKNOWN
  let secondaryTier;
  if (secondaryFresh > 0 || (observedSecondaryAsk != null && observedSecondaryAsk > 0)) {
    secondaryTier = TIER.LOW;
  } else {
    secondaryTier = TIER.UNKNOWN;
  }

  // ── Overall cost tier: importance priority (supplier > accounting > secondary) ─
  let overall;
  if (supplierTier !== TIER.UNKNOWN) overall = supplierTier;
  else if (accountingTier !== TIER.UNKNOWN) overall = accountingTier;
  else if (secondaryTier !== TIER.UNKNOWN) overall = secondaryTier;
  else overall = TIER.UNKNOWN;

  return {
    overall,
    category_tiers: {
      supplier: supplierTier,
      accounting: accountingTier,
      secondary_market: secondaryTier,
    },
    freshness_verified: freshnessVerified,
  };
}

// Back-compat surface for tests / consumers that only need overall tier.
function _deriveCostTier(holdSrc) {
  return _deriveCostBreakdown(holdSrc).overall;
}

function _deriveIdentityTier(holdSrc, decision) {
  // Owner rev.2 (2026-08-18) — physical existence alone is NOT enough for HIGH.
  //   HIGH: upstream explicitly says identity_verified === true
  //   LOW:  upstream explicitly says identity_verified === false
  //   LOW:  hold_quantity_blockers.length >= 1 (regardless of verified)
  //   UNKNOWN: identity_verified missing/null AND no blockers
  //
  //   NO new DB query. NO guess from presence of physical row. Field lookup
  //   is strict: only exact boolean true/false counts. Any other value =
  //   as-if missing.
  const blockers = decision?.hold_quantity_blockers || [];
  const hasBlockers = Array.isArray(blockers) && blockers.length > 0;
  if (hasBlockers) return TIER.LOW;

  // Check two possible upstream locations (both must be strict boolean).
  const v1 = holdSrc?.identity?.verified;
  const v2 = holdSrc?.physical?.identity_verified;
  const verified = (v1 === true || v2 === true) ? true
                 : (v1 === false || v2 === false) ? false
                 : null;

  if (verified === true) return TIER.HIGH;
  if (verified === false) return TIER.LOW;
  return TIER.UNKNOWN;
}

// ─── Per-dimension recommended evidence actions ─────────

function _demandActions(tier) {
  if (tier === TIER.HIGH) return [];
  // LOW or UNKNOWN — Owner reviews the data quality queue
  return [ACTION.REVIEW_DATA_QUALITY];
}

// Owner-approved threshold for CHECK_SECONDARY_MARKET (rev.2 · 2026-08-18).
//   Applies REGARDLESS of current_supply_quality (previous rev. gated on
//   quality !== 'ask_only' which incorrectly suppressed BP's 100% dep60).
const POLICY = Object.freeze({
  SECONDARY_DEP_HIGH_THRESHOLD: 0.5,
});

function _supplyActions(holdSrc) {
  const supply = holdSrc?.supply_risk || {};
  const out = [];
  if (supply.current_supply_quality === 'ask_only') out.push(ACTION.CONFIRM_EXECUTABLE_QUOTE);
  if (supply.has_current_supplier_or_executable === false) out.push(ACTION.CHECK_PRIMARY_SUPPLIER);
  // Owner rule 3 (rev.2) — high secondary dependency ALWAYS surfaces CHECK_SECONDARY_MARKET,
  //   even when quality is ask_only. Broadening the secondary survey and
  //   confirming an executable quote are complementary, not duplicates.
  const dep60 = supply.secondary_market_dependency_by_target?.[60] ?? 0;
  if (Number.isFinite(dep60) && dep60 > POLICY.SECONDARY_DEP_HIGH_THRESHOLD) {
    out.push(ACTION.CHECK_SECONDARY_MARKET);
  }
  return out;
}

function _costActions(tier) {
  return tier === TIER.UNKNOWN ? [ACTION.REVIEW_DATA_QUALITY] : [];
}

function _identityActions(tier) {
  return tier === TIER.LOW ? [ACTION.REVIEW_DATA_QUALITY] : [];
}

// ─── Public: derive judgment_confidence + recommended_evidence_actions ─

/**
 * @param {Object} decisionResult   Phase 8A `assessInventoryDecision` output
 * @returns {{judgment_confidence, recommended_evidence_actions}}
 */
// Owner-approved deterministic action ordering (rev.2 · 2026-08-18).
//   All emitted `recommended_evidence_actions` arrays are deduplicated and
//   sorted by this order so consumers (UI, tests) get a stable sequence.
const ACTION_ORDER = Object.freeze([
  ACTION.CONFIRM_EXECUTABLE_QUOTE,
  ACTION.CHECK_PRIMARY_SUPPLIER,
  ACTION.CHECK_SECONDARY_MARKET,
  ACTION.REVIEW_REPLENISHMENT,
  ACTION.REVIEW_STOCK_PROTECTION,
  ACTION.WATCH_ONLY,
  ACTION.REVIEW_DATA_QUALITY,
  ACTION.NO_ACTION,
]);

function _sortByPolicy(actions) {
  const rank = new Map(ACTION_ORDER.map((a, i) => [a, i]));
  return [...actions].sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
}

function deriveJudgmentConfidence(decisionResult) {
  const holdSrc = decisionResult?.strategic_hold_source || {};
  const decision = decisionResult?.decision || {};
  const supply = holdSrc.supply_risk || {};
  const demand = holdSrc.demand || {};

  const demandTier = _deriveDemandTier(holdSrc);
  const supplyTier = _deriveSupplyTier(holdSrc);
  const costBreakdown = _deriveCostBreakdown(holdSrc);
  const costTier = costBreakdown.overall;
  const identityTier = _deriveIdentityTier(holdSrc, decision);

  const demandActions = _demandActions(demandTier);
  const supplyActions = _supplyActions(holdSrc);
  const costActions = _costActions(costTier);
  const identityActions = _identityActions(identityTier);

  const overallTier = _minTier([demandTier, supplyTier, costTier, identityTier]);

  const headlineConfidence = decisionResult?.decision?.confidence_level ?? null;

  // Explicit identity_verified projection — mirrors upstream check.
  const v1 = holdSrc?.identity?.verified;
  const v2 = holdSrc?.physical?.identity_verified;
  const identityVerified = (v1 === true || v2 === true) ? true
                        : (v1 === false || v2 === false) ? false
                        : null;

  return {
    judgment_confidence: {
      overall_tier: overallTier,
      headline_confidence_level: headlineConfidence,   // verbatim from Phase 8E (never modified)
      derived_matches_headline: _headlineMatchesOverall(headlineConfidence, overallTier),
      by_dimension: {
        demand: {
          tier: demandTier,
          trusted: demand?.trusted ?? null,
          trust_reason: demand?.trust_reason ?? null,
          recommended_evidence_actions: _sortByPolicy(_dedupPreserveOrder(demandActions)),
        },
        supply: {
          tier: supplyTier,
          current_supply_quality: supply?.current_supply_quality ?? null,
          evidence_confidence_upstream: supply?.evidence_confidence ?? null,
          current_supply_layers: supply?.current_supply_layers ?? null,
          has_current_supplier_or_executable: supply?.has_current_supplier_or_executable ?? null,
          secondary_market_dependency_at_60: supply?.secondary_market_dependency_by_target?.[60] ?? null,
          recommended_evidence_actions: _sortByPolicy(_dedupPreserveOrder(supplyActions)),
        },
        cost: {
          tier: costTier,
          category_tiers: { ...costBreakdown.category_tiers },   // Owner rule 2 (rev.2)
          freshness_verified: costBreakdown.freshness_verified,
          typical_supplier_observation_count: holdSrc?.historical_reference_product_cost?.observation_count ?? null,
          secondary_market_fresh_observations_count: _secondaryFreshCount(supply?.secondary_market_depth),
          recommended_evidence_actions: _sortByPolicy(_dedupPreserveOrder(costActions)),
        },
        identity: {
          tier: identityTier,
          identity_verified: identityVerified,             // null / true / false · verbatim upstream
          hold_quantity_blockers: Array.isArray(decision?.hold_quantity_blockers) ? [...decision.hold_quantity_blockers] : [],
          recommended_evidence_actions: _sortByPolicy(_dedupPreserveOrder(identityActions)),
        },
      },
      note: 'Derived explainability value · headline.confidence_level preserved verbatim by Phase 8E · this policy does not modify decision / action / priority / urgency',
    },
    recommended_evidence_actions: _sortByPolicy(_dedupPreserveOrder([
      ...demandActions,
      ...supplyActions,
      ...costActions,
      ...identityActions,
    ])),
  };
}

function _secondaryFreshCount(depth) {
  if (!Array.isArray(depth)) return null;
  const total = depth.reduce((sum, b) => sum + (Number(b?.fresh_observations) || 0), 0);
  return Number.isFinite(total) ? total : null;
}

function _dedupPreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

function _headlineMatchesOverall(headline, overall) {
  if (headline == null || overall == null) return null;
  const h = String(headline).toUpperCase();
  const o = String(overall).toUpperCase();
  return h === o;
}

module.exports = {
  TIER,
  TIER_ORDER,
  POLICY,
  ACTION_ORDER,
  deriveJudgmentConfidence,
  _internals: {
    _minTier, _sortByPolicy,
    _deriveDemandTier, _deriveSupplyTier, _deriveCostTier, _deriveCostBreakdown, _deriveIdentityTier,
    _demandActions, _supplyActions, _costActions, _identityActions,
    _headlineMatchesOverall, _secondaryFreshCount, _hasCurrentSupplyFreshness,
  },
};
