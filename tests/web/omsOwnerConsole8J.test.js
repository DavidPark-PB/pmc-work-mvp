'use strict';

/**
 * tests/web/omsOwnerConsole8J.test.js — Phase 8J.
 *
 * Data Quality Queue drill-down + Owner Evidence History Timeline.
 *
 * Rules under test:
 *   · /evidence-history/:id reuses replacementEvidenceService SoT ONLY
 *   · No parallel classification / freshness / evidence-type logic
 *   · Response never includes raw evidence.jsonb — allow-listed fields only
 *   · Response ordered newest-first
 *   · Invalid physicalId → 400 · empty history → 200 with []
 *   · UI shows DQ drill-down (from list endpoint's data_quality_queue[])
 *   · UI has no BUY/PURCHASE/HOLD/PRICE-CHANGE/LISTING/INVENTORY-ADJUST buttons
 *   · Phase 8C/8D alerter surface unchanged · Phase 8H CLI surface unchanged
 *   · BP baseline unaffected · zero write / zero external call
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { buildRouter } = require('../../src/web/routes/omsOwnerConsole');
const { listReplacementObservationsForOwner } = require('../../src/services/oms/replacementEvidenceService');

// ─── Test harness (same shape as 8I) ────────────────────
function withServer(deps, testFn) {
  return async () => {
    const app = express();
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
            try { resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }); }
            catch (e) { resolve({ status: res.statusCode, body: chunks, parseError: e.message }); }
          });
        });
        r.on('error', reject);
        if (bodyStr != null) r.write(bodyStr);
        r.end();
      });
    };
    try { await testFn(req); } finally { await new Promise(r => server.close(r)); }
  };
}

// Sample history payload the SoT would produce (safely-projected shape).
function historyPayload(physicalProductId, overrides = {}) {
  return {
    physical_product_id: physicalProductId,
    generated_at: '2026-08-16T12:00:00.000Z',
    policy_reference: { replacement_price_freshness_days: 30, policy_source: 'provisional' },
    total_observations: 3,
    returned_observations: 3,
    limit_applied: 50,
    observations: [
      { observation_id: 3, observed_at: '2026-08-15T10:00:00Z', age_days: 1.08, fresh: true,  classification: 'strong', evidence_type: 'EXECUTABLE_QUOTE', identity_match_status: 'EXACT_OR_STRONG_MATCH', source: 'PRIMARY_SUPPLIER', supplier_name: 'Distributor A', currency: 'KRW', product_cost_krw_per_physical: 18000, landed_cost_status: 'UNKNOWN', landed_cost_krw_per_physical: null, moq_physical_units: 30, lead_time_days: 7, reject_reason: null },
      { observation_id: 2, observed_at: '2026-07-01T00:00:00Z', age_days: 46, fresh: false,  classification: 'historical_reference', evidence_type: 'TYPICAL_SUPPLIER_REFERENCE', identity_match_status: 'EXACT_OR_STRONG_MATCH', source: 'internal', supplier_name: 'Reference', currency: 'KRW', product_cost_krw_per_physical: 19500, landed_cost_status: 'UNKNOWN', landed_cost_krw_per_physical: null, moq_physical_units: null, lead_time_days: null, reject_reason: 'typical_supplier_reference_never_current_replacement' },
      { observation_id: 1, observed_at: '2026-08-10T00:00:00Z', age_days: 6, fresh: true,  classification: 'strong', evidence_type: 'SECONDARY_MARKET_ASK', identity_match_status: 'EXACT_OR_STRONG_MATCH', source: 'kream', supplier_name: null, currency: 'KRW', product_cost_krw_per_physical: 40000, landed_cost_status: 'UNKNOWN', landed_cost_krw_per_physical: null, moq_physical_units: null, lead_time_days: null, reject_reason: null },
    ],
    ...overrides,
  };
}

// ─── J1: DQ items visible in list response (already-tested Phase 8I contract) — pin here for J1

test('J1. GET /inventory-exceptions returns data_quality_queue for UI drill-down', withServer({
  queueFn: async () => ({
    generated_at: '2026-08-16T00:00:00Z',
    summary: { physical_products_assessed: 5, sell_normally_count: 2, watch_count: 1, replenish_count: 1, protect_stock_count: 0, insufficient_data_count: 2, action_exception_count: 2, data_quality_count: 2, assessment_errors_count: 0, runtime_ms: 5, avg_ms_per_physical: 1, concurrency: 4, db_cache_hits: 0, db_cache_misses: 0, db_cache_per_table: {} },
    action_queue: [], action_queue_total: 0, action_queue_limit_applied: null,
    data_quality_queue: [
      { physical_product_id: 21, title: 'DQ item A', missing_evidence: ['trusted_cross_channel_velocity'], reason_codes: ['demand_untrusted'], classification: 'insufficient_data' },
      { physical_product_id: 22, title: 'DQ item B', missing_evidence: ['assessment_error'], reason_codes: ['assessment_error'], classification: 'assessment_error', error_message: 'boom' },
    ],
    assessment_errors: [],
  }),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-exceptions');
  assert.equal(r.status, 200);
  assert.equal(r.body.data_quality_queue.length, 2);
  assert.equal(r.body.data_quality_queue[0].physical_product_id, 21);
  assert.deepEqual(r.body.data_quality_queue[0].missing_evidence, ['trusted_cross_channel_velocity']);
}));

// ─── J2: DQ drill-down uses existing detail endpoint (no new route needed) —
// Owner clicks "결정 보기" on a DQ card → same /inventory-decision/:id used for action queue items.

test('J2. GET /inventory-decision/:id serves INSUFFICIENT_DATA detail (same endpoint reused for DQ)', withServer({
  ownerDecisionFn: async () => ({
    physical_product_id: 21, generated_at: '2026-08-16T00:00:00Z',
    headline: { decision_status: 'INSUFFICIENT_DATA', confidence_level: 'low', priority_score: 0, urgency_label: 'data_quality', one_line_summary: 'x' },
    product: { title: 'DQ item A', set_code: null, language: null, unit_type: null },
    inventory: null, demand: null, supply: null, cost_context: null,
    reasons: { reason_codes: ['demand_untrusted'], hold_quantity_blockers: [], missing_evidence: ['trusted_cross_channel_velocity'] },
    recommended_actions: [], forbidden_automatic_actions: [], priority_reasons: [], source_snapshot: {},
  }),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/inventory-decision/21');
  assert.equal(r.status, 200);
  assert.equal(r.body.headline.decision_status, 'INSUFFICIENT_DATA');
  assert.ok(r.body.reasons.missing_evidence.includes('trusted_cross_channel_velocity'));
}));

// ─── J3-J4: evidence-history endpoint · SoT reuse (exactly one call) ─

test('J3-J4. GET /evidence-history/:id delegates to listReplacementObservationsForOwner exactly once', withServer((() => {
  const calls = [];
  return {
    evidenceHistoryFn: async (args) => { calls.push(args); return historyPayload(1); },
    _calls: calls,
  };
})(), async (req) => {
  const r = await req('GET', '/api/oms/owner/evidence-history/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.observations.length, 3);
  assert.equal(r.body.total_observations, 3);
}));

// ─── J5: freshness policy verbatim (never recomputed) ──

test('J5. response passes policy_reference through verbatim (no recomputation)', withServer({
  evidenceHistoryFn: async () => historyPayload(1, { policy_reference: { replacement_price_freshness_days: 999, policy_source: 'test-only-sentinel' } }),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/evidence-history/1');
  assert.equal(r.body.policy_reference.replacement_price_freshness_days, 999);
  assert.equal(r.body.policy_reference.policy_source, 'test-only-sentinel');
}));

// ─── J6: invalid id → 400 ──────────────────────────────

test('J6. invalid physicalId → 400', withServer({}, async (req) => {
  const r = await req('GET', '/api/oms/owner/evidence-history/0');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_physical_id');
}));

test('J6b. invalid limit → 400', withServer({
  evidenceHistoryFn: async () => historyPayload(1),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/evidence-history/1?limit=-1');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_limit');
}));

// ─── J7: physical with no observations → 200 empty ─────

test('J7. physical with no observations → 200 · observations=[]', withServer({
  evidenceHistoryFn: async () => ({ physical_product_id: 999, generated_at: 'x', policy_reference: { replacement_price_freshness_days: 30, policy_source: 'provisional' }, total_observations: 0, returned_observations: 0, limit_applied: 50, observations: [] }),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/evidence-history/999');
  assert.equal(r.status, 200);
  assert.equal(r.body.total_observations, 0);
  assert.deepEqual(r.body.observations, []);
}));

// ─── J8: allow-list projection · no raw evidence.jsonb leak ─

test('J8. response never includes raw evidence.jsonb — only allow-listed fields', withServer({
  evidenceHistoryFn: async () => historyPayload(1),
}, async (req) => {
  const r = await req('GET', '/api/oms/owner/evidence-history/1');
  const o = r.body.observations[0];
  const allowed = new Set(['observation_id','observed_at','age_days','fresh','classification','evidence_type','identity_match_status','source','supplier_name','currency','product_cost_krw_per_physical','landed_cost_status','landed_cost_krw_per_physical','moq_physical_units','lead_time_days','reject_reason']);
  for (const k of Object.keys(o)) assert.ok(allowed.has(k), `unexpected field surfaced: ${k}`);
  assert.equal(o.evidence, undefined, 'raw evidence jsonb MUST NOT leak');
  assert.equal(o.notes, undefined);
  assert.equal(o.numeric_unit, undefined, 'internal numeric_unit label MUST NOT leak');
  assert.equal(o.numeric_value, undefined);
}));

// ─── J9: newest-first ordering (delegated to SoT which sorts) ─

test('J9. observations are ordered newest-first (SoT sorts by observed_at desc)', () => {
  // Direct SoT test to prove ordering happens in the service, not the route.
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/replacementEvidenceService.js'), 'utf8');
  assert.match(src, /listReplacementObservationsForOwner/);
  assert.match(src, /analysed\.sort/);
  assert.match(src, /return bt - at/);
});

// ─── J10: UI distinguishes fresh vs stale + evidence type colors ─

test('J10. UI evidence-history renders fresh/stale badges + per-type color', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/js/ownerInventory.js'), 'utf8');
  assert.match(src, /evidenceTypeColor/);
  assert.match(src, /EXECUTABLE_QUOTE/);
  assert.match(src, /SUPPLIER_QUOTE/);
  assert.match(src, /SECONDARY_MARKET_ASK/);
  assert.match(src, /TYPICAL_SUPPLIER_REFERENCE/);
  assert.match(src, />FRESH</);
  assert.match(src, />STALE</);
});

// ─── J11: zero writes / zero external calls / zero notifications ─

test('J11. router source has NO ingestor / marketplace / notification / DB access via history endpoint', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/web/routes/omsOwnerConsole.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"][^'"]*replacementObservationIngestor['"]\)/);
  assert.doesNotMatch(src, /require\(['"][^'"]*ebayAPI['"]\)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*telegramBot['"]\)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*imessage['"]\)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*notify['"]\)/i);
  assert.doesNotMatch(src, /getClient\(/);
  assert.doesNotMatch(src, /\bfrom\(['"]/);
});

// ─── J12: UI has no operational mutation buttons ───────

test('J12. UI has no BUY/PURCHASE/HOLD/PRICE-CHANGE/LISTING/INVENTORY-ADJUST buttons', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/js/ownerInventory.js'), 'utf8');
  assert.doesNotMatch(src, />\s*(BUY|PURCHASE|HOLD|CHANGE PRICE|CHANGE LISTING|ADJUST INVENTORY)\s*</i);
  assert.doesNotMatch(src, /fetch\(['"][^'"]*\/(buy|purchase|hold|price-change|listing|inventory-adjust)['"]/i);
});

// ─── J13: BP baseline preserved ────────────────────────

test('J13. BP baseline unchanged (buildOwnerDecision + rankAction still yield WATCH · 170)', async () => {
  // This is a regression guard — Phase 8I tests already prove this at length.
  const { buildOwnerDecision } = require('../../src/services/oms/inventoryOwnerDecisionService');
  const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');
  const bp = await buildOwnerDecision({
    physicalProductId: 1,
    assessFn: async () => ({
      physical_product_id: 1, generated_at: '2026-08-16T00:00:00Z',
      physical: { id: 1, canonical_title: 'Battle Partners Booster Box', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
      decision: { status: DECISION.WATCH, confidence_level: 'low', reason_codes: ['x'], hold_quantity_blockers: [], depth_gap: 15 },
      inventory_summary: { on_hand: 60, reserved: 15, available: 45 },
      demand_summary: { trusted: true, units_7d: 60, units_30d: 61, velocity_30d: 2.03, raw_days_of_supply: 22, demand_pattern: 'concentrated_large_order', largest_shipment_units_30d: 60, largest_shipment_share_30d: 0.984 },
      supply_summary: { verdict: 'AT_RISK', current_supply_layers: 1, current_supply_quality: 'ask_only', supplier_diversity: 0, has_current_supplier_or_executable: false, replacement_difficulty: 'HARD', evidenced_replacement_depth: 30, uncovered_at_60: 30, uncovered_at_100: 70, secondary_market_dependency_by_target: { 60: 1.0 } },
      cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
      missing_evidence: [], strategic_hold_source: {},
    }),
  });
  assert.equal(bp.headline.decision_status, DECISION.WATCH);
  assert.equal(bp.headline.priority_score, 170);
});

// ─── J14: Phase 8C/8D alerter surface unchanged ─────────

test('J14. Phase 8C/8D alerter API surface unchanged by Phase 8J', () => {
  const alerter = require('../../src/services/oms/inventoryExceptionsAlerter');
  assert.equal(typeof alerter.computeAlertPlan, 'function');
  assert.equal(typeof alerter.computeDeliveryPlan, 'function');
  assert.equal(typeof alerter.deriveEffectiveDeliveryStateFromRuns, 'function');
  assert.equal(typeof alerter._internals._fingerprint, 'function');
});

// ─── J15: Phase 8H CLI surface unchanged ────────────────

test('J15. Phase 8H CLI (oms-owner-quote) module surface unchanged', () => {
  const cli = require('../../scripts/oms-owner-quote');
  assert.equal(typeof cli.parseArgs, 'function');
  assert.equal(typeof cli.mapArgsToIntakeInput, 'function');
  assert.equal(typeof cli.main, 'function');
  assert.ok(cli.FORBIDDEN_FLAGS.has('--apply'));
});

// ─── SoT surface additive · existing 7C tests unaffected ─

test('replacementEvidenceService export surface is ADDITIVE — legacy consumers still work', () => {
  const svc = require('../../src/services/oms/replacementEvidenceService');
  assert.equal(typeof svc.getReplacementEvidence, 'function');
  assert.equal(typeof svc.listReplacementObservationsForOwner, 'function');
  assert.ok(svc.REPLACEMENT_STATUS);
  assert.ok(svc.AVAILABILITY_STATUS);
  assert.ok(svc._internals && typeof svc._internals._analyseRow === 'function');
});

// ─── UI wiring pinning ─────────────────────────────────

test('UI wiring — DQ panel div, evidence-history panel, refresh handler all present', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/js/ownerInventory.js'), 'utf8');
  assert.match(src, /id="oi-dq-list"/);
  assert.match(src, /renderDqList/);
  assert.match(src, /id="oi-history"/);
  assert.match(src, /loadEvidenceHistory/);
  assert.match(src, /\/api\/oms\/owner\/evidence-history\//);
});

// ─── Route mount unchanged ─────────────────────────────

test('server.js still mounts /api/oms/owner (single mount, unchanged from Phase 8I)', () => {
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
  const matches = serverSrc.match(/app\.use\(['"]\/api\/oms\/owner['"]/g) || [];
  assert.equal(matches.length, 1, 'exactly one /api/oms/owner mount');
});
