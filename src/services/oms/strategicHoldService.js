/**
 * src/services/oms/strategicHoldService.js — Phase 7B · READ-ONLY.
 *
 * Owner directive (Phase 7B):
 *   Decision-support layer ONLY. Never mutates inventory, reservations,
 *   marketplace, mappings, or historical OMS rows. Consumes Phase 7A-4e
 *   trusted cross-channel velocity as the SINGLE source for demand.
 *
 * Absolute rules:
 *   - if overall trusted velocity is false → status='insufficient_evidence'
 *   - replacement price / scarcity evidence UNKNOWN unless a real producer
 *     exists in the repo (Owner Part C audit — none exists yet)
 *   - reservations != sales; strategic hold != reservation
 *   - `strategic_hold_recommended_units = null` means "insufficient evidence"
 *     `= 0` means "sufficient evidence and no hold recommended"
 *   - observed velocity is preserved verbatim; adjusted velocity is never
 *     computed here without an explicitly defensible method
 *   - never call any marketplace API; never write any table
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { getPhysicalInventoryState } = require('./inventoryShadowService');
const { computeMultiChannelPhysicalSales } = require('./channelSalesEvidence');
const { analysePhysicalIdentity } = require('./physicalIdentityDiagnostic');
const { getPolicy } = require('./strategicHoldPolicy');
const { buildReplacementSupplyCurve } = require('./replacementSupplyCurveService');
const { EVIDENCE_TYPES } = require('./replacementEvidenceTypes');

const ONE_DAY_MS = 86400_000;

const STATUS = Object.freeze({
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  SELL_NORMALLY: 'SELL_NORMALLY',
  PROTECT_OPERATING_STOCK: 'PROTECT_OPERATING_STOCK',
  STRATEGIC_HOLD_CANDIDATE: 'STRATEGIC_HOLD_CANDIDATE',
  REPLENISH_CANDIDATE: 'REPLENISH_CANDIDATE',
  REVIEW_DEMAND_SHOCK: 'REVIEW_DEMAND_SHOCK',
  // 7C-7: supply-side risk states (READ-ONLY · never auto-hold)
  REVIEW_SUPPLY_RISK: 'REVIEW_SUPPLY_RISK',
  REVIEW_DEMAND_AND_SUPPLY_RISK: 'REVIEW_DEMAND_AND_SUPPLY_RISK',
});

const SUPPLY_QUALITY = Object.freeze({
  NONE: 'none',
  ASK_ONLY: 'ask_only',
  SUPPLIER_QUOTE: 'supplier_quote',
  EXECUTABLE: 'executable',
});

const DEMAND_PATTERN = Object.freeze({
  STABLE: 'stable',
  ACCELERATING: 'accelerating',
  CONCENTRATED_LARGE_ORDER: 'concentrated_large_order',
  SPARSE: 'sparse',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
});

/**
 * Assess strategic hold recommendation for a physical_product.
 * READ-ONLY. Zero writes to any table or marketplace.
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} [args.asOf=Date.now()]
 * @param {Object} [args.policy]  override provisional defaults
 * @param {string[]} [args.channels=['shopify','ebay']]
 */
async function assessStrategicHold({ physicalProductId, asOf = Date.now(), policy, channels = ['shopify', 'ebay'] } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const nowMs = asOf;
  const pol = getPolicy(policy);
  const db = getClient();

  // ── 1) Physical product ────────────────────────────────
  const { data: phy } = await db.from('physical_products')
    .select('id, canonical_title, set_code, set_name, language, region, unit_type').eq('id', physicalProductId).maybeSingle();
  if (!phy) return _errorReport(physicalProductId, nowMs, 'physical_not_found', pol);

  // ── 2) Inventory (physical ledger) ─────────────────────
  const inv = await getPhysicalInventoryState(physicalProductId);

  // ── 3) Demand (Phase 7A-4e unified trusted velocity) ──
  const multi = await computeMultiChannelPhysicalSales({ physicalProductId, days: 30, channels });

  // ── 4) Shipment-level events for demand-pattern analysis (Part E) ──
  const events = await _collectPhysicalShippedEvents(db, physicalProductId, channels, nowMs);
  const concentration = _computeConcentration({
    events, nowMs,
    trusted: multi.overall.trusted,
    velocity_7d: multi.overall.sales_velocity_7d,
    velocity_30d: multi.overall.sales_velocity_30d,
    policy: pol,
  });

  // ── 5) Supply / replacement evidence (Part C · audit-driven) ──
  const supply = await _collectSupplyEvidence(db, physicalProductId, nowMs, pol);
  const historicalAccountingCost = await _collectHistoricalAccountingCost(db, physicalProductId);

  // ── 5a) 7C-7: consume replacementSupplyCurveService (single source of truth) ──
  const supplyCurve = await buildReplacementSupplyCurve({
    physicalProductId, asOf: nowMs, targetQuantities: [10, 30, 60, 100],
  });
  const supplyRisk = _deriveSupplyRisk(supplyCurve);
  const historicalReferenceContext = _deriveHistoricalReferenceContext(supplyCurve);

  // ── 6) Days of supply from trusted velocity + available ──
  const availableRaw = inv.available;
  const velocityForDoS = multi.overall.sales_velocity_30d;
  const rawDaysOfSupply = (multi.overall.trusted && velocityForDoS != null && velocityForDoS > 0 && availableRaw != null)
    ? Math.round((availableRaw / velocityForDoS) * 100) / 100
    : null;

  // ── 7) Recommendation ─────────────────────────────────
  const missing = [];
  const reasonCodes = [];
  const explanation = [];

  let status;
  let strategic_hold_recommended_units = null;
  let sellable_now_units = null;
  let replenish_recommended = false;

  const concentrated = concentration.demand_pattern === DEMAND_PATTERN.CONCENTRATED_LARGE_ORDER;
  const supplyRiskPresent = supplyRisk.supply_risk_present;

  if (!multi.overall.trusted) {
    status = STATUS.INSUFFICIENT_EVIDENCE;
    missing.push('trusted_cross_channel_velocity');
    reasonCodes.push('demand_untrusted');
    explanation.push(`Phase 7A trust gate: ${multi.overall.trust_gate_reason}`);
  } else if (concentrated && supplyRiskPresent) {
    // 7C-7: combined demand shock + supply risk
    status = STATUS.REVIEW_DEMAND_AND_SUPPLY_RISK;
    reasonCodes.push('demand_concentrated_large_order');
    reasonCodes.push(`largest_shipment_share_${(concentration.largest_shipment_share_30d * 100).toFixed(1)}pct`);
    for (const r of supplyRisk.reason_codes) reasonCodes.push(r);
    explanation.push(`Largest 30d shipment = ${concentration.largest_shipment_units_30d} of ${concentration.total_physical_units_30d} physical units (share ${(concentration.largest_shipment_share_30d * 100).toFixed(2)}%). Current supply is ${supplyRisk.current_supply_quality} with supplier_diversity=${supplyRisk.supplier_diversity}. Do NOT treat as steady-state.`);
    if (supply.replacement_price_status !== 'AVAILABLE') missing.push('replacement_price_current');
    if (supply.scarcity_evidence_status !== 'AVAILABLE') missing.push('scarcity_evidence');
  } else if (concentrated) {
    // 30d demand dominated by 1 large order — no supply-side data yet
    status = STATUS.REVIEW_DEMAND_SHOCK;
    reasonCodes.push('demand_concentrated_large_order');
    reasonCodes.push(`largest_shipment_share_${(concentration.largest_shipment_share_30d * 100).toFixed(1)}pct`);
    explanation.push(`Largest 30d shipment = ${concentration.largest_shipment_units_30d} of ${concentration.total_physical_units_30d} physical units (share ${(concentration.largest_shipment_share_30d * 100).toFixed(2)}%). Do not treat as steady-state demand.`);
    if (supply.replacement_price_status !== 'AVAILABLE') missing.push('replacement_price_current');
    if (supply.scarcity_evidence_status !== 'AVAILABLE') missing.push('scarcity_evidence');
  } else if (supplyRiskPresent) {
    // 7C-7: supply-only risk (demand steady)
    status = STATUS.REVIEW_SUPPLY_RISK;
    for (const r of supplyRisk.reason_codes) reasonCodes.push(r);
    explanation.push(`Demand is stable but current supply is ${supplyRisk.current_supply_quality} · supplier_diversity=${supplyRisk.supplier_diversity} · uncovered_at_60=${supplyRisk.uncovered_at_60} · secondary_dep_at_60=${(supplyRisk.secondary_market_dependency_at_60 * 100).toFixed(1)}%.`);
  } else {
    // Trusted + not concentrated. Decide by supply evidence.
    if (supply.replacement_price_status !== 'AVAILABLE') missing.push('replacement_price_current');
    if (supply.scarcity_evidence_status !== 'AVAILABLE') missing.push('scarcity_evidence');

    if (!pol.strategic_hold_enabled) {
      // Policy explicitly disables strategic hold recommendations.
      // Still recommend SELL_NORMALLY or PROTECT_OPERATING_STOCK based on stock cover.
      if (rawDaysOfSupply != null && rawDaysOfSupply < pol.minimum_operating_stock_days) {
        status = STATUS.PROTECT_OPERATING_STOCK;
        replenish_recommended = true;
        reasonCodes.push(`days_of_supply_below_min_operating_stock(${rawDaysOfSupply}<${pol.minimum_operating_stock_days})`);
      } else {
        status = STATUS.SELL_NORMALLY;
        reasonCodes.push('policy_strategic_hold_disabled');
      }
      // hold quantity remains null while policy disabled (Owner Part H: null vs 0 semantics)
    } else if (missing.length > 0) {
      // Policy enabled but supply evidence missing → cannot compute hold quantity
      status = STATUS.SELL_NORMALLY;
      reasonCodes.push('strategic_hold_evidence_missing_default_sell_normally');
    } else {
      // (Reserved for future: policy on + supply evidence present + not concentrated
      //  → STRATEGIC_HOLD_CANDIDATE with computed quantity)
      status = STATUS.STRATEGIC_HOLD_CANDIDATE;
      strategic_hold_recommended_units = Math.min(
        Math.floor(availableRaw * (pol.max_strategic_hold_pct / 100)),
        Math.max(0, availableRaw - Math.ceil(velocityForDoS * pol.minimum_operating_stock_days))
      );
      sellable_now_units = availableRaw - strategic_hold_recommended_units;
      reasonCodes.push('supply_evidence_present_and_policy_enabled');
    }

    if (rawDaysOfSupply != null && rawDaysOfSupply < pol.minimum_operating_stock_days) {
      replenish_recommended = true;
      reasonCodes.push('replenish_signal_days_of_supply_below_min');
    }
  }

  // Confidence
  let confidenceLevel = 'low';
  if (multi.overall.trusted && missing.length === 0 && supply.replacement_price_status === 'AVAILABLE') confidenceLevel = 'high';
  else if (multi.overall.trusted && missing.length <= 1) confidenceLevel = 'medium';

  // 7C-7: Owner §10 · gap between available inventory and evidenced replacement depth
  const evidencedDepth = supplyRisk.evidenced_replacement_depth;
  const depthGap = (availableRaw != null && evidencedDepth != null) ? (availableRaw - evidencedDepth) : null;
  const replacementGap = {
    available_inventory: availableRaw,
    evidenced_replacement_depth: evidencedDepth,
    depth_gap: depthGap,
    note: depthGap != null && depthGap > 0
      ? `${depthGap} units of currently available inventory exceed currently observed replacement depth. This is NOT the same as saying ${depthGap} units are "unreplaceable" — only that current supply evidence covers ${evidencedDepth} boxes today.`
      : depthGap != null && depthGap === 0
        ? 'Available inventory matches evidenced replacement depth exactly.'
        : depthGap != null && depthGap < 0
          ? `Evidenced replacement depth (${evidencedDepth}) exceeds current available inventory (${availableRaw}) — replacement supply is currently more than enough.`
          : 'depth_gap UNKNOWN (missing inventory or supply evidence).',
  };

  // 7C-7: Owner §7 · why hold quantity is null (explainable blockers)
  const holdQuantityBlockers = _computeHoldQuantityBlockers({
    concentrated, supplyRisk, replacementGap,
    hasCurrentSupplierQuote: supplyRisk.has_current_supplier_or_executable,
    holdQuantityIsNull: strategic_hold_recommended_units == null,
    strategicHoldEnabled: pol.strategic_hold_enabled,
  });

  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(nowMs).toISOString(),
    physical: phy,
    inventory: {
      on_hand: inv.on_hand,
      reserved: inv.reserved,
      available: inv.available,
    },
    demand: {
      trusted: multi.overall.trusted,
      units_7d: multi.overall.sales_units_7d,
      units_30d: multi.overall.sales_units_30d,
      velocity_7d: multi.overall.sales_velocity_7d,
      velocity_30d: multi.overall.sales_velocity_30d,
      raw_days_of_supply: rawDaysOfSupply,
      adjusted_velocity: null,  // Never computed here (Owner Part F)
      adjusted_velocity_method: null,
      source: 'phase_7a_multi_channel_trusted',
      trust_reason: multi.overall.trust_gate_reason,
      coverage_summary: multi.overall.coverage_summary,
    },
    demand_concentration: concentration,
    supply,
    supply_risk: supplyRisk,                          // 7C-7 · Owner §3
    replacement_gap: replacementGap,                  // 7C-7 · Owner §10
    historical_reference_context: historicalReferenceContext,   // 7C-7 · Owner §8
    historical_accounting_cost: historicalAccountingCost,
    policy: {
      minimum_operating_stock_days: pol.minimum_operating_stock_days,
      max_strategic_hold_pct: pol.max_strategic_hold_pct,
      minimum_confidence_required: pol.minimum_confidence_required,
      replacement_price_freshness_days: pol.replacement_price_freshness_days,
      scarcity_threshold: pol.scarcity_threshold,
      strategic_hold_enabled: pol.strategic_hold_enabled,
      policy_source: pol.policy_source,
      owner_confirmed_keys: pol.owner_confirmed_keys,
      provisional_keys: pol.provisional_keys,
    },
    recommendation: {
      status,
      sellable_now_units,
      operationally_reserved_units: inv.reserved,
      strategic_hold_recommended_units,   // null = insufficient evidence · 0 = sufficient and no hold
      replenish_recommended,
      reason_codes: reasonCodes,
      hold_quantity_blockers: holdQuantityBlockers,   // 7C-7 · Owner §7
      explanation: explanation.join(' '),
    },
    confidence: {
      level: confidenceLevel,
      missing_evidence: missing,
    },
    per_channel_evidence: multi.per_channel.map(c => ({
      channel: c.channel,
      channel_trusted: c.channel_trusted,
      shipped_units_7d: c.shipped_units_7d,
      shipped_units_30d: c.shipped_units_30d,
      identity_universe_confidence: c.physical_coverage.identity_universe_confidence,
      potential_unmapped_same_physical: c.physical_coverage.potential_unmapped_same_physical,
    })),
  };
}

// ─────────────────────────────────────────────────────────
// Concentration analysis (Part E)
// ─────────────────────────────────────────────────────────

function _computeConcentration({ events, nowMs, trusted, velocity_7d, velocity_30d, policy }) {
  const cutoff30 = nowMs - 30 * ONE_DAY_MS;
  const events30 = events.filter(e => e.occurredAtMs >= cutoff30 && e.physicalUnits > 0);
  const total = events30.reduce((a, e) => a + e.physicalUnits, 0);
  const largest = events30.reduce((m, e) => Math.max(m, e.physicalUnits), 0);
  const share = total > 0 ? largest / total : 0;
  const largestEvent = events30.find(e => e.physicalUnits === largest) || null;

  let ratio = null;
  if (velocity_7d != null && velocity_30d != null && velocity_30d > 0) {
    ratio = Math.round((velocity_7d / velocity_30d) * 1000) / 1000;
  }

  let pattern;
  if (!trusted) pattern = DEMAND_PATTERN.INSUFFICIENT_EVIDENCE;
  else if (events30.length === 0) pattern = DEMAND_PATTERN.SPARSE;
  else if (share > policy.concentration_share_threshold && events30.length <= policy.concentration_max_events) {
    pattern = DEMAND_PATTERN.CONCENTRATED_LARGE_ORDER;
  } else if (ratio != null && ratio > policy.acceleration_ratio_threshold) {
    pattern = DEMAND_PATTERN.ACCELERATING;
  } else {
    pattern = DEMAND_PATTERN.STABLE;
  }

  return {
    total_physical_units_30d: total,
    total_shipments_30d: events30.length,
    largest_shipment_units_30d: largest,
    largest_shipment_share_30d: Math.round(share * 10000) / 10000,
    velocity_ratio_7d_to_30d: ratio,
    demand_pattern: pattern,
    largest_shipment_evidence: largestEvent ? {
      order_id: largestEvent.orderId,
      channel: largestEvent.channel,
      occurred_at: new Date(largestEvent.occurredAtMs).toISOString(),
      physical_units: largestEvent.physicalUnits,
      external_order_number: largestEvent.externalOrderNumber ?? null,
    } : null,
  };
}

async function _collectPhysicalShippedEvents(db, physicalProductId, channels, nowMs) {
  const out = [];
  for (const ch of channels) {
    const r = await analysePhysicalIdentity({ physicalProductId, channel: ch, days: 30, nowMs });
    for (const e of (r.known_shipped_events || [])) {
      const t = e.shipped_at ? new Date(e.shipped_at).getTime() : null;
      if (t == null || (e.physical_units ?? 0) <= 0) continue;
      out.push({
        orderId: e.order_id,
        externalOrderNumber: e.external_order_number,
        channel: ch,
        occurredAtMs: t,
        physicalUnits: e.physical_units,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Supply / replacement evidence collection (Part C)
// ─────────────────────────────────────────────────────────

async function _collectSupplyEvidence(db, physicalProductId, nowMs, policy) {
  // physical_scarcity_snapshots — latest for this physical
  const { data: snap } = await db.from('physical_scarcity_snapshots')
    .select('id, physical_product_id, scarcity_score, replacement_price, replacement_price_currency, replacement_price_observed_at, replacement_price_source, replacement_availability, calculated_at, engine_version, usable_components')
    .eq('physical_product_id', physicalProductId)
    .order('calculated_at', { ascending: false })
    .limit(1);
  const latest = (snap || [])[0] || null;

  const freshCutoffMs = nowMs - (policy.replacement_price_freshness_days || 30) * ONE_DAY_MS;

  let replacement_price_status = 'UNKNOWN';
  let replacement_price = null;
  let replacement_price_currency = null;
  let replacement_price_source = null;
  let replacement_price_observed_at = null;

  if (latest && latest.replacement_price != null && latest.replacement_price_observed_at) {
    const obsMs = new Date(latest.replacement_price_observed_at).getTime();
    replacement_price = latest.replacement_price;
    replacement_price_currency = latest.replacement_price_currency;
    replacement_price_source = latest.replacement_price_source;
    replacement_price_observed_at = latest.replacement_price_observed_at;
    replacement_price_status = (obsMs >= freshCutoffMs) ? 'AVAILABLE' : 'STALE';
  }

  const scarcity_evidence_status = latest && latest.scarcity_score != null ? 'AVAILABLE' : 'UNKNOWN';
  const scarcity_score = latest?.scarcity_score ?? null;

  const replacement_availability_status = latest && latest.replacement_availability != null ? 'AVAILABLE' : 'UNKNOWN';
  const replacement_availability = latest?.replacement_availability ?? null;

  return {
    replacement_price_status,
    replacement_price,
    replacement_price_currency,
    replacement_price_source,
    replacement_price_observed_at,
    replacement_availability_status,
    replacement_availability,
    scarcity_evidence_status,
    scarcity_score,
    latest_snapshot_id: latest?.id ?? null,
    latest_snapshot_calculated_at: latest?.calculated_at ?? null,
    latest_snapshot_engine_version: latest?.engine_version ?? null,
    notes: latest
      ? 'physical_scarcity_snapshots present · replacement/scarcity fields may still be UNKNOWN if writers are not populating them'
      : 'no physical_scarcity_snapshots row · both replacement price and scarcity remain UNKNOWN',
  };
}

async function _collectHistoricalAccountingCost(db, physicalProductId) {
  // Walk graph: physical → sellable_unit_components (qty=1 primary) → sku_master_link → sku_master.cost_krw
  const { data: comps } = await db.from('sellable_unit_components')
    .select('sellable_unit_id, quantity_per_unit').eq('physical_product_id', physicalProductId);
  const oneBoxSellable = (comps || []).find(c => c.quantity_per_unit === 1);
  if (!oneBoxSellable) {
    return {
      status: 'UNKNOWN', cost_krw: null,
      source: null, caveat: 'no 1-box sellable_unit_component for this physical',
    };
  }
  const { data: links } = await db.from('sku_master_link')
    .select('sku_master_id, sellable_unit_id').eq('sellable_unit_id', oneBoxSellable.sellable_unit_id);
  const skuIds = (links || []).map(l => l.sku_master_id);
  if (!skuIds.length) return { status: 'UNKNOWN', cost_krw: null, source: null, caveat: 'no sku_master_link' };
  const { data: skus } = await db.from('sku_master').select('id, internal_sku, cost_krw').in('id', skuIds);
  const withCost = (skus || []).filter(s => s.cost_krw != null);
  if (!withCost.length) return { status: 'UNKNOWN', cost_krw: null, source: null, caveat: 'no cost_krw on any bridged sku_master' };
  // Report the median (or single) cost_krw for the 1-box unit
  const values = withCost.map(s => Number(s.cost_krw)).sort((a, b) => a - b);
  const median = values.length % 2 === 0
    ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
    : values[(values.length - 1) / 2];
  return {
    status: 'HISTORICAL_ACCOUNTING_ONLY',
    cost_krw: median,
    currency: 'KRW',
    source: `sku_master.cost_krw (${withCost.length} bridged 1-box sku_masters)`,
    bridged_sku_masters: withCost.map(s => ({ id: s.id, internal_sku: s.internal_sku, cost_krw: s.cost_krw })),
    caveat: 'last-known wholesale cost · mutable · not time-stamped · NOT current replacement cost',
  };
}

// ─────────────────────────────────────────────────────────
// 7C-7 helpers — consume replacementSupplyCurveService
// ─────────────────────────────────────────────────────────

function _deriveSupplyRisk(curve) {
  const layers = curve.supply_layers || [];
  const currentSupplyLayers = layers.length;
  const supplyQuality = _classifySupplyQuality(layers);
  const supplierDiversity = curve.replacement_difficulty?.supplier_diversity ?? 0;
  const coverage = {};
  for (const c of (curve.replacement_curve || [])) {
    coverage[c.target_quantity] = {
      target: c.target_quantity,
      covered: c.covered_quantity,
      uncovered: c.uncovered_quantity,
      total_krw: c.total_product_cost_krw,
      average_krw: c.average_product_cost_krw_per_unit,
      marginal_last_krw: c.marginal_last_unit_cost_krw,
      confidence: c.evidence_confidence,
    };
  }
  // 7C-7 hotfix (Owner): expose full per-target secondary_market_dependency map,
  // not only 30/60. curve.secondary_market_dependency already contains every
  // requested target — the previous projection accidentally dropped 10/100.
  const dep = {};
  const depByTarget = {};
  for (const d of (curve.secondary_market_dependency || [])) {
    const pct = (d.secondary_dependency_pct ?? 0) / 100;
    dep[d.target_quantity] = pct;
    depByTarget[d.target_quantity] = pct;
  }
  const evidencedDepth = layers.reduce((a, l) => a + (Number(l.available_physical_units) || 0), 0);
  const largestCoverable = Math.max(0, ...Object.values(coverage).filter(c => c.uncovered === 0).map(c => c.target));
  const hasCurrentSupplierOrExecutable = layers.some(l =>
    l.evidence_type === EVIDENCE_TYPES.SUPPLIER_QUOTE ||
    l.evidence_type === EVIDENCE_TYPES.EXECUTABLE_QUOTE
  );
  const uncoveredAt60 = coverage[60]?.uncovered ?? null;
  const uncoveredAt100 = coverage[100]?.uncovered ?? null;
  const difficulty = curve.replacement_difficulty?.status || 'UNKNOWN';

  // supply_risk_present: only when we have SOME layers AND (any risk indicator)
  const supplyRiskPresent = currentSupplyLayers > 0 && (
    supplierDiversity < 2 ||
    supplyQuality === SUPPLY_QUALITY.ASK_ONLY ||
    (uncoveredAt60 != null && uncoveredAt60 > 0) ||
    (dep[60] != null && dep[60] > 0.5) ||
    difficulty === 'HARD' || difficulty === 'VERY_HARD'
  );

  const reasonCodes = [];
  if (supplyRiskPresent) {
    if (supplyQuality === SUPPLY_QUALITY.ASK_ONLY) reasonCodes.push('current_supply_ask_only');
    if (supplierDiversity === 0) reasonCodes.push('supplier_diversity_zero');
    else if (supplierDiversity === 1) reasonCodes.push('supplier_diversity_one');
    if (uncoveredAt60 != null && uncoveredAt60 > 0) reasonCodes.push(`uncovered_at_60_${uncoveredAt60}`);
    if (dep[60] != null && dep[60] > 0.5) reasonCodes.push(`secondary_market_dependency_at_60_${(dep[60] * 100).toFixed(0)}pct`);
    if (difficulty === 'HARD' || difficulty === 'VERY_HARD') reasonCodes.push(`replacement_difficulty_${difficulty.toLowerCase()}`);
    if (!hasCurrentSupplierOrExecutable) reasonCodes.push('no_current_primary_supplier_quote');
  }

  const secondaryDepth = curve.secondary_market_depth || [];
  const minSecondaryAsk = _minOfSecondary(secondaryDepth);

  return {
    verdict: curve.verdict?.status || 'UNKNOWN',
    verdict_reason_codes: curve.verdict?.reason_codes || [],
    supply_risk_present: supplyRiskPresent,
    current_supply_layers: currentSupplyLayers,
    current_supply_quality: supplyQuality,
    supplier_diversity: supplierDiversity,
    has_current_supplier_or_executable: hasCurrentSupplierOrExecutable,
    replacement_difficulty: difficulty,
    replacement_difficulty_reason_codes: curve.replacement_difficulty?.reason_codes || [],
    secondary_market_dependency_at_30: dep[30] ?? 0,
    secondary_market_dependency_at_60: dep[60] ?? 0,
    // Full per-target map — sourced verbatim from replacementSupplyCurveService.
    secondary_market_dependency_by_target: depByTarget,
    replacement_coverage_10: coverage[10] || null,
    replacement_coverage_30: coverage[30] || null,
    replacement_coverage_60: coverage[60] || null,
    replacement_coverage_100: coverage[100] || null,
    largest_currently_coverable_target: largestCoverable,
    uncovered_at_60: uncoveredAt60,
    uncovered_at_100: uncoveredAt100,
    evidenced_replacement_depth: evidencedDepth,
    observed_secondary_market_unit_cost_min: minSecondaryAsk,
    secondary_market_depth: secondaryDepth,
    evidence_confidence: currentSupplyLayers === 0 ? 'none'
      : (supplyQuality === SUPPLY_QUALITY.EXECUTABLE ? 'medium' : 'low'),
    reason_codes: reasonCodes,
    source: 'replacement_supply_curve_service_v1',
    note: 'Consumed from replacementSupplyCurveService · single source of truth · no duplicated math.',
  };
}

function _classifySupplyQuality(layers) {
  if (layers.length === 0) return SUPPLY_QUALITY.NONE;
  if (layers.some(l => l.evidence_type === EVIDENCE_TYPES.EXECUTABLE_QUOTE)) return SUPPLY_QUALITY.EXECUTABLE;
  if (layers.some(l => l.evidence_type === EVIDENCE_TYPES.SUPPLIER_QUOTE))  return SUPPLY_QUALITY.SUPPLIER_QUOTE;
  if (layers.every(l => l.evidence_type === EVIDENCE_TYPES.SECONDARY_MARKET_ASK)) return SUPPLY_QUALITY.ASK_ONLY;
  return SUPPLY_QUALITY.ASK_ONLY;
}

function _minOfSecondary(depth) {
  const mins = (depth || []).map(d => d.min_ask).filter(v => Number.isFinite(v) && v > 0);
  return mins.length ? Math.min(...mins) : null;
}

function _deriveHistoricalReferenceContext(curve) {
  const layers = curve.historical_reference_layers || [];
  const prices = layers.map(l => l.unit_cost_krw_per_physical).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  let medianKrw = null;
  if (prices.length) {
    const mid = Math.floor(prices.length / 2);
    medianKrw = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  }
  return {
    historical_reference_layers: layers,
    historical_typical_supplier_cost_krw_median: medianKrw,
    observation_count: layers.length,
    note: 'HISTORICAL context only · NEVER counted as current supply · NEVER justifies hold quantity or reduces uncovered.',
  };
}

function _computeHoldQuantityBlockers({ concentrated, supplyRisk, replacementGap, hasCurrentSupplierQuote, holdQuantityIsNull, strategicHoldEnabled }) {
  const b = [];
  if (concentrated) b.push('demand_concentrated_large_order');
  if (supplyRisk.current_supply_quality === SUPPLY_QUALITY.ASK_ONLY) b.push('current_supply_is_ask_only');
  if (supplyRisk.supplier_diversity === 0) b.push('supplier_diversity_zero');
  if (!hasCurrentSupplierQuote) b.push('no_current_primary_supplier_quote');
  if (supplyRisk.uncovered_at_60 != null && supplyRisk.uncovered_at_60 > 0) b.push('replacement_coverage_60_partial');
  if (supplyRisk.secondary_market_dependency_at_60 > 0.5) b.push('secondary_market_dependency_high');
  if (supplyRisk.replacement_difficulty === 'HARD' || supplyRisk.replacement_difficulty === 'VERY_HARD') b.push(`replacement_difficulty_${supplyRisk.replacement_difficulty.toLowerCase()}`);
  if (replacementGap.depth_gap != null && replacementGap.depth_gap > 0) b.push('replacement_depth_below_available_inventory');
  if (!strategicHoldEnabled) b.push('policy_strategic_hold_disabled');
  return b;
}

function _errorReport(physicalProductId, nowMs, reason, pol) {
  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(nowMs).toISOString(),
    error: reason,
    inventory: null,
    demand: null,
    demand_concentration: null,
    supply: null,
    historical_accounting_cost: null,
    policy: {
      minimum_operating_stock_days: pol.minimum_operating_stock_days,
      max_strategic_hold_pct: pol.max_strategic_hold_pct,
      policy_source: pol.policy_source,
    },
    recommendation: {
      status: STATUS.INSUFFICIENT_EVIDENCE,
      sellable_now_units: null,
      operationally_reserved_units: null,
      strategic_hold_recommended_units: null,
      replenish_recommended: false,
      reason_codes: [reason],
      explanation: reason,
    },
    confidence: { level: 'low', missing_evidence: [reason] },
  };
}

module.exports = {
  STATUS,
  DEMAND_PATTERN,
  SUPPLY_QUALITY,
  assessStrategicHold,
  // exposed for tests
  _internals: {
    _computeConcentration, _collectSupplyEvidence, _collectHistoricalAccountingCost,
    _deriveSupplyRisk, _deriveHistoricalReferenceContext, _computeHoldQuantityBlockers,
    _classifySupplyQuality,
  },
};
