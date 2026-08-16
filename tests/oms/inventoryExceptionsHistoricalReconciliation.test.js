'use strict';

/**
 * tests/oms/inventoryExceptionsHistoricalReconciliation.test.js — Phase 8C-2b.
 *
 * Owner requirement: reconcile delivery state from audit HISTORY, not from a
 * single row's derived fields. Production evidence — automation_run #424
 * carries buggy pre-hotfix1 derived fields (effective_satisfied_channels=
 * [imessage, telegram], all_required=true) despite notification.channels
 * clearly showing telegram FAILED. Trusting that one row → repeat of the bug.
 *
 * Fix approach: walk N recent same-fingerprint rows chronologically, apply
 * per-channel authority rules (actual attempt result overrides prior state).
 * Read-time only — historical rows are NEVER mutated.
 *
 * Also validated:
 *   · legacy effective_satisfied_channels alone is treated as ASSUMED
 *   · delivery_state_version=2 is set on new writes so future rows are trusted
 *   · BP WATCH · 170 remains untouched
 *   · zero operational writes
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runInventoryExceptionsDaily } = require('../../src/jobs/inventoryExceptionsDailyJob');
const { deriveEffectiveDeliveryStateFromRuns, computeDeliveryPlan, _internals } = require('../../src/services/oms/inventoryExceptionsAlerter');

const DECISION = { SELL_NORMALLY: 'SELL_NORMALLY', WATCH: 'WATCH', REPLENISH: 'REPLENISH', PROTECT_STOCK: 'PROTECT_STOCK' };

function makeQueueResult({ action = [], sellCount = 0 } = {}) {
  const actionRows = action.map((a, i) => ({
    rank: i + 1, physical_product_id: a.id, title: a.title || `phys#${a.id}`,
    decision_status: a.status, confidence_level: 'low',
    priority_score: a.score ?? 100, priority_reasons: [],
    available_units: 45, raw_days_of_supply: 22, demand_pattern: 'stable',
    replacement_difficulty: 'UNKNOWN', evidenced_replacement_depth: 0, depth_gap: 0,
    reason_codes: [], recommended_human_action: 'act',
  }));
  return {
    generated_at: new Date().toISOString(),
    summary: {
      physical_products_assessed: action.length + sellCount,
      sell_normally_count: sellCount, watch_count: 0, replenish_count: 0, protect_stock_count: 0,
      insufficient_data_count: 0, action_exception_count: action.length, data_quality_count: 0,
      assessment_errors_count: 0, runtime_ms: 5, avg_ms_per_physical: 2, concurrency: 4,
      db_cache_hits: 0, db_cache_misses: 0, db_cache_per_table: {},
    },
    action_queue: actionRows, action_queue_total: actionRows.length, action_queue_limit_applied: null,
    data_quality_queue: [], assessment_errors: [],
  };
}
const fpOf = a => _internals._fingerprint(a);

// Production-shaped fixture builders (exact row shapes from prod)
function row423(fp) {
  return {
    id: 423, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: {
      // Legacy row: no channel breakdown, only a coarse positive indicator
      fingerprint: fp,
      notification: { result: { sent: true } },
    },
  };
}
function row424Buggy(fp) {
  // Pre-hotfix1 buggy derivation: effective_satisfied wrongly includes telegram
  return {
    id: 424, status: 'failed', completed_at: '2026-08-15T00:00:00Z',
    output_snapshot: {
      fingerprint: fp,
      queue_success: true,
      notification: {
        channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter', description: null },
          telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
        },
      },
      effective_satisfied_channels: ['imessage', 'telegram'],   // ← BUGGY derived field
      effective_unresolved_channels: [],                          // ← BUGGY
      all_required_channels_satisfied: true,                      // ← BUGGY
    },
  };
}

// ─── Pure helper: derive from history ───────────────────

test('A. legacy #423-shaped row alone → assumed=[imessage,telegram], confirmed=[]', () => {
  const d = deriveEffectiveDeliveryStateFromRuns([row423('fp1')], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, []);
  assert.deepEqual([...d.assumed_satisfied_channels].sort(), ['imessage', 'telegram']);
  assert.deepEqual(d.effective_unresolved_channels, []);
});

test('B. #423 + #424 → correctly overrides telegram to unresolved', () => {
  const fp = 'fp_prod';
  const d = deriveEffectiveDeliveryStateFromRuns([row423(fp), row424Buggy(fp)], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, []);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_unresolved_channels, ['telegram']);
  assert.equal(d.all_required_channels_satisfied, false);
});

test('B-order. helper sorts oldest→newest regardless of input order', () => {
  const fp = 'fp_prod';
  const d = deriveEffectiveDeliveryStateFromRuns([row424Buggy(fp), row423(fp)], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, []);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_unresolved_channels, ['telegram']);
});

test('G. actual failure overrides historical legacy effective_satisfied', () => {
  const fp = 'fp2';
  // Row 1: legacy-shape with effective_satisfied=[imessage, telegram]
  const r1 = { id: 1, status: 'succeeded', completed_at: '2026-08-13T00:00:00Z',
    output_snapshot: { fingerprint: fp, effective_satisfied_channels: ['imessage', 'telegram'], notification: { result: { sent: true } } } };
  // Row 2: telegram attempted and failed
  const r2 = { id: 2, status: 'failed', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: { fingerprint: fp, queue_success: true,
      notification: { channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
      } } } };
  const d = deriveEffectiveDeliveryStateFromRuns([r1, r2], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, []);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_unresolved_channels, ['telegram']);
});

test('H. actual success overrides historical unresolved', () => {
  const fp = 'fp3';
  const r1 = { id: 1, status: 'failed', completed_at: '2026-08-13T00:00:00Z',
    output_snapshot: { fingerprint: fp, queue_success: true,
      notification: { channels: {
        imessage: { attempted: true, sent: true },
        telegram: { attempted: true, sent: false, error: 'bot_api_500' },
      } } } };
  const r2 = { id: 2, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: { fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: true },
      } } } };
  const d = deriveEffectiveDeliveryStateFromRuns([r1, r2], ['imessage', 'telegram']);
  assert.deepEqual([...d.confirmed_satisfied_channels].sort(), ['imessage', 'telegram']);
  assert.deepEqual(d.effective_unresolved_channels, []);
});

test('I. skipped channel preserves prior', () => {
  const fp = 'fp4';
  const r1 = { id: 1, status: 'succeeded', completed_at: '2026-08-13T00:00:00Z',
    output_snapshot: { fingerprint: fp,
      notification: { channels: { imessage: { attempted: true, sent: true } } } } };
  const r2 = { id: 2, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: { fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: true },
      } } } };
  const d = deriveEffectiveDeliveryStateFromRuns([r1, r2], ['imessage', 'telegram']);
  assert.deepEqual([...d.confirmed_satisfied_channels].sort(), ['imessage', 'telegram']);
});

test('J. v2 row with explicit split is trusted directly (no chan attempts)', () => {
  const fp = 'fp5';
  const r1 = { id: 1, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: {
      delivery_state_version: 2,
      fingerprint: fp,
      confirmed_satisfied_channels: ['telegram'],
      assumed_satisfied_channels: ['imessage'],
      effective_unresolved_channels: [],
      notification: { attempted: false, channels: {}, skipped: true, reason: 'all_channels_already_satisfied' },
    } };
  const d = deriveEffectiveDeliveryStateFromRuns([r1], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, ['telegram']);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage']);
  assert.equal(d.last_known_delivery_state_version, 2);
});

// ─── computeDeliveryPlan integrating reconstruction ─────

test('C. computeDeliveryPlan with recent_runs=[#423,#424] + same fp → channel_retry telegram', () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const plan = computeDeliveryPlan({
    currentFingerprint: currentFp,
    priorState: {
      fingerprint: currentFp,
      recent_runs_same_fingerprint: [row423(currentFp), row424Buggy(currentFp)],
    },
    configuredChannels: ['imessage', 'telegram'],
    shouldAlert: false,
  });
  assert.equal(plan.fingerprint_unchanged, true);
  assert.deepEqual(plan.confirmed_satisfied_channels_prior, []);
  assert.deepEqual(plan.assumed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(plan.unresolved_channels, ['telegram']);
  assert.equal(plan.retry_kind, 'channel_retry');
  assert.deepEqual(plan.should_deliver_to, ['telegram']);
  assert.match(plan.legacy_prior_note || '', /^reconstructed_from_history_/);
});

// ─── Orchestrator: production #423+#424 sequence ────────

/**
 * D. Same fingerprint after #423+#424 history + DRY-RUN
 *    → notify NEVER called (dry_run); delivery plan MUST show telegram pending
 *    → effective persisted (if we were to commit) confirms iMessage assumed,
 *      Telegram unresolved.
 */
test('D. dry-run reading #423+#424 history → retry_kind=channel_retry, should_deliver_to=[telegram], no send', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: false,   // DRY-RUN
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: currentFp,
      action_summary: _internals._extractActionSummary(q.action_queue),
      data_quality_ids: [],
      notification: row424Buggy(currentFp).output_snapshot.notification,
      recent_runs_same_fingerprint: [row423(currentFp), row424Buggy(currentFp)],
      // Buggy legacy derived fields — these MUST be ignored in favor of history
      effective_satisfied_channels: ['imessage', 'telegram'],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => ({ id: 425, status: row.status }),
  });
  assert.equal(notifyCalls.length, 0, 'dry-run must not send');
  assert.equal(r.delivery_plan.retry_kind, 'channel_retry');
  assert.deepEqual(r.delivery_plan.should_deliver_to, ['telegram']);
  assert.deepEqual(r.delivery_plan.confirmed_satisfied_channels_prior, []);
  assert.deepEqual(r.delivery_plan.assumed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(r.delivery_plan.unresolved_channels, ['telegram']);
  // Effective state at end of dry-run: iMessage assumed carries over, telegram remains unresolved
  assert.deepEqual(r.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(r.effective_unresolved_channels, ['telegram']);
  assert.equal(r.all_required_channels_satisfied, false);
});

/**
 * E. Telegram retry SUCCESS on same fingerprint after #423+#424 history
 *    → confirmed=[telegram], assumed=[imessage], all satisfied.
 */
test('E. commit + telegram retry success reading #423+#424 → confirmed=[telegram], assumed=[imessage]', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: currentFp,
      action_summary: _internals._extractActionSummary(q.action_queue),
      data_quality_ids: [],
      notification: row424Buggy(currentFp).output_snapshot.notification,
      recent_runs_same_fingerprint: [row423(currentFp), row424Buggy(currentFp)],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (payload) => {
      assert.deepEqual(payload.onlyChannels, ['telegram'], 'must retry telegram only');
      return {
        attempted: true,
        channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: true, error: null },
        },
        configured_channels: ['imessage', 'telegram'],
        all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
      };
    },
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 426, status: row.status }; },
  });
  assert.deepEqual(r.confirmed_satisfied_channels, ['telegram']);
  assert.deepEqual(r.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual([...r.effective_satisfied_channels].sort(), ['imessage', 'telegram']);
  assert.deepEqual(r.effective_unresolved_channels, []);
  assert.equal(r.all_required_channels_satisfied, true);
  assert.equal(r.run_status, 'succeeded');
  assert.equal(auditCalls[0].output_snapshot.delivery_state_version, 2);
});

/**
 * F. After successful retry (v2 audit row), following same-fingerprint run
 *    sends neither channel.
 */
test('F. following same-fp run after successful retry (v2 row present) → send neither', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const v2Retry = { id: 426, status: 'succeeded', completed_at: '2026-08-16T00:00:00Z',
    output_snapshot: {
      delivery_state_version: 2,
      fingerprint: currentFp,
      confirmed_satisfied_channels: ['telegram'],
      assumed_satisfied_channels: ['imessage'],
      effective_unresolved_channels: [],
      notification: {
        attempted: true,
        channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: true },
        },
      },
    } };
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: currentFp,
      action_summary: _internals._extractActionSummary(q.action_queue),
      data_quality_ids: [],
      notification: v2Retry.output_snapshot.notification,
      recent_runs_same_fingerprint: [row423(currentFp), row424Buggy(currentFp), v2Retry],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => ({ id: 427, status: row.status }),
  });
  assert.equal(notifyCalls.length, 0, 'no channel needs delivery');
  assert.equal(r.delivery_plan.retry_kind, 'satisfied');
});

// ─── K. BP unchanged ────────────────────────────────────

test('K. BP WATCH · priority 170 preserved verbatim through orchestrator', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'Battle Partners Booster Box' }] });
  const before = JSON.parse(JSON.stringify(q));
  const r = await runInventoryExceptionsDaily({ queueFn: async () => q, fetchPriorFn: async () => null });
  assert.deepEqual(r.queue_result, before);
  assert.equal(r.queue_result.action_queue[0].decision_status, 'WATCH');
  assert.equal(r.queue_result.action_queue[0].priority_score, 170);
});

// ─── L. zero operational writes ─────────────────────────

test('L. zero inventory/marketplace/purchase/hold writes on reconstruction path', async () => {
  const dbCalls = [];
  const fakeClient = { from(table) {
    dbCalls.push(['from', table]);
    return {
      select() { return this; }, eq() { return this; }, order() { return this; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      insert: () => { dbCalls.push(['insert', table]); return { select: () => ({ single: async () => ({ data: { id: 1, status: 'succeeded' }, error: null }) }) }; },
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
      delete: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    };
  } };
  const currentFp = 'fp_l';
  await runInventoryExceptionsDaily({
    commit: true, client: fakeClient,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => ({
      fingerprint: currentFp,
      recent_runs_same_fingerprint: [row423(currentFp), row424Buggy(currentFp)],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
      },
      configured_channels: ['imessage','telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (c, row) => { const res = await c.from('automation_runs').insert(row).select('id, status').single(); return res.data; },
  });
  const bad = dbCalls.filter(c => (c[0] === 'insert' || c[0] === 'update' || c[0] === 'delete') && c[1] !== 'automation_runs');
  assert.equal(bad.length, 0);
});

// ─── _defaultFetchPrior: DB shape reconciliation ────────

test('DB1. _defaultFetchPrior returns recent_runs_same_fingerprint filtered by matching fingerprint', async () => {
  const rows = [
    // Newest first (DESC)
    { id: 424, status: 'failed', completed_at: '2026-08-15T00:00:00Z', output_snapshot: row424Buggy('fp_prod').output_snapshot },
    { id: 423, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z', output_snapshot: row423('fp_prod').output_snapshot },
    // Different fingerprint (should be filtered out of recent_runs_same_fingerprint)
    { id: 422, status: 'succeeded', completed_at: '2026-08-13T00:00:00Z', output_snapshot: { fingerprint: 'other_fp', notification: { result: { sent: true } } } },
  ];
  const fakeClient = { from() { return {
    select() { return this; }, eq() { return this; }, order() { return this; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  }; } };
  const { _defaults } = require('../../src/jobs/inventoryExceptionsDailyJob');
  const prior = await _defaults._defaultFetchPrior(fakeClient);
  assert.equal(prior.fingerprint, 'fp_prod');
  assert.equal(prior.recent_runs_same_fingerprint.length, 2, 'must include both same-fp rows regardless of status');
  const ids = prior.recent_runs_same_fingerprint.map(r => r.id).sort();
  assert.deepEqual(ids, [423, 424]);
});

// ─── Full end-to-end: DB → orchestrator → correct plan ──

test('E2E. real-shaped DB (#423+#424) → dry-run shows correct retry plan (matches Owner reconciliation)', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const rows = [
    { id: 424, status: 'failed', completed_at: '2026-08-15T00:00:00Z', output_snapshot: row424Buggy(currentFp).output_snapshot },
    { id: 423, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z', output_snapshot: row423(currentFp).output_snapshot },
  ];
  const fakeClient = { from() { return {
    select() { return this; }, eq() { return this; }, order() { return this; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  }; } };
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: false,   // DRY-RUN as Owner mandated
    client: fakeClient,
    queueFn: async () => q,
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async () => { throw new Error('audit not expected in dry-run'); },
  });
  assert.equal(notifyCalls.length, 0, 'dry-run must not send anything');
  assert.equal(r.commit, false);
  assert.equal(r.delivery_plan.retry_kind, 'channel_retry');
  assert.deepEqual(r.delivery_plan.should_deliver_to, ['telegram']);
  assert.deepEqual(r.delivery_plan.confirmed_satisfied_channels_prior, []);
  assert.deepEqual(r.delivery_plan.assumed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(r.delivery_plan.unresolved_channels, ['telegram']);
});
