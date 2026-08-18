'use strict';

/**
 * tests/oms/costLineageInvariants.test.js — Phase 8L · tests-first.
 *
 * Goal: prevent bad evidence from being promoted into trusted cost numbers.
 *
 * Test categories (per Phase 8L mandate):
 *   A. DATA_CORRUPTION / NUMERIC_INTEGRITY — bad data actually entering math
 *   B. CONFIDENCE / QUALITY ISSUE          — value real but confidence overstated
 *   C. STATISTICAL POLICY CANDIDATE        — probe only, no math change here
 *
 * SAFETY:
 *   Pure fixture tests · zero DB / API / marketplace / notification traffic.
 *   Uses upstream service `_internals` exports · never modifies production
 *   calculation policy inside this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals: holdInternals, SUPPLY_QUALITY } =
  require('../../src/services/oms/strategicHoldService');
const { EVIDENCE_TYPES } =
  require('../../src/services/oms/replacementEvidenceTypes');
const { deriveJudgmentConfidence, TIER } =
  require('../../src/services/oms/judgmentConfidencePolicy');
const { buildOwnerDecision, ACTION } =
  require('../../src/services/oms/inventoryOwnerDecisionService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

// ─── Fixture builders (mimic replacementSupplyCurveService shapes) ─

/**
 * Build a fake `curve` (as returned by replacementSupplyCurveService)
 * suitable for _deriveHistoricalReferenceContext / _deriveSupplyRisk.
 */
function makeCurve({
  historical_reference_layers = [],
  supply_layers = [],
  secondary_market_depth = [],
  replacement_curve = [
    { target_quantity: 10, covered_quantity: 10, uncovered_quantity: 0, total_product_cost_krw: 0, average_product_cost_krw_per_unit: 0 },
    { target_quantity: 30, covered_quantity: 30, uncovered_quantity: 0, total_product_cost_krw: 0, average_product_cost_krw_per_unit: 0 },
    { target_quantity: 60, covered_quantity: 30, uncovered_quantity: 30, total_product_cost_krw: 0, average_product_cost_krw_per_unit: 0 },
    { target_quantity: 100, covered_quantity: 30, uncovered_quantity: 70, total_product_cost_krw: 0, average_product_cost_krw_per_unit: 0 },
  ],
  replacement_difficulty = { status: 'HARD', reason_codes: ['ask_only_supply'], supplier_diversity: 0 },
  verdict = { status: 'AT_RISK', reason_codes: [] },
  evidence_summary = {},
} = {}) {
  return {
    physical_product_id: 1,
    generated_at: '2026-08-18T00:00:00Z',
    target_quantities: [10, 30, 60, 100],
    evidence_summary,
    supply_layers,
    historical_reference_layers,
    excluded_layers: [],
    replacement_curve,
    secondary_market_depth,
    replacement_difficulty,
    verdict,
  };
}

/**
 * historical_reference_layer shape produced by _publicHistoricalLayer:
 *   { observation_id, source_class, source_name, evidence_type,
 *     unit_cost_native, currency, unit_cost_krw_per_physical,
 *     availability_range, availability_confidence, lead_time_days,
 *     observed_at, age_days, reference_only, note }
 *
 * NOTE — the current `_deriveHistoricalReferenceContext` only sees this
 * public layer shape. `identity_ok` and `fresh` are NOT present on the
 * public layer (they're internal to `_analyseRow`). Which means: whether
 * identity/freshness filtering happens for the median is determined
 * ENTIRELY by whether the layer got included in `historical_reference_layers`
 * upstream at supply-curve time.
 */
function makeHistoricalLayer(overrides = {}) {
  // NOTE: uses spread (not ??) so explicit `null` overrides survive · A1 needs
  //   an actual-null unit_cost_krw_per_physical to exercise the filter.
  const base = {
    observation_id: Math.floor(Math.random() * 1e6),
    source_class: 'internal',
    source_name: 'staff reference',
    evidence_type: EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
    unit_cost_native: null,
    currency: 'KRW',
    unit_cost_krw_per_physical: 19500,
    availability_range: null,
    availability_confidence: null,
    lead_time_days: null,
    observed_at: '2026-08-15T00:00:00Z',
    age_days: 3,
    reference_only: true,
    note: 'TYPICAL_SUPPLIER_REFERENCE',
  };
  return { ...base, ...overrides };
}

/**
 * secondary_market_depth[i] shape produced by _summariseSecondaryMarketDepth.
 */
function makeSecondaryBucket(overrides = {}) {
  const prices = overrides.prices ?? [40000];
  const sorted = [...prices].sort((a, b) => a - b);
  const _median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  return {
    source_name: overrides.source_name ?? 'kream',
    observed_listings: overrides.observed_listings ?? prices.length,
    observed_quantity: overrides.observed_quantity ?? prices.length,
    min_ask: sorted[0] ?? null,
    median_ask: sorted.length ? _median(sorted) : null,
    max_ask: sorted[sorted.length - 1] ?? null,
    fresh_observations: overrides.fresh_observations ?? prices.length,
    stale_observations: overrides.stale_observations ?? 0,
    total: overrides.total ?? prices.length,
  };
}

// ─── Category A · DATA_CORRUPTION / NUMERIC_INTEGRITY ────

test('A1. FX-unavailable observations do NOT enter historical supplier KRW median (product_cost_krw_per_physical=null filtered)', () => {
  //   Simulates an ingested TYPICAL observation where the ingestor left
  //   product_cost_krw_per_physical=null because FX was unavailable at write.
  const curve = makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: null, currency: 'USD', unit_cost_native: 15 }),   // FX unavailable
      makeHistoricalLayer({ unit_cost_krw_per_physical: 19500, currency: 'KRW' }),                        // valid
      makeHistoricalLayer({ unit_cost_krw_per_physical: 20500, currency: 'KRW' }),                        // valid
    ],
  });
  const ctx = holdInternals._deriveHistoricalReferenceContext(curve);
  // Median of [19500, 20500] = 20000 · NOT influenced by the null layer
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 20000);
  assert.equal(ctx.observation_count, 3, 'observation_count includes all reference layers (raw shape) · median-eligible filter is separate');
});

test('A2. Zero-or-negative KRW values do NOT contribute to historical median', () => {
  const curve = makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: 0 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: -100 }),   // impossible
      makeHistoricalLayer({ unit_cost_krw_per_physical: 20000 }),
    ],
  });
  const ctx = holdInternals._deriveHistoricalReferenceContext(curve);
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 20000);
});

test('A3. NaN / Infinity / undefined KRW values do NOT contribute', () => {
  const curve = makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: NaN }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: Infinity }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: undefined }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 19500 }),
    ],
  });
  const ctx = holdInternals._deriveHistoricalReferenceContext(curve);
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 19500);
});

test('A4. Stale-only TYPICAL observations still populate historical_typical_median (they are HISTORICAL by definition, never current)', () => {
  //   TYPICAL_SUPPLIER_REFERENCE has freshness policy 365d and is EXPLICITLY
  //   historical. Owner Part 8 rule: staleness must NOT be treated as current.
  //   This test PINS the current behavior: median is computed regardless of
  //   individual age_days (no per-layer freshness filter at median time). The
  //   value stays labeled 'HISTORICAL_REFERENCE_ONLY' downstream.
  const curve = makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ observed_at: '2024-01-01T00:00:00Z', age_days: 900, unit_cost_krw_per_physical: 18000 }),
      makeHistoricalLayer({ observed_at: '2024-06-01T00:00:00Z', age_days: 750, unit_cost_krw_per_physical: 21000 }),
    ],
  });
  const ctx = holdInternals._deriveHistoricalReferenceContext(curve);
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 19500, 'raw median of the ancient observations is preserved (they ARE historical)');
  // But the note must clearly mark this as historical-only · never current
  assert.match(ctx.note, /HISTORICAL/);
  assert.match(ctx.note, /NEVER counted as current supply/);
});

test('A5. Empty historical_reference_layers → median null · observation_count 0 (never 0-fills to a fabricated value)', () => {
  const curve = makeCurve({ historical_reference_layers: [] });
  const ctx = holdInternals._deriveHistoricalReferenceContext(curve);
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, null);
  assert.equal(ctx.observation_count, 0);
});

test('A6. TYPICAL layers with foreign currency BUT resolved KRW price DO contribute (FX succeeded at write time · trust upstream)', () => {
  //   `unit_cost_krw_per_physical` is the AUTHORITATIVE KRW value produced by
  //   replacementLandedCost._resolveFx at write time. Presence of `currency:'USD'`
  //   just describes ORIGIN — it does not invalidate the KRW figure.
  const curve = makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ currency: 'USD', unit_cost_native: 15, unit_cost_krw_per_physical: 20250 }),   // USD 15 × 1350
      makeHistoricalLayer({ currency: 'JPY', unit_cost_native: 1500, unit_cost_krw_per_physical: 13500 }),  // JPY 1500 × 9
      makeHistoricalLayer({ currency: 'KRW', unit_cost_native: 19500, unit_cost_krw_per_physical: 19500 }),
    ],
  });
  const ctx = holdInternals._deriveHistoricalReferenceContext(curve);
  // Median of [13500, 19500, 20250] = 19500
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 19500);
});

test('A7. supply_risk secondary_market min · Math.min honored · never fabricated when no observations', () => {
  const emptyCurve = makeCurve({ secondary_market_depth: [] });
  const riskEmpty = holdInternals._deriveSupplyRisk(emptyCurve);
  assert.equal(riskEmpty.observed_secondary_market_unit_cost_min, null);
  assert.deepEqual(riskEmpty.secondary_market_depth, []);
});

test('A8. secondary_market bucket min_ask=null (no valid KRW prices) does NOT poison the global min', () => {
  const curve = makeCurve({
    secondary_market_depth: [
      makeSecondaryBucket({ source_name: 'kream', prices: [] /* min_ask=null */ }),
      makeSecondaryBucket({ source_name: 'bunjang', prices: [40000] }),
    ],
  });
  const risk = holdInternals._deriveSupplyRisk(curve);
  assert.equal(risk.observed_secondary_market_unit_cost_min, 40000);
});

// ─── Category B · CONFIDENCE / QUALITY ISSUE ───────────────

test('B1. Historical typical reference ONLY (no current supplier or executable quote) → cost dimension caps at MEDIUM (Phase 8K rule)', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: { current_supply_quality: 'ask_only', has_current_supplier_or_executable: false, secondary_market_depth: [] },
      historical_reference_product_cost: { observation_count: 4, median_krw_per_physical: 19500, status: 'HISTORICAL_REFERENCE_ONLY' },
      historical_accounting_cost: null,
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  assert.equal(judgment_confidence.by_dimension.cost.tier, 'MEDIUM');
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.supplier, 'MEDIUM', 'historical typical only → supplier ceiling MEDIUM');
});

test('B2. Secondary market observations do NOT lift supplier or accounting confidence · categories independent (Phase 8K rev.2)', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: {
        current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
        secondary_market_depth: Array.from({ length: 50 }, () => ({ min_ask: 40000, fresh_observations: 10, stale_observations: 0, total: 10 })),
        observed_secondary_market_unit_cost_min: 40000,
      },
      historical_reference_product_cost: null,    // no supplier
      historical_accounting_cost: null,           // no accounting
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  const cat = judgment_confidence.by_dimension.cost.category_tiers;
  assert.equal(cat.supplier, 'UNKNOWN', 'supplier UNKNOWN despite 500 secondary observations');
  assert.equal(cat.accounting, 'UNKNOWN', 'accounting UNKNOWN despite 500 secondary observations');
  assert.equal(cat.secondary_market, 'LOW', 'secondary always LOW ceiling');
  assert.equal(judgment_confidence.by_dimension.cost.tier, 'LOW', 'overall falls through to secondary (LOW) · never higher');
});

test('B3. Single secondary observation → secondary category still LOW · never HIGH', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: {
        current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
        secondary_market_depth: [{ source_name: 'kream', min_ask: 500, fresh_observations: 1, stale_observations: 0, total: 1 }],
        observed_secondary_market_unit_cost_min: 500,
      },
      historical_reference_product_cost: null,
      historical_accounting_cost: null,
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.secondary_market, 'LOW');
  assert.notEqual(judgment_confidence.by_dimension.cost.category_tiers.secondary_market, 'HIGH');
});

test('B4. Freshness UNKNOWN (no replacement_price_observed_at) → cost supplier tier NEVER HIGH even with executable quote', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: {
        current_supply_quality: 'executable', has_current_supplier_or_executable: true,
        secondary_market_depth: [],
      },
      historical_reference_context: {},   // no replacement_price_observed_at
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.supplier, 'MEDIUM');
  assert.notEqual(judgment_confidence.by_dimension.cost.category_tiers.supplier, 'HIGH');
  assert.equal(judgment_confidence.by_dimension.cost.freshness_verified, false);
});

test('B5. Accounting cost without observed_at is preserved as raw value · but supplier & accounting tier never HIGH', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: { current_supply_quality: 'none', has_current_supplier_or_executable: false, secondary_market_depth: [] },
      historical_accounting_cost: { cost_krw: 45000, currency: 'KRW', status: 'HISTORICAL_ACCOUNTING_ONLY' },   // no observed_at
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  const cat = judgment_confidence.by_dimension.cost.category_tiers;
  assert.equal(cat.accounting, 'MEDIUM', 'accounting present but freshness unverifiable → MEDIUM ceiling');
  assert.notEqual(cat.accounting, 'HIGH');
});

test('B6. TYPICAL supplier reference is NOT surfaced as current executable supplier cost anywhere in decision', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: { current_supply_quality: 'ask_only', has_current_supplier_or_executable: false, secondary_market_depth: [] },
      historical_reference_product_cost: { observation_count: 3, status: 'HISTORICAL_REFERENCE_ONLY', median_krw_per_physical: 19500, note: 'never current' },
      historical_reference_context: { historical_typical_supplier_cost_krw_median: 19500 },
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  // has_current_supplier_or_executable=false → supplier action MUST fire
  assert.ok(judgment_confidence.by_dimension.supply.recommended_evidence_actions.includes(ACTION.CHECK_PRIMARY_SUPPLIER));
});

// ─── Category B (extra) · secondary market outlier CANNOT masquerade as executable ─

test('B7. Extreme low secondary outlier (500 KRW) never becomes supplier or accounting cost · only surfaces as secondary tier LOW', () => {
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: {
        current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
        secondary_market_depth: [{ source_name: 'bunjang', min_ask: 500, fresh_observations: 1, stale_observations: 0, total: 1 }],
        observed_secondary_market_unit_cost_min: 500,
      },
      historical_reference_product_cost: null,
      historical_accounting_cost: null,
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.supplier, 'UNKNOWN');
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.accounting, 'UNKNOWN');
  // Raw value is preserved (Owner rule §4: don't delete unusual observations)
  //   — surfaced in Phase 8E cost_context passthrough (verified below in Category C7)
});

// ─── Category B (extra) · owner_decision surface passthrough ─

test('B8. buildOwnerDecision preserves raw secondary outlier (500) verbatim in cost_context · never sanitizes', async () => {
  const fx = {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    physical: { id: 1, canonical_title: 'x', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: { trusted: true, units_7d: 0, units_30d: 0, velocity_30d: 0, raw_days_of_supply: null, demand_pattern: 'stable' },
    supply_summary: { verdict: 'AT_RISK', current_supply_quality: 'ask_only', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD', evidenced_replacement_depth: 0, uncovered_at_60: 60, uncovered_at_100: 100, secondary_market_dependency_by_target: { 60: 1.0 }, observed_secondary_market_unit_cost_min: 500, secondary_market_depth: [{ min_ask: 500, fresh_observations: 1 }] },
    cost_context: { historical_typical_supplier_cost_krw_median: null, historical_accounting_cost_krw: null, observed_secondary_market_ask_min_krw: 500 },
    missing_evidence: [], strategic_hold_source: {},
  };
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => fx });
  assert.equal(owner.cost_context.observed_secondary_market_ask_min_krw, 500, 'raw outlier preserved · Owner rule §4');
});

// ─── Category C · statistical policy PROBES (no math change) ────

test('C1. Historical median formula documented · odd/even correctness verified', () => {
  const odd = holdInternals._deriveHistoricalReferenceContext(makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: 10000 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 20000 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 30000 }),
    ],
  }));
  assert.equal(odd.historical_typical_supplier_cost_krw_median, 20000);

  const even = holdInternals._deriveHistoricalReferenceContext(makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: 10000 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 30000 }),
    ],
  }));
  assert.equal(even.historical_typical_supplier_cost_krw_median, 20000);
});

test('C2. STATISTICAL POLICY probe · single low outlier in 3-observation median = between-middle-value · CURRENT policy pinned (not changed)', () => {
  //   [1, 20000, 21000] → median = 20000 (middle value) · outlier does NOT skew
  //   This test pins current median behavior for regression only. Policy
  //   change (e.g., trimmed mean / percentile) requires Owner decision.
  const ctx = holdInternals._deriveHistoricalReferenceContext(makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: 1 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 20000 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 21000 }),
    ],
  }));
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 20000, 'CURRENT median policy · Owner decision required to change');
});

test('C3. STATISTICAL POLICY probe · 2-observation dataset uses AVERAGE (even-count median) · outlier CAN skew · pinned', () => {
  //   [1, 20000] → median = 10000.5 (skewed by outlier). This is CURRENT
  //   policy · flagged as a POLICY CANDIDATE for even-count small datasets.
  const ctx = holdInternals._deriveHistoricalReferenceContext(makeCurve({
    historical_reference_layers: [
      makeHistoricalLayer({ unit_cost_krw_per_physical: 1 }),
      makeHistoricalLayer({ unit_cost_krw_per_physical: 20000 }),
    ],
  }));
  assert.equal(ctx.historical_typical_supplier_cost_krw_median, 10000.5, 'CURRENT even-count median · single outlier skews · POLICY CANDIDATE');
});

test('C4. Secondary min uses lowest bucket · outlier bucket dominates min · CURRENT behavior pinned', () => {
  const curve = makeCurve({
    secondary_market_depth: [
      makeSecondaryBucket({ source_name: 'kream', prices: [40000, 42000] }),   // min 40000
      makeSecondaryBucket({ source_name: 'bunjang', prices: [500] }),          // min 500
    ],
  });
  const risk = holdInternals._deriveSupplyRisk(curve);
  assert.equal(risk.observed_secondary_market_unit_cost_min, 500, 'CURRENT min-of-buckets · single outlier dominates · POLICY CANDIDATE');
});

// ─── Cross-category · Phase 8K aggregation ───────────────

test('X1. Categories independent · combined count NEVER lifts a lower-tier category', () => {
  //   Historical typical N=100 · secondary fresh N=500 · but no current supplier
  //   → supplier ceiling MEDIUM · secondary LOW · overall = supplier (priority) = MEDIUM
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: {
        current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
        secondary_market_depth: [{ source_name: 'kream', min_ask: 40000, fresh_observations: 500 }],
        observed_secondary_market_unit_cost_min: 40000,
      },
      historical_reference_product_cost: { observation_count: 100 },
      historical_accounting_cost: null,
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  const cat = judgment_confidence.by_dimension.cost.category_tiers;
  assert.equal(cat.supplier, 'MEDIUM');
  assert.equal(cat.secondary_market, 'LOW');
  assert.equal(judgment_confidence.by_dimension.cost.tier, 'MEDIUM');
});

test('X2. UNKNOWN category NEVER promoted by presence of other-category observations', () => {
  //   Only secondary market observations exist. supplier category MUST be
  //   UNKNOWN (no supplier evidence) · never LOW/MEDIUM/HIGH.
  const decisionResult = {
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    strategic_hold_source: {
      supply_risk: {
        current_supply_quality: 'ask_only', has_current_supplier_or_executable: false,
        secondary_market_depth: [{ source_name: 'kream', min_ask: 40000, fresh_observations: 100 }],
        observed_secondary_market_unit_cost_min: 40000,
      },
      historical_reference_product_cost: null,
      historical_accounting_cost: null,
      demand: { trusted: true },
      physical: { id: 1, canonical_title: 'x' },
    },
  };
  const { judgment_confidence } = deriveJudgmentConfidence(decisionResult);
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.supplier, 'UNKNOWN');
  assert.equal(judgment_confidence.by_dimension.cost.category_tiers.accounting, 'UNKNOWN');
});

test('X3. Provenance / source / category survive through Phase 8E projection', async () => {
  const fx = {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    physical: { id: 1, canonical_title: 'x', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 15 },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: { trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.03, raw_days_of_supply: 22, demand_pattern: 'concentrated_large_order' },
    supply_summary: { verdict: 'AT_RISK', current_supply_quality: 'ask_only', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, uncovered_at_60: 30, uncovered_at_100: 70, secondary_market_dependency_by_target: { 60: 1.0 }, observed_secondary_market_unit_cost_min: 40000, secondary_market_depth: [{ min_ask: 40000, fresh_observations: 2 }] },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    missing_evidence: [], strategic_hold_source: { supply_risk: { secondary_market_depth: [{ min_ask: 40000, fresh_observations: 2 }], observation_count: 2, observed_secondary_market_unit_cost_min: 40000 }, historical_reference_product_cost: { observation_count: 4, status: 'HISTORICAL_REFERENCE_ONLY' }, historical_accounting_cost: { cost_krw: 45000 } },
  };
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => fx });
  const dp = owner.data_provenance.cost_context;
  // Each cost category retains its own provenance source
  assert.equal(dp.historical_typical_supplier_cost_krw_median.source, 'physical_market_observations');
  assert.equal(dp.historical_accounting_cost_krw.source, 'internal_accounting');
  assert.equal(dp.observed_secondary_market_ask_min_krw.source, 'physical_market_observations');
  // Categories are NEVER merged
  assert.notEqual(dp.historical_typical_supplier_cost_krw_median.source, dp.historical_accounting_cost_krw.source);
});

// ─── sku_master.cost_krw canonical KRW contract ───────────

test('K1. sku_master.cost_krw is a canonical KRW field per src/services/oms/costFiller.js:15', () => {
  //   Contract audit: this is the sole authoritative statement of the schema
  //   invariant. Any code that reads sku_master.cost_krw without converting
  //   currency is CORRECT.
  const fs = require('fs');
  const path = require('path');
  const cf = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/costFiller.js'), 'utf8');
  assert.match(cf, /cost_krw\s+NUMERIC.*Currency\s*=\s*KRW/i, 'costFiller must document cost_krw as canonical KRW');
});

test('K2. schema migration 038 defines sku_master.cost_krw as NUMERIC (no currency column · confirms KRW-only invariant)', () => {
  const fs = require('fs');
  const path = require('path');
  const mig = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/038_phase1_sku_master_and_exception.sql'), 'utf8');
  assert.match(mig, /cost_krw\s+numeric/i);
  // No cost_currency column on sku_master → the field is KRW by definition
  assert.doesNotMatch(mig, /cost_currency\s+/i);
});

test('K3. accounting cost read (_collectHistoricalAccountingCost) treats sku_master.cost_krw as KRW · never converts', async () => {
  //   Stub db that returns rows the walker can pattern-match. We only exercise
  //   the pure walk logic · never any FX or conversion.
  const stubDb = {
    from(table) {
      const M = {
        'sellable_unit_components': [{ sellable_unit_id: 101, quantity_per_unit: 1 }],
        'sku_master_link': [{ sku_master_id: 501, sellable_unit_id: 101 }],
        'sku_master': [{ id: 501, internal_sku: 'BP-30BOX', cost_krw: 45000 }],
      };
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: M[table] || [], error: null }),
          in: () => Promise.resolve({ data: M[table] || [], error: null }),
        }),
      };
    },
  };
  const res = await holdInternals._collectHistoricalAccountingCost(stubDb, 1);
  assert.equal(res.cost_krw, 45000);
  assert.equal(res.currency, 'KRW', 'response labels currency KRW verbatim');
  assert.equal(res.status, 'HISTORICAL_ACCOUNTING_ONLY');
});

test('K4. buildOwnerDecision does NOT UNKNOWN a valid accounting cost merely because timestamp field is absent', async () => {
  //   Fresh-checkout regression guard: `cost_context.historical_accounting_cost_krw`
  //   present and non-null → Owner Decision preserves it verbatim.
  const fx = {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    physical: { id: 1, canonical_title: 'x', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 0 },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: { trusted: true, units_7d: 0, units_30d: 0, velocity_30d: 0, raw_days_of_supply: null, demand_pattern: 'stable' },
    supply_summary: { verdict: 'AT_RISK', current_supply_quality: 'none', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'UNKNOWN', evidenced_replacement_depth: 0, uncovered_at_60: 60, uncovered_at_100: 100, secondary_market_dependency_by_target: {}, observed_secondary_market_unit_cost_min: null, secondary_market_depth: [] },
    cost_context: { historical_typical_supplier_cost_krw_median: null, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: null },
    missing_evidence: [], strategic_hold_source: { historical_accounting_cost: { cost_krw: 45000, currency: 'KRW' } },
  };
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => fx });
  assert.equal(owner.cost_context.historical_accounting_cost_krw, 45000, 'value preserved · not UNKNOWNed');
});
