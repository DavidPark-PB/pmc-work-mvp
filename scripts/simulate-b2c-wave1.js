#!/usr/bin/env node
'use strict';
/**
 * simulate-b2c-wave1.js — Phase 7.5 · Wave 1 dry-run · READ-ONLY.
 * 실제 DB write 안 함. Wave 1 (상위 3 SKU) 이 activate 되면 어떤 task 가 생성될지 미리보기.
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const { createClient } = require('@supabase/supabase-js');
const pilot = require('../src/services/b2cInventory/pilotSelection');
const waves = require('../src/services/b2cInventory/pilotWaves');
const queueRefill = require('../src/services/b2cInventory/queueRefill');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

(async () => {
  const now = new Date().toISOString();
  console.log('='.repeat(78));
  console.log(`B2C Wave 1 Dry-run · ${now}`);
  console.log('='.repeat(78));

  //   Full pilot preview
  const preview = await pilot.pilotPreview({ db, size: 50 });
  console.log(`\nPilot 전체: matched=${preview.total_pilot_matched} · selected=${preview.selected}`);

  //   Wave plan
  const plan = waves.planWaves(preview.top);
  console.log(`\nWave plan:`);
  plan.forEach(w => console.log(`  Wave ${w.id}: 요청 ${w.requested_sku_count} · 실제 ${w.actual_sku_count} · SKUs=${w.sku_ids.join(',')}`));

  //   Wave 1 상세
  const wave1SkuIds = waves.waveSkuIds(preview.top, 1);
  const wave1Top = preview.top.filter(t => wave1SkuIds.includes(Number(t.sku_master_id)));
  console.log(`\n\n=== WAVE 1 (상위 3 SKU) ===`);
  console.table(wave1Top.map((t, i) => ({
    rank: i + 1, sku_id: t.sku_master_id, internal_sku: t.internal_sku,
    lvl: t.priority_level, score: t.priority_score,
    stock: t.stock_qty, cost: t.cost_krw, inv_krw: t.inventory_value_krw,
    e_s90: t.ebay_sales_90d, s_s90: t.shopify_sales_90d,
    coupang: t.korea_channel_status.coupang,
    naver: t.korea_channel_status.naver,
    '11st': t.korea_channel_status['11st'],
    gmarket: t.korea_channel_status.gmarket,
    reasons: (t.reasons || []).slice(0, 2).join(' / '),
  })));

  //   예상 Task refill (skuIds=wave1 · pilot_max=100)
  //   Note: wave activate 하기 전이라 실제 config default_eligibility_mode=0 이면 eligible=false.
  //   실제 execute 흐름은 (a) wave activate → sku_master.channel_eligibility=KOREA_ALL (b) refill (default_mode 무관)
  //   Dry-run 은 "activate 후 refill 하면 뭐가 생성될까" 를 미리 보여줘야 하므로 WHAT-IF=1 로 시뮬레이션.
  const refill = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true, whatIfMode: 1,   //   WHAT-IF: activate 이후 상태 가정
    allocationStrategy: 'GLOBAL_PRIORITY', pilotMaxTasks: 100,
    skuIds: wave1SkuIds,
  });
  console.log(`\n=== Wave 1 예상 Task (refill dry-run) ===`);
  console.log(`후보 (candidates_evaluated=SKU*4채널): ${refill.candidates_evaluated}`);
  console.log(`filtered:`);
  for (const [k, v] of Object.entries(refill.filtered)) console.log(`  ${k}: ${v}`);
  console.log(`\n→ channel_tasks_planned: ${refill.channel_tasks_planned}`);

  //   plan 상세
  console.log(`\n=== Wave 1 생성 예정 Task 전체 (${refill.plan.length}건) ===`);
  console.table(refill.plan.map((t, i) => ({
    rank: i + 1, sku_id: t.related_sku_id, internal_sku: t.context.internal_sku,
    ch: t.channel, lvl: t.priority_level, score: t.priority_score,
    stock: t.context.stock_qty, cost: t.context.cost_krw, inv_krw: t.context.inventory_value_krw,
    e_s90: t.context.ebay_sales_90d,
  })));

  //   Stop conditions 재확인
  const stop = await waves.detectPilotStopConditions({ db, approvedSkuIds: wave1SkuIds });
  console.log(`\n=== Pilot Stop Conditions 감지 ===`);
  console.log(`stop_recommended: ${stop.stop_recommended}`);
  if (stop.conditions.length) {
    console.log('conditions:'); stop.conditions.forEach(c => console.log(`  · ${c.code}: ${JSON.stringify(c)}`));
  } else {
    console.log('  (none · 안전)');
  }

  //   현재 config 상태
  const { data: cfgRows } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled']);
  console.log(`\n=== Production Config 상태 ===`);
  (cfgRows || []).forEach(r => console.log(`  ${r.setting_key} = ${r.setting_value}`));

  //   실제 team_tasks 현황
  const { count: activeCr } = await db.from('team_tasks')
    .select('*', { count: 'exact', head: true })
    .in('status', ['pending','in_progress','qc_pending'])
    .like('exception_type', 'channel_register.%');
  console.log(`\n활성 CHANNEL_REGISTER task: ${activeCr}`);
})().catch(e => { console.error(e.stack || e); process.exit(1); });
