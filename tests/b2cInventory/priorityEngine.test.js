'use strict';
/**
 * priorityEngine.test.js — Phase 4 · pure Priority Engine tests.
 * Framework: node:test.
 * Run: node --test tests/b2cInventory/priorityEngine.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../../src/services/b2cInventory/priorityEngine');

const CONFIG = {
  old_stock_days: 60,
  very_old_stock_days: 90,
  high_value_threshold_krw: 500000,
  sales_validation_days: 90,
};

//   ── resolveEligibility ──────────────────────────────────
test('resolveEligibility · NULL + NONE default → false', () => {
  assert.equal(e.resolveEligibility(null, 'coupang', 0), false);
});
test('resolveEligibility · NULL + KOREA_ALL default → 한국 4채널만 true', () => {
  assert.equal(e.resolveEligibility(null, 'coupang', 1), true);
  assert.equal(e.resolveEligibility(null, 'naver',   1), true);
  assert.equal(e.resolveEligibility(null, '11st',    1), true);
  assert.equal(e.resolveEligibility(null, 'gmarket', 1), true);
  assert.equal(e.resolveEligibility(null, 'ebay',    1), false);
  assert.equal(e.resolveEligibility(null, 'shopify', 1), false);
});
test('resolveEligibility · explicit array 정확히 반영', () => {
  assert.equal(e.resolveEligibility(['coupang','naver'], 'coupang', 0), true);
  assert.equal(e.resolveEligibility(['coupang','naver'], 'gmarket', 0), false);
  assert.equal(e.resolveEligibility([], 'coupang', 1), false);
});
test('resolveEligibility · UNKNOWN default_mode → false (fail closed)', () => {
  assert.equal(e.resolveEligibility(null, 'coupang', 99), false);
  assert.equal(e.resolveEligibility('not-array', 'coupang', 0), false);
});

//   ── Sales Validation Score ─────────────────────────────
test('sales score · 0 sales → 0', () => assert.equal(e.calculateSalesValidationScore(0, 0), 0));
test('sales score · 1 sale → 10', () => assert.equal(e.calculateSalesValidationScore(1, 0), 10));
test('sales score · 3 sales → 18', () => assert.equal(e.calculateSalesValidationScore(2, 1), 18));
test('sales score · 10 sales → 24', () => assert.equal(e.calculateSalesValidationScore(7, 3), 24));
test('sales score · 30 sales → 30 (clamp)', () => assert.equal(e.calculateSalesValidationScore(20, 10), 30));

//   ── Inventory Value Score ──────────────────────────────
test('inv score · cost null → 0', () => assert.equal(e.calculateInventoryValueScore(0, null), 0));
test('inv score · zero value → 0', () => assert.equal(e.calculateInventoryValueScore(0, 1000), 0));
test('inv score · ₩250,000 → 12', () => assert.equal(e.calculateInventoryValueScore(250000, 1000), 12));
test('inv score · ₩500,000 → 24 (P50 이상)', () => assert.equal(e.calculateInventoryValueScore(500000, 1000), 24));
test('inv score · ₩5,000,000 → 30 (P99+)', () => assert.equal(e.calculateInventoryValueScore(5000000, 1000), 30));

//   ── Channel Gap Score ───────────────────────────────────
test('gap score · 0 eligible → 0', () => {
  assert.equal(e.calculateChannelGapScore([
    { channel: 'coupang', eligible: false, channel_status: 'NONE' },
  ]), 0);
});
test('gap score · 4 eligible · all NONE → 20', () => {
  const evals = ['coupang','naver','11st','gmarket'].map(ch => ({ channel: ch, eligible: true, channel_status: 'NONE' }));
  assert.equal(e.calculateChannelGapScore(evals), 20);
});
test('gap score · 4 eligible · 2 LIVE 2 NONE → 10', () => {
  const evals = [
    { channel: 'coupang', eligible: true, channel_status: 'LIVE' },
    { channel: 'naver',   eligible: true, channel_status: 'LIVE' },
    { channel: '11st',    eligible: true, channel_status: 'NONE' },
    { channel: 'gmarket', eligible: true, channel_status: 'NONE' },
  ];
  assert.equal(e.calculateChannelGapScore(evals), 10);
});

//   ── Aging Score ─────────────────────────────────────────
test('aging · null age → 0', () => assert.equal(e.calculateAgingScore(null, 'sku_created_at', 60, 90), 0));
test('aging · 40일 · low confidence → cap 3 (raw 3)', () => {
  //   40일 · < 60 · raw = round(40/60 * 5) = 3 · low → min(3, 3) = 3
  assert.equal(e.calculateAgingScore(40, 'sku_created_at', 60, 90), 3);
});
test('aging · 70일 · low confidence → cap 3 (raw 7)', () => {
  //   70일 · 60-90 · raw=7 · low → cap 3
  assert.equal(e.calculateAgingScore(70, 'sku_created_at', 60, 90), 3);
});
test('aging · 70일 · high confidence → 7', () => {
  assert.equal(e.calculateAgingScore(70, 'inventory_movement', 60, 90), 7);
});
test('aging · 120일 · high confidence → 10', () => {
  assert.equal(e.calculateAgingScore(120, 'inventory_movement', 60, 90), 10);
});
test('aging · 120일 · low confidence → cap 3', () => {
  assert.equal(e.calculateAgingScore(120, 'sku_created_at', 60, 90), 3);
});

//   ── computeDataQualityFlags ─────────────────────────────
test('flags · cost null + stock > 0 → COST_MISSING', () => {
  const flags = e.computeDataQualityFlags({ unit_cost: null, stock_qty: 5, stock_age_source: 'inventory_movement', title: 'ok' });
  assert.ok(flags.includes('COST_MISSING'));
});
test('flags · cost null + stock 0 → COST_MISSING 없음 (등록 대상 아님)', () => {
  const flags = e.computeDataQualityFlags({ unit_cost: null, stock_qty: 0, stock_age_source: 'inventory_movement', title: 'ok' });
  assert.equal(flags.includes('COST_MISSING'), false);
});
test('flags · sku_created_at source → STOCK_AGE_PROXY', () => {
  const flags = e.computeDataQualityFlags({ unit_cost: 1000, stock_qty: 5, stock_age_source: 'sku_created_at', title: 'ok' });
  assert.ok(flags.includes('STOCK_AGE_PROXY'));
});
test('flags · title 빈 문자열 → MISSING_PRODUCT_TITLE', () => {
  const flags = e.computeDataQualityFlags({ unit_cost: 1000, stock_qty: 5, stock_age_source: 'inventory_movement', title: '  ' });
  assert.ok(flags.includes('MISSING_PRODUCT_TITLE'));
});

//   ── Priority Level ──────────────────────────────────────
test('level · stock 0 → null (등록 후보 아님)', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 0, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 5, shopify_sales_90d: 0,
    inventory_value_krw: 1000000, stock_age_days: 100, stock_age_confidence: 'high',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, null);
});
test('level · LIVE channel → null (이미 등록)', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'LIVE', eligible: true,
    ebay_sales_90d: 5, shopify_sales_90d: 0,
    inventory_value_krw: 1000000, stock_age_days: 100, stock_age_confidence: 'high',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, null);
});
test('level · ERROR channel + sales + high value → P0', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'ERROR', eligible: true,
    ebay_sales_90d: 5, shopify_sales_90d: 0,
    inventory_value_krw: 1000000, stock_age_days: 40, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, 'p0');
});
test('level · sales + high value + cost 있음 → P0', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    inventory_value_krw: 600000, stock_age_days: 46, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, 'p0');
});
test('level · cost missing → P0 금지 (P1로 강등)', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    inventory_value_krw: 0, stock_age_days: 46, stock_age_confidence: 'low',
    data_quality_flags: ['COST_MISSING'], config: CONFIG,
  });
  assert.equal(level, 'p1');
});
test('level · sales + low value + LOW confidence 70일 aging 단독 → P0 아님 (P1)', () => {
  //   low confidence aging + no high value + not very-old → P0 조건 미충족
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    inventory_value_krw: 100000, stock_age_days: 70, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, 'p1');
});
test('level · sales + LOW confidence 100일 aging + invValue>0 → P0 (very-old proxy 허용)', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    inventory_value_krw: 100000, stock_age_days: 100, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, 'p0');
});
test('level · sales 있음 · P0 조건 미충족 → P1', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 2, shopify_sales_90d: 0,
    inventory_value_krw: 100000, stock_age_days: 40, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, 'p1');
});
test('level · 판매 검증 없음 + stock 충분 → P2', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 0, shopify_sales_90d: 0,
    inventory_value_krw: 100000, stock_age_days: 46, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, 'p2');
});
test('level · 판매 검증 없음 + cost missing → P3', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: true,
    ebay_sales_90d: 0, shopify_sales_90d: 0,
    inventory_value_krw: 0, stock_age_days: 46, stock_age_confidence: 'low',
    data_quality_flags: ['COST_MISSING'], config: CONFIG,
  });
  assert.equal(level, 'p3');
});
test('level · eligible=false → null', () => {
  const level = e.calculatePriorityLevel({
    stock_qty: 5, channel_status: 'NONE', eligible: false,
    ebay_sales_90d: 10, shopify_sales_90d: 0,
    inventory_value_krw: 1000000, stock_age_days: 46, stock_age_confidence: 'low',
    data_quality_flags: [], config: CONFIG,
  });
  assert.equal(level, null);
});

//   ── Priority Score clamp ────────────────────────────────
test('score · 0..100 clamp', () => {
  assert.equal(e.calculatePriorityScore({ sales: 30, inventory: 30, gap: 20, aging: 10, margin: 10 }), 100);
  assert.equal(e.calculatePriorityScore({ sales: 0, inventory: 0, gap: 0, aging: 0, margin: 0 }), 0);
  //   over-max protection (impossible via sub-fns but defensive)
  assert.equal(e.calculatePriorityScore({ sales: 40, inventory: 40, gap: 25, aging: 15, margin: 15 }), 100);
});

//   ── evaluateSkuChannel end-to-end · reasons 생성 확인 ───
test('evaluate · sales + high value SKU + COUPANG NONE → P0 · reasons 포함', () => {
  const scorecard = {
    sku_master_id: 999, internal_sku: 'PMC-TEST', title: 'Test SKU',
    unit_cost: 100000, stock_qty: 10, inventory_value_krw: 1000000,
    stock_age_days: 46, stock_age_source: 'sku_created_at',
    ebay_sales_90d: 14, shopify_sales_90d: 0,
    live_channels: 1, registered_channels: 1, observed_channels: 1,
    missing_channels_seen: [], channel_eligibility: ['coupang','naver','11st','gmarket'],
  };
  const allCh = [
    { channel: 'coupang', eligible: true, channel_status: 'NONE' },
    { channel: 'naver',   eligible: true, channel_status: 'NONE' },
    { channel: '11st',    eligible: true, channel_status: 'NONE' },
    { channel: 'gmarket', eligible: true, channel_status: 'NONE' },
  ];
  const r = e.evaluateSkuChannel({
    scorecard, channel: 'coupang', channelStatus: 'NONE', allChannelStatuses: allCh,
    config: CONFIG, options: { defaultMode: 0 },
  });
  assert.equal(r.priority_level, 'p0');
  assert.ok(r.priority_score > 50, `score should be > 50, got ${r.priority_score}`);
  assert.equal(r.eligible, true);
  assert.equal(r.data_quality_flags.includes('COST_MISSING'), false);
  assert.equal(r.data_quality_flags.includes('STOCK_AGE_PROXY'), true);
  assert.ok(r.reasons.length >= 3);
  assert.ok(r.reasons.some(x => x.includes('eBay 14')));
  assert.ok(r.reasons.some(x => x.includes('재고금액')));
  assert.ok(r.reasons.some(x => x.includes('쿠팡')));
  assert.ok(r.reasons.some(x => x.includes('proxy')));
});

test('evaluate · cost null + sales → P1 · COST_MISSING flag', () => {
  const scorecard = {
    sku_master_id: 1000, internal_sku: 'PMC-NOCOST', title: 'No Cost',
    unit_cost: null, stock_qty: 5, inventory_value_krw: 0,
    stock_age_days: 46, stock_age_source: 'sku_created_at',
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    live_channels: 1, registered_channels: 1, observed_channels: 1,
    missing_channels_seen: [], channel_eligibility: ['coupang'],
  };
  const allCh = [{ channel: 'coupang', eligible: true, channel_status: 'NONE' }];
  const r = e.evaluateSkuChannel({
    scorecard, channel: 'coupang', channelStatus: 'NONE', allChannelStatuses: allCh,
    config: CONFIG, options: { defaultMode: 0 },
  });
  assert.equal(r.priority_level, 'p1');
  assert.ok(r.data_quality_flags.includes('COST_MISSING'));
  assert.ok(r.reasons.some(x => x.includes('cost_krw 없음')));
  assert.equal(r.inventory_value_score, 0);
});

test('evaluate · eligible=false → priority_level=null (Task 안 만듦)', () => {
  const scorecard = {
    sku_master_id: 1001, internal_sku: 'X', title: 'X',
    unit_cost: 1000, stock_qty: 5, inventory_value_krw: 5000,
    stock_age_days: 46, stock_age_source: 'sku_created_at',
    ebay_sales_90d: 20, shopify_sales_90d: 0,
    live_channels: 1, registered_channels: 1, observed_channels: 1,
    missing_channels_seen: [], channel_eligibility: null,
  };
  const allCh = [{ channel: 'coupang', eligible: false, channel_status: 'NONE' }];
  const r = e.evaluateSkuChannel({
    scorecard, channel: 'coupang', channelStatus: 'NONE', allChannelStatuses: allCh,
    config: CONFIG, options: { defaultMode: 0 },   //   NULL + NONE → false
  });
  assert.equal(r.priority_level, null);
  assert.equal(r.eligible, false);
});
