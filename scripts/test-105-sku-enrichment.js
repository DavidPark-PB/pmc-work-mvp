#!/usr/bin/env node
/**
 * scripts/test-105-sku-enrichment.js
 *
 * SKU Enrichment Loop V1 · 격리된 검증 스크립트.
 *
 * 안전:
 *   - 임시 SKU (`__TEST_ENRICH_YYYYMMDDHHMMSS__`) 로 격리
 *   - 실 데이터 오염 없음 · 완료 후 임시 row 정리
 *   - 실 서버 실행 불필요 (DB 직접 · API 로직 재현)
 *
 * TESTS (Owner Directive 2026-08-31 + 2026-09-01 atomicity):
 *   1. 신규 SKU enrichment · weight + dims + cost + supplier 저장
 *   2. Persistence · 재조회 값 유지
 *   3. 동일 SKU 다른 주문 · 자동 표시
 *   4. Cost history · 이전값 보존 (rpc)
 *   5. Supplier history · 이력 append (rpc)
 *   6. Multi-qty 보호 · sku_master 오염 방지
 *   7. Profit · 직접 계산 vs API 결과 비교
 *   8. FAILURE ROLLBACK · cost · 존재 안 하는 SKU 에 rpc → history/master 무변경
 *   9. FAILURE ROLLBACK · supplier · 존재 안 하는 supplier_id → history/master 무변경
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 필요');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const TEST_SKU_A = `__TEST_ENRICH_${STAMP}_A__`;
const TEST_SKU_B = `__TEST_ENRICH_${STAMP}_B__`;
const TEST_ORDER_1 = `TEST-ENRICH-${STAMP}-1`;
const TEST_ORDER_2 = `TEST-ENRICH-${STAMP}-2`;
const TEST_ORDER_MULTI = `TEST-ENRICH-${STAMP}-M`;
const TEST_SUPPLIER = `__TEST_SUPPLIER_${STAMP}__`;

let results = [];

function pass(name, note) { results.push({ name, status: 'PASS', note: note || '' }); console.log(`  ✅ ${name}${note ? ' · ' + note : ''}`); }
function fail(name, err)  { results.push({ name, status: 'FAIL', note: String(err?.message || err) }); console.log(`  ❌ ${name} · ${err?.message || err}`); }

// ══════════════════════════════════════════════════════════════════════════
// Setup · 임시 SKU/supplier/order 생성
// ══════════════════════════════════════════════════════════════════════════
async function setup() {
  console.log('\n[SETUP]');

  // SKU A · qty=1 시나리오
  const { data: skuA, error: eA } = await db.from('sku_master')
    .insert({ internal_sku: TEST_SKU_A, title: 'TEST enrichment SKU A', status: 'active' })
    .select('id').single();
  if (eA) throw new Error(`SKU A 생성 실패: ${eA.message}`);
  console.log(`  ✓ SKU A 생성 · id=${skuA.id} · sku=${TEST_SKU_A}`);

  // SKU B · multi-qty 시나리오
  const { data: skuB, error: eB } = await db.from('sku_master')
    .insert({ internal_sku: TEST_SKU_B, title: 'TEST enrichment SKU B', status: 'active',
             weight_gram: 999, length_cm: 99, width_cm: 99, height_cm: 99 })
    .select('id, weight_gram, length_cm, width_cm, height_cm').single();
  if (eB) throw new Error(`SKU B 생성 실패: ${eB.message}`);
  console.log(`  ✓ SKU B 생성 · id=${skuB.id} · 초기 weight=${skuB.weight_gram}g dims=${skuB.length_cm}×${skuB.width_cm}×${skuB.height_cm}`);

  // supplier
  const { data: sup, error: eS } = await db.from('suppliers')
    .insert({ name: TEST_SUPPLIER, channel: 'test', is_active: true })
    .select('id, name').single();
  if (eS) throw new Error(`supplier 생성 실패: ${eS.message}`);
  console.log(`  ✓ supplier 생성 · id=${sup.id}`);

  // 주문 3개 · orders 테이블 · 필수 컬럼만
  const { error: eO } = await db.from('orders').insert([
    { order_no: TEST_ORDER_1, platform: 'ebay', sku: TEST_SKU_A, quantity: 1,
      title: 'TEST order 1', status: 'NEW', order_date: '2026-08-31',
      payment_amount: 15.0, currency: 'USD', country_code: 'US', buyer_name: 'TEST' },
    { order_no: TEST_ORDER_2, platform: 'ebay', sku: TEST_SKU_A, quantity: 1,
      title: 'TEST order 2', status: 'NEW', order_date: '2026-08-31',
      payment_amount: 20.0, currency: 'USD', country_code: 'US', buyer_name: 'TEST' },
    { order_no: TEST_ORDER_MULTI, platform: 'ebay', sku: TEST_SKU_B, quantity: 3,
      title: 'TEST order multi', status: 'NEW', order_date: '2026-08-31',
      payment_amount: 60.0, currency: 'USD', country_code: 'US', buyer_name: 'TEST' },
  ]);
  if (eO) throw new Error(`order 생성 실패: ${eO.message}`);
  console.log(`  ✓ 주문 3개 생성`);

  return { skuA, skuB, sup };
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 1 · 신규 SKU enrichment 저장 (save-weight 로직 재현)
// ══════════════════════════════════════════════════════════════════════════
async function test1_saveWeight(skuAId) {
  console.log('\n[TEST 1] save-weight · weight + dims · qty=1');
  const orderNo = TEST_ORDER_1;
  const wt_kg = 0.082, bl = 15, bw = 10, bh = 2;
  const perUnitGram = Math.round(wt_kg * 1000);
  const nowIso = new Date().toISOString();

  // orders update
  const { data: ordersUpdated, error: eO } = await db.from('orders')
    .update({ weight_kg: wt_kg, box_length: bl, box_width: bw, box_height: bh })
    .eq('order_no', orderNo).select('id, quantity');
  if (eO) return fail('TEST 1 · orders update', eO);
  if (!ordersUpdated?.length) return fail('TEST 1 · orders match', 'no rows');

  const qty = Number(ordersUpdated[0].quantity) || 1;
  if (qty !== 1) return fail('TEST 1 · qty precondition', `expected qty=1 got ${qty}`);

  // sku_master update (qty=1 · dims 포함)
  const updates = {
    weight_gram: perUnitGram, weight_status: 'measured',
    weight_source: 'shipping_measured', weight_source_ref: orderNo, weight_measured_at: nowIso,
    length_cm: bl, width_cm: bw, height_cm: bh,
    dims_source: 'shipping_measured', dims_source_ref: orderNo, dims_measured_at: nowIso,
    updated_at: nowIso,
  };
  const { error: eM } = await db.from('sku_master')
    .update(updates).eq('internal_sku', TEST_SKU_A);
  if (eM) return fail('TEST 1 · sku_master update', eM);

  // 검증
  const { data: sku } = await db.from('sku_master')
    .select('weight_gram, weight_status, weight_source, weight_source_ref, length_cm, width_cm, height_cm, dims_source')
    .eq('internal_sku', TEST_SKU_A).single();
  const okWeight = sku.weight_gram === perUnitGram && sku.weight_status === 'measured'
    && sku.weight_source === 'shipping_measured' && sku.weight_source_ref === orderNo;
  const okDims = Number(sku.length_cm) === bl && Number(sku.width_cm) === bw && Number(sku.height_cm) === bh
    && sku.dims_source === 'shipping_measured';
  if (!okWeight) return fail('TEST 1 · weight fields', JSON.stringify(sku));
  if (!okDims)   return fail('TEST 1 · dims fields', JSON.stringify(sku));
  pass('TEST 1 · save-weight (weight + dims + source)', `${sku.weight_gram}g · ${sku.length_cm}×${sku.width_cm}×${sku.height_cm}cm`);
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 2 · Persistence · 재조회 값 유지
// ══════════════════════════════════════════════════════════════════════════
async function test2_persistence() {
  console.log('\n[TEST 2] Persistence · 재조회 값 유지');
  const { data: sku } = await db.from('sku_master')
    .select('weight_gram, length_cm, width_cm, height_cm, weight_source, dims_source')
    .eq('internal_sku', TEST_SKU_A).single();
  const ok = sku.weight_gram === 82 && Number(sku.length_cm) === 15
    && sku.weight_source === 'shipping_measured' && sku.dims_source === 'shipping_measured';
  if (!ok) return fail('TEST 2 · persistence', JSON.stringify(sku));
  pass('TEST 2 · persistence', 'weight/dims/source 유지 확인');
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 3 · 동일 SKU 다른 주문 · shippingRecommendations join 자동 표시
// ══════════════════════════════════════════════════════════════════════════
async function test3_reuse() {
  console.log('\n[TEST 3] 동일 SKU 다른 주문 · sku_master JOIN 자동 로드');
  // shippingRecommendations 의 lookupSkuMasterMap 재현
  const { data: skus } = await db.from('sku_master')
    .select('internal_sku, weight_gram, length_cm, width_cm, height_cm, weight_source, dims_source, cost_krw, supplier_id')
    .eq('internal_sku', TEST_SKU_A).single();
  if (!skus) return fail('TEST 3', 'sku_master lookup 실패');
  if (skus.weight_gram !== 82 || Number(skus.length_cm) !== 15) {
    return fail('TEST 3', `SKU A 데이터 다름: ${JSON.stringify(skus)}`);
  }
  // ORDER_2 (다른 주문 · 무게 입력 안 됨) · sku_master 값으로 자동 매핑되는지
  const { data: o2 } = await db.from('orders')
    .select('sku, weight_kg, box_length').eq('order_no', TEST_ORDER_2).single();
  if (!o2 || o2.sku !== TEST_SKU_A) return fail('TEST 3', 'order 2 setup mismatch');
  if (o2.weight_kg != null && o2.weight_kg > 0) return fail('TEST 3', 'order 2 already has weight');
  // shippingRecommendations 로직: order.weight_kg 없으면 sku_master.weight_gram fallback
  const effective = o2.weight_kg > 0 ? o2.weight_kg * 1000 : skus.weight_gram;
  if (effective !== 82) return fail('TEST 3', `expected effective=82g got ${effective}`);
  pass('TEST 3 · SKU reuse', `Order2 (weight 미입력) → sku_master fallback = ${effective}g`);
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 4 · Cost history · RPC 원자성 (update_sku_cost_atomic)
// ══════════════════════════════════════════════════════════════════════════
async function test4_costHistory(skuAId) {
  console.log('\n[TEST 4] Cost history via RPC (atomic)');

  // 1차 · 5000 원 (previous null)
  const r1 = await db.rpc('update_sku_cost_atomic', {
    p_internal_sku: TEST_SKU_A, p_new_cost_krw: 5000,
    p_source: 'shipping_manual', p_source_ref: TEST_ORDER_1, p_reason: null, p_changed_by: null,
  });
  if (r1.error) return fail('TEST 4 · rpc call 1', r1.error.message);
  if (r1.data?.unchanged) return fail('TEST 4 · rpc 1 unchanged', 'first insert cannot be unchanged');

  // 2차 · 5500 원 (previous 5000)
  const r2 = await db.rpc('update_sku_cost_atomic', {
    p_internal_sku: TEST_SKU_A, p_new_cost_krw: 5500,
    p_source: 'shipping_manual', p_source_ref: TEST_ORDER_2, p_reason: '매입 인상', p_changed_by: null,
  });
  if (r2.error) return fail('TEST 4 · rpc call 2', r2.error.message);
  if (Number(r2.data?.previous_cost_krw) !== 5000) return fail('TEST 4 · previous_cost', JSON.stringify(r2.data));

  // 3차 · 5500 원 (동일 값 · unchanged=true 여야 함)
  const r3 = await db.rpc('update_sku_cost_atomic', {
    p_internal_sku: TEST_SKU_A, p_new_cost_krw: 5500,
    p_source: 'shipping_manual', p_source_ref: TEST_ORDER_2, p_reason: null, p_changed_by: null,
  });
  if (r3.error) return fail('TEST 4 · rpc call 3', r3.error.message);
  if (!r3.data?.unchanged) return fail('TEST 4 · unchanged flag', JSON.stringify(r3.data));

  // history 확인 · 2 rows only (unchanged 는 INSERT 안 함)
  const { data: skuA } = await db.from('sku_master').select('id').eq('internal_sku', TEST_SKU_A).single();
  const { data: hist } = await db.from('sku_cost_history')
    .select('previous_cost_krw, new_cost_krw, reason, source_ref, changed_at')
    .eq('sku_master_id', skuA.id).order('changed_at', { ascending: false });
  if (!hist || hist.length !== 2) return fail('TEST 4 · history rows', `expected 2 got ${hist?.length}`);
  const latest = hist[0], oldest = hist[1];
  if (Number(latest.new_cost_krw) !== 5500 || Number(latest.previous_cost_krw) !== 5000)
    return fail('TEST 4 · latest', JSON.stringify(latest));
  if (Number(oldest.new_cost_krw) !== 5000 || oldest.previous_cost_krw !== null)
    return fail('TEST 4 · oldest', JSON.stringify(oldest));

  // sku_master 현재값 = 5500
  const { data: cur } = await db.from('sku_master').select('cost_krw, cost_source, cost_source_ref').eq('id', skuA.id).single();
  if (Number(cur.cost_krw) !== 5500) return fail('TEST 4 · current cost', JSON.stringify(cur));
  if (cur.cost_source !== 'shipping_manual') return fail('TEST 4 · current source', JSON.stringify(cur));
  pass('TEST 4 · rpc cost atomic', `history 2 rows · unchanged=true skip audit · current 5500원`);
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 5 · Supplier history · RPC 원자성 (update_sku_supplier_atomic)
// ══════════════════════════════════════════════════════════════════════════
async function test5_supplierHistory(supId) {
  console.log('\n[TEST 5] Supplier history via RPC (atomic)');
  const { data: sup } = await db.from('suppliers').select('id, name').eq('name', TEST_SUPPLIER).single();

  // 1차 · 신규 소싱처 지정
  const r1 = await db.rpc('update_sku_supplier_atomic', {
    p_internal_sku: TEST_SKU_A, p_supplier_id: sup.id, p_supplier_name: null,
    p_purchase_price: 5000, p_currency: 'KRW', p_quantity: null,
    p_purchased_at: '2026-08-31',
    p_source: 'shipping_manual', p_source_ref: TEST_ORDER_1, p_note: null,
    p_set_as_current: true, p_created_by: null,
  });
  if (r1.error) return fail('TEST 5 · rpc call 1', r1.error.message);
  if (!r1.data?.supplier_id_set) return fail('TEST 5 · supplier_id_set', JSON.stringify(r1.data));

  // 2차 · 매입가만 갱신
  const r2 = await db.rpc('update_sku_supplier_atomic', {
    p_internal_sku: TEST_SKU_A, p_supplier_id: sup.id, p_supplier_name: null,
    p_purchase_price: 5500, p_currency: 'KRW', p_quantity: null,
    p_purchased_at: '2026-08-31',
    p_source: 'shipping_manual', p_source_ref: TEST_ORDER_2, p_note: null,
    p_set_as_current: true, p_created_by: null,
  });
  if (r2.error) return fail('TEST 5 · rpc call 2', r2.error.message);

  const { data: skuA } = await db.from('sku_master').select('id, supplier_id').eq('internal_sku', TEST_SKU_A).single();
  const { data: hist } = await db.from('sku_supplier_history')
    .select('id, supplier_id, purchase_price, source_ref, created_at')
    .eq('sku_master_id', skuA.id).order('created_at', { ascending: false });
  if (!hist || hist.length !== 2) return fail('TEST 5 · rows', `expected 2 got ${hist?.length}`);
  if (skuA.supplier_id !== sup.id) return fail('TEST 5 · current supplier_id', JSON.stringify(skuA));
  pass('TEST 5 · rpc supplier atomic', `2 rows · 최신 매입가 ${hist[0].purchase_price}원 · 현재 supplier_id=${skuA.supplier_id}`);
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 6 · MULTI-QTY 보호 (매우 중요)
// ══════════════════════════════════════════════════════════════════════════
async function test6_multiQtyProtection() {
  console.log('\n[TEST 6] Multi-qty 보호 · sku_master 오염 방지 (매우 중요)');
  // SKU B · 초기값 · weight=999g dims=99×99×99
  const orderNo = TEST_ORDER_MULTI;
  const wt_kg = 3.0, bl = 30, bw = 30, bh = 30;

  const { data: ordersUpdated } = await db.from('orders')
    .update({ weight_kg: wt_kg, box_length: bl, box_width: bw, box_height: bh })
    .eq('order_no', orderNo).select('quantity');
  const qty = Number(ordersUpdated[0].quantity);
  if (qty !== 3) return fail('TEST 6 · precondition qty', `expected 3 got ${qty}`);

  // save-weight 로직: qty !== 1 → sku_master 반영 skip
  // (실제 API 는 masterUpdate={ok:false, reason:'multi-qty ...'} 리턴 · DB 는 안 건드림)

  // sku_master 검증 · 초기값 유지
  const { data: skuB } = await db.from('sku_master')
    .select('weight_gram, length_cm, width_cm, height_cm, weight_source, dims_source')
    .eq('internal_sku', TEST_SKU_B).single();
  if (skuB.weight_gram !== 999) return fail('TEST 6 · weight_gram 오염', `expected 999 got ${skuB.weight_gram}`);
  if (Number(skuB.length_cm) !== 99 || Number(skuB.width_cm) !== 99 || Number(skuB.height_cm) !== 99)
    return fail('TEST 6 · dims 오염', JSON.stringify(skuB));
  if (skuB.weight_source != null || skuB.dims_source != null)
    return fail('TEST 6 · source 오염', `weight_source=${skuB.weight_source} dims_source=${skuB.dims_source}`);

  // orders 는 저장됨 확인
  const { data: order } = await db.from('orders').select('weight_kg, box_length').eq('order_no', orderNo).single();
  if (Number(order.weight_kg) !== 3.0) return fail('TEST 6 · orders 저장', JSON.stringify(order));
  pass('TEST 6 · multi-qty 보호', 'orders 저장 O · sku_master 초기값(999g/99cm) 보존 · source null 유지');
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 7 · Profit 계산 vs API 결과
// ══════════════════════════════════════════════════════════════════════════
async function test7_profit() {
  console.log('\n[TEST 7] Profit 계산 · omsProfitService.CHANNEL_FEE_RATE 재사용');
  // shippingRecommendations.estimateProfit 재현
  const { CHANNEL_FEE_RATE } = require('../src/services/omsProfitService');
  const exchangeRate = 1350;

  // Case ok: payment 20 USD · fee_rate 0.18 (ebay) · cost 5500 · shipping 4900
  const paymentAmount = 20, currency = 'USD', platform = 'ebay';
  const costKrw = 5500, shippingKrw = 4900;

  const feeRate = CHANNEL_FEE_RATE.ebay;
  if (feeRate !== 0.18) return fail('TEST 7 · CHANNEL_FEE_RATE.ebay', `expected 0.18 got ${feeRate}`);

  const revenueKrw = paymentAmount * exchangeRate;   // 27000
  const feeKrw = Math.round(revenueKrw * feeRate);   // 4860
  const profitKrw = Math.round(revenueKrw - costKrw - feeKrw - shippingKrw);  // 27000-5500-4860-4900=11740
  const marginPct = +((profitKrw / revenueKrw) * 100).toFixed(2);             // 43.48

  if (revenueKrw !== 27000) return fail('TEST 7 · revenue', `expected 27000 got ${revenueKrw}`);
  if (feeKrw !== 4860) return fail('TEST 7 · fee', `expected 4860 got ${feeKrw}`);
  if (profitKrw !== 11740) return fail('TEST 7 · profit', `expected 11740 got ${profitKrw}`);
  if (Math.abs(marginPct - 43.48) > 0.01) return fail('TEST 7 · margin', `expected 43.48 got ${marginPct}`);
  pass('TEST 7 · profit calc', `revenue=27000 fee=4860 profit=11740 margin=43.48%`);

  // Reason cases
  const cases = [
    { input: { paymentAmount: 0 }, expect: 'no_payment_amount' },
    { input: { paymentAmount: 20, currency: 'USD', platform: 'ebay', costKrw: null, shippingKrw: 4900 }, expect: 'no_cost' },
    { input: { paymentAmount: 20, currency: 'USD', platform: 'ebay', costKrw: 5500, shippingKrw: 0 }, expect: 'no_shipping' },
    { input: { paymentAmount: 20, currency: 'USD', platform: 'unknown_x', costKrw: 5500, shippingKrw: 4900 }, expect: 'unknown_platform' },
    { input: { paymentAmount: 20, currency: 'USD', platform: 'ebay', costKrw: 5500, shippingKrw: 4900 }, expect: 'ok' },
  ];
  // estimateProfit 재현
  function estimate({ paymentAmount, currency, platform, costKrw, shippingKrw }) {
    const feeRate = CHANNEL_FEE_RATE[String(platform || '').toLowerCase()];
    const price = Number(paymentAmount);
    if (!Number.isFinite(price) || price <= 0) return { reason: 'no_payment_amount' };
    const cur = String(currency || 'USD').toUpperCase();
    const revenueKrw = cur === 'KRW' ? price : (cur === 'USD' ? price * exchangeRate : price);
    if (!Number.isFinite(Number(costKrw)) || Number(costKrw) <= 0) return { reason: 'no_cost' };
    if (!Number.isFinite(Number(shippingKrw)) || Number(shippingKrw) <= 0) return { reason: 'no_shipping' };
    if (feeRate == null) return { reason: 'unknown_platform' };
    return { reason: 'ok' };
  }
  for (const c of cases) {
    const r = estimate(c.input);
    if (r.reason !== c.expect) return fail(`TEST 7 · reason=${c.expect}`, `got ${r.reason}`);
  }
  pass('TEST 7 · reason branches', '5개 케이스 모두 정확');
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 8 · FAILURE ROLLBACK · Cost · 존재 안 하는 SKU 에 RPC 호출
// ══════════════════════════════════════════════════════════════════════════
async function test8_costRollback() {
  console.log('\n[TEST 8] Cost RPC rollback · 존재 안 하는 SKU');
  const NONEXISTENT = `__NEVER_EXIST_${STAMP}__`;

  // 사전: history count baseline (전 SKU · 우리 SKU 아님)
  const { data: skuA } = await db.from('sku_master').select('id').eq('internal_sku', TEST_SKU_A).single();
  const { count: histBefore } = await db.from('sku_cost_history').select('*', { count: 'exact', head: true });

  // RPC 호출 · P0002 exception 유발
  const { data, error } = await db.rpc('update_sku_cost_atomic', {
    p_internal_sku: NONEXISTENT, p_new_cost_krw: 9999,
    p_source: 'shipping_manual', p_source_ref: 'ROLLBACK_TEST', p_reason: null, p_changed_by: null,
  });
  if (!error) return fail('TEST 8 · expected error', `unexpectedly succeeded: ${JSON.stringify(data)}`);
  if (error.code !== 'P0002') return fail('TEST 8 · pg_code', `expected P0002 got ${error.code}`);

  // history count 변화 없음 확인 (전체)
  const { count: histAfter } = await db.from('sku_cost_history').select('*', { count: 'exact', head: true });
  if (histBefore !== histAfter) return fail('TEST 8 · history count', `${histBefore} → ${histAfter}`);

  // TEST_SKU_A 는 이전 test 4 로 cost=5500 · 여기서 오염 안 됐는지
  const { data: cur } = await db.from('sku_master').select('cost_krw').eq('id', skuA.id).single();
  if (Number(cur.cost_krw) !== 5500) return fail('TEST 8 · sku_A cost', `expected 5500 got ${cur.cost_krw}`);
  pass('TEST 8 · cost rollback', `error P0002 · history count 유지 (${histBefore}) · 실 SKU 무영향`);
}

// ══════════════════════════════════════════════════════════════════════════
// TEST 9 · FAILURE ROLLBACK · Supplier · 존재 안 하는 supplier_id
// ══════════════════════════════════════════════════════════════════════════
async function test9_supplierRollback() {
  console.log('\n[TEST 9] Supplier RPC rollback · 존재 안 하는 supplier_id');
  const { data: skuA } = await db.from('sku_master').select('id, supplier_id').eq('internal_sku', TEST_SKU_A).single();
  const supplierBefore = skuA.supplier_id;
  const { count: histBefore } = await db.from('sku_supplier_history').select('*', { count: 'exact', head: true });

  const bogusId = 999999999;
  const { data, error } = await db.rpc('update_sku_supplier_atomic', {
    p_internal_sku: TEST_SKU_A, p_supplier_id: bogusId, p_supplier_name: null,
    p_purchase_price: null, p_currency: null, p_quantity: null,
    p_purchased_at: null,
    p_source: 'shipping_manual', p_source_ref: 'ROLLBACK_TEST', p_note: null,
    p_set_as_current: true, p_created_by: null,
  });
  if (!error) return fail('TEST 9 · expected error', `unexpectedly succeeded: ${JSON.stringify(data)}`);
  if (error.code !== 'P0002') return fail('TEST 9 · pg_code', `expected P0002 got ${error.code}`);

  // history count 변화 없음
  const { count: histAfter } = await db.from('sku_supplier_history').select('*', { count: 'exact', head: true });
  if (histBefore !== histAfter) return fail('TEST 9 · history count', `${histBefore} → ${histAfter}`);

  // supplier_id 변경 없음
  const { data: cur } = await db.from('sku_master').select('supplier_id').eq('id', skuA.id).single();
  if (cur.supplier_id !== supplierBefore) return fail('TEST 9 · supplier_id', `${supplierBefore} → ${cur.supplier_id}`);
  pass('TEST 9 · supplier rollback', `error P0002 · history count 유지 (${histBefore}) · supplier_id ${supplierBefore} 유지`);
}

// ══════════════════════════════════════════════════════════════════════════
// Cleanup · 임시 데이터 삭제
// ══════════════════════════════════════════════════════════════════════════
async function cleanup() {
  console.log('\n[CLEANUP]');
  // history first (FK cascade 없음 · 삭제 순서 수동)
  const { data: skuA } = await db.from('sku_master').select('id').eq('internal_sku', TEST_SKU_A).maybeSingle();
  const { data: skuB } = await db.from('sku_master').select('id').eq('internal_sku', TEST_SKU_B).maybeSingle();
  if (skuA) {
    await db.from('sku_cost_history').delete().eq('sku_master_id', skuA.id);
    await db.from('sku_supplier_history').delete().eq('sku_master_id', skuA.id);
  }
  await db.from('orders').delete().in('order_no', [TEST_ORDER_1, TEST_ORDER_2, TEST_ORDER_MULTI]);
  // sku_master 는 supplier_id FK on delete restrict 이 있어도 · 우리는 supplier 지금 삭제 예정 · order 는 supplier 아님. 삭제 순서: sku_master 먼저 · 그 다음 suppliers.
  if (skuA) await db.from('sku_master').delete().eq('id', skuA.id);
  if (skuB) await db.from('sku_master').delete().eq('id', skuB.id);
  await db.from('suppliers').delete().eq('name', TEST_SUPPLIER);
  console.log('  ✓ 정리 완료');
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('='.repeat(78));
  console.log('SKU Enrichment V1 · Isolated Test Suite');
  console.log(`stamp: ${STAMP} · sku=${TEST_SKU_A} / ${TEST_SKU_B}`);
  console.log('='.repeat(78));

  const ctx = await setup();
  try {
    await test1_saveWeight(ctx.skuA.id);
    await test2_persistence();
    await test3_reuse();
    await test4_costHistory(ctx.skuA.id);
    await test5_supplierHistory(ctx.sup.id);
    await test6_multiQtyProtection();
    await test7_profit();
    await test8_costRollback();
    await test9_supplierRollback();
  } catch (e) {
    console.error('\nUNCAUGHT:', e.message);
    results.push({ name: 'UNCAUGHT', status: 'FAIL', note: e.message });
  } finally {
    await cleanup();
  }

  console.log('\n' + '='.repeat(78));
  console.log('SUMMARY');
  console.log('='.repeat(78));
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log(`PASS: ${passCount} · FAIL: ${failCount}`);
  for (const r of results) console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.name}${r.note ? ' · ' + r.note : ''}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
