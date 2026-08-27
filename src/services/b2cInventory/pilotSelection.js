'use strict';
/**
 * pilotSelection.js — B2C · Phase 6 · Pilot 초기 50 SKU 선정 + eligibility 활성.
 *
 * Owner directive:
 *   · 첫 Pilot 조건: stock_qty>0 · cost_krw>0 · has_sales · priority IN (p0,p1)
 *   · SKU 단위 정렬: P0 > P1 → score DESC → inv DESC → sales DESC → sku_id ASC
 *   · Preview 는 DB write 0 · Execute 만 sku_master.channel_eligibility UPDATE
 *   · 기존 bulk eligibility infrastructure 재사용
 */

const engine = require('./priorityEngine');
const KOREA_ALL = ['coupang', 'naver', '11st', 'gmarket'];
const AUTO_CHANNELS = KOREA_ALL;

async function loadAll(db, table, select) {
  const out = []; let off = 0;
  while (true) {
    const { data, error } = await db.from(table).select(select).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return out;
}

async function loadConfig(db) {
  const { data } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.old_stock_days','b2c.very_old_stock_days','b2c.high_value_threshold_krw','b2c.sales_validation_days']);
  const cfg = {};
  for (const r of (data || [])) cfg[r.setting_key.replace(/^b2c\./,'')] = Number(r.setting_value);
  return cfg;
}

//   ── Pure: SKU × 4채널 evaluations 에서 SKU 하나의 best-level+score 로 축소 ─
function reduceToBestPerSku(evaluationsBySku) {
  const out = [];
  for (const [skuId, evals] of evaluationsBySku.entries()) {
    if (!evals || !evals.length) continue;
    let best = null;
    for (const ev of evals) {
      if (!ev || ev.priority_level == null) continue;
      const rb = ({p0:0,p1:1,p2:2,p3:3})[ev.priority_level] ?? 9;
      if (!best) { best = ev; continue; }
      const ra = ({p0:0,p1:1,p2:2,p3:3})[best.priority_level] ?? 9;
      if (rb < ra) best = ev;
      else if (rb === ra && Number(ev.priority_score) > Number(best.priority_score)) best = ev;
    }
    if (best) out.push({ sku_master_id: skuId, best });
  }
  return out;
}

//   ── SKU-level filter · Pilot condition ────────────────
//   scorecard = row from v_sku_b2c_scorecard
//   bestEval  = best evaluation across 4 channels
function matchesPilotCondition(scorecard, bestEval) {
  if (!scorecard || !bestEval) return false;
  if ((Number(scorecard.stock_qty) || 0) <= 0) return false;
  if (scorecard.unit_cost == null || Number(scorecard.unit_cost) <= 0) return false;
  const sales = (Number(scorecard.ebay_sales_90d) || 0) + (Number(scorecard.shopify_sales_90d) || 0);
  if (sales <= 0) return false;
  if (!['p0','p1'].includes(bestEval.priority_level)) return false;
  return true;
}

//   ── Pure sort · SKU-level ────────────────────────────
function sortSkuLevel(rows) {
  rows.sort((a, b) => {
    const ra = ({p0:0,p1:1})[a.best.priority_level];
    const rb = ({p0:0,p1:1})[b.best.priority_level];
    if (ra !== rb) return ra - rb;
    const sa = Number(a.best.priority_score) || 0;
    const sb = Number(b.best.priority_score) || 0;
    if (sa !== sb) return sb - sa;
    const va = Number(a.scorecard.inventory_value_krw) || 0;
    const vb = Number(b.scorecard.inventory_value_krw) || 0;
    if (va !== vb) return vb - va;
    const es = (Number(a.scorecard.ebay_sales_90d) || 0) + (Number(a.scorecard.shopify_sales_90d) || 0);
    const eb = (Number(b.scorecard.ebay_sales_90d) || 0) + (Number(b.scorecard.shopify_sales_90d) || 0);
    if (es !== eb) return eb - es;
    return Number(a.sku_master_id) - Number(b.sku_master_id);
  });
  return rows;
}

//   ── Preview: Top N SKU (READ-ONLY) ────────────────────
async function pilotPreview({ db, size = 50 }) {
  const scorecards = await loadAll(db, 'v_sku_b2c_scorecard',
    'sku_master_id,internal_sku,title,unit_cost,stock_qty,inventory_value_krw,stock_age_days,stock_age_source,sales_30d,sales_90d,ebay_sales_90d,shopify_sales_90d,live_channels,registered_channels,observed_channels,missing_channels_seen,channel_eligibility');
  const chRows = await loadAll(db, 'v_sku_channel_matrix', 'sku_master_id,channel,channel_status');
  const chMap = new Map();
  for (const r of chRows) {
    if (!r.channel) continue;
    if (!chMap.has(r.sku_master_id)) chMap.set(r.sku_master_id, {});
    chMap.get(r.sku_master_id)[r.channel] = r.channel_status;
  }
  const config = await loadConfig(db);
  //   Priority Engine with WHAT-IF KOREA_ALL 로 evaluate (pilot 전제 = eligibility 활성될 상태)
  const options = { defaultMode: 1 };
  const scByIndex = new Map(scorecards.map(s => [s.sku_master_id, s]));
  const evalsBySku = new Map();
  for (const sc of scorecards) {
    const statuses = chMap.get(sc.sku_master_id) || {};
    const allSt = AUTO_CHANNELS.map(ch => ({
      channel: ch, channel_status: statuses[ch] || 'NONE',
      eligible: engine.resolveEligibility(sc.channel_eligibility, ch, options.defaultMode),
    }));
    const evs = AUTO_CHANNELS.map(ch => engine.evaluateSkuChannel({
      scorecard: sc, channel: ch, channelStatus: statuses[ch] || 'NONE',
      allChannelStatuses: allSt, config, options,
    }));
    evalsBySku.set(sc.sku_master_id, evs);
  }

  //   reduce · filter · sort
  const reduced = reduceToBestPerSku(evalsBySku)
    .map(r => ({ sku_master_id: r.sku_master_id, best: r.best, scorecard: scByIndex.get(r.sku_master_id) }))
    .filter(r => matchesPilotCondition(r.scorecard, r.best));
  sortSkuLevel(reduced);
  const top = reduced.slice(0, size);

  //   estimate task count (KOREA_ALL · NONE/ERROR 만 카운트)
  const estimate = { total: 0, byChannel: Object.fromEntries(AUTO_CHANNELS.map(c => [c, 0])) };
  for (const r of top) {
    const st = chMap.get(r.sku_master_id) || {};
    for (const ch of AUTO_CHANNELS) {
      const s = st[ch] || 'NONE';
      if (s === 'NONE' || s === 'ERROR') { estimate.byChannel[ch]++; estimate.total++; }
    }
  }

  return {
    size,
    total_pilot_matched: reduced.length,
    selected: top.length,
    estimated_channel_tasks: estimate,
    top: top.map((r, i) => ({
      rank: i + 1,
      sku_master_id: r.sku_master_id,
      internal_sku: r.scorecard.internal_sku,
      title: r.scorecard.title,
      priority_level: r.best.priority_level,
      priority_score: r.best.priority_score,
      stock_qty: r.scorecard.stock_qty,
      cost_krw: r.scorecard.unit_cost,
      inventory_value_krw: r.scorecard.inventory_value_krw,
      ebay_sales_90d: r.scorecard.ebay_sales_90d,
      shopify_sales_90d: r.scorecard.shopify_sales_90d,
      korea_channel_status: {
        coupang: (chMap.get(r.sku_master_id) || {}).coupang || 'NONE',
        naver:   (chMap.get(r.sku_master_id) || {}).naver   || 'NONE',
        '11st':  (chMap.get(r.sku_master_id) || {})['11st'] || 'NONE',
        gmarket: (chMap.get(r.sku_master_id) || {}).gmarket || 'NONE',
      },
      current_eligibility: r.scorecard.channel_eligibility,
      reasons: r.best.reasons,
    })),
  };
}

//   ── Execute: eligibility KOREA_ALL 활성 (WRITE) ─────
//   Phase 7.5:
//     · size 는 preview 크기 · skuIds 로 Wave 특정 SKU 만 activate 가능
//     · Activate 직전 preview 재실행 → drift check (조건 유지 SKU 만)
//     · 활성 SKU snapshot 을 structured log 로 남김 (PILOT_WAVE_ACTIVATED)
//     · drift 로 제외된 SKU 는 PILOT_ACTIVATION_DRIFT_SKIP 이벤트
async function pilotActivate({ db, size = 50, userId, skuIds = null, waveLabel = null }) {
  //   1) preview 재실행 (drift check 위해 activate 시점 데이터로)
  const preview = await pilotPreview({ db, size });
  const previewMap = new Map(preview.top.map(t => [Number(t.sku_master_id), t]));

  //   2) 대상 결정: skuIds 지정 시 그 SKU 만 · 지정 안 하면 preview top size 개 전체
  const requestedIds = Array.isArray(skuIds) && skuIds.length > 0
    ? skuIds.map(Number).filter(Number.isFinite)
    : preview.top.map(t => Number(t.sku_master_id));

  //   3) drift check + activate
  const nowIso = new Date().toISOString();
  const results = { requested: requestedIds.length, activated: 0, unchanged: 0, skipped_due_to_drift: 0, errors: [], drift_skus: [] };
  const activatedSnapshot = [];
  for (const skuId of requestedIds) {
    const item = previewMap.get(skuId);
    if (!item) {
      //   preview 에 없다 = drift (Activate 시점에 조건 미달)
      results.skipped_due_to_drift++;
      results.drift_skus.push(skuId);
      events.log('PILOT_ACTIVATION_DRIFT_SKIP', {
        sku_master_id: skuId, reason: 'not_in_current_preview', wave: waveLabel, by_user: userId,
      });
      continue;
    }
    const before = item.current_eligibility;
    if (JSON.stringify(before) === JSON.stringify(KOREA_ALL)) {
      results.unchanged++;
      activatedSnapshot.push(snapshotOf(item, before, KOREA_ALL));
      continue;
    }
    const { error } = await db.from('sku_master')
      .update({ channel_eligibility: KOREA_ALL.slice(), updated_at: nowIso })
      .eq('id', item.sku_master_id);
    if (error) {
      results.errors.push({ sku_master_id: item.sku_master_id, error: error.message });
      continue;
    }
    results.activated++;
    const snap = snapshotOf(item, before, KOREA_ALL);
    activatedSnapshot.push(snap);
    console.log('[b2c.pilot.activate] eligibility KOREA_ALL', {
      sku_master_id: item.sku_master_id, internal_sku: item.internal_sku,
      before, after: KOREA_ALL, rank: item.rank, wave: waveLabel, by_user: userId,
    });
  }

  //   4) snapshot 이벤트 (재현 가능성)
  events.log('PILOT_WAVE_ACTIVATED', {
    wave: waveLabel, size, requested: results.requested,
    activated: results.activated, unchanged: results.unchanged,
    skipped_due_to_drift: results.skipped_due_to_drift, errors_count: results.errors.length,
    snapshot: activatedSnapshot, by_user: userId, at: nowIso,
  });

  return {
    size, wave: waveLabel, activated_at: nowIso, by_user: userId,
    preview_matched: preview.total_pilot_matched, preview_selected: preview.selected,
    results,
    activated_snapshot: activatedSnapshot,
  };
}

//   Snapshot fields (Owner spec §4)
function snapshotOf(item, before, after) {
  return {
    sku_master_id: item.sku_master_id,
    internal_sku: item.internal_sku,
    priority_level: item.priority_level,
    priority_score: item.priority_score,
    stock_qty: item.stock_qty,
    cost_krw: item.cost_krw,
    sales_90d: (Number(item.ebay_sales_90d) || 0) + (Number(item.shopify_sales_90d) || 0),
    ebay_sales_90d: item.ebay_sales_90d,
    shopify_sales_90d: item.shopify_sales_90d,
    inventory_value_krw: item.inventory_value_krw,
    korea_channel_status_at_selection: item.korea_channel_status,
    before_eligibility: before,
    after_eligibility: after,
  };
}

//   ── Pilot Preview 에 events import 위해 상단 필요 ────
const events = require('./executionEvents');

module.exports = {
  KOREA_ALL, AUTO_CHANNELS,
  matchesPilotCondition,
  reduceToBestPerSku,
  sortSkuLevel,
  pilotPreview,
  pilotActivate,
};
