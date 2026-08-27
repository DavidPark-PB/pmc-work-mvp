'use strict';
/**
 * channelMatrixHelpers.test.js — Phase 3 · pure helper tests.
 * Framework: node:test (project standard · `npm test` uses --test tests/pricing/*).
 * Run: node --test tests/b2cInventory/channelMatrixHelpers.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../src/services/b2cInventory/channelMatrixHelpers');

// ── computeEligibilityState ──────────────────────────────────
test('computeEligibilityState · NULL → unspecified', () => {
  assert.equal(h.computeEligibilityState(null), 'unspecified');
  assert.equal(h.computeEligibilityState(undefined), 'unspecified');
});
test('computeEligibilityState · [] → none (explicit exclusion)', () => {
  assert.equal(h.computeEligibilityState([]), 'none');
});
test('computeEligibilityState · non-empty array → explicit', () => {
  assert.equal(h.computeEligibilityState(['coupang']), 'explicit');
  assert.equal(h.computeEligibilityState(['ebay', 'shopify']), 'explicit');
});
test('computeEligibilityState · 잘못된 타입은 방어적으로 unspecified', () => {
  assert.equal(h.computeEligibilityState('coupang'), 'unspecified');
  assert.equal(h.computeEligibilityState({}), 'unspecified');
  assert.equal(h.computeEligibilityState(0), 'unspecified');
});

// ── computeChannelEligibility ────────────────────────────────
test('computeChannelEligibility · NULL → per-channel null (unspecified)', () => {
  assert.equal(h.computeChannelEligibility(null, 'coupang'), null);
});
test('computeChannelEligibility · array contains channel → true', () => {
  assert.equal(h.computeChannelEligibility(['coupang', 'naver'], 'coupang'), true);
  assert.equal(h.computeChannelEligibility(['coupang', 'naver'], 'naver'), true);
});
test('computeChannelEligibility · array excludes channel → false', () => {
  assert.equal(h.computeChannelEligibility(['coupang'], 'ebay'), false);
  assert.equal(h.computeChannelEligibility([], 'coupang'), false);
});

// ── validateEligibilityBody ──────────────────────────────────
test('validate · null → ok · value=null', () => {
  const r = h.validateEligibilityBody({ channel_eligibility: null });
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});
test('validate · undefined field → ok · value=null (unspecified)', () => {
  const r = h.validateEligibilityBody({});
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});
test('validate · [] → ok · value=[]', () => {
  const r = h.validateEligibilityBody({ channel_eligibility: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, []);
});
test('validate · valid channels → normalized + deduped', () => {
  const r = h.validateEligibilityBody({ channel_eligibility: ['Coupang', 'NAVER', 'coupang', ' 11st '] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['coupang', 'naver', '11st']);   //   lowercase · dedup · trim
});
test('validate · unknown channel → fail', () => {
  const r = h.validateEligibilityBody({ channel_eligibility: ['coupang', 'lazada'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /알 수 없는 채널/);
});
test('validate · non-string element → fail', () => {
  const r = h.validateEligibilityBody({ channel_eligibility: ['coupang', 123] });
  assert.equal(r.ok, false);
  assert.match(r.error, /문자열이어야 함/);
});
test('validate · not-array not-null → fail', () => {
  assert.equal(h.validateEligibilityBody({ channel_eligibility: 'coupang' }).ok, false);
  assert.equal(h.validateEligibilityBody({ channel_eligibility: 42 }).ok, false);
  assert.equal(h.validateEligibilityBody({ channel_eligibility: {} }).ok, false);
});
test('validate · body 아닌 값 → fail', () => {
  const r = h.validateEligibilityBody(null);
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON object/);
});

// ── buildMatrixResponse ──────────────────────────────────────
test('buildMatrixResponse · 6개 채널 항상 반환 (없으면 NONE)', () => {
  const built = h.buildMatrixResponse([], null);
  assert.equal(built.channels.length, 6);
  assert.deepEqual(built.channels.map(c => c.channel), ['ebay', 'shopify', 'coupang', 'naver', '11st', 'gmarket']);
  assert.equal(built.channels.every(c => c.channel_status === 'NONE'), true);
  assert.equal(built.channels.every(c => c.eligible === null), true);   //   NULL eligibility → 모두 null
});

test('buildMatrixResponse · 등록된 채널 반영 + eligible 계산', () => {
  const rows = [
    { channel: 'ebay',    channel_status: 'LIVE',  listing_id: '204410854607', selling_price: 72.80, selling_currency: 'USD', raw_status: 'active', last_checked_at: '2026-08-01' },
    { channel: 'shopify', channel_status: 'READY', listing_id: 'sku-marker' },
  ];
  const built = h.buildMatrixResponse(rows, ['coupang', 'naver']);
  const byCh = Object.fromEntries(built.channels.map(c => [c.channel, c]));
  assert.equal(byCh.ebay.channel_status, 'LIVE');
  assert.equal(byCh.ebay.listing_id, '204410854607');
  assert.equal(byCh.ebay.selling_price, 72.80);
  assert.equal(byCh.ebay.eligible, false);   //   ebay 는 array 에 없음 → false
  assert.equal(byCh.coupang.channel_status, 'NONE');
  assert.equal(byCh.coupang.eligible, true);
  assert.equal(byCh.gmarket.eligible, false);
});

test('buildMatrixResponse · auto_task_target 4개만 true', () => {
  const built = h.buildMatrixResponse([], null);
  const byCh = Object.fromEntries(built.channels.map(c => [c.channel, c]));
  assert.equal(byCh.ebay.auto_task_target,    false);
  assert.equal(byCh.shopify.auto_task_target, false);
  assert.equal(byCh.coupang.auto_task_target, true);
  assert.equal(byCh.naver.auto_task_target,   true);
  assert.equal(byCh['11st'].auto_task_target, true);
  assert.equal(byCh.gmarket.auto_task_target, true);
});

test('buildMatrixResponse · 표시대상 아닌 채널은 other_channels 로 분리', () => {
  const rows = [
    { channel: 'ebay',   channel_status: 'LIVE', listing_id: '111' },
    { channel: 'shopee', channel_status: 'READY', listing_id: '222' },
    { channel: 'qoo10',  channel_status: 'LIVE', listing_id: '333' },
  ];
  const built = h.buildMatrixResponse(rows, null);
  assert.equal(built.channels.length, 6);
  assert.equal(built.other_channels.length, 2);
  const otherIds = built.other_channels.map(o => o.channel).sort();
  assert.deepEqual(otherIds, ['qoo10', 'shopee']);
});

test('buildMatrixResponse · null/undefined 방어', () => {
  const built = h.buildMatrixResponse(null, null);
  assert.equal(built.channels.length, 6);
  assert.deepEqual(built.other_channels, []);
});

// ── adminNoteFor ─────────────────────────────────────────────
test('adminNoteFor · NULL + default_mode=0 → note 반환', () => {
  const n = h.adminNoteFor(null, 0);
  assert.ok(n && n.includes('NULL'));
  assert.ok(n.includes('default_eligibility_mode'));
});
test('adminNoteFor · NULL + default_mode=1 → null (KOREA_ALL 이면 노트 불필요)', () => {
  assert.equal(h.adminNoteFor(null, 1), null);
});
test('adminNoteFor · 명시적 eligibility → null (관리자가 이미 설정한 경우)', () => {
  assert.equal(h.adminNoteFor(['coupang'], 0), null);
  assert.equal(h.adminNoteFor([], 0), null);
});

// ── DISPLAY_CHANNELS · AUTO_TASK_CHANNELS 계약 pin ─────────
test('constants · DISPLAY_CHANNELS 6개 정확 (Owner Q2 결정)', () => {
  assert.deepEqual(h.DISPLAY_CHANNELS, ['ebay', 'shopify', 'coupang', 'naver', '11st', 'gmarket']);
});
test('constants · AUTO_TASK_CHANNELS 4개 (한국 채널만 · Owner Q2 결정)', () => {
  assert.deepEqual(Array.from(h.AUTO_TASK_CHANNELS).sort(), ['11st', 'coupang', 'gmarket', 'naver']);
});
