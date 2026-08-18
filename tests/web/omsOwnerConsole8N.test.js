'use strict';

/**
 * tests/web/omsOwnerConsole8N.test.js — Phase 8N.
 *
 * GET /api/oms/owner/compare?ids=1,2,3&expected_sale_price_krw=...
 *   • Row per id · preserves order
 *   • Error projections carry through as row.ownerDecision.error (no crash)
 *   • Max 25 ids · 400 on too many
 *   • Invalid comma-separated ids filtered
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
    headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 100 + id, urgency_label: 'medium' },
    product: { title: `p${id}`, set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    demand: {}, supply: {},
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    reasons: { reason_codes: [], hold_quantity_blockers: [], missing_evidence: [] },
    judgment_confidence: { overall_tier: 'LOW', by_dimension: {} },
    data_provenance: {},
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

test('CMP-R1. Happy path · 3 ids · 3 rows in order', withServer(
  { ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=3,1,2&expected_sale_price_krw=100000&seller_borne_shipping_krw=8000');
    assert.equal(r.status, 200);
    assert.equal(r.body.comparison.rows.length, 3);
    assert.deepEqual(r.body.comparison.rows.map(r => r.physical_product_id), [3, 1, 2]);
    //   Financial metrics applied uniformly
    for (const row of r.body.comparison.rows) {
      assert.equal(row.financial.accounting.gross_profit.status, 'AVAILABLE');
      assert.equal(row.financial.accounting.gross_profit.amount_krw, 29000);
    }
  },
));

test('CMP-R2. Ids missing → 400', withServer(
  { ownerDecisionFn: async () => fakeOwnerDecision(1) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ids_required');
  },
));

test('CMP-R3. All-invalid ids → 400', withServer(
  { ownerDecisionFn: async () => fakeOwnerDecision(1) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=abc,,-1');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_ids');
  },
));

test('CMP-R4. Too many ids → 400', withServer(
  { ownerDecisionFn: async () => fakeOwnerDecision(1) },
  async (req) => {
    const many = Array.from({ length: 26 }, (_, i) => i + 1).join(',');
    const r = await req('GET', `/api/oms/owner/compare?ids=${many}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'too_many_ids');
  },
));

test('CMP-R5. Mixed valid/invalid ids · valid ones processed · comma-noise filtered', withServer(
  { ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=1,abc,2,,-5,3');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.comparison.rows.map(x => x.physical_product_id), [1, 2, 3]);
  },
));

test('CMP-R6. One id returns error projection · other rows still populated · no crash · error surfaced explicitly', withServer(
  {
    ownerDecisionFn: async ({ physicalProductId }) => (
      physicalProductId === 2
        ? { physical_product_id: 2, error: 'physical_product_not_found' }
        : fakeOwnerDecision(physicalProductId)
    ),
  },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=1,2,3');
    assert.equal(r.status, 200);
    //   All 3 rows surface · error rows carry through so Owner sees the gap
    assert.equal(r.body.comparison.rows.length, 3);
    assert.deepEqual(r.body.comparison.rows.map(x => x.physical_product_id), [1, 2, 3]);
    //   Row for id 2 has decision=null (error projection stub · no headline)
    //   which distinguishes it visually from valid rows.
    assert.equal(r.body.comparison.rows[1].decision, null);
  },
));

test('CMP-R7. financial_opts_applied echoes back caller inputs · audit trail', withServer(
  { ownerDecisionFn: async ({ physicalProductId }) => fakeOwnerDecision(physicalProductId) },
  async (req) => {
    const r = await req('GET', '/api/oms/owner/compare?ids=1&expected_sale_price_krw=100000&seller_borne_shipping_krw=8000&expected_sale_price_source=ebay_listing_x');
    assert.equal(r.body.financial_opts_applied.expected_sale_price_krw, 100000);
    assert.equal(r.body.financial_opts_applied.seller_borne_shipping_krw, 8000);
    assert.equal(r.body.financial_opts_applied.expected_sale_price_source, 'ebay_listing_x');
  },
));
