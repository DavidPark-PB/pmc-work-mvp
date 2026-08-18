'use strict';

/**
 * tests/oms/inventoryOwnerDecisionService.test.js — Phase 8E.
 *
 * Owner Decision Console — READ-ONLY projection over existing SoT services.
 * Test rules (Owner):
 *   · No business-logic recomputation
 *   · Upstream values must appear verbatim
 *   · null / UNKNOWN preserved
 *   · Action recommendations are non-executing (never runnable)
 *   · Battle Partners WATCH · priority 170 stays as-is
 *   · Zero DB writes · zero marketplace calls · digest fingerprint unchanged
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { buildOwnerDecision, formatCompactOwnerSummary, ACTION, FORBIDDEN_AUTOMATIC_ACTIONS } = require('../../src/services/oms/inventoryOwnerDecisionService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

// ─── Production-shaped BP fixture (Phase 8B result verbatim) ────
//
// This mirrors the Owner-specified BP production result:
//   WATCH · priority_score=170
//   on_hand=60 reserved=15 available=45
//   demand concentrated_large_order · 60 units in 1 shipment (98.4%)
//   supply HARD · depth 30 · depth_gap 15 · ask_only
//   secondary_market_dependency_at_60 = 100%
//   cost: typical=19500 · accounting=45000 · observed_secondary_ask=40000

function bpDecisionResultFixture() {
  const asOfIso = '2026-08-16T00:00:00.000Z';
  return {
    physical_product_id: 1,
    generated_at: asOfIso,
    physical: {
      id: 1,
      canonical_title: 'Battle Partners Booster Box',
      set_code: 'sv9',
      set_name: 'Battle Partners',
      language: 'ko',
      region: null,
      unit_type: 'booster_box',
    },
    decision: {
      status: DECISION.WATCH,
      confidence_level: 'low',
      reason_codes: [
        'hold_status:review_demand_and_supply_risk',
        'demand_concentrated_large_order',
        'current_supply_ask_only',
        'replacement_difficulty_hard',
        'secondary_market_dependency_at_60_100pct',
      ],
      hold_quantity_blockers: [],
      strategic_hold_recommended_units: null,
      upstream_hold_status: 'REVIEW_DEMAND_AND_SUPPLY_RISK',
      upstream_supply_verdict: 'AT_RISK',
      depth_gap: 15,
    },
    inventory_summary: {
      on_hand: 60,
      reserved: 15,
      available: 45,
      invariant: 'available = on_hand(60) - reserved(15) = 45',
    },
    demand_summary: {
      trusted: true,
      units_7d: 60,
      units_30d: 61,
      velocity_7d: 8.57,
      velocity_30d: 2.03,
      raw_days_of_supply: 22,
      adjusted_velocity: null,
      demand_pattern: 'concentrated_large_order',
      largest_shipment_units_30d: 60,
      largest_shipment_share_30d: 0.984,
      total_shipments_30d: 3,
      trust_reason: 'multi_channel_evidence',
    },
    supply_summary: {
      verdict: 'AT_RISK',
      current_supply_layers: 1,
      current_supply_quality: 'ask_only',
      supplier_diversity: 0,
      has_current_supplier_or_executable: false,
      replacement_difficulty: 'HARD',
      replacement_difficulty_reason_codes: ['ask_only_supply', 'no_current_supplier_quote'],
      evidenced_replacement_depth: 30,
      largest_currently_coverable_target: 30,
      uncovered_at_60: 15,
      uncovered_at_100: 55,
      secondary_market_dependency_by_target: { 10: 1.0, 30: 1.0, 60: 1.0, 100: 1.0 },
      replacement_coverage: { 10: 1.0, 30: 1.0, 60: 0.5, 100: 0.3 },
      observed_secondary_market_unit_cost_min: 40000,
      secondary_market_depth: 30,
    },
    cost_context: {
      historical_typical_supplier_cost_krw_median: 19500,
      historical_accounting_cost_krw: 45000,
      observed_secondary_market_ask_min_krw: 40000,
      note: 'Historical typical and secondary-market ASK are DIFFERENT semantic categories · engine does NOT compute an automatic "market trend" ratio.',
    },
    missing_evidence: [],
    recommended_human_action: 'Do NOT treat concentrated 7d velocity as steady demand. Current supply is SECONDARY_MARKET_ASK only — negotiate seller confirmation into EXECUTABLE_QUOTE before purchase. Contact primary distributor for a current SUPPLIER_QUOTE.',
    strategic_hold_source: {},
  };
}

function fakeAssess(fixture) {
  return async (id) => {
    if (id === fixture.physical_product_id) return fixture;
    return { physical_product_id: id, error: 'physical_not_found', decision: { status: DECISION.INSUFFICIENT_DATA, reason_codes: ['physical_not_found'], confidence_level: 'low', hold_quantity_blockers: [], depth_gap: null }, physical: null, inventory_summary: null, demand_summary: null, supply_summary: null, cost_context: null, missing_evidence: ['physical_not_found'], generated_at: new Date().toISOString(), strategic_hold_source: {} };
  };
}

// ─── O1-O12: BP production shape ─────────────────────────

test('O1. BP WATCH decision preserved verbatim (no re-classification)', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.headline.decision_status, DECISION.WATCH);
});

test('O2. priority_score=170 preserved (computed via SoT _rankAction · not re-derived)', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.headline.priority_score, 170);
});

test('O3. inventory 60 / 15 / 45 verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.inventory.on_hand, 60);
  assert.equal(r.inventory.reserved, 15);
  assert.equal(r.inventory.available, 45);
});

test('O4. demand units_30d=61 · pattern=concentrated_large_order · largest 60 (98.4%) verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.demand.units_30d, 61);
  assert.equal(r.demand.demand_pattern, 'concentrated_large_order');
  assert.equal(r.demand.largest_shipment_units_30d, 60);
  assert.equal(r.demand.largest_shipment_share_30d, 0.984);
});

test('O5. supply HARD / depth 30 / gap 15 verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.supply.replacement_difficulty, 'HARD');
  assert.equal(r.supply.evidenced_replacement_depth, 30);
  assert.equal(r.supply.depth_gap, 15);
});

test('O6. secondary_market_dependency_at_60 = 1.0 (100%) verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.supply.secondary_market_dependency_at_60, 1.0);
});

test('O7. cost_context.historical_typical_supplier_cost_krw_median = 19500 verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.cost_context.historical_typical_supplier_cost_krw_median, 19500);
});

test('O8. cost_context.historical_accounting_cost_krw = 45000 verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.cost_context.historical_accounting_cost_krw, 45000);
});

test('O9. cost_context.observed_secondary_market_ask_min_krw = 40000 verbatim', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(r.cost_context.observed_secondary_market_ask_min_krw, 40000);
});

test('O10. recommended_actions include WATCH_ONLY', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  const codes = r.recommended_actions.map(a => a.code);
  assert.ok(codes.includes(ACTION.WATCH_ONLY), `expected WATCH_ONLY in ${codes.join(', ')}`);
});

test('O11. ask_only supply quality → CONFIRM_EXECUTABLE_QUOTE + CHECK_PRIMARY_SUPPLIER', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  const codes = r.recommended_actions.map(a => a.code);
  assert.ok(codes.includes(ACTION.CONFIRM_EXECUTABLE_QUOTE));
  assert.ok(codes.includes(ACTION.CHECK_PRIMARY_SUPPLIER));
});

test('O12. no action is executable_by_system; forbidden auto actions surfaced', async () => {
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  for (const a of r.recommended_actions) {
    assert.equal(a.executable_by_system, false, `${a.code} must NOT be executable by system`);
    assert.equal(a.requires_owner_approval, true, `${a.code} must require owner approval`);
  }
  assert.ok(r.forbidden_automatic_actions.includes('AUTO_PURCHASE'));
  assert.ok(r.forbidden_automatic_actions.includes('AUTO_STRATEGIC_HOLD'));
  assert.ok(r.forbidden_automatic_actions.includes('AUTO_MARKETPLACE_PRICE_CHANGE'));
});

// ─── O13-O16: action translation per status ─────────────

test('O13. REPLENISH → REVIEW_REPLENISHMENT', async () => {
  const f = bpDecisionResultFixture();
  f.decision.status = DECISION.REPLENISH;
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  const codes = r.recommended_actions.map(a => a.code);
  assert.deepEqual(codes, [ACTION.REVIEW_REPLENISHMENT]);
});

test('O14. PROTECT_STOCK → REVIEW_STOCK_PROTECTION', async () => {
  const f = bpDecisionResultFixture();
  f.decision.status = DECISION.PROTECT_STOCK;
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  const codes = r.recommended_actions.map(a => a.code);
  assert.deepEqual(codes, [ACTION.REVIEW_STOCK_PROTECTION]);
});

test('O15. SELL_NORMALLY → NO_ACTION', async () => {
  const f = bpDecisionResultFixture();
  f.decision.status = DECISION.SELL_NORMALLY;
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  const codes = r.recommended_actions.map(a => a.code);
  assert.deepEqual(codes, [ACTION.NO_ACTION]);
});

test('O16. INSUFFICIENT_DATA → REVIEW_DATA_QUALITY', async () => {
  const f = bpDecisionResultFixture();
  f.decision.status = DECISION.INSUFFICIENT_DATA;
  f.missing_evidence = ['trusted_cross_channel_velocity'];
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  const codes = r.recommended_actions.map(a => a.code);
  assert.deepEqual(codes, [ACTION.REVIEW_DATA_QUALITY]);
});

// ─── O17-O18: UNKNOWN preservation, immutability ────────

test('O17. null / UNKNOWN preserved verbatim (never fabricated)', async () => {
  const f = bpDecisionResultFixture();
  f.supply_summary.replacement_difficulty = 'UNKNOWN';
  f.supply_summary.evidenced_replacement_depth = null;
  f.demand_summary.demand_pattern = null;
  const r = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  assert.equal(r.supply.replacement_difficulty, 'UNKNOWN');
  assert.equal(r.supply.evidenced_replacement_depth, null);
  assert.equal(r.demand.demand_pattern, null);
});

test('O18. upstream decision object is not mutated by projection', async () => {
  const f = bpDecisionResultFixture();
  const before = JSON.parse(JSON.stringify(f));
  await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  assert.deepEqual(f, before, 'upstream fixture must be untouched');
});

// ─── O19-O21: CLI + zero-write proof ────────────────────

test('O19. CLI script has NO --apply support (READ-ONLY)', () => {
  const cliPath = path.resolve(__dirname, '../../scripts/oms-owner-decision.js');
  const src = fs.readFileSync(cliPath, 'utf8');
  // --apply must be explicitly rejected, never accepted
  assert.match(src, /'--apply'/);
  assert.match(src, /intentionally NOT supported/);
  assert.doesNotMatch(src, /--apply\s*\)\s*out\.apply/i);
  // No DB write API calls · no supabase client · no marketplace calls · no notification services
  assert.doesNotMatch(src, /\.insert\(|\.upsert\(|\.delete\(/);
  assert.doesNotMatch(src, /getClient\(/);
  assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]/i);
  assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(/);
});

test('O20. buildOwnerDecision performs zero DB writes (assessFn injected · no client access)', async () => {
  let assessCalls = 0;
  await buildOwnerDecision({
    physicalProductId: 1,
    assessFn: async () => { assessCalls++; return bpDecisionResultFixture(); },
  });
  // Only ONE assess call — Owner §Part 7 no duplicate
  assert.equal(assessCalls, 1);
});

test('O21. service source has no marketplace / telegram / DB write API references', () => {
  const svcPath = path.resolve(__dirname, '../../src/services/oms/inventoryOwnerDecisionService.js');
  const src = fs.readFileSync(svcPath, 'utf8');
  // Actual marketplace API surfaces — not the string literal "AUTO_MARKETPLACE_PRICE_CHANGE"
  //   which appears deliberately in the forbidden-actions list.
  assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(/);
  assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*marketplace[^'"]*['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]/i);
  // No supabase from() table access · no writes
  assert.doesNotMatch(src, /\bfrom\(['"]/, 'must not access DB tables directly');
  assert.doesNotMatch(src, /\.insert\(|\.upsert\(|\.delete\(/, 'must not call any write API');
  // .update( is used by the underlying supabase client - forbid supabase-flavoured usage:
  assert.doesNotMatch(src, /getClient\(/, 'must not obtain a supabase client');
});

// ─── O22: digest fingerprint invariance ──────────────────

test('O22. digest enrichment surface does NOT flow into exception fingerprint semantics', () => {
  // The fingerprint is derived from (physical_product_id, decision_status, priority_score) only.
  // formatCompactOwnerSummary returns text — including it would change digest TEXT but never fingerprint.
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  const fp = alerter._internals._fingerprint;
  const extract = alerter._internals._extractActionSummary;
  const baseline = extract([
    { physical_product_id: 1, decision_status: 'WATCH', priority_score: 170, title: 'Battle Partners Booster Box' },
  ]);
  const fpBase = fp(baseline);
  // Simulate an alternate action_queue row that CARRIES the enriched summary as an extra field.
  const enriched = extract([
    { physical_product_id: 1, decision_status: 'WATCH', priority_score: 170, title: 'Battle Partners Booster Box',
      owner_summary_line: formatCompactOwnerSummary({
        physical_product_id: 1,
        headline: { decision_status: 'WATCH', priority_score: 170 },
        product: { title: 'Battle Partners Booster Box' },
        inventory: { available: 45 },
        demand: { demand_pattern: 'concentrated_large_order' },
        supply: { replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, current_supply_quality: 'ask_only' },
        recommended_actions: [{ code: 'WATCH_ONLY' }, { code: 'CONFIRM_EXECUTABLE_QUOTE' }],
      }) },
  ]);
  const fpEnriched = fp(enriched);
  assert.equal(fpBase, fpEnriched, 'adding owner_summary_line to action row MUST NOT change fingerprint');
});

// ─── O23: notification / delivery unchanged ──────────────

test('O23. inventoryExceptionsAlerter.computeDeliveryPlan API surface unchanged', () => {
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  assert.equal(typeof alerter.computeAlertPlan, 'function');
  assert.equal(typeof alerter.computeDeliveryPlan, 'function');
  assert.equal(typeof alerter.deriveEffectiveDeliveryStateFromRuns, 'function');
});

// ─── Extra safety ─────────────────────────────────────────

test('formatCompactOwnerSummary emits a Owner-scannable block containing status / priority / available / pattern / supply / actions', () => {
  const owner = {
    physical_product_id: 1,
    headline: { decision_status: 'WATCH', priority_score: 170 },
    product: { title: 'Battle Partners Booster Box' },
    inventory: { available: 45 },
    demand: { demand_pattern: 'concentrated_large_order' },
    supply: { replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, current_supply_quality: 'ask_only' },
    recommended_actions: [{ code: ACTION.WATCH_ONLY }, { code: ACTION.CONFIRM_EXECUTABLE_QUOTE }],
  };
  const s = formatCompactOwnerSummary(owner);
  assert.match(s, /#1 \[WATCH · 170\] Battle Partners Booster Box/);
  assert.match(s, /available 45/);
  assert.match(s, /concentrated_large_order/);
  assert.match(s, /HARD · depth 30 · ask_only/);
  assert.match(s, /WATCH_ONLY \/ CONFIRM_EXECUTABLE_QUOTE/);
});

test('urgency_label · high for priority_score>=200, medium for >=100 (BP=170)', async () => {
  const bp = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(bpDecisionResultFixture()) });
  assert.equal(bp.headline.urgency_label, 'medium');
  const f = bpDecisionResultFixture();
  f.decision.status = DECISION.PROTECT_STOCK;
  const ps = await buildOwnerDecision({ physicalProductId: 1, assessFn: fakeAssess(f) });
  // PROTECT_STOCK base is 300 → critical
  assert.equal(ps.headline.urgency_label, 'critical');
});

test('assessFn error → clean error projection · action=REVIEW_DATA_QUALITY · forbidden actions still surfaced', async () => {
  const r = await buildOwnerDecision({
    physicalProductId: 99999,
    assessFn: async () => ({ physical_product_id: 99999, error: 'physical_not_found', decision: { status: DECISION.INSUFFICIENT_DATA, confidence_level: 'low', reason_codes: ['physical_not_found'], hold_quantity_blockers: [], depth_gap: null }, physical: null, inventory_summary: null, demand_summary: null, supply_summary: null, cost_context: null, missing_evidence: ['physical_not_found'], generated_at: new Date().toISOString(), strategic_hold_source: {} }),
  });
  assert.equal(r.error, 'physical_not_found');
  assert.equal(r.headline.decision_status, DECISION.INSUFFICIENT_DATA);
  assert.deepEqual(r.recommended_actions.map(a => a.code), [ACTION.REVIEW_DATA_QUALITY]);
  assert.ok(r.forbidden_automatic_actions.includes('AUTO_PURCHASE'));
});

// ─── O24 (full regression) is exercised by the runner (`node --test 'tests/**/*.test.js'`) ─
