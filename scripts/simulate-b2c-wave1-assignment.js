#!/usr/bin/env node
'use strict';
/**
 * simulate-b2c-wave1-assignment.js — Phase 7.6 · Wave 1 assignment simulation (READ-ONLY).
 * 11 task 가 두 operator 에게 정확히 어떻게 분배되는지 미리보기.
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const { createClient } = require('@supabase/supabase-js');
const pilot = require('../src/services/b2cInventory/pilotSelection');
const waves = require('../src/services/b2cInventory/pilotWaves');
const queueRefill = require('../src/services/b2cInventory/queueRefill');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

//   시나리오: Operator A=coupang+naver · Operator B=11st+gmarket
//   실제 user id 는 관리자 화면에서 결정 · 여기서는 4명 후보 중 앞 2명 (id=4 kimjy, id=5 noms) 사용 예
const OPERATOR_A_ID = Number(process.argv[2]) || 4;
const OPERATOR_B_ID = Number(process.argv[3]) || 5;

(async () => {
  console.log('='.repeat(78));
  console.log('B2C Wave 1 Assignment Simulation · READ-ONLY');
  console.log(`Operator A user_id: ${OPERATOR_A_ID} (coupang + naver)`);
  console.log(`Operator B user_id: ${OPERATOR_B_ID} (11st + gmarket)`);
  console.log('='.repeat(78));

  //   Wave 1 sku ids
  const preview = await pilot.pilotPreview({ db, size: 50 });
  const wave1SkuIds = waves.waveSkuIds(preview.top, 1);
  console.log(`\nWave 1 SKUs: ${wave1SkuIds.join(',')}`);

  //   Preview with EXPLICIT_CHANNEL_OWNER
  const result = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true,
    whatIfMode: 1,   //   WHAT-IF: activate 이후 상태
    allocationStrategy: 'GLOBAL_PRIORITY',
    pilotMaxTasks: 12,
    skuIds: wave1SkuIds,
    assignmentMode: 'EXPLICIT_CHANNEL_OWNER',
    channelOwners: {
      coupang: OPERATOR_A_ID,
      naver:   OPERATOR_A_ID,
      '11st':  OPERATOR_B_ID,
      gmarket: OPERATOR_B_ID,
    },
  });

  if (!result.ok) {
    console.log(`\n❌ validation FAILED · code=${result.code}`);
    console.log('errors:');
    (result.assignment_errors || []).forEach(e => console.log(`  · ${e.channel || '-'}: ${e.code} · ${e.message}`));
    console.log('\n→ Wave 1 실행 안전 · owner 조건 미충족');
    return;
  }

  console.log(`\n✓ validation OK · execute_ready 판정 준비 완료`);
  console.log(`plan 총: ${result.channel_tasks_planned}`);
  console.log(`assignment_mode: ${result.assignment_mode}`);

  const s = result.assignment_summary;
  console.log(`\nAssignment Summary:`);
  console.log(`  total_tasks: ${s.total_tasks}`);
  console.log(`  unassigned: ${s.unassigned_count}`);
  console.log(`  all_assigned: ${s.all_assigned}`);
  console.log(`\n채널별 배정:`);
  console.table(Object.values(s.by_channel));

  //   task 상세
  console.log(`\n=== Wave 1 예정 Task ${result.plan.length}건 (assignee 포함) ===`);
  console.table(result.plan.map((t, i) => ({
    rank: i + 1,
    sku_id: t.related_sku_id,
    internal_sku: t.context.internal_sku,
    channel: t.channel,
    lvl: t.priority_level,
    score: t.priority_score,
    assignee_id: t.assignee_id,
    assignee_scope: t.assignee_scope,
  })));

  //   count per assignee
  const perUser = new Map();
  for (const t of result.plan) {
    perUser.set(t.assignee_id, (perUser.get(t.assignee_id) || 0) + 1);
  }
  console.log(`\n예상 assignee count:`);
  for (const [uid, count] of perUser.entries()) console.log(`  user_id=${uid}: ${count} tasks`);

  //   config check
  console.log(`\nGlobal Auto Assignment config (변경 없음 확인):`);
  const { data: cfgRows } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled']);
  (cfgRows || []).forEach(r => console.log(`  ${r.setting_key} = ${r.setting_value}`));
})().catch(e => { console.error(e.stack || e); process.exit(1); });
