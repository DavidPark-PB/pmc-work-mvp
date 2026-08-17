/**
 * src/services/telegramGateway.js — P0 incident response (2026-08-17).
 *
 * CENTRAL kill switch + hard limits + idempotency for ALL Telegram outbound.
 *
 * ROOT CAUSE (2026-08-17 mass send incident): the base `telegramBot.js` calls
 * `fetch(...)` directly from many independent code paths (jobs, agents,
 * services, hermes chunked reports, webhook handler). NO per-process cap,
 * NO idempotency, NO env kill switch, NO cross-instance guard.
 *
 * This gateway wraps every outbound send. Base `telegramBot.js` MUST route
 * through this file — direct `fetch` to Telegram from other modules is
 * forbidden going forward.
 *
 * ── Kill order (any one triggers full block) ──
 *   TELEGRAM_KILL_SWITCH=true
 *   DISABLE_TELEGRAM_SEND=true
 *   TELEGRAM_DRY_RUN=true                     (block but records what would be sent)
 *   NODE_ENV != 'production' AND ALLOW_TELEGRAM_IN_DEV != 'true'
 *
 * ── Limits (defaults, tunable via env) ──
 *   MAX per single-run window (5 min, per jobName):    TELEGRAM_MAX_PER_RUN=5
 *   MAX per sliding hour (per jobName + chat pair):    TELEGRAM_MAX_PER_HOUR=10
 *   Aggregation threshold (aggregation helper):        TELEGRAM_BULK_THRESHOLD=5
 *   Idempotency window (identical (chat, text)):       TELEGRAM_IDEMPOTENCY_MS=900000  (15 min)
 *   Suppressed audit ring buffer size:                  TELEGRAM_SUPPRESSED_RING=200
 *
 * ── Suppressed sends ──
 *   Never dropped silently. Kept in a bounded in-memory ring buffer with
 *   {suppressedAt, reason, jobName, chatShort, textPreview} — token/chat_id
 *   never included in full. `getSuppressed()` exposes the buffer for
 *   inspection.
 */
'use strict';

const crypto = require('crypto');

// ─── Env parsing helpers ─────────────────────────────────
function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : def;
}
function envBool(name) { return process.env[name] === 'true'; }

function cfg() {
  return {
    maxPerRun:              envInt('TELEGRAM_MAX_PER_RUN', 5),
    maxPerHour:             envInt('TELEGRAM_MAX_PER_HOUR', 10),
    bulkThreshold:          envInt('TELEGRAM_BULK_THRESHOLD', 5),
    idempotencyMs:          envInt('TELEGRAM_IDEMPOTENCY_MS', 15 * 60 * 1000),
    runWindowMs:            envInt('TELEGRAM_RUN_WINDOW_MS', 5 * 60 * 1000),
    suppressedRingSize:     envInt('TELEGRAM_SUPPRESSED_RING', 200),
    killSwitch:             envBool('TELEGRAM_KILL_SWITCH') || envBool('DISABLE_TELEGRAM_SEND'),
    dryRun:                 envBool('TELEGRAM_DRY_RUN'),
    isProduction:           process.env.NODE_ENV === 'production',
    allowInDev:             envBool('ALLOW_TELEGRAM_IN_DEV'),
  };
}

// ─── In-memory state (per process) ───────────────────────
let state = _freshState();

function _freshState() {
  return {
    runCounters:      new Map(),   // jobName → { count, firstSeenAt, lastSeenAt }
    hourlyWindows:    new Map(),   // `${jobName}::${chatShort}` → number[] (sent-timestamps)
    idempotency:      new Map(),   // fingerprint → sentAt
    suppressed:       [],          // ring buffer
    stats:            { sent: 0, suppressed_kill_switch: 0, suppressed_non_prod: 0, suppressed_dry_run: 0, suppressed_per_run: 0, suppressed_per_hour: 0, suppressed_idempotent: 0 },
  };
}

// ─── Public: kill / audit / test hooks ───────────────────

/**
 * Report whether sends are currently BLOCKED and why. Never leaks token/chat_id.
 */
function isBlocked() {
  const c = cfg();
  if (c.killSwitch) return { blocked: true, reason: 'kill_switch' };
  if (c.dryRun) return { blocked: true, reason: 'dry_run' };
  if (!c.isProduction && !c.allowInDev) return { blocked: true, reason: 'non_production' };
  return { blocked: false, reason: null };
}

function getSuppressed() { return [...state.suppressed]; }
function getStats() { return { ...state.stats, cfg: cfg() }; }

/**
 * Tests / init only. Never call at runtime; the state is per-process design.
 */
function _resetForTest() { state = _freshState(); }

// ─── Central send guard ──────────────────────────────────

/**
 * Guarded send. `rawSendFn` is the low-level Telegram fetch call that
 * `telegramBot.js` provides — the gateway decides whether to invoke it.
 *
 * @param {Object} args
 * @param {string} args.text                     the message body (raw)
 * @param {string} [args.jobName='unknown']      logical job / caller name
 * @param {string} [args.chatIdShort='chat']     short opaque token identifying the destination chat (NEVER the full chat_id)
 * @param {Function} args.rawSendFn              async () => transport result
 * @returns {Promise<{ok, sent, suppressed, reason?, transport?}>}
 */
async function guardedSend({ text, jobName = 'unknown', chatIdShort = 'chat', rawSendFn } = {}) {
  const c = cfg();
  const now = Date.now();
  const textStr = String(text || '');
  const preview = textStr.slice(0, 60).replace(/[\r\n]+/g, ' ');
  const fingerprint = crypto.createHash('sha256').update(String(chatIdShort) + '::' + textStr).digest('hex').slice(0, 32);

  // 1) Global kill / dev block / dry-run
  if (c.killSwitch) return _suppress({ reason: 'kill_switch', jobName, chatIdShort, preview, fingerprint });
  if (c.dryRun) return _suppress({ reason: 'dry_run', jobName, chatIdShort, preview, fingerprint });
  if (!c.isProduction && !c.allowInDev) return _suppress({ reason: 'non_production', jobName, chatIdShort, preview, fingerprint });

  // 2) Idempotency (same (chatShort, text) within window)
  const seenAt = state.idempotency.get(fingerprint);
  if (seenAt && (now - seenAt) < c.idempotencyMs) {
    return _suppress({ reason: 'idempotent', jobName, chatIdShort, preview, fingerprint });
  }

  // 3) Per-run counter (5-minute rolling window per jobName)
  const rc = state.runCounters.get(jobName);
  const runOk = !rc || (now - rc.firstSeenAt) > c.runWindowMs || rc.count < c.maxPerRun;
  if (!runOk) {
    return _suppress({ reason: 'per_run_limit', jobName, chatIdShort, preview, fingerprint });
  }

  // 4) Per-hour per (job, chat) sliding window
  const hourKey = `${jobName}::${chatIdShort}`;
  const window = (state.hourlyWindows.get(hourKey) || []).filter(t => now - t < 3600_000);
  if (window.length >= c.maxPerHour) {
    state.hourlyWindows.set(hourKey, window);   // keep pruned copy
    return _suppress({ reason: 'per_hour_limit', jobName, chatIdShort, preview, fingerprint });
  }

  // 5) Everything ok → invoke transport
  let transport;
  try {
    transport = await rawSendFn();
  } catch (e) {
    return _suppress({ reason: 'transport_error', jobName, chatIdShort, preview, fingerprint, error: e && e.message ? e.message : String(e) });
  }

  // 6) Record success
  state.stats.sent++;
  state.idempotency.set(fingerprint, now);
  window.push(now);
  state.hourlyWindows.set(hourKey, window);
  if (!rc || (now - rc.firstSeenAt) > c.runWindowMs) {
    state.runCounters.set(jobName, { count: 1, firstSeenAt: now, lastSeenAt: now });
  } else {
    rc.count++;
    rc.lastSeenAt = now;
    state.runCounters.set(jobName, rc);
  }

  return { ok: true, sent: true, suppressed: false, transport };
}

function _suppress({ reason, jobName, chatIdShort, preview, fingerprint, error }) {
  const key = 'suppressed_' + reason;
  state.stats[key] = (state.stats[key] || 0) + 1;
  const entry = { suppressed_at: new Date().toISOString(), reason, job_name: jobName, chat_short: chatIdShort, text_preview: preview, fingerprint };
  if (error) entry.error = error;
  state.suppressed.push(entry);
  const cap = cfg().suppressedRingSize;
  if (state.suppressed.length > cap) state.suppressed.splice(0, state.suppressed.length - cap);
  return { ok: false, sent: false, suppressed: true, reason, error };
}

// ─── Bulk aggregation helper (5+ items → 1 summary) ─────

/**
 * Aggregate bulk items into ONE summary message instead of N individual sends.
 * Owner incident-response mandate: any loop iterating >= bulkThreshold items
 * MUST use this helper, not per-item sendMessage.
 *
 * @param {Object} args
 * @param {string} args.jobName
 * @param {Array}  args.items
 * @param {(item, i) => string} args.formatLine   one-liner formatter
 * @param {string} [args.header]                  header line
 * @param {number} [args.maxRendered=20]          how many lines to include in the summary (rest counted)
 * @param {Function} args.sendFn                  async (text) → guardedSend result
 * @returns {Promise<{aggregated, itemCount, sent}>}
 */
async function sendBulkAggregated({ jobName, items, formatLine, header = '', maxRendered = 20, sendFn } = {}) {
  const list = Array.isArray(items) ? items : [];
  const c = cfg();
  const threshold = c.bulkThreshold;
  if (list.length === 0) return { aggregated: false, itemCount: 0, sent: false };
  if (list.length < threshold) {
    // Below aggregation threshold — caller may send individually. We still cap
    // via the per-run limit downstream.
    return { aggregated: false, itemCount: list.length, sent: false };
  }
  const rendered = list.slice(0, maxRendered).map((it, i) => formatLine(it, i)).join('\n');
  const overflow = list.length > maxRendered ? `\n… (+${list.length - maxRendered} more suppressed)` : '';
  const text = (header ? header + '\n\n' : '') + rendered + overflow;
  const result = await sendFn(text);
  return { aggregated: true, itemCount: list.length, sent: !!result?.sent };
}

module.exports = {
  guardedSend,
  sendBulkAggregated,
  isBlocked,
  getSuppressed,
  getStats,
  _resetForTest,
  _internals: { cfg },
};
