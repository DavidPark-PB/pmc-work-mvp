'use strict';

/**
 * tests/scripts/ownerQuoteCli.test.js — Phase 8H.
 *
 * Owner Evidence Capture UX wrapper (scripts/oms-owner-quote.js).
 *
 * Rules under test:
 *   · UX wrapper is thin — only Phase 8G intake service is used to write.
 *   · --supplier / --executable / --secondary map explicitly · never auto-promote.
 *   · SECONDARY_MARKET_ASK stays SECONDARY_MARKET_ASK even with qty + price.
 *   · --record-evidence requires --identity-confirmed; SUPPLIER/EXECUTABLE also require --current-quote-confirmed.
 *   · Identity gate NEVER weakened — canonical ingestor's identity refusal is honored.
 *   · Preview never writes / never notifies / never mutates anything.
 *   · --reassess only fires after successful record; on failure it is skipped.
 *   · Reassess uses existing decision engine + Phase 8F workflow — no parallel logic.
 *   · No inference of carton / MOQ / landed cost / supplier identity.
 *   · BP baseline WATCH · 170 preserved when no real evidence is recorded.
 *   · Phase 8C/8D delivery + fingerprint API surface untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cli = require('../../scripts/oms-owner-quote');
const { EVIDENCE_TYPES } = require('../../src/services/oms/replacementEvidenceTypes');
const { buildOwnerDecision, ACTION } = require('../../src/services/oms/inventoryOwnerDecisionService');
const { buildOwnerActionWorkflow, WORKFLOW_STATUS } = require('../../src/services/oms/inventoryOwnerActionWorkflowService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

// ── BP fixture ──────────────────────────────────────────
function bpDecisionFixture() {
  return {
    physical_product_id: 1,
    generated_at: '2026-08-16T00:00:00.000Z',
    physical: { id: 1, canonical_title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: ['current_supply_ask_only'], hold_quantity_blockers: [], depth_gap: 15 },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: { trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.03, raw_days_of_supply: 22.13, demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984 },
    supply_summary: { verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, uncovered_at_60: 30, uncovered_at_100: 70, secondary_market_dependency_by_target: { 60: 1.0 }, observed_secondary_market_unit_cost_min: 40000 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    missing_evidence: [], strategic_hold_source: {},
  };
}

// ── Dep helpers ─────────────────────────────────────────
function makeDeps({ previewResult, recordResult, reassessResult, ownerBefore } = {}) {
  const previewCalls = [];
  const recordCalls = [];
  const reassessCalls = [];
  const ownerDecisionCalls = [];
  const wfCalls = [];
  return {
    previewFn: async (input) => { previewCalls.push(input); return previewResult || { mode: 'preview', validation: { ok: true, errors: [], warnings: [], action_gap_projection: { would_close_CHECK_PRIMARY_SUPPLIER: false, would_close_CONFIRM_EXECUTABLE_QUOTE: false, would_close_CHECK_SECONDARY_MARKET: false, forbidden_promotion: [] } }, plan: { status: 'dry_run', would_persist: [{ evidence: { fingerprint: 'F' } }], rejected: [] }, physical: { id: input.physicalId, canonical_title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko' }, would_execute: { purchase: false, strategic_hold: false, marketplace_price_change: false, inventory_adjustment: false, notification: false }, persistence: 'NOT_WRITTEN_PREVIEW_ONLY' }; },
    recordFn: async (input, opts) => { recordCalls.push({ input, opts }); return recordResult || { mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: [], plan: { status: 'ingested', inserted: [{ id: 42 }], skipped_idempotent: [], failed: [], rejected: [] }, physical: { id: input.physicalId, canonical_title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko' }, persistence: 'ingested', would_execute: { purchase: false, strategic_hold: false, marketplace_price_change: false, inventory_adjustment: false, notification: false } }; },
    reassessFn: async (args) => { reassessCalls.push(args); return reassessResult || { status: 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS', before: { decision_status: 'WATCH', priority_score: 170, supply_current_quality: 'ask_only', owner_action_statuses: [{ code: 'CONFIRM_EXECUTABLE_QUOTE', status: 'OPEN' }, { code: 'CHECK_PRIMARY_SUPPLIER', status: 'OPEN' }] }, after: { decision_status: 'WATCH', priority_score: 170, supply_current_quality: 'supplier_quote', owner_action_statuses: [{ code: 'CONFIRM_EXECUTABLE_QUOTE', status: 'OPEN' }, { code: 'CHECK_PRIMARY_SUPPLIER', status: 'EVIDENCE_READY' }] }, changed: {}, unchanged: [] }; },
    buildOwnerDecisionFn: async (args) => { ownerDecisionCalls.push(args); return ownerBefore || (await buildOwnerDecision({ physicalProductId: args.physicalProductId, assessFn: async () => bpDecisionFixture() })); },
    buildOwnerActionWorkflowFn: (od) => { wfCalls.push(od); return buildOwnerActionWorkflow(od); },
    log: () => {}, err: () => {},
    _spies: { previewCalls, recordCalls, reassessCalls, ownerDecisionCalls, wfCalls },
  };
}

function argv(list) { return ['node', 'scripts/oms-owner-quote.js', ...list]; }

// ─── H1-H4: mode → evidence_type mapping ─────────────────

test('H1. --supplier maps to SUPPLIER_QUOTE', () => {
  const { args, errors } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z']));
  assert.deepEqual(errors, []);
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.evidenceType, EVIDENCE_TYPES.SUPPLIER_QUOTE);
});

test('H2. --executable maps to EXECUTABLE_QUOTE', () => {
  const { args, errors } = cli.parseArgs(argv(['--physical-id', '1', '--executable', '--name', 'X', '--price', '40000', '--observed-at', '2026-08-15T00:00:00Z']));
  assert.deepEqual(errors, []);
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.evidenceType, EVIDENCE_TYPES.EXECUTABLE_QUOTE);
});

test('H3. --secondary --market kream maps to SECONDARY_MARKET_ASK', () => {
  const { args, errors } = cli.parseArgs(argv(['--physical-id', '1', '--secondary', '--market', 'kream', '--price', '40000', '--observed-at', '2026-08-15T00:00:00Z']));
  assert.deepEqual(errors, []);
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.evidenceType, EVIDENCE_TYPES.SECONDARY_MARKET_ASK);
  assert.equal(input.source, 'kream');
  assert.equal(input.supplierName, null, 'secondary: supplierName intentionally null (marketplace = identity)');
});

test('H4. secondary + qty + price STAYS SECONDARY_MARKET_ASK (no auto-promotion)', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--secondary', '--market', 'bunjang', '--price', '40000', '--qty', '30', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.evidenceType, EVIDENCE_TYPES.SECONDARY_MARKET_ASK);
  assert.equal(input.availableQuantityExact, 30);
});

test('H4b. mutually exclusive: --supplier + --executable rejected', () => {
  const { errors } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--executable', '--name', 'X', '--price', '1', '--observed-at', '2026-08-15T00:00:00Z']));
  assert.ok(errors.some(e => /mutually exclusive/.test(e)));
});

// ─── H5-H6: record gates ────────────────────────────────

test('H5. --supplier + --record-evidence WITHOUT --current-quote-confirmed → recordFn returns gate_errors, ingestor NOT called', async () => {
  const deps = makeDeps({
    recordResult: { mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: ['SUPPLIER_QUOTE requires currentQuoteConfirmed=true to record'], persistence: 'NOT_WRITTEN_GATE_REJECTED', plan: null, physical: { id: 1, canonical_title: 'Battle Partners Booster Box' }, would_execute: { purchase: false } },
  });
  const code = await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed']), deps);
  assert.equal(code, 1);
  assert.equal(deps._spies.recordCalls.length, 1);
  assert.equal(deps._spies.recordCalls[0].opts.currentQuoteConfirmed, false);
});

test('H6. --executable + --record-evidence WITHOUT --current-quote-confirmed → gate_errors', async () => {
  const deps = makeDeps({
    recordResult: { mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: ['EXECUTABLE_QUOTE requires currentQuoteConfirmed=true to record'], persistence: 'NOT_WRITTEN_GATE_REJECTED', plan: null, physical: { id: 1, canonical_title: 'Battle Partners Booster Box' }, would_execute: { purchase: false } },
  });
  const code = await cli.main(argv(['--physical-id', '1', '--executable', '--name', 'X', '--price', '40000', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed']), deps);
  assert.equal(code, 1);
});

test('H6b. supplier + record with BOTH gates + fake ingested → returns 0', async () => {
  const deps = makeDeps();
  const code = await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'Distributor A', '--price', '19500', '--qty', '20', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed', '--current-quote-confirmed']), deps);
  assert.equal(code, 0);
  assert.equal(deps._spies.recordCalls.length, 1);
  assert.equal(deps._spies.recordCalls[0].opts.identityConfirmed, true);
  assert.equal(deps._spies.recordCalls[0].opts.currentQuoteConfirmed, true);
});

// ─── H7: identity gate preserved ────────────────────────

test('H7. identity gate preserved — canonical rejected[] surfaced as identity_rejected', async () => {
  const deps = makeDeps({
    recordResult: { mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: [], plan: { status: 'ingested', inserted: [], skipped_idempotent: [], failed: [], rejected: [{ identity_status: 'NOT_SAME_PHYSICAL' }] }, physical: { id: 1, canonical_title: 'Battle Partners Booster Box' }, persistence: 'ingested', would_execute: { purchase: false } },
  });
  const buf = [];
  deps.log = m => buf.push(m);
  const code = await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed', '--current-quote-confirmed']), deps);
  assert.equal(code, 0);
  assert.ok(buf.some(s => /identity_rejected=1/.test(s)));
});

// ─── H8-H13: safety (no writes/mutations from preview or record UX layer) ─

test('H8. preview default → previewFn called with confirm implicit (recordFn NOT called)', async () => {
  const deps = makeDeps();
  await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z']), deps);
  assert.equal(deps._spies.previewCalls.length, 1);
  assert.equal(deps._spies.recordCalls.length, 0);
});

test('H9. UX CLI source only requires the Phase 8G intake service (no parallel write path)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-quote.js'), 'utf8');
  // The only intake require must be the Phase 8G service — never the raw ingestor / validator.
  assert.match(src, /require\('\.\.\/src\/services\/oms\/inventoryOwnerEvidenceIntakeService'\)/);
  assert.doesNotMatch(src, /require\(['"][^'"]*replacementObservationIngestor['"]\)/);
  assert.doesNotMatch(src, /require\(['"][^'"]*manualReplacementObservationValidator['"]\)/);
  assert.doesNotMatch(src, /require\(['"][^'"]*physical_market_observations['"]\)/);
});

test('H10-H13. UX CLI source has no inventory / purchase / marketplace / notification references', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-quote.js'), 'utf8');
  // H10: no inventory table access
  assert.doesNotMatch(src, /\binventory_movements\b|\bsellable_units\b|\bphysical_inventory\b|\breservations\b/);
  // H11: no purchase creation
  assert.doesNotMatch(src, /purchase_requests|purchase_orders/);
  // H12: no marketplace API
  assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(|require\(['"][^'"]*ebayAPI['"]\)/);
  // H13: no notification
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]\)|require\(['"][^'"]*imessage['"]\)|require\(['"][^'"]*notify['"]\)/);
  assert.doesNotMatch(src, /sendPlain|sendAlert|sendMessage/);
});

// ─── H14-H16: qty semantics ─────────────────────────────

test('H14. --qty N preserved as availableQuantityExact', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--qty', '20', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.availableQuantityExact, 20);
  assert.equal(input.availableQuantityMin, null);
  assert.equal(input.availableQuantityMax, null);
});

test('H15. --qty-min/--qty-max preserved as range', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--qty-min', '15', '--qty-max', '30', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.availableQuantityMin, 15);
  assert.equal(input.availableQuantityMax, 30);
  assert.equal(input.availableQuantityExact, null);
});

test('H15b. --qty AND --qty-min mixed → rejected', () => {
  const { errors } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--qty', '20', '--qty-min', '15', '--observed-at', '2026-08-15T00:00:00Z']));
  assert.ok(errors.some(e => /either --qty exact OR --qty-min/.test(e)));
});

test('H16. no qty flags → all three qty fields UNKNOWN (null)', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.availableQuantityExact, null);
  assert.equal(input.availableQuantityMin, null);
  assert.equal(input.availableQuantityMax, null);
});

// ─── H17-H18: no fabrication ────────────────────────────

test('H17. no carton inference — unitsPerCarton / cartonCount stay absent from mapped input', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--qty', '30', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.unitsPerCarton, undefined, 'no cartonization inferred');
  assert.equal(input.cartonCount, undefined);
});

test('H18. no landed cost inference — landedCostKrw stays absent', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--qty', '30', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  assert.equal(input.landedCostKrw, undefined);
});

// ─── H19-H20: reassess semantics ────────────────────────

test('H19. --reassess without --record-evidence → parseArgs error', () => {
  const { errors } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--reassess']));
  assert.ok(errors.some(e => /--reassess requires --record-evidence/.test(e)));
});

test('H19b. --reassess + --record-evidence but record FAILED → reassessFn NOT called', async () => {
  const deps = makeDeps({
    recordResult: { mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: [], plan: { status: 'failed', inserted: [], skipped_idempotent: [], failed: [{ code: 'PG_ERR', message: 'x' }], rejected: [] }, physical: { id: 1, canonical_title: 'Battle Partners Booster Box' }, persistence: 'failed', would_execute: { purchase: false } },
  });
  const code = await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed', '--current-quote-confirmed', '--reassess']), deps);
  assert.equal(code, 1);
  assert.equal(deps._spies.reassessCalls.length, 0);
});

test('H19c. --reassess + record success → reassessFn called with mode=around_record', async () => {
  const deps = makeDeps();
  await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed', '--current-quote-confirmed', '--reassess']), deps);
  assert.equal(deps._spies.reassessCalls.length, 1);
  assert.equal(deps._spies.reassessCalls[0].mode, 'around_record');
  assert.equal(deps._spies.reassessCalls[0].physicalProductId, 1);
});

test('H20. reassessment uses existing SoT — CLI does not compute a parallel BEFORE/AFTER itself (delegates to reassessFn)', async () => {
  const deps = makeDeps();
  await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed', '--current-quote-confirmed', '--reassess']), deps);
  // buildOwnerDecisionFn called EXACTLY once for BEFORE snapshot (not twice)
  assert.equal(deps._spies.ownerDecisionCalls.length, 1);
  assert.equal(deps._spies.reassessCalls.length, 1);
});

// ─── H21: workflow reuses Phase 8F ──────────────────────

test('H21. BEFORE snapshot uses Phase 8F workflow (buildOwnerActionWorkflow called)', async () => {
  const deps = makeDeps();
  await cli.main(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--record-evidence', '--identity-confirmed', '--current-quote-confirmed', '--reassess']), deps);
  assert.equal(deps._spies.wfCalls.length, 1);
});

// ─── H22-H23: baselines untouched ───────────────────────

test('H22. BP baseline remains WATCH · 170 when no real evidence recorded (through Phase 8E projection)', async () => {
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => bpDecisionFixture() });
  assert.equal(owner.headline.decision_status, DECISION.WATCH);
  assert.equal(owner.headline.priority_score, 170);
});

test('H23. Phase 8C/8D alerter API surface unchanged by Phase 8H', () => {
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  assert.equal(typeof alerter.computeAlertPlan, 'function');
  assert.equal(typeof alerter.computeDeliveryPlan, 'function');
  assert.equal(typeof alerter.deriveEffectiveDeliveryStateFromRuns, 'function');
  assert.equal(typeof alerter._internals._fingerprint, 'function');
});

// ─── Forbidden flags ────────────────────────────────────

test('forbidden flag --apply is rejected (parseArgs throws with forbidden marker)', () => {
  assert.throws(() => cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--apply'])), /FORBIDDEN_FLAG:--apply/);
});

test('forbidden flag --execute rejected (distinct from mode flag --executable)', () => {
  assert.throws(() => cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z', '--execute'])), /FORBIDDEN_FLAG:--execute/);
});

test('mode flag --executable is NOT confused with forbidden --execute', () => {
  const { args, errors } = cli.parseArgs(argv(['--physical-id', '1', '--executable', '--name', 'X', '--price', '40000', '--observed-at', '2026-08-15T00:00:00Z']));
  assert.deepEqual(errors, []);
  assert.equal(args.mode, 'executable');
});

test('forbidden flags --purchase / --hold / --auto* rejected', () => {
  for (const bad of ['--purchase', '--hold', '--auto', '--auto-purchase', '--auto-hold']) {
    assert.throws(() => cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '1', '--observed-at', '2026-08-15T00:00:00Z', bad])), new RegExp(`FORBIDDEN_FLAG:${bad}`));
  }
});

// ─── Help output uses placeholders (no real BP quotes) ─

test('--help output uses placeholders (never fabricates real BP prices)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-quote.js'), 'utf8');
  // Help examples must not include the observed BP historical typical (19500), accounting (45000),
  // or observed secondary ask (40000) as if they were real current quotes.
  const helpBlock = src.slice(src.indexOf('function _printHelp'), src.indexOf('function renderConfirmation'));
  assert.doesNotMatch(helpBlock, /\b19500\b/);
  assert.doesNotMatch(helpBlock, /\b40000\b/);
  assert.doesNotMatch(helpBlock, /\b45000\b/);
  assert.match(helpBlock, /<REAL_SUPPLIER>/);
  assert.match(helpBlock, /<REAL_PRICE_KRW>/);
  assert.match(helpBlock, /<REAL_QTY>/);
});

// ─── Owner Confirmation Summary block ───────────────────

test('renderConfirmation shows Product / Type / Source / Price / Quantity / Observed and safety statements', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'Distributor A', '--price', '19500', '--qty', '20', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  const out = cli.renderConfirmation({ input, physical: { canonical_title: 'Battle Partners Booster Box' }, args });
  assert.match(out, /OWNER EVIDENCE CONFIRMATION/);
  assert.match(out, /Battle Partners Booster Box/);
  assert.match(out, /Type:  SUPPLIER_QUOTE/);
  assert.match(out, /Source: Distributor A/);
  assert.match(out, /19,500 KRW/);
  assert.match(out, /Quantity: exact 20/);
  assert.match(out, /This WILL NOT:/);
  assert.match(out, /purchase/);
  assert.match(out, /marketplace/);
  assert.match(out, /notification/);
});

test('renderConfirmation for preview mode says preview only', () => {
  const { args } = cli.parseArgs(argv(['--physical-id', '1', '--supplier', '--name', 'X', '--price', '19500', '--observed-at', '2026-08-15T00:00:00Z']));
  const input = cli.mapArgsToIntakeInput(args);
  const out = cli.renderConfirmation({ input, physical: { canonical_title: 'BP' }, args });
  assert.match(out, /print preview only/);
});
