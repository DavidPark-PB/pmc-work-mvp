#!/usr/bin/env node
'use strict';
/**
 * simulate-b2c-pilot.js — Phase 6 · Production READ-ONLY report (A-F).
 *
 * Owner spec §21 · A/B/C/D/E/F 순서로 출력.
 *   A. Pilot Top 50 SKU
 *   B. 예상 Task (총·channel별·P0/P1별)
 *   C. GLOBAL_PRIORITY Preview (100 Task · pilot_max=100)
 *   D. BALANCED_CHANNEL Preview (100 Task · pilot_max=100)
 *   E. Assignment Simulation (READ-ONLY · b2c_operator=true users)
 *   F. Purchase Signal Top 20
 *
 * 모두 dryRun=true · DB write 0 · production config 변경 없음.
 */

require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const pilot = require('../src/services/b2cInventory/pilotSelection');
const queueRefill = require('../src/services/b2cInventory/queueRefill');
const autoAssign = require('../src/services/b2cInventory/autoAssignment');
const purchase = require('../src/services/b2cInventory/purchaseSignals');
const alloc = require('../src/services/b2cInventory/allocationStrategy');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const OUT_DIR = '/Users/parksungmin/pmc-work-mvp/exports/b2c-inventory';
const SIZE = 50;
const PILOT_MAX = 100;

(async () => {
  const now = new Date().toISOString();
  console.log('='.repeat(78));
  console.log(`B2C Pilot Production Read-only Report · ${now}`);
  console.log('='.repeat(78));

  //   ── A. Pilot Top 50 SKU ────────────────────────
  console.log(`\n[A] Pilot Top ${SIZE} SKU (WHAT-IF KOREA_ALL · P0/P1 · cost 있음 · stock>0 · has_sales)`);
  const previewSku = await pilot.pilotPreview({ db, size: SIZE });
  console.log(`총 pilot 조건 만족 SKU: ${previewSku.total_pilot_matched} · 선정: ${previewSku.selected}`);
  console.log(`예상 Task (KOREA_ALL): ${previewSku.estimated_channel_tasks.total} (coupang ${previewSku.estimated_channel_tasks.byChannel.coupang} · naver ${previewSku.estimated_channel_tasks.byChannel.naver} · 11st ${previewSku.estimated_channel_tasks.byChannel['11st']} · gmarket ${previewSku.estimated_channel_tasks.byChannel.gmarket})`);
  console.table(previewSku.top.slice(0, 50).map(t => ({
    rank: t.rank, sku_id: t.sku_master_id, internal_sku: t.internal_sku,
    lvl: t.priority_level, score: t.priority_score,
    stock: t.stock_qty, cost: t.cost_krw, inv_krw: t.inventory_value_krw,
    e_s90: t.ebay_sales_90d, s_s90: t.shopify_sales_90d,
    coupang: t.korea_channel_status.coupang,
    naver:   t.korea_channel_status.naver,
    '11st':  t.korea_channel_status['11st'],
    gmarket: t.korea_channel_status.gmarket,
  })));

  //   ── B. 예상 Task 총·channel·level 별 ────────────
  console.log(`\n[B] 예상 Task 수 (pilot top ${SIZE} SKU 활성화 시)`);
  const byLevel = { p0: 0, p1: 0 };
  const byLevelChannel = { p0: {}, p1: {} };
  for (const t of previewSku.top) {
    byLevel[t.priority_level]++;
    for (const ch of ['coupang','naver','11st','gmarket']) {
      const st = t.korea_channel_status[ch];
      if (st === 'NONE' || st === 'ERROR') {
        byLevelChannel[t.priority_level][ch] = (byLevelChannel[t.priority_level][ch] || 0) + 1;
      }
    }
  }
  console.log(`SKU · P0=${byLevel.p0} · P1=${byLevel.p1}`);
  console.log(`Task (level × channel):`);
  console.table(byLevelChannel);

  //   ── C. GLOBAL_PRIORITY Preview (100 Task) ──────
  //   pilot SKU 만 eligible 이라 가정 → WHAT-IF 로 refill preview
  //   실제 execute 시엔 pilotActivate 로 sku_master.channel_eligibility 활성 후 refill 이지만
  //   여기서는 memory 시뮬레이션 위해 WHAT-IF=1 + pilot_max_tasks=100
  console.log(`\n[C] GLOBAL_PRIORITY Preview (pilot_max=${PILOT_MAX})`);
  const globalC = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true, whatIfMode: 1, allocationStrategy: 'GLOBAL_PRIORITY', pilotMaxTasks: PILOT_MAX,
  });
  console.log(`plan.length=${globalC.plan.length} · slots=${globalC.slots_available}`);
  const gDist = distribution(globalC.plan);
  console.log(`level 분포: ${JSON.stringify(gDist.byLevel)}`);
  console.log(`channel 분포: ${JSON.stringify(gDist.byChannel)}`);
  console.log(`\nTop 20 (GLOBAL_PRIORITY):`);
  console.table(globalC.plan.slice(0, 20).map((t, i) => ({
    rank: i+1, sku_id: t.related_sku_id, internal_sku: t.context.internal_sku,
    ch: t.channel, lvl: t.priority_level, score: t.priority_score,
    inv_krw: t.context.inventory_value_krw, e_s90: t.context.ebay_sales_90d,
  })));

  //   ── D. BALANCED_CHANNEL Preview ──────────────
  console.log(`\n[D] BALANCED_CHANNEL Preview (pilot_max=${PILOT_MAX})`);
  const balC = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true, whatIfMode: 1, allocationStrategy: 'BALANCED_CHANNEL', pilotMaxTasks: PILOT_MAX,
  });
  console.log(`plan.length=${balC.plan.length}`);
  const bDist = distribution(balC.plan);
  console.log(`level 분포: ${JSON.stringify(bDist.byLevel)}`);
  console.log(`channel 분포 (균형 확인): ${JSON.stringify(bDist.byChannel)}`);
  console.log(`\nTop 20 (BALANCED_CHANNEL):`);
  console.table(balC.plan.slice(0, 20).map((t, i) => ({
    rank: i+1, sku_id: t.related_sku_id, internal_sku: t.context.internal_sku,
    ch: t.channel, lvl: t.priority_level, score: t.priority_score,
    inv_krw: t.context.inventory_value_krw, e_s90: t.context.ebay_sales_90d,
  })));
  console.log(`\n두 전략 비교:`);
  console.log(`  GLOBAL_PRIORITY channel 편중 · max=${Math.max(...Object.values(gDist.byChannel))} · min=${Math.min(...Object.values(gDist.byChannel))}`);
  console.log(`  BALANCED_CHANNEL channel 편중 · max=${Math.max(...Object.values(bDist.byChannel))} · min=${Math.min(...Object.values(bDist.byChannel))}`);

  //   ── E. Assignment Simulation ─────────────────
  console.log(`\n[E] Assignment Simulation (READ-ONLY)`);
  const eligibles = await autoAssign.loadEligibleEmployees(db);
  console.log(`eligible employees (b2c_operator=true · is_active=true): ${eligibles.length}`);
  eligibles.forEach(u => console.log(`  · id=${u.id} · ${u.username} (${u.display_name || '-'})`));
  if (eligibles.length === 0) {
    console.log(`\n  ⚠ b2c_operator=true 인 직원이 없습니다. Auto assignment 켜도 모두 unassigned 됩니다.`);
    console.log(`  admin 이 UPDATE users SET b2c_operator=true WHERE id IN (...) 로 opt-in 필요.`);
  } else {
    //   시뮬레이션 · GLOBAL_PRIORITY plan 100개 대상
    const sim = await autoAssign.simulateAssignment({ db, plan: globalC.plan });
    console.log(`\n  simulation (100 Task 배정):`);
    console.table(sim.eligibles);
  }

  //   ── F. Purchase Signal Top 20 ────────────────
  console.log(`\n[F] Purchase Signal Top 20 (OUT_OF_STOCK_WITH_SALES · threshold=3)`);
  const ps = await purchase.listPurchaseSignals({ db, threshold: 3 });
  console.log(`total: ${ps.count}`);
  console.table(ps.items.slice(0, 20).map((x, i) => ({
    rank: i+1, sku_id: x.sku_master_id, internal_sku: x.internal_sku,
    sales_90d: x.sales_90d, stock: x.stock_qty,
    severity: x.signals[0].severity,
    opportunity: x.signals[0].opportunity_score,
    recommended: x.signals[0].recommended_action,
  })));

  //   ── save ────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `phase6_report_${now.replace(/[:.]/g,'-').slice(0,19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: now,
    A_pilot_top_50: previewSku,
    B_expected_tasks: { byLevel, byLevelChannel },
    C_global_priority: { plan_count: globalC.plan.length, distribution: gDist, top20: globalC.plan.slice(0, 20).map(t => ({ sku_master_id: t.related_sku_id, ...t.context, channel: t.channel, priority_level: t.priority_level, priority_score: t.priority_score })) },
    D_balanced_channel: { plan_count: balC.plan.length, distribution: bDist, top20: balC.plan.slice(0, 20).map(t => ({ sku_master_id: t.related_sku_id, ...t.context, channel: t.channel, priority_level: t.priority_level, priority_score: t.priority_score })) },
    E_assignment: { eligible_count: eligibles.length, eligibles },
    F_purchase_signals: { total: ps.count, top20: ps.items.slice(0, 20) },
  }, null, 2));
  console.log(`\n리포트: ${outPath}`);
})().catch(e => { console.error(e.stack || e); process.exit(1); });

function distribution(plan) {
  const byLevel = {}; const byChannel = {};
  for (const t of plan) {
    byLevel[t.priority_level] = (byLevel[t.priority_level] || 0) + 1;
    byChannel[t.channel] = (byChannel[t.channel] || 0) + 1;
  }
  return { byLevel, byChannel };
}
