'use strict';

/**
 * tests/oms/judgmentHistorySnapshotService.test.js — Phase 8M.
 *
 * Verifies pure snapshot + diff builder.
 *
 * SAFETY: pure functions · no DB · no I/O · no external calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildJudgmentHistorySnapshot,
  diffJudgmentHistorySnapshots,
  CHANGE_KIND,
} = require('../../src/services/oms/judgmentHistorySnapshotService');
const { buildFinancialMetrics } = require('../../src/services/oms/financialMetricsAssembler');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function makeOwnerDecision(overrides = {}) {
  return {
    physical_product_id: 1,
    generated_at: '2026-08-18T00:00:00Z',
    headline: {
      decision_status: DECISION.WATCH, confidence_level: 'low',
      priority_score: 170, urgency_label: 'medium', one_line_summary: 'x',
    },
    product: { title: 'BP', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    demand: { trusted: true },
    supply: { verdict: 'AT_RISK' },
    cost_context: {
      historical_typical_supplier_cost_krw_median: 19500,
      historical_accounting_cost_krw: 45000,
      observed_secondary_market_ask_min_krw: 40000,
    },
    reasons: { reason_codes: ['current_supply_ask_only'], hold_quantity_blockers: [], missing_evidence: [] },
    judgment_confidence: {
      overall_tier: 'LOW',
      by_dimension: {
        demand:   { tier: 'MEDIUM' },
        supply:   { tier: 'LOW' },
        cost:     { tier: 'MEDIUM' },
        identity: { tier: 'HIGH' },
      },
    },
    data_provenance: {
      inventory: { source: 'inventory_movements_ledger' },
      demand: { source: 'oms_order_items' },
      supply: { source: 'physical_market_observations' },
      cost_context: {
        historical_typical_supplier_cost_krw_median: { source: 'physical_market_observations' },
        historical_accounting_cost_krw: { source: 'internal_accounting' },
        observed_secondary_market_ask_min_krw: { source: 'physical_market_observations' },
      },
    },
    ...overrides,
  };
}

// ─── Snapshot builder ─────────────────────────────────

test('HS1. Snapshot requires caller-supplied snapshotAt · never derived internally', () => {
  const od = makeOwnerDecision();
  assert.throws(() => buildJudgmentHistorySnapshot(od), /snapshotAt required/);
});

test('HS2. Snapshot captures decision / priority / urgency / confidence tiers verbatim', () => {
  const od = makeOwnerDecision();
  const snap = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  assert.equal(snap.snapshot_at, '2026-08-18T09:00:00Z');
  assert.equal(snap.decision, DECISION.WATCH);
  assert.equal(snap.priority, 170);
  assert.equal(snap.urgency, 'medium');
  assert.equal(snap.confidence.overall_tier, 'LOW');
  assert.equal(snap.confidence.demand_tier, 'MEDIUM');
  assert.equal(snap.confidence.supply_tier, 'LOW');
  assert.equal(snap.confidence.cost_tier, 'MEDIUM');
  assert.equal(snap.confidence.identity_tier, 'HIGH');
});

test('HS3. Snapshot preserves reason_codes / blockers / missing_evidence as ARRAY COPIES (not references)', () => {
  const od = makeOwnerDecision();
  const snap = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  assert.deepEqual(snap.key_reasons.reason_codes, ['current_supply_ask_only']);
  // Mutate the original — snapshot must be immune
  od.reasons.reason_codes.push('MUTATED');
  assert.deepEqual(snap.key_reasons.reason_codes, ['current_supply_ask_only']);
});

test('HS4. Snapshot cost_context surfaces exactly the 3 canonical numbers · null-safe', () => {
  const od = makeOwnerDecision();
  const snap = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  assert.deepEqual(snap.cost_context_snapshot, {
    historical_typical_supplier_cost_krw_median: 19500,
    historical_accounting_cost_krw: 45000,
    observed_secondary_market_ask_min_krw: 40000,
  });
});

test('HS5. Snapshot financial_metrics_summary aggregates all 3 scenarios × 5 metrics (status + amount only)', () => {
  const od = makeOwnerDecision();
  const fm = buildFinancialMetrics(od, {
    expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000,
  });
  const snap = buildJudgmentHistorySnapshot(od, fm, { snapshotAt: '2026-08-18T09:00:00Z' });
  const acc = snap.financial_metrics_summary.accounting;
  assert.equal(acc.cost_basis_source, 'sku_master_cost_krw');
  assert.equal(acc.cost_basis_krw, 45000);
  assert.equal(acc.gross_profit.status, 'AVAILABLE');
  assert.equal(acc.gross_profit.amount_krw, 29000);
  assert.equal(acc.gross_margin.status, 'AVAILABLE');
  assert.ok(acc.gross_margin.pct > 0);
});

test('HS6. Snapshot provenance_summary lists unique sources seen · no duplicates', () => {
  const od = makeOwnerDecision();
  const snap = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const src = snap.provenance_summary.sources_seen.sort();
  assert.deepEqual(src, ['internal_accounting', 'inventory_movements_ledger', 'oms_order_items', 'physical_market_observations']);
});

test('HS7. Snapshot never mutates the ownerDecision input', () => {
  const od = makeOwnerDecision();
  const before = JSON.stringify(od);
  buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  assert.equal(JSON.stringify(od), before);
});

// ─── Diff ─────────────────────────────────────────────

test('HD1. Identical snapshots → unchanged=true · delta=[]', () => {
  const od = makeOwnerDecision();
  const t0 = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const t1 = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T10:00:00Z' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  assert.equal(d.unchanged, true);
  assert.deepEqual(d.delta, []);
});

test('HD2. Decision change · one delta record with from/to', () => {
  const od1 = makeOwnerDecision();
  const od2 = makeOwnerDecision({ headline: { ...makeOwnerDecision().headline, decision_status: DECISION.REPLENISH } });
  const t0 = buildJudgmentHistorySnapshot(od1, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const t1 = buildJudgmentHistorySnapshot(od2, null, { snapshotAt: '2026-08-18T10:00:00Z' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  assert.equal(d.unchanged, false);
  assert.ok(d.delta.find(x => x.kind === CHANGE_KIND.DECISION_CHANGED && x.from === DECISION.WATCH && x.to === DECISION.REPLENISH));
});

test('HD3. Reason codes added and removed both surface in one delta entry', () => {
  const od1 = makeOwnerDecision();
  const od2 = makeOwnerDecision({
    reasons: { reason_codes: ['current_supply_executable_confirmed'], hold_quantity_blockers: [], missing_evidence: [] },
  });
  const t0 = buildJudgmentHistorySnapshot(od1, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const t1 = buildJudgmentHistorySnapshot(od2, null, { snapshotAt: '2026-08-18T10:00:00Z' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  const change = d.delta.find(x => x.kind === CHANGE_KIND.REASON_CODES_CHANGED);
  assert.ok(change);
  assert.deepEqual(change.added, ['current_supply_executable_confirmed']);
  assert.deepEqual(change.removed, ['current_supply_ask_only']);
});

test('HD4. Cost context single-field change · delta names the field with from/to', () => {
  const od1 = makeOwnerDecision();
  const od2 = makeOwnerDecision({
    cost_context: { ...makeOwnerDecision().cost_context, historical_typical_supplier_cost_krw_median: 22000 },
  });
  const t0 = buildJudgmentHistorySnapshot(od1, null, { snapshotAt: 'a' });
  const t1 = buildJudgmentHistorySnapshot(od2, null, { snapshotAt: 'b' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  const c = d.delta.find(x => x.kind === CHANGE_KIND.COST_CONTEXT_CHANGED);
  assert.equal(c.field, 'historical_typical_supplier_cost_krw_median');
  assert.equal(c.from, 19500);
  assert.equal(c.to, 22000);
});

test('HD5. Financial metric status flip (UNKNOWN → AVAILABLE) surfaces as FINANCIAL_METRIC_STATUS_FLIP', () => {
  const od = makeOwnerDecision();
  const fmBefore = buildFinancialMetrics(od, {});  // no price → UNKNOWN
  const fmAfter  = buildFinancialMetrics(od, { expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const t0 = buildJudgmentHistorySnapshot(od, fmBefore, { snapshotAt: 'a' });
  const t1 = buildJudgmentHistorySnapshot(od, fmAfter,  { snapshotAt: 'b' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  const flips = d.delta.filter(x => x.kind === CHANGE_KIND.FINANCIAL_METRIC_STATUS_FLIP);
  assert.ok(flips.length >= 3, `at least 3 status flips expected · got ${flips.length}`);
  const accountingProfit = flips.find(f => f.scenario === 'accounting' && f.metric === 'gross_profit');
  assert.equal(accountingProfit.from, 'UNKNOWN');
  assert.equal(accountingProfit.to, 'AVAILABLE');
});

test('HD6. Financial metric amount change (AVAILABLE → AVAILABLE, different value) surfaces as FINANCIAL_METRIC_AMOUNT_CHANGED', () => {
  const od1 = makeOwnerDecision();
  const od2 = makeOwnerDecision({
    cost_context: { ...makeOwnerDecision().cost_context, historical_accounting_cost_krw: 50000 },
  });
  const fm1 = buildFinancialMetrics(od1, { expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const fm2 = buildFinancialMetrics(od2, { expected_sale_price_krw: 100000, seller_borne_shipping_krw: 8000 });
  const t0 = buildJudgmentHistorySnapshot(od1, fm1, { snapshotAt: 'a' });
  const t1 = buildJudgmentHistorySnapshot(od2, fm2, { snapshotAt: 'b' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  const changes = d.delta.filter(x => x.kind === CHANGE_KIND.FINANCIAL_METRIC_AMOUNT_CHANGED);
  const accountingProfit = changes.find(c => c.scenario === 'accounting' && c.metric === 'gross_profit');
  assert.equal(accountingProfit.from, 29000);   // 74000 - 45000
  assert.equal(accountingProfit.to, 24000);     // 74000 - 50000
});

test('HD7. Confidence tier change per dimension surfaces separately', () => {
  const od1 = makeOwnerDecision();
  const od2 = makeOwnerDecision({
    judgment_confidence: {
      overall_tier: 'MEDIUM',
      by_dimension: {
        demand: { tier: 'HIGH' }, supply: { tier: 'MEDIUM' }, cost: { tier: 'MEDIUM' }, identity: { tier: 'HIGH' },
      },
    },
  });
  const t0 = buildJudgmentHistorySnapshot(od1, null, { snapshotAt: 'a' });
  const t1 = buildJudgmentHistorySnapshot(od2, null, { snapshotAt: 'b' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  const tierChanges = d.delta.filter(x => x.kind === CHANGE_KIND.CONFIDENCE_TIER_CHANGED);
  //   overall + demand + supply changed · cost + identity unchanged
  assert.equal(tierChanges.length, 3);
  assert.ok(tierChanges.find(t => t.dimension === 'overall_tier' && t.from === 'LOW' && t.to === 'MEDIUM'));
  assert.ok(tierChanges.find(t => t.dimension === 'demand_tier' && t.from === 'MEDIUM' && t.to === 'HIGH'));
  assert.ok(tierChanges.find(t => t.dimension === 'supply_tier' && t.from === 'LOW' && t.to === 'MEDIUM'));
});

test('HD8. Diff preserves before_snapshot_at + after_snapshot_at for chronology', () => {
  const od = makeOwnerDecision();
  const t0 = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const t1 = buildJudgmentHistorySnapshot(od, null, { snapshotAt: '2026-08-19T09:00:00Z' });
  const d = diffJudgmentHistorySnapshots(t0, t1);
  assert.equal(d.before_snapshot_at, '2026-08-18T09:00:00Z');
  assert.equal(d.after_snapshot_at, '2026-08-19T09:00:00Z');
});

test('HD9. Diff requires both snapshots · throws otherwise', () => {
  assert.throws(() => diffJudgmentHistorySnapshots(null, {}), /both snapshots required/);
  assert.throws(() => diffJudgmentHistorySnapshots({}, null), /both snapshots required/);
});

test('HD10. Diff never mutates input snapshots', () => {
  const od = makeOwnerDecision();
  const t0 = buildJudgmentHistorySnapshot(od, null, { snapshotAt: 'a' });
  const t1 = buildJudgmentHistorySnapshot(od, null, { snapshotAt: 'b' });
  const before = JSON.stringify([t0, t1]);
  diffJudgmentHistorySnapshots(t0, t1);
  assert.equal(JSON.stringify([t0, t1]), before);
});
