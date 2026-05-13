/**
 * Phase 5 — 사장님 spec 7개 테스트 케이스
 *
 * 실행: node scripts/test-shipping-phase5.js
 *
 * 케이스 1~5,6: shippingWeightCalculator 의 pure 함수로 검증 (DB 불필요)
 * 케이스 3,4:   DB·라우트 통합 필요 — 본 스크립트 밑에 수동 절차 출력
 */
'use strict';

const calc = require('../src/services/shippingWeightCalculator');

let pass = 0, fail = 0;
function ok(name, condition, hint = '') {
  if (condition) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (hint ? '  — ' + hint : '')); }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Phase 5 — 배송비 계산/배송추천 테스트 (사장님 spec 7 cases)');
console.log('═══════════════════════════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────
// CASE 1: SKU 마스터에 무게가 있는 상품 주문 → 자동 계산
// ─────────────────────────────────────────────────────────────────
console.log('[CASE 1] SKU 마스터에 무게 있는 상품 → 자동 계산\n');
{
  const lines = [{
    id: 101, quantity: 3,
    sku: { id: 1, weight_gram: 50, default_packaging_weight_g: 20,
           shipping_group: 'general',
           width_cm: 10, height_cm: 8, length_cm: 5 },
  }];
  const agg = calc._aggregate(lines);

  ok('product_weight_g = 50 × 3 = 150g', agg.productWeightG === 150,
     `got ${agg.productWeightG}`);
  ok('packaging_weight_g = SKU default 20g', agg.packagingWeightG === 20,
     `got ${agg.packagingWeightG}`);
  ok('final_weight_g = 150 + 20 = 170g', agg.finalWeightG === 170);
  ok('volumetric_weight_g 계산됨', agg.volumetricWeightG > 0);
  ok('chargeable_weight_g 양수', agg.chargeableWeightG > 0);
  ok('hasAllWeights = true', agg.hasAllWeights === true);
  ok('missingSkus 비어있음', agg.missingSkus.length === 0);

  const rec = calc._recommendCarrierAndCost({
    chargeableWeightG: agg.chargeableWeightG,
    countryCode: 'US',
    hasAllWeights: true,
  });
  ok('recommended_carrier 추천됨', !!rec.carrierKey && rec.carrierKey !== 'review',
     `got carrierKey=${rec.carrierKey}`);
}

// ─────────────────────────────────────────────────────────────────
// CASE 2: SKU 무게 없는 주문 → '무게 입력 필요'
// ─────────────────────────────────────────────────────────────────
console.log('\n[CASE 2] SKU 무게 없는 주문 → 무게 입력 필요\n');
{
  const lines = [{
    id: 102, quantity: 1, marketplace_sku: 'NO-WEIGHT-001',
    sku: { id: 2, weight_gram: null, shipping_group: null },
  }];
  const agg = calc._aggregate(lines);
  ok('hasAllWeights = false', agg.hasAllWeights === false);
  ok('missingSkus 1건 포함', agg.missingSkus.length === 1);
  ok('missing 이유 weight_gram 미입력', /weight_gram 미입력/.test(agg.missingSkus[0].reason));

  const rec = calc._recommendCarrierAndCost({
    chargeableWeightG: agg.chargeableWeightG,
    countryCode: 'US',
    hasAllWeights: agg.hasAllWeights,
  });
  ok('추천 carrier = review', rec.carrierKey === 'review', `got ${rec.carrierKey}`);
  ok('reason 에 "무게 미입력" 포함', /무게 미입력/.test(rec.reason || ''));
}

// ─────────────────────────────────────────────────────────────────
// CASE 5: 수량 ≥ 2 → item_weight_g × quantity
// ─────────────────────────────────────────────────────────────────
console.log('\n[CASE 5] 수량 5개 → 단품무게 × 수량\n');
{
  const lines = [{
    id: 105, quantity: 5,
    sku: { id: 5, weight_gram: 40, default_packaging_weight_g: 10, shipping_group: null },
  }];
  const agg = calc._aggregate(lines);
  ok('product_weight = 40 × 5 = 200g', agg.productWeightG === 200,
     `got ${agg.productWeightG}`);
  ok('수량 반영 — 단품 × qty 곱셈', agg.productWeightG / lines[0].quantity === 40);
}

// 다중 라인 (서로 다른 SKU 합산)
console.log('\n[CASE 5b] 다중 라인 — 라인별 단품×수량 합산\n');
{
  const lines = [
    { id: 1, quantity: 2, sku: { weight_gram: 30, default_packaging_weight_g: 10 } },
    { id: 2, quantity: 1, sku: { weight_gram: 100, default_packaging_weight_g: 50 } },
  ];
  const agg = calc._aggregate(lines);
  ok('product_weight = 30×2 + 100×1 = 160g', agg.productWeightG === 160,
     `got ${agg.productWeightG}`);
  ok('packaging = max(10, 50) = 50g (한 박스 가정)', agg.packagingWeightG === 50,
     `got ${agg.packagingWeightG}`);
  ok('final = 160 + 50 = 210g', agg.finalWeightG === 210);
}

// ─────────────────────────────────────────────────────────────────
// CASE 6: 부피무게 > 실무게 → chargeable = 부피무게
// ─────────────────────────────────────────────────────────────────
console.log('\n[CASE 6] 부피무게 > 실무게 → chargeable = 부피무게 기준\n');
{
  // 30×30×30 박스, 단품 100g, 포장 80g → 실무게 180g
  // 부피 = 27000 cm³ / 5000 × 1000 = 5400g (실무게보다 큼)
  const lines = [{
    id: 106, quantity: 1,
    sku: { id: 6, weight_gram: 100, default_packaging_weight_g: 80,
           shipping_group: 'album',
           width_cm: 30, height_cm: 30, length_cm: 30 },
  }];
  const agg = calc._aggregate(lines);
  ok('final_weight_g = 180', agg.finalWeightG === 180);
  ok('volumetric_weight_g = 5400', agg.volumetricWeightG === 5400,
     `got ${agg.volumetricWeightG}`);
  ok('chargeable = max(180, 5400) = 5400 (부피 우세)',
     agg.chargeableWeightG === 5400);
}

// 반대 — 작은 박스: 실무게 우세
console.log('\n[CASE 6b] 작은 박스 — 실무게 우세\n');
{
  // 카드 5장, 6×9×0.4 cm × 5 = 108 cm³ × 5? 아니, 단품 dim × qty 합산.
  // 부피 = 6×9×0.4 × 5 qty = 108 cm³ / 5000 × 1000 = 21.6g
  // 실무게 = 2g × 5 + 5g(pkg) = 15g  → 부피 우세
  // 다른 케이스로 변경: 단품 1000g 무거운 거 작은 박스
  // 단품 1000g × 1, 5×5×5=125cm³ → 부피 25g, 실무게 1000 + 50 = 1050g, chargeable 1050
  const lines = [{
    id: 107, quantity: 1,
    sku: { id: 7, weight_gram: 1000, default_packaging_weight_g: 50,
           width_cm: 5, height_cm: 5, length_cm: 5 },
  }];
  const agg = calc._aggregate(lines);
  ok('실무게 > 부피 → chargeable = 실무게',
     agg.chargeableWeightG === agg.finalWeightG && agg.finalWeightG > agg.volumetricWeightG,
     `final=${agg.finalWeightG}, vol=${agg.volumetricWeightG}, chargeable=${agg.chargeableWeightG}`);
}

// ─────────────────────────────────────────────────────────────────
// CASE 7: SKU 마스터 무게 vs 주문 수정 무게 차이 큰 경우 → 경고
// ─────────────────────────────────────────────────────────────────
// 라우트 핸들러 안에서 inline 으로 계산하는 규칙: deviation = |override - final| / final
// >= 0.5 (50%) → 경고. 본 스크립트는 그 규칙을 그대로 재현해서 검증.
console.log('\n[CASE 7] 자동 계산 vs 수동 수정 ±50% 차이 → 경고\n');
{
  const THRESHOLD = 0.5;
  function shouldWarn(finalWeight, overridden) {
    if (!finalWeight) return false;
    return Math.abs(overridden - finalWeight) / finalWeight >= THRESHOLD;
  }
  // 자동 계산 100g, 수동 200g → 100% 차이 → 경고 O
  ok('100g 자동 vs 200g 수동 (100% 차이) → 경고',
     shouldWarn(100, 200) === true);
  // 자동 100g, 수동 150g → 50% 차이 → 경고 O (threshold 포함)
  ok('100g 자동 vs 150g 수동 (50% 차이) → 경고',
     shouldWarn(100, 150) === true);
  // 자동 100g, 수동 140g → 40% 차이 → 경고 X
  ok('100g 자동 vs 140g 수동 (40% 차이) → 경고 안 함',
     shouldWarn(100, 140) === false);
  // 자동 100g, 수동 50g → 50% 차이 (감소) → 경고 O
  ok('100g 자동 vs 50g 수동 (50% 감소) → 경고',
     shouldWarn(100, 50) === true);
}

// ─────────────────────────────────────────────────────────────────
// 결과 요약
// ─────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`결과: ${pass} pass, ${fail} fail`);
console.log('═══════════════════════════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────
// 수동 검증 절차 — 케이스 3·4 (DB 연동 필요)
// ─────────────────────────────────────────────────────────────────
console.log('────────────────────────────────────────────────────────────────');
console.log('수동 검증 절차 (브라우저 + 라이브 DB 필요):');
console.log('────────────────────────────────────────────────────────────────\n');

console.log('[CASE 3] 주문별 무게 수정 → 해당 주문배송 데이터만 변경');
console.log('  1. 🆕 배송 추천 (자동계산) 페이지 진입');
console.log('  2. 임의 주문 행의 ✏️ 수정 클릭');
console.log('  3. 새 무게(g) + 사유 입력. "SKU 마스터에도 반영" 체크박스 OFF');
console.log('  4. 저장 → 그 행에 ✏️ 수동 수정 표시 + 청구무게 변경 확인');
console.log('  5. SKU 마스터 페이지에서 해당 SKU 의 weight_gram 이 변경 안 됐는지 확인');
console.log('  6. 같은 SKU 의 다른 주문 행은 영향 없는지 확인');
console.log('');

console.log('[CASE 4] "SKU 마스터에도 반영" 선택 → sku_master.weight_gram 업데이트');
console.log('  1. 단일 SKU 주문 (line 1개) 선택');
console.log('  2. ✏️ 수정 → 새 무게 입력 → ☑ SKU 마스터에도 반영 체크');
console.log('  3. 저장 후 alert 메시지에 inferredItemWeight 확인');
console.log('  4. 📦 SKU 마스터 페이지로 이동 → 해당 SKU 의 weight_gram 변경 확인');
console.log('  5. weight_status 가 measured 로 셋팅됐는지 확인');
console.log('  6. 새 주문 import 또는 🔁 재계산 → 자동 계산 무게가 새 값으로 갱신');
console.log('');

console.log('[CASE 4 다중 SKU 차단 확인]');
console.log('  1. 다중 SKU 주문 (line 2개 이상) 선택');
console.log('  2. ✏️ 수정 → "SKU 마스터에도 반영" 체크박스가 비활성 상태인지 확인');
console.log('  3. 안내 문구 "단일 SKU 주문에만 가능 (현재 N개)" 표시 확인');
console.log('');

process.exit(fail > 0 ? 1 : 0);
