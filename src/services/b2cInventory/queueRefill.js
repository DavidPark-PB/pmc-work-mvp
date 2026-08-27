'use strict';
/**
 * queueRefill.js — B2C Inventory Distribution OS · Phase 5 · Controlled Task Queue.
 *
 * Owner directive (2026-08-25):
 *   · 7,234 후보를 한 번에 INSERT 하지 않는다. active queue 를 target/threshold 로 통제.
 *   · dryRun=true 가 기본. execute 는 관리자 명시적 호출.
 *   · Scheduler 연결은 Phase 6.
 *   · P3 default 제외. include_p3 옵션으로 활성화.
 *
 * 분리:
 *   · planRefill(...)  · pure function · testable · no I/O · 순수 계산
 *   · refillChannelRegistrationQueue({ db, ... })  · DB 오케스트레이션 wrapper
 *
 * 정렬 규칙 (Owner spec §7):
 *   priority_level ASC (P0<P1<P2<P3)
 *   → priority_score DESC
 *   → inventory_value_krw DESC
 *   → sales_90d DESC
 *   → sku_master_id ASC (deterministic tie-breaker)
 *
 * dedup:
 *   · existingActiveKeys = Set<`${sku_master_id}|${channel}|${exception_type}`>
 *   · UNIQUE partial index (uq_team_tasks_b2c_active_dedupe) 가 DB race 도 방어.
 *
 * exception_type: 'channel_register.<channel>'
 * channel: 'coupang' | 'naver' | '11st' | 'gmarket'
 */

const engine = require('./priorityEngine');
const allocation = require('./allocationStrategy');
const autoAssign = require('./autoAssignment');
const explicit = require('./explicitAssignment');
const events = require('./executionEvents');

const LEVEL_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const ACTIVE_STATUSES = ['pending', 'in_progress', 'qc_pending'];
const AUTO_CHANNELS = ['coupang', 'naver', '11st', 'gmarket'];

//   ── Pure planner ────────────────────────────────────────
//   Input:
//     activeCount           : 현재 B2C CHANNEL_REGISTER active tasks 수
//     config                : { active_queue_target, active_queue_refill_threshold, max_tasks_per_refill, include_p3, default_eligibility_mode, old_stock_days, very_old_stock_days, high_value_threshold_krw }
//     candidates            : [ evaluation objects from Priority Engine (모든 SKU × 4채널) ]
//     existingActiveKeys    : Set<`${sku_master_id}|${channel}|channel_register.${channel}`>
//     nowISO                : ISO string · 감사 스탬프용
//   Output:
//     { slotsAvailable, plan, filtered, reason }
function planRefill({ activeCount, config, candidates, existingActiveKeys, nowISO, allocationStrategy = 'GLOBAL_PRIORITY', pilotMaxTasks = null, skuIds = null, createdBy = 2 }) {
  const target = Number(config.active_queue_target) || 300;
  const threshold = Number(config.active_queue_refill_threshold) || 200;
  const globalMaxPer = Number(config.max_tasks_per_refill) || 150;
  //   pilot override 는 globalMaxPer 보다 작을 때만 유효 (Owner 안전장치: 절대 늘리지 않음)
  const maxPer = pilotMaxTasks != null ? Math.min(globalMaxPer, Math.max(0, Number(pilotMaxTasks))) : globalMaxPer;
  const includeP3 = Number(config.include_p3) === 1;
  //   Phase 7.5 · Wave 지원 · skuIds 지정 시 그 SKU 만 대상 (그 외는 모두 제외 · 순서/우선순위 룰은 그대로)
  const skuIdSet = Array.isArray(skuIds) && skuIds.length > 0 ? new Set(skuIds.map(Number)) : null;

  //   1) queue healthy check
  if (activeCount >= threshold) {
    return {
      slotsAvailable: 0,
      plan: [],
      filtered: {
        raw: candidates.length,
        excluded_no_level: 0,
        excluded_p3: 0,
        excluded_ineligible: 0,
        excluded_not_none_or_error: 0,
        excluded_duplicate: 0,
        after_filters: 0,
        beyond_slot_limit: 0,
      },
      reason: 'QUEUE_HEALTHY',
    };
  }

  //   2) slots — target 까지 채우되 max_per_refill 로 clip
  const slotsAvailable = Math.min(Math.max(0, target - activeCount), maxPer);

  //   3) filter candidates
  const stats = {
    raw: candidates.length,
    excluded_no_level: 0,
    excluded_p3: 0,
    excluded_ineligible: 0,
    excluded_not_none_or_error: 0,
    excluded_duplicate: 0,
    excluded_not_in_sku_ids: 0,   //   Phase 7.5 · Wave filter 결과
    after_filters: 0,
    beyond_slot_limit: 0,
  };
  const eligibleCandidates = [];
  for (const c of candidates) {
    if (c.priority_level == null)                             { stats.excluded_no_level++; continue; }
    if (!c.eligible)                                          { stats.excluded_ineligible++; continue; }
    if (c.channel_status !== 'NONE' && c.channel_status !== 'ERROR') { stats.excluded_not_none_or_error++; continue; }
    if (!includeP3 && c.priority_level === 'p3')              { stats.excluded_p3++; continue; }
    if (skuIdSet && !skuIdSet.has(Number(c.sku_master_id)))   { stats.excluded_not_in_sku_ids++; continue; }
    const key = `${c.sku_master_id}|${c.channel}|channel_register.${c.channel}`;
    if (existingActiveKeys.has(key))                          { stats.excluded_duplicate++; continue; }
    eligibleCandidates.push(c);
  }
  stats.after_filters = eligibleCandidates.length;

  //   4) sort · allocation strategy 별 (deterministic 모두 유지)
  let sorted;
  if (allocationStrategy === 'BALANCED_CHANNEL') {
    sorted = allocation.allocateBalancedChannel(eligibleCandidates, AUTO_CHANNELS);
  } else {
    sorted = allocation.allocateGlobalPriority(eligibleCandidates);
  }

  //   5) take top slotsAvailable
  const plan = sorted.slice(0, slotsAvailable).map(c => taskRowFromCandidate(c, nowISO, createdBy));
  stats.beyond_slot_limit = Math.max(0, sorted.length - slotsAvailable);

  return {
    slotsAvailable,
    plan,
    filtered: stats,
    reason: slotsAvailable > 0 ? 'REFILL_PLANNED' : 'NO_SLOTS',
    allocation_strategy: allocationStrategy,
    pilot_max_tasks: pilotMaxTasks,
  };
}

//   ── Task row builder — Owner spec §16 context snapshot ─
function taskRowFromCandidate(c, nowISO, createdBy = 2) {
  //   createdBy default = 2 (owner) — 기존 team_tasks 관습 (auto-generated 954건 모두 owner attribution)
  //   FK team_tasks.created_by → users.id · 반드시 실제 user id 여야 함 (0 은 FK 위반)
  return {
    title:            `[B2C] ${c.channel} 채널 등록 · ${c.internal_sku}`,
    assignee_id:      null,                     //   Phase 6 에서 round-robin
    assignee_scope:   'operators',              //   기존 값 유지 (operators = 운영팀 대상 fanout)
    priority:         'normal',                 //   legacy 컬럼 (P0/P1/P2/P3 는 priority_level 에)
    priority_level:   c.priority_level,
    priority_score:   c.priority_score,
    channel:          c.channel,
    status:           'pending',
    memo:             c.reasons ? c.reasons.slice(0, 3).join(' · ') : null,
    created_by:       Number(createdBy) || 2,
    auto_generated:   true,
    exception_type:   `channel_register.${c.channel}`,
    dedupe_key:       `b2c_ch:${c.sku_master_id}:${c.channel}`,
    severity:         c.priority_level === 'p0' ? 'high' : (c.priority_level === 'p1' ? 'medium' : 'low'),
    related_sku_id:   c.sku_master_id,
    context:          {
      domain:              'b2c_inventory_distribution',
      engine_version:      'v1',
      generated_at:        nowISO,
      sku_master_id:       c.sku_master_id,
      internal_sku:        c.internal_sku,
      title:               c.title,
      channel:             c.channel,
      channel_status:      c.channel_status,
      stock_qty:           c.stock_qty,
      cost_krw:            c.unit_cost,
      inventory_value_krw: c.inventory_value_krw,
      sales_90d:           (Number(c.ebay_sales_90d) || 0) + (Number(c.shopify_sales_90d) || 0),
      ebay_sales_90d:      c.ebay_sales_90d,
      shopify_sales_90d:   c.shopify_sales_90d,
      stock_age_days:      c.stock_age_days,
      stock_age_source:    c.stock_age_source,
      stock_age_confidence: c.stock_age_confidence,
      priority_level:      c.priority_level,
      priority_score:      c.priority_score,
      sub_scores: {
        sales:     c.sales_validation_score,
        inventory: c.inventory_value_score,
        gap:       c.channel_gap_score,
        aging:     c.aging_score,
        margin:    c.margin_score,
      },
      data_quality_flags:  c.data_quality_flags,
      reasons:             c.reasons,
    },
  };
}

//   ── DB orchestrator ───────────────────────────────────
//   loadCandidates: Priority Engine 을 프로덕션 데이터 위에 실행. eligibility resolution 은 engine 내장.
async function loadCandidatesFromDb({ db, config, defaultMode }) {
  //   scorecard 전체 load
  const sc = await loadAll(db, 'v_sku_b2c_scorecard',
    'sku_master_id,internal_sku,title,unit_cost,stock_qty,inventory_value_krw,stock_age_days,stock_age_source,sales_30d,sales_90d,ebay_sales_90d,shopify_sales_90d,live_channels,registered_channels,observed_channels,missing_channels_seen,channel_eligibility');
  //   channel status map · v_sku_channel_matrix
  const chRows = await loadAll(db, 'v_sku_channel_matrix', 'sku_master_id,channel,channel_status');
  const chMap = new Map();
  for (const r of chRows) {
    if (!r.channel) continue;
    if (!chMap.has(r.sku_master_id)) chMap.set(r.sku_master_id, {});
    chMap.get(r.sku_master_id)[r.channel] = r.channel_status;
  }

  const options = { defaultMode };
  const out = [];
  for (const s of sc) {
    const statuses = chMap.get(s.sku_master_id) || {};
    const allStatuses = AUTO_CHANNELS.map(ch => ({
      channel: ch,
      channel_status: statuses[ch] || 'NONE',
      eligible: engine.resolveEligibility(s.channel_eligibility, ch, options.defaultMode),
    }));
    for (const ch of AUTO_CHANNELS) {
      out.push(engine.evaluateSkuChannel({
        scorecard: s,
        channel: ch,
        channelStatus: statuses[ch] || 'NONE',
        allChannelStatuses: allStatuses,
        config,
        options,
      }));
    }
  }
  return out;
}

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

async function loadConfigFromDb(db) {
  const keys = [
    'b2c.active_queue_target', 'b2c.active_queue_refill_threshold', 'b2c.max_tasks_per_refill',
    'b2c.include_p3', 'b2c.default_eligibility_mode',
    'b2c.old_stock_days', 'b2c.very_old_stock_days', 'b2c.high_value_threshold_krw',
    'b2c.sales_validation_days', 'b2c.cost_missing_sales_threshold',
  ];
  const { data, error } = await db.from('margin_settings').select('setting_key, setting_value').in('setting_key', keys);
  if (error) throw new Error('config load: ' + error.message);
  const cfg = {};
  for (const r of (data || [])) {
    cfg[r.setting_key.replace(/^b2c\./, '')] = Number(r.setting_value);
  }
  return cfg;
}

async function loadActiveChannelRegisterCount(db) {
  const { count, error } = await db.from('team_tasks').select('*', { count: 'exact', head: true })
    .in('status', ACTIVE_STATUSES).like('exception_type', 'channel_register.%');
  if (error) throw new Error('active count: ' + error.message);
  return Number(count) || 0;
}

async function loadExistingActiveKeys(db) {
  //   dedup 대조용. exception_type LIKE 'channel_register.%' AND active
  const rows = await loadAll(db, 'team_tasks', 'related_sku_id, channel, exception_type, status');
  const keys = new Set();
  for (const r of rows) {
    if (!ACTIVE_STATUSES.includes(r.status)) continue;
    if (!r.related_sku_id || !r.channel) continue;
    if (!String(r.exception_type || '').startsWith('channel_register.')) continue;
    keys.add(`${r.related_sku_id}|${r.channel}|${r.exception_type}`);
  }
  return keys;
}

//   ── Main entry (DB) ─────────────────────────────────────
//   Options:
//     db                 supabase client (required)
//     dryRun             default true
//     whatIfMode         null (config default) | 0 (NONE) | 1 (KOREA_ALL)
//     allocationStrategy 'GLOBAL_PRIORITY' (default) | 'BALANCED_CHANNEL'
//     pilotMaxTasks      정수 · Pilot execute 시 refill 상한 override (global max 보다 작을 때만 유효)
//     autoAssignEnabled  null (config 값 · b2c.auto_assignment_enabled) | true | false
//     userId             감사 로그용
async function refillChannelRegistrationQueue({
  db, dryRun = true, whatIfMode = null,
  allocationStrategy = 'GLOBAL_PRIORITY', pilotMaxTasks = null,
  autoAssignEnabled = null, userId = null,
  skuIds = null,   //   Phase 7.5 · Wave 지원 · 특정 SKU 만 대상
  //   Phase 7.6 · EXPLICIT_CHANNEL_OWNER 배정 (Global auto_assignment_enabled 과 별개)
  assignmentMode = null,     //   null (default) | 'AUTO' | 'EXPLICIT_CHANNEL_OWNER'
  channelOwners = null,      //   { [channel]: userId } · EXPLICIT_CHANNEL_OWNER 필수
  createdBy = 2,             //   team_tasks.created_by · FK users(id) · default owner(2)
} = {}) {
  const runId = `refill_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const startedAt = new Date().toISOString();

  const config = await loadConfigFromDb(db);
  const effectiveMode = whatIfMode != null ? Number(whatIfMode) : (Number(config.default_eligibility_mode) || 0);
  const effectiveAuto = autoAssignEnabled != null
    ? !!autoAssignEnabled
    : Number(config.auto_assignment_enabled) === 1;

  const [activeCount, candidates, existingActiveKeys] = await Promise.all([
    loadActiveChannelRegisterCount(db),
    loadCandidatesFromDb({ db, config, defaultMode: effectiveMode }),
    loadExistingActiveKeys(db),
  ]);

  const planning = planRefill({
    activeCount, config, candidates, existingActiveKeys, nowISO: startedAt,
    allocationStrategy, pilotMaxTasks, skuIds, createdBy,
  });

  //   ── Assignment ─────────────────────────────────
  //   Phase 7.6: EXPLICIT_CHANNEL_OWNER 최우선 · 다음이 Global auto (config) · 마지막이 unassigned fallback
  let assignmentApplied = { mode: 'UNASSIGNED', unassigned: planning.plan.length, assigned: 0 };
  let assignmentSummary = null;

  if (assignmentMode === 'EXPLICIT_CHANNEL_OWNER' && planning.plan.length > 0) {
    //   validate all-or-nothing · plan 에 있는 unique channels 대상
    const uniqueChannels = Array.from(new Set(planning.plan.map(t => t.channel).filter(Boolean)));
    const ownerIds = Object.values(channelOwners || {}).map(Number).filter(Number.isFinite);
    const ownerUsers = await explicit.loadOwnerUsers({ db, userIds: ownerIds });
    const validation = explicit.validateExplicitChannelOwners({
      channelOwners, channelsInPlan: uniqueChannels, users: ownerUsers,
    });
    if (!validation.ok) {
      //   부분 생성 금지 · 전체 요청 실패
      return {
        run_id: `refill_reject_${Date.now()}`, dry_run: dryRun,
        started_at: startedAt, finished_at: new Date().toISOString(),
        code: 'ASSIGNMENT_VALIDATION_FAILED', ok: false,
        assignment_mode: assignmentMode,
        assignment_errors: validation.errors,
        active_before: activeCount, target: Number(config.active_queue_target) || 300,
        channel_tasks_planned: 0, channel_tasks_created: 0,
        candidates_evaluated: planning.filtered.raw,
        plan: [],
        reason: 'ASSIGNMENT_VALIDATION_FAILED',
      };
    }
    const withAssignees = explicit.applyExplicitAssignment({ plan: planning.plan, channelOwners });
    planning.plan.length = 0;
    planning.plan.push(...withAssignees);
    assignmentSummary = explicit.summarizeAssignment({ plan: withAssignees, users: ownerUsers });
    assignmentApplied = {
      mode: 'EXPLICIT_CHANNEL_OWNER',
      eligible_count: ownerUsers.length,
      unassigned: assignmentSummary.unassigned_count,
      assigned: assignmentSummary.total_tasks - assignmentSummary.unassigned_count,
      by_channel: assignmentSummary.by_channel,
    };
  } else if (effectiveAuto && planning.plan.length > 0) {
    //   Global auto assignment · Phase 6 로직 (config gated)
    const eligibles = await autoAssign.loadEligibleEmployees(db);
    if (eligibles.length === 0) {
      assignmentApplied = { mode: 'AUTO', enabled: true, eligible_count: 0, unassigned: planning.plan.length, assigned: 0, note: 'no_eligible_employees' };
    } else {
      const counts = await autoAssign.loadActiveB2cTaskCounts(db, eligibles.map(u => u.id));
      const withAssignees = autoAssign.assignLeastActive({ eligibles, activeCounts: counts, plan: planning.plan });
      planning.plan.length = 0;
      planning.plan.push(...withAssignees);
      assignmentApplied = {
        mode: 'AUTO',
        enabled: true,
        eligible_count: eligibles.length,
        unassigned: withAssignees.filter(t => t.assignee_id == null).length,
        assigned: withAssignees.filter(t => t.assignee_id != null).length,
      };
    }
  }

  //   ── INSERT (execute mode) ─────────────────────────────
  let created = 0;
  let dbErrors = [];
  let insertedIds = [];
  if (!dryRun && planning.plan.length > 0) {
    let duplicate_race = 0;
    for (const row of planning.plan) {
      const { data, error } = await db.from('team_tasks').insert({ ...row }).select('id').maybeSingle();
      if (error) {
        if (error.code === '23505' || /duplicate key/i.test(error.message)) { duplicate_race++; continue; }
        dbErrors.push({ related_sku_id: row.related_sku_id, channel: row.channel, error: error.message, code: error.code });
        continue;
      }
      if (data && data.id) {
        created++;
        insertedIds.push(data.id);
        if (row.assignee_id != null) {
          events.log('TASK_AUTO_ASSIGNED', { task_id: data.id, sku_master_id: row.related_sku_id, channel: row.channel, assignee_id: row.assignee_id, run_id: runId });
        }
      }
    }
    planning.filtered.duplicate_race = duplicate_race;
    events.log('QUEUE_REFILL_EXECUTED', {
      run_id: runId, created, dry_run: false, allocation_strategy: allocationStrategy,
      pilot_max_tasks: pilotMaxTasks, active_before: activeCount, target: Number(config.active_queue_target) || 300,
      auto_assignment: effectiveAuto, by_user: userId,
    });
  }

  const finishedAt = new Date().toISOString();

  return {
    ok: true,
    run_id: runId,
    dry_run: dryRun,
    what_if_mode: whatIfMode,
    allocation_strategy: allocationStrategy,
    pilot_max_tasks: pilotMaxTasks,
    assignment_mode: assignmentMode || (effectiveAuto ? 'AUTO' : 'UNASSIGNED'),
    assignment: assignmentApplied,
    assignment_summary: assignmentSummary,
    started_at: startedAt,
    finished_at: finishedAt,
    effective_default_eligibility_mode: effectiveMode,
    config,
    active_before: activeCount,
    target: Number(config.active_queue_target) || 300,
    slots_available: planning.slotsAvailable,
    candidates_evaluated: planning.filtered.raw,
    filtered: planning.filtered,
    channel_tasks_planned: planning.plan.length,
    channel_tasks_created: created,
    inserted_ids: insertedIds,
    errors: dbErrors,
    reason: planning.reason,
    plan: planning.plan,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  AUTO_CHANNELS,
  LEVEL_RANK,
  planRefill,
  taskRowFromCandidate,
  loadCandidatesFromDb,
  loadActiveChannelRegisterCount,
  loadExistingActiveKeys,
  loadConfigFromDb,
  refillChannelRegistrationQueue,
};
