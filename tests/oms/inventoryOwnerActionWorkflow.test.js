'use strict';

/**
 * tests/oms/inventoryOwnerActionWorkflow.test.js — Phase 8F.
 *
 * Owner Action Workflow — evidence-closure semantics.
 *
 * Absolute rules under test:
 *   · SECONDARY_MARKET_ASK ≠ EXECUTABLE_QUOTE
 *   · TYPICAL_SUPPLIER_REFERENCE ≠ current SUPPLIER_QUOTE
 *   · historical accounting cost ≠ current supplier quote
 *   · Evidence readiness NEVER executes purchase / hold / marketplace mutation
 *   · UNKNOWN stays UNKNOWN
 *   · BP remains WATCH · priority 170
 *   · Phase 8E raw projection values unchanged after CLI hotfix
 *   · CLI rejects --apply / --execute / --purchase / --hold
 *   · Phase 8C/8D delivery/fingerprint API surface unchanged
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildOwnerDecision, ACTION } = require('../../src/services/oms/inventoryOwnerDecisionService');
const { buildOwnerActionWorkflow, WORKFLOW_STATUS } = require('../../src/services/oms/inventoryOwnerActionWorkflowService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');
const { EVIDENCE_TYPES } = require('../../src/services/oms/replacementEvidenceTypes');

// ─── Production-shaped BP fixture (same as Phase 8E) ─────

function bpDecisionResultFixture(overrides = {}) {
  const base = {
    physical_product_id: 1,
    generated_at: '2026-08-16T00:00:00.000Z',
    physical: {
      id: 1, canonical_title: 'Battle Partners Booster Box',
      set_code: 'sv9', set_name: 'Battle Partners', language: 'ko', region: null, unit_type: 'booster_box',
    },
    decision: {
      status: DECISION.WATCH, confidence_level: 'low',
      reason_codes: ['hold_status:review_demand_and_supply_risk', 'demand_concentrated_large_order', 'current_supply_ask_only', 'replacement_difficulty_hard', 'no_current_primary_supplier_quote'],
      hold_quantity_blockers: [], strategic_hold_recommended_units: null,
      upstream_hold_status: 'REVIEW_DEMAND_AND_SUPPLY_RISK', upstream_supply_verdict: 'AT_RISK', depth_gap: 15,
    },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45, invariant: 'available = on_hand(60) - reserved(15) = 45' },
    demand_summary: {
      trusted: true, units_7d: 60, units_30d: 61, velocity_7d: 8.57, velocity_30d: 2.033333333333333,
      raw_days_of_supply: 22.13, adjusted_velocity: null,
      demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984,
      total_shipments_30d: 3, trust_reason: 'multi_channel_evidence',
    },
    supply_summary: {
      verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only', supplier_diversity: 0,
      has_current_supplier_or_executable: false, replacement_difficulty: 'HARD',
      replacement_difficulty_reason_codes: ['ask_only_supply', 'no_current_supplier_quote'],
      evidenced_replacement_depth: 30, largest_currently_coverable_target: 30,
      uncovered_at_60: 30, uncovered_at_100: 70,
      secondary_market_dependency_by_target: { 10: 1.0, 30: 1.0, 60: 1.0, 100: 1.0 },
      replacement_coverage: { 10: 1.0, 30: 1.0, 60: 0.5, 100: 0.3 },
      observed_secondary_market_unit_cost_min: 40000, secondary_market_depth: 30,
    },
    cost_context: {
      historical_typical_supplier_cost_krw_median: 19500,
      historical_accounting_cost_krw: 45000,
      observed_secondary_market_ask_min_krw: 40000,
      note: 'categories separated',
    },
    missing_evidence: [], recommended_human_action: 'stub', strategic_hold_source: {},
  };
  return Object.assign(base, overrides);
}
function fakeAssess(fixture) {
  return async (id) => (id === fixture.physical_product_id ? fixture : { error: 'physical_not_found' });
}

async function ownerDecisionFor(fixture) {
  return buildOwnerDecision({ physicalProductId: fixture.physical_product_id, assessFn: fakeAssess(fixture) });
}

// ─── F1-F5: BP + evidence closure semantics ─────────────

test('F1. BP workflow produces WATCH_ONLY + CONFIRM_EXECUTABLE_QUOTE + CHECK_PRIMARY_SUPPLIER', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const wf = buildOwnerActionWorkflow(ownerDecision);
  const codes = wf.workflow_actions.map(a => a.action_code);
  assert.deepEqual(codes, [ACTION.WATCH_ONLY, ACTION.CONFIRM_EXECUTABLE_QUOTE, ACTION.CHECK_PRIMARY_SUPPLIER]);
});

test('F2. ask_only supply does NOT close CONFIRM_EXECUTABLE_QUOTE', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const wf = buildOwnerActionWorkflow(ownerDecision);
  const confirm = wf.workflow_actions.find(a => a.action_code === ACTION.CONFIRM_EXECUTABLE_QUOTE);
  assert.equal(confirm.status, WORKFLOW_STATUS.OPEN, 'ask_only must NOT close CONFIRM_EXECUTABLE_QUOTE');
  assert.ok(confirm.not_accepted_as_closure.includes(EVIDENCE_TYPES.SECONDARY_MARKET_ASK));
  assert.ok(confirm.missing_evidence.includes(EVIDENCE_TYPES.EXECUTABLE_QUOTE));
  assert.deepEqual(confirm.current_evidence, [EVIDENCE_TYPES.SECONDARY_MARKET_ASK], 'ask_only recorded as observed evidence but does NOT satisfy');
});

test('F3. current EXECUTABLE_QUOTE makes CONFIRM_EXECUTABLE_QUOTE EVIDENCE_READY', async () => {
  const f = bpDecisionResultFixture();
  f.supply_summary.current_supply_quality = 'executable';
  f.supply_summary.has_current_supplier_or_executable = true;
  const ownerDecision = await ownerDecisionFor(f);
  // Manually inject the EXECUTABLE_QUOTE-corresponding recommended action list
  // — real orchestration removes CONFIRM_EXECUTABLE_QUOTE recommendation when
  //   quality=executable, so we exercise the workflow projection directly by
  //   simulating the recommendation still present (post-arrival-of-evidence
  //   review moment).
  const wfInput = {
    ...ownerDecision,
    recommended_actions: [
      { code: ACTION.WATCH_ONLY, label: 'Watch only', description: 'x', risk_level: 'none', requires_owner_approval: true, executable_by_system: false },
      { code: ACTION.CONFIRM_EXECUTABLE_QUOTE, label: 'Confirm executable quote', description: 'x', risk_level: 'low', requires_owner_approval: true, executable_by_system: false },
    ],
  };
  const wf = buildOwnerActionWorkflow(wfInput);
  const confirm = wf.workflow_actions.find(a => a.action_code === ACTION.CONFIRM_EXECUTABLE_QUOTE);
  assert.equal(confirm.status, WORKFLOW_STATUS.EVIDENCE_READY);
  assert.deepEqual(confirm.missing_evidence, []);
  assert.ok(confirm.current_evidence.includes(EVIDENCE_TYPES.EXECUTABLE_QUOTE));
  // Re-evaluation hint fires
  assert.match(wf.reevaluation_hint, /re_run_assessInventoryDecision/);
});

test('F4. historical typical supplier cost does NOT satisfy current supplier quote', async () => {
  // BP already has historical_typical=19500 and has_current_supplier_or_executable=false.
  // Verify that the workflow's not_accepted_as_closure list explicitly names
  // both TYPICAL_SUPPLIER_REFERENCE and historical_accounting_cost.
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const wf = buildOwnerActionWorkflow(ownerDecision);
  const check = wf.workflow_actions.find(a => a.action_code === ACTION.CHECK_PRIMARY_SUPPLIER);
  assert.equal(check.status, WORKFLOW_STATUS.OPEN);
  assert.ok(check.not_accepted_as_closure.includes(EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE));
  assert.ok(check.not_accepted_as_closure.includes('historical_accounting_cost'));
  assert.ok(check.not_accepted_as_closure.includes(EVIDENCE_TYPES.SECONDARY_MARKET_ASK));
  assert.ok(check.not_accepted_as_closure.includes(EVIDENCE_TYPES.ACTUAL_PURCHASE));
  assert.ok(check.missing_evidence.includes(EVIDENCE_TYPES.SUPPLIER_QUOTE));
  assert.ok(check.missing_evidence.includes(EVIDENCE_TYPES.EXECUTABLE_QUOTE));
});

test('F5. current SUPPLIER_QUOTE makes CHECK_PRIMARY_SUPPLIER EVIDENCE_READY', async () => {
  const f = bpDecisionResultFixture();
  f.supply_summary.current_supply_quality = 'supplier_quote';
  f.supply_summary.has_current_supplier_or_executable = true;
  const ownerDecision = await ownerDecisionFor(f);
  const wfInput = {
    ...ownerDecision,
    recommended_actions: [
      { code: ACTION.WATCH_ONLY, label: 'Watch only', description: 'x', risk_level: 'none', requires_owner_approval: true, executable_by_system: false },
      { code: ACTION.CHECK_PRIMARY_SUPPLIER, label: 'Check primary supplier', description: 'x', risk_level: 'low', requires_owner_approval: true, executable_by_system: false },
    ],
  };
  const wf = buildOwnerActionWorkflow(wfInput);
  const check = wf.workflow_actions.find(a => a.action_code === ACTION.CHECK_PRIMARY_SUPPLIER);
  assert.equal(check.status, WORKFLOW_STATUS.EVIDENCE_READY);
  assert.deepEqual(check.missing_evidence, []);
  assert.ok(check.current_evidence.includes(EVIDENCE_TYPES.SUPPLIER_QUOTE));
});

// ─── F6-F8: no side effects on evidence arrival ─────────

test('F6. evidence readiness never executes purchase (workflow marks executable_by_system=false, requires_owner_approval=true)', async () => {
  const f = bpDecisionResultFixture();
  f.supply_summary.current_supply_quality = 'executable';
  f.supply_summary.has_current_supplier_or_executable = true;
  const ownerDecision = await ownerDecisionFor(f);
  const wf = buildOwnerActionWorkflow(ownerDecision);
  for (const a of wf.workflow_actions) {
    assert.equal(a.executable_by_system, false, `${a.action_code} MUST NOT be executable by system`);
    assert.equal(a.requires_owner_approval, true);
  }
  assert.ok(wf.forbidden_automatic_actions.includes('AUTO_PURCHASE'));
});

test('F7. workflow service source has no marketplace / telegram / imessage / notify / DB write API references', () => {
  const svcPath = path.resolve(__dirname, '../../src/services/oms/inventoryOwnerActionWorkflowService.js');
  const src = fs.readFileSync(svcPath, 'utf8');
  assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(/);
  assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*marketplace[^'"]*['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]/i);
  assert.doesNotMatch(src, /\bfrom\(['"]/);
  assert.doesNotMatch(src, /\.insert\(|\.upsert\(|\.delete\(/);
  assert.doesNotMatch(src, /getClient\(/);
});

test('F8. workflow projection does not mutate its input ownerDecision', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const before = JSON.parse(JSON.stringify(ownerDecision));
  buildOwnerActionWorkflow(ownerDecision);
  assert.deepEqual(ownerDecision, before);
});

// ─── F9-F10: UNKNOWN / raw value preservation ────────────

test('F9. UNKNOWN stays UNKNOWN through workflow projection', async () => {
  const f = bpDecisionResultFixture();
  f.supply_summary.replacement_difficulty = 'UNKNOWN';
  f.supply_summary.current_supply_quality = 'none';
  f.supply_summary.has_current_supplier_or_executable = false;
  const ownerDecision = await ownerDecisionFor(f);
  const wf = buildOwnerActionWorkflow(ownerDecision);
  assert.equal(ownerDecision.supply.replacement_difficulty, 'UNKNOWN');
  assert.equal(ownerDecision.supply.current_supply_quality, 'none');
  // Workflow must not fabricate readiness for either action
  for (const a of wf.workflow_actions) {
    if (a.action_code === ACTION.CONFIRM_EXECUTABLE_QUOTE || a.action_code === ACTION.CHECK_PRIMARY_SUPPLIER) {
      assert.equal(a.status, WORKFLOW_STATUS.OPEN);
    }
  }
});

test('F10. raw Phase 8E projection numeric values remain unchanged (velocity_30d, raw_days_of_supply not rounded)', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  assert.equal(ownerDecision.demand.velocity_30d, 2.033333333333333, 'velocity_30d must remain raw');
  assert.equal(ownerDecision.demand.raw_days_of_supply, 22.13, 'raw_days_of_supply must remain raw');
  // Passing through workflow must not alter numbers either
  buildOwnerActionWorkflow(ownerDecision);
  assert.equal(ownerDecision.demand.velocity_30d, 2.033333333333333);
});

// ─── F11: CLI display hotfix (v30 spacing / /day suffix) ─

test('F11. Phase 8E CLI script uses spaced v30/dos formatting with /day suffix (display-only)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-decision.js'), 'utf8');
  // Must NOT produce the concatenated 'v30=...dos=' pattern
  assert.doesNotMatch(src, /v30=\$\{[^}]*\}dos=/, 'v30 and dos must be visually separated');
  // Must use fmtVelocity / fmtDos helpers
  assert.match(src, /fmtVelocity\(r\.demand\.velocity_30d\)/);
  assert.match(src, /fmtDos\(r\.demand\.raw_days_of_supply\)/);
  // The /day suffix should be emitted
  assert.match(src, /toFixed\(2\)\}\/day/);
});

// ─── F12-F13: CLI safety flags ──────────────────────────

test('F12. Owner Actions CLI rejects --apply', () => {
  const cliPath = path.resolve(__dirname, '../../scripts/oms-owner-actions.js');
  const src = fs.readFileSync(cliPath, 'utf8');
  assert.match(src, /FORBIDDEN_FLAGS/);
  assert.match(src, /'--apply'/);
  assert.match(src, /intentionally NOT supported/);
});

test('F13. Owner Actions CLI rejects --execute / --purchase / --hold', () => {
  const cliPath = path.resolve(__dirname, '../../scripts/oms-owner-actions.js');
  const src = fs.readFileSync(cliPath, 'utf8');
  for (const flag of ['--execute', '--purchase', '--hold']) {
    assert.match(src, new RegExp(`'${flag}'`), `CLI must list ${flag} as forbidden`);
  }
  // No DB writes / marketplace / notify APIs in CLI
  assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(/);
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]/i);
  assert.doesNotMatch(src, /getClient\(/);
});

// ─── F14: BP unchanged ──────────────────────────────────

test('F14. BP remains WATCH · priority 170 after workflow projection', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const wf = buildOwnerActionWorkflow(ownerDecision);
  assert.equal(ownerDecision.headline.decision_status, DECISION.WATCH);
  assert.equal(ownerDecision.headline.priority_score, 170);
  assert.equal(wf.decision_status_at_creation, DECISION.WATCH);
  assert.equal(wf.priority_score_at_creation, 170);
});

// ─── F15: scheduler / cron unchanged ────────────────────

test('F15. scheduler / cron / job files unchanged by Phase 8F (no new require / no wiring)', () => {
  const scheduler = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.js'), 'utf8');
  assert.doesNotMatch(scheduler, /inventoryOwnerActionWorkflowService/);
  assert.doesNotMatch(scheduler, /oms-owner-actions/);
  const dailyJob = fs.readFileSync(path.resolve(__dirname, '../../src/jobs/inventoryExceptionsDailyJob.js'), 'utf8');
  assert.doesNotMatch(dailyJob, /inventoryOwnerActionWorkflowService/);
});

// ─── F16: 8C/8D delivery API surface unchanged ──────────

test('F16. Phase 8C/8D delivery / fingerprint API surface unchanged', () => {
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  assert.equal(typeof alerter.computeAlertPlan, 'function');
  assert.equal(typeof alerter.computeDeliveryPlan, 'function');
  assert.equal(typeof alerter.deriveEffectiveDeliveryStateFromRuns, 'function');
  assert.equal(typeof alerter._internals._fingerprint, 'function');
  assert.equal(typeof alerter._internals._extractActionSummary, 'function');
});

// ─── Extra sanity ────────────────────────────────────────

test('WATCH_ONLY status is OPEN and observational (never spuriously satisfied)', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const wf = buildOwnerActionWorkflow(ownerDecision);
  const watch = wf.workflow_actions.find(a => a.action_code === ACTION.WATCH_ONLY);
  assert.equal(watch.status, WORKFLOW_STATUS.OPEN);
  assert.equal(watch.observational, true);
  assert.deepEqual(watch.required_evidence, []);
});

test('SELL_NORMALLY → NO_ACTION is CLOSED_NO_ACTION', async () => {
  const f = bpDecisionResultFixture();
  f.decision.status = DECISION.SELL_NORMALLY;
  const ownerDecision = await ownerDecisionFor(f);
  const wf = buildOwnerActionWorkflow(ownerDecision);
  const only = wf.workflow_actions[0];
  assert.equal(only.action_code, ACTION.NO_ACTION);
  assert.equal(only.status, WORKFLOW_STATUS.CLOSED_NO_ACTION);
});

test('REPLENISH / PROTECT_STOCK / INSUFFICIENT_DATA all yield OWNER_REVIEW_REQUIRED', async () => {
  for (const st of [DECISION.REPLENISH, DECISION.PROTECT_STOCK, DECISION.INSUFFICIENT_DATA]) {
    const f = bpDecisionResultFixture();
    f.decision.status = st;
    if (st === DECISION.INSUFFICIENT_DATA) f.missing_evidence = ['trusted_cross_channel_velocity'];
    const ownerDecision = await ownerDecisionFor(f);
    const wf = buildOwnerActionWorkflow(ownerDecision);
    for (const a of wf.workflow_actions) assert.equal(a.status, WORKFLOW_STATUS.OWNER_REVIEW_REQUIRED, `${st}: ${a.action_code}`);
  }
});

test('workflow summary counters are correct', async () => {
  const ownerDecision = await ownerDecisionFor(bpDecisionResultFixture());
  const wf = buildOwnerActionWorkflow(ownerDecision);
  assert.equal(wf.summary.total_actions, 3);
  assert.equal(wf.summary.open_count, 3, 'WATCH_ONLY + CONFIRM + CHECK all open/partial');
  assert.equal(wf.summary.evidence_ready_count, 0);
  assert.equal(wf.summary.review_required_count, 0);
});
