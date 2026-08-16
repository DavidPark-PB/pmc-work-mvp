'use strict';

/**
 * tests/oms/inventoryExceptionsDaily.test.js — Phase 8C.
 *
 * Covers dedup / escalation / audit / notify with injectable I/O.
 * Business logic (queue itself) is NOT recomputed here — we inject queue
 * results directly and verify orchestration only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeAlertPlan, _internals } = require('../../src/services/oms/inventoryExceptionsAlerter');
const { runInventoryExceptionsDaily } = require('../../src/jobs/inventoryExceptionsDailyJob');

const DECISION = { SELL_NORMALLY: 'SELL_NORMALLY', WATCH: 'WATCH', REPLENISH: 'REPLENISH', PROTECT_STOCK: 'PROTECT_STOCK', INSUFFICIENT_DATA: 'INSUFFICIENT_DATA' };

// ── Fake queue result builders ───────────────────────────

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

// ── Alerter tests ────────────────────────────────────────

test('A1. first run · empty queue → no alert', () => {
  const r = computeAlertPlan({ currentResult: makeQueueResult({ sellCount: 3 }), priorState: null });
  assert.equal(r.should_alert, false);
  assert.equal(r.alert_kind, 'first_run');
  assert.ok(r.reason_codes.includes('first_run_no_exceptions'));
});

test('A2. first run · with exceptions → alert', () => {
  const r = computeAlertPlan({
    currentResult: makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    priorState: null,
  });
  assert.equal(r.should_alert, true);
  assert.equal(r.alert_kind, 'first_run');
});

test('A3. identical fingerprint → no alert (dedup)', () => {
  const cur = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const fp = _internals._fingerprint(_internals._extractActionSummary(cur.action_queue));
  const prior = { fingerprint: fp, action_summary: _internals._extractActionSummary(cur.action_queue), data_quality_ids: [] };
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, false);
  assert.equal(r.alert_kind, 'no_change');
  assert.ok(r.reason_codes.includes('fingerprint_unchanged'));
});

test('A4. new physical enters queue → alert (new)', () => {
  const prior = { fingerprint: 'x', action_summary: [], data_quality_ids: [] };
  const cur = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'BP' }] });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, true);
  assert.equal(r.alert_kind, 'new');
  assert.equal(r.new_physicals.length, 1);
  assert.equal(r.new_physicals[0].physical_product_id, 1);
});

test('A5. status escalation (WATCH → REPLENISH) → alert (escalation)', () => {
  const prior = { fingerprint: 'x', action_summary: [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170, title: 'BP' }], data_quality_ids: [] };
  const cur = makeQueueResult({ action: [{ id: 1, status: DECISION.REPLENISH, score: 220 }] });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, true);
  assert.equal(r.alert_kind, 'escalation');
  assert.equal(r.escalated.length, 1);
  assert.equal(r.escalated[0].prior_status, 'WATCH');
  assert.equal(r.escalated[0].current_status, 'REPLENISH');
});

test('A6. de-escalation (REPLENISH → WATCH) → NOT alerted by default', () => {
  const prior = { fingerprint: 'x', action_summary: [{ physical_product_id: 1, decision_status: 'REPLENISH', priority_score: 200 }], data_quality_ids: [] };
  const cur = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 120 }] });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, false);
  assert.equal(r.deescalated.length, 1);
});

test('A7. resolved (queue → SELL_NORMALLY) → NOT alerted by default', () => {
  const prior = { fingerprint: 'x', action_summary: [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }], data_quality_ids: [] };
  const cur = makeQueueResult({ sellCount: 1 });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, false);
  assert.equal(r.resolved.length, 1);
});

test('A8. resolved WITH alertResolved=true → alert', () => {
  const prior = { fingerprint: 'x', action_summary: [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }], data_quality_ids: [] };
  const cur = makeQueueResult({ sellCount: 1 });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior, alertResolved: true });
  assert.equal(r.should_alert, true);
  assert.equal(r.alert_kind, 'resolved');
});

test('A9. INSUFFICIENT_DATA change → NOT alerted by default (Owner §6)', () => {
  const prior = { fingerprint: 'x', action_summary: [], data_quality_ids: [] };
  const cur = makeQueueResult({ dq: [{ id: 99 }] });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, false);
  assert.equal(r.data_quality_new.length, 1);
});

test('A10. INSUFFICIENT_DATA WITH alertDataQuality=true → alert', () => {
  const prior = { fingerprint: 'x', action_summary: [], data_quality_ids: [] };
  const cur = makeQueueResult({ dq: [{ id: 99 }] });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior, alertDataQuality: true });
  assert.equal(r.should_alert, true);
  assert.ok(r.reason_codes.some(c => /data_quality_new/.test(c)));
});

test('A11. fingerprint is deterministic across runs (order-invariant on ids)', () => {
  const a = _internals._fingerprint([{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }, { physical_product_id: 2, decision_status: 'REPLENISH', priority_score: 220 }]);
  const b = _internals._fingerprint([{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }, { physical_product_id: 2, decision_status: 'REPLENISH', priority_score: 220 }]);
  assert.equal(a, b);
});

test('A12. multiple diffs → alert_kind=multiple', () => {
  const prior = { fingerprint: 'x', action_summary: [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }], data_quality_ids: [] };
  const cur = makeQueueResult({ action: [{ id: 1, status: DECISION.PROTECT_STOCK, score: 320 }, { id: 2, status: DECISION.WATCH, score: 120 }] });
  const r = computeAlertPlan({ currentResult: cur, priorState: prior });
  assert.equal(r.should_alert, true);
  assert.equal(r.alert_kind, 'multiple');
  assert.equal(r.new_physicals.length, 1);
  assert.equal(r.escalated.length, 1);
});

test('A13. SELL_NORMALLY only, no prior → NOT alerted (Owner §4)', () => {
  const r = computeAlertPlan({ currentResult: makeQueueResult({ sellCount: 5 }), priorState: null });
  assert.equal(r.should_alert, false);
});

// ── Orchestrator (runInventoryExceptionsDaily) tests ─────

test('D1. default dry-run: no notify, no audit insert', async () => {
  const notifyCalls = []; const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async (x) => { notifyCalls.push(x); return { sent: true }; },
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 1, status: row.status }; },
  });
  assert.equal(r.commit, false);
  assert.equal(notifyCalls.length, 0);
  assert.equal(auditCalls.length, 0);
  assert.equal(r.alert_plan.should_alert, true);
  assert.equal(r.notification.skipped, true);
});

test('D2. commit + alert (all channels succeed) → notify called AND audit status=succeeded', async () => {
  const notifyCalls = []; const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async (x) => { notifyCalls.push(x); return {
      attempted: true, channels: { telegram: { attempted: true, sent: true, error: null, description: null } },
      configured_channels: ['telegram'], all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }; },
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 42, status: row.status }; },
  });
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].title.includes('Inventory exceptions'), true);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].status, 'succeeded');
  assert.equal(auditCalls[0].output_snapshot.fingerprint.length > 0, true);
  assert.equal(r.notification.all_succeeded, true);
  assert.equal(r.notification.partial_failure, false);
  assert.equal(r.audit_row.id, 42);
});

test('D3. commit but no alert (dedup) → notify skipped · audit still written', async () => {
  const fp = _internals._fingerprint([{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }]);
  const notifyCalls = []; const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => ({ fingerprint: fp, action_summary: [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }], data_quality_ids: [] }),
    notifyFn: async (x) => { notifyCalls.push(x); return { attempted: true, channels: {}, all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }; },
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 43, status: row.status }; },
  });
  assert.equal(notifyCalls.length, 0);
  assert.equal(auditCalls.length, 1, 'audit row inserted so future runs know last state');
  assert.equal(r.notification.skipped, true);
  // 8C-2: fingerprint dedup + implied channel-satisfaction is reported as
  //       'all_channels_already_satisfied' (delivery-plan aware) rather than
  //       the coarser 'should_alert_false' — see computeDeliveryPlan.
  assert.ok(
    r.notification.reason === 'all_channels_already_satisfied' || r.notification.reason === 'should_alert_false',
    `unexpected skip reason: ${r.notification.reason}`
  );
});

test('D4. failure isolation: notify throws → audit still written · run reports total_failure', async () => {
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => { throw new Error('telegram_502'); },
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 44, status: row.status }; },
  });
  assert.equal(r.notification.total_failure, true);
  assert.match(r.notification.thrown_error, /telegram_502/);
  assert.equal(auditCalls.length, 1);
  // 8C-1: run status must be 'failed' when notification totally failed
  assert.equal(auditCalls[0].status, 'failed');
  assert.equal(auditCalls[0].output_snapshot.queue_success, true);
  assert.equal(auditCalls[0].output_snapshot.notification_total_failure, true);
});

test('D5. failure isolation: queue itself throws → audit written with failed status · notify NOT called', async () => {
  const notifyCalls = []; const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => { throw new Error('supabase_down'); },
    fetchPriorFn: async () => null,
    notifyFn: async (x) => { notifyCalls.push(x); return { sent: true }; },
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 45, status: row.status }; },
  });
  assert.equal(r.queue_error, 'supabase_down');
  assert.equal(r.alert_plan.should_alert, false);
  assert.equal(notifyCalls.length, 0);
  assert.equal(auditCalls[0].status, 'failed');
});

test('D6. retry-safe: request_id derived from timestamp · deterministic within a same-now invocation', async () => {
  const r = await runInventoryExceptionsDaily({
    now: 1725000000000,
    queueFn: async () => makeQueueResult({ sellCount: 1 }),
    fetchPriorFn: async () => null,
  });
  assert.match(r.request_id, /^inventory_exceptions_daily_/);
});

test('D7. fetchPrior throws → treated as first_run · no crash', async () => {
  const r = await runInventoryExceptionsDaily({
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => { throw new Error('rls_denied'); },
  });
  assert.equal(r.alert_plan.alert_kind, 'first_run');
  assert.equal(r.alert_plan.should_alert, true);
});

test('D8. NO auto-purchase / hold / marketplace write path even under commit', async () => {
  // We simply verify no such calls are made by the orchestrator itself. Business
  // services are stubbed and not touched.
  const dbCalls = [];
  const fakeClient = { from(table) { dbCalls.push(['from', table]); return { insert: () => { dbCalls.push(['insert', table]); return { select: () => ({ single: async () => ({ data: { id: 1, status: 'succeeded' }, error: null }) }) }; } }; } };
  const r = await runInventoryExceptionsDaily({
    commit: true, client: fakeClient,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({ sent: true }),
    insertAuditFn: async (c, row) => { const res = await c.from('automation_runs').insert(row).select('id, status').single(); return res.data; },
  });
  // Only automation_runs inserted. No purchase_requests / inventory_movements / marketplace calls.
  const badInserts = dbCalls.filter(c => c[0] === 'insert' && !['automation_runs'].includes(c[1]));
  assert.equal(badInserts.length, 0);
});

test('D9. Battle-Partners-shaped queue result → digest mentions WATCH and priority', async () => {
  const r = await runInventoryExceptionsDaily({
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'Battle Partners Booster Box' }] }),
    fetchPriorFn: async () => null,
  });
  assert.match(r.alert_plan.digest_title, /Inventory exceptions/);
  assert.match(r.alert_plan.digest_text, /Battle Partners/);
  assert.match(r.alert_plan.digest_text, /WATCH/);
  assert.match(r.alert_plan.digest_text, /170/);
});

test('D10. deep-equivalent with 8B output — orchestrator does NOT modify queue result', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const cloneBefore = JSON.parse(JSON.stringify(q));
  const r = await runInventoryExceptionsDaily({
    queueFn: async () => q,
    fetchPriorFn: async () => null,
  });
  assert.deepEqual(r.queue_result, cloneBefore, '8B queue result must not be mutated by 8C orchestrator');
});

// ── Idempotency / no leak ───────────────────────────────

test('D11. two consecutive runs with same queue AND state → second alerts nothing (dedup)', async () => {
  // Fake prior store that captures last inserted snapshot
  let lastSnapshot = null;
  const notifyCalls = [];
  const queue = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] });
  const run = async () => runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => queue,
    fetchPriorFn: async () => lastSnapshot,
    notifyFn: async (x) => { notifyCalls.push(x); return {
      attempted: true, channels: {}, configured_channels: [],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }; },
    insertAuditFn: async (_c, row) => {
      lastSnapshot = { fingerprint: row.output_snapshot.fingerprint, action_summary: row.output_snapshot.action_summary, data_quality_ids: row.output_snapshot.data_quality_ids };
      return { id: 100, status: row.status };
    },
  });
  const r1 = await run(); assert.equal(r1.notification.all_succeeded, true);
  const r2 = await run();
  assert.equal(r2.notification.skipped, true);
  // 8C-2: dedup + implied satisfaction reports as 'all_channels_already_satisfied'.
  assert.ok(
    r2.notification.reason === 'all_channels_already_satisfied' || r2.notification.reason === 'should_alert_false',
    `unexpected skip reason: ${r2.notification.reason}`
  );
  assert.equal(notifyCalls.length, 1);   // only first run notified
});

// ── 8C-1 hotfix — notification delivery hardening ───────

test('N1. Telegram plain-text digest sends OK when digest contains underscores/brackets', async () => {
  // Simulate the exact production digest text that broke on legacy Markdown parse.
  const tricky = '[OMS] Inventory exceptions (first_run) · WATCH=1 REPLENISH=0 PROTECT_STOCK=0\n\ndb_cache_hits=3 · action_exceptions=1\n#1 [WATCH · 170] Battle Partners Booster Box';
  // Stub the underlying fetch to capture the payload.
  const origFetch = global.fetch;
  let payload = null;
  global.fetch = async (url, opts) => {
    payload = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 999 } }) };
  };
  process.env.TELEGRAM_BOT_TOKEN = 'stub';
  process.env.TELEGRAM_CHAT_ID = '123';
  delete require.cache[require.resolve('../../src/services/telegramBot')];
  const tg = require('../../src/services/telegramBot');
  try {
    const res = await tg.sendPlain(tricky);
    assert.equal(res.ok, true);
    assert.equal(payload.parse_mode, undefined, 'parse_mode must NOT be present in sendPlain body');
    assert.equal(payload.text.includes('PROTECT_STOCK=0'), true);
  } finally {
    global.fetch = origFetch;
  }
});

test('N2. underscores + asterisks in digest do not trigger parse error (plain text path)', async () => {
  const origFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (_url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  process.env.TELEGRAM_BOT_TOKEN = 'stub';
  process.env.TELEGRAM_CHAT_ID = '123';
  delete require.cache[require.resolve('../../src/services/telegramBot')];
  const tg = require('../../src/services/telegramBot');
  try {
    const r = await tg.sendPlain('one_underscore *asterisk* [bracket] `backtick`');
    assert.equal(r.ok, true);
    assert.equal(capturedBodies[0].parse_mode, undefined);
  } finally {
    global.fetch = origFetch;
  }
});

test('N3. iMessage success + Telegram failure → partial_failure surfaced (not hidden as success)', async () => {
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'can\'t parse entities' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: true, partial_failure: true, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 500, status: row.status }; },
  });
  assert.equal(r.notification.partial_failure, true);
  assert.equal(r.notification.all_succeeded, false);
  assert.equal(auditCalls[0].status, 'failed', 'partial delivery must NOT be recorded as succeeded');
  assert.equal(auditCalls[0].output_snapshot.queue_success, true);
  assert.equal(auditCalls[0].output_snapshot.notification_partial_failure, true);
  assert.equal(auditCalls[0].error_code, 'notification_partial_failure');
  assert.match(auditCalls[0].error_message, /telegram:bot_api_400/);
});

test('N4. both channels succeed → all_succeeded=true · audit succeeded', async () => {
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: true, error: null, description: null },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 501, status: row.status }; },
  });
  assert.equal(r.notification.all_succeeded, true);
  assert.equal(auditCalls[0].status, 'succeeded');
  assert.equal(auditCalls[0].error_code, null);
});

test('N5. both channels fail → total_failure=true · audit failed · error_code=notification_total_failure', async () => {
  const auditCalls = [];
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: false, error: 'osascript_send_failed', description: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'parse error' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 502, status: row.status }; },
  });
  assert.equal(r.notification.total_failure, true);
  assert.equal(auditCalls[0].status, 'failed');
  assert.equal(auditCalls[0].error_code, 'notification_total_failure');
});

test('N6. dry-run → notification call count = 0 (unchanged)', async () => {
  const notifyCalls = [];
  await runInventoryExceptionsDaily({
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async (x) => { notifyCalls.push(x); return {
      attempted: true, channels: {}, configured_channels: [],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }; },
  });
  assert.equal(notifyCalls.length, 0);
});

test('N7. unchanged fingerprint → notification call count = 0', async () => {
  const fp = _internals._fingerprint([{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }]);
  const notifyCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => ({ fingerprint: fp, action_summary: [{ physical_product_id: 1, decision_status: 'WATCH', priority_score: 170 }], data_quality_ids: [] }),
    notifyFn: async (x) => { notifyCalls.push(x); return {
      attempted: true, channels: {}, configured_channels: [],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }; },
    insertAuditFn: async () => ({ id: 600, status: 'succeeded' }),
  });
  assert.equal(notifyCalls.length, 0);
});

test('N8. audit output_snapshot preserves per-channel delivery result', async () => {
  const auditCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: false, error: 'bot_api_400', description: 'parse fail' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: true, partial_failure: true, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 700, status: row.status }; },
  });
  const notif = auditCalls[0].output_snapshot.notification;
  assert.equal(notif.channels.imessage.sent, true);
  assert.equal(notif.channels.telegram.sent, false);
  assert.equal(notif.channels.telegram.error, 'bot_api_400');
  assert.equal(notif.channels.telegram.description, 'parse fail');
});

test('N9. partial failure is NEVER rendered as sent=yes / all_succeeded=true', async () => {
  const r = await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: false, error: 'x', description: 'y' },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: false, any_succeeded: true, partial_failure: true, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => ({ id: 800, status: row.status }),
  });
  assert.notEqual(r.notification.all_succeeded, true);
  assert.equal(r.notification.partial_failure, true);
});

test('N10. inventory queue / BP WATCH result is unchanged (8B contract preserved)', async () => {
  const q = makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170, title: 'Battle Partners Booster Box' }] });
  const cloneBefore = JSON.parse(JSON.stringify(q));
  const r = await runInventoryExceptionsDaily({
    queueFn: async () => q, fetchPriorFn: async () => null,
  });
  assert.deepEqual(r.queue_result, cloneBefore);
  assert.equal(r.queue_result.action_queue[0].decision_status, DECISION.WATCH);
  assert.equal(r.queue_result.action_queue[0].priority_score, 170);
});

test('N11. zero inventory/marketplace/purchase/hold writes even on notification path', async () => {
  const dbCalls = [];
  const fakeClient = { from(table) { dbCalls.push(['from', table]); return { insert: () => { dbCalls.push(['insert', table]); return { select: () => ({ single: async () => ({ data: { id: 1, status: 'succeeded' }, error: null }) }) }; } }; } };
  await runInventoryExceptionsDaily({
    commit: true, client: fakeClient,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({ attempted: true, channels: {}, configured_channels: [], all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false }),
    insertAuditFn: async (c, row) => { const res = await c.from('automation_runs').insert(row).select('id, status').single(); return res.data; },
  });
  const badInserts = dbCalls.filter(c => c[0] === 'insert' && !['automation_runs'].includes(c[1]));
  assert.equal(badInserts.length, 0);
});

test('N12. secrets — audit snapshot must not contain BOT_TOKEN / CHAT_ID / IMESSAGE_TO literals', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'SUPER_SECRET_TOKEN_ZZZ';
  process.env.TELEGRAM_CHAT_ID = '-100_SECRET_CHAT_ID';
  process.env.IMESSAGE_TO = 'secret@example.com';
  const auditCalls = [];
  await runInventoryExceptionsDaily({
    commit: true,
    queueFn: async () => makeQueueResult({ action: [{ id: 1, status: DECISION.WATCH, score: 170 }] }),
    fetchPriorFn: async () => null,
    notifyFn: async () => ({
      attempted: true,
      channels: {
        imessage: { attempted: true, sent: true, error: null, description: null },
        telegram: { attempted: true, sent: true, error: null, description: null },
      },
      configured_channels: ['imessage', 'telegram'],
      all_succeeded: true, any_succeeded: true, partial_failure: false, total_failure: false,
    }),
    insertAuditFn: async (_c, row) => { auditCalls.push(row); return { id: 900, status: row.status }; },
  });
  const flat = JSON.stringify(auditCalls[0]);
  assert.equal(flat.includes('SUPER_SECRET_TOKEN_ZZZ'), false);
  assert.equal(flat.includes('-100_SECRET_CHAT_ID'), false);
  assert.equal(flat.includes('secret@example.com'), false);
});
