#!/usr/bin/env node
'use strict';
/**
 * probe-b2c-distribution.js — Phase 4 pre-implementation · READ-ONLY.
 * Production 데이터의 분포를 뽑아 threshold 를 데이터 기반으로 제안한다.
 *
 * 조사 항목:
 *   1) v_sku_b2c_scorecard 전체 크기 · stock_qty>0 · sales_90d>0 · cost_krw NULL 갯수
 *   2) inventory_value_krw 분포 (P50 · P75 · P90 · P95 · MAX)
 *   3) sales_90d 분포 (P50 · P75 · P90 · MAX)
 *   4) stock_age_days 분포 · inventory_movements 실 receipt 갯수 (proxy 비율 산출)
 *   5) v_sku_channel_matrix 상 자동 대상 4채널 (coupang/naver/11st/gmarket) 별 status 분포
 *   6) channel_eligibility 값 분포 (NULL / [] / explicit array)
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function loadAll(table, select) {
  const out = []; let off = 0;
  while (true) {
    const { data, error } = await db.from(table).select(select).range(off, off + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return out;
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a,b) => a - b);
  const idx = Math.floor((s.length - 1) * (p / 100));
  return s[idx];
}
function bucketCounts(arr, buckets) {
  const c = new Array(buckets.length + 1).fill(0);
  for (const v of arr) {
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      if (v <= buckets[i]) { c[i]++; placed = true; break; }
    }
    if (!placed) c[c.length - 1]++;
  }
  return buckets.map((b, i) => `≤${b}: ${c[i]}`).concat([`>${buckets[buckets.length-1]}: ${c[c.length-1]}`]);
}

(async () => {
  const sc = await loadAll('v_sku_b2c_scorecard',
    'sku_master_id,internal_sku,unit_cost,stock_qty,inventory_value_krw,stock_age_days,sales_90d,ebay_sales_90d,shopify_sales_90d,live_channels,registered_channels,observed_channels,missing_channels_seen,channel_eligibility');
  console.log('='.repeat(70));
  console.log('1. v_sku_b2c_scorecard 요약');
  console.log('='.repeat(70));
  console.log(`총 active SKU               : ${sc.length}`);
  console.log(`stock_qty > 0               : ${sc.filter(r => Number(r.stock_qty) > 0).length}`);
  console.log(`inventory_value_krw > 0     : ${sc.filter(r => Number(r.inventory_value_krw) > 0).length}`);
  console.log(`sales_90d > 0               : ${sc.filter(r => Number(r.sales_90d) > 0).length}`);
  console.log(`  ebay_sales_90d > 0        : ${sc.filter(r => Number(r.ebay_sales_90d) > 0).length}`);
  console.log(`  shopify_sales_90d > 0     : ${sc.filter(r => Number(r.shopify_sales_90d) > 0).length}`);
  console.log(`cost_krw IS NULL (unit_cost): ${sc.filter(r => r.unit_cost == null).length}`);
  console.log(`live_channels > 0           : ${sc.filter(r => Number(r.live_channels) > 0).length}`);

  console.log('\n' + '='.repeat(70));
  console.log('2. inventory_value_krw 분포 (stock_qty>0 AND cost 있는 SKU만)');
  console.log('='.repeat(70));
  const invValues = sc
    .filter(r => Number(r.stock_qty) > 0 && r.unit_cost != null)
    .map(r => Number(r.inventory_value_krw) || 0)
    .filter(v => v > 0);
  console.log(`N=${invValues.length}`);
  if (invValues.length) {
    console.log(`  MIN   : ₩${percentile(invValues, 0).toLocaleString('ko-KR')}`);
    console.log(`  P25   : ₩${percentile(invValues, 25).toLocaleString('ko-KR')}`);
    console.log(`  P50   : ₩${percentile(invValues, 50).toLocaleString('ko-KR')}`);
    console.log(`  P75   : ₩${percentile(invValues, 75).toLocaleString('ko-KR')}`);
    console.log(`  P90   : ₩${percentile(invValues, 90).toLocaleString('ko-KR')}`);
    console.log(`  P95   : ₩${percentile(invValues, 95).toLocaleString('ko-KR')}`);
    console.log(`  P99   : ₩${percentile(invValues, 99).toLocaleString('ko-KR')}`);
    console.log(`  MAX   : ₩${percentile(invValues, 100).toLocaleString('ko-KR')}`);
    console.log(`  현재 HIGH_VALUE_THRESHOLD (config)=₩500,000 · > 이 값 SKU: ${invValues.filter(v => v >= 500000).length}`);
    console.log(`  버킷: ${bucketCounts(invValues, [50000, 100000, 300000, 500000, 1000000, 3000000]).join(' · ')}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('3. sales_90d 분포 (>0 SKU만)');
  console.log('='.repeat(70));
  const salesValues = sc.filter(r => Number(r.sales_90d) > 0).map(r => Number(r.sales_90d));
  console.log(`N=${salesValues.length}`);
  if (salesValues.length) {
    console.log(`  P25   : ${percentile(salesValues, 25)}`);
    console.log(`  P50   : ${percentile(salesValues, 50)}`);
    console.log(`  P75   : ${percentile(salesValues, 75)}`);
    console.log(`  P90   : ${percentile(salesValues, 90)}`);
    console.log(`  P95   : ${percentile(salesValues, 95)}`);
    console.log(`  MAX   : ${percentile(salesValues, 100)}`);
    console.log(`  버킷: ${bucketCounts(salesValues, [1, 3, 5, 10, 20, 50]).join(' · ')}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('4. stock_age_days 분포 + inventory_movements 실 receipt 갯수');
  console.log('='.repeat(70));
  const ageValues = sc.filter(r => r.stock_age_days != null).map(r => Number(r.stock_age_days));
  console.log(`N (stock_age_days 있음) : ${ageValues.length}`);
  if (ageValues.length) {
    console.log(`  P25   : ${percentile(ageValues, 25)} 일`);
    console.log(`  P50   : ${percentile(ageValues, 50)} 일`);
    console.log(`  P75   : ${percentile(ageValues, 75)} 일`);
    console.log(`  P95   : ${percentile(ageValues, 95)} 일`);
    console.log(`  MAX   : ${percentile(ageValues, 100)} 일`);
  }
  const { count: mvTotal } = await db.from('inventory_movements').select('*',{count:'exact',head:true});
  const { count: mvReceipts } = await db.from('inventory_movements').select('*',{count:'exact',head:true}).eq('movement_type','receipt').gt('quantity_delta', 0);
  console.log(`inventory_movements 총    : ${mvTotal}`);
  console.log(`  movement_type='receipt' AND quantity_delta>0 : ${mvReceipts}`);
  const { data: mvSample } = await db.from('inventory_movements')
    .select('sku_master_id, movement_type, quantity_delta, occurred_at')
    .eq('movement_type','receipt').gt('quantity_delta',0).limit(50);
  const receiptSkuIds = new Set((mvSample || []).map(m => m.sku_master_id));
  console.log(`  distinct sku_master_id  : ${receiptSkuIds.size}`);
  console.log(`  → 위 ${receiptSkuIds.size} SKU 만 stock_age_confidence=high · 나머지 ${sc.length - receiptSkuIds.size} 개는 sku_created_at proxy (low)`);

  console.log('\n' + '='.repeat(70));
  console.log('5. v_sku_channel_matrix 자동 대상 4채널 · status 분포');
  console.log('='.repeat(70));
  const AUTO = ['coupang','naver','11st','gmarket'];
  for (const ch of AUTO) {
    const { data: rows } = await db.from('v_sku_channel_matrix').select('channel_status').eq('channel', ch);
    const cnt = new Map();
    for (const r of (rows || [])) cnt.set(r.channel_status, (cnt.get(r.channel_status) || 0) + 1);
    const total = rows?.length || 0;
    console.log(`  ${ch.padEnd(10)} · total=${total} · ${Array.from(cnt.entries()).sort().map(([k,v]) => `${k}=${v}`).join(', ')}`);
  }
  //   SKU 하나에 있어야 하는데 채널 자체가 view row 로 없으면 → NONE 으로 취급
  console.log(`  (참고: coupang/11st/gmarket 은 sku_listing_link 에 mapping 없어서 v_sku_channel_matrix 에 row=0 → SKU 별 build 시 NONE 처리)`);

  console.log('\n' + '='.repeat(70));
  console.log('6. channel_eligibility 분포');
  console.log('='.repeat(70));
  const el = sc.map(r => r.channel_eligibility);
  const elNull = el.filter(v => v === null || v === undefined).length;
  const elEmpty = el.filter(v => Array.isArray(v) && v.length === 0).length;
  const elExplicit = el.filter(v => Array.isArray(v) && v.length > 0).length;
  console.log(`  NULL (unspecified) : ${elNull}   ← default_eligibility_mode 로 결정`);
  console.log(`  []   (배제)        : ${elEmpty}`);
  console.log(`  explicit array     : ${elExplicit}`);
})().catch(e => { console.error(e.stack || e); process.exit(1); });
