/**
 * src/services/oms/replacementSupplyCurveService.js — Phase 7C-5 · READ-ONLY.
 *
 * Owner directive: replacement_price is NOT one scalar. Build a supply curve
 * answering "If PMC needs N more physical boxes today, how much to replenish?".
 *
 * READ-ONLY. Never writes / calls marketplace / mutates strategic hold / scarcity.
 * Reads only `physical_market_observations` (kind='replacement_price').
 *
 * Ownership rules (Owner §8-§11):
 *   - EXECUTABLE_QUOTE > SUPPLIER_QUOTE > SECONDARY_MARKET_ASK  (for current supply)
 *   - ACTUAL_PURCHASE excluded from current-supply curve (historical only)
 *   - each layer's available_physical_units is CONSERVATIVE (min of range)
 *     — range max is exposed separately (Owner §12: 15–30 stays a range)
 *   - unknown availability = null (NOT infinite)  Owner §10
 *   - uncovered demand NEVER extrapolates last-known price  Owner §9/§10
 *   - identity_match_status must be EXACT/PROBABLE (matcher-verified or manual-confirmed)
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const {
  EVIDENCE_TYPES, CURRENT_SUPPLY_ORDER, TRUST_RANK, getFreshnessDays,
  EVIDENCE_ORIGIN,
} = require('./replacementEvidenceTypes');

const ONE_DAY_MS = 86400_000;
const DEFAULT_TARGETS = [10, 30, 60, 100];

const CURVE_STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  PARTIAL_COVERAGE: 'PARTIAL_COVERAGE',
  COVERED: 'COVERED',
});

const DIFFICULTY = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  EASY: 'EASY',
  MODERATE: 'MODERATE',
  HARD: 'HARD',
  VERY_HARD: 'VERY_HARD',
});

async function buildReplacementSupplyCurve({
  physicalProductId, asOf = Date.now(), targetQuantities = DEFAULT_TARGETS,
} = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const db = getClient();
  const nowMs = asOf;

  const { data: phy } = await db.from('physical_products')
    .select('id, canonical_title, set_code, language, region, unit_type')
    .eq('id', physicalProductId).maybeSingle();
  if (!phy) return _emptyReport(physicalProductId, nowMs, 'physical_not_found');

  const { data: rows } = await db.from('physical_market_observations')
    .select('id, observed_at, source, evidence, numeric_value, numeric_unit, confidence, notes')
    .eq('physical_product_id', physicalProductId)
    .eq('observation_kind', 'replacement_price');

  const all = (rows || []).map(r => _analyseRow(r, nowMs));
  const evidenceSummary = _summariseEvidence(all);

  // Current-supply layers = fresh, identity-strong, evidence_type ∈ CURRENT_SUPPLY_ORDER
  //   (7C-5 hotfix: TYPICAL_SUPPLIER_REFERENCE is intentionally excluded here.)
  const currentLayers = all.filter(a =>
    a.fresh &&
    a.identity_ok &&
    CURRENT_SUPPLY_ORDER.includes(a.evidence_type) &&
    Number.isFinite(a.unit_cost_krw_per_physical) &&
    a.available_physical_units != null && a.available_physical_units > 0
  );

  // 7C-5 hotfix (Owner §6): typical/historical reference layers exposed
  // separately as procurement CONTEXT — NEVER counted toward current supply.
  const historicalReferenceLayers = all
    .filter(a => a.evidence_type === EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE)
    .map(_publicHistoricalLayer);

  const sortedLayers = _sortForCurrentSupply(currentLayers);
  const curve = targetQuantities.map(t => _allocate(t, sortedLayers));
  const secondaryMarketDepth = _summariseSecondaryMarketDepth(sortedLayers);
  const difficulty = _classifyDifficulty(curve, sortedLayers, targetQuantities);
  const verdict = _verdict(sortedLayers, curve, evidenceSummary);
  const secondaryDependency = _secondaryDependency(curve);

  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(nowMs).toISOString(),
    physical: phy,
    target_quantities: targetQuantities,
    evidence_summary: evidenceSummary,
    supply_layers: sortedLayers.map(_publicLayer),
    historical_reference_layers: historicalReferenceLayers,
    excluded_layers: all.filter(a => !currentLayers.includes(a)).map(a => ({
      observation_id: a.observation_id,
      source: a.source, source_name: a.source_name, evidence_type: a.evidence_type,
      exclusion_reasons: a.exclusion_reasons,
    })),
    replacement_curve: curve,
    secondary_market_depth: secondaryMarketDepth,   // 7C-6 (Owner §10)
    secondary_market_dependency: secondaryDependency,
    replacement_difficulty: difficulty,
    verdict,
    policy_reference: {
      policy_source: 'provisional',
      freshness_days: {
        EXECUTABLE_QUOTE: getFreshnessDays('EXECUTABLE_QUOTE'),
        SECONDARY_MARKET_ASK: getFreshnessDays('SECONDARY_MARKET_ASK'),
        SUPPLIER_QUOTE: getFreshnessDays('SUPPLIER_QUOTE'),
        ACTUAL_PURCHASE_recent_days: getFreshnessDays('ACTUAL_PURCHASE'),
      },
    },
  };
}

// ─── row analysis ────────────────────────────────────────

function _analyseRow(row, nowMs) {
  const ev = row.evidence || {};
  const evidenceType = ev.evidence_type || null;
  const identityStatus = ev.identity_match_status || 'UNKNOWN';
  const identity_ok = identityStatus === 'EXACT_OR_STRONG_MATCH' || identityStatus === 'PROBABLE_MATCH';
  const observedMs = row.observed_at ? new Date(row.observed_at).getTime() : null;
  const ageDays = observedMs != null ? Math.round((nowMs - observedMs) / ONE_DAY_MS * 100) / 100 : null;
  const freshLimit = evidenceType ? getFreshnessDays(evidenceType) : 14;
  const fresh = ageDays != null && ageDays <= freshLimit;

  // Conservative availability (Owner §12 · §10)
  const availMin = _num(ev.available_quantity_min);
  const availMax = _num(ev.available_quantity_max);
  const availExact = _num(ev.available_quantity_exact);
  const maxReplen = _num(ev.max_replenishable_quantity);
  const cartonCount = _num(ev.carton_count);
  const unitsPerCarton = _num(ev.units_per_carton);
  const cartonPhysical = (cartonCount != null && unitsPerCarton != null) ? cartonCount * unitsPerCarton : null;

  // Priority: exact > min-of-range > cartonPhysical > maxReplenishable
  let available_physical_units;
  if (availExact != null) available_physical_units = availExact;
  else if (availMin != null) available_physical_units = availMin;
  else if (cartonPhysical != null) available_physical_units = cartonPhysical;
  else if (maxReplen != null) available_physical_units = maxReplen;
  else available_physical_units = null;
  // Upper bound (Owner §12 range preservation)
  const availability_upper_bound = availExact != null ? availExact
    : (availMax != null ? availMax
    : (cartonPhysical != null ? cartonPhysical
    : (maxReplen != null ? maxReplen : null)));

  const unitCost = _num(ev.product_cost_krw_per_physical);

  const exclusion_reasons = [];
  if (!identity_ok) exclusion_reasons.push(`identity_${identityStatus}`);
  if (!evidenceType) exclusion_reasons.push('no_evidence_type');
  if (evidenceType === EVIDENCE_TYPES.ACTUAL_PURCHASE) exclusion_reasons.push('actual_purchase_is_historical_not_current_supply');
  if (evidenceType === EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE) exclusion_reasons.push('typical_supplier_reference_is_not_current_supply');
  if (evidenceType && !CURRENT_SUPPLY_ORDER.includes(evidenceType)
      && evidenceType !== EVIDENCE_TYPES.ACTUAL_PURCHASE
      && evidenceType !== EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE) exclusion_reasons.push(`unsupported_evidence_type_${evidenceType}`);
  if (!fresh) exclusion_reasons.push(`stale(age=${ageDays}·limit=${freshLimit})`);
  if (unitCost == null || !(unitCost > 0)) exclusion_reasons.push('no_unit_cost_krw_per_physical');
  if (available_physical_units == null || available_physical_units <= 0) exclusion_reasons.push('no_available_physical_units');

  return {
    observation_id: row.id,
    source: row.source,
    source_name: ev.supplier_name || row.source,
    source_class: ev.source_class || null,
    evidence_type: evidenceType,
    identity_ok,
    identity_status: identityStatus,
    row_confidence: row.confidence,
    availability_confidence: ev.availability_confidence || null,
    observed_at: row.observed_at,
    age_days: ageDays,
    fresh_limit_days: freshLimit,
    fresh,
    unit_cost_krw_per_physical: unitCost,
    currency: ev.currency || null,
    unit_cost_native: ev.quoted_price_per_physical ?? null,
    available_physical_units,
    availability_upper_bound,
    available_quantity_min: availMin, available_quantity_max: availMax, available_quantity_exact: availExact,
    units_per_carton: unitsPerCarton, carton_count: cartonCount, carton_physical_units: cartonPhysical,
    max_replenishable_quantity: maxReplen,
    lead_time_days: ev.lead_time_days ?? null,
    exclusion_reasons,
  };
}

function _publicHistoricalLayer(a) {
  return {
    observation_id: a.observation_id,
    source_class: a.source_class,
    source_name: a.source_name,
    evidence_type: a.evidence_type,
    unit_cost_native: a.unit_cost_native,
    currency: a.currency,
    unit_cost_krw_per_physical: a.unit_cost_krw_per_physical,
    availability_range: (a.available_quantity_min != null || a.available_quantity_max != null)
      ? [a.available_quantity_min, a.available_quantity_max] : null,
    availability_confidence: a.availability_confidence,
    lead_time_days: a.lead_time_days,
    observed_at: a.observed_at,
    age_days: a.age_days,
    reference_only: true,
    note: 'TYPICAL_SUPPLIER_REFERENCE · NEVER contributes to current replacement supply.',
  };
}

function _publicLayer(a) {
  return {
    observation_id: a.observation_id,
    source_class: a.source_class,
    source_name: a.source_name,
    evidence_type: a.evidence_type,
    confidence: a.row_confidence,
    availability_confidence: a.availability_confidence,
    unit_cost_native: a.unit_cost_native,
    currency: a.currency,
    unit_cost_krw_per_physical: a.unit_cost_krw_per_physical,
    available_physical_units: a.available_physical_units,
    availability_upper_bound: a.availability_upper_bound,
    availability_range: (a.available_quantity_min != null || a.available_quantity_max != null)
      ? [a.available_quantity_min, a.available_quantity_max] : null,
    max_replenishable_quantity: a.max_replenishable_quantity,
    units_per_carton: a.units_per_carton, carton_count: a.carton_count, carton_physical_units: a.carton_physical_units,
    lead_time_days: a.lead_time_days,
    observed_at: a.observed_at, freshness_age_days: a.age_days, fresh: a.fresh,
  };
}

function _summariseEvidence(all) {
  const bucket = { supplier_quotes: 0, secondary_market_asks: 0, executable_quotes: 0, actual_purchases: 0 };
  let fresh = 0, stale = 0;
  for (const a of all) {
    if (a.fresh) fresh++; else stale++;
    if (a.evidence_type === EVIDENCE_TYPES.SUPPLIER_QUOTE) bucket.supplier_quotes++;
    else if (a.evidence_type === EVIDENCE_TYPES.SECONDARY_MARKET_ASK) bucket.secondary_market_asks++;
    else if (a.evidence_type === EVIDENCE_TYPES.EXECUTABLE_QUOTE) bucket.executable_quotes++;
    else if (a.evidence_type === EVIDENCE_TYPES.ACTUAL_PURCHASE) bucket.actual_purchases++;
  }
  return { ...bucket, fresh_observations: fresh, stale_observations: stale, total: all.length };
}

// ─── sorting + allocation ────────────────────────────────

function _sortForCurrentSupply(layers) {
  // Sort by:
  //   1. evidence_type rank (CURRENT_SUPPLY_ORDER)
  //   2. unit_cost_krw_per_physical ascending
  //   3. observed_at DESC (fresher first for tiebreak)
  return [...layers].sort((a, b) => {
    const ra = TRUST_RANK[a.evidence_type] || 0;
    const rb = TRUST_RANK[b.evidence_type] || 0;
    if (rb !== ra) return rb - ra;
    if (a.unit_cost_krw_per_physical !== b.unit_cost_krw_per_physical) return a.unit_cost_krw_per_physical - b.unit_cost_krw_per_physical;
    return (b.observed_at || '').localeCompare(a.observed_at || '');
  });
}

function _allocate(target, layers) {
  let remaining = target;
  let totalCost = 0;
  const source_mix = [];
  let marginalUnitCost = null;
  for (const layer of layers) {
    if (remaining <= 0) break;
    const take = Math.min(layer.available_physical_units, remaining);
    if (take <= 0) continue;
    const cost = take * layer.unit_cost_krw_per_physical;
    totalCost += cost;
    remaining -= take;
    marginalUnitCost = layer.unit_cost_krw_per_physical;
    source_mix.push({
      observation_id: layer.observation_id,
      source_name: layer.source_name,
      source_class: layer.source_class,
      evidence_type: layer.evidence_type,
      units_taken: take,
      unit_cost_krw: layer.unit_cost_krw_per_physical,
      subtotal_krw: Math.round(cost * 100) / 100,
    });
  }
  const covered = target - remaining;
  const uncovered = remaining;
  const evidenceConfidence = uncovered > 0 ? 'partial'
    : source_mix.length >= 3 ? 'high'
    : source_mix.length >= 2 ? 'medium' : 'low';
  return {
    target_quantity: target,
    covered_quantity: covered,
    uncovered_quantity: uncovered,
    total_product_cost_krw: covered > 0 ? Math.round(totalCost * 100) / 100 : null,
    average_product_cost_krw_per_unit: covered > 0 ? Math.round((totalCost / covered) * 100) / 100 : null,
    marginal_last_unit_cost_krw: marginalUnitCost,
    evidence_confidence: evidenceConfidence,
    source_mix,
  };
}

// ─── difficulty ──────────────────────────────────────────

function _classifyDifficulty(curve, layers, targets) {
  const supplierNames = new Set(
    layers.filter(l => l.evidence_type === EVIDENCE_TYPES.SUPPLIER_QUOTE || l.evidence_type === EVIDENCE_TYPES.EXECUTABLE_QUOTE)
          .map(l => l.source_name).filter(Boolean)
  );
  const supplierDiversity = supplierNames.size;

  const step30 = curve.find(c => c.target_quantity === 30) || curve.find(c => c.target_quantity >= 30);
  const step100 = curve.find(c => c.target_quantity === 100) || curve.find(c => c.target_quantity >= 100);

  const reasons = [];

  if (layers.length === 0) return { status: DIFFICULTY.UNKNOWN, reason_codes: ['no_current_supply_layers'], supplier_diversity: supplierDiversity };

  // Compute secondary-market dependency at 60-unit target
  const step60 = curve.find(c => c.target_quantity === 60) || curve.find(c => c.target_quantity >= 60);
  let secDep = 0;
  if (step60 && step60.covered_quantity > 0) {
    const secTaken = step60.source_mix.filter(m => m.evidence_type === EVIDENCE_TYPES.SECONDARY_MARKET_ASK).reduce((a, m) => a + m.units_taken, 0);
    secDep = secTaken / step60.covered_quantity;
  }

  // Rules
  if (step30 && step30.uncovered_quantity > 0) { reasons.push('cannot_cover_30_units'); return { status: DIFFICULTY.VERY_HARD, reason_codes: reasons, supplier_diversity: supplierDiversity, secondary_market_dependency_at_60: secDep }; }
  if (secDep > 0.5) { reasons.push(`secondary_market_dep_${(secDep * 100).toFixed(0)}pct_at_60`); return { status: DIFFICULTY.HARD, reason_codes: reasons, supplier_diversity: supplierDiversity, secondary_market_dependency_at_60: secDep }; }
  if (step100 && step100.uncovered_quantity === 0 && supplierDiversity >= 2 && secDep === 0) { reasons.push('100_covered_by_supplier_tier_diverse'); return { status: DIFFICULTY.EASY, reason_codes: reasons, supplier_diversity: supplierDiversity, secondary_market_dependency_at_60: secDep }; }
  if (step30 && step30.uncovered_quantity === 0) { reasons.push('30_covered_but_100_or_diversity_insufficient'); return { status: DIFFICULTY.MODERATE, reason_codes: reasons, supplier_diversity: supplierDiversity, secondary_market_dependency_at_60: secDep }; }
  reasons.push('coverage_insufficient_at_all_targets');
  return { status: DIFFICULTY.UNKNOWN, reason_codes: reasons, supplier_diversity: supplierDiversity, secondary_market_dependency_at_60: secDep };
}

/**
 * 7C-6 (Owner §10): per-source depth summary for SECONDARY_MARKET_ASK.
 * Individual observations are still preserved in `supply_layers`.
 */
function _summariseSecondaryMarketDepth(layers) {
  const secLayers = layers.filter(l => l.evidence_type === EVIDENCE_TYPES.SECONDARY_MARKET_ASK);
  const bySource = new Map();
  for (const l of secLayers) {
    const key = l.source_name || 'unknown';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(l);
  }
  const out = [];
  for (const [source_name, arr] of bySource.entries()) {
    const prices = arr.map(l => l.unit_cost_krw_per_physical).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const totalQty = arr.reduce((a, l) => a + (Number(l.available_physical_units) || 0), 0);
    out.push({
      source_name,
      observed_listings: arr.length,
      observed_quantity: totalQty,
      min_ask: prices.length ? prices[0] : null,
      median_ask: prices.length ? _median(prices) : null,
      max_ask: prices.length ? prices[prices.length - 1] : null,
    });
  }
  return out.sort((a, b) => (b.observed_quantity || 0) - (a.observed_quantity || 0));
}

function _median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _secondaryDependency(curve) {
  return curve.map(c => {
    const taken = c.source_mix.reduce((a, m) => a + m.units_taken, 0);
    const secTaken = c.source_mix.filter(m => m.evidence_type === EVIDENCE_TYPES.SECONDARY_MARKET_ASK).reduce((a, m) => a + m.units_taken, 0);
    return {
      target_quantity: c.target_quantity,
      secondary_market_units: secTaken,
      total_units_taken: taken,
      secondary_dependency_pct: taken > 0 ? Math.round((secTaken / taken) * 10000) / 100 : 0,
    };
  });
}

// ─── verdict ─────────────────────────────────────────────

function _verdict(layers, curve, evidenceSummary) {
  const reasons = [];
  const missing = [];
  if (layers.length === 0) {
    reasons.push('no_current_supply_layers');
    if (evidenceSummary.total === 0) missing.push('any_replacement_observation');
    else missing.push('fresh_strong_identity_supply_layer');
    return { status: CURVE_STATUS.UNKNOWN, reason_codes: reasons, missing_evidence: missing };
  }
  const step100 = curve.find(c => c.target_quantity === 100) || curve[curve.length - 1];
  if (step100 && step100.uncovered_quantity === 0) return { status: CURVE_STATUS.COVERED, reason_codes: ['largest_target_fully_covered'], missing_evidence: missing };
  reasons.push(`largest_target_uncovered_by_${step100 ? step100.uncovered_quantity : 'unknown'}_units`);
  return { status: CURVE_STATUS.PARTIAL_COVERAGE, reason_codes: reasons, missing_evidence: missing };
}

// ─── helpers ─────────────────────────────────────────────

function _num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _emptyReport(physicalProductId, nowMs, error) {
  return {
    physical_product_id: physicalProductId, generated_at: new Date(nowMs).toISOString(),
    error, physical: null, target_quantities: DEFAULT_TARGETS,
    evidence_summary: { supplier_quotes: 0, secondary_market_asks: 0, executable_quotes: 0, actual_purchases: 0, fresh_observations: 0, stale_observations: 0, total: 0 },
    supply_layers: [], excluded_layers: [], replacement_curve: [],
    secondary_market_dependency: [], replacement_difficulty: { status: DIFFICULTY.UNKNOWN, reason_codes: [error] },
    verdict: { status: CURVE_STATUS.UNKNOWN, reason_codes: [error], missing_evidence: [error] },
    policy_reference: { policy_source: 'provisional' },
  };
}

module.exports = {
  CURVE_STATUS, DIFFICULTY, DEFAULT_TARGETS,
  buildReplacementSupplyCurve,
  _internals: { _analyseRow, _allocate, _sortForCurrentSupply, _classifyDifficulty },
};
