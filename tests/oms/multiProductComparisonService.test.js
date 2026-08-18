'use strict';

/**
 * tests/oms/multiProductComparisonService.test.js — Phase 8N.
 *
 * Multi-product side-by-side view. Verifies:
 *   • Preserves caller's row order (no re-ranking)
 *   • Never invents ROI score / new priority
 *   • Financial metrics per row preserved via financialMetricsAssembler
 *     projection · categories independent
 *   • UNKNOWN never rendered as 0
 *   • Row shape is column-stable
 *
 * SAFETY: pure functions · no DB · no I/O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMultiProductComparison, DEFAULT_COLUMNS } = require('../../src/services/oms/multiProductComparisonService');
const { buildFinancialMetrics } = require('../../src/services/oms/financialMetricsAssembler');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function makeOwnerDecision(id, overrides = {}) {
  return {
    physical_product_id: id,
    generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 100, urgency_label: 'medium' },
    product: { title: `Product ${id}`, set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    demand: { trusted: true },
    supply: { verdict: 'AT_RISK', replacement_difficulty: 'HARD', has_current_supplier_or_executable: false, supplier_diversity: 0, current_supply_quality: 'ask_only' },
    cost_context: {
      historical_typical_supplier_cost_krw_median: 19500,
      historical_accounting_cost_krw: 45000,
      observed_secondary_market_ask_min_krw: 40000,
    },
    reasons: { reason_codes: [], hold_quantity_blockers: [], missing_evidence: [] },
    judgment_confidence: { overall_tier: 'LOW', by_dimension: { demand: { tier: 'MEDIUM' }, supply: { tier: 'LOW' }, cost: { tier: 'MEDIUM' }, identity: { tier: 'HIGH' } } },
    ...overrides,
  };
}

// ─── Structural invariants ────────────────────────────

test('MP1. Empty items → empty rows · caveats always present', () => {
  const r = buildMultiProductComparison([]);
  assert.deepEqual(r.rows, []);
  assert.ok(Array.isArray(r.caveats) && r.caveats.length > 0);
});

test('MP2. Each row includes ALL DEFAULT_COLUMNS-derived fields', () => {
  const od = makeOwnerDecision(1);
  const fm = buildFinancialMetrics(od, { expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const r = buildMultiProductComparison([{ ownerDecision: od, financialMetrics: fm }]);
  const row = r.rows[0];
  assert.equal(row.physical_product_id, 1);
  assert.equal(row.decision, DECISION.WATCH);
  assert.equal(row.priority, 100);
  assert.equal(row.confidence_overall_tier, 'LOW');
  assert.ok(row.financial.accounting);
  assert.ok(row.financial.replacement);
  assert.ok(row.financial.secondary_market_ask);
});

test('MP3. Row ORDER preserved from input · service never re-ranks', () => {
  const items = [
    { ownerDecision: makeOwnerDecision(3, { headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 50, urgency_label: 'low' } }) },
    { ownerDecision: makeOwnerDecision(1, { headline: { decision_status: DECISION.REPLENISH, confidence_level: 'high', priority_score: 300, urgency_label: 'critical' } }) },
    { ownerDecision: makeOwnerDecision(2, { headline: { decision_status: DECISION.PROTECT_STOCK, confidence_level: 'medium', priority_score: 200, urgency_label: 'high' } }) },
  ];
  const r = buildMultiProductComparison(items);
  //   Row order must match input order · higher-priority row 2 stays second
  assert.deepEqual(r.rows.map(row => row.physical_product_id), [3, 1, 2]);
});

test('MP4. Rows with missing financialMetrics still project · all metrics UNKNOWN', () => {
  const od = makeOwnerDecision(1);
  const r = buildMultiProductComparison([{ ownerDecision: od /* no fm */ }]);
  const row = r.rows[0];
  assert.equal(row.financial.accounting.gross_profit.status, 'UNKNOWN');
  assert.equal(row.financial.replacement.gross_profit.status, 'UNKNOWN');
  assert.equal(row.financial.secondary_market_ask.gross_profit.status, 'UNKNOWN');
  //   Non-financial columns still populated
  assert.equal(row.decision, DECISION.WATCH);
});

test('MP5. Category independence surfaces in output · accounting != replacement != secondary rows have different values', () => {
  const od = makeOwnerDecision(1);
  const fm = buildFinancialMetrics(od, { expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const r = buildMultiProductComparison([{ ownerDecision: od, financialMetrics: fm }]);
  const row = r.rows[0];
  //   Accounting profit 29000 · replacement 54500 · secondary 34000
  assert.equal(row.financial.accounting.gross_profit.amount_krw, 29000);
  assert.equal(row.financial.replacement.gross_profit.amount_krw, 54500);
  assert.equal(row.financial.secondary_market_ask.gross_profit.amount_krw, 34000);
});

test('MP6. Cost_context surfaces the 3 canonical numbers verbatim', () => {
  const od = makeOwnerDecision(1);
  const r = buildMultiProductComparison([{ ownerDecision: od }]);
  const cc = r.rows[0].cost_context;
  assert.equal(cc.historical_accounting_cost_krw, 45000);
  assert.equal(cc.historical_typical_supplier_cost_krw_median, 19500);
  assert.equal(cc.observed_secondary_market_ask_min_krw, 40000);
});

test('MP7. UNKNOWN NEVER rendered as 0 · amount_krw stays null when status UNKNOWN', () => {
  const od = makeOwnerDecision(1);
  const fm = buildFinancialMetrics(od, {});   // no sale price → UNKNOWN
  const r = buildMultiProductComparison([{ ownerDecision: od, financialMetrics: fm }]);
  const row = r.rows[0];
  for (const scenario of ['accounting', 'replacement', 'secondary_market_ask']) {
    assert.equal(row.financial[scenario].gross_profit.status, 'UNKNOWN');
    assert.equal(row.financial[scenario].gross_profit.amount_krw, null, `${scenario} gross_profit must stay null · not 0`);
  }
});

test('MP8. data_quality_flag is true for INSUFFICIENT_DATA decisions · false for others', () => {
  const dq = makeOwnerDecision(1, { headline: { decision_status: 'INSUFFICIENT_DATA', confidence_level: 'low', priority_score: 0, urgency_label: 'data_quality' } });
  const ok = makeOwnerDecision(2);
  const r = buildMultiProductComparison([{ ownerDecision: dq }, { ownerDecision: ok }]);
  assert.equal(r.rows[0].data_quality_flag, true);
  assert.equal(r.rows[1].data_quality_flag, false);
});

test('MP9. Column list is stable · default includes primary + financial + cost_context columns', () => {
  const r = buildMultiProductComparison([]);
  assert.ok(r.columns.includes('priority'));
  assert.ok(r.columns.includes('financial.accounting.gross_profit'));
  assert.ok(r.columns.includes('financial.secondary_market_ask.gross_margin_pct'));
  assert.ok(r.columns.includes('cost_context.historical_accounting_cost_krw'));
});

test('MP10. Custom columns opt-in via opts.columns · service still projects full row', () => {
  const custom = ['physical_product_id', 'title', 'decision'];
  const r = buildMultiProductComparison([{ ownerDecision: makeOwnerDecision(1) }], { columns: custom });
  assert.deepEqual(r.columns, custom);
  //   Row still has all fields available (columns hint is UI-level)
  assert.equal(r.rows[0].physical_product_id, 1);
});

test('MP11. Never mutates input ownerDecision objects', () => {
  const items = [{ ownerDecision: makeOwnerDecision(1) }, { ownerDecision: makeOwnerDecision(2) }];
  const before = JSON.stringify(items);
  buildMultiProductComparison(items);
  assert.equal(JSON.stringify(items), before);
});

test('MP12. Rejects nullish ownerDecision entries silently (skip · not crash)', () => {
  const items = [null, { ownerDecision: null }, { ownerDecision: makeOwnerDecision(1) }, undefined];
  const r = buildMultiProductComparison(items);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].physical_product_id, 1);
});
