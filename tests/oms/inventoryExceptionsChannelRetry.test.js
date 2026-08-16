'use strict';

/**
 * tests/oms/inventoryExceptionsChannelRetry.test.js — Phase 8C-2.
 *
 * Channel-aware notification retry / dedup:
 *   · dedup by fingerprint remains the primary suppression
 *   · but a channel that failed on the same fingerprint is retried without
 *     re-firing successful channels (no iMessage duplicate)
 *   · Owner-explicit `--force-channel` overrides dedup for that channel only
 *   · legacy pre-8C-1 prior rows (no channel breakdown) default to "all
 *     satisfied" so an actually-successful iMessage does not duplicate
 *
 * Business logic (queue building, decision engine) is NOT recomputed.
 * READ-ONLY on inventory / reservations / marketplace / mappings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runInventoryExceptionsDaily } = require('../../src/jobs/inventoryExceptionsDailyJob');
const { computeDeliveryPlan, computeAlertPlan, _internals } = require('../../src/services/oms/inventoryExceptionsAlerter');

const DECISION = { SELL_NORMALLY: 'SELL_NORMALLY', WATCH: 'WATCH', REPLENISH: 'REPLENISH', PROTECT_STOCK: 'PROTECT_STOCK', INSUFFICIENT_DATA: 'INSUFFICIENT_DATA' };

function makeQueueResult({ action = [], dq = [], sellCount = 0, assessed = null } = {}) {
  const actionRows = action.map((a, i) => ({
    rank: i + 1, physical_product_id: a.id, title: a.title || `phys#${a.id}`,
    decision_status: a.status, confidence_level: 'low',
    priority_score: a.score ?? 100, priority_reasons: [],
    available_units: 45, raw_days_of_supply: 22, demand_pattern: 'stable',
    replacement_difficulty: 'UNKNOWN', evidenced_replacement_depth: 0, depth_gap: 0,
    reason_codes: [], recommended_human_action: 'act',
  }));
  const dqRows = dq.map(x => ({ physical_product_id: x.id, title: x.title || `phys#${x.id}`, missing_evidence: [], reason_codes: [], classification: x.classification || 'insufficient_data' }));
  return {
    generated_at: new Date().toISOString(),
    summary: {
      physical_products_assessed: assessed ?? action.length + dq.length + sellCount,
      sell_normally_count: sellCount,
      watch_count: action.filter(a => a.status === DECISION.WATCH).length,
      replenish_count: action.filter(a => a.status === DECISION.REPLENISH).length,
      protect_stock_count: action.filter(a => a.status === DECISION.PROTECT_STOCK).length,
      insufficient_data_count: dq.length,
      action_exception_count: action.length,
      data_quality_count: dq.length,
      assessment_errors_count: 0,
      runtime_ms: 5, avg_ms_per_physical: 2, concurrency: 4,
      db_cache_hits: 3, db_cache_misses: 2, db_cache_per_table: {},
    },
    action_queue: actionRows,
    action_queue_total: actionRows.length,
    action_queue_limit_applied: null,
    data_quality_queue: dqRows,
    assessment_errors: [],
  };
}

function fingerprintFor(actionSummary) {
  return _internals._fingerprint(actionSummary);
}

// ─── computeDeliveryPlan (pure) ──────────────────────────

test('R-DP1. no prior → satisfied=[], deliver to all configured (via alert path)', () => {
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: null, configuredChannels: ['imessage','telegram'], shouldAlert: true });
  assert.equal(p.fingerprint_unchanged, false);
  assert.deepEqual(p.satisfied_channels_prior, []);
  assert.deepEqual(p.unresolved_channels, ['imessage','telegram']);
  assert.equal(p.retry_kind, 'first_run');
  assert.deepEqual(p.should_deliver_to, ['imessage','telegram']);
});

test('R-DP2. prior with channels[telegram.sent=false] + same fp + no alert → retry telegram only', () => {
  const prior = {
    fingerprint: 'fp1',
    notification: { channels: {
      imessage: { attempted: true, sent: true, error: null, description: null },
      telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'parse error' },
    }},
  };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: prior, configuredChannels: ['imessage','telegram'], shouldAlert: false });
  assert.equal(p.fingerprint_unchanged, true);
  assert.deepEqual(p.satisfied_channels_prior, ['imessage']);
  assert.deepEqual(p.unresolved_channels, ['telegram']);
  assert.equal(p.retry_kind, 'channel_retry');
  assert.deepEqual(p.should_deliver_to, ['telegram']);
});

test('R-DP3. prior with all channels sent + same fp + no alert → satisfied, deliver none', () => {
  const prior = {
    fingerprint: 'fp1',
    notification: { channels: {
      imessage: { attempted: true, sent: true, error: null, description: null },
      telegram: { attempted: true, sent: true, error: null, description: null },
    }},
  };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: prior, configuredChannels: ['imessage','telegram'], shouldAlert: false });
  assert.equal(p.retry_kind, 'satisfied');
  assert.deepEqual(p.should_deliver_to, []);
});

test('R-DP4. legacy prior (no notification metadata) + same fp → assume all satisfied', () => {
  const prior = { fingerprint: 'fp1' };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: prior, configuredChannels: ['imessage','telegram'], shouldAlert: false });
  assert.deepEqual(p.satisfied_channels_prior, ['imessage','telegram']);
  assert.equal(p.retry_kind, 'satisfied');
  assert.deepEqual(p.should_deliver_to, []);
  assert.equal(p.legacy_prior_note, 'legacy_prior_assumed_all_satisfied_no_notification_metadata');
});

test('R-DP5. fingerprint changed → prior satisfied ignored, retry_kind=business_change', () => {
  const prior = {
    fingerprint: 'fp_old',
    notification: { channels: { imessage: { attempted: true, sent: true } } },
  };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp_new', priorState: prior, configuredChannels: ['imessage','telegram'], shouldAlert: true });
  assert.equal(p.fingerprint_unchanged, false);
  assert.deepEqual(p.satisfied_channels_prior, []);
  assert.equal(p.retry_kind, 'business_change');
  assert.deepEqual(p.should_deliver_to, ['imessage','telegram']);
});

test('R-DP6. force_channels overrides dedup, restricts delivery to listed channels only', () => {
  const prior = {
    fingerprint: 'fp1',
    notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: true } } },
  };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: prior, configuredChannels: ['imessage','telegram'], forceChannels: ['telegram'], shouldAlert: false });
  assert.equal(p.retry_kind, 'force');
  assert.deepEqual(p.should_deliver_to, ['telegram']);
  assert.deepEqual(p.force_channels_requested, ['telegram']);
});

test('R-DP7. force_channels rejects unknown channels silently (only configured ones honoured)', () => {
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: null, configuredChannels: ['imessage','telegram'], forceChannels: ['bogus_channel'], shouldAlert: false });
  assert.deepEqual(p.force_channels_requested, []);
});

// ─── Orchestrator scenarios (14 required scenarios) ─────

/**
 * O1. Owner requirement: prior=(imessage.sent=true, telegram.sent=false), same fingerprint.
 *     MUST NOT resend iMessage. MUST retry Telegram only.
 */
test('O1. same fp + prior partial fail → Telegram retried, iMessage NOT re-fired', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'parse error' },
      }},
      action_summary: _internals._extractActionSummary(q.action_queue),
      data_quality_ids: [],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (payload) => {
      notifyCalls.push(payload);
      // Simulate Telegram now succeeds. onlyChannels=['telegram']
      const attemptTg = !payload.onlyChannels || payload.onlyChannels.includes('telegram');
      const attemptIm = !payload.onlyChannels || payload.onlyChannels.includes('imessage');
      return {
        attempted: attemptTg || attemptIm,
        channels: {
          imessage: attemptIm
            ? { attempted: true, sent: true, error: null, description: null }
            : { attempted: false, sent: false, error: 'skipped_by_only_channels_filter', description: null },
          telegram: attemptTg
            ? { attempted: true, sent: true, error: null, description: null }
            : { attempted: false, sent: false, error: 'skipped_by_only_channels_filter', description: null },
        },
        configured_channels: ['imessage', 'telegram'],
        all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
        only_channels_filter: payload.onlyChannels || null,
      };
    },
    insertAuditFn: async (_c, row) => ({ id: 4231, status: row.status }),
  });
  assert.equal(notifyCalls.length, 1, 'notify called exactly once (for the retry)');
  assert.deepEqual(notifyCalls[0].onlyChannels, ['telegram'], 'only Telegram must be attempted');
  assert.equal(r.delivery_plan.retry_kind, 'channel_retry');
  assert.deepEqual(r.notification.channels.imessage.attempted, false);
  assert.deepEqual(r.notification.channels.telegram.attempted, true);
  assert.deepEqual(r.notification.channels.telegram.sent, true);
  // After retry success, effective_satisfied includes BOTH channels
  assert.deepEqual([...r.effective_satisfied_channels].sort(), ['imessage','telegram']);
  assert.equal(r.all_required_channels_satisfied, true);
  assert.equal(r.run_status, 'succeeded');
});

/**
 * O2. Same fingerprint + all prior channels succeeded → send NOTHING.
 */
test('O2. same fp + all prior channels satisfied → notify NOT called', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: true, error: null, description: null },
      }},
      action_summary: _internals._extractActionSummary(q.action_queue),
      data_quality_ids: [],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => ({ id: 4232, status: row.status }),
  });
  assert.equal(notifyCalls.length, 0);
  assert.equal(r.notification.skipped, true);
  assert.equal(r.notification.reason, 'all_channels_already_satisfied');
  assert.equal(r.run_status, 'succeeded');
});

/**
 * O3. Same fp + retry SUCCEEDS on Telegram → audit succeeded AND
 *     iMessage.attempted=false (not double-delivered).
 */
test('O3. retry-success run: audit records iMessage skipped, Telegram sent', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const auditCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'parse error' },
      }},
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (payload) => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter', description: null },
        telegram: { attempted: true, sent: true, error: null, description: null },
      },
      configured_channels: ['imessage','telegram'],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
      only_channels_filter: payload.onlyChannels,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 4233, status: row.status }; },
  });
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].status, 'succeeded');
  const snap = auditCalls[0].output_snapshot;
  assert.deepEqual([...snap.effective_satisfied_channels].sort(), ['imessage','telegram']);
  assert.deepEqual(snap.effective_unresolved_channels, []);
  assert.equal(snap.all_required_channels_satisfied, true);
  assert.equal(snap.notification.channels.imessage.attempted, false);
  assert.equal(snap.notification.channels.telegram.sent, true);
});

/**
 * O4. Following run with same fp — after retry success — sends NOTHING.
 */
test('O4. subsequent same-fp run after retry success → no send', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    // Prior row from previous retry-success run (has effective_satisfied_channels)
    fetchPriorFn: async () => ({
      fingerprint: fp,
      effective_satisfied_channels: ['imessage', 'telegram'],
      notification: { channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: true, error: null },
      }},
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => ({ id: 4234, status: row.status }),
  });
  assert.equal(notifyCalls.length, 0);
});

/**
 * O5. Retry FAILS again → iMessage still not resent, audit fails, unresolved persists.
 */
test('O5. retry failure: iMessage still not resent, telegram remains unresolved', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: true, sent: true, error: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'parse error' },
      }},
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: false, error: 'bot_api_500', description: 'server error' },
      },
      configured_channels: ['imessage','telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 4235, status: row.status }; },
  });
  assert.equal(r.notification.channels.imessage.attempted, false);
  assert.equal(r.notification.channels.telegram.sent, false);
  assert.equal(auditCalls[0].status, 'failed');
  assert.equal(auditCalls[0].error_code, 'notification_total_failure');
  const snap = auditCalls[0].output_snapshot;
  assert.deepEqual(snap.effective_satisfied_channels, ['imessage']);
  assert.deepEqual(snap.effective_unresolved_channels, ['telegram']);
  assert.equal(snap.all_required_channels_satisfied, false);
});

/**
 * O6. New fingerprint → normal alert to ALL configured channels (no retry semantics).
 */
test('O6. new fingerprint → deliver to all configured channels (business_change)', async () => {
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 2, status: DECISION.REPLENISH, score: 220 }] }),
    fetchPriorFn: async () => ({
      fingerprint: 'old_fp',
      notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: true } } },
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => {
      notifyCalls.push(p);
      return {
        attempted: true,
        channels: {
          imessage: { attempted: true, sent: true, error: null },
          telegram: { attempted: true, sent: true, error: null },
        },
        configured_channels: ['imessage','telegram'],
        all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
      };
    },
    insertAuditFn: async (_c, row) => ({ id: 4236, status: row.status }),
  });
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].onlyChannels, null, 'business_change must not filter channels');
  assert.equal(r.delivery_plan.retry_kind, 'business_change');
});

/**
 * O7. Escalation → normal alert to ALL configured (like O6).
 */
test('O7. escalation (WATCH→REPLENISH) → deliver to all configured channels', async () => {
  const prior_action_summary = [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170, title: 'BP' }];
  const prior_fp = fingerprintFor(prior_action_summary);
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.REPLENISH, score: 220 }] }),
    fetchPriorFn: async () => ({
      fingerprint: prior_fp, action_summary: prior_action_summary, data_quality_ids: [],
      notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: true } } },
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => {
      notifyCalls.push(p);
      return { attempted: true, channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: true } }, configured_channels: ['imessage','telegram'], all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false };
    },
    insertAuditFn: async (_c, row) => ({ id: 4237, status: row.status }),
  });
  assert.equal(r.alert_plan.alert_kind, 'escalation');
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].onlyChannels, null);
});

/**
 * O8. Dry-run performs ZERO sends (unchanged from 8C-1).
 */
test('O8. dry-run → notify never called', async () => {
  const notifyCalls = [];
  await runInventoryExceptionsDaily({
    commit: false,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
  });
  assert.equal(notifyCalls.length, 0);
});

/**
 * O9. Channel not configured is not treated as unresolved required delivery.
 *     Example: only iMessage configured, prior sent iMessage → satisfied, no retry.
 */
test('O9. single-channel configuration → prior iMessage.sent=true → satisfied', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: { imessage: { attempted: true, sent: true, error: null } } },
    }),
    configuredChannelsFn: async () => ['imessage'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => ({ id: 4239, status: row.status }),
  });
  assert.equal(notifyCalls.length, 0);
  assert.equal(r.delivery_plan.retry_kind, 'satisfied');
  assert.equal(r.run_status, 'succeeded');
});

/**
 * O10. --force-channel telegram overrides dedup for that channel only.
 */
test('O10. forceChannels=[telegram] → Telegram delivered even if satisfied', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: true } } },
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => {
      notifyCalls.push(p);
      return {
        attempted: true,
        channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: true, error: null },
        },
        configured_channels: ['imessage','telegram'],
        all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
      };
    },
    insertAuditFn: async (_c, row) => ({ id: 42310, status: row.status }),
  });
  assert.equal(notifyCalls.length, 1);
  assert.deepEqual(notifyCalls[0].onlyChannels, ['telegram']);
});

/**
 * O11. Audit output_snapshot preserves per-channel delivery state so future runs
 *      can derive prior state.
 */
test('O11. audit snapshot includes delivery_plan + effective_satisfied_channels', async () => {
  const auditCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: true, error: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'x' },
      },
      configured_channels: ['imessage','telegram'],
      all_succeeded: false, any_succeeded: true, partial_failure: true, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 42311, status: row.status }; },
  });
  const snap = auditCalls[0].output_snapshot;
  assert.equal(typeof snap.delivery_plan, 'object');
  assert.deepEqual(snap.effective_satisfied_channels, ['imessage']);
  assert.deepEqual(snap.effective_unresolved_channels, ['telegram']);
  assert.equal(snap.all_required_channels_satisfied, false);
});

/**
 * O12. BP (Battle Partners) remains WATCH · priority 170 through orchestration
 *      (business logic untouched).
 */
test('O12. BP WATCH · priority 170 preserved verbatim through orchestrator', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'Battle Partners Booster Box' }] });
  const cloneBefore = JSON.parse(JSON.stringify(q));
  const r = await runInventoryExceptionsDaily({
    queueFn: async () => q,
    fetchPriorFn: async () => null,
  });
  assert.deepEqual(r.queue_result, cloneBefore);
  assert.equal(r.queue_result.action_queue[0].decision_status, 'WATCH');
  assert.equal(r.queue_result.action_queue[0].priority_score, 170);
  assert.match(r.alert_plan.digest_text, /Battle Partners/);
});

/**
 * O13. Zero inventory / marketplace / purchase / hold writes on any path.
 */
test('O13. only automation_runs inserted — no inventory/marketplace/purchase/hold writes', async () => {
  const dbCalls = [];
  const fakeClient = { from(table) { dbCalls.push(['from', table]); return {
    insert: () => { dbCalls.push(['insert', table]); return { select: () => ({ single: async () => ({ data: { id: 1, status: 'succeeded' }, error: null }) }) }; },
    update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    delete: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
  }; } };
  await runInventoryExceptionsDaily({
    commit: true, client: fakeClient,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({ attempted: true, channels: {}, configured_channels: [], all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }),
    insertAuditFn: async (c, row) => { const res = await c.from('automation_runs').insert(row).select('id, status').single(); return res.data; },
  });
  const bad = dbCalls.filter(c => (c[0] === 'insert' || c[0] === 'update' || c[0] === 'delete') && c[1] !== 'automation_runs');
  assert.equal(bad.length, 0);
});

/**
 * O14. _defaultFetchPrior accepts a status='failed' row when queue_success=true
 *      (post-8C-1 partial failure). Specifically: #423-style row.
 */
test('O14. _defaultFetchPrior picks status=failed row when queue_success=true (post-8C-1 partial)', async () => {
  const rows = [
    { id: 424, status: 'failed', completed_at: '2026-08-15T09:00:00Z', output_snapshot: null }, // pure queue failure → skipped
    { id: 423, status: 'failed', completed_at: '2026-08-14T09:00:00Z', output_snapshot: { fingerprint: 'fp_xxx', queue_success: true, notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: false, error: 'bot_api_400' } } } } },
    { id: 422, status: 'succeeded', completed_at: '2026-08-13T09:00:00Z', output_snapshot: { fingerprint: 'fp_old', queue_success: true } },
  ];
  const fakeClient = { from() { return {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    limit() { return Promise.resolve({ data: rows, error: null }); },
  }; } };
  const { _defaults } = require('../../src/jobs/inventoryExceptionsDailyJob');
  const prior = await _defaults._defaultFetchPrior(fakeClient);
  assert.equal(prior.id, 423, 'must pick the queue-succeeded/notification-failed row');
  assert.equal(prior.fingerprint, 'fp_xxx');
  assert.equal(prior.notification.channels.telegram.sent, false);
});

// ─── Bonus: legacy #423 (pre-8C-1) safe default ─────────

test('L1. legacy pre-8C-1 prior (status=succeeded, no channel breakdown) → all satisfied by default', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fingerprintFor(_internals._extractActionSummary(q.action_queue));
  const notifyCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    // Legacy pre-8C-1 row has no notification.channels
    fetchPriorFn: async () => ({ fingerprint: fp, action_summary: _internals._extractActionSummary(q.action_queue), data_quality_ids: [] }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (p) => { notifyCalls.push(p); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => ({ id: 999, status: row.status }),
  });
  assert.equal(notifyCalls.length, 0, 'legacy prior must not trigger silent re-fire');
  assert.match(r.delivery_plan.legacy_prior_note || '', /assumed_all_satisfied/);
});
