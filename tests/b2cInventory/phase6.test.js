'use strict';
/**
 * phase6.test.js — Allocation / Auto Assignment / Pilot / Purchase Signal recommended_action.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const alloc = require('../../src/services/b2cInventory/allocationStrategy');
const autoAssign = require('../../src/services/b2cInventory/autoAssignment');
const pilot = require('../../src/services/b2cInventory/pilotSelection');
const purchase = require('../../src/services/b2cInventory/purchaseSignals');
const events = require('../../src/services/b2cInventory/executionEvents');
const metrics = require('../../src/services/b2cInventory/pilotMetrics');
const { planRefill } = require('../../src/services/b2cInventory/queueRefill');

//   ── helpers ─────────────────────────────────────────
function cand(o = {}) {
  return Object.assign({
    sku_master_id: 1, internal_sku: 'S1', title: 'T', channel: 'coupang',
    channel_status: 'NONE', eligible: true,
    priority_level: 'p1', priority_score: 50,
    stock_qty: 5, unit_cost: 10000, inventory_value_krw: 50000,
    stock_age_days: 46, stock_age_source: 'sku_created_at', stock_age_confidence: 'low',
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    sales_validation_score: 18, inventory_value_score: 5, channel_gap_score: 20, aging_score: 3, margin_score: 5,
    data_quality_flags: ['STOCK_AGE_PROXY'],
    reasons: ['r1'],
  }, o);
}
const CFG = { active_queue_target: 300, active_queue_refill_threshold: 200, max_tasks_per_refill: 150, include_p3: 0 };
const NOW = '2026-08-25T00:00:00.000Z';

//   ── Allocation Strategy: GLOBAL_PRIORITY ────────────
test('GLOBAL_PRIORITY · P0 > P1 > P2 유지', () => {
  const items = [
    cand({ sku_master_id: 3, priority_level: 'p2', priority_score: 99 }),
    cand({ sku_master_id: 1, priority_level: 'p0', priority_score: 50 }),
    cand({ sku_master_id: 2, priority_level: 'p1', priority_score: 90 }),
  ];
  const sorted = alloc.allocateGlobalPriority(items);
  assert.deepEqual(sorted.map(c => c.sku_master_id), [1, 2, 3]);
});

//   ── BALANCED_CHANNEL · 채널 편중 방지 · P0 우선 유지 ─
test('BALANCED_CHANNEL · P0 먼저 · 각 level 안 채널 round-robin', () => {
  //   P0 4개 (모두 다른 채널) · P1 4개 (모두 다른 채널) 시나리오
  const items = [];
  const chs = ['coupang', 'naver', '11st', 'gmarket'];
  for (const ch of chs) items.push(cand({ sku_master_id: 100 + chs.indexOf(ch), channel: ch, priority_level: 'p0', priority_score: 80 }));
  for (const ch of chs) items.push(cand({ sku_master_id: 200 + chs.indexOf(ch), channel: ch, priority_level: 'p1', priority_score: 60 }));
  const sorted = alloc.allocateBalancedChannel(items, chs);
  //   앞 4개 모두 P0 · 뒤 4개 모두 P1
  assert.equal(sorted.slice(0, 4).every(c => c.priority_level === 'p0'), true);
  assert.equal(sorted.slice(4, 8).every(c => c.priority_level === 'p1'), true);
  //   각 그룹 안에서 channel 순환 (deterministic AUTO_CHANNELS order)
  assert.deepEqual(sorted.slice(0, 4).map(c => c.channel), chs);
  assert.deepEqual(sorted.slice(4, 8).map(c => c.channel), chs);
});

test('BALANCED_CHANNEL · 한 채널에 몰려도 다른 채널 부족 시 넘어감', () => {
  //   coupang 만 3개 · naver 1개 → 결과: coupang, naver, coupang, coupang
  const items = [
    cand({ sku_master_id: 1, channel: 'coupang', priority_level: 'p1', priority_score: 80 }),
    cand({ sku_master_id: 2, channel: 'coupang', priority_level: 'p1', priority_score: 70 }),
    cand({ sku_master_id: 3, channel: 'coupang', priority_level: 'p1', priority_score: 60 }),
    cand({ sku_master_id: 4, channel: 'naver',   priority_level: 'p1', priority_score: 65 }),
  ];
  const sorted = alloc.allocateBalancedChannel(items, ['coupang','naver','11st','gmarket']);
  //   round 1: coupang(80), naver(65) · round 2: coupang(70) · round 3: coupang(60)
  assert.deepEqual(sorted.map(c => `${c.channel}:${c.priority_score}`), ['coupang:80','naver:65','coupang:70','coupang:60']);
});

//   ── planRefill · allocation_strategy 옵션 통합 ─────
test('planRefill · allocation_strategy=BALANCED_CHANNEL 반영', () => {
  const items = [];
  for (let i = 0; i < 8; i++) {
    items.push(cand({ sku_master_id: i + 1, channel: 'coupang', priority_level: 'p1', priority_score: 90 - i }));
  }
  //   coupang 만 있는데 BALANCED_CHANNEL 이면 어차피 coupang 만 반환
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW, allocationStrategy: 'BALANCED_CHANNEL' });
  assert.equal(r.allocation_strategy, 'BALANCED_CHANNEL');
  assert.equal(r.plan.length, 8);
});

test('planRefill · pilot_max_tasks 로 slots 제한', () => {
  const items = Array.from({ length: 300 }, (_, i) => cand({ sku_master_id: i + 1 }));
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW, pilotMaxTasks: 100 });
  assert.equal(r.slotsAvailable, 100);
  assert.equal(r.plan.length, 100);
  assert.equal(r.pilot_max_tasks, 100);
});

test('planRefill · pilot_max_tasks 가 global max 보다 커도 늘리지 않음 (안전장치)', () => {
  const items = Array.from({ length: 300 }, (_, i) => cand({ sku_master_id: i + 1 }));
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW, pilotMaxTasks: 999 });
  //   global max = 150 · pilot 이 999 지시해도 150 초과 불가
  assert.equal(r.slotsAvailable, 150);
});

//   ── Auto Assignment · LEAST_ACTIVE_TASKS ──────────
test('assignLeastActive · eligible 0 → assignee_id null (fallback)', () => {
  const plan = [{ related_sku_id: 1, channel: 'coupang' }];
  const out = autoAssign.assignLeastActive({ eligibles: [], activeCounts: new Map(), plan });
  assert.equal(out[0].assignee_id, null);
  assert.equal(out[0].assignee_scope, 'operators');
});

test('assignLeastActive · least active · tiebreak user_id ASC', () => {
  const eligibles = [
    { id: 5, username: 'e' },
    { id: 3, username: 'c' },
    { id: 7, username: 'g' },
  ];
  const counts = new Map([[5, 2], [3, 2], [7, 5]]);
  const plan = [
    { related_sku_id: 1 },   //   3 & 5 tied at 2 → id ASC → 3
    { related_sku_id: 2 },   //   3 now 3 · 5 still 2 → 5
    { related_sku_id: 3 },   //   3=3 · 5=3 · 7=5 → 3
  ];
  const out = autoAssign.assignLeastActive({ eligibles, activeCounts: counts, plan });
  assert.deepEqual(out.map(t => t.assignee_id), [3, 5, 3]);
});

test('assignLeastActive · 모두 same count → user_id ASC round-robin', () => {
  const eligibles = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const plan = Array.from({ length: 6 }, (_, i) => ({ related_sku_id: i + 1 }));
  const out = autoAssign.assignLeastActive({ eligibles, activeCounts: new Map(), plan });
  //   round 1: 1, 2, 3 (all 0) · round 2: 1, 2, 3 (all now 1)
  assert.deepEqual(out.map(t => t.assignee_id), [1, 2, 3, 1, 2, 3]);
});

test('assignLeastActive · scope 반영', () => {
  const eligibles = [{ id: 1 }];
  const plan = [{ related_sku_id: 10 }];
  const out = autoAssign.assignLeastActive({ eligibles, activeCounts: new Map(), plan });
  assert.equal(out[0].assignee_scope, 'specific');
});

//   ── Pilot ────────────────────────────────────────
test('pilot · matchesPilotCondition · 모든 조건 필요', () => {
  const passing = { stock_qty: 5, unit_cost: 1000, ebay_sales_90d: 3, shopify_sales_90d: 0 };
  const best = { priority_level: 'p1' };
  assert.equal(pilot.matchesPilotCondition(passing, best), true);
});
test('pilot · stock=0 실패', () => {
  assert.equal(pilot.matchesPilotCondition({ stock_qty: 0, unit_cost: 1000, ebay_sales_90d: 5 }, { priority_level: 'p0' }), false);
});
test('pilot · cost null 실패', () => {
  assert.equal(pilot.matchesPilotCondition({ stock_qty: 5, unit_cost: null, ebay_sales_90d: 5 }, { priority_level: 'p0' }), false);
});
test('pilot · sales 0 실패', () => {
  assert.equal(pilot.matchesPilotCondition({ stock_qty: 5, unit_cost: 1000, ebay_sales_90d: 0, shopify_sales_90d: 0 }, { priority_level: 'p0' }), false);
});
test('pilot · priority P2 실패 (P0/P1 만)', () => {
  assert.equal(pilot.matchesPilotCondition({ stock_qty: 5, unit_cost: 1000, ebay_sales_90d: 5 }, { priority_level: 'p2' }), false);
});

test('pilot · sortSkuLevel · P0 > P1 · deterministic', () => {
  const rows = [
    { sku_master_id: 3, best: { priority_level: 'p1', priority_score: 90 }, scorecard: { inventory_value_krw: 100000, ebay_sales_90d: 5 } },
    { sku_master_id: 1, best: { priority_level: 'p0', priority_score: 50 }, scorecard: { inventory_value_krw: 50000, ebay_sales_90d: 5 } },
    { sku_master_id: 2, best: { priority_level: 'p0', priority_score: 50 }, scorecard: { inventory_value_krw: 50000, ebay_sales_90d: 5 } },
  ];
  pilot.sortSkuLevel(rows);
  //   P0 · 같은 score/inventory/sales → id ASC (1, 2) · 그 후 P1(3)
  assert.deepEqual(rows.map(r => r.sku_master_id), [1, 2, 3]);
});

test('pilot · reduceToBestPerSku · 4채널 중 가장 상위 level 채널 선택', () => {
  const evals = new Map([[1, [
    { priority_level: 'p2', priority_score: 90 },
    { priority_level: 'p0', priority_score: 50 },   //   ← best (P0)
    { priority_level: 'p1', priority_score: 80 },
  ]]]);
  const r = pilot.reduceToBestPerSku(evals);
  assert.equal(r.length, 1);
  assert.equal(r[0].best.priority_level, 'p0');
});

test('pilot · reduceToBestPerSku · 같은 level 이면 score DESC', () => {
  const evals = new Map([[1, [
    { priority_level: 'p1', priority_score: 60 },
    { priority_level: 'p1', priority_score: 90 },   //   ← best
    { priority_level: 'p1', priority_score: 70 },
  ]]]);
  const r = pilot.reduceToBestPerSku(evals);
  assert.equal(r[0].best.priority_score, 90);
});

//   ── Purchase Signals · recommended_action ──────────
test('purchase · signal 에 recommended_action 포함', () => {
  const sig = purchase.detectPurchaseSignals({ stock_qty: 0, ebay_sales_90d: 5, shopify_sales_90d: 0 }, 3);
  assert.equal(sig[0].recommended_action, 'REVIEW_RESTOCK');
});
test('purchase · high severity · opportunity_score 반영', () => {
  const sig = purchase.detectPurchaseSignals({ stock_qty: 0, ebay_sales_90d: 100, shopify_sales_90d: 0 }, 3);
  assert.equal(sig[0].severity, 'high');
  assert.ok(sig[0].opportunity_score >= 60);
});
test('purchase · 자동 발주 hint 없음 · recommendation 만 존재', () => {
  const sig = purchase.detectPurchaseSignals({ stock_qty: 0, ebay_sales_90d: 10, shopify_sales_90d: 0 }, 3);
  //   그 어떤 필드도 "auto" · "execute" · "purchase_order" 등을 지시하지 않음
  const s = JSON.stringify(sig[0]);
  assert.equal(/auto|execute|create.*order/i.test(s), false);
});

//   ── Execution Events ─────────────────────────────
test('events · 알려진 event 만 · unknown 은 warn', () => {
  //   이 test 는 스타일 검사 · types 만 확인
  assert.ok(events.EVENT_TYPES.includes('QUEUE_REFILL_EXECUTED'));
  assert.ok(events.EVENT_TYPES.includes('TASK_AUTO_ASSIGNED'));
  assert.ok(events.EVENT_TYPES.includes('PILOT_ELIGIBILITY_ACTIVATED'));
});

//   ── Metrics · pure ────────────────────────────────
test('metrics · computeMetricsFromTasks · B2C exception_type 만 집계', () => {
  const tasks = [
    { exception_type: 'channel_register.coupang', channel: 'coupang', status: 'done', qc_status: 'pass', created_at: '2026-08-01', completed_at: '2026-08-02' },
    { exception_type: 'channel_register.naver',   channel: 'naver',   status: 'pending' },
    { exception_type: 'SKU_MATCH_FAILED',         status: 'pending' },   //   legacy pricing · 제외돼야 함
    { exception_type: 'data_quality.cost_missing', status: 'done', qc_status: 'pass' },
  ];
  const m = metrics.computeMetricsFromTasks(tasks);
  assert.equal(m.tasks_total, 3);   //   pricing legacy 는 제외
  assert.equal(m.tasks_completed, 2);
  assert.equal(m.live_count, 2);
  assert.equal(m.by_channel.coupang.created, 1);
  assert.equal(m.by_channel.coupang.completed, 1);
  assert.equal(m.by_channel.coupang.live, 1);
});
