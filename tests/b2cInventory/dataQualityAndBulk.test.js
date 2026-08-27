'use strict';
/**
 * dataQualityAndBulk.test.js — Phase 5 · DATA_QUALITY planner + bulk eligibility + purchase signals.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const dq = require('../../src/services/b2cInventory/dataQualityTasks');
const elig = require('../../src/services/b2cInventory/eligibilityBulk');
const ps = require('../../src/services/b2cInventory/purchaseSignals');

const NOW = '2026-08-25T00:00:00.000Z';

//   ── DATA_QUALITY planner ──────────────────────────
test('DQ planner · cost 있음 → 제외', () => {
  const r = dq.planDataQualityCostMissing({
    scorecards: [
      { sku_master_id: 1, internal_sku: 'a', unit_cost: 1000, stock_qty: 5, ebay_sales_90d: 5, shopify_sales_90d: 0 },
    ],
    existingActiveSkuIds: new Set(), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.equal(r.plan.length, 0);
  assert.equal(r.filtered.excluded_has_cost, 1);
});
test('DQ planner · stock 0 → 제외', () => {
  const r = dq.planDataQualityCostMissing({
    scorecards: [
      { sku_master_id: 1, internal_sku: 'a', unit_cost: null, stock_qty: 0, ebay_sales_90d: 5, shopify_sales_90d: 0 },
    ],
    existingActiveSkuIds: new Set(), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.equal(r.plan.length, 0);
  assert.equal(r.filtered.excluded_zero_stock, 1);
});
test('DQ planner · sales < threshold → 제외', () => {
  const r = dq.planDataQualityCostMissing({
    scorecards: [
      { sku_master_id: 1, internal_sku: 'a', unit_cost: null, stock_qty: 5, ebay_sales_90d: 2, shopify_sales_90d: 0 },
    ],
    existingActiveSkuIds: new Set(), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.equal(r.plan.length, 0);
  assert.equal(r.filtered.excluded_low_sales, 1);
});
test('DQ planner · 조건 충족 → task row 생성 · channel=NULL · exception_type 정확', () => {
  const r = dq.planDataQualityCostMissing({
    scorecards: [
      { sku_master_id: 42, internal_sku: 'PMC-42', title: 'x', unit_cost: null, stock_qty: 5, ebay_sales_90d: 10, shopify_sales_90d: 5 },
    ],
    existingActiveSkuIds: new Set(), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.equal(r.plan.length, 1);
  const t = r.plan[0];
  assert.equal(t.exception_type, 'data_quality.cost_missing');
  assert.equal(t.channel, null);
  assert.equal(t.related_sku_id, 42);
  assert.equal(t.dedupe_key, 'b2c_dq_cost:42');
  assert.equal(t.context.sales_90d, 15);
  assert.equal(t.context.completion_gate, 'cost_krw IS NOT NULL');
});
test('DQ planner · existing active SKU 제외', () => {
  const r = dq.planDataQualityCostMissing({
    scorecards: [
      { sku_master_id: 1, internal_sku: 'a', unit_cost: null, stock_qty: 5, ebay_sales_90d: 5, shopify_sales_90d: 0 },
    ],
    existingActiveSkuIds: new Set([1]), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.equal(r.plan.length, 0);
  assert.equal(r.filtered.excluded_duplicate, 1);
});
test('DQ planner · max_per 초과 방지', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    sku_master_id: i + 1, internal_sku: 's' + i, unit_cost: null,
    stock_qty: 5, ebay_sales_90d: 5, shopify_sales_90d: 0,
  }));
  const r = dq.planDataQualityCostMissing({
    scorecards: many, existingActiveSkuIds: new Set(), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.equal(r.plan.length, 150);
  assert.equal(r.filtered.beyond_slot_limit, 50);
});
test('DQ planner · sales DESC 정렬', () => {
  const r = dq.planDataQualityCostMissing({
    scorecards: [
      { sku_master_id: 1, internal_sku: 'lo', unit_cost: null, stock_qty: 5, ebay_sales_90d: 3, shopify_sales_90d: 0 },
      { sku_master_id: 2, internal_sku: 'hi', unit_cost: null, stock_qty: 5, ebay_sales_90d: 15, shopify_sales_90d: 0 },
      { sku_master_id: 3, internal_sku: 'md', unit_cost: null, stock_qty: 5, ebay_sales_90d: 5, shopify_sales_90d: 5 },
    ],
    existingActiveSkuIds: new Set(), threshold: 3, maxPer: 150, nowISO: NOW,
  });
  assert.deepEqual(r.plan.map(p => p.related_sku_id), [2, 3, 1]);
});

//   ── Bulk eligibility · computeNewEligibility ────
test('eligibility action · korea_all → 한국 4채널', () => {
  const v = elig.computeNewEligibility({ type: 'korea_all' });
  assert.deepEqual(v.sort(), ['11st','coupang','gmarket','naver']);
});
test('eligibility action · clear → []', () => {
  assert.deepEqual(elig.computeNewEligibility({ type: 'clear' }), []);
});
test('eligibility action · unspecified → null', () => {
  assert.equal(elig.computeNewEligibility({ type: 'unspecified' }), null);
});
test('eligibility action · set_channels · normalize + dedup', () => {
  assert.deepEqual(elig.computeNewEligibility({ type: 'set_channels', channels: ['Coupang','NAVER','coupang'] }),
    ['coupang','naver']);
});
test('eligibility action · set_channels · unknown → throw', () => {
  assert.throws(() => elig.computeNewEligibility({ type: 'set_channels', channels: ['lazada'] }), /알 수 없는 채널/);
});
test('eligibility action · 잘못된 type → throw', () => {
  assert.throws(() => elig.computeNewEligibility({ type: 'wtf' }), /알 수 없는 action/);
});

//   ── Bulk eligibility · filterCandidates ────
function scRow(o = {}) {
  return Object.assign({
    sku_master_id: 1, internal_sku: 's', title: 't',
    unit_cost: 1000, stock_qty: 5, inventory_value_krw: 100000,
    ebay_sales_90d: 3, shopify_sales_90d: 0, channel_eligibility: null,
  }, o);
}
test('filterCandidates · has_sales=true · sales 없는 SKU 제외', () => {
  const sc = [scRow({ ebay_sales_90d: 0, shopify_sales_90d: 0 }), scRow({ sku_master_id: 2, ebay_sales_90d: 5 })];
  const r = elig.filterCandidates({ scorecards: sc, channelStatusMap: new Map(), evaluationsBySku: new Map(), filters: { has_sales: true } });
  assert.equal(r.length, 1);
  assert.equal(r[0].sku_master_id, 2);
});
test('filterCandidates · cost_present=true · cost NULL 제외', () => {
  const sc = [scRow({ unit_cost: null }), scRow({ sku_master_id: 2, unit_cost: 1000 })];
  const r = elig.filterCandidates({ scorecards: sc, channelStatusMap: new Map(), evaluationsBySku: new Map(), filters: { cost_present: true } });
  assert.equal(r.length, 1);
  assert.equal(r[0].sku_master_id, 2);
});
test('filterCandidates · stock_gt=0 · stock=0 제외', () => {
  const sc = [scRow({ stock_qty: 0 }), scRow({ sku_master_id: 2, stock_qty: 3 })];
  const r = elig.filterCandidates({ scorecards: sc, channelStatusMap: new Map(), evaluationsBySku: new Map(), filters: { stock_gt: 0 } });
  assert.equal(r.length, 1);
  assert.equal(r[0].sku_master_id, 2);
});
test('filterCandidates · minimum_inventory_value 통과', () => {
  const sc = [scRow({ inventory_value_krw: 10000 }), scRow({ sku_master_id: 2, inventory_value_krw: 600000 })];
  const r = elig.filterCandidates({ scorecards: sc, channelStatusMap: new Map(), evaluationsBySku: new Map(), filters: { minimum_inventory_value: 500000 } });
  assert.deepEqual(r.map(x => x.sku_master_id), [2]);
});
test('filterCandidates · sku_ids explicit', () => {
  const sc = [scRow({ sku_master_id: 1 }), scRow({ sku_master_id: 2 }), scRow({ sku_master_id: 3 })];
  const r = elig.filterCandidates({ scorecards: sc, channelStatusMap: new Map(), evaluationsBySku: new Map(), filters: { sku_ids: [1, 3] } });
  assert.deepEqual(r.map(x => x.sku_master_id).sort(), [1, 3]);
});

//   ── estimateTaskCounts ────────────────────────────
test('estimateTaskCounts · korea_all → 4채널 · NONE/ERROR 만 카운트', () => {
  const chMap = new Map([[1, { coupang: 'LIVE', naver: 'NONE', '11st': 'NONE', gmarket: 'ERROR' }]]);
  const est = elig.estimateTaskCounts({
    selectedSkus: [{ sku_master_id: 1 }],
    newEligibility: ['coupang','naver','11st','gmarket'],
    channelStatusMap: chMap,
  });
  //   coupang LIVE 제외 · naver+11st+gmarket 3개
  assert.equal(est.total, 3);
  assert.equal(est.perChannel.coupang, 0);
  assert.equal(est.perChannel.naver, 1);
  assert.equal(est.perChannel['11st'], 1);
  assert.equal(est.perChannel.gmarket, 1);
});
test('estimateTaskCounts · unspecified (null) → 0', () => {
  const est = elig.estimateTaskCounts({
    selectedSkus: [{ sku_master_id: 1 }],
    newEligibility: null,
    channelStatusMap: new Map(),
  });
  assert.equal(est.total, 0);
});

//   ── Purchase signals ──────────────────────────────
test('purchase signal · stock=0 + sales 5 → OUT_OF_STOCK_WITH_SALES', () => {
  const sig = ps.detectPurchaseSignals({ stock_qty: 0, ebay_sales_90d: 5, shopify_sales_90d: 0 }, 3);
  assert.equal(sig.length, 1);
  assert.equal(sig[0].signal, 'OUT_OF_STOCK_WITH_SALES');
  assert.equal(sig[0].severity, 'medium');
});
test('purchase signal · stock=0 + sales 15 → severity=high', () => {
  const sig = ps.detectPurchaseSignals({ stock_qty: 0, ebay_sales_90d: 15, shopify_sales_90d: 0 }, 3);
  assert.equal(sig[0].severity, 'high');
});
test('purchase signal · stock>0 → 신호 없음', () => {
  const sig = ps.detectPurchaseSignals({ stock_qty: 5, ebay_sales_90d: 10, shopify_sales_90d: 0 }, 3);
  assert.equal(sig.length, 0);
});
test('purchase signal · sales < threshold → 신호 없음', () => {
  const sig = ps.detectPurchaseSignals({ stock_qty: 0, ebay_sales_90d: 2, shopify_sales_90d: 0 }, 3);
  assert.equal(sig.length, 0);
});
