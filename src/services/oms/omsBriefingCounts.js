'use strict';

/**
 * src/services/oms/omsBriefingCounts.js — OPS-BRIEF-1B (2026-09-06).
 *
 * Canonical OMS briefing counter helpers. Isolated from the legacy
 * `wms_orders`-backed helpers so:
 *   · the KST day-boundary helper can be reused (e.g. by a future
 *     src/web/routes/omsAdmin.js KST cleanup — OMS-STATUS-TZ);
 *   · the PENDING_ACTION status constant lives in one place so a future
 *     OMS order console API (OMS-CONSOLE-1) can consume the same literal
 *     and preserve count = detail;
 *   · summary and detail cannot drift because a single predicate lives
 *     in one file.
 *
 * Scope guarantees (owner rule §1, §22):
 *   · READ ONLY. `count: 'exact', head: true` shapes only. No .limit(N)
 *     + `.length` saturation risk (the same anti-pattern OPS-BRIEF-1A
 *     removed on team_tasks).
 *   · No ingestion / statusMapper / marketplace mutation surface.
 *   · No wms_orders drop or modification. This module only stops the
 *     briefing from reading wms_orders — legacy code is untouched.
 */

/**
 * Canonical OMS `order_status` values that represent an order still
 * requiring operational work. Every value NOT in this set — i.e.
 * `shipped`, `completed`, `cancelled`, `returned` — is excluded from
 * PENDING_ACTION.
 *
 * `pending` is intentionally absent: `oms_orders.order_status` has no
 * `pending` value (see supabase/migrations/078_oms_orders.sql:110-112).
 * `payment_status='pending'` is a different business axis and MUST NOT
 * be substituted here.
 *
 * Frozen literal · downstream code (this module + future OMS console
 * API) must reuse the export rather than duplicating the array.
 */
const PENDING_ACTION_STATUSES = Object.freeze([
  'new',
  'confirmed',
  'processing',
  'on_hold',
  'ready_to_ship',
]);

/**
 * KST (Asia/Seoul) day-boundary context.
 *
 * Railway server is UTC (no `TZ` env var in Dockerfile / config / env).
 * The prior `new Date(y, m, d, 0, 0, 0)` idiom used process-local time
 * and therefore returned UTC-midnight (= KST 09:00) on Railway,
 * silently under-scoping the KST-morning window by up to 9-15 hours.
 *
 * This helper anchors "today" to Korean business day regardless of
 * host TZ. Mirrors the established pattern in
 * `src/db/attendanceRepository.js:26-32` (`_koreaParts`).
 *
 * @param {Date} [now=new Date()]
 * @returns {{ dateStr: string, todayStartIso: string }}
 *   dateStr        YYYY-MM-DD in Asia/Seoul (used for DATE-typed
 *                  overdue comparisons in summarizeTasks)
 *   todayStartIso  UTC ISO instant equivalent to "<dateStr>T00:00:00+09:00"
 */
function getKstDateContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const dateStr       = `${parts.year}-${parts.month}-${parts.day}`;
  const todayStartIso = new Date(`${dateStr}T00:00:00+09:00`).toISOString();
  return { dateStr, todayStartIso };
}

/**
 * Exact count of TODAY_NEW: `oms_orders` where `ordered_at >= KST midnight`.
 *
 * `ordered_at` = marketplace order time (business truth). Late-ingested
 * orders (marketplace ordered yesterday, PMC imported today) are
 * excluded — see OPS-BRIEF-1B audit §5 for rationale.
 *
 * Uses `idx_oms_orders_ordered_at` (see migration 078:134).
 *
 * @throws on Supabase error — caller MUST NOT convert this to 0.
 *         UNKNOWN ≠ ZERO invariant lives in the caller.
 *
 * @param {SupabaseClient} supabase
 * @param {string} todayStartIso  UTC ISO for KST midnight
 * @returns {Promise<number>}
 */
async function countTodayNew(supabase, todayStartIso) {
  const res = await supabase
    .from('oms_orders')
    .select('id', { count: 'exact', head: true })
    .gte('ordered_at', todayStartIso);
  if (res.error) throw res.error;
  return res.count == null ? 0 : res.count;
}

/**
 * Exact count of PENDING_ACTION: `oms_orders` where
 * `order_status IN PENDING_ACTION_STATUSES`.
 *
 * Cancelled / completed / shipped / returned are excluded by construction
 * (they aren't in the set) — separates order-volume truth from actionable-
 * work truth.
 *
 * Uses `idx_oms_orders_order_status` (migration 078:131).
 *
 * @throws on Supabase error — caller MUST NOT convert this to 0.
 *
 * @param {SupabaseClient} supabase
 * @returns {Promise<number>}
 */
async function countPendingAction(supabase) {
  const res = await supabase
    .from('oms_orders')
    .select('id', { count: 'exact', head: true })
    .in('order_status', PENDING_ACTION_STATUSES.slice());
  if (res.error) throw res.error;
  return res.count == null ? 0 : res.count;
}

module.exports = {
  PENDING_ACTION_STATUSES,
  getKstDateContext,
  countTodayNew,
  countPendingAction,
};
