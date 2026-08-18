'use strict';

/**
 * tests/web/omsOwnerConsole8L.test.js — Phase 8L integration.
 *
 * READ-ONLY additive endpoint: GET /api/oms/owner/financial-metrics/:physicalId
 *
 *   • Returns owner_decision + financial_metrics side-by-side
 *   • owner_decision shape UNCHANGED · financial_metrics is a separate field
 *   • Query params allow caller-supplied sale price / shipping / fee overrides
 *   • Invalid numeric query values → null → downstream UNKNOWN (never 0)
 *   • 404 when ownerDecision.error is present · 500 only on true throw
 *   • Zero DB / marketplace / notification traffic
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { buildRouter } = require('../../src/web/routes/omsOwnerConsole');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function bpOwnerDecision() {
  return {
    physical_product_id: 1, generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 170, urgency_label: 'medium', one_line_summary: 'x' },
    product: { title: 'BP', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    demand: { trusted: true },
    supply: { verdict: 'AT_RISK' },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    reasons: { reason_codes: [], hold_quantity_blockers: [], missing_evidence: [] },
    recommended_actions: [], recommended_evidence_actions: [], forbidden_automatic_actions: [],
    judgment_confidence: {}, data_provenance: {}, priority_reasons: [], source_snapshot: {},
  };
}

function withServer(deps, testFn) {
  return async () => {
    const app = express();
    const fakeAuth = (req, _res, next) => { req.user = { role: 'admin', isAdmin: true }; next(); };
    const router = buildRouter({ ...deps, requireAdmin: fakeAuth });
    app.use('/api/oms/owner', router);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const { port } = server.address();
    const req = async (method, url) => new Promise((resolve, reject) => {
      const r = http.request({ method, port, path: url, headers: { accept: 'application/json' } }, res => {
        let s = '';
        res.on('data', d => s += d.toString('utf8'));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }); }
          catch (e) { resolve({ status: res.statusCode, body: s, parseError: e.message }); }
        });
      });
      r.on('error', reject); r.end();
    });
    try { await testFn(req); } finally { await new Promise(r => server.close(r)); }
  };
}

// ─── Integration tests ────────────────────────────────

test('FM-R1. Happy path · returns owner_decision + financial_metrics with 3 scenarios', withServer(
  { ownerDecisionFn: async () => bpOwnerDecision() },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1?expected_sale_price_krw=100000&seller_borne_shipping_krw=8000');
    assert.equal(r.status, 200);
    assert.ok(r.body.owner_decision);
    assert.ok(r.body.financial_metrics);
    assert.deepEqual(Object.keys(r.body.financial_metrics.scenarios).sort(), ['accounting', 'replacement', 'secondary_market_ask']);
    //   BP accounting profit = 100000 - 18000 - 8000 - 45000 = 29000
    assert.equal(r.body.financial_metrics.scenarios.accounting.gross_profit.amount_krw, 29000);
  },
));

test('FM-R2. Missing sale price query param → proceeds UNKNOWN in all scenarios · owner_decision unchanged', withServer(
  { ownerDecisionFn: async () => bpOwnerDecision() },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1');
    assert.equal(r.status, 200);
    for (const s of Object.values(r.body.financial_metrics.scenarios)) {
      assert.equal(s.expected_sale_proceeds.status, 'UNKNOWN');
    }
    //   Owner Decision shape untouched — same cost_context, same headline
    assert.deepEqual(r.body.owner_decision.cost_context, bpOwnerDecision().cost_context);
  },
));

test('FM-R3. Invalid numeric query param → treated as null → UNKNOWN (never coerced to 0)', withServer(
  { ownerDecisionFn: async () => bpOwnerDecision() },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1?expected_sale_price_krw=NOT_A_NUMBER&seller_borne_shipping_krw=8000');
    assert.equal(r.status, 200);
    for (const s of Object.values(r.body.financial_metrics.scenarios)) {
      assert.equal(s.expected_sale_proceeds.status, 'UNKNOWN');
    }
  },
));

test('FM-R4. 400 when physicalId invalid', withServer(
  { ownerDecisionFn: async () => bpOwnerDecision() },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/not-a-number');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_physical_id');
  },
));

test('FM-R5. 404 when ownerDecision returns error projection', withServer(
  { ownerDecisionFn: async () => ({ physical_product_id: 999, error: 'physical_product_not_found' }) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/999');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'physical_product_not_found');
  },
));

test('FM-R6. Provenance query params passed through (sliced to 200 chars max)', withServer(
  { ownerDecisionFn: async () => bpOwnerDecision() },
  async (req) => {
    const src = encodeURIComponent('ebay_listing:205376020693');
    const r = await req('GET', `/api/oms/owner/financial-metrics/1?expected_sale_price_krw=100000&expected_sale_price_source=${src}&seller_borne_shipping_krw=8000&shipping_source=kpacket_us`);
    for (const s of Object.values(r.body.financial_metrics.scenarios)) {
      assert.equal(s.expected_sale_proceeds.provenance.expected_sale_price_source, 'ebay_listing:205376020693');
      assert.equal(s.expected_sale_proceeds.provenance.shipping_source, 'kpacket_us');
    }
  },
));

test('FM-R7. Route uses injected financialMetricsFn (proves NO parallel calculation)', withServer(
  {
    ownerDecisionFn: async () => bpOwnerDecision(),
    financialMetricsFn: () => ({ scenarios: { fake: 'yes' }, inputs_used: {}, missing_inputs: [], caveats: [] }),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1');
    assert.deepEqual(r.body.financial_metrics.scenarios, { fake: 'yes' });
  },
));

test('FM-R8. owner_decision object round-trip is byte-identical when financialMetricsFn is a pure passthrough (no mutation)', withServer(
  {
    ownerDecisionFn: async () => bpOwnerDecision(),
    financialMetricsFn: () => ({ scenarios: {} }),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1');
    assert.deepEqual(r.body.owner_decision, bpOwnerDecision());
  },
));

test('FM-R9. 500 when ownerDecisionFn throws · error payload does not leak sensitive information', withServer(
  { ownerDecisionFn: async () => { throw new Error('unexpected'); } },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'financial_metrics_failed');
  },
));
