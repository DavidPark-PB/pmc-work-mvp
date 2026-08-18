'use strict';

/**
 * tests/oms/shadowValidation8P.test.js — Phase 8P.
 *
 * P27 · SOLD_VS_LISTING_PRICE_DIVERGENCE anomaly.
 * P28-P32 · zero mutation contract.
 * P33-P35 · BP invariant + regression.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runShadowValidation, ANOMALY_TYPE, SOLD_VS_LISTING_DIVERGENCE_PCT } = require('../../src/services/oms/shadowValidationService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function makeOwnerDecision(id) {
  return {
    physical_product_id: id,
    generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH, priority_score: 100, urgency_label: 'medium', confidence_level: 'low' },
    product: { title: `p${id}` },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
  };
}

//   Fake orchestrator that returns a controllable inputs_resolution
function fakeOrchestrator({ soldValue = null, listingValue = null, selected = 'AUTO_SOLD_MEDIAN' }) {
  return async (_args) => ({
    financial_metrics: { scenarios: { accounting: { gross_profit: { status: 'AVAILABLE', amount_krw: 29000 } } } },
    inputs_resolution: {
      sale_price: {
        resolution: selected,
        value: selected === 'AUTO_SOLD_MEDIAN' ? soldValue : listingValue,
        source: 'x', note: '',
        auto_observation: selected === 'AUTO_OBSERVED' && listingValue != null
          ? { status: 'OBSERVED_LISTING_PRICE', amount_krw: listingValue }
          : null,
        candidates_seen: [
          soldValue != null ? { type: 'RECENT_SOLD_PRICE_MEDIAN', status: 'RECENT_SOLD_PRICE_MEDIAN', value: soldValue } : { type: 'RECENT_SOLD_PRICE_MEDIAN', status: 'UNKNOWN' },
          listingValue != null ? { type: 'OBSERVED_LISTING_PRICE', status: 'OBSERVED_LISTING_PRICE', value: listingValue } : { type: 'OBSERVED_LISTING_PRICE', status: 'UNKNOWN' },
        ],
      },
      shipping: { resolution: 'AUTO_ESTIMATED', value: 13000, source: 's', note: '', auto_observation: null },
    },
  });
}

//   Bypass the real orchestrator/db by monkey-patching the orchestrator require.
const orchestratorMod = require('../../src/services/oms/financialMetricsOrchestrator');
const originalOrchestrator = orchestratorMod.buildFinancialMetricsWithAutoInputs;
function withFakeOrchestrator(fn, fakeImpl) {
  orchestratorMod.buildFinancialMetricsWithAutoInputs = fakeImpl;
  return fn().finally(() => { orchestratorMod.buildFinancialMetricsWithAutoInputs = originalOrchestrator; });
}

// ─── P27 · SOLD_VS_LISTING_PRICE_DIVERGENCE ─────────

test('P27a. Sold and listing candidates within threshold → no divergence anomaly', async () => {
  //   sold=100000 · listing=110000 · divergence 9.09% < 25% → no anomaly
  await withFakeOrchestrator(async () => {
    const r = await runShadowValidation({
      physicalProductIds: [1],
      ownerDecisionFn: async (id) => makeOwnerDecision(id),
      db: { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) },
    });
    const kinds = r.physicals[0].anomalies.map(a => a.kind);
    assert.ok(!kinds.includes('sold_vs_listing_price_divergence'));
  }, fakeOrchestrator({ soldValue: 100000, listingValue: 110000, selected: 'AUTO_SOLD_MEDIAN' }));
});

test('P27b. Sold and listing candidates diverge > 25% → POLICY_CANDIDATE anomaly', async () => {
  //   sold=100000 · listing=200000 · divergence 50% > 25% → flag
  await withFakeOrchestrator(async () => {
    const r = await runShadowValidation({
      physicalProductIds: [1],
      ownerDecisionFn: async (id) => makeOwnerDecision(id),
      db: { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) },
    });
    const anomaly = r.physicals[0].anomalies.find(a => a.kind === 'sold_vs_listing_price_divergence');
    assert.ok(anomaly, 'anomaly must fire');
    assert.equal(anomaly.type, ANOMALY_TYPE.POLICY_CANDIDATE);
    assert.equal(anomaly.detail.divergence_pct, 50);
    assert.match(anomaly.detail.note, /NEVER auto-corrects/);
  }, fakeOrchestrator({ soldValue: 100000, listingValue: 200000, selected: 'AUTO_SOLD_MEDIAN' }));
});

test('P27c. Only one candidate present → no divergence check (needs both)', async () => {
  await withFakeOrchestrator(async () => {
    const r = await runShadowValidation({
      physicalProductIds: [1],
      ownerDecisionFn: async (id) => makeOwnerDecision(id),
      db: { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) },
    });
    const kinds = r.physicals[0].anomalies.map(a => a.kind);
    assert.ok(!kinds.includes('sold_vs_listing_price_divergence'));
  }, fakeOrchestrator({ soldValue: 100000, listingValue: null, selected: 'AUTO_SOLD_MEDIAN' }));
});

test('P27d. Threshold constant exported for Owner audit', () => {
  assert.equal(SOLD_VS_LISTING_DIVERGENCE_PCT, 25);
});

// ─── P28-P32 · zero-mutation contract ─────────

test('P28-P32. Service sources have zero mutation paths (no marketplace/inventory/purchase/notification/schema)', () => {
  const fs = require('fs');
  const path = require('path');
  const files = [
    'src/services/oms/recentSoldPriceService.js',
    'src/services/oms/financialMetricsOrchestrator.js',
    'src/services/oms/shadowValidationService.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/, `${f} must not have DB write`);
    assert.doesNotMatch(src, /require\(['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i, `${f} must not require marketplace api`);
    assert.doesNotMatch(src, /require\(['"][^'"]*(?:notify|telegram|imessage)/i, `${f} must not require notification`);
    assert.doesNotMatch(src, /create table|alter table/i, `${f} must not contain DDL`);
  }
});

// ─── P35 · BP invariant (decision / priority / action unchanged) ─

test('P35. BP owner_decision headline shape is UNCHANGED — Phase 8P is additive only', () => {
  //   Static assertion: nothing in the 8P files touches inventoryOwnerDecisionService
  //   or inventoryDecisionEngine · they never mutate decision/priority/action fields.
  const fs = require('fs');
  const path = require('path');
  const files = [
    'src/services/oms/recentSoldPriceService.js',
    'src/services/oms/financialMetricsOrchestrator.js',
    'src/services/oms/shadowValidationService.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][^'"]*inventoryOwnerDecisionService/, `${f} must not modify owner decision`);
    assert.doesNotMatch(src, /require\(['"][^'"]*inventoryDecisionEngine/, `${f} must not modify decision engine`);
    assert.doesNotMatch(src, /priority_score\s*=/, `${f} must not reassign priority_score`);
    assert.doesNotMatch(src, /decision_status\s*=/, `${f} must not reassign decision_status`);
  }
});
