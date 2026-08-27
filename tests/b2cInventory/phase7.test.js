'use strict';
/**
 * phase7.test.js — Employee Work OS · NEXT TASK · Actions · Capability · KPI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const nt = require('../../src/services/b2cInventory/nextTask');
const acts = require('../../src/services/b2cInventory/taskActions');
const kpi = require('../../src/services/b2cInventory/employeeAndChannelKpi');
const auto = require('../../src/services/b2cInventory/autoAssignment');

const NOW = '2026-08-26T00:00:00.000Z';

function task(o = {}) {
  return Object.assign({
    id: 1, exception_type: 'channel_register.coupang', channel: 'coupang',
    priority_level: 'p1', priority_score: 50, status: 'pending',
    assignee_id: 100, created_at: NOW,
  }, o);
}

//   ── NEXT TASK ────────────────────────────────────
test('NEXT TASK · P0 우선', () => {
  const tasks = [task({ id: 1, priority_level: 'p1', priority_score: 90 }), task({ id: 2, priority_level: 'p0', priority_score: 50 })];
  const n = nt.pickNextTask(tasks);
  assert.equal(n.id, 2);
});
test('NEXT TASK · 동일 priority · score DESC · created_at ASC · id ASC', () => {
  const tasks = [
    task({ id: 3, priority_level: 'p0', priority_score: 50, created_at: '2026-08-20T00:00:00Z' }),
    task({ id: 1, priority_level: 'p0', priority_score: 50, created_at: '2026-08-20T00:00:00Z' }),
    task({ id: 2, priority_level: 'p0', priority_score: 70, created_at: '2026-08-20T00:00:00Z' }),
  ];
  const n = nt.pickNextTask(tasks);
  assert.equal(n.id, 2);   //   score 70 이 최상
  nt.sortTasksNextOrder(tasks);
  //   3 (score 50) vs 1 (score 50) · id ASC → 1 먼저
  assert.deepEqual(tasks.map(t => t.id), [2, 1, 3]);
});
test('NEXT TASK · in_progress 우선 · pending 보다', () => {
  const tasks = [
    task({ id: 1, priority_level: 'p0', priority_score: 90, status: 'pending' }),
    task({ id: 2, priority_level: 'p1', priority_score: 50, status: 'in_progress' }),
  ];
  const n = nt.pickNextTask(tasks);
  assert.equal(n.id, 2);   //   in_progress 최상위 (사용자 이어서 처리)
});
test('NEXT TASK · qc_pending 은 NEXT 로 안 뽑힘', () => {
  const tasks = [task({ id: 1, priority_level: 'p0', priority_score: 90, status: 'qc_pending' })];
  const n = nt.pickNextTask(tasks);
  assert.equal(n, null);
});
test('NEXT TASK · B2C exception_type 만 · legacy pricing 제외', () => {
  const tasks = [
    task({ id: 1, exception_type: 'SKU_MATCH_FAILED', priority_level: 'p0' }),
    task({ id: 2, exception_type: 'channel_register.coupang', priority_level: 'p1' }),
  ];
  const n = nt.pickNextTask(tasks);
  assert.equal(n.id, 2);
});

test('summarizeMyTasks · today count / status buckets', () => {
  const today = '2026-08-26';
  const tasks = [
    task({ id: 1, status: 'done', completed_at: '2026-08-26T10:00:00Z' }),
    task({ id: 2, status: 'done', completed_at: '2026-08-25T10:00:00Z' }),   //   어제 완료
    task({ id: 3, status: 'in_progress' }),
    task({ id: 4, status: 'qc_pending' }),
    task({ id: 5, status: 'pending' }),
    task({ id: 6, status: 'blocked' }),
    task({ id: 7, status: 'in_progress', qc_status: 'fail' }),
  ];
  const s = nt.summarizeMyTasks(tasks, today);
  assert.equal(s.completed_today, 1);
  assert.equal(s.in_progress, 2);
  assert.equal(s.qc_pending, 1);
  assert.equal(s.remaining, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.qc_failed_active, 1);
});

//   ── Validators ───────────────────────────────────
test('submit · CHANNEL_REGISTER 은 listing_id 필수', () => {
  const r = acts.validateSubmitBody({ listing_url: 'https://x.com', selling_price: 1000 }, task());
  assert.equal(r.ok, false); assert.equal(r.code, 'LISTING_ID_REQUIRED');
});
test('submit · listing_url http/https 필수', () => {
  const r = acts.validateSubmitBody({ listing_id: 'X', listing_url: 'ftp://x', selling_price: 1000 }, task());
  assert.equal(r.ok, false); assert.equal(r.code, 'LISTING_URL_INVALID');
});
test('submit · selling_price > 0 필수', () => {
  const r = acts.validateSubmitBody({ listing_id: 'X', listing_url: 'https://x.com', selling_price: 0 }, task());
  assert.equal(r.ok, false); assert.equal(r.code, 'SELLING_PRICE_INVALID');
});
test('submit · 모두 유효 → ok', () => {
  const r = acts.validateSubmitBody({ listing_id: ' X ', listing_url: 'https://x.com', selling_price: '15000' }, task());
  assert.equal(r.ok, true);
  assert.equal(r.value.listing_id, 'X');
  assert.equal(r.value.selling_price, 15000);
});
test('submit · data_quality task 는 필수필드 없음', () => {
  const r = acts.validateSubmitBody({}, task({ exception_type: 'data_quality.cost_missing', channel: null }));
  assert.equal(r.ok, true);
});

test('blocked reason · allowlist 강제', () => {
  assert.equal(acts.validateBlockedBody({ reason: 'BRAND_RESTRICTION' }).ok, true);
  assert.equal(acts.validateBlockedBody({ reason: 'INVALID_REASON' }).ok, false);
  assert.equal(acts.validateBlockedBody({}).ok, false);
});

test('qc_fail reason · allowlist 강제', () => {
  assert.equal(acts.validateQcFailBody({ reason: 'WRONG_PRICE' }).ok, true);
  assert.equal(acts.validateQcFailBody({ reason: 'HACKED' }).ok, false);
});

//   ── Authorization ────────────────────────────────
test('canUserActOnTask · 본인 배정 만 · admin 예외', () => {
  const t = task({ assignee_id: 100 });
  assert.equal(acts.canUserActOnTask({ id: 100 }, t), true);
  assert.equal(acts.canUserActOnTask({ id: 200 }, t), false);
  assert.equal(acts.canUserActOnTask({ id: 999, isAdmin: true }, t), true);
});

test('canQc · admin 만', () => {
  assert.equal(acts.canQc({ id: 1, isAdmin: true }), true);
  assert.equal(acts.canQc({ id: 1, isAdmin: false }), false);
  assert.equal(acts.canQc(null), false);
});

//   ── Auto assignment · Channel capability ─────────
test('capability · b2c_channels NULL → 모든 채널 가능', () => {
  assert.equal(auto.userCanHandleChannel({ id: 1, b2c_channels: null }, 'coupang'), true);
  assert.equal(auto.userCanHandleChannel({ id: 1, b2c_channels: null }, 'gmarket'), true);
});
test('capability · [] → 모든 채널 불가', () => {
  assert.equal(auto.userCanHandleChannel({ id: 1, b2c_channels: [] }, 'coupang'), false);
});
test('capability · [ch...] whitelist', () => {
  const u = { id: 1, b2c_channels: ['coupang', 'naver'] };
  assert.equal(auto.userCanHandleChannel(u, 'coupang'), true);
  assert.equal(auto.userCanHandleChannel(u, '11st'), false);
});
test('assignLeastActive · capability filter · 담당 가능한 직원 없으면 unassigned', () => {
  const eligibles = [
    { id: 1, b2c_channels: ['naver'] },
    { id: 2, b2c_channels: ['gmarket'] },
  ];
  const plan = [{ related_sku_id: 1, channel: 'coupang' }];
  const out = auto.assignLeastActive({ eligibles, activeCounts: new Map(), plan });
  //   coupang 담당 가능 직원 0 → unassigned
  assert.equal(out[0].assignee_id, null);
  assert.equal(out[0].assignee_scope, 'operators');
});
test('assignLeastActive · capability + least active · 동률 → user_id ASC', () => {
  const eligibles = [
    { id: 5, b2c_channels: null },       //   all channels
    { id: 3, b2c_channels: ['coupang'] },//   coupang only
    { id: 7, b2c_channels: null },       //   all
  ];
  const plan = [{ related_sku_id: 1, channel: 'coupang' }, { related_sku_id: 2, channel: 'coupang' }];
  const out = auto.assignLeastActive({ eligibles, activeCounts: new Map(), plan });
  //   3 candidates 모두 count 0 → id ASC → 3 먼저 · 그 다음 5
  assert.equal(out[0].assignee_id, 3);
  assert.equal(out[1].assignee_id, 5);
});

//   ── KPI · BLOCKED 는 실패에서 제외 ───────────────
test('employee KPI · BLOCKED 는 qc_fail rate 에서 제외', () => {
  const tasks = [
    { exception_type: 'channel_register.coupang', assignee_id: 1, qc_status: 'pass' },
    { exception_type: 'channel_register.coupang', assignee_id: 1, qc_status: 'fail' },
    { exception_type: 'channel_register.coupang', assignee_id: 1, status: 'blocked', blocked_reason: 'OTHER' },
  ];
  const m = kpi.computeEmployeeKpi(tasks);
  const k = m.get(1);
  assert.equal(k.qc_passed, 1);
  assert.equal(k.qc_failed, 1);
  assert.equal(k.blocked, 1);
  //   pass/fail rate = 1/(1+1) = 50 · blocked 는 분모 제외
  assert.equal(k.qc_pass_rate_pct, 50);
});
test('channel KPI · created / qc_pass / qc_fail / blocked · pass rate', () => {
  const tasks = [
    { exception_type: 'channel_register.coupang', channel: 'coupang', qc_status: 'pass' },
    { exception_type: 'channel_register.coupang', channel: 'coupang', qc_status: 'pass' },
    { exception_type: 'channel_register.coupang', channel: 'coupang', qc_status: 'fail' },
    { exception_type: 'channel_register.coupang', channel: 'coupang', status: 'blocked' },
    { exception_type: 'channel_register.naver',   channel: 'naver',   qc_status: 'pass' },
  ];
  const m = kpi.computeChannelKpi(tasks);
  const c = m.get('coupang');
  assert.equal(c.created, 4);
  assert.equal(c.qc_pass, 2);
  assert.equal(c.qc_fail, 1);
  assert.equal(c.blocked, 1);
  assert.equal(c.qc_pass_rate_pct, 66.67);   //   2 / (2+1) = 66.67%
  //   naver
  const n = m.get('naver');
  assert.equal(n.created, 1);
  assert.equal(n.qc_pass_rate_pct, 100);
});

//   ── isB2c filter ─────────────────────────────────
test('isB2c · channel_register.* · data_quality.* · listing_error 만 true', () => {
  assert.equal(kpi.isB2c('channel_register.coupang'), true);
  assert.equal(kpi.isB2c('data_quality.cost_missing'), true);
  assert.equal(kpi.isB2c('listing_error'), true);
  assert.equal(kpi.isB2c('SKU_MATCH_FAILED'), false);
  assert.equal(kpi.isB2c('LANDING_COST_DATA_MISSING'), false);
});
