'use strict';

/**
 * tests/oms/inventoryExceptionsHistoricalReconciliation2c.test.js — Phase 8C-2c.
 *
 * Prod bug: reconstruction was losing the legacy ASSUMED seed for row #423
 * because the production audit uses `notified: {...}` (older orchestrator
 * variant) instead of `notification: {...}` (post-8C-1 orchestrator). Helper
 * only checked `snap.notification`, so #423 was silently ignored, and the
 * effective state became [] instead of [imessage, telegram] before applying
 * #424 → after #424 the result was [] instead of [imessage].
 *
 * Fix: helper recognizes both key variants and broader positive shapes.
 *
 * Owner rules covered:
 *   Rule 2. legacy positive row MUST seed ASSUMED for every configured channel
 *   Rule 3. legacy channels are ASSUMED, never CONFIRMED
 *   Rule 4. attempted=false preserves prior per-channel state verbatim
 *   Rule 5. attempted=true & sent=false removes from confirmed/assumed
 *   Rule 6. attempted=true & sent=true removes unresolved/assumed, adds confirmed
 *   Rule 7. state transitions are strictly per-channel
 *   Rule 8. no historical row mutation
 *   Rule 9. no production send
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runInventoryExceptionsDaily } = require('../../src/jobs/inventoryExceptionsDailyJob');
const { deriveEffectiveDeliveryStateFromRuns, computeDeliveryPlan, _internals } = require('../../src/services/oms/inventoryExceptionsAlerter');

const DECISION = { SELL_NORMALLY: 'SELL_NORMALLY', WATCH: 'WATCH', REPLENISH: 'REPLENISH', PROTECT_STOCK: 'PROTECT_STOCK' };

function makeQueueResult({ action = [] } = {}) {
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
      physical_products_assessed: action.length, sell_normally_count: 0,
      watch_count: 0, replenish_count: 0, protect_stock_count: 0,
      insufficient_data_count: 0, action_exception_count: action.length, data_quality_count: 0,
      assessment_errors_count: 0, runtime_ms: 5, avg_ms_per_physical: 2, concurrency: 4,
      db_cache_hits: 0, db_cache_misses: 0, db_cache_per_table: {},
    },
    action_queue: actionRows, action_queue_total: actionRows.length, action_queue_limit_applied: null,
    data_quality_queue: [], assessment_errors: [],
  };
}
const fpOf = a => _internals._fingerprint(a);

// ─── Production-exact fixtures (Owner-specified shapes) ─

// #423 uses `notified` key, not `notification`
function row423Production(fp) {
  return {
    id: 423, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: {
      fingerprint: fp,
      notified: { ok: true, result: { sent: true } },
    },
  };
}
// #424 uses `notification.channels` shape (post-8C-1)
function row424Production(fp) {
  return {
    id: 424, status: 'failed', completed_at: '2026-08-15T00:00:00Z',
    output_snapshot: {
      fingerprint: fp,
      queue_success: true,
      notification: {
        channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
        },
      },
      // Buggy pre-hotfix derived fields — must NOT be trusted by reconstruction
      effective_satisfied_channels: ['imessage', 'telegram'],
      effective_unresolved_channels: [],
      all_required_channels_satisfied: true,
    },
  };
}

// ─── Owner-required tests ───────────────────────────────

test('2c-A. #423 alone (notified key) → assumed=[imessage,telegram], confirmed=[]', () => {
  const d = deriveEffectiveDeliveryStateFromRuns([row423Production('fp1')], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, [], 'never CONFIRMED for legacy row');
  assert.deepEqual([...d.assumed_satisfied_channels].sort(), ['imessage', 'telegram']);
  assert.deepEqual(d.effective_unresolved_channels, []);
  assert.equal(d.all_required_channels_satisfied, true);
});

test('2c-B. #423 + #424 production shapes → assumed=[imessage], unresolved=[telegram]', () => {
  const fp = 'fp_prod';
  const d = deriveEffectiveDeliveryStateFromRuns([row423Production(fp), row424Production(fp)], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, []);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage'], 'imessage assumed carried across #424 (attempted=false)');
  assert.deepEqual(d.effective_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_unresolved_channels, ['telegram']);
  assert.equal(d.all_required_channels_satisfied, false);
});

test('2c-C. attempted=false preserves prior CONFIRMED', () => {
  const fp = 'fpc';
  const r1 = { id: 1, status: 'succeeded', completed_at: '2026-08-13T00:00:00Z',
    output_snapshot: { fingerprint: fp,
      notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: true } } } } };
  const r2 = { id: 2, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z',
    output_snapshot: { fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
      } } } };
  const d = deriveEffectiveDeliveryStateFromRuns([r1, r2], ['imessage', 'telegram']);
  assert.deepEqual([...d.confirmed_satisfied_channels].sort(), ['imessage', 'telegram']);
});

test('2c-D. attempted=false preserves prior ASSUMED', () => {
  const fp = 'fpd';
  const d = deriveEffectiveDeliveryStateFromRuns([
    row423Production(fp),
    { id: 2, status: 'succeeded', completed_at: '2026-08-15T00:00:00Z',
      output_snapshot: { fingerprint: fp,
        notification: { channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        } } } },
  ], ['imessage', 'telegram']);
  assert.deepEqual([...d.assumed_satisfied_channels].sort(), ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, []);
});

test('2c-E. actual failure overrides ASSUMED (telegram → unresolved)', () => {
  const fp = 'fpe';
  const d = deriveEffectiveDeliveryStateFromRuns([
    row423Production(fp),  // seeds assumed=[imessage, telegram]
    { id: 2, status: 'failed', completed_at: '2026-08-15T00:00:00Z',
      output_snapshot: { fingerprint: fp,
        notification: { channels: {
          telegram: { attempted: true, sent: false, error: 'bot_api_403' },
        } } } },
  ], ['imessage', 'telegram']);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_unresolved_channels, ['telegram']);
});

test('2c-F. actual success converts ASSUMED → CONFIRMED', () => {
  const fp = 'fpf';
  const d = deriveEffectiveDeliveryStateFromRuns([
    row423Production(fp),
    { id: 2, status: 'succeeded', completed_at: '2026-08-15T00:00:00Z',
      output_snapshot: { fingerprint: fp,
        notification: { channels: {
          telegram: { attempted: true, sent: true },
        } } } },
  ], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, ['telegram']);
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(d.effective_unresolved_channels, []);
});

test('2c-G. state transitions are strictly per-channel (imessage assumed untouched while telegram flips)', () => {
  const fp = 'fpg';
  const d = deriveEffectiveDeliveryStateFromRuns([
    row423Production(fp),
    // telegram fails
    { id: 2, status: 'failed', completed_at: '2026-08-15T00:00:00Z',
      output_snapshot: { fingerprint: fp,
        notification: { channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: false, error: 'x' },
        } } } },
    // telegram retry succeeds
    { id: 3, status: 'succeeded', completed_at: '2026-08-16T00:00:00Z',
      output_snapshot: { fingerprint: fp,
        notification: { channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: true },
        } } } },
  ], ['imessage', 'telegram']);
  assert.deepEqual(d.confirmed_satisfied_channels, ['telegram'], 'telegram confirmed by run 3');
  assert.deepEqual(d.assumed_satisfied_channels, ['imessage'], 'imessage assumed preserved end-to-end');
});

test('2c-H. computeDeliveryPlan(prod #423+#424) → retry_kind=channel_retry, deliver=[telegram]', () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const plan = computeDeliveryPlan({
    currentFingerprint: currentFp,
    priorState: {
      fingerprint: currentFp,
      recent_runs_same_fingerprint: [row423Production(currentFp), row424Production(currentFp)],
    },
    configuredChannels: ['imessage', 'telegram'],
    shouldAlert: false,
  });
  assert.equal(plan.retry_kind, 'channel_retry');
  assert.deepEqual(plan.confirmed_satisfied_channels_prior, []);
  assert.deepEqual(plan.assumed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(plan.unresolved_channels, ['telegram']);
  assert.deepEqual(plan.should_deliver_to, ['telegram']);
});

test('2c-I. iMessage never enters should_deliver_to for #423+#424 scenario', () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const plan = computeDeliveryPlan({
    currentFingerprint: currentFp,
    priorState: {
      fingerprint: currentFp,
      recent_runs_same_fingerprint: [row423Production(currentFp), row424Production(currentFp)],
    },
    configuredChannels: ['imessage', 'telegram'],
    shouldAlert: false,
  });
  assert.equal(plan.should_deliver_to.includes('imessage'), false, 'iMessage MUST NOT be re-fired');
});

// ─── Orchestrator end-to-end: DB → orchestrator → correct plan ──

test('2c-J. E2E dry-run with production DB shape → matches Owner reconciliation exactly', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const currentFp = fpOf(_internals._extractActionSummary(q.action_queue));
  const rows = [
    { id: 424, status: 'failed', completed_at: '2026-08-15T00:00:00Z', output_snapshot: row424Production(currentFp).output_snapshot },
    { id: 423, status: 'succeeded', completed_at: '2026-08-14T00:00:00Z', output_snapshot: row423Production(currentFp).output_snapshot },
  ];
  const fakeClient = { from() { return {
    select() { return this; }, eq() { return this; }, order() { return this; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  }; } };
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: false,   // DRY-RUN (Owner mandate)
    client: fakeClient,
    queueFn: async () => q,
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async () => { throw new Error('audit not expected in dry-run'); },
  });
  assert.equal(notifyCalls.length, 0);
  assert.equal(r.delivery_plan.retry_kind, 'channel_retry');
  assert.deepEqual(r.delivery_plan.confirmed_satisfied_channels_prior, []);
  assert.deepEqual(r.delivery_plan.assumed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(r.delivery_plan.unresolved_channels, ['telegram']);
  assert.deepEqual(r.delivery_plan.should_deliver_to, ['telegram']);
  // Final derived state persisted (if committed) — matches Owner reconciliation
  assert.deepEqual(r.confirmed_satisfied_channels, []);
  assert.deepEqual(r.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual(r.effective_satisfied_channels, ['imessage']);
  assert.deepEqual(r.effective_unresolved_channels, ['telegram']);
  assert.equal(r.all_required_channels_satisfied, false);
});

// ─── K. BP unchanged ───────────────────────────────────

test('2c-K. Battle Partners WATCH · priority 170 preserved verbatim', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'Battle Partners Booster Box' }] });
  const before = JSON.parse(JSON.stringify(q));
  const r = await runInventoryExceptionsDaily({ queueFn: async () => q, fetchPriorFn: async () => null });
  assert.deepEqual(r.queue_result, before);
  assert.equal(r.queue_result.action_queue[0].decision_status, 'WATCH');
  assert.equal(r.queue_result.action_queue[0].priority_score, 170);
});

// ─── L. zero operational writes on reconstruction path ─

test('2c-L. no inventory/marketplace/purchase/hold writes on reconstruction path', async () => {
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
      recent_runs_same_fingerprint: [row423Production(currentFp), row424Production(currentFp)],
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
