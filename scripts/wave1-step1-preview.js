#!/usr/bin/env node
'use strict';
/**
 * wave1-step1-preview.js — Wave 1 최신 프로덕션 데이터로 preview.
 * eligibility 변경 없음 · READ-ONLY.
 * Expected: SKUs = [2616, 2290, 6048] · task ≈ 11
 * 불일치 시 STOP.
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const { createClient } = require('@supabase/supabase-js');
const pilot = require('../src/services/b2cInventory/pilotSelection');
const waves = require('../src/services/b2cInventory/pilotWaves');
const queueRefill = require('../src/services/b2cInventory/queueRefill');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const EXPECTED_SKUS = [2616, 2290, 6048];
const EXPECTED_TASKS = 11;

(async () => {
  console.log('='.repeat(78));
  console.log('Wave 1 · STEP 1 · Preview (READ-ONLY · eligibility 변경 없음)');
  console.log('='.repeat(78));

  const preview = await pilot.pilotPreview({ db, size: 50 });
  console.log(`\npilot_size: 50 · matched: ${preview.total_pilot_matched} · selected: ${preview.selected}`);

  const wave1SkuIds = waves.waveSkuIds(preview.top, 1);
  console.log(`\nWave 1 예상 SKUs: [${wave1SkuIds.join(',')}]`);
  console.log(`Expected:         [${EXPECTED_SKUS.join(',')}]`);

  const skuMatch = wave1SkuIds.length === EXPECTED_SKUS.length &&
    wave1SkuIds.every((v, i) => v === EXPECTED_SKUS[i]);
  console.log(`SKU 일치: ${skuMatch ? '✓' : '✗ MISMATCH · STOP'}`);
  if (!skuMatch) {
    console.log('\n예상 SKU 와 실제 preview SKU 가 다름. Owner 확인 필요. STOP.');
    process.exit(1);
  }

  //   예상 task 수 (WHAT-IF 모드로 확인 · activate 후 시나리오)
  const refillDry = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true, whatIfMode: 1,
    allocationStrategy: 'GLOBAL_PRIORITY', pilotMaxTasks: 12,
    skuIds: wave1SkuIds,
  });
  console.log(`\n예상 Task 수 (WHAT-IF · pilot_max=12): ${refillDry.channel_tasks_planned}`);
  console.log(`Expected: ${EXPECTED_TASKS}`);
  const taskMatch = refillDry.channel_tasks_planned === EXPECTED_TASKS;
  console.log(`Task 수 일치: ${taskMatch ? '✓' : `⚠ 실제 ${refillDry.channel_tasks_planned} · 예상 ${EXPECTED_TASKS}`}`);
  if (Math.abs(refillDry.channel_tasks_planned - EXPECTED_TASKS) > 2) {
    console.log('\n예상 task 수와 크게 다름 (> 2건 차이). Owner 확인 필요. STOP.');
    process.exit(1);
  }

  //   3 SKU 각각 상세
  console.log(`\n=== Wave 1 SKU 상세 ===`);
  const details = preview.top.filter(t => wave1SkuIds.includes(Number(t.sku_master_id)));
  console.table(details.map(t => ({
    rank: t.rank, sku_id: t.sku_master_id, internal_sku: t.internal_sku,
    lvl: t.priority_level, score: t.priority_score,
    stock: t.stock_qty, cost: t.cost_krw, inv_krw: t.inventory_value_krw,
    e_s90: t.ebay_sales_90d, s_s90: t.shopify_sales_90d,
  })));

  //   현재 eligibility 상태 (activate 전이라 모두 NULL 이어야)
  const { data: skuRows } = await db.from('sku_master')
    .select('id, internal_sku, channel_eligibility').in('id', wave1SkuIds);
  console.log(`\n현재 eligibility (activate 전):`);
  (skuRows || []).forEach(r => console.log(`  id=${r.id} · ${r.internal_sku} · eligibility=${JSON.stringify(r.channel_eligibility)}`));

  console.log('\n' + '='.repeat(78));
  console.log(skuMatch && taskMatch
    ? '✓ STEP 1 SUCCESS · STEP 2 진행 가능'
    : '⚠ STEP 1 조건 부분 불일치 · Owner 확인 필요');
  console.log('='.repeat(78));
})().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
