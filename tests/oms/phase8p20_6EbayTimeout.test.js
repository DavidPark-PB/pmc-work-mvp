'use strict';

/**
 * tests/oms/phase8p20_6EbayTimeout.test.js — Phase 8P-20.6
 *
 * Confirms the eBay HTTP-timeout minimal fix:
 *   • Trading API axios.post has explicit timeout: 30000
 *   • Both OAuth axios.post calls have explicit timeout: 15000
 *   • Shopify axios timeout unchanged
 *   • Scheduler classifies /timeout/ jobError as errorClass='timeout'
 *   • First-tick completion with a timeout-shaped jobError does NOT permanently
 *     hold the per-channel running lock (finally releases it · next tick eligible)
 *
 * All tests are static source scans or in-memory fakes · zero DB · zero network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

//   ─── A. Trading API request has explicit 30000ms timeout ──────────────

test('P8P20_6_A · callTradingAPI axios.post declares timeout: 30000', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/ebayAPI.js'), 'utf8');
  //   The Trading API call is the one that also passes `xml` as second arg.
  //   Match: axios.post(this.apiUrl, xml, { ... timeout: 30000 ... })
  const match = src.match(/axios\.post\(this\.apiUrl,\s*xml,\s*\{[\s\S]*?\}\)/);
  assert.ok(match, 'expected axios.post(this.apiUrl, xml, {...}) block in ebayAPI.js');
  assert.match(match[0], /timeout:\s*30000/,
    'Trading API axios.post must declare timeout: 30000 (Phase 8P-20.6 minimal hang fix)');
});

//   ─── B. Both OAuth requests have explicit 15000ms timeout ──────────────

test('P8P20_6_B · both OAuth axios.post calls (client_credentials + refresh_token) declare timeout: 15000', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/ebayAPI.js'), 'utf8');
  //   Both OAuth calls target this.oauthUrl. Grab every axios.post(this.oauthUrl, ...) block.
  const oauthCalls = [...src.matchAll(/axios\.post\(this\.oauthUrl,[\s\S]*?\}\s*\)/g)];
  assert.equal(oauthCalls.length, 2,
    `expected exactly 2 axios.post(this.oauthUrl, ...) blocks (_fetchApplicationToken + refreshAccessToken); found ${oauthCalls.length}`);
  for (const [i, m] of oauthCalls.entries()) {
    assert.match(m[0], /timeout:\s*15000/,
      `OAuth call #${i + 1} must declare timeout: 15000 (Phase 8P-20.6)`);
  }
});

//   ─── E. Shopify unchanged · still uses 30000 default in _request wrapper ──────

test('P8P20_6_E · Shopify _request wrapper still declares timeout: config.timeout || 30000', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/shopifyAPI.js'), 'utf8');
  assert.match(src, /timeout:\s*config\.timeout\s*\|\|\s*30000/,
    'Shopify axios timeout must remain unchanged (Phase 8P-20.6 must not modify Shopify)');
});

//   ─── C + D. Scheduler classifies timeout jobError as errorClass='timeout'
//              AND completes the tick so the running lock is released ─────────

test('P8P20_6_C_D · simulated ebay ingestor timeout · scheduler logs classification, completes tick, lock released', async () => {
  //   Isolate module cache: fresh scheduler + fresh ingestionStateService + fake ebayIngestor.
  const schedulerPath          = require.resolve('../../src/services/oms/channelIngestionScheduler');
  const ingestionStateSvcPath  = require.resolve('../../src/services/oms/ingestionStateService');
  const ebayIngestorPath       = require.resolve('../../src/services/oms/ebayIngestor');

  const prevScheduler          = require.cache[schedulerPath];
  const prevStateSvc           = require.cache[ingestionStateSvcPath];
  const prevIngestor           = require.cache[ebayIngestorPath];

  //   Capture calls to recordAttempt so we can assert classification
  const recordAttemptCalls = [];
  const recordAuthFailureCalls = [];

  //   Fake ingestionStateService — behaves like DB-missing-table default path
  require.cache[ingestionStateSvcPath] = {
    id: ingestionStateSvcPath,
    filename: ingestionStateSvcPath,
    loaded: true,
    exports: {
      DEFAULT_CADENCE: {
        ebay:    { cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7 },
        shopify: { cadence_minutes:  5, overlap_minutes: 20, default_lookback_days: 3 },
        naver:   { cadence_minutes: 10, overlap_minutes: 30, default_lookback_days: 3 },
        coupang: { cadence_minutes: 10, overlap_minutes: 30, default_lookback_days: 3 },
        qoo10:   { cadence_minutes: 15, overlap_minutes: 60, default_lookback_days: 3 },
        shopee:  { cadence_minutes: 10, overlap_minutes: 30, default_lookback_days: 3 },
      },
      KNOWN_STATUSES: ['healthy','stale','auth_failed','disabled'],
      getIngestionState: async (channel) => ({
        channel, status: 'healthy',
        last_success_at: null, last_attempt_at: null, last_error: null, last_cursor: null,
        consecutive_failures: 0,
        cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7,
      }),
      recordAttempt: async (args) => { recordAttemptCalls.push(args); },
      recordAuthFailure: async (args) => { recordAuthFailureCalls.push(args); },
      listFreshness: async () => [],
      computeIngestionWindow: () => ({ fetch_from_iso: '', fetch_to_iso: '', from_ms: 0, to_ms: 0 }),
    },
  };

  //   Fake ebayIngestor that simulates the axios timeout path
  require.cache[ebayIngestorPath] = {
    id: ebayIngestorPath,
    filename: ebayIngestorPath,
    loaded: true,
    exports: {
      ingestEbay: async () => ({
        channel: 'ebay', days: 7,
        fetched: 0, attempted: 0,
        created: 0, updated: 0, skipped: 0, invalid: 0, failed: 0,
        rawEventsInserted: 0, rawEventsDeduped: 0,
        itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
        itemsMatched: 0, itemsUnmatched: 0,
        failures: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        jobError: 'fetch_failed:timeout of 30000ms exceeded',
      }),
      _emptyReport: () => ({}),
    },
  };

  //   Fresh scheduler load (so its destructured refs bind to our fake service)
  delete require.cache[schedulerPath];
  const { startChannelIngestionScheduler } = require(schedulerPath);

  //   Capture logs
  const logs = [];
  const log = (m) => logs.push(String(m));

  const prevActiveChannels = process.env.OMS_SCHEDULER_ACTIVE_CHANNELS;
  process.env.OMS_SCHEDULER_ACTIVE_CHANNELS = 'ebay';  //   isolate ebay for this test

  let ctrl;
  try {
    ctrl = startChannelIngestionScheduler({
      dryRun: false,
      staggerMs: 0,
      log,
      overrideIntervals: { ebay: 10 },  //   cadence irrelevant · first tick fires at initialDelay=0
    });

    //   Wait for first tick to complete. staggerMs=0 → setTimeout(0) → tick runs on next loop.
    //   ingestEbay is synchronous-async (returns immediately) so the whole tick settles fast.
    await new Promise(r => setTimeout(r, 200));

    //   Assertions ─────────────────────────────────────

    //   Tick entered
    assert.ok(
      logs.some(l => /^OMS_SCHEDULER_TICK_STARTED channel=ebay/.test(l)),
      `expected OMS_SCHEDULER_TICK_STARTED log · saw: ${JSON.stringify(logs)}`
    );

    //   Tick completed (finally block ran · lock released)
    assert.ok(
      logs.some(l => /channel=ebay tick .* jobError=fetch_failed:timeout/.test(l)),
      `expected completion log with timeout jobError · saw: ${JSON.stringify(logs)}`
    );

    //   NO 'tick skipped' — first tick was fresh, so lock was free
    assert.ok(
      !logs.some(l => /channel=ebay tick skipped/.test(l)),
      `unexpected 'tick skipped' on first tick · saw: ${JSON.stringify(logs)}`
    );

    //   Classification: recordAttempt(ok=false, errorClass='timeout')
    const ebayAttempts = recordAttemptCalls.filter(c => c.channel === 'ebay');
    assert.equal(ebayAttempts.length, 1, `expected 1 recordAttempt for ebay · got ${ebayAttempts.length}`);
    assert.equal(ebayAttempts[0].ok, false);
    assert.equal(ebayAttempts[0].errorClass, 'timeout',
      `expected errorClass='timeout' · got '${ebayAttempts[0].errorClass}'`);

    //   Auth-failure path NOT triggered (word 'timeout' does not match auth regex)
    assert.equal(recordAuthFailureCalls.length, 0);

  } finally {
    if (ctrl) ctrl.stop();
    //   Restore module cache
    if (prevScheduler)  require.cache[schedulerPath] = prevScheduler; else delete require.cache[schedulerPath];
    if (prevStateSvc)   require.cache[ingestionStateSvcPath] = prevStateSvc; else delete require.cache[ingestionStateSvcPath];
    if (prevIngestor)   require.cache[ebayIngestorPath] = prevIngestor; else delete require.cache[ebayIngestorPath];
    if (prevActiveChannels == null) delete process.env.OMS_SCHEDULER_ACTIVE_CHANNELS;
    else process.env.OMS_SCHEDULER_ACTIVE_CHANNELS = prevActiveChannels;
  }
});

//   ─── Extra safety · confirm the scheduler's tick function's finally-block
//        structural guarantee is still present (regression guard) ──────────

test('P8P20_6_STRUCT · scheduler tick has finally { running.set(channel, false) } (lock release guarantee)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/channelIngestionScheduler.js'), 'utf8');
  assert.match(src, /finally\s*\{\s*running\.set\(channel,\s*false\)\s*;\s*\}/,
    'tick finally must always release the running lock (Phase 8P-20.5/6 invariant)');
  //   And the pre-ingestor observability log must be present
  assert.match(src, /OMS_SCHEDULER_TICK_STARTED channel=/,
    'Phase 8P-20.6 pre-ingestor observability log must be present');
});
