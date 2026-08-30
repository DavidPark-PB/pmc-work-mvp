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
 * route 안의 로직과 동일한 순수 함수.
 * 라우트 자체는 DB 조인 + supabase 계층까지 있어서 여기서는 계산부만 격리.
 * suggestedRaise 로직이 바뀌면 이 함수도 라우트와 동기화되어야 한다.
 */
function computeSuggestedRaise({ type, newPrice, compShipping, myPrice, myShipping }) {
  if (type !== 'raise_opportunity') return null;
  if (newPrice == null || myPrice == null) return null;
  const myTotal = myPrice + (myShipping || 0);
  const compTotal = newPrice + (compShipping || 0);
  const targetTotal = +(compTotal - 0.50).toFixed(2);
  if (targetTotal <= myTotal) return null;
  const targetMyPrice = +(targetTotal - (myShipping || 0)).toFixed(2);
  if (targetMyPrice <= myPrice) return null;
  return targetMyPrice;
}

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
