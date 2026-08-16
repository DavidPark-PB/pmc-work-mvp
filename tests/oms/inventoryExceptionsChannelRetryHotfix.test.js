'use strict';

/**
 * tests/oms/inventoryExceptionsChannelRetryHotfix.test.js — Phase 8C-2 hotfix.
 *
 * Fixes the delivery-state accounting bug where a legacy "assumed satisfied"
 * assumption incorrectly survived an actual retry failure.
 *
 * Owner rules (verbatim, priority order):
 *   1. Fresh actual channel result overrides legacy assumption.
 *   2. attempted=true && sent=true   → channel satisfied (confirmed)
 *   3. attempted=true && sent=false  → channel unresolved
 *   4. attempted=false because skipped_by_only_channels_filter
 *                                    → preserve prior state for that channel
 *   5. Legacy assumed satisfaction is lower authority than new actual result.
 *   6. Same rule applies to both telegram and imessage.
 *   7. Audit output_snapshot must preserve prior + current + final.
 *   8. #424-style row must resolve to: iMessage=satisfied, Telegram=unresolved.
 *   9. Do not retry production notifications during implementation. (N/A here)
 *  10. No scheduler/cron activation. (N/A here)
 *  11. No inventory/business-decision changes. (asserted below)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runInventoryExceptionsDaily } = require('../../src/jobs/inventoryExceptionsDailyJob');
const { computeDeliveryPlan, _internals } = require('../../src/services/oms/inventoryExceptionsAlerter');

const DECISION = { SELL_NORMALLY: 'SELL_NORMALLY', WATCH: 'WATCH', REPLENISH: 'REPLENISH', PROTECT_STOCK: 'PROTECT_STOCK' };

function makeQueueResult({ action = [], dq = [], sellCount = 0 } = {}) {
  const actionRows = action.map((a, i) => ({
    rank: i + 1, physical_product_id: a.id, title: a.title || `phys#${a.id}`,
    decision_status: a.status, confidence_level: 'low',
    priority_score: a.score ?? 100, priority_reasons: [],
    available_units: 45, raw_days_of_supply: 22, demand_pattern: 'stable',
    replacement_difficulty: 'UNKNOWN', evidenced_replacement_depth: 0, depth_gap: 0,
    reason_codes: [], recommended_human_action: 'act',
  }));
  const dqRows = dq.map(x => ({ physical_product_id: x.id, title: x.title || `phys#${x.id}`, missing_evidence: [], reason_codes: [], classification: 'insufficient_data' }));
  return {
    generated_at: new Date().toISOString(),
    summary: {
      physical_products_assessed: action.length + dq.length + sellCount,
      sell_normally_count: sellCount, watch_count: 0, replenish_count: 0, protect_stock_count: 0,
      insufficient_data_count: dq.length, action_exception_count: action.length, data_quality_count: dq.length,
      assessment_errors_count: 0, runtime_ms: 5, avg_ms_per_physical: 2, concurrency: 4,
      db_cache_hits: 0, db_cache_misses: 0, db_cache_per_table: {},
    },
    action_queue: actionRows, action_queue_total: actionRows.length, action_queue_limit_applied: null,
    data_quality_queue: dqRows, assessment_errors: [],
  };
}
const fpOf = a => _internals._fingerprint(a);

// ─── computeDeliveryPlan: authority split ───────────────

test('H-DP1. legacy prior (no notification metadata) → assumed_satisfied populated, confirmed empty', () => {
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: { fingerprint: 'fp1' }, configuredChannels: ['imessage','telegram'], shouldAlert: false });
  assert.deepEqual(p.confirmed_satisfied_channels_prior, []);
  assert.deepEqual(p.assumed_satisfied_channels_prior, ['imessage','telegram']);
  assert.deepEqual(p.satisfied_channels_prior, ['imessage','telegram'], 'union preserved for dedup');
});

test('H-DP2. prior notification.channels with explicit sent=true → confirmed_satisfied populated', () => {
  const prior = { fingerprint: 'fp1', notification: { channels: { imessage: { attempted: true, sent: true }, telegram: { attempted: true, sent: false, error: 'x' } } } };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: prior, configuredChannels: ['imessage','telegram'], shouldAlert: false });
  assert.deepEqual(p.confirmed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(p.assumed_satisfied_channels_prior, []);
});

test('H-DP3. post-hotfix prior with split lists → passed through verbatim', () => {
  const prior = { fingerprint: 'fp1', confirmed_satisfied_channels: ['imessage'], assumed_satisfied_channels: [] };
  const p = computeDeliveryPlan({ currentFingerprint: 'fp1', priorState: prior, configuredChannels: ['imessage','telegram'], shouldAlert: false });
  assert.deepEqual(p.confirmed_satisfied_channels_prior, ['imessage']);
  assert.deepEqual(p.assumed_satisfied_channels_prior, []);
  assert.deepEqual(p.unresolved_channels, ['telegram']);
});

// ─── Orchestrator: actual result overrides prior assumption ───

/**
 * H1. THE #424 BUG: legacy prior assumes both satisfied; force telegram; telegram FAILS.
 *     Expected: satisfied=[imessage], unresolved=[telegram], all_required=false.
 */
test('H1. legacy prior assumed both + force telegram + telegram FAIL → telegram overridden to unresolved', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({ fingerprint: fp }),   // legacy: no channel breakdown
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (payload) => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter', description: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
      only_channels_filter: payload.onlyChannels,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 424, status: row.status }; },
  });

  // Effective state must reflect the actual failure, NOT the legacy assumption.
  assert.deepEqual(r.confirmed_satisfied_channels, [], 'no channel is confirmed_satisfied by this run');
  assert.deepEqual(r.assumed_satisfied_channels, ['imessage'], 'imessage preserved as ASSUMED (was not attempted this run)');
  assert.deepEqual(r.effective_satisfied_channels, ['imessage']);
  assert.deepEqual(r.effective_unresolved_channels, ['telegram']);
  assert.equal(r.all_required_channels_satisfied, false);

  // Run status must be failed (real delivery failure)
  assert.equal(r.run_status, 'failed');
  assert.equal(auditCalls[0].status, 'failed');
  assert.equal(auditCalls[0].output_snapshot.effective_unresolved_channels[0], 'telegram');
  assert.equal(auditCalls[0].output_snapshot.all_required_channels_satisfied, false);

  // Owner rule: surface the permanent-destination problem
  assert.ok(Array.isArray(r.permanent_delivery_failures) && r.permanent_delivery_failures.length >= 1);
  assert.equal(r.permanent_delivery_failures[0].channel, 'telegram');
  assert.match(r.permanent_delivery_failures[0].hint, /Owner must/);
});

/**
 * H2. force telegram + telegram SUCCESS → satisfied=[imessage,telegram], unresolved=[].
 */
test('H2. legacy prior assumed both + force telegram + telegram SUCCESS → both satisfied', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({ fingerprint: fp }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: true, error: null, description: null },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => ({ id: 4242, status: row.status }),
  });
  assert.deepEqual(r.confirmed_satisfied_channels, ['telegram']);
  assert.deepEqual(r.assumed_satisfied_channels, ['imessage']);
  assert.deepEqual([...r.effective_satisfied_channels].sort(), ['imessage','telegram']);
  assert.deepEqual(r.effective_unresolved_channels, []);
  assert.equal(r.all_required_channels_satisfied, true);
  assert.equal(r.run_status, 'succeeded');
});

/**
 * H3. force imessage + imessage FAIL → telegram prior preserved, imessage unresolved.
 */
test('H3. legacy prior + force imessage + imessage FAIL → imessage unresolved, telegram preserved as assumed', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['imessage'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({ fingerprint: fp }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: false, error: 'osascript_send_failed', description: 'invalid destination' },
        telegram: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (_c, row) => ({ id: 4243, status: row.status }),
  });
  assert.deepEqual(r.confirmed_satisfied_channels, []);
  assert.deepEqual(r.assumed_satisfied_channels, ['telegram']);
  assert.deepEqual(r.effective_satisfied_channels, ['telegram']);
  assert.deepEqual(r.effective_unresolved_channels, ['imessage']);
  assert.equal(r.all_required_channels_satisfied, false);
  assert.equal(r.run_status, 'failed');
});

/**
 * H4. Skipped channel (skipped_by_only_channels_filter) preserves prior state.
 */
test('H4. attempted=false / skipped preserves prior channel state', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    // Prior is confirmed telegram sent + unresolved imessage (unusual but valid state)
    fetchPriorFn: async () => ({
      fingerprint: fp,
      confirmed_satisfied_channels: ['telegram'],
      assumed_satisfied_channels: [],
      notification: { channels: {} },
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: true },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => ({ id: 4244, status: row.status }),
  });
  // imessage: not attempted, not in prior → unresolved
  assert.deepEqual(r.effective_unresolved_channels, ['imessage']);
  assert.deepEqual(r.confirmed_satisfied_channels, ['telegram']);
  assert.deepEqual(r.assumed_satisfied_channels, []);
});

/**
 * H5. Actual success overrides prior unresolved.
 */
test('H5. actual sent=true overrides prior unresolved for same channel', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => q,
    // Prior: imessage confirmed, telegram was explicitly unresolved (post-8C-1 partial fail row)
    fetchPriorFn: async () => ({
      fingerprint: fp,
      notification: { channels: {
        imessage: { attempted: true, sent: true },
        telegram: { attempted: true, sent: false, error: 'bot_api_400' },
      }},
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async (payload) => {
      // Retry telegram only (channel_retry path)
      assert.deepEqual(payload.onlyChannels, ['telegram']);
      return {
        attempted: true,
        channels: {
          imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
          telegram: { attempted: true, sent: true },
        },
        configured_channels: ['imessage','telegram'],
        all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
      };
    },
    insertAuditFn: async (_c, row) => ({ id: 4245, status: row.status }),
  });
  assert.deepEqual([...r.confirmed_satisfied_channels].sort(), ['imessage','telegram'], 'both confirmed after retry success');
  assert.deepEqual(r.effective_unresolved_channels, []);
  assert.equal(r.all_required_channels_satisfied, true);
});

/**
 * H6. Actual failure overrides prior ASSUMED satisfied (the #424 core).
 *     (H1 covers this at the audit-persistence level; H6 asserts the pure
 *     accounting: even without forceChannels — happens on any explicit
 *     retry — the assumed→unresolved override is symmetric.)
 */
test('H6. actual sent=false overrides prior assumed_satisfied for same channel', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      confirmed_satisfied_channels: [],
      assumed_satisfied_channels: ['imessage', 'telegram'],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (_c, row) => ({ id: 4246, status: row.status }),
  });
  assert.deepEqual(r.assumed_satisfied_channels, ['imessage'], 'imessage stays assumed (not attempted)');
  assert.deepEqual(r.effective_unresolved_channels, ['telegram'], 'telegram overridden to unresolved by actual sent=false');
});

/**
 * H7. Actual failure overrides prior CONFIRMED satisfied when explicitly retried.
 *     (Confirmed satisfaction is not immortal — if the destination is
 *     re-attempted and fails, the current authoritative state is failure.)
 */
test('H7. actual sent=false overrides prior confirmed_satisfied when the same channel is explicitly retried', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({
      fingerprint: fp,
      confirmed_satisfied_channels: ['imessage', 'telegram'],
      assumed_satisfied_channels: [],
    }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: false, error: 'bot_api_500', description: 'server error' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (_c, row) => ({ id: 4247, status: row.status }),
  });
  assert.deepEqual(r.confirmed_satisfied_channels, ['imessage'], 'imessage preserved (not attempted)');
  assert.deepEqual(r.effective_unresolved_channels, ['telegram'], 'telegram overridden despite prior confirmed');
});

/**
 * H8. all_required_channels_satisfied is exact (not lenient).
 */
test('H8. all_required_channels_satisfied is exact — true only when every configured channel is satisfied', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const scenarios = [
    { name: 'one unresolved', sat: ['imessage'], expected: false },
    { name: 'both satisfied', sat: ['imessage', 'telegram'], expected: true },
    { name: 'none', sat: [], expected: false },
  ];
  for (const s of scenarios) {
    const r = await runInventoryExceptionsDaily({
      commit: true,
      queueFn: async () => q,
      fetchPriorFn: async () => null,
      configuredChannelsFn: async () => ['imessage', 'telegram'],
      notifyFn: async () => {
        const channels = {
          imessage: { attempted: true, sent: s.sat.includes('imessage'), error: null },
          telegram: { attempted: true, sent: s.sat.includes('telegram'), error: s.sat.includes('telegram') ? null : 'x' },
        };
        const attempted = true;
        const sentCount = s.sat.length;
        return {
          attempted,
          channels,
          configured_channels: ['imessage', 'telegram'],
          all_succeeded: sentCount === 2,
          any_succeeded: sentCount > 0,
          partial_failure: sentCount === 1,
          total_failure: sentCount === 0,
        };
      },
      insertAuditFn: async (_c, row) => ({ id: 4248, status: row.status }),
    });
    assert.equal(r.all_required_channels_satisfied, s.expected, `${s.name}: expected ${s.expected}`);
  }
});

/**
 * H9. Audit failed when a required channel is unresolved via actual failure.
 */
test('H9. audit=failed when actual retry produces total_failure', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = fpOf(_internals._extractActionSummary(q.action_queue));
  const auditCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({ fingerprint: fp }),
    configuredChannelsFn: async () => ['imessage', 'telegram'],
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: false, sent: false, error: 'skipped_by_only_channels_filter' },
        telegram: { attempted: true, sent: false, error: 'bot_api_403', description: 'Forbidden: the group chat was deleted' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 4249, status: row.status }; },
  });
  assert.equal(auditCalls[0].status, 'failed');
  assert.equal(auditCalls[0].error_code, 'notification_total_failure');
  assert.match(auditCalls[0].error_message || '', /telegram:bot_api_403/);
});

/**
 * H10. BP WATCH 170 unchanged.
 */
test('H10. Battle Partners WATCH · priority 170 preserved verbatim', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'Battle Partners Booster Box' }] });
  const before = JSON.parse(JSON.stringify(q));
  const r = await runInventoryExceptionsDaily({ queueFn: async () => q, fetchPriorFn: async () => null });
  assert.deepEqual(r.queue_result, before);
  assert.equal(r.queue_result.action_queue[0].decision_status, 'WATCH');
  assert.equal(r.queue_result.action_queue[0].priority_score, 170);
});

/**
 * H11. Zero operational writes even on the hotfix delivery path.
 */
test('H11. no inventory/marketplace/purchase/hold write on hotfix delivery path', async () => {
  const dbCalls = [];
  const fakeClient = { from(table) {
    dbCalls.push(['from', table]);
    return {
      insert: () => { dbCalls.push(['insert', table]); return { select: () => ({ single: async () => ({ data: { id: 1, status: 'succeeded' }, error: null }) }) }; },
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
      delete: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    };
  } };
  await runInventoryExceptionsDaily({
    commit: true, client: fakeClient, forceChannels: ['telegram'],
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => ({ fingerprint: 'fp' }),
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

/**
 * H12. Configuration-error surface: NEVER auto-alter TELEGRAM_CHAT_ID / IMESSAGE_TO.
 *      The hint text must instruct the Owner to fix it manually.
 */
test('H12. permanent-failure hint tells Owner to fix manually, never suggests auto-provision', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const r = await runInventoryExceptionsDaily({
    commit: true,
    forceChannels: ['telegram'],
    queueFn: async () => q,
    fetchPriorFn: async () => ({ fingerprint: fpOf(_internals._extractActionSummary(q.action_queue)) }),
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
    insertAuditFn: async (_c, row) => ({ id: 42412, status: row.status }),
  });
  const p = r.permanent_delivery_failures[0];
  assert.equal(p.channel, 'telegram');
  assert.match(p.hint, /Owner must manually/);
  // Hint MUST NOT suggest the system will auto-create a group / auto-set the destination
  assert.doesNotMatch(p.hint, /automatically create|auto-create|hardcode|silently/i);
});
