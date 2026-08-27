'use strict';
/**
 * eligibilityBulk.js — B2C · Phase 5 · Preview → Confirm 구조로 bulk eligibility 설정.
 *
 * Owner directive:
 *   · Preview 는 DB 절대 변경 안 함 · 후보 SKU 목록 반환.
 *   · Execute 는 관리자 명시적 승인 후에만 · admin API 층에서 requireAdmin 강제.
 *   · 초기 운영: P0+P1+cost_present+stock>0 필터 · 100~300 SKU 정도만 활성화 예상.
 *
 * Filter fields (Owner spec §2):
 *   priority_level             : 'p0' | 'p1' | 'p2' | 'p3'  (multi 허용: 배열)
 *   minimum_priority_score     : 0..100
 *   has_sales                  : boolean · ebay/shopify 90d 판매 있음
 *   minimum_sales_90d          : 정수
 *   stock_gt                   : 정수 (stock_qty > 이 값)
 *   cost_present               : true (unit_cost NOT NULL)
 *   cost_missing               : true (unit_cost NULL)
 *   minimum_inventory_value    : 원
 *   channel_status             : { channel, statuses[] }  · 특정 채널의 status filter
 *   sku_ids                    : 명시적 SKU id 배열
 */

const engine = require('./priorityEngine');
const AUTO_CHANNELS = ['coupang', 'naver', '11st', 'gmarket'];
const KOREA_ALL = ['coupang', 'naver', '11st', 'gmarket'];
const ACTION_TYPES = new Set(['korea_all', 'set_channels', 'clear', 'unspecified']);

//   ── Pure filter · scorecard 배열 + channel status map 을 받아 SKU 필터링 ──
function filterCandidates({ scorecards, channelStatusMap, evaluationsBySku, filters }) {
  //   evaluationsBySku: Map<sku_master_id, [ eval per 4 channel ]>  (Priority Engine 결과)
  const f = filters || {};
  const priorityLevels = f.priority_level
    ? (Array.isArray(f.priority_level) ? f.priority_level : [f.priority_level])
    : null;
  const minScore = f.minimum_priority_score != null ? Number(f.minimum_priority_score) : null;
  const minSales = f.minimum_sales_90d != null ? Number(f.minimum_sales_90d) : null;
  const stockGt = f.stock_gt != null ? Number(f.stock_gt) : null;
  const minInv = f.minimum_inventory_value != null ? Number(f.minimum_inventory_value) : null;
  const skuIdSet = Array.isArray(f.sku_ids) && f.sku_ids.length ? new Set(f.sku_ids.map(Number)) : null;

  const out = [];
  for (const sc of scorecards) {
    //   sku_ids 필터
    if (skuIdSet && !skuIdSet.has(Number(sc.sku_master_id))) continue;
    //   has_sales / minimum_sales_90d
    const totalSales = (Number(sc.ebay_sales_90d) || 0) + (Number(sc.shopify_sales_90d) || 0);
    if (f.has_sales === true && totalSales <= 0) continue;
    if (f.has_sales === false && totalSales > 0) continue;
    if (minSales != null && totalSales < minSales) continue;
    //   stock_gt
    if (stockGt != null && Number(sc.stock_qty) <= stockGt) continue;
    //   cost_present / cost_missing (mutually exclusive · owner 가 둘 다 지정하면 결과 0)
    if (f.cost_present === true && sc.unit_cost == null) continue;
    if (f.cost_missing === true && sc.unit_cost != null) continue;
    //   minimum_inventory_value
    if (minInv != null && (Number(sc.inventory_value_krw) || 0) < minInv) continue;
    //   channel_status filter (e.g. { channel: 'coupang', statuses: ['NONE','ERROR'] })
    if (f.channel_status && f.channel_status.channel) {
      const ch = f.channel_status.channel;
      const wanted = Array.isArray(f.channel_status.statuses) ? f.channel_status.statuses : [];
      const st = (channelStatusMap.get(sc.sku_master_id) || {})[ch] || 'NONE';
      if (wanted.length > 0 && !wanted.includes(st)) continue;
    }
    //   priority_level / minimum_priority_score · evaluations 배열 중 가장 상위 (best) 채널로 판정
    if (priorityLevels || minScore != null) {
      const evals = evaluationsBySku.get(sc.sku_master_id) || [];
      const best = evals.reduce((a, b) => {
        if (!a) return b;
        const ra = ({p0:0,p1:1,p2:2,p3:3})[a.priority_level] ?? 9;
        const rb = ({p0:0,p1:1,p2:2,p3:3})[b.priority_level] ?? 9;
        if (ra !== rb) return ra < rb ? a : b;
        return (a.priority_score >= b.priority_score) ? a : b;
      }, null);
      if (priorityLevels && (!best || !priorityLevels.includes(best.priority_level))) continue;
      if (minScore != null && (!best || Number(best.priority_score) < minScore)) continue;
    }
    out.push(sc);
  }
  return out;
}

//   ── Compute new channel_eligibility from action ────────
//   action: { type: 'korea_all' | 'set_channels' | 'clear' | 'unspecified', channels?: [...] }
function computeNewEligibility(action) {
  if (!action || typeof action !== 'object') throw new Error('action 필요');
  if (!ACTION_TYPES.has(action.type)) throw new Error(`알 수 없는 action.type: ${action.type}`);
  if (action.type === 'unspecified') return null;
  if (action.type === 'clear')        return [];
  if (action.type === 'korea_all')    return KOREA_ALL.slice();
  //   set_channels · custom
  if (!Array.isArray(action.channels)) throw new Error('set_channels 은 channels 배열 필요');
  const KNOWN = new Set(['ebay','shopify','coupang','naver','11st','gmarket','auction','shopee','alibaba','qoo10','other']);
  const cleaned = [];
  for (const v of action.channels) {
    if (typeof v !== 'string') throw new Error(`channels 원소는 문자열: ${typeof v}`);
    const norm = v.trim().toLowerCase();
    if (!KNOWN.has(norm)) throw new Error(`알 수 없는 채널: ${v}`);
    if (!cleaned.includes(norm)) cleaned.push(norm);
  }
  return cleaned;
}

//   ── Task estimate — 이 SKU 배치가 활성화되면 몇 개 Task 가 생성될 예정인지 ─
function estimateTaskCounts({ selectedSkus, newEligibility, channelStatusMap }) {
  const channels = newEligibility === null || (Array.isArray(newEligibility) && newEligibility.length === 0)
    ? []
    : newEligibility.filter(ch => AUTO_CHANNELS.includes(ch));
  const perChannel = Object.fromEntries(AUTO_CHANNELS.map(ch => [ch, 0]));
  let total = 0;
  for (const sc of selectedSkus) {
    for (const ch of channels) {
      const st = (channelStatusMap.get(sc.sku_master_id) || {})[ch] || 'NONE';
      if (st === 'NONE' || st === 'ERROR') {
        perChannel[ch]++;
        total++;
      }
    }
  }
  return { total, perChannel };
}

//   ── Preview (READ-ONLY · no DB write) ──────────────────
async function previewBulkEligibility({ db, filters, action }) {
  const scorecards = await loadAll(db, 'v_sku_b2c_scorecard',
    'sku_master_id,internal_sku,title,unit_cost,stock_qty,inventory_value_krw,stock_age_days,stock_age_source,sales_30d,sales_90d,ebay_sales_90d,shopify_sales_90d,channel_eligibility');
  const chRows = await loadAll(db, 'v_sku_channel_matrix', 'sku_master_id,channel,channel_status');
  const chMap = new Map();
  for (const r of chRows) {
    if (!r.channel) continue;
    if (!chMap.has(r.sku_master_id)) chMap.set(r.sku_master_id, {});
    chMap.get(r.sku_master_id)[r.channel] = r.channel_status;
  }
  //   Config for engine
  const config = await loadConfig(db);
  //   Evaluations · use WHAT-IF mode = KOREA_ALL for preview so priority_level is populated
  //   (preview 는 관리자가 "이 필터에 해당하는 SKU 가 몇 개인가" 를 볼 목적)
  const options = { defaultMode: 1 };
  const evalsBySku = new Map();
  for (const sc of scorecards) {
    const statuses = chMap.get(sc.sku_master_id) || {};
    const allSt = AUTO_CHANNELS.map(ch => ({
      channel: ch, channel_status: statuses[ch] || 'NONE',
      eligible: engine.resolveEligibility(sc.channel_eligibility, ch, options.defaultMode),
    }));
    const list = AUTO_CHANNELS.map(ch => engine.evaluateSkuChannel({
      scorecard: sc, channel: ch, channelStatus: statuses[ch] || 'NONE',
      allChannelStatuses: allSt, config, options,
    }));
    evalsBySku.set(sc.sku_master_id, list);
  }

  const selected = filterCandidates({ scorecards, channelStatusMap: chMap, evaluationsBySku: evalsBySku, filters });
  const newVal = computeNewEligibility(action);
  const estimate = estimateTaskCounts({ selectedSkus: selected, newEligibility: newVal, channelStatusMap: chMap });

  //   preview 결과 · 관리자 확인용 미리보기
  return {
    dry_run: true,
    filters,
    action,
    matched_sku_count: selected.length,
    new_eligibility: newVal,
    estimated_channel_tasks: estimate,
    sample: selected.slice(0, 20).map(s => ({
      sku_master_id: s.sku_master_id,
      internal_sku: s.internal_sku,
      title: s.title,
      stock_qty: s.stock_qty,
      unit_cost: s.unit_cost,
      inventory_value_krw: s.inventory_value_krw,
      sales_90d: s.sales_90d,
      current_eligibility: s.channel_eligibility,
    })),
  };
}

//   ── Execute (WRITE · admin API 층에서 requireAdmin) ────
async function executeBulkEligibility({ db, filters, action, userId }) {
  //   Same filtering as preview → apply to sku_master.channel_eligibility
  const preview = await previewBulkEligibility({ db, filters, action });
  const selected = preview.sample;   //   NOTE: preview.sample 은 20개만. execute 는 전체 필요.
  //   전체 대상 재계산 · scorecards 재로드 없이 execute 를 위한 재실행
  const scorecards = await loadAll(db, 'v_sku_b2c_scorecard',
    'sku_master_id,internal_sku,title,unit_cost,stock_qty,inventory_value_krw,stock_age_days,stock_age_source,sales_30d,sales_90d,ebay_sales_90d,shopify_sales_90d,channel_eligibility');
  const chRows = await loadAll(db, 'v_sku_channel_matrix', 'sku_master_id,channel,channel_status');
  const chMap = new Map();
  for (const r of chRows) {
    if (!r.channel) continue;
    if (!chMap.has(r.sku_master_id)) chMap.set(r.sku_master_id, {});
    chMap.get(r.sku_master_id)[r.channel] = r.channel_status;
  }
  const config = await loadConfig(db);
  const options = { defaultMode: 1 };
  const evalsBySku = new Map();
  for (const sc of scorecards) {
    const statuses = chMap.get(sc.sku_master_id) || {};
    const allSt = AUTO_CHANNELS.map(ch => ({
      channel: ch, channel_status: statuses[ch] || 'NONE',
      eligible: engine.resolveEligibility(sc.channel_eligibility, ch, options.defaultMode),
    }));
    evalsBySku.set(sc.sku_master_id, AUTO_CHANNELS.map(ch => engine.evaluateSkuChannel({
      scorecard: sc, channel: ch, channelStatus: statuses[ch] || 'NONE',
      allChannelStatuses: allSt, config, options,
    })));
  }
  const fullSelection = filterCandidates({ scorecards, channelStatusMap: chMap, evaluationsBySku: evalsBySku, filters });
  const newVal = computeNewEligibility(action);
  const nowIso = new Date().toISOString();

  const results = { updated: 0, unchanged: 0, errors: [] };
  for (const sc of fullSelection) {
    //   before check
    const before = sc.channel_eligibility;
    if (JSON.stringify(before) === JSON.stringify(newVal)) {
      results.unchanged++;
      continue;
    }
    const { error } = await db.from('sku_master')
      .update({ channel_eligibility: newVal, updated_at: nowIso })
      .eq('id', sc.sku_master_id);
    if (error) {
      results.errors.push({ sku_master_id: sc.sku_master_id, error: error.message });
      continue;
    }
    results.updated++;
    //   structured log for audit
    console.log('[b2c.eligibility.bulk] updated', {
      sku_master_id: sc.sku_master_id, internal_sku: sc.internal_sku,
      before, after: newVal, filters, action, by_user: userId,
    });
  }

  return {
    dry_run: false,
    filters,
    action,
    matched_sku_count: fullSelection.length,
    new_eligibility: newVal,
    results,
    at: nowIso,
    by_user: userId,
  };
}

//   ── helpers ────────────────────────────────────────────
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

module.exports = {
  AUTO_CHANNELS, KOREA_ALL,
  filterCandidates,
  computeNewEligibility,
  estimateTaskCounts,
  previewBulkEligibility,
  executeBulkEligibility,
};
