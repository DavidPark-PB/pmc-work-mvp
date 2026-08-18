/**
 * src/services/oms/inventoryExceptionQueueService.js — Phase 8B · READ-ONLY.
 *
 * Owner directive:
 *   "System watches everything. Humans inspect only exceptions."
 *
 *   Consume `inventoryDecisionEngine.assessInventoryDecision` per physical
 *   product. NEVER duplicate upstream business logic. NEVER mutate anything.
 *
 * Two separate queues (Owner §5):
 *   action_queue        — WATCH / REPLENISH / PROTECT_STOCK
 *   data_quality_queue  — INSUFFICIENT_DATA + assessment errors
 *
 * Priority score is ranking metadata ONLY. It NEVER changes decision.status
 * (Owner §6/§7 · Battle Partners WATCH must stay WATCH).
 */
'use strict';

const supabaseClient = require('../../db/supabaseClient');
const getClient = supabaseClient.getClient;
// Some test stubs may replace only `getClient` — fall back to a passthrough
// runner when withReadCache is not exported.
const withReadCache = typeof supabaseClient.withReadCache === 'function'
  ? supabaseClient.withReadCache
  : async (fn) => ({ value: await fn(), stats: { hits: 0, misses: 0, per_table: {} } });
const { assessInventoryDecision, DECISION } = require('./inventoryDecisionEngine');

const DEFAULT_CONCURRENCY = 4;

const SEVERITY = Object.freeze({
  PROTECT_STOCK: 300,
  REPLENISH: 200,
  WATCH: 100,
});

const ACTION_STATUSES = new Set([DECISION.WATCH, DECISION.REPLENISH, DECISION.PROTECT_STOCK]);

/**
 * @param {Object} args
 * @param {number} [args.limit=null]              CAP applied to returned action_queue length (ranking-safe)
 * @param {boolean} [args.activeOnly=true]        physical_products.status='active' filter
 * @param {number[]} [args.physicalIds]           override universe (tests / focus mode)
 * @param {number} [args.asOf=Date.now()]
 * @param {Object} [args.policy]
 * @param {(id) => Promise} [args.assessFn]       injectable · defaults to assessInventoryDecision
 */
async function buildInventoryExceptionQueue({
  limit = null, activeOnly = true, physicalIds = null,
  asOf = Date.now(), policy = null,
  assessFn = null,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const t0 = process.hrtime ? process.hrtime.bigint() : null;
  const nowIso = new Date(asOf).toISOString();

  // 8B-1: entire batch runs under a single READ-cache scope so that identical
  //       reads (physical_products, oms_orders/items, sku_master_link, etc.)
  //       are executed once and reused across all physicals & across the
  //       repeated internal calls each physical makes.
  const { value: batchOutcome, stats: cacheStats } = await withReadCache(async () => {
    const db = getClient();

    // 1) Discover physical-product universe (READ-ONLY)
    const universe = await _loadUniverse(db, { activeOnly, physicalIds });

    const _assess = assessFn || (id => assessInventoryDecision({ physicalProductId: id, asOf, policy }));

    // 2) Assess each physical (failure isolated · Owner §10) · bounded concurrency
    const results = new Array(universe.length);
    const assessmentErrors = [];
    const summary = _initSummary();
    await _mapLimit(universe, Math.max(1, concurrency), async (phy, i) => {
      try {
        const decisionResult = await _assess(phy.id);
        if (decisionResult) results[i] = { physical: phy, decisionResult };
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        assessmentErrors.push({ physical_product_id: phy.id, title: phy.canonical_title, error_message: msg });
      }
    });
    // Prune holes from failed rows to keep downstream code identical.
    const compact = results.filter(Boolean);
    return { universe, results: compact, assessmentErrors, summary };
  });

  const { results, assessmentErrors, summary } = batchOutcome;

  // 3) Count + classify
  for (const r of results) {
    const st = r.decisionResult.decision?.status;
    if (st === DECISION.SELL_NORMALLY) summary.sell_normally_count++;
    else if (st === DECISION.WATCH) summary.watch_count++;
    else if (st === DECISION.REPLENISH) summary.replenish_count++;
    else if (st === DECISION.PROTECT_STOCK) summary.protect_stock_count++;
    else if (st === DECISION.INSUFFICIENT_DATA) summary.insufficient_data_count++;
  }
  summary.physical_products_assessed = results.length;
  summary.assessment_errors_count = assessmentErrors.length;

  // 4) Build action queue (WATCH / REPLENISH / PROTECT_STOCK)
  const actionQueue = [];
  for (const r of results) {
    const st = r.decisionResult.decision?.status;
    if (!ACTION_STATUSES.has(st)) continue;
    const ranked = _rankAction(r.decisionResult, r.physical);
    actionQueue.push(ranked);
  }
  actionQueue.sort((a, b) => (b.priority_score - a.priority_score) || (a.physical_product_id - b.physical_product_id));
  actionQueue.forEach((row, i) => { row.rank = i + 1; });

  // 5) Data-quality queue (INSUFFICIENT_DATA + assessment_errors)
  const dataQualityQueue = [];
  for (const r of results) {
    if (r.decisionResult.decision?.status !== DECISION.INSUFFICIENT_DATA) continue;
    dataQualityQueue.push({
      physical_product_id: r.physical.id,
      title: r.physical.canonical_title,
      missing_evidence: r.decisionResult.missing_evidence || [],
      reason_codes: r.decisionResult.decision.reason_codes || [],
      classification: 'insufficient_data',
    });
  }
  for (const e of assessmentErrors) {
    dataQualityQueue.push({
      physical_product_id: e.physical_product_id,
      title: e.title,
      missing_evidence: ['assessment_error'],
      reason_codes: ['assessment_error'],
      error_message: e.error_message,
      classification: 'assessment_error',
    });
  }
  summary.action_exception_count = actionQueue.length;
  summary.data_quality_count = dataQualityQueue.length;

  // 6) Apply limit (ranking-safe — after sort)
  const limitedActionQueue = (limit != null && Number.isInteger(limit) && limit >= 0)
    ? actionQueue.slice(0, limit) : actionQueue;

  // 7) Runtime + defensible cache metrics
  let runtimeMs = null;
  if (t0 != null && process.hrtime) {
    const t1 = process.hrtime.bigint();
    runtimeMs = Number(t1 - t0) / 1_000_000;
  }
  const physicalsN = summary.physical_products_assessed;
  const avgMs = physicalsN > 0 && runtimeMs != null ? Math.round((runtimeMs / physicalsN) * 100) / 100 : null;

  return {
    generated_at: nowIso,
    summary: {
      ...summary,
      runtime_ms: runtimeMs,
      avg_ms_per_physical: avgMs,
      concurrency,
      // Cache stats (defensible · counts actual proxy hits/misses in this batch)
      db_cache_hits: cacheStats.hits,
      db_cache_misses: cacheStats.misses,
      db_cache_per_table: cacheStats.per_table,
    },
    action_queue: limitedActionQueue,
    action_queue_total: actionQueue.length,
    action_queue_limit_applied: limit ?? null,
    data_quality_queue: dataQualityQueue,
    assessment_errors: assessmentErrors,
  };
}

// ─── bounded concurrency ─────────────────────────────────

/**
 * Await `fn(item, i)` on all items with at most `limit` in flight.
 * Never rejects — fn is expected to trap its own errors (queue does).
 */
async function _mapLimit(items, limit, fn) {
  const workers = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  const w = Math.min(limit, Math.max(1, items.length));
  for (let k = 0; k < w; k++) workers.push(worker());
  await Promise.all(workers);
}

// ─── universe ────────────────────────────────────────────

async function _loadUniverse(db, { activeOnly, physicalIds }) {
  if (Array.isArray(physicalIds) && physicalIds.length > 0) {
    const { data } = await db.from('physical_products')
      .select('id, canonical_title, set_code, language, region, unit_type, status').in('id', physicalIds);
    return data || [];
  }
  const q = db.from('physical_products')
    .select('id, canonical_title, set_code, language, region, unit_type, status');
  const { data } = activeOnly ? await q.eq('status', 'active') : await q;
  return data || [];
}

// ─── ranking ─────────────────────────────────────────────

/**
 * Deterministic priority ranking. Priority NEVER changes decision.status
 * (Owner §6/§7). All tie-breakers are derived from ALREADY-COMPUTED
 * upstream decision outputs · never recomputed here.
 */
function _rankAction(decisionResult, phy) {
  const d = decisionResult.decision || {};
  const dm = decisionResult.demand_summary || {};
  const sp = decisionResult.supply_summary || {};
  const status = d.status;
  const base = SEVERITY[status] || 0;

  let score = base;
  const reasons = [`base_severity_${status.toLowerCase()}_${base}`];

  // (a) Supply-side risk tie-breakers (all sourced from upstream)
  if (sp.replacement_difficulty === 'VERY_HARD') { score += 30; reasons.push('difficulty_very_hard_+30'); }
  else if (sp.replacement_difficulty === 'HARD') { score += 20; reasons.push('difficulty_hard_+20'); }
  else if (sp.replacement_difficulty === 'MODERATE') { score += 10; reasons.push('difficulty_moderate_+10'); }

  if (sp.uncovered_at_60 != null && sp.uncovered_at_60 > 0) { score += 15; reasons.push(`uncovered_at_60_${sp.uncovered_at_60}_+15`); }
  if (sp.uncovered_at_100 != null && sp.uncovered_at_100 > 0) { score += 10; reasons.push(`uncovered_at_100_${sp.uncovered_at_100}_+10`); }

  const dep60 = sp.secondary_market_dependency_by_target && sp.secondary_market_dependency_by_target[60];
  if (dep60 != null && dep60 > 0.5) { score += 10; reasons.push(`secondary_dependency_60_${(dep60 * 100).toFixed(0)}pct_+10`); }

  if (d.depth_gap != null && d.depth_gap > 0) { score += 5; reasons.push(`depth_gap_${d.depth_gap}_+5`); }

  if (sp.current_supply_layers === 0) { score += 15; reasons.push('no_current_supply_layer_+15'); }
  else if (!sp.has_current_supplier_or_executable) { score += 10; reasons.push('no_current_supplier_or_executable_+10'); }

  // (b) DoS-based tie-breaker — GATED (Owner §7): only trust DoS when demand
  //     is NOT concentrated (concentrated demand makes DoS misleading).
  const dosMeaningful = dm.demand_pattern && dm.demand_pattern !== 'concentrated_large_order';
  if (dosMeaningful && dm.raw_days_of_supply != null) {
    if (dm.raw_days_of_supply < 7)  { score += 20; reasons.push('dos_below_7_+20'); }
    else if (dm.raw_days_of_supply < 14) { score += 10; reasons.push('dos_below_14_+10'); }
  } else if (dm.demand_pattern === 'concentrated_large_order') {
    reasons.push('dos_gated_concentrated_demand_no_change');
  }

  return {
    rank: null,   // filled after global sort
    physical_product_id: phy.id,
    title: phy.canonical_title,
    decision_status: status,             // Owner §6/§7: status preserved verbatim
    confidence_level: d.confidence_level,
    priority_score: score,
    priority_reasons: reasons,
    available_units: decisionResult.inventory_summary?.available ?? null,
    raw_days_of_supply: dm.raw_days_of_supply ?? null,
    demand_pattern: dm.demand_pattern ?? null,
    replacement_difficulty: sp.replacement_difficulty ?? null,
    evidenced_replacement_depth: sp.evidenced_replacement_depth ?? null,
    depth_gap: d.depth_gap ?? null,
    reason_codes: d.reason_codes || [],
    recommended_human_action: decisionResult.recommended_human_action || null,
  };
}

function _initSummary() {
  return {
    physical_products_assessed: 0,
    sell_normally_count: 0, watch_count: 0, replenish_count: 0, protect_stock_count: 0,
    insufficient_data_count: 0,
    action_exception_count: 0, data_quality_count: 0,
    assessment_errors_count: 0,
  };
}

module.exports = {
  SEVERITY, DECISION,
  buildInventoryExceptionQueue,
  _internals: { _rankAction },
};
