/**
 * src/services/oms/inventoryDecisionEngine.js — Phase 8A · READ-ONLY.
 *
 * Owner directive:
 *   Convert existing PMC raw operational data into a simple, explainable,
 *   READ-ONLY inventory decision. Never duplicate business logic from
 *   strategicHoldService / replacementSupplyCurveService — consume them.
 *
 * Decision enum (Owner §):
 *   SELL_NORMALLY
 *   WATCH
 *   REPLENISH
 *   PROTECT_STOCK
 *   INSUFFICIENT_DATA
 *
 * Absolute rules (Owner §1-§10):
 *   - never mutate inventory / reservation / marketplace / mappings
 *   - null hold quantity means UNKNOWN · NOT zero
 *   - observed velocity is preserved · never invent adjusted velocity
 *   - concentrated 30d demand → do NOT treat as steady state
 *   - SECONDARY_MARKET_ASK ≠ executable supply
 *   - TYPICAL_SUPPLIER_REFERENCE / ACTUAL_PURCHASE are historical context only
 */
'use strict';

const { assessStrategicHold, STATUS: HOLD_STATUS, SUPPLY_QUALITY } = require('./strategicHoldService');

const DECISION = Object.freeze({
  SELL_NORMALLY: 'SELL_NORMALLY',
  WATCH: 'WATCH',
  REPLENISH: 'REPLENISH',
  PROTECT_STOCK: 'PROTECT_STOCK',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
});

/**
 * Assess physical-product-level inventory decision.
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} [args.asOf=Date.now()]
 * @param {Object} [args.policy]
 * @param {string[]} [args.channels=['shopify','ebay']]
 */
async function assessInventoryDecision({ physicalProductId, asOf = Date.now(), policy, channels } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const hold = await assessStrategicHold({ physicalProductId, asOf, policy, channels });

  // Physical-not-found or error report
  if (hold.error) return _errorReport(physicalProductId, asOf, hold);

  const decision = _deriveDecision(hold);

  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(asOf).toISOString(),
    physical: hold.physical,
    decision,
    inventory_summary: _summariseInventory(hold),
    demand_summary: _summariseDemand(hold),
    supply_summary: _summariseSupply(hold),
    cost_context: _summariseCostContext(hold),
    missing_evidence: hold.confidence?.missing_evidence || [],
    recommended_human_action: _recommendHumanAction(decision, hold),
    strategic_hold_source: hold,   // full audit · lets the CLI reprint sub-sections without re-fetching
  };
}

// ─── decision derivation ─────────────────────────────────

/**
 * Rules — thin translation from strategicHoldService output. Never
 * recomputes coverage / velocity / difficulty / concentration.
 */
function _deriveDecision(hold) {
  const holdStatus = hold.recommendation?.status;
  const holdQtyBlockers = hold.recommendation?.hold_quantity_blockers || [];
  const reasonCodes = [...(hold.recommendation?.reason_codes || [])];
  const missing = hold.confidence?.missing_evidence || [];
  const strategicHoldUnits = hold.recommendation?.strategic_hold_recommended_units ?? null;
  const replenishRecommended = !!hold.recommendation?.replenish_recommended;

  const trusted = hold.demand?.trusted === true;
  const supplyRisk = hold.supply_risk || {};
  const replacementGap = hold.replacement_gap || {};

  let status;
  const decisionReasonCodes = [];

  if (!trusted) {
    status = DECISION.INSUFFICIENT_DATA;
    decisionReasonCodes.push('demand_untrusted');
    if (missing.includes('trusted_cross_channel_velocity')) decisionReasonCodes.push('missing:trusted_cross_channel_velocity');
  } else if (
    holdStatus === HOLD_STATUS.REVIEW_DEMAND_SHOCK ||
    holdStatus === HOLD_STATUS.REVIEW_DEMAND_AND_SUPPLY_RISK ||
    holdStatus === HOLD_STATUS.REVIEW_SUPPLY_RISK
  ) {
    status = DECISION.WATCH;
    decisionReasonCodes.push(`hold_status:${holdStatus.toLowerCase()}`);
  } else if (holdStatus === HOLD_STATUS.PROTECT_OPERATING_STOCK) {
    status = DECISION.PROTECT_STOCK;
    decisionReasonCodes.push('protect_operating_stock_from_hold_service');
  } else if (replenishRecommended) {
    status = DECISION.REPLENISH;
    decisionReasonCodes.push('replenish_signal_from_hold_service');
  } else if (holdStatus === HOLD_STATUS.STRATEGIC_HOLD_CANDIDATE) {
    // Only reached when policy is enabled AND supply evidence sufficient.
    status = DECISION.PROTECT_STOCK;
    decisionReasonCodes.push('strategic_hold_candidate_from_hold_service');
  } else if (holdStatus === HOLD_STATUS.SELL_NORMALLY) {
    status = DECISION.SELL_NORMALLY;
    decisionReasonCodes.push('hold_status:sell_normally');
  } else {
    status = DECISION.INSUFFICIENT_DATA;
    decisionReasonCodes.push(`unrecognised_hold_status:${holdStatus}`);
  }

  // Propagate the hold recommendation's own reasons for full explainability.
  const merged = [...decisionReasonCodes];
  for (const r of reasonCodes) if (!merged.includes(r)) merged.push(r);

  return {
    status,
    confidence_level: hold.confidence?.level || 'low',
    reason_codes: merged,
    hold_quantity_blockers: holdQtyBlockers,
    strategic_hold_recommended_units: strategicHoldUnits,     // null preserved (Owner §9)
    upstream_hold_status: holdStatus,
    upstream_supply_verdict: supplyRisk.verdict,
    depth_gap: replacementGap.depth_gap ?? null,
  };
}

// ─── summaries ───────────────────────────────────────────

function _summariseInventory(hold) {
  const inv = hold.inventory || {};
  return {
    on_hand: inv.on_hand,
    reserved: inv.reserved,
    available: inv.available,
    invariant: (inv.on_hand != null && inv.reserved != null)
      ? `available = on_hand(${inv.on_hand}) - reserved(${inv.reserved}) = ${inv.available}` : null,
  };
}

function _summariseDemand(hold) {
  const d = hold.demand || {};
  const c = hold.demand_concentration || {};
  return {
    trusted: d.trusted,
    units_7d: d.units_7d,
    units_30d: d.units_30d,
    velocity_7d: d.velocity_7d,
    velocity_30d: d.velocity_30d,
    raw_days_of_supply: d.raw_days_of_supply,
    adjusted_velocity: null,                       // Owner §3 · never invented
    demand_pattern: c.demand_pattern,
    largest_shipment_units_30d: c.largest_shipment_units_30d,
    largest_shipment_share_30d: c.largest_shipment_share_30d,
    total_shipments_30d: c.total_shipments_30d,
    trust_reason: d.trust_reason,
  };
}

function _summariseSupply(hold) {
  const s = hold.supply_risk || {};
  return {
    verdict: s.verdict,
    current_supply_layers: s.current_supply_layers,
    current_supply_quality: s.current_supply_quality,
    supplier_diversity: s.supplier_diversity,
    has_current_supplier_or_executable: s.has_current_supplier_or_executable,
    replacement_difficulty: s.replacement_difficulty,
    replacement_difficulty_reason_codes: s.replacement_difficulty_reason_codes,
    evidenced_replacement_depth: s.evidenced_replacement_depth,
    largest_currently_coverable_target: s.largest_currently_coverable_target,
    uncovered_at_60: s.uncovered_at_60,
    uncovered_at_100: s.uncovered_at_100,
    secondary_market_dependency_by_target: s.secondary_market_dependency_by_target,
    replacement_coverage: {
      10: s.replacement_coverage_10,
      30: s.replacement_coverage_30,
      60: s.replacement_coverage_60,
      100: s.replacement_coverage_100,
    },
    observed_secondary_market_unit_cost_min: s.observed_secondary_market_unit_cost_min,
    secondary_market_depth: s.secondary_market_depth,
  };
}

function _summariseCostContext(hold) {
  const historicalTypical = hold.historical_reference_context?.historical_typical_supplier_cost_krw_median ?? null;
  const historicalAccountingKrw = hold.historical_accounting_cost?.cost_krw ?? null;
  const observedAskMin = hold.supply_risk?.observed_secondary_market_unit_cost_min ?? null;
  return {
    historical_typical_supplier_cost_krw_median: historicalTypical,
    historical_accounting_cost_krw: historicalAccountingKrw,
    observed_secondary_market_ask_min_krw: observedAskMin,
    note: 'Historical typical and secondary-market ASK are DIFFERENT semantic categories · engine does NOT compute an automatic "market trend" ratio.',
  };
}

function _recommendHumanAction(decision, hold) {
  const s = decision.status;
  const supplyQuality = hold.supply_risk?.current_supply_quality;
  const depthGap = hold.replacement_gap?.depth_gap;
  if (s === DECISION.INSUFFICIENT_DATA) {
    return 'Do not automate any inventory decision yet. Collect trusted demand and/or supply evidence (see missing_evidence).';
  }
  if (s === DECISION.WATCH) {
    const parts = [];
    parts.push('Do NOT treat concentrated 7d velocity as steady demand.');
    if (supplyQuality === SUPPLY_QUALITY.ASK_ONLY) parts.push('Current supply is SECONDARY_MARKET_ASK only — negotiate seller confirmation into EXECUTABLE_QUOTE before purchase.');
    if (!hold.supply_risk?.has_current_supplier_or_executable) parts.push('Contact primary distributor for a current SUPPLIER_QUOTE.');
    if (Number.isFinite(depthGap) && depthGap > 0) parts.push(`Available inventory exceeds evidenced replacement depth by ${depthGap} units — do not assume all can be replenished.`);
    return parts.join(' ');
  }
  if (s === DECISION.REPLENISH) {
    return 'Days of supply below minimum operating stock. Begin procurement (SUPPLIER_QUOTE / EXECUTABLE_QUOTE). No auto-purchase.';
  }
  if (s === DECISION.PROTECT_STOCK) {
    return 'Reduce sellable exposure. Consider raising price or delisting a portion — but do NOT auto-execute. Owner must approve any pricing / listing change.';
  }
  if (s === DECISION.SELL_NORMALLY) {
    return 'Continue selling. Watch normal metrics. No action required.';
  }
  return null;
}

function _errorReport(physicalProductId, asOf, hold) {
  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(asOf).toISOString(),
    error: hold.error,
    physical: null,
    decision: {
      status: DECISION.INSUFFICIENT_DATA,
      confidence_level: 'low',
      reason_codes: [hold.error],
      hold_quantity_blockers: [],
      strategic_hold_recommended_units: null,
      upstream_hold_status: null,
      upstream_supply_verdict: null,
      depth_gap: null,
    },
    inventory_summary: null, demand_summary: null, supply_summary: null,
    cost_context: null, missing_evidence: [hold.error],
    recommended_human_action: 'Physical product not found — no decision possible.',
    strategic_hold_source: hold,
  };
}

module.exports = {
  DECISION,
  assessInventoryDecision,
  _internals: { _deriveDecision, _summariseInventory, _summariseDemand, _summariseSupply, _summariseCostContext, _recommendHumanAction },
};
