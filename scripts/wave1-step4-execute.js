#!/usr/bin/env node
'use strict';
/**
 * wave1-step4-execute.js — Owner FINAL GO (2026-08-26) · Wave 1 Production Execute.
 *
 * 순서:
 *   1) Pre-execute Safety Check (config OFF · stop=false · active=0 · approved SKUs 확인)
 *   2) 정확히 1회 refillChannelRegistrationQueue({ dryRun: false, ... })
 *   3) Post-insert DB verification
 *   4) Employee visibility (kimjy 5 · noms 6 · other tasks 비노출)
 *   5) Save execute snapshot
 *
 * 하나라도 실패 시 STOP · exit 1.
 * INSERT 는 반드시 1회 · 추가 실행 절대 안 함.
 */
require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const queueRefill = require('../src/services/b2cInventory/queueRefill');
const waves = require('../src/services/b2cInventory/pilotWaves');
const nextTask = require('../src/services/b2cInventory/nextTask');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const APPROVED_SKUS = [2616, 2290, 6048];
const REQUEST_BODY = {
  pilot_max_tasks: 12,
  sku_ids: APPROVED_SKUS,
  assignment_mode: 'EXPLICIT_CHANNEL_OWNER',
  channel_owners: { coupang: 4, naver: 4, '11st': 5, gmarket: 5 },
};

async function stop(msg) {
  console.error('\n' + '='.repeat(78));
  console.error(`✗ STOP · ${msg}`);
  console.error('='.repeat(78));
  process.exit(1);
}

(async () => {
  const runIso = new Date().toISOString();
  console.log('='.repeat(78));
  console.log(`Wave 1 · STEP 4 · Production Execute · ${runIso}`);
  console.log('='.repeat(78));

  //   ── 1) Pre-execute Safety Check ────────────────
  console.log('\n[1] Pre-execute Safety Check');
  const { data: cfgRows } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled']);
  const cfg = {}; (cfgRows || []).forEach(r => cfg[r.setting_key] = Number(r.setting_value));
  const configOff = cfg['b2c.scheduler_enabled'] === 0 && cfg['b2c.auto_assignment_enabled'] === 0 && cfg['b2c.data_quality_auto_enabled'] === 0;
  console.log(`  config OFF (3개): ${configOff ? '✓' : '✗ STOP'} · ${JSON.stringify(cfg)}`);
  if (!configOff) await stop('config 3개 중 하나 이상 ON');

  const stopSig = await waves.detectPilotStopConditions({ db, approvedSkuIds: APPROVED_SKUS });
  console.log(`  stop_recommended: ${stopSig.stop_recommended ? '✗ STOP · ' + JSON.stringify(stopSig.conditions) : '✓ false'}`);
  if (stopSig.stop_recommended) await stop('stop condition 감지됨');

  const { count: activeCr } = await db.from('team_tasks').select('*', { count: 'exact', head: true })
    .in('status', ['pending','in_progress','qc_pending'])
    .like('exception_type', 'channel_register.%')
    .in('related_sku_id', APPROVED_SKUS);
  console.log(`  active CHANNEL_REGISTER for approved SKUs: ${activeCr} · expected 0 · ${activeCr === 0 ? '✓' : '✗ STOP'}`);
  if (Number(activeCr) !== 0) await stop(`이미 active tasks 존재: ${activeCr}건`);

  //   approved SKU eligibility 확인
  const { data: skuRows } = await db.from('sku_master')
    .select('id, internal_sku, channel_eligibility').in('id', APPROVED_SKUS);
  const eligible = (skuRows || []).every(r => Array.isArray(r.channel_eligibility) && r.channel_eligibility.length === 4);
  console.log(`  approved 3 SKU eligibility 활성 확인: ${eligible ? '✓' : '✗ STOP'}`);
  if (!eligible) await stop('approved SKU eligibility 미활성');

  //   ── 2) Production Execute (정확히 1회) ──────
  console.log('\n[2] Production Execute · refillChannelRegistrationQueue(dryRun=false, ...)');
  const result = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: false, whatIfMode: null,
    allocationStrategy: 'GLOBAL_PRIORITY',
    pilotMaxTasks: REQUEST_BODY.pilot_max_tasks,
    skuIds: REQUEST_BODY.sku_ids,
    assignmentMode: REQUEST_BODY.assignment_mode,
    channelOwners: REQUEST_BODY.channel_owners,
    userId: 'owner_wave1_final_go',
    createdBy: 2,   //   owner (사장 · 기존 team_tasks 관습) · FK 방어
  });

  if (result.ok === false) {
    console.error(`\n✗ EXECUTE FAILED · code=${result.code}`);
    console.error(JSON.stringify(result, null, 2));
    await stop('execute 자체 실패 · 재실행 금지');
  }

  console.log(`  run_id                  : ${result.run_id}`);
  console.log(`  channel_tasks_planned   : ${result.channel_tasks_planned}`);
  console.log(`  channel_tasks_created   : ${result.channel_tasks_created}`);
  console.log(`  duplicate_race          : ${result.filtered?.duplicate_race || 0}`);
  console.log(`  errors                  : ${(result.errors || []).length}`);
  console.log(`  inserted_ids            : ${JSON.stringify(result.inserted_ids)}`);

  const insertOk =
    result.channel_tasks_created === 11 &&
    (result.filtered?.duplicate_race || 0) === 0 &&
    (result.errors || []).length === 0;
  console.log(`  Expected · inserted=11 duplicate=0 error=0 → ${insertOk ? '✓' : '✗ STOP · 추가 실행 금지'}`);
  if (!insertOk) {
    console.error('\n예상과 다름 · 추가 실행 금지 · Owner 조사 필요');
    console.error(JSON.stringify({
      created: result.channel_tasks_created,
      duplicate_race: result.filtered?.duplicate_race,
      errors: result.errors,
    }, null, 2));
    process.exit(1);
  }

  //   ── 3) Post-Insert DB Verification ──────────
  console.log('\n[3] Post-Insert DB Verification');
  const insertedIds = result.inserted_ids || [];
  const { data: tasks, error: tErr } = await db.from('team_tasks').select('*').in('id', insertedIds);
  if (tErr) await stop(`inserted tasks 재조회 실패: ${tErr.message}`);

  const activeCr2 = tasks.length;
  console.log(`  active CHANNEL_REGISTER (재조회): ${activeCr2} · expected 11 · ${activeCr2 === 11 ? '✓' : '✗'}`);

  const outsideApproved = tasks.filter(t => !APPROVED_SKUS.includes(Number(t.related_sku_id))).length;
  console.log(`  approved SKU 밖 task: ${outsideApproved} · expected 0 · ${outsideApproved === 0 ? '✓' : '✗'}`);

  const unassigned = tasks.filter(t => t.assignee_id == null).length;
  console.log(`  unassigned: ${unassigned} · expected 0 · ${unassigned === 0 ? '✓' : '✗'}`);

  const p0Count = tasks.filter(t => t.priority_level === 'p0').length;
  console.log(`  P0 count: ${p0Count} · expected 11 · ${p0Count === 11 ? '✓' : '✗'}`);

  const kimjyCount = tasks.filter(t => t.assignee_id === 4).length;
  const nomsCount = tasks.filter(t => t.assignee_id === 5).length;
  console.log(`  kimjy(4): ${kimjyCount} · expected 5 · ${kimjyCount === 5 ? '✓' : '✗'}`);
  console.log(`  noms(5) : ${nomsCount} · expected 6 · ${nomsCount === 6 ? '✓' : '✗'}`);

  const chCount = {};
  for (const t of tasks) chCount[t.channel] = (chCount[t.channel] || 0) + 1;
  console.log(`  channel count: ${JSON.stringify(chCount)}`);
  const chOk = chCount.coupang === 3 && chCount.naver === 2 && chCount['11st'] === 3 && chCount.gmarket === 3;
  console.log(`  Expected coupang=3 naver=2 11st=3 gmarket=3 → ${chOk ? '✓' : '✗'}`);

  const statusOk = tasks.every(t => t.status === 'pending');
  const scopeOk = tasks.every(t => t.assignee_scope === 'specific');
  const skuOk = tasks.every(t => APPROVED_SKUS.includes(Number(t.related_sku_id)));
  console.log(`  모든 task status=pending: ${statusOk ? '✓' : '✗'}`);
  console.log(`  모든 task assignee_scope=specific: ${scopeOk ? '✓' : '✗'}`);
  console.log(`  모든 task related_sku_id ∈ approved: ${skuOk ? '✓' : '✗'}`);

  //   ── 4) Dedupe Verification (READ-ONLY · 추가 refill 금지) ─
  console.log('\n[4] Dedupe Verification (READ-ONLY)');
  const { data: allActive } = await db.from('team_tasks')
    .select('related_sku_id, channel, exception_type, status')
    .in('status', ['pending','in_progress','qc_pending'])
    .like('exception_type', 'channel_register.%');
  const keyMap = new Map();
  for (const t of (allActive || [])) {
    if (!t.related_sku_id || !t.channel) continue;
    const k = `${t.related_sku_id}|${t.channel}|${t.exception_type}`;
    keyMap.set(k, (keyMap.get(k) || 0) + 1);
  }
  const dupKeys = Array.from(keyMap.entries()).filter(([, n]) => n > 1);
  console.log(`  (sku,channel,exception_type) unique 활성 tuple: ${keyMap.size}`);
  console.log(`  duplicate 발견: ${dupKeys.length} · expected 0 · ${dupKeys.length === 0 ? '✓' : '✗'}`);

  //   ── 5) Employee Visibility ────────────────
  console.log('\n[5] Employee Visibility (kimjy · noms)');
  const kView = await nextTask.getMyTasksView(db, 4);
  const nView = await nextTask.getMyTasksView(db, 5);
  console.log(`  kimjy(4) · summary: remaining=${kView.summary.remaining} · in_progress=${kView.summary.in_progress} · qc_pending=${kView.summary.qc_pending}`);
  console.log(`  kimjy(4) · NEXT TASK: sku=${kView.next_task?.related_sku_id} · channel=${kView.next_task?.channel} · score=${kView.next_task?.priority_score}`);
  console.log(`  noms(5)  · summary: remaining=${nView.summary.remaining} · in_progress=${nView.summary.in_progress} · qc_pending=${nView.summary.qc_pending}`);
  console.log(`  noms(5)  · NEXT TASK: sku=${nView.next_task?.related_sku_id} · channel=${nView.next_task?.channel} · score=${nView.next_task?.priority_score}`);

  //   ── 6) 다른 직원 task 비노출 검증 ──────
  const kimjyOtherTaskCount = kView.tasks.filter(t => t.assignee_id !== 4).length;
  const nomsOtherTaskCount = nView.tasks.filter(t => t.assignee_id !== 5).length;
  console.log(`  kimjy 목록에 assignee != 4 task 수: ${kimjyOtherTaskCount} (기대 0) ${kimjyOtherTaskCount === 0 ? '✓' : '✗'}`);
  console.log(`  noms  목록에 assignee != 5 task 수: ${nomsOtherTaskCount} (기대 0) ${nomsOtherTaskCount === 0 ? '✓' : '✗'}`);

  //   ── 7) config 재확인 ───────────────────
  const { data: cfg2Rows } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled']);
  const cfg2 = {}; (cfg2Rows || []).forEach(r => cfg2[r.setting_key] = Number(r.setting_value));
  const stillOff = cfg2['b2c.scheduler_enabled'] === 0 && cfg2['b2c.auto_assignment_enabled'] === 0 && cfg2['b2c.data_quality_auto_enabled'] === 0;
  console.log(`\n[7] config 재확인: ${stillOff ? '✓ 모두 OFF' : '✗'}`);

  //   ── 8) Snapshot 저장 ──────────────────
  const outDir = '/Users/parksungmin/pmc-work-mvp/exports/b2c-inventory';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `wave1_execute_${runIso.replace(/[:.]/g,'-').slice(0,19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    executed_at: runIso, by_user: 'owner_wave1_final_go',
    request_body: REQUEST_BODY,
    execute_result: { ...result, plan: undefined },
    verification: {
      inserted_ids: insertedIds,
      task_details: tasks.map(t => ({
        id: t.id, sku_id: t.related_sku_id, channel: t.channel,
        assignee_id: t.assignee_id, assignee_scope: t.assignee_scope,
        priority_level: t.priority_level, priority_score: t.priority_score,
        status: t.status, dedupe_key: t.dedupe_key,
      })),
      counts: { total: activeCr2, outsideApproved, unassigned, p0: p0Count, kimjy: kimjyCount, noms: nomsCount, channel: chCount },
      dedupe: { unique_active_tuples: keyMap.size, duplicates: dupKeys.length },
      config: cfg2,
    },
    employee_visibility: {
      kimjy: { summary: kView.summary, next_task_id: kView.next_task?.id, other_task_leak: kimjyOtherTaskCount },
      noms:  { summary: nView.summary, next_task_id: nView.next_task?.id, other_task_leak: nomsOtherTaskCount },
    },
  }, null, 2));
  console.log(`\n스냅샷: ${outPath}`);

  const allOk =
    insertOk && activeCr2 === 11 && outsideApproved === 0 && unassigned === 0 &&
    p0Count === 11 && kimjyCount === 5 && nomsCount === 6 && chOk &&
    statusOk && scopeOk && skuOk && dupKeys.length === 0 &&
    kimjyOtherTaskCount === 0 && nomsOtherTaskCount === 0 && stillOff;

  console.log('\n' + '='.repeat(78));
  console.log(allOk ? '✓ WAVE 1 PRODUCTION EXECUTE SUCCESS · STOP · Owner 관찰 대기'
                    : '⚠ 일부 조건 불일치 · 위 결과 확인');
  console.log('='.repeat(78));
})().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
