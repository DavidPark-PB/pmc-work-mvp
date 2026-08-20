'use strict';

/**
 * channelIngestionScheduler.js — Phase 8P-20.
 *
 * Per-channel independent scheduler for OMS order ingestion.
 * One channel failing does NOT stop the others.
 *
 * Design:
 *   • One setInterval-driven "tick" per channel, offset by 30s stagger to avoid
 *     starting all channels at the same second.
 *   • Each tick runs the channel's ingestor with a small concurrency lock —
 *     a slow run does not start a second run for the same channel.
 *   • Job wrapping: try/catch surrounds every ingest call so an uncaught throw
 *     never propagates and crashes the host process.
 *   • Cadence read from `ingestion_state.cadence_minutes` (per channel) at
 *     start-up · fallback to DEFAULT_CADENCE in ingestionStateService.
 *   • Auth failure sets status='auth_failed' and pauses the channel until Owner
 *     resets it (dashboard button · not implemented here).
 *   • Explicit `--disabled` env flag OMS_SCHEDULER_DISABLED=1 completely bypasses
 *     the scheduler (for local dev or maintenance mode).
 *
 * Registered channels: ebay, shopify, naver, coupang, qoo10, shopee.
 * Alibaba intentionally omitted — no customer-order API in existing client.
 *
 * PII: never log buyer info. Only channel + counts + status codes.
 */

const { DEFAULT_CADENCE, getIngestionState, recordAttempt, recordAuthFailure } = require('./ingestionStateService');

//   Deferred loads · avoid pulling api clients at module load in tests
function _lazyRequire(path) { return () => require(path); }

const CHANNEL_INGESTORS = Object.freeze({
  ebay:    { load: _lazyRequire('./ebayIngestor'),    fn: 'ingestEbay',    disabled_env: 'OMS_INGEST_EBAY_DISABLED' },
  shopify: { load: _lazyRequire('./shopifyIngestor'), fn: 'ingestShopify', disabled_env: 'OMS_INGEST_SHOPIFY_DISABLED' },
  naver:   { load: _lazyRequire('./naverIngestor'),   fn: 'ingestNaver',   disabled_env: 'OMS_INGEST_NAVER_DISABLED' },
  coupang: { load: _lazyRequire('./coupangIngestor'), fn: 'ingestCoupang', disabled_env: 'OMS_INGEST_COUPANG_DISABLED' },
  qoo10:   { load: _lazyRequire('./qoo10Ingestor'),   fn: 'ingestQoo10',   disabled_env: 'OMS_INGEST_QOO10_DISABLED' },
  shopee:  { load: _lazyRequire('./shopeeIngestor'),  fn: 'ingestShopee',  disabled_env: 'OMS_INGEST_SHOPEE_DISABLED' },
});

//   Phase 8P-20.2 V1 activation boundary.
//   Owner decision: eBay + Shopify are the sole operational V1 channels.
//   Naver / Coupang / Qoo10 / Shopee stay code-present but scheduler-deferred
//   until per-channel Owner activation (credentials, IP whitelist, key rotation).
//   Override with env: OMS_SCHEDULER_ACTIVE_CHANNELS="ebay,shopify,naver"
const V1_DEFAULT_ACTIVE = Object.freeze(['ebay', 'shopify']);
const V1_DEFERRED       = Object.freeze(['naver', 'coupang', 'qoo10', 'shopee']);

function _resolveActiveSet() {
  const raw = process.env.OMS_SCHEDULER_ACTIVE_CHANNELS;
  if (!raw || !raw.trim()) return new Set(V1_DEFAULT_ACTIVE);
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Start scheduler for all channels. Returns a controller with .stop() to
 * cancel every timer (useful for tests · graceful shutdown).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]         only log · never invoke ingestor
 * @param {number}  [opts.staggerMs=30_000]     offset between channel starts
 * @param {Function} [opts.log=console.log]     structured logger hook
 * @param {Object}  [opts.overrideIntervals]    { channel: minutes } override for tests
 * @returns {{ stop: Function, channels: string[], timers: Map<string, any> }}
 */
function startChannelIngestionScheduler(opts = {}) {
  const dryRun = !!opts.dryRun;
  const log = opts.log || console.log;
  const staggerMs = Number.isFinite(opts.staggerMs) ? opts.staggerMs : 30_000;
  const overrideIntervals = opts.overrideIntervals || {};

  if (process.env.OMS_SCHEDULER_DISABLED === '1') {
    log('[oms-scheduler] OMS_SCHEDULER_DISABLED=1 · scheduler start skipped');
    return { stop: () => {}, channels: [], timers: new Map() };
  }

  const timers = new Map();
  const running = new Map();       //   channel → boolean (concurrency lock)
  //   Phase 8P-20.7 · in-memory tick tracker (Task D · option A).
  //   Distinct from ingestion_state.last_attempt_at (which only updates on completion,
  //   hiding hangs). This is log-only + queryable via the returned controller.
  //   Zero DB write · zero migration.
  const inflight = new Map();      //   channel → { startedAt, sinceMs()  }  while a tick is running
  const lastCompletedAt = new Map(); //   channel → ISO string of last observed completion (any outcome)
  const startedChannels = [];
  const deferredChannels = [];     //   V1 boundary · code-present but scheduler-off

  const activeSet = _resolveActiveSet();
  //   Phase 8P-20.3a · SAFE boot observability · no secrets
  log(`OMS_SCHEDULER_BOOT enabled_env=${process.env.OMS_SCHEDULER_ENABLED === '1' ? '1' : 'unset'} disabled_env=${process.env.OMS_SCHEDULER_DISABLED === '1' ? '1' : 'unset'} railway_environment=${process.env.RAILWAY_ENVIRONMENT || 'unset'} resolved_active_channels=${[...activeSet].sort().join(',')}`);
  const channels = Object.keys(CHANNEL_INGESTORS);
  channels.forEach((channel, i) => {
    const conf = CHANNEL_INGESTORS[channel];
    if (!activeSet.has(channel)) {
      deferredChannels.push(channel);
      log(`[oms-scheduler] channel=${channel} DEFERRED_NOT_BLOCKING_V1 · code preserved · scheduler skip (activate via OMS_SCHEDULER_ACTIVE_CHANNELS)`);
      return;
    }
    if (process.env[conf.disabled_env] === '1') {
      log(`[oms-scheduler] channel=${channel} disabled via env · skip`);
      return;
    }
    startedChannels.push(channel);
    running.set(channel, false);

    const startTimer = async () => {
      let cadenceMinutes = overrideIntervals[channel];
      if (!Number.isFinite(cadenceMinutes)) {
        try {
          const state = await getIngestionState(channel);
          cadenceMinutes = state.cadence_minutes || (DEFAULT_CADENCE[channel]?.cadence_minutes || 10);
        } catch (_e) {
          cadenceMinutes = DEFAULT_CADENCE[channel]?.cadence_minutes || 10;
        }
      }
      const cadenceMs = Math.max(60_000, cadenceMinutes * 60_000); //   min 60s guard

      const tick = async () => {
        if (running.get(channel)) {
          const inf = inflight.get(channel);
          //   Phase 8P-20.7 · make "skipped because previous is stuck" observable.
          //   Includes elapsed_ms of the stuck predecessor so Owner can see hang duration.
          const infoStr = inf ? ` previous_started_at=${inf.startedAt} elapsed_ms=${Date.now() - inf.startedAtMs}` : '';
          log(`[oms-scheduler] channel=${channel} tick skipped · previous run in progress${infoStr}`);
          return;
        }
        running.set(channel, true);
        const runStartedAt = new Date().toISOString();
        //   Phase 8P-20.7 · in-memory started_at (persists across ticks even while a hang
        //   holds the lock; distinct from ingestion_state.last_attempt_at which only
        //   updates on completion). Cleared in finally.
        inflight.set(channel, { startedAt: runStartedAt, startedAtMs: Date.now() });
        //   Phase 8P-20.6 · pre-ingestor observability so Railway logs prove the
        //   tick entered (previously we only saw completion logs; a hung ingestor
        //   left zero evidence). Emitted AFTER lock acquisition · BEFORE any await.
        log(`OMS_SCHEDULER_TICK_STARTED channel=${channel} ts=${runStartedAt}`);
        try {
          //   Refresh state each tick · Owner may have set status='disabled' since start
          const state = await getIngestionState(channel);
          if (state.status === 'disabled' || state.status === 'auth_failed') {
            log(`[oms-scheduler] channel=${channel} status=${state.status} · tick skipped · Owner action required`);
            return;
          }
          if (dryRun) {
            log(`[oms-scheduler] channel=${channel} dryRun tick ${runStartedAt}`);
            return;
          }
          const mod = conf.load();
          const ingestorFn = mod[conf.fn];
          if (typeof ingestorFn !== 'function') throw new Error(`ingestor missing: ${channel}.${conf.fn}`);
          //   Phase 8P-20.7 · propagate stage logger only into ingestors that accept it
          //   (currently ingestEbay). Shopify & deferred channels ignore the extra opt.
          const report = await ingestorFn({ actorType: 'automation', stageLog: log });
          //   Log only ids/counts · never PII
          log(`[oms-scheduler] channel=${channel} tick ${runStartedAt} fetched=${report.fetched ?? '?'} attempted=${report.attempted ?? '?'} upserted=${report.ordersUpserted ?? report.created ?? '?'} errors=${(report.errors && report.errors.length) || 0} jobError=${report.jobError || 'none'}`);
          //   Freshness tracking · wrapper-level so legacy ingestors (ebay, shopify)
          //   get last_success_at / last_attempt_at without touching their code.
          //   New ingestors (naver, coupang, qoo10, shopee) also call recordAttempt
          //   internally; the extra wrapper call is safe (upserts same row).
          const finishedAt = new Date().toISOString();
          if (report.jobError) {
            const jobErrStr = String(report.jobError);
            const isAuth = /auth|token|expired|unauthor|forbidden|IP_NOT_ALLOWED/i.test(jobErrStr);
            //   Phase 8P-20.6 · distinguish HTTP timeout from generic network error
            //   so ingestion_error_log surfaces the fix's evidence explicitly.
            const isTimeout = /timeout|ETIMEDOUT|ECONNABORTED/i.test(jobErrStr);
            if (isAuth) await recordAuthFailure({ channel, err: report.jobError });
            else await recordAttempt({ channel, ok: false, err: report.jobError, errorClass: isTimeout ? 'timeout' : 'network' });
          } else {
            await recordAttempt({ channel, ok: true, cursor: finishedAt });
          }
        } catch (err) {
          //   Never crash the process · log + continue
          log(`[oms-scheduler] channel=${channel} tick uncaught: ${err && err.message ? err.message.slice(0, 300) : String(err).slice(0, 300)}`);
          try { await recordAttempt({ channel, ok: false, err, errorClass: 'unknown' }); } catch (_e) { /* swallow · state service is best-effort */ }
        } finally {
          //   Phase 8P-20.7 · release in-memory tracker BEFORE clearing running so
          //   a rapid re-entrant tick sees consistent state.
          lastCompletedAt.set(channel, new Date().toISOString());
          inflight.delete(channel);
          running.set(channel, false);
        }
      };

      //   Stagger initial invocation
      const initialDelay = i * staggerMs;
      log(`OMS_SCHEDULER_CHANNEL_REGISTERED channel=${channel} cadence_minutes=${cadenceMinutes} initial_delay_ms=${initialDelay}`);
      const initialTimer = setTimeout(() => {
        tick();
        const iv = setInterval(tick, cadenceMs);
        timers.set(channel, { kind: 'interval', handle: iv, cadenceMinutes });
      }, initialDelay);
      timers.set(channel, { kind: 'initial', handle: initialTimer, cadenceMinutes });
    };

    startTimer().catch(e => log(`[oms-scheduler] channel=${channel} startTimer failed: ${e && e.message ? e.message : String(e)}`));
  });

  log(`OMS_SCHEDULER_STARTED active=${startedChannels.join(',') || '(none)'} deferred=${deferredChannels.join(',') || '(none)'} stagger_ms=${staggerMs} dry_run=${dryRun}`);

  return {
    stop() {
      for (const { kind, handle } of timers.values()) {
        if (kind === 'initial') clearTimeout(handle);
        else if (kind === 'interval') clearInterval(handle);
      }
      timers.clear();
      log('[oms-scheduler] stopped');
    },
    channels: startedChannels,
    deferred: deferredChannels,
    timers,
    //   Phase 8P-20.7 · in-memory tick tracker query API.
    //   Owner / dashboard / freshness route may call getInflight() to see
    //   which channels are mid-tick (with elapsed_ms). Distinct from
    //   ingestion_state.last_attempt_at — no DB read.
    getInflight() {
      const out = {};
      for (const [ch, inf] of inflight.entries()) {
        out[ch] = { started_at: inf.startedAt, elapsed_ms: Date.now() - inf.startedAtMs };
      }
      return out;
    },
    getLastCompletedAt() { return Object.fromEntries(lastCompletedAt); },
  };
}

module.exports = {
  startChannelIngestionScheduler,
  CHANNEL_INGESTORS,
  V1_DEFAULT_ACTIVE,
  V1_DEFERRED,
};
