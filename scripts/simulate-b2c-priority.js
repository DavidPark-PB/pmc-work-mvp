#!/usr/bin/env node
'use strict';
/**
 * simulate-b2c-priority.js — Phase 4 · READ-ONLY Priority Engine simulation.
 *
 * Owner directive (2026-08-25):
 *   · 자동 Task INSERT 금지 · DB config 값 변경 금지.
 *   · REAL MODE: 현재 default_eligibility_mode 그대로 사용.
 *   · WHAT-IF MODE: 메모리에서만 default_mode=1 (KOREA_ALL) 로 가정.
 *   · 자동 대상 채널 4개 (coupang, naver, 11st, gmarket) 만 평가.
 *
 * Output:
 *   · 요약 카운트 (전체/stock>0/판매/cost missing/eligible/mode 별 P0-P3 갯수)
 *   · Top 30 SKU × Channel (WHAT-IF 기준)
 *   · 이상치 (아래 6가지 케이스)
 *
 * Usage:
 *   node scripts/simulate-b2c-priority.js
 */

require('dotenv').config({ path: '/Users/parksungmin/pmc-work-mvp/config/.env' });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const engine = require('../src/services/b2cInventory/priorityEngine');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const AUTO_CHANNELS = ['coupang', 'naver', '11st', 'gmarket'];

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

async function loadConfig() {
  const { data } = await db.from('margin_settings')
    .select('setting_key, setting_value')
    .in('setting_key', ['b2c.default_eligibility_mode','b2c.old_stock_days','b2c.very_old_stock_days','b2c.high_value_threshold_krw','b2c.sales_validation_days']);
  const cfg = {};
  for (const r of (data || [])) {
    const key = r.setting_key.replace(/^b2c\./, '');
    cfg[key] = Number(r.setting_value);
  }
  return cfg;
}

async function loadChannelStatuses() {
  //   v_sku_channel_matrix 전체 → sku_master_id → channel → channel_status map
  const rows = await loadAll('v_sku_channel_matrix', 'sku_master_id, channel, channel_status');
  const bySku = new Map();
  for (const r of rows) {
    if (!r.channel) continue;
    if (!bySku.has(r.sku_master_id)) bySku.set(r.sku_master_id, {});
    bySku.get(r.sku_master_id)[r.channel] = r.channel_status;
  }
  return bySku;
}

//   ── evaluate 1 SKU for all 4 auto channels ────────────────
function evaluateSkuAllChannels(scorecard, channelStatusMap, config, options) {
  //   allChannelStatuses (for gap calc): status of THIS sku on each of 4 auto channels
  const statuses = channelStatusMap.get(scorecard.sku_master_id) || {};
  const allStatuses = AUTO_CHANNELS.map(ch => ({
    channel: ch,
    channel_status: statuses[ch] || 'NONE',
    eligible: engine.resolveEligibility(scorecard.channel_eligibility, ch, options.defaultMode),
  }));
  return AUTO_CHANNELS.map(ch => {
    const cs = statuses[ch] || 'NONE';
    return engine.evaluateSkuChannel({
      scorecard, channel: ch, channelStatus: cs, allChannelStatuses: allStatuses,
      config, options,
    });
  });
}

function countBy(evals, keyFn) {
  const m = new Map();
  for (const ev of evals) {
    const k = keyFn(ev);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries(Array.from(m.entries()).sort());
}

async function main() {
  const now = new Date().toISOString();
  console.log('='.repeat(78));
  console.log(`B2C Priority Engine Simulation · ${now}`);
  console.log('='.repeat(78));

  const config = await loadConfig();
  console.log(`\nConfig (margin_settings b2c.*):`);
  for (const [k, v] of Object.entries(config)) console.log(`  ${k}=${v}`);

  const scRows = await loadAll('v_sku_b2c_scorecard',
    'sku_master_id,internal_sku,title,unit_cost,stock_qty,inventory_value_krw,stock_age_days,stock_age_source,sales_30d,sales_90d,ebay_sales_90d,shopify_sales_90d,live_channels,registered_channels,observed_channels,missing_channels_seen,channel_eligibility');
  const statusMap = await loadChannelStatuses();

  //   ── 기본 요약 ─────────────────────────────────────────
  const skuCount = scRows.length;
  const stockPos = scRows.filter(r => Number(r.stock_qty) > 0).length;
  const salesPos = scRows.filter(r => Number(r.sales_90d) > 0).length;
  const costMiss = scRows.filter(r => r.unit_cost == null).length;
  console.log(`\n총 active SKU        : ${skuCount}`);
  console.log(`stock_qty > 0        : ${stockPos}`);
  console.log(`sales_90d > 0        : ${salesPos}`);
  console.log(`cost_krw NULL        : ${costMiss}`);

  //   ── REAL MODE ────────────────────────────────────────
  const realMode = { defaultMode: Number(config.default_eligibility_mode) || 0 };
  const realEvals = [];
  for (const sc of scRows) {
    for (const ev of evaluateSkuAllChannels(sc, statusMap, config, realMode)) realEvals.push(ev);
  }
  const realTaskCandidates = realEvals.filter(e => e.priority_level != null);   //   Task 후보
  console.log(`\n${'='.repeat(78)}\nREAL MODE · default_eligibility_mode=${realMode.defaultMode}\n${'='.repeat(78)}`);
  console.log(`전체 evaluations (SKU × 4채널): ${realEvals.length}`);
  console.log(`eligible=true                  : ${realEvals.filter(e => e.eligible).length}`);
  console.log(`Task 후보 (priority_level!=null): ${realTaskCandidates.length}`);
  console.log(`  priority_level 별: ${JSON.stringify(countBy(realTaskCandidates, e => e.priority_level))}`);
  console.log(`  channel 별      : ${JSON.stringify(countBy(realTaskCandidates, e => e.channel))}`);

  //   ── WHAT-IF MODE (KOREA_ALL) ─────────────────────────
  const whatIfMode = { defaultMode: 1 };
  const wEvals = [];
  for (const sc of scRows) {
    for (const ev of evaluateSkuAllChannels(sc, statusMap, config, whatIfMode)) wEvals.push(ev);
  }
  const wCandidates = wEvals.filter(e => e.priority_level != null);
  console.log(`\n${'='.repeat(78)}\nWHAT-IF MODE · default_eligibility_mode=1 (KOREA_ALL · 메모리에서만)\n${'='.repeat(78)}`);
  console.log(`전체 evaluations               : ${wEvals.length}`);
  console.log(`eligible=true                  : ${wEvals.filter(e => e.eligible).length}`);
  console.log(`Task 후보 (priority_level!=null): ${wCandidates.length}`);
  console.log(`  priority_level 별: ${JSON.stringify(countBy(wCandidates, e => e.priority_level))}`);
  console.log(`  channel 별      : ${JSON.stringify(countBy(wCandidates, e => e.channel))}`);
  //   channel × level pivot
  const pivot = {};
  for (const ev of wCandidates) {
    pivot[ev.channel] = pivot[ev.channel] || {};
    pivot[ev.channel][ev.priority_level] = (pivot[ev.channel][ev.priority_level] || 0) + 1;
  }
  console.log(`\n  channel × priority pivot:`);
  console.table(pivot);

  //   ── Top 30 (WHAT-IF · priority_level 우선 · priority_score DESC) ─
  const rank = (e) => ({ p0: 0, p1: 1, p2: 2, p3: 3 }[e.priority_level] ?? 9);
  const top30 = wCandidates
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.priority_score - a.priority_score || b.inventory_value_krw - a.inventory_value_krw)
    .slice(0, 30);
  console.log(`\n${'='.repeat(78)}\nTOP 30 후보 (WHAT-IF)\n${'='.repeat(78)}`);
  console.table(top30.map((e, i) => ({
    rank: i + 1,
    sku: e.internal_sku,
    ch: e.channel,
    lvl: e.priority_level,
    score: e.priority_score,
    stock: e.stock_qty,
    cost: e.unit_cost,
    inv_krw: e.inventory_value_krw,
    e_s90: e.ebay_sales_90d,
    s_s90: e.shopify_sales_90d,
    age: e.stock_age_days,
    age_conf: e.stock_age_confidence,
    dq: (e.data_quality_flags || []).join('|'),
  })));

  //   ── 이상치 6종 ──────────────────────────────────────
  console.log(`\n${'='.repeat(78)}\n이상치 분석 (WHAT-IF)\n${'='.repeat(78)}`);
  //   1) 재고는 큰데 판매검증 없음 (inv > 500k, sales = 0)
  const anom1 = scRows.filter(r => Number(r.inventory_value_krw) >= 500000 && Number(r.sales_90d) === 0);
  console.log(`\n[1] 재고>=₩500k · 최근 90일 판매 없음: ${anom1.length}건`);
  anom1.slice(0, 5).forEach(r => console.log(`    ${r.internal_sku} · inv=₩${Number(r.inventory_value_krw).toLocaleString()} · stock=${r.stock_qty}`));

  //   2) 판매 많은데 cost 없음
  const anom2 = scRows.filter(r => Number(r.sales_90d) >= 3 && r.unit_cost == null);
  console.log(`\n[2] sales_90d >= 3 · cost NULL: ${anom2.length}건`);
  anom2.slice(0, 5).forEach(r => console.log(`    ${r.internal_sku} · sales=${r.sales_90d} (eb ${r.ebay_sales_90d} · sh ${r.shopify_sales_90d}) · cost NULL`));

  //   3) 판매 많은데 stock 0
  const anom3 = scRows.filter(r => Number(r.sales_90d) >= 3 && Number(r.stock_qty) === 0);
  console.log(`\n[3] sales_90d >= 3 · stock 0: ${anom3.length}건`);
  anom3.slice(0, 5).forEach(r => console.log(`    ${r.internal_sku} · sales=${r.sales_90d} · stock=0`));

  //   4) 재고는 있는데 모든 한국채널 LIVE (이미 다 등록됨)
  const anom4 = scRows.filter(r => {
    if (Number(r.stock_qty) === 0) return false;
    const st = statusMap.get(r.sku_master_id) || {};
    return AUTO_CHANNELS.every(ch => st[ch] === 'LIVE');
  });
  console.log(`\n[4] stock 있고 4채널 모두 LIVE: ${anom4.length}건`);

  //   5) P0인데 inventory_value 매우 낮음 (< 100k)
  const anom5 = wCandidates.filter(e => e.priority_level === 'p0' && Number(e.inventory_value_krw) < 100000);
  console.log(`\n[5] P0 · inventory_value < ₩100,000: ${anom5.length}건`);
  anom5.slice(0, 5).forEach(e => console.log(`    ${e.internal_sku}/${e.channel} · inv=₩${e.inventory_value_krw} · score=${e.priority_score} · reasons: ${e.reasons.slice(0,2).join(' / ')}`));

  //   6) P0인데 sales 1건 뿐
  const anom6 = wCandidates.filter(e => e.priority_level === 'p0' && (e.ebay_sales_90d + e.shopify_sales_90d) === 1);
  console.log(`\n[6] P0 · sales 합계 = 1: ${anom6.length}건`);
  anom6.slice(0, 5).forEach(e => console.log(`    ${e.internal_sku}/${e.channel} · sales_e=${e.ebay_sales_90d} · sales_s=${e.shopify_sales_90d} · inv=₩${e.inventory_value_krw}`));

  //   ── 리포트 저장 ─────────────────────────────────────
  const outDir = '/Users/parksungmin/pmc-work-mvp/exports/b2c-inventory';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `simulation_${now.replace(/[:.]/g,'-').slice(0,19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: now,
    config,
    totals: { skuCount, stockPos, salesPos, costMiss },
    real: {
      mode: realMode,
      evaluations: realEvals.length,
      eligible: realEvals.filter(e => e.eligible).length,
      taskCandidates: realTaskCandidates.length,
      byLevel: countBy(realTaskCandidates, e => e.priority_level),
      byChannel: countBy(realTaskCandidates, e => e.channel),
    },
    whatIf: {
      mode: whatIfMode,
      evaluations: wEvals.length,
      eligible: wEvals.filter(e => e.eligible).length,
      taskCandidates: wCandidates.length,
      byLevel: countBy(wCandidates, e => e.priority_level),
      byChannel: countBy(wCandidates, e => e.channel),
      pivot,
    },
    top30,
    anomalies: {
      highValueNoSales: anom1.length,
      salesNoCost: anom2.length,
      salesNoStock: anom3.length,
      allChannelsLive: anom4.length,
      p0LowValue: anom5.length,
      p0LowSales: anom6.length,
    },
  }, null, 2));
  console.log(`\n리포트: ${outPath}`);
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
