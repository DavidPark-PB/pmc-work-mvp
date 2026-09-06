'use strict';

/**
 * R2-SHIP-6F1A · eBay Tracking Observer (2026-09-06).
 *
 * READ-only fetch of eBay Trading GetOrders with OrderStatus=Completed for a
 * bounded ModTime window · SAFE_INSERT_ONLY reconciliation into
 * `orders.tracking_no` + provenance columns from migration 110.
 *
 * Contract in one paragraph:
 *   For every eBay OrderID returned in the window, extract ALL
 *   <ShipmentTrackingDetails> observations · deduplicate identical tracking
 *   numbers (multi-line orders often replicate the same tracking across N
 *   Transactions) · classify each order as NO_TRACKING · ONE_UNIQUE_TRACKING ·
 *   MULTIPLE_DISTINCT_TRACKING · MALFORMED. Then for eligible orders
 *   (ONE_UNIQUE_TRACKING · exact `orders.order_no` + `platform='eBay'` match ·
 *   DB `tracking_no` currently NULL/empty), atomically insert-only via a
 *   conditional UPDATE that MUST NOT overwrite a value written by any other
 *   writer between fetch and write.
 *
 * What this observer NEVER does:
 *   · touch `orders.status` — tracking observation ≠ SHIPPED (R2-D1 frozen)
 *   · touch `orders.carrier` — eBay `ShippingCarrierUsed` is metadata that
 *     may disagree with PMC-side carrier semantics; owner-facing meaning differs
 *   · overwrite an existing non-null `orders.tracking_no` (SAFE_INSERT_ONLY)
 *   · write anything on a run where a page failed mid-sweep (RUN_INCOMPLETE
 *     → preserve DB, no writes anywhere · owner rule §15)
 *   · pick "first" or "last" tracking when multiple distinct values exist ·
 *     MULTIPLE_DISTINCT_TRACKING → MULTI_PACKAGE_REVIEW (no scalar write ·
 *     shipment model foundation is future R2-SHIP-6F2)
 *   · invent tracking_observed_at from order ModifiedTime / CreatedTime /
 *     orders.updated_at / NOW() (owner rule §27 · eBay does not expose a
 *     tracking-specific observation timestamp in GetOrders · leave NULL)
 *
 * Zero touch to src/api/ebayAPI.js (Phase 7A-4 unstaged hunk MUST NOT collide).
 * Uses only the deployed `EbayAPI.prototype.callTradingAPI` public primitive.
 *
 * Deployment gate: this observer is not wired to any scheduler in this phase
 * (R2-SHIP-6F1A). Scheduler activation is separate future phase R2-SHIP-6F1B.
 */

const DEFAULT_ENTRIES_PER_PAGE = 100;
const DEFAULT_DAYS_WINDOW      = 30;   // eBay ModTime max window per Trading API
const MAX_PAGES                = 30;   // runtime safety cap · far above any real day
const TRACKING_SOURCE          = 'ebay_observation';

//   OMS-SHIP-EVIDENCE-E1 (2026-09-06) · neutral evidence helper.
//     Extends per-order parsing to retain shipped_time_raw / paid_time_raw /
//     cancel_status_raw / raw_order_status / trackings[] and persists into
//     `channel_order_events` (mig 080). Evidence persistence is ADDITIVE ·
//     legacy tracking write path is byte-identical (R2-SHIP-6F1C-D frozen).
const shipmentEvidence = require('./oms/ebayShipmentEvidence');

const OUTCOME = Object.freeze({
  RUN_COMPLETE:                 'RUN_COMPLETE',
  RUN_INCOMPLETE:               'RUN_INCOMPLETE',
  //   R2-SHIP-6F1B-S · fail-closed when caller requests writes without an
  //   explicit mutation-scope contract. Write mode MUST pass eligibleStatuses.
  //   Silently defaulting to "all statuses" would authorize scope wider than
  //   the audit-validated 998 SHIPPED cohort and would break owner rule §4.
  MUTATION_SCOPE_REQUIRED:      'MUTATION_SCOPE_REQUIRED',
});

const ORDER_CLASS = Object.freeze({
  NO_TRACKING:                  'NO_TRACKING',
  ONE_UNIQUE_TRACKING:          'ONE_UNIQUE_TRACKING',
  MULTIPLE_DISTINCT_TRACKING:   'MULTIPLE_DISTINCT_TRACKING',
  MALFORMED:                    'MALFORMED',
});

const WRITE_OUTCOME = Object.freeze({
  INSERTED:                     'INSERTED',
  ALREADY_KNOWN_OR_RACED:       'ALREADY_KNOWN_OR_RACED',
  CONFLICT:                     'CONFLICT',
  MULTI_PACKAGE:                'MULTI_PACKAGE',
  DB_ORDER_NOT_ELIGIBLE:        'DB_ORDER_NOT_ELIGIBLE',
  //   R2-SHIP-6F1B-S · candidate exists but its DB status is not in the
  //   caller-supplied `eligibleStatuses` set. Observer never rewrites status
  //   (R2-D1 preserved) so this is simply a report/skip.
  NOT_ELIGIBLE_STATUS:          'NOT_ELIGIBLE_STATUS',
});

/* ─────────────────────────────── XML helpers ─────────────────────────────── */

function _extractTag(xml, tag) {
  //   Non-greedy · matches first occurrence · returns trimmed inner text or ''
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function _extractAllOrderBlocks(xml) {
  const re = /<Order>([\s\S]*?)<\/Order>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function _extractAllShipmentTracking(orderXml) {
  //   ShipmentTrackingDetails can appear at Order.ShippingDetails AND at each
  //   Transaction.ShippingDetails. Collect ALL and deduplicate later.
  const re = /<ShipmentTrackingDetails>([\s\S]*?)<\/ShipmentTrackingDetails>/g;
  const out = [];
  let m;
  while ((m = re.exec(orderXml)) !== null) {
    const inner   = m[1];
    const number  = _extractTag(inner, 'ShipmentTrackingNumber');
    const carrier = _extractTag(inner, 'ShippingCarrierUsed');
    if (number) out.push({ number, carrier });
  }
  return out;
}

function _normalizeTrackingNumber(raw) {
  //   Tracking IS a string · never coerce numerically. Owner rule §8:
  //   minimum String(x).trim() · never uppercase / strip / rewrite.
  if (raw == null) return '';
  const s = String(raw).trim();
  return s;
}

function classifyOrderObservations(rawTrackings) {
  const normalized = rawTrackings
    .map(t => ({ number: _normalizeTrackingNumber(t.number), carrier: _normalizeTrackingNumber(t.carrier) }))
    .filter(t => t.number !== '');
  if (normalized.length === 0) return { classification: ORDER_CLASS.NO_TRACKING, unique: [] };
  //   Dedupe by tracking number · retain the first-seen carrier for reporting
  const bySameNumber = new Map();
  for (const t of normalized) {
    if (!bySameNumber.has(t.number)) bySameNumber.set(t.number, t);
  }
  const unique = Array.from(bySameNumber.values());
  if (unique.length === 1) return { classification: ORDER_CLASS.ONE_UNIQUE_TRACKING, unique };
  return { classification: ORDER_CLASS.MULTIPLE_DISTINCT_TRACKING, unique };
}

/* ─────────────────────────────── GetOrders fetch ─────────────────────────── */

function _buildGetOrdersXml({ modTimeFrom, modTimeTo, page, entriesPerPage }) {
  return `
<ModTimeFrom>${modTimeFrom}</ModTimeFrom>
<ModTimeTo>${modTimeTo}</ModTimeTo>
<OrderStatus>Completed</OrderStatus>
<DetailLevel>ReturnAll</DetailLevel>
<Pagination>
  <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
  <PageNumber>${page}</PageNumber>
</Pagination>`;
}

async function fetchAllPages({ ebay, daysWindow, entriesPerPage, now }) {
  const nowTs         = now ? now() : new Date();
  const modTimeTo     = nowTs.toISOString();
  const modTimeFrom   = new Date(nowTs.getTime() - daysWindow * 86400000).toISOString();

  const allOrders     = [];
  let page            = 1;
  while (true) {
    if (page > MAX_PAGES) {
      return {
        outcome: OUTCOME.RUN_INCOMPLETE,
        reason:  'page cap exceeded',
        pageAt:  page,
        allOrders,
      };
    }
    let xml;
    try {
      xml = await ebay.callTradingAPI('GetOrders', _buildGetOrdersXml({ modTimeFrom, modTimeTo, page, entriesPerPage }));
    } catch (e) {
      return {
        outcome: OUTCOME.RUN_INCOMPLETE,
        reason:  `network/callTradingAPI error page=${page}: ${e && e.message ? e.message : String(e)}`,
        pageAt:  page,
        allOrders,
      };
    }
    const ackMatch = xml.match(/<Ack>(.*?)<\/Ack>/);
    if (!ackMatch) {
      return { outcome: OUTCOME.RUN_INCOMPLETE, reason: `Ack tag missing page=${page}`, pageAt: page, allOrders };
    }
    const ack = ackMatch[1];
    if (ack !== 'Success' && ack !== 'Warning') {
      const errMsg = _extractTag(xml, 'ShortMessage') || _extractTag(xml, 'LongMessage') || '(no message)';
      return { outcome: OUTCOME.RUN_INCOMPLETE, reason: `Ack=${ack} page=${page} · ${errMsg}`, pageAt: page, allOrders };
    }
    const orderBlocks = _extractAllOrderBlocks(xml);
    for (const orderXml of orderBlocks) {
      const orderId    = _extractTag(orderXml, 'OrderID');
      const trackings  = _extractAllShipmentTracking(orderXml);
      const { classification, unique } = classifyOrderObservations(trackings);
      //   OMS-SHIP-EVIDENCE-E1 · retain per-order raw evidence fields the
      //   existing parser previously discarded (owner rule §4). PII-free by
      //   construction: only order-lifecycle scalars + tracking scalars.
      const rawOrderStatus  = _extractTag(orderXml, 'OrderStatus')  || null;
      const shippedTimeRaw  = _extractTag(orderXml, 'ShippedTime')  || null;
      const paidTimeRaw     = _extractTag(orderXml, 'PaidTime')     || null;
      const cancelStatusRaw = _extractTag(orderXml, 'CancelStatus') || null;
      allOrders.push({
        orderId, classification, unique,
        evidence: { rawOrderStatus, shippedTimeRaw, paidTimeRaw, cancelStatusRaw, trackings: unique },
      });
    }
    const totalPagesMatch = xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
    const totalPages      = totalPagesMatch ? parseInt(totalPagesMatch[1], 10) : 1;
    if (page >= totalPages) {
      return { outcome: OUTCOME.RUN_COMPLETE, pages: totalPages, allOrders };
    }
    page += 1;
  }
}

/* ─────────────────────────────── DB matching + mutation ──────────────────── */

async function _fetchDbCohort({ db, orderIds }) {
  //   Fetch the eligible cohort in chunks so a large `IN (?, ?, ...)` never
  //   trips PostgREST URL length limits. 200 IDs per chunk is safe on the
  //   pooler for a plain equality-list SELECT. Status is fetched too so the
  //   observer can classify NOT_ELIGIBLE_STATUS accurately for reporting;
  //   the atomic UPDATE enforces status independently.
  const chunkSize = 200;
  const map       = new Map(); // order_no → { tracking_no, platform, status }
  for (let i = 0; i < orderIds.length; i += chunkSize) {
    const chunk = orderIds.slice(i, i + chunkSize);
    const { data, error } = await db
      .from('orders')
      .select('order_no, platform, tracking_no, status')
      .eq('platform', 'eBay')
      .in('order_no', chunk);
    if (error) throw new Error(`DB fetch cohort chunk starting=${i}: ${error.message}`);
    for (const row of (data || [])) {
      map.set(row.order_no, { tracking_no: row.tracking_no, platform: row.platform, status: row.status });
    }
  }
  return map;
}

async function _atomicInsertOnly({ db, orderNo, trackingNo, importedAt, eligibleStatuses }) {
  //   Atomic conditional UPDATE: only writes when
  //   platform='eBay' AND (tracking_no IS NULL OR tracking_no = '')
  //   AND (if eligibleStatuses supplied) status IN (...eligibleStatuses).
  //   Uses PostgREST .or() with .is/.eq to preserve the invariant even under
  //   concurrent writes. .select() returns the updated row (empty array if
  //   no row matched · that means race OR DB already had value OR status
  //   changed since classification OR status is not in the mutation scope).
  //
  //   R2-SHIP-6F1B-S · adding status to the atomic predicate closes the
  //   read-then-update race: if an eBay-observed SHIPPED order flipped to
  //   READY between fetch and write (or vice versa), the UPDATE returns 0
  //   rows and observer classifies as ALREADY_KNOWN_OR_RACED. No overwrite.
  const patch = {
    tracking_no:          trackingNo,
    tracking_source:      TRACKING_SOURCE,
    //   tracking_observed_at intentionally NULL · eBay GetOrders exposes no
    //   verified tracking-specific timestamp (order ModifiedTime is order-
    //   level · not tracking-specific · owner rule §27 forbids substitution)
    tracking_observed_at: null,
    tracking_imported_at: importedAt,
  };
  let query = db
    .from('orders')
    .update(patch)
    .eq('order_no', orderNo)
    .eq('platform', 'eBay')
    .or('tracking_no.is.null,tracking_no.eq.');
  if (Array.isArray(eligibleStatuses) && eligibleStatuses.length > 0) {
    query = query.in('status', eligibleStatuses);
  }
  const { data, error } = await query.select('order_no, tracking_no');
  if (error) throw new Error(`atomic insert-only ${orderNo}: ${error.message}`);
  const rows = data || [];
  return rows.length === 1;
}

/* ─────────────────────────────── main entry point ────────────────────────── */

/**
 * Run the eBay tracking observation sweep.
 *
 * @param {object} opts
 * @param {number} [opts.daysWindow=30]      ModTime window · max 30 per eBay
 * @param {number} [opts.entriesPerPage=100] GetOrders pagination page size
 * @param {boolean}[opts.dryRun=true]        Dry-run default · MUST explicitly
 *                                            pass dryRun=false for actual writes
 * @param {function}[opts.now]               time source for tests (defaults to Date)
 * @param {object} [opts.deps]               dependency injection for tests
 * @param {object} [opts.deps.ebay]          EbayAPI instance (defaults to new)
 * @param {object} [opts.deps.db]            Supabase client (defaults to getClient())
 */
async function run(opts = {}) {
  const daysWindow      = opts.daysWindow      || DEFAULT_DAYS_WINDOW;
  const entriesPerPage  = opts.entriesPerPage  || DEFAULT_ENTRIES_PER_PAGE;
  const dryRun          = opts.dryRun !== false; // default true
  const now             = opts.now;
  const deps            = opts.deps || {};
  //   R2-SHIP-6F1B-S · explicit mutation scope for write mode. Owner rule §4:
  //   write mode must NOT silently default to all-status mutation. dryRun=true
  //   observation is broad by design (used for reporting/audits); dryRun=false
  //   requires the caller to declare which order statuses may mutate.
  const eligibleStatuses = Array.isArray(opts.eligibleStatuses) && opts.eligibleStatuses.length > 0
    ? opts.eligibleStatuses.slice()
    : null;

  if (!dryRun && !eligibleStatuses) {
    return {
      counters: {
        outcome:              OUTCOME.MUTATION_SCOPE_REQUIRED,
        fetch_reason:         'dryRun=false requires opts.eligibleStatuses (non-empty array)',
        ebay_orders_seen:     0,
        no_tracking:          0,
        one_unique_tracking:  0,
        multiple_distinct:    0,
        malformed:             0,
        db_matches:           0,
        safe_insert_candidates: 0,
        already_known_or_raced: 0,
        conflict:             0,
        multi_package:        0,
        db_order_not_eligible: 0,
        not_eligible_status:  0,
        inserted:             0,
        //   OMS-SHIP-EVIDENCE-E1 · additive counters (owner rule §16, §25).
        evidence_inserted:                0,
        evidence_duplicate:               0,
        evidence_identity_unlinked:       0,
        evidence_identity_ambiguous:      0,
        evidence_error:                   0,
        legacy_skipped_due_to_evidence:   0,
      },
      decisions: [],
    };
  }

  const ebay            = deps.ebay || (() => { const EbayAPI = require('../api/ebayAPI'); return new EbayAPI(); })();
  const db              = deps.db   || (() => { const { getClient } = require('../db/supabaseClient'); return getClient(); })();

  //   STEP 1 · fetch all pages first · do NOT interleave DB writes
  const fetchResult = await fetchAllPages({ ebay, daysWindow, entriesPerPage, now });
  const counters = {
    outcome:                 fetchResult.outcome,
    fetch_reason:            fetchResult.reason || null,
    fetch_pageAt:            fetchResult.pageAt || null,
    ebay_orders_seen:        fetchResult.allOrders.length,
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
    //   OMS-SHIP-EVIDENCE-E1 · additive counters (owner rule §16, §25).
    evidence_inserted:                0,
    evidence_duplicate:               0,
    evidence_identity_unlinked:       0,
    evidence_identity_ambiguous:      0,
    evidence_error:                   0,
    legacy_skipped_due_to_evidence:   0,
  };

  //   STEP 2 · if RUN_INCOMPLETE · preserve DB · report and stop (owner §15)
  if (fetchResult.outcome === OUTCOME.RUN_INCOMPLETE) {
    return { counters, decisions: [] };
  }

  //   STEP 3 · per-order classification counters
  for (const o of fetchResult.allOrders) {
    if (o.classification === ORDER_CLASS.NO_TRACKING)                 counters.no_tracking++;
    else if (o.classification === ORDER_CLASS.ONE_UNIQUE_TRACKING)    counters.one_unique_tracking++;
    else if (o.classification === ORDER_CLASS.MULTIPLE_DISTINCT_TRACKING) counters.multiple_distinct++;
    else if (o.classification === ORDER_CLASS.MALFORMED)              counters.malformed++;
  }

  //   OMS-SHIP-EVIDENCE-E1 · STEP 3b · persist neutral shipment evidence.
  //   Runs AFTER fetch-all-first succeeds and BEFORE the legacy tracking loop
  //   (owner rule §23). Skipped entirely on dryRun (owner rule §15).
  //
  //   Per-order isolation: evidence persistence failure for order X flags X
  //   as `evidenceFailedOrderIds` so the existing legacy write skips X
  //   (evidence-first truth · §23 conservative contract). Other orders'
  //   legacy writes proceed unaffected — R2-SHIP availability is preserved
  //   under healthy Supabase operation (INSERT ... ON CONFLICT is highly
  //   reliable; only genuine infra faults trigger evidence_error).
  const importedAt = (now ? now() : new Date()).toISOString();
  const evidenceFailedOrderIds = new Set();
  if (!dryRun) {
    for (const o of fetchResult.allOrders) {
      try {
        const canonical = shipmentEvidence.buildEvidenceCanonical({
          orderId:         o.orderId,
          rawOrderStatus:  o.evidence.rawOrderStatus,
          shippedTimeRaw:  o.evidence.shippedTimeRaw,
          paidTimeRaw:     o.evidence.paidTimeRaw,
          cancelStatusRaw: o.evidence.cancelStatusRaw,
          trackings:       o.evidence.trackings,
        });
        const hash = shipmentEvidence.hashEvidence(canonical);
        const resolved = await shipmentEvidence.resolveOmsLinkedOrderId(db, o.orderId);
        if (resolved.ambiguous)                    counters.evidence_identity_ambiguous++;
        else if (resolved.linkedOrderId == null)   counters.evidence_identity_unlinked++;
        const persist = await shipmentEvidence.persistEvidence(db, {
          canonical,
          hash,
          externalOrderId: o.orderId,
          rawStatus:       o.evidence.rawOrderStatus,
          importedAt,
          linkedOrderId:   resolved.linkedOrderId,
        });
        if (persist.inserted)      counters.evidence_inserted++;
        else if (persist.duplicate) counters.evidence_duplicate++;
      } catch (e) {
        counters.evidence_error++;
        evidenceFailedOrderIds.add(o.orderId);
        console.error(`[ebayTrackingObserver] evidence persistence failed order=${o.orderId} · ${e && e.message ? e.message : String(e)}`);
      }
    }
  }

  //   STEP 4 · DB cohort match against ALL scanned OrderIDs (regardless of
  //   classification · so we can also report already_known / conflict against
  //   eBay's view). Only ONE_UNIQUE candidates go to the writer.
  const eligibleOrderIds = fetchResult.allOrders
    .filter(o => o.classification === ORDER_CLASS.ONE_UNIQUE_TRACKING)
    .map(o => o.orderId);

  const dbMap = eligibleOrderIds.length > 0
    ? await _fetchDbCohort({ db, orderIds: eligibleOrderIds })
    : new Map();
  counters.db_matches = dbMap.size;

  //   STEP 5 · decide + optionally mutate
  const decisions = [];
  //   `importedAt` computed above (STEP 3b) so evidence + legacy write share
  //   the same server-clock instant. Reused verbatim here.
  for (const o of fetchResult.allOrders) {
    if (o.classification !== ORDER_CLASS.ONE_UNIQUE_TRACKING) {
      if (o.classification === ORDER_CLASS.MULTIPLE_DISTINCT_TRACKING) {
        counters.multi_package++;
        decisions.push({ orderId: o.orderId, outcome: WRITE_OUTCOME.MULTI_PACKAGE, trackings: o.unique.map(x => x.number) });
      }
      continue;
    }
    //   OMS-SHIP-EVIDENCE-E1 · owner rule §23 conservative contract:
    //     evidence persistence failure for this order → skip legacy mutation.
    //     Other orders remain unaffected. R2-SHIP legacy write path is
    //     otherwise byte-identical below.
    if (evidenceFailedOrderIds.has(o.orderId)) {
      counters.legacy_skipped_due_to_evidence++;
      decisions.push({ orderId: o.orderId, outcome: 'LEGACY_SKIPPED_EVIDENCE_ERROR' });
      continue;
    }
    const dbRow = dbMap.get(o.orderId);
    if (!dbRow) {
      counters.db_order_not_eligible++;
      decisions.push({ orderId: o.orderId, outcome: WRITE_OUTCOME.DB_ORDER_NOT_ELIGIBLE });
      continue;
    }
    const observedNumber = o.unique[0].number;
    const dbTracking     = (dbRow.tracking_no || '').trim();
    if (dbTracking !== '') {
      if (dbTracking === observedNumber) {
        counters.already_known_or_raced++;
        decisions.push({ orderId: o.orderId, outcome: WRITE_OUTCOME.ALREADY_KNOWN_OR_RACED });
      } else {
        counters.conflict++;
        decisions.push({
          orderId:      o.orderId,
          outcome:      WRITE_OUTCOME.CONFLICT,
          dbTracking,
          ebayTracking: observedNumber,
        });
      }
      continue;
    }
    //   R2-SHIP-6F1B-S · when eligibleStatuses is provided (write mode always;
    //   dry-run optional), classify candidates whose DB status is outside the
    //   scope as NOT_ELIGIBLE_STATUS. This reports the population accurately
    //   without hiding it from the counter; the atomic UPDATE independently
    //   enforces the same predicate so a race (SHIPPED → READY between fetch
    //   and update) results in 0 rows written, not an overwrite.
    if (eligibleStatuses && !eligibleStatuses.includes(dbRow.status)) {
      counters.not_eligible_status++;
      decisions.push({
        orderId:  o.orderId,
        outcome:  WRITE_OUTCOME.NOT_ELIGIBLE_STATUS,
        dbStatus: dbRow.status,
        tracking: observedNumber,
      });
      continue;
    }
    counters.safe_insert_candidates++;
    if (dryRun) {
      //   Dry-run · classify as candidate but do NOT touch DB
      decisions.push({
        orderId:  o.orderId,
        outcome:  'DRY_RUN_CANDIDATE',
        tracking: observedNumber,
        dbStatus: dbRow.status,
      });
      continue;
    }
    //   Write mode · atomic insert-only · status predicate enforced in DB
    const inserted = await _atomicInsertOnly({
      db,
      orderNo:          o.orderId,
      trackingNo:       observedNumber,
      importedAt,
      eligibleStatuses,
    });
    if (inserted) {
      counters.inserted++;
      decisions.push({ orderId: o.orderId, outcome: WRITE_OUTCOME.INSERTED, tracking: observedNumber });
    } else {
      //   Row didn't match the condition between fetch and update · either
      //   already populated by concurrent writer (SAFE) or platform not eBay.
      counters.already_known_or_raced++;
      decisions.push({ orderId: o.orderId, outcome: WRITE_OUTCOME.ALREADY_KNOWN_OR_RACED });
    }
  }

  return { counters, decisions };
}

module.exports = {
  run,
  //   Exposed for behavioural tests only · do not import from other callers.
  _internals: {
    _extractTag,
    _extractAllOrderBlocks,
    _extractAllShipmentTracking,
    _normalizeTrackingNumber,
    classifyOrderObservations,
    fetchAllPages,
    OUTCOME,
    ORDER_CLASS,
    WRITE_OUTCOME,
    TRACKING_SOURCE,
  },
};
