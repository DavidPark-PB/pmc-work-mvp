'use strict';

/**
 * R2-SHIP-6F1C-D · Recurring eBay Tracking Observer job (2026-09-06).
 *
 * R1-B distributed-lease wrapper around
 * `src/services/ebayTrackingObserver.js` `run()`. Enforces:
 *
 *   · SHIPPED-only mutation authorization (never READY / NEW / all-status)
 *   · 30-day observation window (empirically proven in R2-SHIP-6F1B-S ·
 *     future R2-SHIP-6F1D may narrow to 7d once recurring production
 *     evidence establishes eBay ModifiedTime bump reliability)
 *   · Multi-instance safety via `scheduler:ebay-tracking-observer` lease
 *     (mig 108 · ON CONFLICT DO UPDATE WHERE expires_at <= now())
 *   · Fetch-all-first + atomic insert-only preserved from observer (no
 *     re-implementation here)
 *   · Fail-closed on lease infrastructure error (money-facing pattern
 *     matching repricingPipelineJob.js)
 *   · Backward-compatible skip shape (numeric zero counters + explicit
 *     skipped=true, skipReason='locked'|'lease_infra_error') so this
 *     wrapper drops into an existing scheduler cron cleanly
 *
 * Explicit non-scope:
 *   · No observer business-logic change (deployed at 7672606 · frozen)
 *   · No ebayAPI.js change (Phase 7A-4 collision avoided via observer's
 *     `callTradingAPI` reuse)
 *   · No scheduler infrastructure change (existing R1 lease reused)
 *   · No READY/NEW authorization (owner rule §12 · eligibleStatuses is
 *     literal `['SHIPPED']` · not env-configurable in this phase)
 *   · No boot execution (first mutation run is the first natural cron
 *     tick after deploy · owner rule §9)
 */

const { withLease } = require('../services/schedulerLock');
const ebayTrackingObserver = require('../services/ebayTrackingObserver');

//   R1 lease configuration · matches repricingPipelineJob.js conventions.
//   TTL 900s = ~5× observed 187s runtime · gives 5x safety margin for
//   worst-case pagination. Heartbeat 60s = mandatory (schedulerLock.js:165
//   requires >0); at 187s runtime with 900s TTL heartbeat is defense-in-
//   depth · not strictly required.
const LEASE_KEY            = 'scheduler:ebay-tracking-observer';
const LEASE_TTL_SEC        = 900;
const LEASE_HEARTBEAT_SEC  = 60;

//   R2-SHIP-6F1C-D · authorization constants pinned at module scope for
//   grep visibility. Owner rule §12: literal `['SHIPPED']` · never env-
//   configurable in this phase. Broadening requires an explicit code
//   change reviewed as a new phase (R2-SHIP-6F1B-A).
const ELIGIBLE_STATUSES    = Object.freeze(['SHIPPED']);
const DAYS_WINDOW          = 30;

/**
 * Inner run function (single business action).
 *
 * Directly invokes the deployed observer with explicit mutation
 * authorization: dryRun=false + eligibleStatuses=['SHIPPED'] + 30d
 * window. No historical query, no READY/NEW logic, no status
 * correction, no carrier mutation. All classification / atomic
 * insert-only / RUN_INCOMPLETE handling lives inside the observer.
 *
 * @returns {Promise<object>} observer result · shape:
 *   { counters: {outcome, ebay_orders_seen, inserted, ...},
 *     decisions: [...] }
 */
async function _runObserverInner() {
  return await ebayTrackingObserver.run({
    dryRun:            false,
    eligibleStatuses:  ELIGIBLE_STATUSES.slice(),
    daysWindow:        DAYS_WINDOW,
  });
}

/**
 * Entry point invoked from the scheduler cron entry.
 *
 * @returns {Promise<object>} observer result on success · or
 *   backward-compat skip shape on lease unavailability:
 *   { outcome: 'RUN_SKIPPED', counters: {inserted:0, ...},
 *     skipped: true, skipReason: 'locked'|'lease_infra_error' }
 */
async function runEbayTrackingObserverJob() {
  const leaseResult = await withLease(
    LEASE_KEY,
    {
      ttlSec:       LEASE_TTL_SEC,
      heartbeatSec: LEASE_HEARTBEAT_SEC,
      failPolicy:   'closed',
    },
    async (_ctx) => {
      //   Observer performs its own atomic insert-only predicate at
      //   the DB layer · lease ownership fence is defense-in-depth
      //   for the outer sweep. No need to pass verifyOwnership here.
      return await _runObserverInner();
    }
  );

  if (leaseResult.ran && leaseResult.value) {
    const c = leaseResult.value.counters || {};
    console.log(
      `[EbayTrackingObserver] outcome=${c.outcome} ebay_orders_seen=${c.ebay_orders_seen} `
      + `inserted=${c.inserted} already_known_or_raced=${c.already_known_or_raced} `
      + `not_eligible_status=${c.not_eligible_status} multi_package=${c.multi_package} `
      + `conflict=${c.conflict}`
    );
    return leaseResult.value;
  }

  //   Backward-compat skip shape. Numeric-zero counters mirror the
  //   observer's normal return so downstream callers (future dashboards,
  //   admin routes) can safely spread `...result.counters`.
  //
  //   Reason classification · matches tokenRefresh.js (`_refreshUnderLease`)
  //   pattern rather than repricingPipelineJob.js: check `leaseResult.error`
  //   FIRST · a `{acquired:false, error:...}` is infra failure not "another
  //   holder". Only `{acquired:false, error:undefined}` means clean lock.
  const skipReason = leaseResult.error
    ? 'lease_infra_error'
    : (leaseResult.acquired === false ? 'locked' : 'lease_infra_error');
  console.log(`[EbayTrackingObserver] skipped · reason=${skipReason}`);
  return {
    counters: {
      outcome:                 'RUN_SKIPPED',
      fetch_reason:            skipReason,
      ebay_orders_seen:        0,
      no_tracking:             0,
      one_unique_tracking:     0,
      multiple_distinct:       0,
      malformed:               0,
      db_matches:              0,
      safe_insert_candidates:  0,
      already_known_or_raced:  0,
      conflict:                0,
      multi_package:           0,
      db_order_not_eligible:   0,
      not_eligible_status:     0,
      inserted:                0,
    },
    decisions: [],
    skipped:   true,
    skipReason,
  };
}

module.exports = {
  runEbayTrackingObserverJob,
  //   Exposed for behavioural tests only. Do not import from other callers.
  _runObserverInner,
  _LEASE_KEY:              LEASE_KEY,
  _LEASE_TTL_SEC:          LEASE_TTL_SEC,
  _LEASE_HEARTBEAT_SEC:    LEASE_HEARTBEAT_SEC,
  _ELIGIBLE_STATUSES:      ELIGIBLE_STATUSES,
  _DAYS_WINDOW:            DAYS_WINDOW,
};
