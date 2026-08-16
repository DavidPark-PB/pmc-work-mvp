/**
 * src/services/oms/inventoryExceptionsAlerter.js — Phase 8C · pure.
 *
 * Diffs current inventory-exception-queue result against the last successful
 * daily-run state and decides whether to notify. Never sends anything itself
 * (Owner §3: default READ-ONLY). Never recomputes upstream business logic.
 *
 * Owner rules:
 *   - SELL_NORMALLY only  → no alert (queue empty → no notification)
 *   - New WATCH / REPLENISH / PROTECT_STOCK physical(s) → alert
 *   - Status escalation on existing physical → alert  (WATCH → REPLENISH → PROTECT_STOCK)
 *   - Same set with same statuses → no alert (dedup)
 *   - INSUFFICIENT_DATA is a separate class — DEFAULT NOT alerted (Owner §6)
 *   - Resolved / de-escalated exceptions are informational, DEFAULT NOT alerted
 */
'use strict';

const crypto = require('crypto');

const SEVERITY_ORDER = { WATCH: 1, REPLENISH: 2, PROTECT_STOCK: 3 };
const ACTION_STATUSES = new Set(['WATCH', 'REPLENISH', 'PROTECT_STOCK']);

/**
 * @param {Object} args
 * @param {Object} args.currentResult   buildInventoryExceptionQueue output
 * @param {Object|null} args.priorState prior audit snapshot (or null on first run)
 *        Shape: { fingerprint, action_summary: [{physical_product_id, decision_status, priority_score, title}] }
 * @param {boolean} [args.alertDataQuality=false]
 * @param {boolean} [args.alertResolved=false]
 */
function computeAlertPlan({ currentResult, priorState = null, alertDataQuality = false, alertResolved = false } = {}) {
  const currentAction = _extractActionSummary(currentResult.action_queue || []);
  const currentDataQ = _extractDataQualityIds(currentResult.data_quality_queue || []);
  const fingerprint = _fingerprint(currentAction);

  const priorAction = _asArray(priorState?.action_summary);
  const priorDataQ = _asArray(priorState?.data_quality_ids);
  const priorFingerprint = priorState?.fingerprint || null;

  const priorMap = new Map(priorAction.map(r => [r.physical_product_id, r]));
  const currentMap = new Map(currentAction.map(r => [r.physical_product_id, r]));

  const newPhysicals = [];
  const escalated = [];
  const resolved = [];
  const deescalated = [];

  for (const cur of currentAction) {
    const prior = priorMap.get(cur.physical_product_id);
    if (!prior) {
      newPhysicals.push({ ...cur, kind: 'new' });
      continue;
    }
    const priorSev = SEVERITY_ORDER[prior.decision_status] ?? 0;
    const curSev = SEVERITY_ORDER[cur.decision_status] ?? 0;
    if (curSev > priorSev) {
      escalated.push({
        physical_product_id: cur.physical_product_id, title: cur.title,
        prior_status: prior.decision_status, current_status: cur.decision_status,
        prior_score: prior.priority_score, current_score: cur.priority_score,
      });
    } else if (curSev < priorSev) {
      deescalated.push({
        physical_product_id: cur.physical_product_id, title: cur.title,
        prior_status: prior.decision_status, current_status: cur.decision_status,
      });
    }
  }
  for (const prior of priorAction) {
    if (!currentMap.has(prior.physical_product_id)) {
      resolved.push({ physical_product_id: prior.physical_product_id, title: prior.title, prior_status: prior.decision_status });
    }
  }

  const dqPriorSet = new Set(priorDataQ);
  const dqCurrentSet = new Set(currentDataQ);
  const dataQualityNew = currentDataQ.filter(id => !dqPriorSet.has(id));
  const dataQualityResolved = priorDataQ.filter(id => !dqCurrentSet.has(id));

  // Alert decision
  const reasonCodes = [];
  let shouldAlert = false;
  let alertKind;
  if (priorState == null) {
    alertKind = 'first_run';
    if (currentAction.length > 0) { shouldAlert = true; reasonCodes.push('first_run_with_exceptions'); }
    else reasonCodes.push('first_run_no_exceptions');
  } else if (priorFingerprint === fingerprint) {
    alertKind = 'no_change';
    reasonCodes.push('fingerprint_unchanged');
  } else {
    if (newPhysicals.length > 0) { shouldAlert = true; reasonCodes.push(`new_exceptions_${newPhysicals.length}`); }
    if (escalated.length > 0) { shouldAlert = true; reasonCodes.push(`escalations_${escalated.length}`); }
    if (alertResolved && resolved.length > 0) { shouldAlert = true; reasonCodes.push(`resolved_${resolved.length}`); }
    if (!shouldAlert) reasonCodes.push('fingerprint_changed_but_no_alertable_diff');
    alertKind = _classifyAlertKind({ newPhysicals, escalated, resolved, deescalated });
  }

  if (alertDataQuality && dataQualityNew.length > 0) {
    shouldAlert = true;
    reasonCodes.push(`data_quality_new_${dataQualityNew.length}`);
  }

  const digest = _buildDigest({
    currentResult, newPhysicals, escalated, resolved, deescalated,
    dataQualityNew, dataQualityResolved, alertDataQuality, alertResolved,
    shouldAlert, alertKind,
  });

  return {
    fingerprint,
    prior_fingerprint: priorFingerprint,
    should_alert: shouldAlert,
    alert_kind: alertKind,
    new_physicals: newPhysicals,
    escalated,
    resolved,                       // exposed but not necessarily notified
    deescalated,                    // exposed but not notified
    data_quality_new: dataQualityNew,
    data_quality_resolved: dataQualityResolved,
    action_summary: currentAction,
    data_quality_ids: currentDataQ,
    digest_text: digest.text,
    digest_title: digest.title,
    reason_codes: reasonCodes,
  };
}

// ─── helpers ─────────────────────────────────────────────

function _extractActionSummary(actionQueue) {
  return actionQueue
    .filter(r => ACTION_STATUSES.has(r.decision_status))
    .map(r => ({
      physical_product_id: r.physical_product_id,
      decision_status: r.decision_status,
      priority_score: r.priority_score,
      title: r.title || null,
    }))
    .sort((a, b) => a.physical_product_id - b.physical_product_id);
}
function _extractDataQualityIds(dq) {
  return (dq || []).map(r => r.physical_product_id).sort((a, b) => a - b);
}
function _asArray(v) { return Array.isArray(v) ? v : []; }

function _fingerprint(actionSummary) {
  const canonical = JSON.stringify(actionSummary.map(r => [r.physical_product_id, r.decision_status, r.priority_score]));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function _classifyAlertKind({ newPhysicals, escalated, resolved, deescalated }) {
  const parts = [];
  if (newPhysicals.length) parts.push('new');
  if (escalated.length) parts.push('escalation');
  if (resolved.length) parts.push('resolved');
  if (deescalated.length) parts.push('deescalation');
  if (parts.length === 0) return 'no_alertable_change';
  if (parts.length === 1) return parts[0];
  return 'multiple';
}

function _buildDigest({ currentResult, newPhysicals, escalated, resolved, deescalated,
                       dataQualityNew, dataQualityResolved, alertDataQuality, alertResolved,
                       shouldAlert, alertKind }) {
  const s = currentResult.summary || {};
  const title = shouldAlert
    ? `[OMS] Inventory exceptions (${alertKind}) · WATCH=${s.watch_count ?? 0} REPLENISH=${s.replenish_count ?? 0} PROTECT_STOCK=${s.protect_stock_count ?? 0}`
    : `[OMS] Inventory exceptions unchanged (${alertKind})`;
  const lines = [];
  lines.push(`assessed=${s.physical_products_assessed ?? '?'} · sell_normally=${s.sell_normally_count ?? 0}`);
  lines.push(`action_exceptions=${s.action_exception_count ?? 0} · data_quality=${s.data_quality_count ?? 0}`);
  if (newPhysicals.length) {
    lines.push('');
    lines.push('NEW exceptions:');
    for (const n of newPhysicals.slice(0, 10)) {
      lines.push(`  · #${n.physical_product_id} [${n.decision_status} · ${n.priority_score}] ${n.title ?? ''}`);
    }
    if (newPhysicals.length > 10) lines.push(`  · … +${newPhysicals.length - 10} more`);
  }
  if (escalated.length) {
    lines.push('');
    lines.push('ESCALATED:');
    for (const e of escalated.slice(0, 10)) {
      lines.push(`  · #${e.physical_product_id} ${e.prior_status}→${e.current_status} (${e.prior_score}→${e.current_score}) ${e.title ?? ''}`);
    }
    if (escalated.length > 10) lines.push(`  · … +${escalated.length - 10} more`);
  }
  if (alertResolved && resolved.length) {
    lines.push('');
    lines.push('RESOLVED (informational):');
    for (const r of resolved.slice(0, 5)) lines.push(`  · #${r.physical_product_id} was ${r.prior_status} · ${r.title ?? ''}`);
  }
  if (alertDataQuality && dataQualityNew.length) {
    lines.push('');
    lines.push(`Data-quality NEW: ${dataQualityNew.length} physicals — inspect separately.`);
  }
  return { title, text: lines.join('\n') };
}

// ─── 8C-2: channel-aware delivery plan ─────────────────
/**
 * Distinct from computeAlertPlan (business change). This layer answers:
 *   "for the CURRENT fingerprint, which configured channels still need
 *    delivery given prior successful/failed attempts?"
 *
 * @param {Object} args
 * @param {string} args.currentFingerprint
 * @param {Object|null} args.priorState               fetchPrior return
 * @param {string[]} args.configuredChannels          from notify.getConfiguredChannels()
 * @param {string[]} [args.forceChannels=[]]          Owner-explicit one-shot
 * @param {boolean} args.shouldAlert                  from computeAlertPlan
 */
function computeDeliveryPlan({ currentFingerprint, priorState = null, configuredChannels = [], forceChannels = [], shouldAlert = false } = {}) {
  const priorFp = priorState?.fingerprint || null;
  const fingerprintUnchanged = priorFp != null && priorFp === currentFingerprint;

  const configuredSet = new Set(configuredChannels);
  const forceNorm = (forceChannels || []).filter(ch => configuredSet.has(ch));

  // Derive prior delivery state from most-specific source.
  //   1. Post-8C-2-hotfix rows: output_snapshot.confirmed_satisfied_channels
  //      AND output_snapshot.assumed_satisfied_channels (split by authority)
  //   2. Post-8C-2 rows: output_snapshot.effective_satisfied_channels
  //      (single list · treat as confirmed for backward compat)
  //   3. Post-8C-1 rows: output_snapshot.notification.channels[*].sent
  //      (explicit per-channel breakdown · confirmed)
  //   4. Legacy pre-8C-1 rows / minimal shape: no channel breakdown available.
  //      Safe default = ASSUME every configured channel satisfied on
  //      fingerprint match, so a real subsequent success does not duplicate.
  //      Assumed state is LOWER AUTHORITY than any subsequent actual delivery
  //      result — that override happens in the orchestrator.
  //
  // Two-tier authority the orchestrator later uses to enforce Owner rule #5:
  //   confirmed_satisfied_channels_prior — explicit sent=true evidence
  //   assumed_satisfied_channels_prior   — legacy fingerprint-match guess
  let confirmedPrior = [];
  let assumedPrior = [];
  let priorChannelState = null;
  let legacy_prior_note = null;
  if (!fingerprintUnchanged) {
    if (priorState) legacy_prior_note = 'fingerprint_changed_prior_state_ignored';
  } else if (priorState) {
    const notif = priorState.notification || null;
    const hasRecentRuns = Array.isArray(priorState.recent_runs_same_fingerprint);
    const hasSplit = Array.isArray(priorState.confirmed_satisfied_channels) || Array.isArray(priorState.assumed_satisfied_channels);
    if (hasRecentRuns) {
      // 8C-2b: reconstruct from history chronologically. Highest fidelity —
      //        avoids trusting a single corrupted derived snapshot.
      const derived = deriveEffectiveDeliveryStateFromRuns(priorState.recent_runs_same_fingerprint, configuredChannels);
      confirmedPrior = derived.confirmed_satisfied_channels;
      assumedPrior = derived.assumed_satisfied_channels;
      priorChannelState = notif ? (notif.channels || null) : null;
      legacy_prior_note = `reconstructed_from_history_${derived.runs_processed}_runs`;
    } else if (hasSplit) {
      confirmedPrior = Array.isArray(priorState.confirmed_satisfied_channels) ? [...priorState.confirmed_satisfied_channels] : [];
      assumedPrior = Array.isArray(priorState.assumed_satisfied_channels) ? [...priorState.assumed_satisfied_channels] : [];
      priorChannelState = notif ? (notif.channels || null) : null;
    } else if (notif && notif.channels && Object.keys(notif.channels).length > 0) {
      priorChannelState = notif.channels;
      confirmedPrior = Object.entries(notif.channels).filter(([, c]) => c.sent === true).map(([n]) => n);
      // 8C-2b · when the row ALSO carries legacy effective_satisfied_channels
      // (a hotfix1-shaped snapshot that included inherited assumptions),
      // channels NOT attempted in this row inherit as ASSUMED. Owner rule #3
      // keeps them lower authority than an actual attempt result.
      if (Array.isArray(priorState.effective_satisfied_channels)) {
        for (const ch of priorState.effective_satisfied_channels) {
          if (confirmedPrior.includes(ch)) continue;
          const c = notif.channels[ch];
          if (!c || c.attempted !== true) {
            if (!assumedPrior.includes(ch)) assumedPrior.push(ch);
          }
        }
      }
    } else if (Array.isArray(priorState.effective_satisfied_channels)) {
      // 8C-2b · Owner rule #3: legacy derived effective_satisfied_channels is
      // LOWER AUTHORITY. A single corrupted pre-hotfix row must not spoof
      // confirmed status. Treat as ASSUMED — an actual retry can still
      // override it.
      assumedPrior = [...priorState.effective_satisfied_channels];
      legacy_prior_note = 'legacy_effective_satisfied_treated_as_assumed';
    } else {
      // No channel breakdown available for this fingerprint → assume every
      // configured channel is already satisfied. LOWER AUTHORITY — any
      // subsequent real attempt overrides. Owner can `--force-channel` to
      // explicitly retry.
      assumedPrior = [...configuredChannels];
      legacy_prior_note = notif
        ? 'legacy_prior_assumed_all_satisfied_no_channel_breakdown'
        : 'legacy_prior_assumed_all_satisfied_no_notification_metadata';
    }
  }
  const satisfiedPriorSet = new Set([...confirmedPrior, ...assumedPrior]);
  const satisfiedPrior = [...satisfiedPriorSet];

  const unresolvedChannels = configuredChannels.filter(ch => !satisfiedPrior.includes(ch));
  const pendingChannels = forceNorm.length > 0
    ? [...forceNorm]
    : unresolvedChannels;

  let shouldDeliverTo; let retryKind;
  if (forceNorm.length > 0) {
    shouldDeliverTo = forceNorm;
    retryKind = 'force';
  } else if (shouldAlert) {
    // Business change · new content · send to ALL configured
    shouldDeliverTo = [...configuredChannels];
    retryKind = priorFp == null ? 'first_run' : (fingerprintUnchanged ? 'business_change_same_fp' : 'business_change');
  } else if (fingerprintUnchanged && unresolvedChannels.length > 0) {
    shouldDeliverTo = [...unresolvedChannels];
    retryKind = 'channel_retry';
  } else {
    shouldDeliverTo = [];
    retryKind = fingerprintUnchanged ? 'satisfied' : 'no_alert';
  }

  return {
    fingerprint_unchanged: fingerprintUnchanged,
    prior_fingerprint: priorFp,
    prior_channels: priorChannelState,
    satisfied_channels_prior: satisfiedPrior,
    confirmed_satisfied_channels_prior: confirmedPrior,
    assumed_satisfied_channels_prior: assumedPrior,
    unresolved_channels: unresolvedChannels,
    pending_channels: pendingChannels,
    should_deliver_to: shouldDeliverTo,
    retry_kind: retryKind,
    force_channels_requested: forceNorm,
    legacy_prior_note,
    configured_channels: [...configuredChannels],
  };
}

// ─── 8C-2b: historical delivery-state reconstruction ────
/**
 * Reconstruct effective per-channel delivery state for a specific fingerprint
 * by walking automation_runs oldest → newest.
 *
 * Authority order (highest first):
 *   1. THIS row's notification.channels[ch] actual attempt result
 *        attempted=true && sent=true   → CONFIRMED (overrides any prior state)
 *        attempted=true && sent=false  → REMOVES from confirmed/assumed
 *        attempted=false               → preserves state accumulated so far
 *   2. THIS row's explicit v2 split fields
 *        confirmed_satisfied_channels / assumed_satisfied_channels
 *        (used only when the row has no channel breakdown to override with;
 *         v2 rows have both a snapshot AND channels, so channels wins)
 *   3. Legacy derived field effective_satisfied_channels
 *        LOWER AUTHORITY — treated as ASSUMED, never CONFIRMED.
 *   4. Legacy positive indicator (notification.result.sent=true / ok=true) with
 *      no channel breakdown at all
 *        → mark every configured channel as ASSUMED
 *
 * Pure. No I/O. `runs` may be in any order — we sort by completed_at asc.
 */
function deriveEffectiveDeliveryStateFromRuns(runs, configuredChannels) {
  const cfgList = Array.isArray(configuredChannels) ? [...configuredChannels] : [];
  const cfgSet = new Set(cfgList);
  const confirmed = new Set();
  const assumed = new Set();

  const runsAsc = [...(runs || [])].sort((a, b) => String(a?.completed_at || '').localeCompare(String(b?.completed_at || '')));
  let versionSeen = 0;

  for (const run of runsAsc) {
    if (!run) continue;
    const snap = run.output_snapshot || {};
    // 8C-2c: production audit history uses inconsistent field names.
    //   `notification` (post-8C-1 orchestrator)
    //   `notified`     (older orchestrator variant — production row #423)
    // Recognize both when hunting for a legacy positive indicator so a real
    // legacy row seeds ASSUMED channels instead of being silently ignored.
    const notif = snap.notification || snap.notified || null;
    const version = Number(snap.delivery_state_version || 0) || 0;
    if (version > versionSeen) versionSeen = version;

    const hasChanBreakdown = !!(notif && notif.channels && Object.keys(notif.channels).length > 0);
    const hasV2Split = version >= 2
      && (Array.isArray(snap.confirmed_satisfied_channels) || Array.isArray(snap.assumed_satisfied_channels));
    const hasLegacyEffective = Array.isArray(snap.effective_satisfied_channels);
    // 8C-2c: broadened legacy-positive detection. Any of these shapes means
    // "delivery succeeded at some coarse level" and must seed ASSUMED so we
    // don't duplicate — but NEVER CONFIRMED (Owner rule #3).
    const legacyPositive = !!(notif && (
      notif.ok === true
      || notif.sent === true
      || notif.all_succeeded === true
      || (notif.result && (notif.result.sent === true || notif.result.ok === true))
    ));

    // Seed from v2 snapshot (only if this row has no channel breakdown to
    // refine with — otherwise channels win)
    if (hasV2Split && !hasChanBreakdown) {
      const conf = new Set(snap.confirmed_satisfied_channels || []);
      const asum = new Set(snap.assumed_satisfied_channels || []);
      for (const ch of cfgList) {
        if (conf.has(ch)) { confirmed.add(ch); assumed.delete(ch); }
        else if (asum.has(ch)) { if (!confirmed.has(ch)) assumed.add(ch); }
      }
    } else if (hasV2Split && hasChanBreakdown) {
      // v2 row with channels: adopt snapshot for channels NOT attempted this row
      const conf = new Set(snap.confirmed_satisfied_channels || []);
      const asum = new Set(snap.assumed_satisfied_channels || []);
      for (const ch of cfgList) {
        const c = notif.channels[ch] || null;
        if (c && c.attempted === true) continue; // will be handled below by attempt loop
        if (conf.has(ch)) { confirmed.add(ch); assumed.delete(ch); }
        else if (asum.has(ch)) { if (!confirmed.has(ch)) assumed.add(ch); }
      }
    }

    // Apply per-channel actual attempt results (highest authority)
    if (hasChanBreakdown) {
      for (const [ch, c] of Object.entries(notif.channels)) {
        if (!cfgSet.has(ch) || !c) continue;
        const attempted = c.attempted === true;
        const sent = c.sent === true;
        if (attempted && sent) { confirmed.add(ch); assumed.delete(ch); }
        else if (attempted && !sent) { confirmed.delete(ch); assumed.delete(ch); }
        // attempted=false → preserve current state for that channel
      }
    }

    // Legacy fallbacks — only fire when the row provided NO higher-authority
    // evidence for a channel this iteration.
    if (!hasChanBreakdown && !hasV2Split) {
      if (hasLegacyEffective) {
        // Owner rule #3 — treat as ASSUMED, not CONFIRMED
        for (const ch of snap.effective_satisfied_channels) {
          if (cfgSet.has(ch) && !confirmed.has(ch)) assumed.add(ch);
        }
      } else if (legacyPositive) {
        for (const ch of cfgList) {
          if (!confirmed.has(ch)) assumed.add(ch);
        }
      }
    }
  }

  const confirmedList = cfgList.filter(ch => confirmed.has(ch));
  const assumedList = cfgList.filter(ch => assumed.has(ch) && !confirmed.has(ch));
  const satisfiedSet = new Set([...confirmedList, ...assumedList]);
  const unresolvedList = cfgList.filter(ch => !satisfiedSet.has(ch));

  return {
    confirmed_satisfied_channels: confirmedList,
    assumed_satisfied_channels: assumedList,
    effective_satisfied_channels: [...satisfiedSet],
    effective_unresolved_channels: unresolvedList,
    all_required_channels_satisfied: cfgList.length > 0 && unresolvedList.length === 0,
    runs_processed: runsAsc.length,
    last_known_delivery_state_version: versionSeen,
  };
}

module.exports = {
  computeAlertPlan,
  computeDeliveryPlan,                       // 8C-2
  deriveEffectiveDeliveryStateFromRuns,      // 8C-2b
  _internals: { _fingerprint, _extractActionSummary, _classifyAlertKind, _buildDigest, SEVERITY_ORDER, ACTION_STATUSES },
};
