'use strict';
/**
 * dataQualityTasks.js — B2C · Phase 5 · DATA_QUALITY task queue (별도 dedupe).
 *
 * Owner directive:
 *   · exception_type='data_quality.cost_missing' · channel=NULL · SKU 당 1개
 *   · dedupe: (related_sku_id, exception_type)  ← Migration 101 unique index
 *   · 완료조건: sku_master.cost_krw IS NOT NULL 재확인
 *   · 원가 여전히 NULL 이면 완료 거부.
 *   · 조건 (기본):
 *       stock_qty > 0
 *       AND cost_krw IS NULL
 *       AND sales_90d >= b2c.cost_missing_sales_threshold (default 3)
 */

const ACTIVE_STATUSES = ['pending', 'in_progress', 'qc_pending'];

//   ── Pure planner ─────────────────────────────────────────
function planDataQualityCostMissing({ scorecards, existingActiveSkuIds, threshold, maxPer, nowISO }) {
  const stats = {
    raw: scorecards.length,
    excluded_has_cost: 0,
    excluded_zero_stock: 0,
    excluded_low_sales: 0,
    excluded_duplicate: 0,
    after_filters: 0,
    beyond_slot_limit: 0,
  };
  const eligible = [];
  const T = Number(threshold) || 3;
  for (const s of scorecards) {
    if (s.unit_cost != null) { stats.excluded_has_cost++; continue; }
    if ((Number(s.stock_qty) || 0) <= 0) { stats.excluded_zero_stock++; continue; }
    const totalSales = (Number(s.ebay_sales_90d) || 0) + (Number(s.shopify_sales_90d) || 0);
    if (totalSales < T) { stats.excluded_low_sales++; continue; }
    if (existingActiveSkuIds.has(s.sku_master_id)) { stats.excluded_duplicate++; continue; }
    eligible.push(s);
  }
  stats.after_filters = eligible.length;

  //   Sort · sales DESC → inventory sales impact 큰 것 먼저 · then sku_master_id ASC
  eligible.sort((a, b) => {
    const sa = (Number(a.ebay_sales_90d) || 0) + (Number(a.shopify_sales_90d) || 0);
    const sb = (Number(b.ebay_sales_90d) || 0) + (Number(b.shopify_sales_90d) || 0);
    if (sa !== sb) return sb - sa;
    return (Number(a.sku_master_id) || 0) - (Number(b.sku_master_id) || 0);
  });

  const slots = Math.max(0, Number(maxPer) || 150);
  const plan = eligible.slice(0, slots).map(s => taskRow(s, nowISO));
  stats.beyond_slot_limit = Math.max(0, eligible.length - slots);
  return { plan, filtered: stats };
}

function taskRow(s, nowISO) {
  const sales90 = (Number(s.ebay_sales_90d) || 0) + (Number(s.shopify_sales_90d) || 0);
  return {
    title:           `[B2C DATA] cost_krw 없음 · ${s.internal_sku} (판매 ${sales90}건)`,
    assignee_id:     null,
    assignee_scope:  'operators',
    priority:        'normal',
    priority_level:  'p1',            //   DATA_QUALITY 는 판매 검증 있어야 만들어짐 (P1급 취급)
    priority_score:  Math.min(100, sales90 * 5 + 20),   //   sales 기반 단순 score
    channel:         null,             //   DATA_QUALITY 는 channel 없음
    status:          'pending',
    memo:            `원가 미입력 · 최근 90일 판매 ${sales90}건 (eBay ${s.ebay_sales_90d||0} · Shopify ${s.shopify_sales_90d||0}) · cost 입력 시 자동 완료 가능`,
    created_by:      0,
    auto_generated:  true,
    exception_type:  'data_quality.cost_missing',
    dedupe_key:      `b2c_dq_cost:${s.sku_master_id}`,
    severity:        'medium',
    related_sku_id:  s.sku_master_id,
    context: {
      domain:              'b2c_inventory_distribution',
      task_type:           'data_quality.cost_missing',
      engine_version:      'v1',
      generated_at:        nowISO,
      sku_master_id:       s.sku_master_id,
      internal_sku:        s.internal_sku,
      title:               s.title,
      stock_qty:           s.stock_qty,
      ebay_sales_90d:      s.ebay_sales_90d,
      shopify_sales_90d:   s.shopify_sales_90d,
      sales_90d:           sales90,
      required_action:     'sku_master.cost_krw 입력',
      completion_gate:     'cost_krw IS NOT NULL',
    },
  };
}

//   ── DB orchestrator ───────────────────────────────────
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

async function refillDataQualityCostMissingQueue({ db, dryRun = true }) {
  const runId = `dq_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const startedAt = new Date().toISOString();

  const { data: cfgRows } = await db.from('margin_settings')
    .select('setting_key, setting_value')
    .in('setting_key', ['b2c.cost_missing_sales_threshold', 'b2c.max_tasks_per_refill']);
  const cfg = {};
  for (const r of (cfgRows || [])) cfg[r.setting_key.replace(/^b2c\./,'')] = Number(r.setting_value);

  const scorecards = await loadAll(db, 'v_sku_b2c_scorecard',
    'sku_master_id, internal_sku, title, unit_cost, stock_qty, ebay_sales_90d, shopify_sales_90d');

  //   기존 active DATA_QUALITY.cost_missing 태스크의 sku_master_id set
  const existingRows = await loadAll(db, 'team_tasks', 'related_sku_id, exception_type, status');
  const existingSkuIds = new Set();
  for (const r of existingRows) {
    if (!ACTIVE_STATUSES.includes(r.status)) continue;
    if (r.exception_type !== 'data_quality.cost_missing') continue;
    if (r.related_sku_id) existingSkuIds.add(r.related_sku_id);
  }

  const planning = planDataQualityCostMissing({
    scorecards, existingActiveSkuIds: existingSkuIds,
    threshold: cfg.cost_missing_sales_threshold,
    maxPer: cfg.max_tasks_per_refill,
    nowISO: startedAt,
  });

  let created = 0;
  let errors = [];
  let duplicate_race = 0;
  let insertedIds = [];
  if (!dryRun && planning.plan.length > 0) {
    for (const row of planning.plan) {
      const { data, error } = await db.from('team_tasks').insert({ ...row }).select('id').maybeSingle();
      if (error) {
        if (error.code === '23505' || /duplicate key/i.test(error.message)) { duplicate_race++; continue; }
        errors.push({ related_sku_id: row.related_sku_id, error: error.message, code: error.code });
        continue;
      }
      if (data && data.id) { created++; insertedIds.push(data.id); }
    }
    planning.filtered.duplicate_race = duplicate_race;
  }

  return {
    run_id: runId,
    dry_run: dryRun,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    config: cfg,
    active_before: existingSkuIds.size,
    candidates_evaluated: planning.filtered.raw,
    filtered: planning.filtered,
    data_quality_tasks_planned: planning.plan.length,
    data_quality_tasks_created: created,
    inserted_ids: insertedIds,
    errors,
    plan: planning.plan,
  };
}

//   ── Completion validator (Owner spec §10) ─────────────
//   DATA_QUALITY.cost_missing 태스크 완료 요청 시 반드시 sku_master.cost_krw NOT NULL 재검증.
async function completeDataQualityCostMissing({ db, taskId, userId }) {
  const nowIso = new Date().toISOString();
  //   1. Task 조회
  const { data: task, error: e1 } = await db.from('team_tasks').select('*').eq('id', taskId).maybeSingle();
  if (e1) throw new Error(`task load: ${e1.message}`);
  if (!task) return { ok: false, code: 'TASK_NOT_FOUND' };
  if (task.exception_type !== 'data_quality.cost_missing') {
    return { ok: false, code: 'WRONG_TASK_TYPE', message: `expected data_quality.cost_missing, got ${task.exception_type}` };
  }
  if (task.status === 'done' || task.status === 'failed') {
    return { ok: false, code: 'ALREADY_TERMINAL', message: `status=${task.status}` };
  }
  //   2. SKU cost_krw 재검증
  const skuId = task.related_sku_id;
  if (!skuId) return { ok: false, code: 'NO_SKU_LINK' };
  const { data: sku, error: e2 } = await db.from('sku_master').select('id, internal_sku, cost_krw').eq('id', skuId).maybeSingle();
  if (e2) throw new Error(`sku load: ${e2.message}`);
  if (!sku) return { ok: false, code: 'SKU_NOT_FOUND' };
  if (sku.cost_krw == null || Number(sku.cost_krw) <= 0) {
    return {
      ok: false, code: 'COST_STILL_MISSING',
      message: `SKU ${sku.internal_sku} · cost_krw 여전히 ${sku.cost_krw == null ? 'NULL' : sku.cost_krw} · SKU 마스터에서 원가 입력 후 재시도`,
      sku_master_id: skuId, internal_sku: sku.internal_sku, cost_krw: sku.cost_krw,
    };
  }
  //   3. 완료 처리
  const updateBody = {
    status: 'done',
    completed_at: nowIso,
    completion_note: `Cost 입력 확인 · ₩${Number(sku.cost_krw).toLocaleString()} · 검증 통과`,
  };
  const { error: e3 } = await db.from('team_tasks').update(updateBody).eq('id', taskId);
  if (e3) return { ok: false, code: 'UPDATE_FAILED', message: e3.message };
  console.log('[b2c.data_quality.complete] validated', { taskId, sku_master_id: skuId, cost_krw: sku.cost_krw, by_user: userId });
  return {
    ok: true, code: 'COMPLETED',
    task_id: taskId, sku_master_id: skuId, internal_sku: sku.internal_sku, cost_krw: sku.cost_krw,
    completed_at: nowIso,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  planDataQualityCostMissing,
  taskRow,
  refillDataQualityCostMissingQueue,
  completeDataQualityCostMissing,
};
