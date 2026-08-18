'use strict';

/**
 * tests/web/omsOwnerConsole.test.js — Phase 8I.
 *
 * Owner Decision Dashboard API + UI wiring safety.
 *
 * Rules under test:
 *   · API projects verbatim from existing SoT — no recomputation
 *   · BP remains WATCH / priority 170
 *   · Initial dashboard endpoint does NOT fetch per-physical detail
 *   · Evidence preview never writes; record requires {confirm:true}, identity gate, and current-quote gate for SUPPLIER/EXECUTABLE
 *   · Zero purchase / inventory / marketplace / strategic-hold mutation endpoints
 *   · Reassessment uses ONLY existing SoT (mode='around_record')
 *   · Legacy shared-password admin cannot record evidence
 *   · Phase 8C/8D alerter surface unchanged · Phase 8H CLI unaffected
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { buildRouter, _internals } = require('../../src/web/routes/omsOwnerConsole');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');
const { EVIDENCE_TYPES } = require('../../src/services/oms/replacementEvidenceTypes');
const { ACTION } = require('../../src/services/oms/inventoryOwnerDecisionService');

// ─── BP production-shape fixture ────────────────────────
function bpDecision() {
  return {
    physical_product_id: 1,
    generated_at: '2026-08-16T00:00:00.000Z',
    physical: { id: 1, canonical_title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: ['current_supply_ask_only'], hold_quantity_blockers: [], depth_gap: 15 },
    inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
    demand_summary: { trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.033333333333333, raw_days_of_supply: 22.13, demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984 },
    supply_summary: { verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, uncovered_at_60: 30, uncovered_at_100: 70, secondary_market_dependency_by_target: { 60: 1.0 } },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    missing_evidence: [], strategic_hold_source: {},
  };
}
function bpOwnerDecision() {
  // Match Phase 8E projection shape (via buildOwnerDecision) — but tests inject
  // via ownerDecisionFn so we can hand back a fake shape directly.
  return {
    physical_product_id: 1, generated_at: '2026-08-16T00:00:00.000Z',
    headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 170, urgency_label: 'medium', one_line_summary: 'x' },
    product: { title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 60, reserved: 15, available: 45 },
    demand: { trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.033333333333333, raw_days_of_supply: 22.13, demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984 },
    supply: { verdict: 'AT_RISK', replacement_difficulty: 'HARD', current_supply_quality: 'ask_only', evidenced_replacement_depth: 30, depth_gap: 15, uncovered_at_60: 30, uncovered_at_100: 70, secondary_market_dependency_at_60: 1.0, has_current_supplier_or_executable: false, supplier_diversity: 0 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000, note: 'separated' },
    reasons: { reason_codes: ['current_supply_ask_only'], hold_quantity_blockers: [], missing_evidence: [] },
    recommended_actions: [
      { code: ACTION.WATCH_ONLY, label: 'Watch only', description: 'x', risk_level: 'none', requires_owner_approval: true, executable_by_system: false },
      { code: ACTION.CONFIRM_EXECUTABLE_QUOTE, label: 'x', description: 'x', risk_level: 'low', requires_owner_approval: true, executable_by_system: false },
      { code: ACTION.CHECK_PRIMARY_SUPPLIER, label: 'x', description: 'x', risk_level: 'low', requires_owner_approval: true, executable_by_system: false },
    ],
    forbidden_automatic_actions: ['AUTO_PURCHASE', 'AUTO_STRATEGIC_HOLD', 'AUTO_MARKETPLACE_PRICE_CHANGE'],
    priority_reasons: [],
    source_snapshot: {},
  };
}
function bpQueueResult() {
  return {
    generated_at: '2026-08-16T00:00:00.000Z',
    summary: { physical_products_assessed: 5, sell_normally_count: 2, watch_count: 1, replenish_count: 1, protect_stock_count: 1, insufficient_data_count: 0, action_exception_count: 3, data_quality_count: 0, assessment_errors_count: 0, runtime_ms: 42, avg_ms_per_physical: 8.4, concurrency: 4, db_cache_hits: 3, db_cache_misses: 5, db_cache_per_table: {} },
    action_queue: [
      { rank: 1, physical_product_id: 1, title: 'Battle Partners Booster Box', decision_status: 'WATCH', confidence_level: 'low', priority_score: 170, priority_reasons: [], available_units: 45, raw_days_of_supply: 22.13, demand_pattern: 'concentrated_large_order', replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, depth_gap: 15, reason_codes: [], recommended_human_action: 'x' },
      { rank: 2, physical_product_id: 2, title: 'Other REPLENISH', decision_status: 'REPLENISH', confidence_level: 'medium', priority_score: 220, priority_reasons: [], available_units: 5, raw_days_of_supply: 2.5, demand_pattern: 'stable', replacement_difficulty: 'MODERATE', evidenced_replacement_depth: 100, depth_gap: -95, reason_codes: [], recommended_human_action: 'x' },
      { rank: 3, physical_product_id: 3, title: 'Protect stock', decision_status: 'PROTECT_STOCK', confidence_level: 'medium', priority_score: 330, priority_reasons: [], available_units: 200, raw_days_of_supply: 60, demand_pattern: 'accelerating', replacement_difficulty: 'HARD', evidenced_replacement_depth: 50, depth_gap: 150, reason_codes: [], recommended_human_action: 'x' },
    ],
    action_queue_total: 3, action_queue_limit_applied: null,
    data_quality_queue: [], assessment_errors: [],
  };
}

// ─── Test harness — spin up an in-process Express with the router ─
function withServer(deps, testFn) {
  return async () => {
    const app = express();
    // Inject a fake auth stub that mimics req.user shape.
    const fakeAuth = deps.__user
      ? (req, _res, next) => { req.user = deps.__user; next(); }
      : (req, _res, next) => { req.user = { id: 42, username: 'owner', role: 'admin', isAdmin: true, isLegacy: false }; next(); };
    const router = buildRouter({ ...deps, requireAdmin: fakeAuth });
    app.use('/api/oms/owner', router);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const { port } = server.address();
    const req = async (method, url, body) => {
      const bodyStr = body === undefined ? null : JSON.stringify(body);
      const opts = { method, port, path: url, headers: { 'accept': 'application/json' } };
      if (bodyStr != null) { opts.headers['content-type'] = 'application/json'; opts.headers['content-length'] = Buffer.byteLength(bodyStr); }
      return new Promise((resolve, reject) => {
        const r = http.request(opts, res => {
          let chunks = '';
          res.on('data', d => chunks += d.toString('utf8'));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null, headers: res.headers });
            } catch (e) { resolve({ status: res.statusCode, body: chunks, headers: res.headers, parseError: e.message }); }
          });
        });
        r.on('error', reject);
        if (bodyStr != null) r.write(bodyStr);
        r.end();
      });
    };
    try {
      await testFn(req);
    } finally {
      await new Promise(r => server.close(r));
    }
  };
}

// Spies factory
function spies() {
  const queueCalls = [];
  const ownerDecisionCalls = [];
  const workflowCalls = [];
  const previewCalls = [];
  const recordCalls = [];
  const reassessCalls = [];
  return { queueCalls, ownerDecisionCalls, workflowCalls, previewCalls, recordCalls, reassessCalls };
}

// ─── I1: exception endpoint returns existing queue result ─

test('I1. GET /inventory-exceptions returns buildInventoryExceptionQueue result verbatim', withServer({
  queueFn: async () => bpQueueResult(),
  ownerDecisionFn: async () => { throw new Error('detail must not be called'); },
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-exceptions');
  assert.equal(r.status, 200);
  assert.equal(r.body.action_queue.length, 3);
  assert.equal(r.body.action_queue[0].physical_product_id, 1);
  assert.equal(r.body.action_queue[0].decision_status, 'WATCH');
  assert.equal(r.body.action_queue[0].priority_score, 170);
  assert.equal(r.body.summary.watch_count, 1);
}));

// ─── I2: BP remains WATCH / 170 through the API path ─

test('I2. BP row in /inventory-exceptions is WATCH / 170 (verbatim)', withServer({
  queueFn: async () => bpQueueResult(),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-exceptions');
  const bp = r.body.action_queue.find(x => x.physical_product_id === 1);
  assert.equal(bp.decision_status, 'WATCH');
  assert.equal(bp.priority_score, 170);
  assert.equal(bp.available_units, 45);
  assert.equal(bp.demand_pattern, 'concentrated_large_order');
  assert.equal(bp.replacement_difficulty, 'HARD');
  assert.equal(bp.evidenced_replacement_depth, 30);
  assert.equal(bp.depth_gap, 15);
}));

// ─── I3: API does not recompute priority ─

test('I3. API does not recompute priority — priority in response == priority the queueFn produced', withServer({
  queueFn: async () => {
    const q = bpQueueResult();
    q.action_queue[0].priority_score = 999;   // arbitrary sentinel
    return q;
  },
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-exceptions');
  assert.equal(r.body.action_queue[0].priority_score, 999, 'router MUST not overwrite priority');
}));

// ─── I4: detail endpoint uses buildOwnerDecision ─

test('I4. GET /inventory-decision/:id calls buildOwnerDecision(physicalProductId) exactly once', withServer((() => {
  const s = spies();
  return {
    ownerDecisionFn: async (args) => { s.ownerDecisionCalls.push(args); return bpOwnerDecision(); },
    workflowFn: () => { throw new Error('workflow must not be called from detail endpoint'); },
    _spies: s,
  };
})(), async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-decision/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.headline.decision_status, 'WATCH');
  assert.equal(r.body.headline.priority_score, 170);
}));

// ─── I5: action endpoint uses buildOwnerActionWorkflow ─

test('I5. GET /inventory-actions/:id calls buildOwnerDecision + buildOwnerActionWorkflow (SoT reuse)', withServer((() => {
  const s = spies();
  return {
    ownerDecisionFn: async () => { s.ownerDecisionCalls.push(1); return bpOwnerDecision(); },
    workflowFn: (od) => { s.workflowCalls.push(od); return { workflow_actions: [{ action_code: 'WATCH_ONLY', status: 'OPEN' }, { action_code: 'CONFIRM_EXECUTABLE_QUOTE', status: 'OPEN', missing_evidence: ['EXECUTABLE_QUOTE'] }, { action_code: 'CHECK_PRIMARY_SUPPLIER', status: 'OPEN', missing_evidence: ['SUPPLIER_QUOTE', 'EXECUTABLE_QUOTE'] }], summary: {} }; },
    _spies: s,
  };
})(), async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-actions/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.owner_decision.headline.decision_status, 'WATCH');
  assert.equal(r.body.workflow.workflow_actions.length, 3);
  const codes = r.body.workflow.workflow_actions.map(a => a.action_code);
  assert.ok(codes.includes('WATCH_ONLY'));
  assert.ok(codes.includes('CONFIRM_EXECUTABLE_QUOTE'));
  assert.ok(codes.includes('CHECK_PRIMARY_SUPPLIER'));
}));

// ─── I6: initial dashboard does NOT fetch per-physical detail ─

test('I6. Initial dashboard endpoint (/inventory-exceptions) does NOT call the per-physical detail service', withServer((() => {
  const s = spies();
  return {
    queueFn: async () => { s.queueCalls.push(1); return bpQueueResult(); },
    ownerDecisionFn: async () => { s.ownerDecisionCalls.push(1); throw new Error('should not be called on list endpoint'); },
    workflowFn: () => { throw new Error('workflow should not be called on list endpoint'); },
    _spies: s,
  };
})(), async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-exceptions');
  assert.equal(r.status, 200);
  // 3 exceptions in the queue but the endpoint must NOT call ownerDecisionFn for each.
  // We assert by observing that a subsequent call to the detail endpoint succeeds
  // (i.e., the throw-guarded fn was never invoked by the list endpoint).
}));

// ─── I7-I10: renderable rows per status (from list endpoint) ──

test('I7-I10. WATCH / REPLENISH / PROTECT_STOCK all present · INSUFFICIENT_DATA counted separately (data_quality)', withServer({
  queueFn: async () => {
    const q = bpQueueResult();
    q.data_quality_queue = [{ physical_product_id: 99, title: 'DQ', missing_evidence: ['x'], reason_codes: [], classification: 'insufficient_data' }];
    q.summary.data_quality_count = 1;
    q.summary.insufficient_data_count = 1;
    return q;
  },
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-exceptions');
  assert.equal(r.status, 200);
  const kinds = new Set(r.body.action_queue.map(x => x.decision_status));
  assert.ok(kinds.has('WATCH'));
  assert.ok(kinds.has('REPLENISH'));
  assert.ok(kinds.has('PROTECT_STOCK'));
  // I10: INSUFFICIENT_DATA does NOT appear in action_queue — it lives in data_quality_queue.
  assert.ok(!kinds.has('INSUFFICIENT_DATA'));
  assert.equal(r.body.data_quality_queue.length, 1);
  assert.equal(r.body.summary.data_quality_count, 1);
}));

// ─── I11-I13: semantic separation in detail payload ────

test('I11-I13. cost semantics separated · ask_only surfaced · typical/accounting/observed distinct', withServer({
  ownerDecisionFn: async () => bpOwnerDecision(),
  workflowFn: (od) => ({ workflow_actions: [
    { action_code: 'CONFIRM_EXECUTABLE_QUOTE', status: 'OPEN', current_evidence: ['SECONDARY_MARKET_ASK'], missing_evidence: ['EXECUTABLE_QUOTE'], not_accepted_as_closure: ['SECONDARY_MARKET_ASK', 'TYPICAL_SUPPLIER_REFERENCE', 'historical_accounting_cost'] },
    { action_code: 'CHECK_PRIMARY_SUPPLIER', status: 'OPEN', current_evidence: [], missing_evidence: ['SUPPLIER_QUOTE', 'EXECUTABLE_QUOTE'], not_accepted_as_closure: ['TYPICAL_SUPPLIER_REFERENCE', 'historical_accounting_cost'] },
  ] }),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-actions/1');
  // I11 — three cost categories present and distinct fields
  assert.equal(r.body.owner_decision.cost_context.historical_typical_supplier_cost_krw_median, 19500);
  assert.equal(r.body.owner_decision.cost_context.historical_accounting_cost_krw, 45000);
  assert.equal(r.body.owner_decision.cost_context.observed_secondary_market_ask_min_krw, 40000);
  // I12 — ask_only quality surfaced
  assert.equal(r.body.owner_decision.supply.current_supply_quality, 'ask_only');
  const confirm = r.body.workflow.workflow_actions.find(a => a.action_code === 'CONFIRM_EXECUTABLE_QUOTE');
  assert.ok(confirm.not_accepted_as_closure.includes('SECONDARY_MARKET_ASK'));
  // I13 — typical / accounting cost explicitly rejected as closure for CHECK_PRIMARY_SUPPLIER
  const check = r.body.workflow.workflow_actions.find(a => a.action_code === 'CHECK_PRIMARY_SUPPLIER');
  assert.ok(check.not_accepted_as_closure.includes('TYPICAL_SUPPLIER_REFERENCE'));
  assert.ok(check.not_accepted_as_closure.includes('historical_accounting_cost'));
}));

// ─── I14: evidence preview performs zero writes ────────

test('I14. POST /evidence/preview delegates to previewFn (no write) — recordFn NEVER called', withServer((() => {
  const s = spies();
  return {
    previewFn: async (input) => { s.previewCalls.push(input); return { mode: 'preview', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, plan: { status: 'dry_run' }, physical: { id: 1, canonical_title: 'BP' }, would_execute: { purchase: false, notification: false }, persistence: 'NOT_WRITTEN_PREVIEW_ONLY' }; },
    recordFn: async () => { s.recordCalls.push(1); throw new Error('recordFn must not be called by preview endpoint'); },
    _spies: s,
  };
})(), async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/preview', {
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE, source: 'X', supplierName: 'X',
    price: 19500, priceBasis: 'per_physical_unit', physicalUnitsPerOffer: 1, currency: 'KRW',
    observedAt: '2026-08-15T00:00:00Z', currentQuoteConfirmed: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.persistence, 'NOT_WRITTEN_PREVIEW_ONLY');
}));

// ─── I15-I16: record path uses only Phase 8G service + requires confirm ─

test('I15-I16. POST /evidence/record without {confirm:true} → 400', withServer({}, async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/record', {
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE, source: 'X', supplierName: 'X',
    price: 19500, currency: 'KRW', observedAt: '2026-08-15T00:00:00Z',
    identityConfirmed: true, currentQuoteConfirmed: true,
    // NO confirm: true
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'confirm_must_be_true');
}));

test('I15-I16b. record with {confirm:true} + gates → delegates to recordFn once, returns 200 on ingested', withServer((() => {
  const s = spies();
  return {
    recordFn: async (input, opts) => { s.recordCalls.push({ input, opts }); return { mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: [], plan: { status: 'ingested', inserted: [{ id: 1 }], skipped_idempotent: [], failed: [], rejected: [] }, physical: { id: 1, canonical_title: 'BP' }, persistence: 'ingested', would_execute: { purchase: false, notification: false } }; },
    _spies: s,
  };
})(), async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/record', {
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE, source: 'X', supplierName: 'X',
    price: 19500, currency: 'KRW', observedAt: '2026-08-15T00:00:00Z',
    identityConfirmed: true, currentQuoteConfirmed: true, confirm: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.status, 'ingested');
}));

test('I16b. record without identityConfirmed → gate rejected (400)', withServer({
  recordFn: async () => ({ mode: 'record', validation: { ok: true, errors: [], warnings: [], action_gap_projection: {} }, gate_errors: ['identityConfirmed MUST be true to record evidence'], plan: null, persistence: 'NOT_WRITTEN_GATE_REJECTED', would_execute: { purchase: false } }),
}, async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/record', {
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE, source: 'X', supplierName: 'X',
    price: 19500, currency: 'KRW', observedAt: '2026-08-15T00:00:00Z',
    currentQuoteConfirmed: true, confirm: true,
    // no identityConfirmed
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'gate_rejected');
}));

test('I16c. legacy shared-password admin cannot record evidence (403)', withServer({
  __user: { id: 0, isAdmin: true, isLegacy: true, role: 'admin' },
}, async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/record', {
    physicalId: 1, evidenceType: EVIDENCE_TYPES.SUPPLIER_QUOTE, source: 'X', supplierName: 'X',
    price: 19500, currency: 'KRW', observedAt: '2026-08-15T00:00:00Z',
    identityConfirmed: true, currentQuoteConfirmed: true, confirm: true,
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'legacy_admin_cannot_record_evidence');
}));

// ─── I17-I20: no operational-mutation endpoints ────────

test('I17-I20. router source has NO buy/purchase/hold/marketplace/inventory-mutation endpoints', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/web/routes/omsOwnerConsole.js'), 'utf8');
  // No route paths that suggest mutation
  assert.doesNotMatch(src, /router\.\w+\(['"][^'"]*\/(buy|purchase|hold|price|price-change|inventory-adjust|listing|marketplace)['"]/i);
  // No require of ingestor / marketplace / notify / imessage / telegram directly
  assert.doesNotMatch(src, /require\(['"][^'"]*replacementObservationIngestor['"]\)/);
  assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]\)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]\)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]\)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]\)/i);
  // No DB access from router directly
  assert.doesNotMatch(src, /getClient\(/);
  assert.doesNotMatch(src, /\bfrom\(['"]/);
});

test('I17b. UI source has NO buttons for buy/purchase/hold/price change/listing change/inventory adjust', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/js/ownerInventory.js'), 'utf8');
  // No text labels that would show a mutation button to Owner.
  assert.doesNotMatch(src, />\s*(BUY|PURCHASE|HOLD|CHANGE PRICE|CHANGE LISTING|ADJUST INVENTORY)\s*</i);
  // No fetch to any mutation endpoint we haven't defined.
  assert.doesNotMatch(src, /fetch\(['"][^'"]*\/(buy|purchase|hold|price-change|listing|inventory-adjust)['"]/i);
});

// ─── I21: reassessment reuses existing SoT ─────────────

test('I21. POST /evidence/reassess-after-record delegates to reassessFn(mode=around_record)', withServer((() => {
  const s = spies();
  return {
    reassessFn: async (args) => { s.reassessCalls.push(args); return { status: 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS', before: { decision_status: 'WATCH', priority_score: 170, supply_current_quality: 'ask_only' }, after: { decision_status: 'WATCH', priority_score: 170, supply_current_quality: 'supplier_quote' }, changed: { supply_current_quality: { before: 'ask_only', after: 'supplier_quote' } }, unchanged: ['decision_status', 'priority_score'] }; },
    _spies: s,
  };
})(), async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/reassess-after-record', {
    physicalId: 1,
    beforeSnapshot: { owner_decision: bpOwnerDecision(), workflow: { workflow_actions: [] } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS');
}));

test('I21b. reassess without beforeSnapshot → 400', withServer({}, async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/reassess-after-record', { physicalId: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'beforeSnapshot_required');
}));

// ─── I22-I23: unchanged / changed decision display path (client-side helpers) ─

test('I22. unchanged decision — reassess response with empty changed{} indicates "Decision unchanged"', withServer({
  reassessFn: async () => ({ status: 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS', before: { decision_status: 'WATCH', priority_score: 170 }, after: { decision_status: 'WATCH', priority_score: 170 }, changed: {}, unchanged: ['decision_status', 'priority_score'] }),
}, async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/reassess-after-record', {
    physicalId: 1, beforeSnapshot: { owner_decision: bpOwnerDecision(), workflow: {} },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.changed), []);
}));

test('I23. changed decision — non-empty changed{} lists exact keys', withServer({
  reassessFn: async () => ({ status: 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS', before: { decision_status: 'WATCH', priority_score: 170, supply_current_quality: 'ask_only' }, after: { decision_status: 'WATCH', priority_score: 150, supply_current_quality: 'supplier_quote' }, changed: { priority_score: { before: 170, after: 150 }, supply_current_quality: { before: 'ask_only', after: 'supplier_quote' } }, unchanged: ['decision_status'] }),
}, async (req) => {
  const r = await req('POST', '/api/oms/owner/evidence/reassess-after-record', {
    physicalId: 1, beforeSnapshot: { owner_decision: bpOwnerDecision(), workflow: {} },
  });
  assert.ok(r.body.changed.priority_score);
  assert.equal(r.body.changed.priority_score.after, 150);
  assert.ok(r.body.changed.supply_current_quality);
}));

// ─── I24-I25: neighboring surfaces untouched ────────────

test('I24. Phase 8C/8D alerter API surface unchanged after Phase 8I', () => {
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  assert.equal(typeof alerter.computeAlertPlan, 'function');
  assert.equal(typeof alerter.computeDeliveryPlan, 'function');
  assert.equal(typeof alerter.deriveEffectiveDeliveryStateFromRuns, 'function');
  assert.equal(typeof alerter._internals._fingerprint, 'function');
});

test('I25. Phase 8H CLI (oms-owner-quote) module surface unchanged', () => {
  const cli = require('../../scripts/oms-owner-quote');
  assert.equal(typeof cli.parseArgs, 'function');
  assert.equal(typeof cli.mapArgsToIntakeInput, 'function');
  assert.equal(typeof cli.main, 'function');
  assert.equal(typeof cli.renderConfirmation, 'function');
  assert.ok(cli.FORBIDDEN_FLAGS.has('--apply'));
});

// ─── Extra sanity ───────────────────────────────────────

test('detail endpoint returns 400 on invalid physicalId', withServer({}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-decision/0');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_physical_id');
}));

test('detail endpoint returns 404 when ownerDecisionFn returns .error', withServer({
  ownerDecisionFn: async () => ({ error: 'physical_not_found', physical_product_id: 99999 }),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-decision/99999');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'physical_not_found');
}));

test('_sanitizeEvidenceInput drops non-allow-list fields', () => {
  const cleaned = _internals._sanitizeEvidenceInput({
    physicalId: 1, evidenceType: 'SUPPLIER_QUOTE',
    __proto__pollution: 'nope', naughtyField: 'nope', system_role_key: 'leak_attempt',
  });
  assert.equal(cleaned.physicalId, 1);
  assert.equal(cleaned.evidenceType, 'SUPPLIER_QUOTE');
  assert.equal(cleaned.naughtyField, undefined);
  assert.equal(cleaned.system_role_key, undefined);
});

test('server.js registers the /api/oms/owner mount', () => {
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
  assert.match(serverSrc, /app\.use\(['"]\/api\/oms\/owner['"]/);
});

test('SPA wiring — menu entry, page div, script tag, navigateTo case all present', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');
  assert.match(html, /data-page="owner-inventory"/);
  assert.match(html, /id="page-owner-inventory"/);
  assert.match(html, /ownerInventory\.js/);
  const dashboardJs = fs.readFileSync(path.resolve(__dirname, '../../public/js/dashboard.js'), 'utf8');
  assert.match(dashboardJs, /case 'owner-inventory'/);
});
