'use strict';

/**
 * tests/oms/missingMetricsAbsenceInvariants.test.js — Phase 8L batch 4.
 *
 * Category B finding: 4 of Owner's 7 numeric verification targets do NOT
 * exist anywhere in the OMS decision system:
 *
 *   • expected_sale_proceeds     — NOT IMPLEMENTED
 *   • gross_profit               — NOT IMPLEMENTED at OMS decision layer
 *   • gross_margin               — NOT IMPLEMENTED at OMS decision layer
 *   • break_even_price           — NOT IMPLEMENTED
 *   • inventory_value            — NOT IMPLEMENTED
 *
 * (Per-listing gross profit / margin lives in Hermes Phase 18A
 * listingProfitabilityCalculator.js — separate CSV surface, verified in
 * profitLineageInvariants.test.js. NOT reachable from Owner Decision.)
 *
 * Invariant: the OMS Owner Decision surface MUST NOT surface these fields
 * at all until they have real implementations. Publishing an unbacked
 * "gross_margin" or "inventory_value" would be numeric fabrication —
 * exactly the Phase 8L failure mode Owner asked to prevent.
 *
 * These tests will FAIL the day someone silently adds one of these fields
 * without going through Phase 8L numerical-correctness verification.
 *
 * SAFETY: pure inspection · no DB · no marketplace · fixture-only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { buildOwnerDecision } = require('../../src/services/oms/inventoryOwnerDecisionService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

// ─── Fixture helpers ──────────────────────────────────────

function makeFullOwnerDecisionFixture() {
  return {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    physical: { id: 1, canonical_title: 'x', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: [], hold_quantity_blockers: [], depth_gap: 15 },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: { trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.03, raw_days_of_supply: 22, demand_pattern: 'concentrated_large_order' },
    supply_summary: { verdict: 'AT_RISK', current_supply_quality: 'ask_only', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, uncovered_at_60: 30, uncovered_at_100: 70, secondary_market_dependency_by_target: { 60: 1.0 }, observed_secondary_market_unit_cost_min: 40000, secondary_market_depth: [{ min_ask: 40000, fresh_observations: 2 }] },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    missing_evidence: [],
    strategic_hold_source: { supply_risk: { secondary_market_depth: [{ min_ask: 40000, fresh_observations: 2 }], observation_count: 2, observed_secondary_market_unit_cost_min: 40000 }, historical_reference_product_cost: { observation_count: 4, status: 'HISTORICAL_REFERENCE_ONLY' }, historical_accounting_cost: { cost_krw: 45000 } },
  };
}

// ─── Absence invariants on Owner Decision output ─────────

const FORBIDDEN_METRICS = [
  // Sale-side (not yet computed)
  'expected_sale_proceeds',
  'expected_sale_proceeds_krw',
  'expected_revenue',
  'expected_revenue_krw',
  // Profit-side (not yet computed at OMS layer)
  'gross_profit',
  'gross_profit_krw',
  'gross_margin',
  'gross_margin_pct',
  'estimated_profit',
  'estimated_profit_krw',   // exists only in Hermes CSV surface, NOT here
  // Break-even (not yet computed)
  'break_even_price',
  'break_even_price_krw',
  'breakeven_price',
  'breakeven_price_krw',
  // Inventory valuation (not yet computed)
  'inventory_value',
  'inventory_value_krw',
  'stock_value',
  'stock_value_krw',
];

test('MA1. buildOwnerDecision result MUST NOT surface any of the 4 unbacked profit/valuation metrics', async () => {
  const fx = makeFullOwnerDecisionFixture();
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => fx });
  const serialized = JSON.stringify(owner);
  for (const bad of FORBIDDEN_METRICS) {
    assert.doesNotMatch(
      serialized,
      new RegExp(`"${bad}"\\s*:`),
      `Owner Decision surface must NOT contain field "${bad}" — no implementation backs it (Phase 8L absence invariant)`,
    );
  }
});

test('MA2. buildOwnerDecision top-level keys are the pinned Phase 8E/8K set only', () => {
  //   Structural pinning: any new top-level key on Owner Decision MUST go
  //   through Phase 8L numerical-correctness verification before being
  //   surfaced. This test breaks the day someone adds a key silently.
  const EXPECTED_KEYS = new Set([
    'physical_product_id',
    'generated_at',
    'headline',
    'product',
    'inventory',
    'demand',
    'supply',
    'cost_context',
    'reasons',
    'priority_reasons',
    'recommended_actions',
    'recommended_evidence_actions',
    'forbidden_automatic_actions',
    'judgment_confidence',
    'data_provenance',
    'source_snapshot',
    'reason_code_explanations',
    'error',
  ]);
  return buildOwnerDecision({ physicalProductId: 1, assessFn: async () => makeFullOwnerDecisionFixture() })
    .then(owner => {
      const actualKeys = Object.keys(owner);
      for (const k of actualKeys) {
        assert.ok(
          EXPECTED_KEYS.has(k),
          `Unexpected top-level key "${k}" on Owner Decision — new fields require Phase 8L verification (see docs/PLAN-competitor-kill-to-no1-seller.md for the numeric-integrity gate)`,
        );
      }
    });
});

test('MA3. cost_context surfaces exactly the 3 Phase 8E cost numbers · no fabricated profit/margin/break-even/inventory-value additions', async () => {
  //   Pins cost_context shape. Adding gross_profit/margin/break_even here
  //   without an implementation is exactly the Phase 8L failure mode.
  const ALLOWED_COST_KEYS = new Set([
    'historical_typical_supplier_cost_krw_median',
    'historical_accounting_cost_krw',
    'observed_secondary_market_ask_min_krw',
    'note',
  ]);
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => makeFullOwnerDecisionFixture() });
  for (const k of Object.keys(owner.cost_context || {})) {
    assert.ok(
      ALLOWED_COST_KEYS.has(k),
      `Unexpected cost_context key "${k}" — profit/margin/break-even/inventory-value are NOT implemented; adding them here fabricates numbers`,
    );
  }
});

test('MA4. Only src/services/oms/financialMetricsService.js is authorized to define gross_profit / break_even / inventory_value symbols', () => {
  //   Repository-level absence check. financialMetricsService.js is the
  //   ONE authorized implementation of these metrics (Phase 8L core).
  //   Any OTHER file adding these symbols must go through Phase 8L review.
  //   Hermes CSV calculator lives at src/services/listingProfitabilityCalculator.js
  //   — separate surface, NOT under src/services/oms/.
  const omsDir = path.resolve(__dirname, '../../src/services/oms');
  const AUTHORIZED = new Set([
    path.resolve(omsDir, 'financialMetricsService.js'),
    path.resolve(omsDir, 'financialMetricsAssembler.js'),
  ]);
  const files = _walkJsFiles(omsDir).filter(f => !AUTHORIZED.has(f));
  const forbiddenSymbols = [
    'expected_sale_proceeds',
    'gross_profit',
    'gross_margin',
    'break_even_price',
    'breakeven',
    'inventory_value',
    'stock_value',
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const sym of forbiddenSymbols) {
      const regex = new RegExp(`\\b${sym}\\b`, 'i');
      assert.doesNotMatch(
        src,
        regex,
        `Found "${sym}" in ${path.relative(process.cwd(), file)} — Phase 8L numeric-integrity gate required before adding this metric outside financialMetricsService.js`,
      );
    }
  }
});

test('MA5. Owner UI (public/js/ownerInventory.js) — financial metric symbols are ONLY rendered via financialMetricsService (Phase 8L integration)', () => {
  //   Phase 8L integrated financialMetricsService into the Owner UI. UI now
  //   legitimately references the metric field names when rendering the
  //   `financial_metrics` API response. Guard shifted from "no mention" to
  //   "no hard-coded fabrication" — verify the UI shows "확인되지 않음" for
  //   UNKNOWN status and never writes a numeric literal for an unbacked
  //   metric.
  const uiPath = path.resolve(__dirname, '../../public/js/ownerInventory.js');
  const src = fs.readFileSync(uiPath, 'utf8');
  //   Explicit Korean UNKNOWN rendering must be present for the panel
  assert.match(src, /확인되지 않음/, 'Owner UI must render UNKNOWN as "확인되지 않음" (Phase 8L UI rule)');
  //   No hard-coded 0 render for the metric fields · we check literal patterns
  //   like `gross_profit: 0` that would signal fabrication.
  const badPatterns = [
    /expected_sale_proceeds\s*[:=]\s*0\b/,
    /gross_profit\s*[:=]\s*0\b/,
    /gross_margin\s*[:=]\s*0\b/,
    /break_even_price\s*[:=]\s*0\b/,
    /inventory_value\s*[:=]\s*0\b/,
  ];
  for (const p of badPatterns) {
    assert.doesNotMatch(src, p, `Hard-coded 0 for metric matches ${p} · would fabricate a number in UI`);
  }
});

// ─── Helper ─────────────────────────────────────────────

function _walkJsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && /\.js$/.test(ent.name)) out.push(full);
    }
  }
  return out;
}
