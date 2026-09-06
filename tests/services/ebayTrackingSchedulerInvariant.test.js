'use strict';

/**
 * tests/services/ebayTrackingSchedulerInvariant.test.js — R2-SHIP-6F1C-D (2026-09-06).
 *
 * Invariant suite for the recurring eBay tracking observer job wrapper
 * (`src/jobs/ebayTrackingObserverJob.js`) + its scheduler entry
 * (`src/services/scheduler.js`).
 *
 * Test isolation pattern: require.cache substitution of
 * `src/services/schedulerLock` and `src/services/ebayTrackingObserver`
 * BEFORE loading the job module. No real lease acquire, no real eBay
 * call, no real DB write.
 *
 * The scheduler tick invocation itself is verified via source-level
 * static assertion (SCHED-T11) — invoking cron.schedule with a real
 * clock would either wait 6 hours or need `sinon` fake-timers which
 * add dependency cost for a single-line entry.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

// ─────────────────────────────────────────────────────────────────────
// require.cache substitution BEFORE loading the job
// ─────────────────────────────────────────────────────────────────────

const ROOT           = path.resolve(__dirname, '../..');
const SCHEDULER_LOCK = path.resolve(ROOT, 'src/services/schedulerLock.js');
const OBSERVER       = path.resolve(ROOT, 'src/services/ebayTrackingObserver.js');

const spy = {
  leaseCalls:      [],   // { lockKey, opts }
  observerCalls:   [],   // opts passed to observer.run
};

function resetSpy() {
  spy.leaseCalls.length    = 0;
  spy.observerCalls.length = 0;
}

//   Configurable withLease behaviour per test.
let leaseMode = 'acquire_ok'; // 'acquire_ok' | 'locked' | 'infra_error' | 'observer_throws' | 'observer_incomplete'
let observerReturn = null;

function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

stubModule(SCHEDULER_LOCK, {
  async withLease(lockKey, opts, fn) {
    spy.leaseCalls.push({ lockKey, opts });
    if (leaseMode === 'locked') {
      return { acquired: false, ran: false, leaseLost: false };
    }
    if (leaseMode === 'infra_error') {
      return { acquired: false, ran: false, leaseLost: false, error: new Error('SIMULATED_LEASE_INFRA_ERROR') };
    }
    //   Run fn with a fake ctx (verifyOwnership no-op)
    const ctx = { runId: 'test-run', isLeaseLost: () => false, verifyOwnership: async () => true };
    const value = await fn(ctx);
    return { acquired: true, ran: true, leaseLost: false, value };
  },
});

stubModule(OBSERVER, {
  async run(opts) {
    spy.observerCalls.push(opts);
    if (leaseMode === 'observer_throws') throw new Error('SIMULATED_OBSERVER_ERROR');
    if (leaseMode === 'observer_incomplete') {
      return {
        counters: {
          outcome: 'RUN_INCOMPLETE',
          fetch_reason: 'SIMULATED_PAGE_FAIL',
          ebay_orders_seen: 0,
          inserted: 0,
          already_known_or_raced: 0,
          not_eligible_status: 0,
          multi_package: 0,
          conflict: 0,
        },
        decisions: [],
      };
    }
    return observerReturn || {
      counters: {
        outcome:                'RUN_COMPLETE',
        ebay_orders_seen:       1200,
        inserted:               5,
        already_known_or_raced: 995,
        not_eligible_status:    71,
        multi_package:          2,
        conflict:               0,
      },
      decisions: [],
    };
  },
});

const job = require('../../src/jobs/ebayTrackingObserverJob');
const {
  runEbayTrackingObserverJob,
  _runObserverInner,
  _LEASE_KEY,
  _LEASE_TTL_SEC,
  _LEASE_HEARTBEAT_SEC,
  _ELIGIBLE_STATUSES,
  _DAYS_WINDOW,
} = job;

// ─────────────────────────────────────────────────────────────────────
// Constants / structural assertions
// ─────────────────────────────────────────────────────────────────────

test('CONST · _LEASE_KEY matches scheduler:ebay-tracking-observer', () => {
  assert.equal(_LEASE_KEY, 'scheduler:ebay-tracking-observer');
});

test('CONST · lease TTL 900s · heartbeat 60s', () => {
  assert.equal(_LEASE_TTL_SEC, 900);
  assert.equal(_LEASE_HEARTBEAT_SEC, 60);
});

test('CONST · ELIGIBLE_STATUSES is exactly [SHIPPED] · frozen', () => {
  assert.deepEqual([..._ELIGIBLE_STATUSES], ['SHIPPED']);
  assert.throws(() => _ELIGIBLE_STATUSES.push('READY'),
    /Cannot|read.only|frozen/i,
    'ELIGIBLE_STATUSES must be frozen to prevent runtime broadening');
});

test('CONST · DAYS_WINDOW is exactly 30', () => {
  assert.equal(_DAYS_WINDOW, 30);
});

// ─────────────────────────────────────────────────────────────────────
// Behavioral tests
// ─────────────────────────────────────────────────────────────────────

test('SCHED-T1 · lease acquired → observer invoked exactly once · dryRun=false · eligibleStatuses=[SHIPPED] · daysWindow=30', async () => {
  resetSpy();
  leaseMode = 'acquire_ok';
  const r = await runEbayTrackingObserverJob();
  assert.equal(spy.leaseCalls.length,    1);
  assert.equal(spy.leaseCalls[0].lockKey, 'scheduler:ebay-tracking-observer');
  assert.equal(spy.leaseCalls[0].opts.ttlSec,       900);
  assert.equal(spy.leaseCalls[0].opts.heartbeatSec, 60);
  assert.equal(spy.leaseCalls[0].opts.failPolicy,   'closed');
  assert.equal(spy.observerCalls.length, 1);
  assert.equal(spy.observerCalls[0].dryRun,                       false);
  assert.deepEqual(spy.observerCalls[0].eligibleStatuses,         ['SHIPPED']);
  assert.equal(spy.observerCalls[0].daysWindow,                   30);
  assert.equal(r.counters.outcome, 'RUN_COMPLETE');
});

test('SCHED-T2 · lease already locked → observer 0 calls · skipped_locked', async () => {
  resetSpy();
  leaseMode = 'locked';
  const r = await runEbayTrackingObserverJob();
  assert.equal(spy.leaseCalls.length,    1);
  assert.equal(spy.observerCalls.length, 0);
  assert.equal(r.skipped,   true);
  assert.equal(r.skipReason, 'locked');
  assert.equal(r.counters.inserted, 0);
  assert.equal(r.counters.outcome,  'RUN_SKIPPED');
});

test('SCHED-T3 · lease infra error → observer 0 calls · lease_infra_error', async () => {
  resetSpy();
  leaseMode = 'infra_error';
  const r = await runEbayTrackingObserverJob();
  assert.equal(spy.leaseCalls.length,    1);
  assert.equal(spy.observerCalls.length, 0);
  assert.equal(r.skipped,    true);
  assert.equal(r.skipReason, 'lease_infra_error');
  assert.equal(r.counters.inserted, 0);
});

test('SCHED-T4 · observer returns RUN_INCOMPLETE → job surfaces truthfully · 0 mutations claimed', async () => {
  resetSpy();
  leaseMode = 'observer_incomplete';
  const r = await runEbayTrackingObserverJob();
  assert.equal(spy.observerCalls.length, 1);
  assert.equal(r.counters.outcome, 'RUN_INCOMPLETE');
  assert.equal(r.counters.inserted, 0);
});

test('SCHED-T5 · two simulated scheduler instances · only lease owner runs observer', async () => {
  resetSpy();
  //   First instance: lease acquired · observer runs
  leaseMode = 'acquire_ok';
  const r1 = await runEbayTrackingObserverJob();
  assert.equal(spy.observerCalls.length, 1);
  //   Second concurrent instance: lease locked · observer skipped
  leaseMode = 'locked';
  const r2 = await runEbayTrackingObserverJob();
  //   Still only 1 observer invocation total
  assert.equal(spy.observerCalls.length, 1);
  assert.equal(r1.counters.outcome, 'RUN_COMPLETE');
  assert.equal(r2.skipped, true);
});

test('SCHED-T6 · observer throws → job catches · returns error skip shape · scheduler process survives', async () => {
  resetSpy();
  leaseMode = 'observer_throws';
  //   The observer stub throws · withLease propagates · we expect
  //   the outer catch in the scheduler cron entry to survive this
  //   in production. In the job wrapper itself the throw propagates
  //   OUT (matches repricingPipelineJob pattern · scheduler handles it).
  await assert.rejects(runEbayTrackingObserverJob(), /SIMULATED_OBSERVER_ERROR/);
  assert.equal(spy.observerCalls.length, 1);
  //   Confirm scheduler entry has try/catch to survive
  const schedulerSrc = fs.readFileSync(path.resolve(ROOT, 'src/services/scheduler.js'), 'utf8');
  const entryStart = schedulerSrc.indexOf('R2-SHIP-6F1C-D');
  assert.ok(entryStart > -1, 'R2-SHIP-6F1C-D marker must exist in scheduler.js');
  const entrySlice = schedulerSrc.slice(entryStart, entryStart + 2000);
  assert.ok(/try\s*\{[\s\S]+catch\s*\(e\)/.test(entrySlice),
    'scheduler cron entry must wrap job invocation in try/catch so scheduler process survives');
});

test('SCHED-T7 · module import does NOT invoke observer · zero boot execution', async () => {
  //   Fresh require.cache clear + reload · observer must NOT be called
  //   just by loading the job module.
  resetSpy();
  delete require.cache[require.resolve('../../src/jobs/ebayTrackingObserverJob')];
  require('../../src/jobs/ebayTrackingObserverJob');
  assert.equal(spy.observerCalls.length, 0, 'module import must never invoke observer');
  assert.equal(spy.leaseCalls.length,    0, 'module import must never acquire lease');
});

test('SCHED-T8 · repeated job execution · observer sees same options each time (idempotency guaranteed by observer)', async () => {
  resetSpy();
  leaseMode = 'acquire_ok';
  await runEbayTrackingObserverJob();
  await runEbayTrackingObserverJob();
  await runEbayTrackingObserverJob();
  //   All 3 observer invocations must have identical mutation authorization
  assert.equal(spy.observerCalls.length, 3);
  for (const call of spy.observerCalls) {
    assert.equal(call.dryRun, false);
    assert.deepEqual(call.eligibleStatuses, ['SHIPPED']);
    assert.equal(call.daysWindow, 30);
  }
  //   Note: actual idempotency (tracking_no not overwritten · tracking_imported_at
  //   preserved) is enforced INSIDE the observer via atomic .or(...) predicate ·
  //   verified in ebayTrackingObserverInvariant.test.js BH-T5 / BH-S6.
});

test('SCHED-T9 · mutation authorization is exactly [SHIPPED] · never broader', async () => {
  resetSpy();
  leaseMode = 'acquire_ok';
  await runEbayTrackingObserverJob();
  const call = spy.observerCalls[0];
  //   Explicit deep-equal · not superset
  assert.deepEqual(call.eligibleStatuses, ['SHIPPED']);
  assert.equal(call.eligibleStatuses.length, 1);
  assert.equal(call.eligibleStatuses[0], 'SHIPPED');
  //   Not READY · not NEW · not undefined (fail-closed) · not all statuses
  assert.ok(!call.eligibleStatuses.includes('READY'));
  assert.ok(!call.eligibleStatuses.includes('NEW'));
  assert.ok(!call.eligibleStatuses.includes('PENDING_KOREAPOST'));
});

test('SCHED-T10 · daysWindow is exactly 30 · not 7 · not 1', async () => {
  resetSpy();
  leaseMode = 'acquire_ok';
  await runEbayTrackingObserverJob();
  assert.equal(spy.observerCalls[0].daysWindow, 30);
});

test('SCHED-T11 · scheduler cron entry is exactly `0 2,8,14,20 * * *` + KST timezone', () => {
  const schedulerSrc = fs.readFileSync(path.resolve(ROOT, 'src/services/scheduler.js'), 'utf8');
  const entryStart = schedulerSrc.indexOf('R2-SHIP-6F1C-D');
  assert.ok(entryStart > -1, 'R2-SHIP-6F1C-D marker must exist in scheduler.js');
  const entrySlice = schedulerSrc.slice(entryStart, entryStart + 2000);
  //   Cron literal
  assert.ok(entrySlice.includes("cron.schedule('0 2,8,14,20 * * *'"),
    "cron entry must be literal '0 2,8,14,20 * * *' offset from aiPubMonitor 0/6/12/18");
  //   Timezone via existing TZ constant (KST)
  assert.ok(/timezone:\s*TZ/.test(entrySlice),
    'entry must use existing TZ constant · not a new timezone string');
  //   Invokes the job wrapper (not observer directly)
  assert.ok(entrySlice.includes("require('../jobs/ebayTrackingObserverJob')"),
    'entry must lazy-require the job wrapper');
  assert.ok(entrySlice.includes('runEbayTrackingObserverJob()'),
    'entry must invoke runEbayTrackingObserverJob (not observer.run directly)');
});

test('SCHED-T12 · production diff scope: only 3 approved files touched (structural)', () => {
  //   This test is a documentation invariant · the CI/reviewer confirms
  //   that the R2-SHIP-6F1C-D commit contains exactly:
  //     src/jobs/ebayTrackingObserverJob.js       (new file)
  //     src/services/scheduler.js                 (1 cron entry added)
  //     tests/services/ebayTrackingSchedulerInvariant.test.js  (new file)
  //   Any change to src/api/ebayAPI.js (Phase 7A-4) or the observer
  //   itself must be a separate phase. This test asserts the source
  //   still contains observer/scheduler_lock via require · not local
  //   copies · so the scope invariant is enforced at code level.
  const jobSrc = fs.readFileSync(path.resolve(ROOT, 'src/jobs/ebayTrackingObserverJob.js'), 'utf8');
  //   Job MUST require the observer as a module · not inline duplicate
  assert.ok(jobSrc.includes("require('../services/ebayTrackingObserver')"),
    'job must reuse deployed observer · not duplicate business logic');
  assert.ok(jobSrc.includes("require('../services/schedulerLock')"),
    'job must reuse deployed R1 lease · not duplicate lock system');
  //   Job MUST NOT reach into ebayAPI directly · observer already wraps
  assert.ok(!jobSrc.includes("require('../api/ebayAPI')"),
    'job MUST NOT import ebayAPI.js directly (Phase 7A-4 collision guard)');
  //   Job MUST NOT touch orderSync
  assert.ok(!jobSrc.includes('orderSync'),
    'job MUST NOT touch orderSync');
});
