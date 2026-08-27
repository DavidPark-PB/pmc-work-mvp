#!/usr/bin/env node
'use strict';
/**
 * simulate-b2c-queue.js — Phase 5 · Controlled Task Queue dry-run.
 * READ-ONLY · dryRun=true 강제 · team_tasks INSERT 안 함.
 *
 * Owner spec §22 · 초기 예시 형식으로 보고.
 *
 * Options:
 *   --what-if 0|1     WHAT-IF eligibility mode (default: config 값 · 0)
 *
 * Usage:
 *   node scripts/simulate-b2c-queue.js
 *   node scripts/simulate-b2c-queue.js --what-if 1
 */

require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const queueRefill = require('../src/services/b2cInventory/queueRefill');
const dq = require('../src/services/b2cInventory/dataQualityTasks');
const ps = require('../src/services/b2cInventory/purchaseSignals');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

(async () => {
  const whatIf = arg('--what-if', null);
  console.log('='.repeat(78));
  console.log(`B2C Queue Refill · Dry-run · what_if=${whatIf ?? '(config default)'}`);
  console.log('='.repeat(78));

  //   ── Channel Register Queue ─────────────────────
  const crRes = await queueRefill.refillChannelRegistrationQueue({
    db, dryRun: true, whatIfMode: whatIf != null ? Number(whatIf) : null,
  });
  console.log(`\n[CHANNEL_REGISTER] run=${crRes.run_id}`);
  console.log(`  effective_default_eligibility_mode: ${crRes.effective_default_eligibility_mode}`);
  console.log(`  active_before: ${crRes.active_before} · target: ${crRes.target} · slots_available: ${crRes.slots_available}`);
  console.log(`  candidates_evaluated: ${crRes.candidates_evaluated}`);
  console.log(`  filtered:`);
  for (const [k, v] of Object.entries(crRes.filtered)) console.log(`    ${k}: ${v}`);
  console.log(`  → channel_tasks_planned: ${crRes.channel_tasks_planned}`);
  console.log(`  reason: ${crRes.reason}`);

  //   plan pivot: level × channel
  const pivot = {};
  for (const t of crRes.plan) {
    pivot[t.priority_level] = pivot[t.priority_level] || {};
    pivot[t.priority_level][t.channel] = (pivot[t.priority_level][t.channel] || 0) + 1;
  }
  console.log(`\n  plan pivot (level × channel):`);
  console.table(pivot);

  //   Top 50 예정 Task
  console.log(`\n[TOP 50 예정 Task]`);
  console.table(crRes.plan.slice(0, 50).map((t, i) => {
    const c = t.context;
    return {
      rank: i + 1,
      sku_id: t.related_sku_id,
      internal_sku: c.internal_sku,
      ch: t.channel,
      lvl: t.priority_level,
      score: t.priority_score,
      stock: c.stock_qty,
      cost: c.cost_krw,
      inv_krw: c.inventory_value_krw,
      e_s90: c.ebay_sales_90d,
      s_s90: c.shopify_sales_90d,
      dq: (c.data_quality_flags || []).join('|'),
    };
  }));

  //   ── DATA_QUALITY Queue ─────────────────────────
  const dqRes = await dq.refillDataQualityCostMissingQueue({ db, dryRun: true });
  console.log(`\n[DATA_QUALITY.cost_missing] run=${dqRes.run_id}`);
  console.log(`  active_before: ${dqRes.active_before}`);
  console.log(`  candidates_evaluated: ${dqRes.candidates_evaluated}`);
  console.log(`  filtered:`);
  for (const [k, v] of Object.entries(dqRes.filtered)) console.log(`    ${k}: ${v}`);
  console.log(`  → data_quality_tasks_planned: ${dqRes.data_quality_tasks_planned}`);
  console.log(`  cost_missing_sales_threshold: ${dqRes.config.cost_missing_sales_threshold}`);
  console.log(`  max_tasks_per_refill: ${dqRes.config.max_tasks_per_refill}`);

  console.log(`\n[TOP 20 DATA_QUALITY 예정 Task]`);
  console.table(dqRes.plan.slice(0, 20).map((t, i) => ({
    rank: i + 1,
    sku_id: t.related_sku_id,
    internal_sku: t.context.internal_sku,
    stock: t.context.stock_qty,
    sales_90d: t.context.sales_90d,
    e_s90: t.context.ebay_sales_90d,
    s_s90: t.context.shopify_sales_90d,
  })));

  //   ── Purchase signals ─────────────────────────
  const psRes = await ps.listPurchaseSignals({ db, threshold: 3 });
  console.log(`\n[PURCHASE_SIGNALS · OUT_OF_STOCK_WITH_SALES · threshold=${psRes.threshold}]`);
  console.log(`  total: ${psRes.count}`);
  console.log(`\n  top 15:`);
  console.table(psRes.items.slice(0, 15).map(x => ({
    sku_id: x.sku_master_id,
    internal_sku: x.internal_sku,
    sales_90d: x.sales_90d,
    stock: x.stock_qty,
    severity: x.signals[0].severity,
  })));

  //   ── Save report ─────────────────────────────
  const outDir = '/Users/parksungmin/pmc-work-mvp/exports/b2c-inventory';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `queue_dryrun_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}${whatIf!=null?'_whatif'+whatIf:''}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    channel_register: { ...crRes, plan: undefined, plan_top50: crRes.plan.slice(0, 50), plan_pivot: pivot },
    data_quality: { ...dqRes, plan: undefined, plan_top50: dqRes.plan.slice(0, 50) },
    purchase_signals: { total: psRes.count, top50: psRes.items.slice(0, 50) },
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n리포트: ${outPath}`);
})().catch(e => { console.error(e.stack || e); process.exit(1); });
