'use strict';

/**
 * ingestionStateService.js — Phase 8P-20.
 *
 * Read/write helper for the `ingestion_state` table (migration 096).
 * Never throws for missing table — falls back to safe defaults so
 * dev/test environments without the migration applied still work.
 *
 * Zero direct writes to any other table. Ingestors call:
 *   • getIngestionState(channel)         → { status, last_success_at, last_cursor, cadence_minutes, overlap_minutes }
 *   • recordAttempt({channel, ok, err, cursor, windowStart, windowEnd})
 *   • recordAuthFailure({channel, err})   → sets status='auth_failed', alerts Owner via error log
 *
 * Cadence + overlap defaults (owner-tunable via DB row):
 *   ebay    · 10 min · 15 min overlap
 *   shopify ·  5 min · 20 min overlap
 *   naver   · 10 min · 30 min overlap
 *   coupang · 10 min · 30 min overlap
 *   qoo10   · 15 min · 60 min overlap
 *   shopee  · 10 min · 30 min overlap
 */

const { getClient } = require('../../db/supabaseClient');

const DEFAULT_CADENCE = Object.freeze({
  ebay:    { cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7 },
  shopify: { cadence_minutes:  5, overlap_minutes: 20, default_lookback_days: 3 },
  naver:   { cadence_minutes: 10, overlap_minutes: 30, default_lookback_days: 3 },
  coupang: { cadence_minutes: 10, overlap_minutes: 30, default_lookback_days: 3 },
  qoo10:   { cadence_minutes: 15, overlap_minutes: 60, default_lookback_days: 3 },
  shopee:  { cadence_minutes: 10, overlap_minutes: 30, default_lookback_days: 3 },
});

const KNOWN_STATUSES = Object.freeze(['healthy', 'stale', 'auth_failed', 'disabled']);

/**
 * Get ingestion state for a channel. Returns defaults if row absent
 * (migration 096 not yet applied · dev/test).
 */
async function getIngestionState(channel) {
  if (!channel) throw new Error('ingestionStateService.getIngestionState: channel required');
  const defaults = DEFAULT_CADENCE[channel] || { cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 3 };
  const db = getClient();
  try {
    const { data, error } = await db.from('ingestion_state').select('*').eq('channel', channel).maybeSingle();
    if (error && !_isMissingTableError(error)) throw error;
    if (!data) return { channel, status: 'healthy', last_success_at: null, last_attempt_at: null, last_error: null, last_cursor: null, consecutive_failures: 0, ...defaults };
    return { ...defaults, ...data };
  } catch (e) {
    if (_isMissingTableError(e)) return { channel, status: 'healthy', last_success_at: null, last_attempt_at: null, last_error: null, last_cursor: null, consecutive_failures: 0, ...defaults };
    throw e;
  }
}

/**
 * Compute the next ingestion window [fetch_from, fetch_to] using
 * last_cursor − overlap_window (or now − default_lookback if no cursor).
 */
function computeIngestionWindow(state, nowMs = Date.now()) {
  const cadence = DEFAULT_CADENCE[state.channel] || { cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 3 };
  const overlapMs = (state.overlap_minutes ?? cadence.overlap_minutes) * 60_000;
  const defaultLookbackMs = cadence.default_lookback_days * 86_400_000;
  const cursorMs = state.last_cursor ? new Date(state.last_cursor).getTime() : (nowMs - defaultLookbackMs);
  const fromMs = Math.min(cursorMs - overlapMs, nowMs - overlapMs);
  return {
    fetch_from_iso: new Date(Math.max(0, fromMs)).toISOString(),
    fetch_to_iso: new Date(nowMs).toISOString(),
    from_ms: fromMs,
    to_ms: nowMs,
  };
}

/**
 * Record an ingestion attempt. On ok=true advances last_cursor + resets
 * consecutive_failures. On ok=false increments consecutive_failures and
 * (if >= 3) transitions to 'stale' status. Also writes an error-log row.
 */
async function recordAttempt({ channel, ok, err = null, cursor = null, windowStart = null, windowEnd = null, errorClass = null, httpStatus = null }) {
  if (!channel) throw new Error('ingestionStateService.recordAttempt: channel required');
  const db = getClient();
  const now = new Date().toISOString();
  try {
    const existing = await db.from('ingestion_state').select('consecutive_failures, status').eq('channel', channel).maybeSingle();
    const prev = existing.data || { consecutive_failures: 0, status: 'healthy' };
    let nextStatus = prev.status || 'healthy';
    let nextFailures = ok ? 0 : (prev.consecutive_failures || 0) + 1;
    if (ok) nextStatus = 'healthy';
    else if (nextFailures >= 3 && nextStatus !== 'auth_failed' && nextStatus !== 'disabled') nextStatus = 'stale';

    const patch = {
      channel,
      status: nextStatus,
      last_attempt_at: now,
      consecutive_failures: nextFailures,
      updated_at: now,
    };
    if (ok) {
      patch.last_success_at = now;
      patch.last_error = null;
      if (cursor) patch.last_cursor = cursor;
    } else {
      patch.last_error = _safeMsg(err);
    }
    const up = await db.from('ingestion_state').upsert(patch, { onConflict: 'channel' });
    if (up.error && !_isMissingTableError(up.error)) throw up.error;

    if (!ok) {
      await db.from('ingestion_error_log').insert({
        channel, attempted_at: now, error_class: errorClass || 'unknown', error_message: _safeMsg(err),
        http_status: httpStatus, window_start: windowStart, window_end: windowEnd, consecutive_failure_count: nextFailures,
      }).then(r => { if (r.error && !_isMissingTableError(r.error)) throw r.error; });
    }
  } catch (e) {
    if (_isMissingTableError(e)) return;
    throw e;
  }
}

/**
 * Immediate auth-failure transition. Different from recordAttempt(ok=false)
 * because auth failures should not increment retry counters (retry won't help).
 */
async function recordAuthFailure({ channel, err }) {
  const db = getClient();
  const now = new Date().toISOString();
  try {
    await db.from('ingestion_state').upsert({
      channel, status: 'auth_failed', last_attempt_at: now,
      last_error: _safeMsg(err), consecutive_failures: 999, updated_at: now,
    }, { onConflict: 'channel' }).then(r => { if (r.error && !_isMissingTableError(r.error)) throw r.error; });
    await db.from('ingestion_error_log').insert({
      channel, attempted_at: now, error_class: 'auth_failed', error_message: _safeMsg(err),
    }).then(r => { if (r.error && !_isMissingTableError(r.error)) throw r.error; });
  } catch (e) {
    if (_isMissingTableError(e)) return;
    throw e;
  }
}

/**
 * List all channels with current freshness. Used by /admin freshness dashboard.
 */
async function listFreshness() {
  const db = getClient();
  try {
    const { data, error } = await db.from('ingestion_state').select('*').order('channel');
    if (error && !_isMissingTableError(error)) throw error;
    const rows = data || [];
    const now = Date.now();
    return rows.map(r => {
      const cadence = DEFAULT_CADENCE[r.channel] || { cadence_minutes: 10 };
      const lagMs = r.last_success_at ? now - new Date(r.last_success_at).getTime() : null;
      const lagMinutes = lagMs != null ? Math.round(lagMs / 60_000) : null;
      const staleThresholdMinutes = (r.cadence_minutes || cadence.cadence_minutes) * 3;
      const isStale = lagMinutes == null || lagMinutes > staleThresholdMinutes;
      return { ...r, lag_minutes: lagMinutes, stale_threshold_minutes: staleThresholdMinutes, is_stale: isStale };
    });
  } catch (e) {
    if (_isMissingTableError(e)) return [];
    throw e;
  }
}

//   ─── helpers ─────────────────────────────────

function _safeMsg(err) {
  if (err == null) return null;
  const m = err.message || String(err);
  return String(m).slice(0, 500);
}

function _isMissingTableError(err) {
  const msg = err && (err.message || err.hint || err.details || String(err));
  return typeof msg === 'string' && (/does not exist/i.test(msg) || /relation ".*" does not exist/i.test(msg) || err?.code === '42P01');
}

module.exports = {
  getIngestionState,
  computeIngestionWindow,
  recordAttempt,
  recordAuthFailure,
  listFreshness,
  DEFAULT_CADENCE,
  KNOWN_STATUSES,
};
