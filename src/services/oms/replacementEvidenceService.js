/**
 * src/services/oms/replacementEvidenceService.js — Phase 7C · READ-ONLY.
 *
 * Aggregate physical_market_observations (observation_kind='replacement_price')
 * into an explainable replacement-evidence contract.
 *
 * Owner Part E — do NOT define replacement price as MIN(all supplier prices):
 *   - fresh window (policy.replacement_price_freshness_days)
 *   - identity match confidence ≥ 'medium' (via evidence.identity_match_status)
 *   - one observation ≠ high confidence
 *   - stale evidence remains historical, NOT current
 *
 * Owner Part F — landed cost separate from product cost. If landed
 * complete, verdict escalates to ESTIMATED_LANDED_COST.
 *
 * NEVER writes. Only reads `physical_market_observations`.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { getPolicy } = require('./strategicHoldPolicy');

const ONE_DAY_MS = 86400_000;

const REPLACEMENT_STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  OBSERVED_PRODUCT_COST: 'OBSERVED_PRODUCT_COST',
  ESTIMATED_LANDED_COST: 'ESTIMATED_LANDED_COST',
});

const AVAILABILITY_STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  OBSERVED: 'OBSERVED',
});

/**
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} [args.asOf=Date.now()]
 * @param {Object} [args.policy]  overrides strategicHoldPolicy defaults
 */
async function getReplacementEvidence({ physicalProductId, asOf = Date.now(), policy } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const db = getClient();
  const pol = getPolicy(policy);
  const nowMs = asOf;

  const { data: rows } = await db.from('physical_market_observations')
    .select('id, physical_product_id, observed_at, observation_kind, source, evidence, numeric_value, numeric_unit, confidence, notes')
    .eq('physical_product_id', physicalProductId)
    .eq('observation_kind', 'replacement_price');

  const all = rows || [];
  const analysed = all.map(r => _analyseRow(r, nowMs, pol));

  const total = analysed.length;
  const rejected = analysed.filter(a => a.classification === 'rejected').length;
  const ambiguous = analysed.filter(a => a.classification === 'ambiguous').length;
  const strongMatches = analysed.filter(a => a.classification === 'strong').length;
  const historicalReferences = analysed.filter(a => a.classification === 'historical_reference');
  const fresh = analysed.filter(a => a.fresh).length;
  const strongFresh = analysed.filter(a => a.classification === 'strong' && a.fresh);

  // 7C-5 hotfix (Owner §7): audit-only aggregate of typical/historical reference prices.
  const typicalRefs = historicalReferences.filter(a => a.evidence_type === 'TYPICAL_SUPPLIER_REFERENCE');
  const typicalRefPrices = typicalRefs.map(a => a.product_cost_krw_per_physical).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const historicalReferenceProductCost = typicalRefPrices.length ? {
    status: 'HISTORICAL_REFERENCE_ONLY',
    currency: 'KRW',
    median_krw_per_physical: _median(typicalRefPrices),
    observation_count: typicalRefs.length,
    note: 'Owner/staff typical supplier reference · NOT current replacement price · never gate strategic hold.',
  } : null;

  const uniqueSources = new Set(strongFresh.map(a => a.row.source).filter(Boolean));
  const uniqueSuppliers = new Set(strongFresh
    .map(a => (a.row.evidence?.supplier_id ?? a.row.evidence?.supplier_name))
    .filter(Boolean));

  // Verdict
  let priceStatus = REPLACEMENT_STATUS.UNKNOWN;
  let priceAmount = null;
  let priceCurrency = null;
  let pricePerPhysical = null;
  let priceBasis = null;
  let priceObservedAt = null;
  let priceFreshnessDays = null;
  let priceConfidence = 'unknown';
  const reasonCodes = [];
  let sourceCount = 0;
  let supplierCount = 0;

  if (strongFresh.length === 0) {
    reasonCodes.push('no_fresh_strong_identity_matches');
    if (analysed.length > 0) reasonCodes.push(`observations_present_but_filtered(fresh=${fresh}/total=${total}·strong=${strongMatches})`);
  } else {
    // Choose median product-cost-per-physical-unit-krw
    const knownPrices = strongFresh
      .map(a => a.product_cost_krw_per_physical)
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const median = _median(knownPrices);
    if (median != null) {
      pricePerPhysical = median;
      priceAmount = median;
      priceCurrency = 'KRW';
      priceBasis = 'product_cost_per_physical_unit_krw_median';
      const chosen = strongFresh.find(a => a.product_cost_krw_per_physical === median) || strongFresh[0];
      priceObservedAt = chosen.row.observed_at;
      priceFreshnessDays = chosen.age_days;

      const landedComplete = strongFresh.every(a => a.landed_cost_status === 'COMPLETE');
      priceStatus = landedComplete ? REPLACEMENT_STATUS.ESTIMATED_LANDED_COST : REPLACEMENT_STATUS.OBSERVED_PRODUCT_COST;

      sourceCount = uniqueSources.size;
      supplierCount = uniqueSuppliers.size;

      // Confidence
      if (supplierCount >= 3 && sourceCount >= 2) priceConfidence = 'high';
      else if (supplierCount >= 2) priceConfidence = 'medium';
      else priceConfidence = 'low';

      reasonCodes.push(`strong_fresh_observations(${strongFresh.length})`);
      reasonCodes.push(`unique_suppliers(${supplierCount})`);
      if (landedComplete) reasonCodes.push('landed_cost_complete_for_all_strong_fresh');
    } else {
      reasonCodes.push('strong_fresh_observations_have_no_valid_krw_per_physical');
    }
  }

  // Availability
  let availStatus = AVAILABILITY_STATUS.UNKNOWN;
  let minMoq = null;
  let leadTimeDays = null;
  let availConfidence = 'unknown';
  if (strongFresh.length > 0) {
    const moqs = strongFresh.map(a => a.moq_physical_units).filter(v => Number.isFinite(v) && v > 0);
    const leads = strongFresh.map(a => a.lead_time_days).filter(v => Number.isFinite(v) && v > 0);
    if (moqs.length) minMoq = Math.min(...moqs);
    if (leads.length) leadTimeDays = _median(leads);
    availStatus = AVAILABILITY_STATUS.OBSERVED;
    availConfidence = supplierCount >= 2 ? 'medium' : 'low';
  }

  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(nowMs).toISOString(),
    policy_reference: {
      replacement_price_freshness_days: pol.replacement_price_freshness_days,
      policy_source: pol.policy_source,
    },
    observations: {
      total,
      fresh,
      strong_identity_matches: strongMatches,
      ambiguous,
      rejected,
      historical_references: historicalReferences.length,
    },
    historical_reference_product_cost: historicalReferenceProductCost,
    replacement_price: {
      status: priceStatus,
      amount: priceAmount,
      currency: priceCurrency,
      per_physical_unit: pricePerPhysical,
      basis: priceBasis,
      observed_at: priceObservedAt,
      freshness_days: priceFreshnessDays,
      source_count: sourceCount,
      supplier_count: supplierCount,
      confidence: priceConfidence,
      reason_codes: reasonCodes,
    },
    availability: {
      status: availStatus,
      supplier_count: supplierCount,
      min_moq_physical_units: minMoq,
      lead_time_days: leadTimeDays,
      confidence: availConfidence,
    },
    sample_analysed: analysed.slice(0, 20).map(a => ({
      observation_id: a.row.id,
      source: a.row.source,
      supplier_name: a.row.evidence?.supplier_name ?? null,
      observed_at: a.row.observed_at,
      age_days: a.age_days,
      fresh: a.fresh,
      classification: a.classification,
      identity_match_status: a.identity_match_status,
      product_cost_krw_per_physical: a.product_cost_krw_per_physical,
      landed_cost_status: a.landed_cost_status,
      landed_cost_krw_per_physical: a.landed_cost_krw_per_physical,
      moq_physical_units: a.moq_physical_units,
      reject_reason: a.reject_reason,
    })),
  };
}

function _analyseRow(row, nowMs, pol) {
  const observedMs = row.observed_at ? new Date(row.observed_at).getTime() : null;
  const ageDays = observedMs != null ? Math.round((nowMs - observedMs) / ONE_DAY_MS * 100) / 100 : null;
  const fresh = ageDays != null && ageDays <= pol.replacement_price_freshness_days;

  const ev = row.evidence || {};
  const identityStatus = ev.identity_match_status || 'UNKNOWN';
  const evidenceType = ev.evidence_type || null;
  const productCostKrwPerPhysical = _num(ev.product_cost_krw_per_physical);
  const landedCostKrwPerPhysical = _num(ev.landed_cost_krw_per_physical);
  const landedCostStatus = ev.landed_cost_status || 'UNKNOWN';
  const moq = _num(ev.minimum_order_quantity_physical_units);
  const leadTime = _num(ev.lead_time_days);

  // Classification (Owner Part E · 7C-5 hotfix Owner §7)
  //   TYPICAL_SUPPLIER_REFERENCE → historical_reference (never contributes to current replacement price)
  //   ACTUAL_PURCHASE also treated as historical (already excluded from current supply curve)
  let classification = 'rejected';
  let rejectReason = null;
  if (evidenceType === 'TYPICAL_SUPPLIER_REFERENCE') {
    classification = 'historical_reference';
    rejectReason = 'typical_supplier_reference_never_current_replacement';
  } else if (evidenceType === 'ACTUAL_PURCHASE') {
    classification = 'historical_reference';
    rejectReason = 'actual_purchase_is_historical_not_current_replacement';
  } else if (identityStatus === 'EXACT_OR_STRONG_MATCH' || identityStatus === 'PROBABLE_MATCH') {
    if (productCostKrwPerPhysical != null && productCostKrwPerPhysical > 0) {
      classification = 'strong';
    } else {
      classification = 'ambiguous';
      rejectReason = 'no_product_cost_krw_per_physical';
    }
  } else if (identityStatus === 'AMBIGUOUS' || identityStatus === 'INSUFFICIENT_EVIDENCE') {
    classification = 'ambiguous';
    rejectReason = `identity_${identityStatus.toLowerCase()}`;
  } else {
    classification = 'rejected';
    rejectReason = `identity_${identityStatus}`;
  }

  return {
    row,
    age_days: ageDays,
    fresh,
    classification,
    evidence_type: evidenceType,
    identity_match_status: identityStatus,
    product_cost_krw_per_physical: productCostKrwPerPhysical,
    landed_cost_krw_per_physical: landedCostKrwPerPhysical,
    landed_cost_status: landedCostStatus,
    moq_physical_units: moq,
    lead_time_days: leadTime,
    reject_reason: rejectReason,
  };
}

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function _median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Phase 8J · Owner-facing evidence timeline (READ-ONLY).
 *
 * Purpose: expose an ordered, safely-projected list of observations for one
 * physical so the Owner Console UI can render a chronological timeline
 * without recomputing any freshness / classification / evidence semantics.
 *
 * Reuses `_analyseRow` verbatim → freshness policy + identity classification +
 * evidence_type surface all come from the canonical SoT. Only additive:
 * ordering (newest-first) and an Owner-safe allow-list projection.
 *
 * NEVER exposes raw `evidence.jsonb` internals. Only allow-listed derived
 * fields.
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} [args.asOf=Date.now()]
 * @param {Object} [args.policy]
 * @param {number} [args.limit=50]   caller-side cap (default 50, max 200)
 */
async function listReplacementObservationsForOwner({ physicalProductId, asOf = Date.now(), policy, limit = 50 } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const db = getClient();
  const pol = getPolicy(policy);
  const nowMs = asOf;

  const { data: rows } = await db.from('physical_market_observations')
    .select('id, physical_product_id, observed_at, observation_kind, source, evidence, numeric_value, numeric_unit, confidence')
    .eq('physical_product_id', physicalProductId)
    .eq('observation_kind', 'replacement_price');

  const all = rows || [];
  const analysed = all.map(r => _analyseRow(r, nowMs, pol));

  // Newest-first · then apply cap.
  analysed.sort((a, b) => {
    const at = a.row.observed_at ? new Date(a.row.observed_at).getTime() : 0;
    const bt = b.row.observed_at ? new Date(b.row.observed_at).getTime() : 0;
    return bt - at;
  });
  const view = analysed.slice(0, capped);

  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(nowMs).toISOString(),
    policy_reference: {
      replacement_price_freshness_days: pol.replacement_price_freshness_days,
      policy_source: pol.policy_source,
    },
    total_observations: analysed.length,
    returned_observations: view.length,
    limit_applied: capped,
    observations: view.map(a => ({
      observation_id: a.row.id,
      observed_at: a.row.observed_at,
      age_days: a.age_days,
      fresh: a.fresh,
      classification: a.classification,
      evidence_type: a.evidence_type,
      identity_match_status: a.identity_match_status,
      source: a.row.source,
      supplier_name: a.row.evidence?.supplier_name ?? null,
      currency: a.row.evidence?.currency ?? null,
      product_cost_krw_per_physical: a.product_cost_krw_per_physical,
      landed_cost_status: a.landed_cost_status,
      landed_cost_krw_per_physical: a.landed_cost_krw_per_physical,
      moq_physical_units: a.moq_physical_units,
      lead_time_days: a.lead_time_days,
      reject_reason: a.reject_reason,
    })),
  };
}

module.exports = { REPLACEMENT_STATUS, AVAILABILITY_STATUS, getReplacementEvidence, listReplacementObservationsForOwner };
module.exports._internals = { _analyseRow };
