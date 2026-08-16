/**
 * src/jobs/inventoryExceptionsDailyJob.js — Phase 8C.
 *
 * Daily orchestrator that wraps existing services:
 *   buildInventoryExceptionQueue    (READ-ONLY · Phase 8B/8B-1)
 *   computeAlertPlan                (pure · Phase 8C)
 *   automation_runs audit           (append-only · existing schema)
 *   notify.sendAlert                (Telegram-first · existing channel)
 *
 * Owner rules:
 *   §1 reuse existing queue service · §2 no business logic recompute
 *   §3 READ-ONLY by default · §4 no alert if only SELL_NORMALLY
 *   §5 alert on WATCH/REPLENISH/PROTECT_STOCK change · §6 INSUFFICIENT_DATA separate
 *   §7 dedup via fingerprint · §8 escalation notified · §9 reuse safest channel
 *   §10 no auto purchase / hold / marketplace write
 *   §11 audit trail via automation_runs · §12 failure-isolated · retry-safe
 *
 * Injectable I/O for testability:
 *   queueFn         — build queue
 *   fetchPriorFn    — read prior automation_runs snapshot
 *   insertAuditFn   — insert automation_runs row
 *   notifyFn        — send notification (title, message, data)
 *   clientFactory   — supabase client factory for default I/O
 */
'use strict';

const { buildInventoryExceptionQueue } = require('../services/oms/inventoryExceptionQueueService');
const { computeAlertPlan, computeDeliveryPlan } = require('../services/oms/inventoryExceptionsAlerter');

const AUTOMATION_TYPE = 'inventory_exceptions_daily';

/**
 * @param {Object} args
 * @param {boolean} [args.commit=false]   DEFAULT DRY-RUN. Only --commit writes audit + notifies.
 * @param {boolean} [args.activeOnly=true]
 * @param {number|null} [args.limit=null]           display limit for action_queue in queue result
 * @param {number} [args.concurrency=4]
 * @param {boolean} [args.alertDataQuality=false]   Owner §6 · default off
 * @param {boolean} [args.alertResolved=false]      informational · default off
 * @param {number|null} [args.actorId=null]
 * @param {number} [args.now=Date.now()]
 * // Injectable I/O
 * @param {Function} [args.queueFn]
 * @param {Function} [args.fetchPriorFn]
 * @param {Function} [args.insertAuditFn]
 * @param {Function} [args.notifyFn]
 * @param {Object}   [args.client]
 */
async function runInventoryExceptionsDaily({
  commit = false, activeOnly = true, limit = null, concurrency = 4,
  alertDataQuality = false, alertResolved = false,
  actorId = null, now = Date.now(),
  forceChannels = [],   // 8C-2 · Owner-explicit one-shot override
  queueFn = null, fetchPriorFn = null, insertAuditFn = null, notifyFn = null,
  configuredChannelsFn = null,   // 8C-2 · injectable for tests
  client = null,
} = {}) {
  const startedAt = new Date(now).toISOString();
  const requestId = `inventory_exceptions_daily_${startedAt}`;

  // 1) Build queue (READ-ONLY · Phase 8B/8B-1)
  const _queueFn = queueFn || ((opts) => buildInventoryExceptionQueue(opts));
  let queueResult; let queueError = null;
  try {
    queueResult = await _queueFn({ activeOnly, limit, concurrency, asOf: now });
  } catch (e) {
    queueError = e && e.message ? String(e.message) : String(e);
  }

  // 2) Load prior state (best-effort · retry-safe)
  let priorState = null;
  if (!queueError) {
    try {
      priorState = await (fetchPriorFn || _defaultFetchPrior)(client);
    } catch (e) {
      // Fatal for alerting but not for run · treat as first_run
      priorState = null;
    }
  }

  // 3) Compute alert plan
  const alertPlan = queueError
    ? { should_alert: false, alert_kind: 'run_error', fingerprint: null, prior_fingerprint: priorState?.fingerprint ?? null,
        new_physicals: [], escalated: [], resolved: [], deescalated: [], data_quality_new: [], data_quality_resolved: [],
        action_summary: [], data_quality_ids: [],
        digest_text: `Run error: ${queueError}`, digest_title: '[OMS] Inventory exceptions run FAILED',
        reason_codes: ['queue_error'] }
    : computeAlertPlan({ currentResult: queueResult, priorState, alertDataQuality, alertResolved });

  // 3.5) 8C-2: compute channel-aware delivery plan
  //      Separates "business alert change" (should_alert) from "delivery
  //      completeness" (which channels still need to see the current
  //      fingerprint). If Telegram failed on the prior run for the same
  //      fingerprint, we retry Telegram only — iMessage does not duplicate.
  const _cfgFn = configuredChannelsFn || _defaultConfiguredChannels;
  let configuredChannels = [];
  try { configuredChannels = await _cfgFn(); } catch (_) { configuredChannels = []; }
  const deliveryPlan = queueError
    ? { fingerprint_unchanged: false, prior_fingerprint: priorState?.fingerprint ?? null,
        prior_channels: null, satisfied_channels_prior: [], unresolved_channels: [],
        pending_channels: [], should_deliver_to: [], retry_kind: 'run_error',
        force_channels_requested: [], legacy_prior_note: null,
        configured_channels: configuredChannels }
    : computeDeliveryPlan({
        currentFingerprint: alertPlan.fingerprint,
        priorState,
        configuredChannels,
        forceChannels,
        shouldAlert: alertPlan.should_alert,
      });

  // 4) Notify — 8C-2 delivery decision
  //    Two paths:
  //      (a) alert-driven (first_run / business_change): shouldAlert drives
  //          delivery to ALL configured channels (onlyChannels=null). Preserves
  //          8C-1 semantics.
  //      (b) retry-driven (channel_retry / force): explicit shouldDeliverTo
  //          list filters channels so successful channels don't duplicate.
  const isRetryOnlyPath = deliveryPlan.retry_kind === 'channel_retry' || deliveryPlan.retry_kind === 'force';
  const alertDrivenDeliver = commit && alertPlan.should_alert && !isRetryOnlyPath;
  const retryDrivenDeliver = commit && isRetryOnlyPath && deliveryPlan.should_deliver_to.length > 0;
  const willDeliver = alertDrivenDeliver || retryDrivenDeliver;
  const onlyChannelsForNotify = isRetryOnlyPath ? deliveryPlan.should_deliver_to : null;

  let notification;
  if (willDeliver) {
    const _notifyFn = notifyFn || _defaultNotify;
    try {
      const res = await _notifyFn({
        title: alertPlan.digest_title,
        message: alertPlan.digest_text,
        data: {
          alert_kind: alertPlan.alert_kind,
          new_physicals: alertPlan.new_physicals.map(x => x.physical_product_id),
          escalated: alertPlan.escalated.map(x => x.physical_product_id),
          fingerprint: alertPlan.fingerprint,
        },
        onlyChannels: onlyChannelsForNotify,
        retryKind: deliveryPlan.retry_kind,
      });
      notification = _coerceNotificationResult(res);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      notification = {
        attempted: true, channels: {}, configured_channels: configuredChannels,
        all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: true,
        thrown_error: msg,
      };
    }
  } else {
    const reason = !commit
      ? 'dry_run'
      : deliveryPlan.retry_kind === 'satisfied'
        ? 'all_channels_already_satisfied'
        : (!alertPlan.should_alert && !isRetryOnlyPath)
          ? 'should_alert_false'
          : (isRetryOnlyPath && deliveryPlan.should_deliver_to.length === 0)
            ? 'all_channels_already_satisfied'
            : 'nothing_to_deliver';
    notification = {
      attempted: false, channels: {}, configured_channels: configuredChannels,
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: false,
      skipped: true, reason,
    };
  }

  // 8C-2 hotfix: effective delivery state
  //   Owner rule #5: legacy assumed satisfaction is LOWER AUTHORITY than
  //   any new actual delivery result. So if a channel is attempted this run:
  //     attempted && sent  → confirmed_satisfied (overrides prior)
  //     attempted && !sent → unresolved          (overrides prior assumed OR confirmed)
  //   If a channel is NOT attempted this run (skipped_by_only_channels_filter
  //   or no delivery attempted): preserve prior state verbatim.
  //
  //   Two-tier accounting so future runs can reason about authority:
  //     confirmed_satisfied_channels — evidenced by an actual sent=true
  //     assumed_satisfied_channels   — inherited legacy assumption, no evidence
  //   effective_satisfied = confirmed ∪ assumed  (union · dedup purposes)
  //   effective_unresolved = configured − effective_satisfied
  const priorConfirmedSet = new Set(
    deliveryPlan.fingerprint_unchanged ? (deliveryPlan.confirmed_satisfied_channels_prior || []) : []
  );
  const priorAssumedSet = new Set(
    deliveryPlan.fingerprint_unchanged ? (deliveryPlan.assumed_satisfied_channels_prior || []) : []
  );
  const confirmedSatisfiedSet = new Set();
  const assumedSatisfiedSet = new Set();
  const explicitlyUnresolvedSet = new Set();
  const chans = notification.channels || {};
  for (const ch of configuredChannels) {
    const c = chans[ch] || null;
    const attempted = !!(c && c.attempted === true);
    const sent = !!(c && c.sent === true);
    if (attempted && sent) {
      confirmedSatisfiedSet.add(ch);
    } else if (attempted && !sent) {
      explicitlyUnresolvedSet.add(ch);
    } else {
      // Not attempted this run — preserve prior state (verbatim).
      if (priorConfirmedSet.has(ch)) confirmedSatisfiedSet.add(ch);
      else if (priorAssumedSet.has(ch)) assumedSatisfiedSet.add(ch);
      // else: no prior evidence and not attempted → remains unresolved
    }
  }
  const confirmedSatisfiedChannels = [...confirmedSatisfiedSet];
  const assumedSatisfiedChannels = [...assumedSatisfiedSet];
  const effectiveSatisfiedSet = new Set([...confirmedSatisfiedSet, ...assumedSatisfiedSet]);
  const effectiveSatisfiedChannels = [...effectiveSatisfiedSet];
  const requiredChannels = configuredChannels;
  const effectiveUnresolvedChannels = requiredChannels.filter(ch => !effectiveSatisfiedSet.has(ch));
  const allRequiredChannelsSatisfied = requiredChannels.length > 0 && effectiveUnresolvedChannels.length === 0;

  // Surface permanent delivery failures (chat/group deleted, bot blocked, etc.)
  // without altering any configuration. Owner rule: do NOT silently change
  // TELEGRAM_CHAT_ID or auto-provision destinations.
  const permanentDeliveryFailures = _detectPermanentDeliveryFailures(chans);

  // 5) Persist audit row (only when commit; retry-safe via request_id)
  //    8C-1 semantics (Owner-approved):
  //      queue failed                                → status='failed', queue_success=false
  //      queue OK + no notify needed                 → status='succeeded'
  //      queue OK + notify all channels succeeded    → status='succeeded'
  //      queue OK + notification partial/total fail  → status='failed'
  //                                                    queue_success=true
  //                                                    notification_partial_failure=true|false
  //                                                    notification_total_failure=true|false
  const queueSuccess = !queueError;
  const notificationBadDelivery = notification.attempted && (notification.total_failure || notification.partial_failure || !!notification.thrown_error);
  // 8C-2: succeeded when queue OK AND (all required channels satisfied OR no
  //   channels required OR no alert needed AND nothing attempted OR retry
  //   fully satisfied delivery). Failed when a channel we attempted did not
  //   deliver AND that keeps required delivery incomplete.
  const deliveryFullySatisfied = allRequiredChannelsSatisfied || requiredChannels.length === 0;
  const noAlertNeededAndNothingAttempted = !alertPlan.should_alert && !notification.attempted;
  const runStatus = queueError
    ? 'failed'
    : notificationBadDelivery
      ? 'failed'
      : (deliveryFullySatisfied || noAlertNeededAndNothingAttempted)
        ? 'succeeded'
        : 'succeeded'; // notify skipped path (dry-run, no config) — still succeeded
  const errorCode = queueError ? 'queue_error'
    : notification.total_failure ? 'notification_total_failure'
    : notification.partial_failure ? 'notification_partial_failure'
    : notification.thrown_error ? 'notification_thrown_error'
    : null;
  const errorMessage = queueError
    ? queueError
    : notification.thrown_error
      ? notification.thrown_error
      : (notification.total_failure || notification.partial_failure)
        ? Object.entries(notification.channels || {})
            .filter(([, c]) => c.attempted && !c.sent)
            .map(([name, c]) => `${name}:${c.error || 'failed'}${c.description ? '(' + c.description + ')' : ''}`)
            .join('; ') || null
        : null;

  let auditRow = null; let auditError = null;
  if (commit) {
    try {
      auditRow = await (insertAuditFn || _defaultInsertAudit)(client, {
        request_id: requestId,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        actor_id: actorId,
        status: runStatus,
        input_snapshot: { commit, activeOnly, limit, concurrency, alertDataQuality, alertResolved, now: startedAt },
        output_snapshot: {
          // 8C-2b: explicit versioning of the delivery-state contract. Rows
          // stamped >=2 have been derived under the corrected authority model
          // and can be trusted directly. Older rows require reconstruction.
          delivery_state_version: 2,
          summary: queueResult?.summary || null,
          action_summary: alertPlan.action_summary,
          data_quality_ids: alertPlan.data_quality_ids,
          fingerprint: alertPlan.fingerprint,
          should_alert: alertPlan.should_alert,
          alert_kind: alertPlan.alert_kind,
          new_physicals_count: alertPlan.new_physicals.length,
          escalated_count: alertPlan.escalated.length,
          resolved_count: alertPlan.resolved.length,
          data_quality_new_count: alertPlan.data_quality_new.length,
          queue_success: queueSuccess,
          notification_partial_failure: !!notification.partial_failure,
          notification_total_failure: !!notification.total_failure,
          notification_attempted: !!notification.attempted,
          notification,
          delivery_plan: deliveryPlan,
          confirmed_satisfied_channels: confirmedSatisfiedChannels,
          assumed_satisfied_channels: assumedSatisfiedChannels,
          effective_satisfied_channels: effectiveSatisfiedChannels,
          effective_unresolved_channels: effectiveUnresolvedChannels,
          all_required_channels_satisfied: allRequiredChannelsSatisfied,
          permanent_delivery_failures: permanentDeliveryFailures,
          run_error: queueError,
        },
        error_code: errorCode,
        error_message: errorMessage,
      });
    } catch (e) {
      auditError = e && e.message ? String(e.message) : String(e);
    }
  }

  return {
    request_id: requestId,
    commit,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    queue_result: queueResult || null,
    queue_error: queueError,
    alert_plan: alertPlan,
    delivery_plan: deliveryPlan,
    notification,
    confirmed_satisfied_channels: confirmedSatisfiedChannels,
    assumed_satisfied_channels: assumedSatisfiedChannels,
    effective_satisfied_channels: effectiveSatisfiedChannels,
    effective_unresolved_channels: effectiveUnresolvedChannels,
    all_required_channels_satisfied: allRequiredChannelsSatisfied,
    permanent_delivery_failures: permanentDeliveryFailures,
    audit_row: auditRow,
    audit_error: auditError,
    prior_state: priorState,
    run_status: runStatus,
  };
}

// ─── default I/O ─────────────────────────────────────────

/**
 * 8C-2b: fetch prior state and RECONSTRUCT delivery from history.
 *
 * Motivation: a single legacy audit row's derived fields
 * (`effective_satisfied_channels`) can be corrupted from a pre-hotfix bug and
 * lie about which channels actually delivered. Trusting one row = repeat of
 * the #424 misclassification. Instead, walk the last N same-fingerprint rows
 * chronologically and let `deriveEffectiveDeliveryStateFromRuns` compute the
 * correct effective state from raw notification.channels evidence.
 *
 * The returned priorState carries `recent_runs_same_fingerprint`, which
 * `computeDeliveryPlan` picks up and reconstructs from — bypassing any
 * single-row derived field.
 *
 * DB shape unchanged. JSONB output_snapshot only. No migration.
 */
async function _defaultFetchPrior(clientArg) {
  const client = clientArg || require('../db/supabaseClient').getClient();
  const { data } = await client.from('automation_runs')
    .select('id, output_snapshot, completed_at, status')
    .eq('automation_type', AUTOMATION_TYPE)
    .order('completed_at', { ascending: false })
    .limit(20);
  const rows = data || [];
  const acceptable = rows.find(r => {
    if (!r || !r.output_snapshot) return false;
    if (r.status === 'succeeded') return true;
    // 8C-1 partial/total notification failure paths still have queue_success=true
    if (r.output_snapshot.queue_success === true) return true;
    return false;
  }) || null;
  if (!acceptable) return null;
  const snap = acceptable.output_snapshot || {};
  const currentFp = snap.fingerprint || null;

  // Filter recent rows to the SAME fingerprint (regardless of status) so we
  // can reconstruct end-to-end. A queue-only-failure row (queue_success=false)
  // has no notification/channels information anyway, so include is a no-op.
  const sameFpRuns = currentFp
    ? rows.filter(r => (r?.output_snapshot?.fingerprint || null) === currentFp)
    : [];

  return {
    id: acceptable.id,
    status: acceptable.status,
    fingerprint: currentFp,
    action_summary: snap.action_summary || [],
    data_quality_ids: snap.data_quality_ids || [],
    completed_at: acceptable.completed_at,
    // 8C-2c: accept legacy `notified` field name in prior rows so CLI display
    // and any downstream field access do not silently see null.
    notification: snap.notification || snap.notified || null,
    // 8C-2b: reconstruction input — raw rows for chronological derivation
    recent_runs_same_fingerprint: sameFpRuns.map(r => ({
      id: r.id,
      status: r.status,
      completed_at: r.completed_at,
      output_snapshot: r.output_snapshot,
    })),
    // 8C-2 hotfix1 fields — retained for backward compat when history isn't
    // available or the reconstruction path is bypassed.
    effective_satisfied_channels: Array.isArray(snap.effective_satisfied_channels)
      ? snap.effective_satisfied_channels
      : null,
    confirmed_satisfied_channels: Array.isArray(snap.confirmed_satisfied_channels)
      ? snap.confirmed_satisfied_channels
      : null,
    assumed_satisfied_channels: Array.isArray(snap.assumed_satisfied_channels)
      ? snap.assumed_satisfied_channels
      : null,
  };
}

/**
 * 8C-2 hotfix: detect delivery failures that will keep failing until the
 * Owner reconfigures the destination. We SURFACE these — we never rewrite
 * TELEGRAM_CHAT_ID / IMESSAGE_TO or auto-provision a group.
 *
 *   Telegram: 403 Forbidden + description mentioning
 *             "group chat was deleted" / "bot was blocked" / "chat not found"
 *   iMessage: description containing "invalid destination" / similar
 *
 * Returns [{channel, error, description, hint}] — empty when nothing matches.
 * Hint is a short, non-destructive operator message; never a credential.
 */
function _detectPermanentDeliveryFailures(channels) {
  const out = [];
  const chans = channels || {};
  for (const [name, c] of Object.entries(chans)) {
    if (!c || c.attempted !== true || c.sent !== false) continue;
    const err = String(c.error || '');
    const desc = String(c.description || '');
    const combined = (err + ' ' + desc).toLowerCase();
    let hint = null;
    if (name === 'telegram') {
      if (/\b403\b/.test(combined) || /forbidden/i.test(combined)) {
        if (/group chat was deleted|chat not found|bot was blocked|bot was kicked/i.test(combined)) {
          hint = 'Telegram destination is invalid or the bot no longer has access. Owner must manually supply a valid TELEGRAM_CHAT_ID for a chat where the bot has send permission.';
        } else {
          hint = 'Telegram returned 403 Forbidden. Owner must manually verify bot access / destination configuration.';
        }
      }
    } else if (name === 'imessage') {
      if (/invalid|no such|destination|not.*imessage/i.test(combined)) {
        hint = 'iMessage destination invalid. Owner must manually supply a reachable IMESSAGE_TO.';
      }
    }
    if (hint) out.push({ channel: name, error: err, description: desc, hint });
  }
  return out;
}

async function _defaultConfiguredChannels() {
  const notify = require('../services/notify');
  if (typeof notify.getConfiguredChannels === 'function') return notify.getConfiguredChannels();
  return notify.isConfigured && notify.isConfigured() ? [] : [];
}

async function _defaultInsertAudit(clientArg, row) {
  const client = clientArg || require('../db/supabaseClient').getClient();
  const payload = {
    automation_type: AUTOMATION_TYPE,
    triggered_by: row.actor_id != null ? String(row.actor_id) : 'system_daily',
    request_id: row.request_id,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    input_snapshot: row.input_snapshot,
    output_snapshot: row.output_snapshot,
    error_code: row.error_code,
    error_message: row.error_message,
    retry_count: 0,
  };
  const { data, error } = await client.from('automation_runs').insert(payload).select('id, status').single();
  if (error) throw error;
  return data;
}

async function _defaultNotify({ title, message, /* data intentionally not appended */ onlyChannels = null }) {
  const notify = require('../services/notify');
  if (!notify.isConfigured || !notify.isConfigured()) {
    return {
      attempted: false, channels: {}, configured_channels: [],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: false,
      skipped: true, reason: 'notify_not_configured',
    };
  }
  // 8C-1: plain-text multi-channel with explicit per-channel delivery result.
  //       No Markdown / HTML parse_mode → immune to entity-parse errors on
  //       digest text containing underscores / brackets / asterisks.
  // 8C-2: onlyChannels filters delivery to a subset — used by channel-aware
  //       retry so a Telegram retry does not re-fire iMessage.
  return await notify.sendPlainMultiChannel(title, message, { onlyChannels });
}

/**
 * Accept either the legacy shape (`{ ok, result }`), `{ sent: true }`, or the
 * new full contract from `notify.sendPlainMultiChannel`. Coerce to a canonical
 * shape the audit block always understands.
 */
function _coerceNotificationResult(res) {
  if (res && typeof res === 'object' && 'channels' in res && 'attempted' in res) {
    // Full 8C-1 contract — pass through
    return res;
  }
  // Legacy fallback (injected test notifiers, etc.)
  const attempted = !(res && res.skipped);
  if (res && res.skipped) {
    return {
      attempted: false, channels: {}, configured_channels: [],
      all_succeeded: false, any_succeeded: false, partial_failure: false, total_failure: false,
      skipped: true, reason: res.reason || 'skipped',
    };
  }
  const ok = res && (res.ok === true || res.sent === true);
  return {
    attempted,
    channels: {},
    configured_channels: [],
    all_succeeded: !!ok,
    any_succeeded: !!ok,
    partial_failure: false,
    total_failure: attempted && !ok,
    legacy_shape: true,
  };
}

module.exports = {
  AUTOMATION_TYPE,
  runInventoryExceptionsDaily,
  _defaults: { _defaultFetchPrior, _defaultInsertAudit, _defaultNotify, _defaultConfiguredChannels },
};
