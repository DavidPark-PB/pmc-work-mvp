'use strict';

/**
 * tests/web/omsOwnerConsole8O.test.js — Phase 8O.
 *
 * Route auto-mode integration:
 *   GET /financial-metrics/:id?auto=1&usdKrw=1350&lengthCm=...
 *   GET /compare?ids=...&auto=1&usdKrw=1350&lengthCm=...
 *
 * Verifies:
 *   • auto=1 flag switches to orchestrator path
 *   • orchestrator receives injected db + manual/auto opts
 *   • mode field surfaced in response
 *   • inputs_resolution audit trail present in auto mode
 *   • manual overrides still take priority (Owner rule §5.1)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { buildRouter } = require('../../src/web/routes/omsOwnerConsole');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function fakeOwnerDecision(id) {
  return {
    physical_product_id: id, generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 100, urgency_label: 'medium' },
    product: { title: `p${id}` },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    reasons: { reason_codes: [], hold_quantity_blockers: [], missing_evidence: [] },
    judgment_confidence: { overall_tier: 'LOW', by_dimension: {} },
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

// ─── Financial metrics auto-mode ─────────────────────

test('FMO1. auto=1 uses orchestrator path · mode=auto · inputs_resolution surfaced', withServer(
  {
    ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId),
    orchestratorFn: async ({ ownerDecision, manual }) => ({
      financial_metrics: { scenarios: { accounting: { gross_profit: { status: 'AVAILABLE', amount_krw: 29000 } } } },
      inputs_resolution: {
        sale_price: { resolution: 'AUTO_OBSERVED', value: 101250, source: 'ebay_listing:e_1', auto_observation: {}, note: 'OBSERVED_LISTING_PRICE' },
        shipping:   { resolution: 'AUTO_ESTIMATED', value: 13000, source: 'shippingRateEngine.v1:yun', auto_observation: {}, note: 'ESTIMATED' },
      },
    }),
    dbFn: () => ({ from: () => ({ select: () => ({}) }) }),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1?auto=1&usdKrw=1350&lengthCm=20&widthCm=15&heightCm=5');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'auto');
    assert.ok(r.body.inputs_resolution);
    assert.equal(r.body.inputs_resolution.sale_price.resolution, 'AUTO_OBSERVED');
  },
));

test('FMO2. Without auto=1 · default manual path · no inputs_resolution', withServer(
  { ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'manual');
    assert.equal(r.body.inputs_resolution, undefined);
  },
));

test('FMO3. auto=1 + manual sale price → orchestrator sees manual override in opts', withServer(
  {
    ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId),
    orchestratorFn: async ({ manual }) => ({
      financial_metrics: { scenarios: {} },
      inputs_resolution: {
        sale_price: { resolution: manual.expected_sale_price_krw ? 'MANUAL' : 'UNKNOWN', value: manual.expected_sale_price_krw ?? null, source: 'x', auto_observation: null, note: '' },
        shipping: { resolution: 'UNKNOWN', value: null, source: null, auto_observation: null, note: '' },
      },
    }),
    dbFn: () => ({}),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1?auto=1&expected_sale_price_krw=200000');
    assert.equal(r.body.inputs_resolution.sale_price.resolution, 'MANUAL');
    assert.equal(r.body.inputs_resolution.sale_price.value, 200000);
  },
));

// ─── Compare auto-mode ─────────────────────────────

test('FMO4. /compare?auto=1 runs orchestrator per-row · mode=auto', withServer(
  {
    ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId),
    orchestratorFn: async () => ({
      financial_metrics: { scenarios: { accounting: { cost_basis_source: 'sku_master_cost_krw', gross_profit: { status: 'AVAILABLE', amount_krw: 29000 } } } },
      inputs_resolution: { sale_price: { resolution: 'AUTO_OBSERVED' }, shipping: { resolution: 'AUTO_ESTIMATED' } },
    }),
    dbFn: () => ({}),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=1,2&auto=1&usdKrw=1350&lengthCm=20&widthCm=15&heightCm=5');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'auto');
    assert.equal(r.body.comparison.rows.length, 2);
  },
));

test('FMO5. /compare default (no auto) uses manual assembler path · mode=manual', withServer(
  { ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=1,2');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'manual');
  },
));

test('FMO6. FX not supplied in auto mode → orchestrator returns UNKNOWN · route still 200 · no crash', withServer(
  {
    ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId),
    orchestratorFn: async () => ({
      financial_metrics: { scenarios: { accounting: { gross_profit: { status: 'UNKNOWN', amount_krw: null } } } },
      inputs_resolution: { sale_price: { resolution: 'UNKNOWN' }, shipping: { resolution: 'UNKNOWN' } },
    }),
    dbFn: () => ({}),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/financial-metrics/1?auto=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.inputs_resolution.sale_price.resolution, 'UNKNOWN');
  },
));
