'use strict';

/**
 * priceEngine.characterization.test.js — Phase 1 Commit 1
 * ---------------------------------------------------------------------------
 * 목적: 현재 priceEngine 의 동작을 **고정** (문서화). 로직 변경 X.
 * 이후 Commit 이 이 계산 결과를 실수로 바꾸면 즉시 실패.
 *
 * 실행: node --test tests/pricing/
 *
 * 원칙 (사장님 지시):
 *   - 실제 marketplace/DB 절대 호출 X — priceEngine 은 순수 함수
 *   - 기존 계산 결과를 임의로 바꾸지 않음
 *   - CASE A~G (attack / hold / block missing cost / ambiguous fee / kill switch /
 *     idempotency retry / marketplace failure) 중 순수 판정 로직 부분은 여기서,
 *     실행 게이트/idempotency/mock marketplace 는 Commit 2 gate 테스트에서 다룸.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION, REASON, DEFAULTS,
  computeConfidence, computeLandingCost, computeFloor,
  decideSku, canAutoApply,
} = require('../../src/engines/priceEngine');

/* ─────────────────────────── computeLandingCost ─────────────────────────── */

test('computeLandingCost — cost 있음 + intl shipping 있음 → complete=true, baseCostUsd 계산', () => {
  // ₩65,000 원가 + ₩7,250 국제배송 + ₩0 국내배송 = ₩72,250. 환율 1450 → $49.83
  const r = computeLandingCost({ costKrw: 65000, intlShippingKrw: 7250, usdKrw: 1450 });
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.baseCostUsd, 49.83);
});

test('computeLandingCost — cost 누락 → complete=false, missing=[cost_krw]', () => {
  const r = computeLandingCost({ costKrw: 0, intlShippingKrw: 7250 });
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['cost_krw', 'intl_shipping'].filter(x => x === 'cost_krw'));
  assert.equal(r.baseCostUsd, null);
});

test('computeLandingCost — intl shipping 누락 → complete=false, missing=[intl_shipping]', () => {
  const r = computeLandingCost({ costKrw: 65000, intlShippingKrw: null });
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['intl_shipping']);
  assert.equal(r.baseCostUsd, null);
});

test('computeLandingCost — usdKrw 기본값 1450', () => {
  const r = computeLandingCost({ costKrw: 14500, intlShippingKrw: 1450 }); // 환율 미지정
  // (14500 + 1450) / 1450 = 11
  assert.equal(r.baseCostUsd, 11);
});

/* ─────────────────────────── computeFloor ─────────────────────────── */

test('computeFloor — 기본 fee 18% + margin 15% → baseCost / 0.67', () => {
  // floor = 50 / (1 - 0.18 - 0.15) = 50 / 0.67 = 74.63
  const floor = computeFloor({ baseCostUsd: 50 });
  assert.equal(floor, 74.63);
});

test('computeFloor — fee + margin >= 100% → Infinity (수학적 불가능)', () => {
  const floor = computeFloor({ baseCostUsd: 50, ebayFeePct: 0.60, minMarginPct: 50 });
  assert.equal(floor, Infinity);
});

test('computeFloor — 커스텀 margin 10% + fee 15% → baseCost / 0.75', () => {
  // 60 / (1 - 0.15 - 0.10) = 60 / 0.75 = 80
  const floor = computeFloor({ baseCostUsd: 60, ebayFeePct: 0.15, minMarginPct: 10 });
  assert.equal(floor, 80);
});

/* ─────────────────────────── computeConfidence ─────────────────────────── */

test('computeConfidence — 4축 모두 만점 + supplier NULL → overall=1.0', () => {
  const c = computeConfidence({
    identityConfidence: 1.0,
    competitorAgeHours: 2,       // 신선 (< 48h 기본)
    anomalySuspect: false,
    landingCost: { complete: true },
    supplierConfidence: null,    // Engine 5 활성 전 → 1.0 취급
  });
  assert.equal(c.identity, 1.0);
  assert.equal(c.price, 1.0);
  assert.equal(c.cost, 1.0);
  assert.equal(c.supplier, 1.0);
  assert.equal(c.overall, 1.0);
});

test('computeConfidence — identity null → identity=0 → overall=0 (min-of-axes)', () => {
  const c = computeConfidence({
    identityConfidence: null,
    competitorAgeHours: 2,
    anomalySuspect: false,
    landingCost: { complete: true },
  });
  assert.equal(c.identity, 0);
  assert.equal(c.overall, 0);
});

test('computeConfidence — landing cost incomplete → cost=0 → overall=0', () => {
  const c = computeConfidence({
    identityConfidence: 0.99,
    competitorAgeHours: 2,
    anomalySuspect: false,
    landingCost: { complete: false, missing: ['cost_krw'] },
  });
  assert.equal(c.cost, 0);
  assert.equal(c.overall, 0);
});

test('computeConfidence — competitor age 48h 초과 96h 이하 → price=0.5', () => {
  const c = computeConfidence({
    identityConfidence: 1.0,
    competitorAgeHours: 60,      // > FRESH_HOURS(48) but <= 2*FRESH
    anomalySuspect: false,
    landingCost: { complete: true },
  });
  assert.equal(c.price, 0.5);
});

test('computeConfidence — competitor age 2x FRESH 초과 → price=0', () => {
  const c = computeConfidence({
    identityConfidence: 1.0,
    competitorAgeHours: 100,
    anomalySuspect: false,
    landingCost: { complete: true },
  });
  assert.equal(c.price, 0);
});

test('computeConfidence — anomaly 의심 → price 상한 0.5', () => {
  const c = computeConfidence({
    identityConfidence: 1.0,
    competitorAgeHours: 2,        // 원래 1.0
    anomalySuspect: true,
    landingCost: { complete: true },
  });
  assert.equal(c.price, 0.5);
});

/* ─────────────────────────── decideSku — CASE A~K ─────────────────────────── */

const HEALTHY_INPUT = () => ({
  sku: 'PMC-TEST-001', itemId: '123456789',
  currentTotal: 80,
  competitorTotal: 60,
  prevCompetitorTotal: 62,
  identityConfidence: 0.99,
  competitorAgeHours: 2,
  landingCost: { complete: true, baseCostUsd: 30, missing: [] },
  supplierConfidence: null,
});

test('CASE A — 정상 (current $62 → drop 4.8% 내, 경쟁 $60, cost $30) → AUTO_UNDERCUT_SAFE, recommended=$59', () => {
  // NOTE: currentTotal 80 이면 drop 26% > DAILY_MAX_DROP_PCT(15) → REVIEW_MAX_DROP_EXCEEDED 로 분기.
  // 현재 사장님 실제 리스팅이 competitor 근접 상태에서 미세 인하하는 시나리오가 정상 AUTO 케이스.
  const r = decideSku({ ...HEALTHY_INPUT(), currentTotal: 62 });
  assert.equal(r.action, ACTION.AUTO);
  assert.equal(r.reason_code, REASON.AUTO_UNDERCUT_SAFE);
  assert.equal(r.recommended_price, 59);
  assert.equal(r.target, 59);      // 60 - 1
  // floor = 30 / (1 - 0.18 - 0.15) = 44.78
  assert.equal(r.floor, 44.78);
});

test('CASE A-EDGE — current $80 → drop 26% > 15% cap → REVIEW_MAX_DROP_EXCEEDED (현재 실 동작 고정)', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), currentTotal: 80 });
  assert.equal(r.action, ACTION.REVIEW);
  assert.equal(r.reason_code, REASON.REVIEW_MAX_DROP_EXCEEDED);
});

test('CASE A2 — current 이미 recommended 와 같음 → AUTO_PRICE_MAINTAINED', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), currentTotal: 59 });
  assert.equal(r.action, ACTION.AUTO);
  assert.equal(r.reason_code, REASON.AUTO_PRICE_MAINTAINED);
});

test('CASE B — cost 누락 (landing incomplete) → BLOCK_LANDING_COST_UNKNOWN', () => {
  const r = decideSku({
    ...HEALTHY_INPUT(),
    landingCost: { complete: false, missing: ['cost_krw'], baseCostUsd: null },
  });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_LANDING_COST_UNKNOWN);
  assert.deepEqual(r.missing_data, ['cost_krw']);
  assert.equal(r.recommended_price, null);
});

test('CASE C — identity null (매칭 없음) → BLOCK_NO_MATCH', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), identityConfidence: null });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_NO_MATCH);
});

test('CASE C2 — competitorTotal 0 이하 → BLOCK_NO_MATCH', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), competitorTotal: 0 });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_NO_MATCH);
});

test('CASE D — competitor < baseCost (네이버 프로모 의심) → REVIEW_COMPETITOR_BELOW_COST', () => {
  // baseCost $30, competitor $25 → 경쟁이 우리 원가보다 낮음
  const r = decideSku({
    ...HEALTHY_INPUT(),
    competitorTotal: 25,
    prevCompetitorTotal: 25,       // anomaly 없게
    currentTotal: 80,
  });
  assert.equal(r.action, ACTION.REVIEW);
  assert.equal(r.reason_code, REASON.REVIEW_COMPETITOR_BELOW_COST);
  // 여전히 target/floor 는 계산됨
  assert.equal(r.target, 24);
  assert.equal(r.floor, 44.78);
});

test('CASE E — competitor age > fresh_hours(48) → BLOCK_STALE_COMPETITOR', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), competitorAgeHours: 100 });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_STALE_COMPETITOR);
});

test('CASE E2 — competitorAgeHours null → BLOCK_STALE_COMPETITOR', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), competitorAgeHours: null });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_STALE_COMPETITOR);
});

test('CASE F — 경쟁가 급락 (직전 $100 → 현재 $50, 50% down) → REVIEW_PRICE_ANOMALY', () => {
  const r = decideSku({
    ...HEALTHY_INPUT(),
    competitorTotal: 50,
    prevCompetitorTotal: 100,     // 50% 급락 (anomaly_drop_pct=30 초과)
    landingCost: { complete: true, baseCostUsd: 20, missing: [] },  // baseCost < competitor 로 belowCost 회피
  });
  assert.equal(r.action, ACTION.REVIEW);
  assert.equal(r.reason_code, REASON.REVIEW_PRICE_ANOMALY);
});

test('CASE G — floor > target (원가 높아 최저가 못 감) → REVIEW_FLOOR_BINDS', () => {
  // baseCost $50 → floor = 50/0.67 = 74.63, target = competitor(60) - 1 = 59 → floor > target
  const r = decideSku({
    ...HEALTHY_INPUT(),
    landingCost: { complete: true, baseCostUsd: 50, missing: [] },
    currentTotal: 80,
  });
  assert.equal(r.action, ACTION.REVIEW);
  assert.equal(r.reason_code, REASON.REVIEW_FLOOR_BINDS);
  assert.equal(r.recommended_price, 74.63);   // max(target, floor)
});

test('CASE H — daily drop cap 초과 (오늘 이미 10% 인하 + 이번 8% → 15% 초과) → REVIEW_MAX_DROP_EXCEEDED', () => {
  // current $80, recommended $59 → drop = (80-59)/80 = 26.25%
  // usedPct=10 + 26.25 = 36.25 > 15
  const r = decideSku({ ...HEALTHY_INPUT(), currentTotal: 80, todayDropPctUsed: 10 });
  assert.equal(r.action, ACTION.REVIEW);
  assert.equal(r.reason_code, REASON.REVIEW_MAX_DROP_EXCEEDED);
});

test('CASE J — apiError true → BLOCK_API_ERROR (모든 다른 검사보다 우선)', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), apiError: true });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_API_ERROR);
});

test('CASE K — isMapRestricted true → BLOCK_MAP', () => {
  const r = decideSku({ ...HEALTHY_INPUT(), isMapRestricted: true });
  assert.equal(r.action, ACTION.BLOCK);
  assert.equal(r.reason_code, REASON.BLOCK_MAP);
});

test('CASE L — REVIEW_LOW_CONFIDENCE (identity 0.85, 축 min=0.85 < 0.95 AUTO_THRESHOLD)', () => {
  // identity 0.85 → axes min (excluding anomaly) = 0.85, overall = 0.85
  // review_threshold=0.80 통과 (BLOCK 회피), auto_threshold=0.95 미달 → REVIEW_LOW_CONFIDENCE
  const r = decideSku({ ...HEALTHY_INPUT(), identityConfidence: 0.85 });
  assert.equal(r.action, ACTION.REVIEW);
  assert.equal(r.reason_code, REASON.REVIEW_LOW_CONFIDENCE);
});

/* ─────────────────────────── canAutoApply ─────────────────────────── */

test('canAutoApply — kill_switch=true → BLOCK, why=kill_switch (FAIL CLOSED)', () => {
  const r = canAutoApply({
    guardrails: { kill_switch: true, auto_apply_enabled: true },
    autoAppliedToday: 0,
    catalogSize: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'kill_switch');
});

test('canAutoApply — auto_apply_enabled=false → BLOCK (kill_switch 와 별개 개념)', () => {
  const r = canAutoApply({
    guardrails: { kill_switch: false, auto_apply_enabled: false },
    autoAppliedToday: 0,
    catalogSize: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'auto_apply_disabled(dry-run)');
});

test('canAutoApply — 일일 자동변경 cap 초과 → BLOCK, why=daily_auto_ratio_cap', () => {
  // cap 기본 20%, catalog 100 → 20건 이상이면 차단
  const r = canAutoApply({
    guardrails: { kill_switch: false, auto_apply_enabled: true, daily_auto_ratio_cap_pct: 20 },
    autoAppliedToday: 25,
    catalogSize: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'daily_auto_ratio_cap');
});

test('canAutoApply — guardrails 정상 + cap 미만 → ok:true', () => {
  const r = canAutoApply({
    guardrails: { kill_switch: false, auto_apply_enabled: true, daily_auto_ratio_cap_pct: 20 },
    autoAppliedToday: 5,
    catalogSize: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.why, null);
});

test('canAutoApply — guardrails 빈 객체 → auto_apply_enabled=undefined → BLOCK (FAIL CLOSED)', () => {
  const r = canAutoApply({ guardrails: {}, autoAppliedToday: 0, catalogSize: 100 });
  assert.equal(r.ok, false);
  // undefined 는 falsy → auto_apply_disabled 로 분기
  assert.equal(r.why, 'auto_apply_disabled(dry-run)');
});

test('canAutoApply — guardrails null → BLOCK (kill_switch=undefined, auto_apply_enabled=undefined)', () => {
  const r = canAutoApply({ guardrails: null, autoAppliedToday: 0, catalogSize: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'auto_apply_disabled(dry-run)');
});

/* ─────────────────────────── DEFAULTS 스냅샷 ─────────────────────────── */

test('DEFAULTS 스냅샷 — 상수가 실수로 바뀌면 실패 (Data Contract 값)', () => {
  assert.equal(DEFAULTS.UNDERCUT_USD, 1.0);
  assert.equal(DEFAULTS.MIN_MARGIN_PCT, 15);
  assert.equal(DEFAULTS.AUTO_THRESHOLD, 0.95);
  assert.equal(DEFAULTS.REVIEW_THRESHOLD, 0.80);
  assert.equal(DEFAULTS.FRESH_HOURS, 48);
  assert.equal(DEFAULTS.ANOMALY_DROP_PCT, 30);
  assert.equal(DEFAULTS.DAILY_MAX_DROP_PCT, 15);
});
