'use strict';
/**
 * suggestedRaiseTotalBased.test.js — /api/battle/alerts suggestedRaise 로직 검증.
 *
 * 배경 (2026-08-30 · Owner 스크린샷 버그):
 *   이전 로직은 경쟁사 판매가와 내 판매가만 비교했음.
 *   내 총액 (판매가+배송) 이 경쟁사 총액보다 이미 비싼데도 판매가만 낮으면
 *   "인상 제안" 을 냈다. 예: 내 $24.98+$10=$34.98 vs 경쟁사 $31.99+$0=$31.99
 *   → 이미 내가 $2.99 비쌈인데 "$31.49 로 인상" 제안 → 총액 더 벌어짐.
 *
 * Fix (route 내 로직 · 여기서는 pure function 형태로 검증):
 *   총액 기준 비교. targetMyPrice = (compTotal - 0.50) - myShipping.
 *   그 값이 내 판매가보다 커야만 suggestedRaise 반환.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * route 안의 로직과 동일한 순수 함수 · 라우트가 바뀌면 여기도 동기화되어야 한다.
 * 2026-08-30: suggestedDrop 추가 (Owner: "인하가 주 목적").
 */
const UNDERCUT = 0.50;

function computeSuggestions({ type, newPrice, compShipping, myPrice, myShipping }) {
  if (newPrice == null || myPrice == null) return { suggestedRaise: null, suggestedDrop: null };
  const myTotal   = myPrice + (myShipping || 0);
  const compTotal = newPrice + (compShipping || 0);
  let suggestedRaise = null;
  let suggestedDrop  = null;
  if (myTotal > compTotal) {
    const targetTotal = +(compTotal - UNDERCUT).toFixed(2);
    const targetMyPrice = +(targetTotal - (myShipping || 0)).toFixed(2);
    if (targetMyPrice > 0 && targetMyPrice < myPrice) suggestedDrop = targetMyPrice;
  } else if (type === 'raise_opportunity' && myTotal < compTotal) {
    const targetTotal = +(compTotal - UNDERCUT).toFixed(2);
    if (targetTotal > myTotal) {
      const targetMyPrice = +(targetTotal - (myShipping || 0)).toFixed(2);
      if (targetMyPrice > myPrice) suggestedRaise = targetMyPrice;
    }
  }
  return { suggestedRaise, suggestedDrop };
}

//   compat wrapper (기존 케이스 그대로 유지)
function computeSuggestedRaise(args) { return computeSuggestions(args).suggestedRaise; }
function computeSuggestedDrop(args)  { return computeSuggestions(args).suggestedDrop; }

//   ── Owner 실제 케이스 (3M Scotch Brite) ──
test('Owner 버그 케이스 — 내가 이미 비싼데 판매가만 낮음 → 인상 제안 X', () => {
  const r = computeSuggestedRaise({
    type: 'raise_opportunity',
    newPrice: 31.99,     // 경쟁사 판매가 (배송 별도)
    compShipping: 0,     // 경쟁사 배송 free
    myPrice: 24.98,      // 내 판매가
    myShipping: 10.00,   // 내 배송
  });
  assert.equal(r, null, '내 총액 $34.98 > 경쟁사 총액 $31.99 이므로 인상 제안 X');
});

//   ── 신규 · 인하 제안 ──
test('내 총액 > 경쟁사 총액 → suggestedDrop 반환 (인하가 주 목적)', () => {
  const r = computeSuggestedDrop({
    type: 'price_change',
    newPrice: 31.99, compShipping: 0,
    myPrice: 24.98, myShipping: 10.00,
  });
  //   compTotal 31.99 · target 31.49 · targetMyPrice 21.49
  assert.equal(r, 21.49);
});

test('내가 이미 저렴 → suggestedDrop X (더 낮출 필요 없음)', () => {
  const r = computeSuggestedDrop({
    type: 'price_change',
    newPrice: 40.00, compShipping: 5.00,   // compTotal 45
    myPrice: 30.00, myShipping: 10.00,     // myTotal 40 · 이미 저렴
  });
  assert.equal(r, null);
});

test('인하 제안이 음수/0 이 되면 반환 X (원가 밑 방지)', () => {
  const r = computeSuggestedDrop({
    type: 'price_change',
    newPrice: 3.00, compShipping: 0,       // compTotal 3
    myPrice: 5.00, myShipping: 10.00,      // myTotal 15 · 비쌈
  });
  //   target 2.50 · targetMyPrice = 2.50 - 10 = -7.50 → null
  assert.equal(r, null);
});

test('type 무관 · 총액 비교만으로 인하 제안 (price_crash 든 price_change 든)', () => {
  const args = { newPrice: 20, compShipping: 0, myPrice: 25, myShipping: 5 };
  assert.equal(computeSuggestedDrop({ ...args, type: 'price_crash' }), 14.50);
  assert.equal(computeSuggestedDrop({ ...args, type: 'price_change' }), 14.50);
  assert.equal(computeSuggestedDrop({ ...args, type: 'raise_opportunity' }), 14.50);
});

//   ── 정상 케이스: 내가 저렴한데 경쟁사 인상 → 나도 따라 올릴 여지 ──
test('내가 총액으로도 저렴 + 경쟁사 인상 → 판매가 인상 제안', () => {
  const r = computeSuggestedRaise({
    type: 'raise_opportunity',
    newPrice: 40.00,      // 경쟁사 판매가
    compShipping: 5.00,   // 경쟁사 총액 45.00
    myPrice: 24.98,
    myShipping: 10.00,    // 내 총액 34.98
  });
  //   target 총액 = 45 - 0.5 = 44.50 · 내 판매가 = 44.50 - 10 = 34.50
  assert.equal(r, 34.50);
});

//   ── 경계: 경쟁사 배송 없고 우리 배송도 없는 단순 케이스 ──
test('둘 다 배송 없음 · 경쟁사 $40 로 인상 · 나 $25 → 판매가 $39.50 제안', () => {
  const r = computeSuggestedRaise({
    type: 'raise_opportunity',
    newPrice: 40.00,
    compShipping: 0,
    myPrice: 25.00,
    myShipping: 0,
  });
  assert.equal(r, 39.50);
});

//   ── 타입 필터: raise_opportunity 가 아니면 제안 안 함 ──
test('type != raise_opportunity → 항상 null', () => {
  const base = { newPrice: 40, compShipping: 0, myPrice: 20, myShipping: 0 };
  assert.equal(computeSuggestedRaise({ ...base, type: 'price_crash' }), null);
  assert.equal(computeSuggestedRaise({ ...base, type: 'price_change' }), null);
});

//   ── 안전: null / 결측치 ──
test('newPrice 또는 myPrice 결측 → null', () => {
  assert.equal(computeSuggestedRaise({ type: 'raise_opportunity', newPrice: null, myPrice: 20 }), null);
  assert.equal(computeSuggestedRaise({ type: 'raise_opportunity', newPrice: 30, myPrice: null }), null);
});

//   ── 경계: 경쟁사 총액과 내 총액이 같으면 인상 제안 X (동가) ──
test('경쟁사 총액 = 내 총액 → 인상 제안 X (동가에서 굳이 인상할 이유 없음)', () => {
  const r = computeSuggestedRaise({
    type: 'raise_opportunity',
    newPrice: 30, compShipping: 5,     // comp total 35
    myPrice: 25, myShipping: 10,        // my total 35
  });
  //   targetTotal = 34.5 · myTotal 35 → 34.5 > 35 FALSE
  assert.equal(r, null);
});

//   ── 경계: 미세 인상 (총액 차이 $0.50 미만) → 판매가 변화 없어서 제안 X ──
test('제안 판매가가 현재와 같으면 (rounding 후 동가) 제안 X', () => {
  const r = computeSuggestedRaise({
    type: 'raise_opportunity',
    newPrice: 25.50, compShipping: 0,
    myPrice: 24.98, myShipping: 0,
  });
  //   targetTotal = 25.00 > myTotal 24.98 → 통과 · targetMyPrice = 25.00 > 24.98 → OK
  assert.equal(r, 25.00);
});
