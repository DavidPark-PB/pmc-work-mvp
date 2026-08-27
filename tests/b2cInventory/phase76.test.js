'use strict';
/**
 * phase76.test.js — Wave 1 Assignment Fix · explicit channel owner + validation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const exp = require('../../src/services/b2cInventory/explicitAssignment');

//   helpers
function user(o = {}) {
  return Object.assign({
    id: 1, username: 'a', is_active: true, b2c_operator: true, b2c_channels: null,
  }, o);
}
function taskRow(ch, sku) {
  return { channel: ch, related_sku_id: sku, exception_type: `channel_register.${ch}` };
}

//   ── validateExplicitChannelOwners ─────────────────
test('validate · 모든 owner 유효 (b2c_channels=null → all channels) → ok', () => {
  const users = [user({ id: 10, username: 'A' }), user({ id: 20, username: 'B' })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10, naver: 10, '11st': 20, gmarket: 20 },
    channelsInPlan: ['coupang','naver','11st','gmarket'],
    users,
  });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('validate · inactive owner → INVALID_CHANNEL_OWNER', () => {
  const users = [user({ id: 10, is_active: false })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10 },
    channelsInPlan: ['coupang'],
    users,
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'INVALID_CHANNEL_OWNER');
  assert.match(r.errors[0].message, /is_active=false/);
});

test('validate · non-b2c_operator → INVALID_CHANNEL_OWNER', () => {
  const users = [user({ id: 10, b2c_operator: false })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10 },
    channelsInPlan: ['coupang'],
    users,
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'INVALID_CHANNEL_OWNER');
  assert.match(r.errors[0].message, /b2c_operator=false/);
});

test('validate · user not found → INVALID_CHANNEL_OWNER', () => {
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 999 },
    channelsInPlan: ['coupang'],
    users: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'INVALID_CHANNEL_OWNER');
});

test('validate · capability mismatch → CHANNEL_CAPABILITY_MISMATCH', () => {
  const users = [user({ id: 10, b2c_channels: ['naver'] })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10 },
    channelsInPlan: ['coupang'],
    users,
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'CHANNEL_CAPABILITY_MISMATCH');
  assert.deepEqual(r.errors[0].user_channels, ['naver']);
});

test('validate · capability match (b2c_channels 포함) → ok', () => {
  const users = [user({ id: 10, b2c_channels: ['coupang','naver'] })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10, naver: 10 },
    channelsInPlan: ['coupang','naver'],
    users,
  });
  assert.equal(r.ok, true);
});

test('validate · missing channel owner → MISSING_CHANNEL_OWNER', () => {
  const users = [user({ id: 10 })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10 },   //   naver 지정 안 됨
    channelsInPlan: ['coupang', 'naver'],
    users,
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].channel, 'naver');
  assert.equal(r.errors[0].code, 'MISSING_CHANNEL_OWNER');
});

test('validate · channel_owners=null → CHANNEL_OWNERS_REQUIRED', () => {
  const r = exp.validateExplicitChannelOwners({
    channelOwners: null,
    channelsInPlan: ['coupang'],
    users: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'CHANNEL_OWNERS_REQUIRED');
});

test('validate · plan 에 없는 채널 owner 는 무시 (허용)', () => {
  const users = [user({ id: 10 })];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10, naver: 10, gmarket: 10 },
    channelsInPlan: ['coupang'],   //   naver / gmarket 은 plan 에 없음
    users,
  });
  assert.equal(r.ok, true);
});

test('validate · 여러 errors 동시 수집 (부분 성공 금지 · 전체 실패 · 원인 상세)', () => {
  const users = [
    user({ id: 10, b2c_channels: ['coupang'] }),   //   naver capability mismatch
    user({ id: 20, is_active: false }),             //   inactive
  ];
  const r = exp.validateExplicitChannelOwners({
    channelOwners: { coupang: 10, naver: 10, '11st': 20 },
    channelsInPlan: ['coupang','naver','11st','gmarket'],
    users,
  });
  assert.equal(r.ok, false);
  //   errors: naver capability mismatch · 11st inactive · gmarket missing
  const codes = r.errors.map(e => e.code).sort();
  assert.deepEqual(codes, ['CHANNEL_CAPABILITY_MISMATCH','INVALID_CHANNEL_OWNER','MISSING_CHANNEL_OWNER']);
});

//   ── applyExplicitAssignment ──────────────────────
test('apply · 채널별 owner assignee_id 설정 · assignee_scope=specific', () => {
  const plan = [
    taskRow('coupang', 1),
    taskRow('naver', 1),
    taskRow('11st', 1),
    taskRow('gmarket', 1),
  ];
  const out = exp.applyExplicitAssignment({
    plan, channelOwners: { coupang: 10, naver: 10, '11st': 20, gmarket: 20 },
  });
  assert.equal(out[0].assignee_id, 10);   //   coupang
  assert.equal(out[0].assignee_scope, 'specific');
  assert.equal(out[1].assignee_id, 10);   //   naver
  assert.equal(out[2].assignee_id, 20);   //   11st
  assert.equal(out[3].assignee_id, 20);   //   gmarket
});

//   ── summarizeAssignment ──────────────────────────
test('summary · Wave 1 시나리오 · A(coupang+naver 5) · B(11st+gmarket 6)', () => {
  const plan = [
    ...Array(3).fill(taskRow('coupang', 1)),
    ...Array(2).fill(taskRow('naver', 2)),
    ...Array(3).fill(taskRow('11st', 3)),
    ...Array(3).fill(taskRow('gmarket', 4)),
  ];
  const channelOwners = { coupang: 10, naver: 10, '11st': 20, gmarket: 20 };
  const withA = exp.applyExplicitAssignment({ plan, channelOwners });
  const users = [
    { id: 10, username: 'operatorA' },
    { id: 20, username: 'operatorB' },
  ];
  const s = exp.summarizeAssignment({ plan: withA, users });
  assert.equal(s.total_tasks, 11);
  assert.equal(s.unassigned_count, 0);
  assert.equal(s.all_assigned, true);
  assert.equal(s.by_channel.coupang.task_count, 3);
  assert.equal(s.by_channel.coupang.assignee_id, 10);
  assert.equal(s.by_channel.coupang.assignee_username, 'operatorA');
  assert.equal(s.by_channel.naver.task_count, 2);
  assert.equal(s.by_channel.naver.assignee_username, 'operatorA');
  assert.equal(s.by_channel['11st'].task_count, 3);
  assert.equal(s.by_channel['11st'].assignee_username, 'operatorB');
  assert.equal(s.by_channel.gmarket.task_count, 3);
  assert.equal(s.by_channel.gmarket.assignee_username, 'operatorB');
});

test('summary · 일부 unassigned → all_assigned=false · unassigned_count>0', () => {
  const plan = [
    { channel: 'coupang', assignee_id: 10 },
    { channel: 'naver', assignee_id: null },
    { channel: '11st', assignee_id: 20 },
  ];
  const s = exp.summarizeAssignment({ plan, users: [] });
  assert.equal(s.all_assigned, false);
  assert.equal(s.unassigned_count, 1);
});
