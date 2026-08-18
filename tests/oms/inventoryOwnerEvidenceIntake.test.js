'use strict';

/**
 * tests/oms/inventoryOwnerEvidenceIntake.test.js — Phase 8G.
 *
 * Owner Evidence Intake validator + preview + record adapter.
 *
 * ABSOLUTE rules under test:
 *   · SUPPLIER_QUOTE never promotes to EXECUTABLE_QUOTE
 *   · SECONDARY_MARKET_ASK never masquerades as EXECUTABLE_QUOTE or SUPPLIER_QUOTE
 *   · TYPICAL_SUPPLIER_REFERENCE never satisfies current supplier quote
 *   · Historical accounting cost never satisfies anything
 *   · UNKNOWN stays UNKNOWN (quantity, landed cost, supplier identity)
 *   · Preview mode NEVER calls the ingestor with confirm=true
 *   · Record mode ONLY calls the canonical ingestReplacementObservations path
 *   · Idempotency reuses the canonical SHA-256 fingerprint (no parallel dedup)
 *   · Evidence readiness NEVER executes purchase / hold / marketplace / inventory
 *   · Reassessment reuses assessInventoryDecision — never fabricates AFTER state
 *   · BP baseline: WATCH · 170 preserved through the whole path
 *   · Phase 8C/8D delivery / fingerprint API surface untouched
 *   · Phase 8E numeric semantics untouched
 *   · Phase 8F workflow semantics untouched
 *
 * Tests must NEVER touch the real DB or the real ingestor — all writes /
 * assess calls are injected fakes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  validateOwnerSupplyEvidence,
  previewOwnerEvidence,
  recordOwnerEvidence,
  previewOwnerEvidenceReassessment,
} = require('../../src/services/oms/inventoryOwnerEvidenceIntakeService');
const { EVIDENCE_TYPES } = require('../../src/services/oms/replacementEvidenceTypes');
const { buildOwnerDecision, ACTION } = require('../../src/services/oms/inventoryOwnerDecisionService');
const { buildOwnerActionWorkflow, WORKFLOW_STATUS } = require('../../src/services/oms/inventoryOwnerActionWorkflowService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

// ─── BP fixture (production-shape, matches Phase 8E/8F) ─

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
      reason_codes: ['hold_status:review_demand_and_supply_risk', 'current_supply_ask_only', 'replacement_difficulty_hard'],
      hold_quantity_blockers: [], strategic_hold_recommended_units: null,
      upstream_hold_status: 'REVIEW_DEMAND_AND_SUPPLY_RISK', upstream_supply_verdict: 'AT_RISK', depth_gap: 15,
    },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: {
      trusted: true, units_7d: 60, units_30d: 61, velocity_7d: 8.57, velocity_30d: 2.033333333333333,
      raw_days_of_supply: 22.13, demand_pattern: 'concentrated_large_order',
      largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984, total_shipments_30d: 3, trust_reason: 'multi_channel_evidence',
    },
    supply_summary: {
      verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only', supplier_diversity: 0,
      has_current_supplier_or_executable: false, replacement_difficulty: 'HARD',
      replacement_difficulty_reason_codes: ['ask_only_supply'],
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
function bpPhysical() { return bpDecisionResultFixture().physical; }
const NOW_MS = Date.parse('2026-08-16T00:00:00.000Z');

async function bpBeforeSnapshot() {
  const owner = await buildOwnerDecision({
    physicalProductId: 1,
    assessFn: async () => bpDecisionResultFixture(),
  });
  const wf = buildOwnerActionWorkflow(owner);
  return { owner_decision: owner, workflow: wf };
}

// Fake ingestor — captures every call, never touches DB.
function makeFakeIngestor(behavior = 'ingested') {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (args.confirm !== true) {
      return { status: 'dry_run', dryRun: true, physical_product_id: args.physical.id, identity_confirmed: !!args.identityConfirmed, current_quote_confirmed: !!args.currentQuoteConfirmed, current_quote_warnings: [], counts: { raw: args.rawOffers.length, normalized: args.rawOffers.length, persistable: args.rawOffers.length, by_identity_status: {} }, would_persist: args.rawOffers.map(r => ({ evidence: { fingerprint: 'FP' + Math.random().toString(16).slice(2, 10), source_listing_id: r.source_listing_id } })), rejected: [] };
    }
    if (behavior === 'ingested') return { status: 'ingested', dryRun: false, inserted: [{ id: 1234 }], skipped_idempotent: [], failed: [] };
    if (behavior === 'idempotent_skip') return { status: 'ingested', dryRun: false, inserted: [], skipped_idempotent: [{ existing_id: 999, fingerprint: 'FP_dup', reason: 'idempotent_no_op' }], failed: [] };
    if (behavior === 'aborted_current_quote_not_confirmed') return { status: 'aborted_current_quote_not_confirmed', dryRun: false, error: 'apply refused' };
    if (behavior === 'aborted_typical_cannot_be_current') return { status: 'aborted_typical_reference_cannot_be_current_quote', dryRun: false, error: 'apply refused' };
    return { status: behavior, dryRun: false };
  };
  fn._calls = calls;
  return fn;
}

// ─── G1-G6: validator semantics ─────────────────────────

test('G1. valid SUPPLIER_QUOTE validates ok=true', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, priceBasis: 'per_physical_unit',
    physicalUnitsPerOffer: 1, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, true, `errors: ${v.errors.join(', ')}`);
  assert.equal(v.normalized.evidenceType, EVIDENCE_TYPES.SUPPLIER_QUOTE);
});

test('G2. SUPPLIER_QUOTE input never auto-promotes to EXECUTABLE_QUOTE (action_gap_projection)', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.action_gap_projection.would_close_CONFIRM_EXECUTABLE_QUOTE, false);
  assert.equal(v.action_gap_projection.would_close_CHECK_PRIMARY_SUPPLIER, true);
  assert.ok(v.action_gap_projection.forbidden_promotion.includes('SUPPLIER_QUOTE_MUST_NOT_MASQUERADE_AS_EXECUTABLE_QUOTE'));
});

test('G3. valid EXECUTABLE_QUOTE validates distinctly and closes BOTH actions (with currentQuoteConfirmed)', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.EXECUTABLE_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 18000, observedAt: '2026-08-15T00:00:00Z',
    availableQuantityExact: 30,
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, true);
  assert.equal(v.action_gap_projection.would_close_CONFIRM_EXECUTABLE_QUOTE, true);
  assert.equal(v.action_gap_projection.would_close_CHECK_PRIMARY_SUPPLIER, true);
});

test('G4. SECONDARY_MARKET_ASK cannot masquerade as EXECUTABLE_QUOTE or SUPPLIER_QUOTE', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SECONDARY_MARKET_ASK,
    source: 'bunjang', currency: 'KRW', price: 40000, observedAt: '2026-08-15T00:00:00Z',
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, true);
  assert.equal(v.action_gap_projection.would_close_CONFIRM_EXECUTABLE_QUOTE, false);
  assert.equal(v.action_gap_projection.would_close_CHECK_PRIMARY_SUPPLIER, false);
  assert.equal(v.action_gap_projection.would_close_CHECK_SECONDARY_MARKET, true);
  assert.ok(v.action_gap_projection.forbidden_promotion.some(x => /MASQUERADE_AS_EXECUTABLE_QUOTE/.test(x)));
  assert.ok(v.action_gap_projection.forbidden_promotion.some(x => /IS_NOT_A_SUPPLIER_QUOTE/.test(x)));
});

test('G5. TYPICAL_SUPPLIER_REFERENCE cannot carry currentQuoteConfirmed (semantic mismatch rejected)', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
    source: 'internal', supplierName: 'Reference Only',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,   // FORBIDDEN
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /currentQuoteConfirmed forbidden/.test(e)));
});

test('G6. accounting cost is not an evidence type — unknown evidenceType rejected', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: 'HISTORICAL_ACCOUNTING_COST',
    source: 'internal', currency: 'KRW', price: 45000, observedAt: '2026-08-15T00:00:00Z',
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /evidenceType must be one of/.test(e)));
});

// ─── G7-G10: UNKNOWN preservation + timestamps ─────────

test('G7. UNKNOWN quantity remains UNKNOWN (warning surfaced, never fabricated)', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, true);
  assert.equal(v.normalized.availableQuantityMin, null);
  assert.equal(v.normalized.availableQuantityMax, null);
  assert.equal(v.normalized.availableQuantityExact, null);
  assert.ok(v.warnings.some(w => /quantity UNKNOWN/.test(w)));
});

test('G8. UNKNOWN landed cost remains UNKNOWN (warning surfaced, never fabricated)', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.EXECUTABLE_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 18000, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.ok(v.warnings.some(w => /landed_cost UNKNOWN/.test(w)));
});

test('G9. malformed timestamp rejected', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: 'not-a-date',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /observedAt not a valid ISO/.test(e)));
});

test('G10. future timestamp beyond 1h clock tolerance rejected (existing 7C-4 policy reused)', () => {
  const future = new Date(NOW_MS + 24 * 3600 * 1000).toISOString();
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: future,
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /future beyond/.test(e)));
});

// ─── G11-G13: preview safety + CLI mutation flag rejection

test('G11. previewOwnerEvidence performs zero writes (ingestor called with confirm=false)', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  await previewOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, priceBasis: 'per_physical_unit',
    physicalUnitsPerOffer: 1, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS });
  assert.equal(ingestFn._calls.length, 1);
  assert.equal(ingestFn._calls[0].confirm, false, 'preview MUST call ingestor with confirm=false');
});

test('G12. previewOwnerEvidence performs zero notifications (result shape has would_execute.notification=false)', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  const r = await previewOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS });
  assert.equal(r.would_execute.notification, false);
  assert.equal(r.would_execute.purchase, false);
  assert.equal(r.would_execute.strategic_hold, false);
  assert.equal(r.would_execute.marketplace_price_change, false);
});

test('G13. CLI rejects --apply / --execute / --purchase / --hold / --auto*', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-evidence.js'), 'utf8');
  for (const flag of ['--apply', '--execute', '--purchase', '--hold', '--auto', '--auto-purchase', '--auto-hold']) {
    assert.match(src, new RegExp(`'${flag}'`), `CLI must list ${flag} as forbidden`);
  }
  assert.match(src, /FORBIDDEN_FLAGS/);
  assert.match(src, /intentionally NOT supported/);
});

// ─── G14-G15: canonical persistence path + idempotency ─

test('G14. recordOwnerEvidence calls ONLY ingestReplacementObservations (canonical path)', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  await recordOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, priceBasis: 'per_physical_unit',
    physicalUnitsPerOffer: 1, observedAt: '2026-08-15T00:00:00Z',
  }, {
    identityConfirmed: true, currentQuoteConfirmed: true,
    ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS,
  });
  assert.equal(ingestFn._calls.length, 1);
  assert.equal(ingestFn._calls[0].confirm, true);
  assert.equal(ingestFn._calls[0].identityConfirmed, true);
  assert.equal(ingestFn._calls[0].currentQuoteConfirmed, true);
  // Exactly one rawOffer · one supplyMeta · evidence_type preserved
  assert.equal(ingestFn._calls[0].rawOffers.length, 1);
  assert.equal(ingestFn._calls[0].supplyMetaByOffer[0].evidenceType, EVIDENCE_TYPES.SUPPLIER_QUOTE);
});

test('G15. idempotency semantics reuse canonical fingerprint (skipped_idempotent surfaced)', async () => {
  const ingestFn = makeFakeIngestor('idempotent_skip');
  const r = await recordOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A', sourceListingId: 'owner:2026-08-15:distA',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
  }, { identityConfirmed: true, currentQuoteConfirmed: true, ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS });
  assert.equal(r.plan.status, 'ingested');
  assert.equal(r.plan.skipped_idempotent.length, 1);
  assert.match(r.idempotency_note, /SHA-256 fingerprint/);
});

// ─── G16-G18: no mutations elsewhere ────────────────────

test('G16. record does not mutate inventory (no inventory table access in service or CLI source)', () => {
  const svc = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/inventoryOwnerEvidenceIntakeService.js'), 'utf8');
  const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-evidence.js'), 'utf8');
  for (const src of [svc, cli]) {
    // Word-boundary anchored so we don't trip on "preservation" / "reserved" in comments.
    assert.doesNotMatch(src, /\binventory_movements\b|\bsellable_units\b|\bphysical_inventory\b|\breservations\b/);
    // Only physical_products (read) and physical_market_observations (via injected ingestor) are allowed.
    assert.doesNotMatch(src, /\bfrom\(['"](?!physical_products['"])(?!physical_market_observations['"])[^'"]+['"]/);
  }
});

test('G17. record does not mutate marketplace (no marketplace API references)', () => {
  const svc = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/inventoryOwnerEvidenceIntakeService.js'), 'utf8');
  const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-evidence.js'), 'utf8');
  for (const src of [svc, cli]) {
    assert.doesNotMatch(src, /\.updateItem\(|\.ReviseItem\(|\.updatePrice\(|updatePriceKrw/);
    assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]/i);
    assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]/i);
    assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]/i);
    assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]/i);
  }
});

test('G18. record does not purchase — no purchase_requests / strategic_hold_allocations references', () => {
  const svc = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/inventoryOwnerEvidenceIntakeService.js'), 'utf8');
  const cli = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-owner-evidence.js'), 'utf8');
  for (const src of [svc, cli]) {
    assert.doesNotMatch(src, /purchase_requests|purchase_orders|strategic_hold_allocations|strategic_hold_units/);
  }
});

// ─── G19-G21: action-gap closure semantics ─────────────

test('G19. SUPPLIER_QUOTE closes CHECK_PRIMARY_SUPPLIER only (not CONFIRM_EXECUTABLE_QUOTE)', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.action_gap_projection.would_close_CHECK_PRIMARY_SUPPLIER, true);
  assert.equal(v.action_gap_projection.would_close_CONFIRM_EXECUTABLE_QUOTE, false);
});

test('G20. EXECUTABLE_QUOTE closes BOTH CONFIRM_EXECUTABLE_QUOTE AND CHECK_PRIMARY_SUPPLIER', () => {
  const v = validateOwnerSupplyEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.EXECUTABLE_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 18000, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { nowMs: NOW_MS });
  assert.equal(v.action_gap_projection.would_close_CONFIRM_EXECUTABLE_QUOTE, true);
  assert.equal(v.action_gap_projection.would_close_CHECK_PRIMARY_SUPPLIER, true);
});

test('G21. evidence readiness does not imply BUY — record result has would_execute.purchase=false', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  const r = await recordOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.EXECUTABLE_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 18000, observedAt: '2026-08-15T00:00:00Z',
  }, { identityConfirmed: true, currentQuoteConfirmed: true, ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS });
  assert.equal(r.plan.status, 'ingested');
  assert.equal(r.would_execute.purchase, false);
  assert.equal(r.would_execute.strategic_hold, false);
  assert.equal(r.would_execute.marketplace_price_change, false);
});

// ─── G22-G23: reassessment reuses SoT, no parallel logic

test('G22. previewOwnerEvidenceReassessment(mode=around_record) reuses assessInventoryDecision', async () => {
  const before = await bpBeforeSnapshot();
  // AFTER decision: BP with EXECUTABLE quote arrived
  const afterFixture = bpDecisionResultFixture();
  afterFixture.supply_summary.current_supply_quality = 'executable';
  afterFixture.supply_summary.has_current_supplier_or_executable = true;
  afterFixture.decision.reason_codes = ['hold_status:sell_normally'];
  let assessCalls = 0;
  const assessFn = async () => { assessCalls++; return afterFixture; };
  const r = await previewOwnerEvidenceReassessment({ physicalProductId: 1, beforeSnapshot: before, mode: 'around_record', assessFn });
  assert.equal(assessCalls, 1, 'assess called EXACTLY once (SoT reused, no parallel logic)');
  assert.equal(r.status, 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS');
  assert.equal(r.before.supply_current_quality, 'ask_only');
  assert.equal(r.after.supply_current_quality, 'executable');
  assert.ok(r.changed.supply_current_quality);
  assert.ok(r.unchanged.length > 0);
});

test('G23. reassessment PREVIEW mode returns REASSESSMENT_PREVIEW_UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE (never fabricates AFTER)', async () => {
  const before = await bpBeforeSnapshot();
  const r = await previewOwnerEvidenceReassessment({ physicalProductId: 1, beforeSnapshot: before, mode: 'preview' });
  assert.equal(r.status, 'REASSESSMENT_PREVIEW_UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE');
  assert.equal(r.after, null);
});

// ─── G24-G27: baseline preservation ─────────────────────

test('G24. BP baseline remains WATCH · priority 170 before any evidence', async () => {
  const before = await bpBeforeSnapshot();
  assert.equal(before.owner_decision.headline.decision_status, DECISION.WATCH);
  assert.equal(before.owner_decision.headline.priority_score, 170);
});

test('G25. Phase 8C/8D alerter API surface unchanged after 8G', () => {
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  assert.equal(typeof alerter.computeAlertPlan, 'function');
  assert.equal(typeof alerter.computeDeliveryPlan, 'function');
  assert.equal(typeof alerter.deriveEffectiveDeliveryStateFromRuns, 'function');
  assert.equal(typeof alerter._internals._fingerprint, 'function');
});

test('G26. Phase 8E numeric semantics preserved (velocity_30d raw, cost categories separated)', async () => {
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => bpDecisionResultFixture() });
  assert.equal(owner.demand.velocity_30d, 2.033333333333333);
  assert.equal(owner.cost_context.historical_typical_supplier_cost_krw_median, 19500);
  assert.equal(owner.cost_context.historical_accounting_cost_krw, 45000);
  assert.equal(owner.cost_context.observed_secondary_market_ask_min_krw, 40000);
});

test('G27. Phase 8F workflow semantics preserved (ask_only → CONFIRM_EXECUTABLE_QUOTE stays OPEN)', async () => {
  const owner = await buildOwnerDecision({ physicalProductId: 1, assessFn: async () => bpDecisionResultFixture() });
  const wf = buildOwnerActionWorkflow(owner);
  const confirm = wf.workflow_actions.find(a => a.action_code === ACTION.CONFIRM_EXECUTABLE_QUOTE);
  assert.equal(confirm.status, WORKFLOW_STATUS.OPEN);
  const check = wf.workflow_actions.find(a => a.action_code === ACTION.CHECK_PRIMARY_SUPPLIER);
  assert.equal(check.status, WORKFLOW_STATUS.OPEN);
});

// ─── Gate rejection paths ──────────────────────────────

test('recordOwnerEvidence without identityConfirmed=true is gate-rejected (does not call ingestor with confirm=true)', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  const r = await recordOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
  }, { identityConfirmed: false, currentQuoteConfirmed: true, ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS });
  assert.equal(r.persistence, 'NOT_WRITTEN_GATE_REJECTED');
  assert.equal(ingestFn._calls.length, 0);
  assert.ok(r.gate_errors.some(e => /identityConfirmed MUST be true/.test(e)));
});

test('recordOwnerEvidence SUPPLIER_QUOTE without currentQuoteConfirmed=true is gate-rejected', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  const r = await recordOwnerEvidence({
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
  }, { identityConfirmed: true, currentQuoteConfirmed: false, ingestFn, physicalFetcher: async () => bpPhysical(), nowMs: NOW_MS });
  assert.equal(r.persistence, 'NOT_WRITTEN_GATE_REJECTED');
  assert.equal(ingestFn._calls.length, 0);
});

test('physical_not_found short-circuits BEFORE ingestor is called', async () => {
  const ingestFn = makeFakeIngestor('ingested');
  const r = await previewOwnerEvidence({
    physicalId: 999999, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE,
    source: 'PRIMARY_SUPPLIER', supplierName: 'Distributor A',
    currency: 'KRW', price: 19500, observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true,
  }, { ingestFn, physicalFetcher: async () => null, nowMs: NOW_MS });
  assert.equal(r.error, 'physical_not_found');
  assert.equal(ingestFn._calls.length, 0);
});
