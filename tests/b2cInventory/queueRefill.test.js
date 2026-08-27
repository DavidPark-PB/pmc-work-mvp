'use strict';
/**
 * queueRefill.test.js — Phase 5 · pure planner tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { planRefill, taskRowFromCandidate, LEVEL_RANK, AUTO_CHANNELS } = require('../../src/services/b2cInventory/queueRefill');

const CFG = {
  active_queue_target: 300,
  active_queue_refill_threshold: 200,
  max_tasks_per_refill: 150,
  include_p3: 0,
};
const NOW = '2026-08-25T00:00:00.000Z';

function cand(overrides = {}) {
  return Object.assign({
    sku_master_id: 1, internal_sku: 'S1', title: 'T', channel: 'coupang',
    channel_status: 'NONE', eligible: true,
    priority_level: 'p1', priority_score: 50,
    stock_qty: 5, unit_cost: 10000, inventory_value_krw: 50000,
    stock_age_days: 46, stock_age_source: 'sku_created_at', stock_age_confidence: 'low',
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    sales_validation_score: 18, inventory_value_score: 5, channel_gap_score: 20, aging_score: 3, margin_score: 5,
    data_quality_flags: ['STOCK_AGE_PROXY'],
    reasons: ['reason1', 'reason2'],
  }, overrides);
}

//   ── queue healthy ─────────────────────────────────────
test('queue >= threshold → 0 생성 · QUEUE_HEALTHY', () => {
  const r = planRefill({
    activeCount: 250, config: CFG, candidates: [cand()], existingActiveKeys: new Set(), nowISO: NOW,
  });
  assert.equal(r.reason, 'QUEUE_HEALTHY');
  assert.equal(r.slotsAvailable, 0);
  assert.equal(r.plan.length, 0);
});

//   ── slots · target - active · max_per_refill clip ──
test('slots · active 100 · target 300 · max 150 → slots = 150', () => {
  const r = planRefill({
    activeCount: 100, config: CFG, candidates: [], existingActiveKeys: new Set(), nowISO: NOW,
  });
  assert.equal(r.slotsAvailable, 150);
});
test('slots · active 250 · under threshold 나올 순 없지만 방어 · target - active clip', () => {
  //   실제로는 active >= threshold(200) 면 healthy 로 리턴 · 이 경계는 250 < 200 아니면 healthy
  //   active 180 → 300-180=120 (< max 150) → 120
  const r = planRefill({ activeCount: 180, config: CFG, candidates: [], existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.slotsAvailable, 120);
});
test('slots · active 0 · slots = max_per_refill 150', () => {
  const r = planRefill({ activeCount: 0, config: CFG, candidates: [], existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.slotsAvailable, 150);
});

//   ── max_tasks_per_refill 초과 생성 금지 ─────────────
test('candidate 500 · slots 150 · plan.length = 150', () => {
  const many = Array.from({ length: 500 }, (_, i) => cand({ sku_master_id: i + 1 }));
  const r = planRefill({ activeCount: 0, config: CFG, candidates: many, existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.slotsAvailable, 150);
  assert.equal(r.plan.length, 150);
  assert.equal(r.filtered.beyond_slot_limit, 350);
});

//   ── P0 > P1 > P2 순서 · deterministic tie-breaker ─
test('정렬 · P0 먼저 · 같은 level 이면 score DESC · inventory DESC · sales DESC · id ASC', () => {
  const items = [
    cand({ sku_master_id: 4, priority_level: 'p1', priority_score: 90, inventory_value_krw: 50000, ebay_sales_90d: 5 }),
    cand({ sku_master_id: 2, priority_level: 'p0', priority_score: 60, inventory_value_krw: 100000 }),
    cand({ sku_master_id: 3, priority_level: 'p2', priority_score: 99 }),
    cand({ sku_master_id: 1, priority_level: 'p0', priority_score: 60, inventory_value_krw: 100000 }),   //   같은 level·score·inventory → id 낮은 것 먼저
    cand({ sku_master_id: 5, priority_level: 'p0', priority_score: 80 }),
  ];
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW });
  //   P0: 5 (score 80), 1 (score 60 · id 1), 2 (score 60 · id 2) · P1: 4 · P2: 3 (default 은 P3 만 제외)
  //   sku 1 이 sku 2 보다 앞 · deterministic id ASC · P2 는 include (P3 만 default 제외)
  assert.deepEqual(r.plan.map(p => p.related_sku_id), [5, 1, 2, 4, 3]);
});

//   ── P3 default 제외 ────────────────────────────────
test('include_p3=false (default) · P3 candidate 제외', () => {
  const items = [
    cand({ sku_master_id: 1, priority_level: 'p1' }),
    cand({ sku_master_id: 2, priority_level: 'p3' }),
  ];
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].related_sku_id, 1);
  assert.equal(r.filtered.excluded_p3, 1);
});
test('include_p3=true · P3 포함', () => {
  const items = [cand({ sku_master_id: 1, priority_level: 'p3' })];
  const r = planRefill({ activeCount: 0, config: { ...CFG, include_p3: 1 }, candidates: items, existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.plan.length, 1);
});

//   ── LIVE 제외 · not NONE/ERROR ────────────────────
test('channel_status=LIVE 제외', () => {
  const items = [
    cand({ sku_master_id: 1, channel_status: 'LIVE' }),
    cand({ sku_master_id: 2, channel_status: 'NONE' }),
    cand({ sku_master_id: 3, channel_status: 'ERROR' }),
    cand({ sku_master_id: 4, channel_status: 'READY' }),
    cand({ sku_master_id: 5, channel_status: 'PAUSED' }),
  ];
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.plan.length, 2);
  assert.deepEqual(r.plan.map(p => p.related_sku_id).sort(), [2, 3]);
  assert.equal(r.filtered.excluded_not_none_or_error, 3);
});

//   ── eligible=false 제외 ────────────────────────────
test('eligible=false 제외', () => {
  const items = [
    cand({ sku_master_id: 1, eligible: false }),
    cand({ sku_master_id: 2, eligible: true }),
  ];
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].related_sku_id, 2);
  assert.equal(r.filtered.excluded_ineligible, 1);
});

//   ── existing active task 제외 (dedup) ─────────────
test('existing active task 제외 · (sku, channel, exception_type) key 매칭', () => {
  const items = [
    cand({ sku_master_id: 1, channel: 'coupang' }),
    cand({ sku_master_id: 1, channel: 'naver' }),
  ];
  const existing = new Set(['1|coupang|channel_register.coupang']);
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: existing, nowISO: NOW });
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].channel, 'naver');
  assert.equal(r.filtered.excluded_duplicate, 1);
});

//   ── Task context snapshot 확인 (Owner spec §16) ──
test('taskRowFromCandidate · context snapshot 필드 완전 · engine_version=v1', () => {
  const c = cand({
    sku_master_id: 42, internal_sku: 'PMC-42', title: 'The Answer',
    unit_cost: 190000, inventory_value_krw: 1520000, ebay_sales_90d: 16, shopify_sales_90d: 0,
    stock_age_days: 46, stock_age_source: 'sku_created_at',
    priority_level: 'p0', priority_score: 81,
    sales_validation_score: 30, inventory_value_score: 28, channel_gap_score: 20, aging_score: 3, margin_score: 5,
    reasons: ['eBay 16건', '재고금액 큼'],
  });
  const row = taskRowFromCandidate(c, NOW);
  assert.equal(row.exception_type, 'channel_register.coupang');
  assert.equal(row.channel, 'coupang');
  assert.equal(row.priority_level, 'p0');
  assert.equal(row.priority_score, 81);
  assert.equal(row.related_sku_id, 42);
  assert.equal(row.dedupe_key, 'b2c_ch:42:coupang');
  assert.equal(row.severity, 'high');
  assert.equal(row.status, 'pending');
  assert.equal(row.auto_generated, true);
  //   context snapshot
  const ctx = row.context;
  assert.equal(ctx.domain, 'b2c_inventory_distribution');
  assert.equal(ctx.engine_version, 'v1');
  assert.equal(ctx.sku_master_id, 42);
  assert.equal(ctx.stock_qty, 5);
  assert.equal(ctx.cost_krw, 190000);
  assert.equal(ctx.inventory_value_krw, 1520000);
  assert.equal(ctx.sales_90d, 16);
  assert.equal(ctx.priority_score, 81);
  assert.equal(ctx.stock_age_source, 'sku_created_at');
  assert.deepEqual(ctx.sub_scores, { sales: 30, inventory: 28, gap: 20, aging: 3, margin: 5 });
  assert.deepEqual(ctx.reasons, ['eBay 16건', '재고금액 큼']);
  assert.equal(ctx.generated_at, NOW);
});

//   ── priority_level=null (Task 후보 아님) 제외 ────
test('priority_level=null candidate 제외', () => {
  const items = [
    cand({ sku_master_id: 1, priority_level: null }),
    cand({ sku_master_id: 2, priority_level: 'p1' }),
  ];
  const r = planRefill({ activeCount: 0, config: CFG, candidates: items, existingActiveKeys: new Set(), nowISO: NOW });
  assert.equal(r.plan.length, 1);
  assert.equal(r.filtered.excluded_no_level, 1);
});
