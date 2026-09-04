'use strict';

/**
 * schedulerLock.js — R1-A · Distributed lease primitive for background jobs.
 *
 * Owner Directive (2026-09-04) · Refactor R1-A.
 *
 * Purpose:
 *   Prevent duplicate execution of the same scheduler job across (a) rolling
 *   Railway deploys where old+new processes overlap for a window, (b) any
 *   future multi-instance topology, and (c) in-process overlap when a cron
 *   tick fires while a previous run of the same job is still executing.
 *
 * Design notes:
 *   · owner_id  = per-PROCESS identity (host + pid + boot uuid). Stable for
 *                 the lifetime of this Node process.
 *   · run_id    = per-INVOCATION identity (fresh UUID per withLease() call).
 *                 Two overlapping runs in the same process have DIFFERENT
 *                 run_ids and the second run's acquire is rejected.
 *   · Ownership fencing: heartbeat + release require (lock_key, owner_id,
 *                 run_id) all three to match. A stale runner whose lease was
 *                 taken over by another run cannot heartbeat or release the
 *                 winner's row.
 *   · Fail policy:
 *       - 'closed' (default): lock infra ERROR → fn NOT called. Money-facing
 *         jobs should always be closed. `acquired=false` (normal SKIP_LOCKED)
 *         is ALWAYS respected regardless of policy.
 *       - 'open': lock infra ERROR → fn called anyway with warning log.
 *         For pure notifications/reports where downtime is worse than a
 *         duplicate. `acquired=false` still skips.
 *   · Feature flag `SCHEDULER_LOCK_ENABLED=0` → pass-through mode. Emits
 *     LOCK_DISABLED log then runs fn without touching the DB. Kill switch
 *     for lease infrastructure emergencies.
 *
 * Not this module's job (R1-A):
 *   · Wiring into any specific scheduler. That's R1-B .. R1-E.
 *   · Cancelling a job when leaseLost=true. Arbitrary async jobs cannot be
 *     force-cancelled safely; withLease surfaces leaseLost via callback
 *     context (ctx.isLeaseLost()) and via the returned {leaseLost} flag.
 *     R1-B onward decides per-job how to react (money-facing jobs should
 *     poll ctx.isLeaseLost() at safe checkpoints and abort further writes).
 */

const crypto = require('crypto');
const os = require('os');
const { getClient } = require('../db/supabaseClient');

// ─── process identity (stable for lifetime of this Node process) ─────────
const OWNER_ID = [
  process.env.RAILWAY_DEPLOYMENT_ID
    || process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || os.hostname()
    || 'local',
  process.pid,
  crypto.randomUUID().slice(0, 8),
].join(':');

// ─── constants (must match migration 108 guards) ─────────────────────────
const MAX_TTL_SECONDS         = 86_400;
const DEFAULT_TTL_SECONDS     = 600;
const DEFAULT_HEARTBEAT_SEC   = 60;
const MIN_HEARTBEAT_SEC       = 1;

// ─── test hook: override the Supabase client for unit tests ──────────────
let _clientOverride = null;
function _setClientForTests(client) { _clientOverride = client; }
function _resetClientForTests()      { _clientOverride = null; }
function _getDb()                    { return _clientOverride || getClient(); }

// ─── structured single-line log ──────────────────────────────────────────
function _log(event, fields) {
  const parts = ['[LEASE]', `event=${event}`];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${v}`);
  }
  console.log(parts.join(' '));
}

// ─── RPC wrappers ────────────────────────────────────────────────────────
async function _acquire(lockKey, runId, ttlSec) {
  const db = _getDb();
  const { data, error } = await db.rpc('acquire_scheduler_lease', {
    p_lock_key:    lockKey,
    p_owner_id:    OWNER_ID,
    p_run_id:      runId,
    p_ttl_seconds: ttlSec,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('acquire_scheduler_lease returned empty result');
  return row;
}

async function _heartbeat(lockKey, runId, ttlSec) {
  const db = _getDb();
  const { data, error } = await db.rpc('heartbeat_scheduler_lease', {
    p_lock_key:    lockKey,
    p_owner_id:    OWNER_ID,
    p_run_id:      runId,
    p_ttl_seconds: ttlSec,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, expires_at: null };
  return row;
}

async function _release(lockKey, runId) {
  const db = _getDb();
  const { data, error } = await db.rpc('release_scheduler_lease', {
    p_lock_key: lockKey,
    p_owner_id: OWNER_ID,
    p_run_id:   runId,
  });
  if (error) throw error;
  return data === true;
}

// ─── public API ──────────────────────────────────────────────────────────

/**
 * Run `fn` under a distributed lease keyed by `lockKey`.
 *
 * @param {string} lockKey                 e.g. 'scheduler:repricing-pipeline'
 * @param {object} options
 * @param {number} [options.ttlSec=600]    lease TTL. Should be ≥ 2× worst
 *                                         expected runtime. Max 86400 (24h).
 * @param {number} [options.heartbeatSec=60]  heartbeat period. Must be > 0
 *                                            and < ttlSec.
 * @param {'closed'|'open'} [options.failPolicy='closed']
 *                                         behaviour when the acquire RPC
 *                                         itself throws (network/DB down).
 *                                         normal `acquired=false` is always
 *                                         respected regardless.
 * @param {Function} fn                    async function(ctx) => any
 *                                         ctx: { runId, isLeaseLost() }
 * @returns {Promise<{acquired:boolean, ran:boolean, leaseLost:boolean,
 *                    value?:any, error?:Error}>}
 */
async function withLease(lockKey, options, fn) {
  const opts         = options || {};
  const ttlSec       = Number.isFinite(opts.ttlSec)       ? opts.ttlSec       : DEFAULT_TTL_SECONDS;
  const heartbeatSec = Number.isFinite(opts.heartbeatSec) ? opts.heartbeatSec : DEFAULT_HEARTBEAT_SEC;
  const failPolicy   = opts.failPolicy === 'open' ? 'open' : 'closed';
  const runId        = crypto.randomUUID();

  // ── argument validation ───────────────────────────────────────────────
  if (!lockKey || typeof lockKey !== 'string') {
    throw new Error('schedulerLock.withLease: lockKey (non-empty string) required');
  }
  if (typeof fn !== 'function') {
    throw new Error('schedulerLock.withLease: fn (function) required');
  }
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new Error(`schedulerLock.withLease: ttlSec must be > 0 (got ${ttlSec})`);
  }
  if (ttlSec > MAX_TTL_SECONDS) {
    throw new Error(`schedulerLock.withLease: ttlSec must be <= ${MAX_TTL_SECONDS} (got ${ttlSec})`);
  }
  if (!Number.isFinite(heartbeatSec) || heartbeatSec < MIN_HEARTBEAT_SEC) {
    throw new Error(`schedulerLock.withLease: heartbeatSec must be >= ${MIN_HEARTBEAT_SEC} (got ${heartbeatSec})`);
  }
  if (heartbeatSec >= ttlSec) {
    throw new Error(`schedulerLock.withLease: heartbeatSec (${heartbeatSec}) must be < ttlSec (${ttlSec})`);
  }

  // ── kill switch: pass-through mode ────────────────────────────────────
  if (process.env.SCHEDULER_LOCK_ENABLED === '0') {
    _log('LOCK_DISABLED', { job: lockKey, run_id: runId });
    const value = await fn({
      runId,
      isLeaseLost: () => false,
      // No lease infrastructure · caller can safely proceed. Return true so
      // money-facing callers don't block on a disabled subsystem. If Owner
      // wants hard-off, they should not run the money job at all.
      verifyOwnership: async () => true,
    });
    return { acquired: true, ran: true, leaseLost: false, value };
  }

  // ── acquire ───────────────────────────────────────────────────────────
  let acq;
  try {
    acq = await _acquire(lockKey, runId, ttlSec);
  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    _log('ACQUIRE_ERROR', {
      job: lockKey, run_id: runId, fail_policy: failPolicy,
      error: JSON.stringify(errMsg).slice(0, 300),
    });
    if (failPolicy === 'closed') {
      return { acquired: false, ran: false, leaseLost: false, error: e };
    }
    // fail-open: run without lease · surface a distinct log
    _log('LOCK_INFRA_BYPASS', { job: lockKey, run_id: runId });
    const value = await fn({
      runId,
      isLeaseLost: () => false,
      // No lease acquired · caller has already accepted the risk (fail-open).
      // Return true so verifyOwnership doesn't compound the failure into a
      // second FAIL CLOSED downstream. Fail-open is opt-in by policy.
      verifyOwnership: async () => true,
    });
    return { acquired: false, ran: true, leaseLost: false, value };
  }

  if (!acq.acquired) {
    _log('SKIP_LOCKED', {
      job: lockKey, run_id: runId,
      current_owner: acq.current_owner_id,
      current_run:   acq.current_run_id,
      expires_at:    acq.expires_at,
    });
    return { acquired: false, ran: false, leaseLost: false };
  }

  _log('LOCK_ACQUIRED', {
    job: lockKey, owner: OWNER_ID, run_id: runId,
    ttl_sec: ttlSec, expires_at: acq.expires_at,
  });

  // ── heartbeat timer ───────────────────────────────────────────────────
  let leaseLost = false;
  let heartbeatTimer = null;

  const heartbeatTick = async () => {
    try {
      const hb = await _heartbeat(lockKey, runId, ttlSec);
      if (!hb.ok) {
        if (!leaseLost) {
          leaseLost = true;
          _log('LEASE_LOST', { job: lockKey, run_id: runId });
        }
      } else {
        _log('HEARTBEAT', { job: lockKey, run_id: runId, expires_at: hb.expires_at });
      }
    } catch (e) {
      const errMsg = (e && e.message) ? e.message : String(e);
      _log('HEARTBEAT_ERROR', {
        job: lockKey, run_id: runId,
        error: JSON.stringify(errMsg).slice(0, 300),
      });
      // do NOT flip leaseLost here · transient errors ≠ lost ownership.
      // If we truly lost the lease, subsequent heartbeats will return ok=false.
    }
  };

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(heartbeatTick, heartbeatSec * 1000);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  // ── run fn ────────────────────────────────────────────────────────────
  //   ctx.verifyOwnership() — public API for money-facing callers to
  //     synchronously verify (via fresh RPC round-trip · not local flag)
  //     that this run still holds the lease immediately before an
  //     external write. Uses the heartbeat RPC underneath, so a successful
  //     verify also extends expires_at (natural TTL renewal per write).
  //
  //     Returns true if we still own the lease · false if a different
  //     run has taken over. THROWS on RPC infrastructure failure — the
  //     caller MUST treat exceptions as ownership-lost and FAIL CLOSED.
  //     Do not silently return false on RPC error here; propagating the
  //     exception forces the caller to make an explicit decision.
  const verifyOwnership = async () => {
    const hb = await _heartbeat(lockKey, runId, ttlSec);
    if (!hb.ok && !leaseLost) {
      leaseLost = true;
      _log('LEASE_LOST', { job: lockKey, run_id: runId, via: 'verifyOwnership' });
    }
    return hb.ok === true;
  };

  _log('START', { job: lockKey, run_id: runId });
  startHeartbeat();
  const startedAt = Date.now();

  try {
    const value = await fn({
      runId,
      isLeaseLost: () => leaseLost,
      verifyOwnership,
    });
    const durationMs = Date.now() - startedAt;
    _log('SUCCESS', {
      job: lockKey, run_id: runId, duration_ms: durationMs, lease_lost: leaseLost,
    });
    return { acquired: true, ran: true, leaseLost, value };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const errMsg = (e && e.message) ? e.message : String(e);
    _log('FAIL', {
      job: lockKey, run_id: runId, duration_ms: durationMs, lease_lost: leaseLost,
      error: JSON.stringify(errMsg).slice(0, 300),
    });
    throw e;
  } finally {
    stopHeartbeat();
    try {
      const ok = await _release(lockKey, runId);
      _log('RELEASE', { job: lockKey, run_id: runId, ok });
    } catch (e) {
      const errMsg = (e && e.message) ? e.message : String(e);
      _log('RELEASE_ERROR', {
        job: lockKey, run_id: runId,
        error: JSON.stringify(errMsg).slice(0, 300),
      });
    }
  }
}

module.exports = {
  withLease,
  OWNER_ID,
  MAX_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SEC,
  // internals · exposed for tests only
  _acquire,
  _heartbeat,
  _release,
  _setClientForTests,
  _resetClientForTests,
};
