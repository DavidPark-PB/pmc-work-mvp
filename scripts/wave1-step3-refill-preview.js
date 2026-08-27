#!/usr/bin/env node
'use strict';
/**
 * wave1-step3-refill-preview.js — Wave 1 refill PREVIEW (dry-run · task INSERT 없음).
 *
 * Owner spec 조건 검증:
 *   execute_ready = true
 *   all_assigned = true
 *   unassigned_count = 0
 *   channel_tasks_planned = 11
 *   allocation: kimjy 5 (coupang 3 + naver 2) · noms 6 (11st 3 + gmarket 3)
 *   각 task: sku_id ∈ [2616,2290,6048] · priority_level=p0
 * 하나라도 미충족 시 STOP.
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const queueRefill = require('../src/services/b2cInventory/queueRefill');
const waves = require('../src/services/b2cInventory/pilotWaves');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const EXPECTED_SKUS = [2616, 2290, 6048];
const EXPECTED_TASKS = 11;
const EXPECTED_ALLOC = { kimjy: 5, noms: 6 };

(async () => {
  console.log('='.repeat(78));
  console.log('Wave 1 · STEP 3 · Refill Preview (DRY-RUN · Task INSERT 없음)');
  console.log('='.repeat(78));

  const result = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true, whatIfMode: null,   //   activate 완료 상태라 real config 사용
    allocationStrategy: 'GLOBAL_PRIORITY', pilotMaxTasks: 12,
    skuIds: EXPECTED_SKUS,
    assignmentMode: 'EXPLICIT_CHANNEL_OWNER',
    channelOwners: { coupang: 4, naver: 4, '11st': 5, gmarket: 5 },
  });

  if (result.ok === false) {
    console.log(`\n✗ ASSIGNMENT VALIDATION FAILED · code=${result.code}`);
    (result.assignment_errors || []).forEach(e => console.log(`  ${e.channel}: ${e.code} · ${e.message}`));
    process.exit(1);
  }

  //   summary check
  const s = result.assignment_summary;
  console.log(`\n=== Assignment Summary ===`);
  console.log(`total_tasks: ${s.total_tasks} · expected ${EXPECTED_TASKS} → ${s.total_tasks === EXPECTED_TASKS ? '✓' : '✗'}`);
  console.log(`unassigned_count: ${s.unassigned_count} · expected 0 → ${s.unassigned_count === 0 ? '✓' : '✗'}`);
  console.log(`all_assigned: ${s.all_assigned} · expected true → ${s.all_assigned ? '✓' : '✗'}`);

  //   plan 상세
  console.log(`\n=== Wave 1 정확한 11 Task 목록 ===`);
  const plan = result.plan;
  console.table(plan.map((t, i) => ({
    rank: i+1, sku_id: t.related_sku_id, sku: t.context.internal_sku,
    channel: t.channel, lvl: t.priority_level, score: t.priority_score,
    assignee_id: t.assignee_id, assignee_scope: t.assignee_scope,
    stock: t.context.stock_qty, cost: t.context.cost_krw, inv_krw: t.context.inventory_value_krw,
    e_s90: t.context.ebay_sales_90d,
  })));

  //   각 task 조건 검증
  let allValid = true;
  for (const t of plan) {
    const skuOk = EXPECTED_SKUS.includes(Number(t.related_sku_id));
    const lvlOk = t.priority_level === 'p0';
    const assigneeOk = t.assignee_id === 4 || t.assignee_id === 5;
    const scopeOk = t.assignee_scope === 'specific';
    if (!skuOk || !lvlOk || !assigneeOk || !scopeOk) {
      console.log(`⚠ task 조건 불일치: sku=${t.related_sku_id}(${skuOk}) lvl=${t.priority_level}(${lvlOk}) assignee=${t.assignee_id}(${assigneeOk}) scope=${t.assignee_scope}(${scopeOk})`);
      allValid = false;
    }
  }
  console.log(`\n조건: 모든 task sku ∈ [${EXPECTED_SKUS.join(',')}] · p0 · assignee ∈ {4,5} · scope=specific → ${allValid ? '✓' : '✗'}`);

  //   assignee 별 count
  const perUser = new Map();
  for (const t of plan) perUser.set(t.assignee_id, (perUser.get(t.assignee_id) || 0) + 1);
  const kimjyCount = perUser.get(4) || 0;
  const nomsCount = perUser.get(5) || 0;
  console.log(`\n=== Assignee 별 Count ===`);
  console.log(`kimjy (id=4): ${kimjyCount} · expected ${EXPECTED_ALLOC.kimjy} → ${kimjyCount === EXPECTED_ALLOC.kimjy ? '✓' : '✗'}`);
  console.log(`noms  (id=5): ${nomsCount} · expected ${EXPECTED_ALLOC.noms}  → ${nomsCount === EXPECTED_ALLOC.noms ? '✓' : '✗'}`);

  //   channel 별 count
  const perCh = {};
  for (const t of plan) perCh[t.channel] = (perCh[t.channel] || 0) + 1;
  console.log(`\n=== Channel 별 Count ===`);
  for (const [ch, n] of Object.entries(perCh)) console.log(`  ${ch}: ${n}`);

  //   Stop conditions 재확인
  const stop = await waves.detectPilotStopConditions({ db, approvedSkuIds: EXPECTED_SKUS });
  console.log(`\n=== Stop Conditions ===`);
  console.log(`stop_recommended: ${stop.stop_recommended} · ${stop.conditions.length === 0 ? '✓ 안전' : '⚠'}`);
  if (stop.conditions.length) stop.conditions.forEach(c => console.log(`  ${c.code}: ${JSON.stringify(c)}`));

  //   config 재확인
  const { data: cfgRows } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled']);
  console.log(`\n=== Global Config (모두 OFF 확인) ===`);
  const cfg = {};
  (cfgRows || []).forEach(r => { cfg[r.setting_key] = Number(r.setting_value); console.log(`  ${r.setting_key} = ${r.setting_value}`); });
  const allOff = cfg['b2c.scheduler_enabled'] === 0 && cfg['b2c.auto_assignment_enabled'] === 0 && cfg['b2c.data_quality_auto_enabled'] === 0;
  console.log(`Global 3개 OFF: ${allOff ? '✓' : '✗'}`);

  //   최종 판정
  const gateOk =
    s.total_tasks === EXPECTED_TASKS &&
    s.all_assigned === true &&
    s.unassigned_count === 0 &&
    allValid &&
    kimjyCount === EXPECTED_ALLOC.kimjy &&
    nomsCount === EXPECTED_ALLOC.noms &&
    !stop.stop_recommended &&
    allOff;

  //   save preview snapshot
  const outDir = '/Users/parksungmin/pmc-work-mvp/exports/b2c-inventory';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `wave1_refill_preview_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    at: new Date().toISOString(),
    result: { ...result, plan_preview: plan.slice(0, 30), plan: undefined },
    plan_full: plan.map(t => ({
      sku_master_id: t.related_sku_id, internal_sku: t.context.internal_sku,
      channel: t.channel, priority_level: t.priority_level, priority_score: t.priority_score,
      assignee_id: t.assignee_id, assignee_scope: t.assignee_scope,
      cost_krw: t.context.cost_krw, stock_qty: t.context.stock_qty,
      inventory_value_krw: t.context.inventory_value_krw,
      ebay_sales_90d: t.context.ebay_sales_90d,
      dedupe_key: t.dedupe_key,
    })),
    assignee_count: { kimjy: kimjyCount, noms: nomsCount },
    channel_count: perCh,
    execute_ready: result.execute_ready ?? gateOk,
    gate_ok: gateOk,
    stop_conditions: stop,
    config: cfg,
  }, null, 2));
  console.log(`\n스냅샷: ${outPath}`);

  console.log('\n' + '='.repeat(78));
  console.log(gateOk ? '✓ STEP 3 SUCCESS · CHECKPOINT · Owner 최종 GO 대기'
                    : '✗ STEP 3 조건 미충족 · STOP');
  console.log('='.repeat(78));
  console.log('\n⚠ Task INSERT 는 아직 실행 안 됨. Owner 명시 GO 후 다음:');
  console.log('   POST /api/b2c/tasks/channel-register/refill');
  console.log('   Body: (STEP 3 request 와 동일)');
  if (!gateOk) process.exit(1);
})().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
