/**
 * src/services/oms/ebayIngestor.js — eBay orders → Canonical OMS pipeline.
 *
 * Owner directive §4 · §5 · §7 · §9:
 *   Flow: eBayAPI.getAwaitingShipmentOrders()
 *     → persistRawEvent()
 *     → ebayOrderAdapter.toCanonicalOrder()
 *     → validate (implicit in upsertCanonicalOrder)
 *     → upsertCanonicalOrder()
 *     → markProcessed()
 *   Batch isolation (§7): one order fail ≠ whole job fail.
 *   Legacy orderSync unchanged (§5) — this is a sidecar.
 *
 * PII logging (§18): only ids/counts/status codes to logs — never buyer email/phone/raw payload.
 */
'use strict';

const EbayAPI = require('../../api/ebayAPI');
const { toCanonicalOrder } = require('./adapters/ebayOrderAdapter');
const {
  persistRawEvent, markProcessed,
  //   Phase 8P-20.8C · bulk prefetch + canonical identity hasher (single source of truth)
  prefetchExistingEvents, payloadHash,
} = require('./channelEventService');
const { upsertCanonicalOrder } = require('./omsOrderService');
const { fillCostSnapshotForItems } = require('./costFiller');
const { matchCanonicalItems } = require('./omsSkuMatcher');

/**
 * Run one eBay ingestion pass over the awaiting-shipment window.
 *
 * @param {Object} opts
 * @param {number} [opts.days=7]           lookback window (max 30 · eBay ModTime)
 * @param {number} [opts.limit=null]       cap orders processed this run (safety)
 * @param {number|null} [opts.actorId]     who triggered (nullable — system)
 * @param {'user'|'system'|'automation'|'external'} [opts.actorType='automation']
 * @param {Object} [opts.ebayApi]          injectable — defaults to `new EbayAPI()`
 * @returns {Promise<IngestReport>}
 */
async function ingestEbay(opts = {}) {
  const days = clampInt(opts.days, 7, 1, 30);
  const limit = opts.limit != null ? Math.max(1, parseInt(opts.limit, 10)) : null;
  const actorId = opts.actorId ?? null;
  const actorType = opts.actorType || 'automation';
  const startedAt = new Date().toISOString();
  // Phase 8P-20.7 · injectable stage logger (defaults to console.log).
  // Zero PII / zero raw payload / zero credential in stage records.
  const stageLog = typeof opts.stageLog === 'function' ? opts.stageLog : (m) => console.log(m);
  const _stageStart = (stage) => {
    const t = Date.now();
    stageLog(`OMS_EBAY_STAGE_START stage=${stage} ts=${new Date(t).toISOString()}`);
    return t;
  };
  const _stageDone = (stage, t0, extra = '') => {
    stageLog(`OMS_EBAY_STAGE_DONE stage=${stage} elapsed_ms=${Date.now() - t0}${extra ? ' ' + extra : ''}`);
  };
  const _stageFail = (stage, t0, errClass, err) => {
    const msg = _safeStageMsg(err);
    stageLog(`OMS_EBAY_STAGE_FAIL stage=${stage} elapsed_ms=${Date.now() - t0} error_class=${errClass} message=${msg}`);
  };

  const report = _emptyReport('ebay', days);
  report.startedAt = startedAt;

  // 1) Fetch (job-level failure is job-level — surface as jobError)
  let rawOrders;
  const tFetch = _stageStart('ebay_api_fetch');
  try {
    const api = opts.ebayApi || new EbayAPI();
    rawOrders = await api.getAwaitingShipmentOrders(days, { stageLog });
    if (!Array.isArray(rawOrders)) rawOrders = [];
    _stageDone('ebay_api_fetch', tFetch, `orders_fetched=${rawOrders.length}`);
  } catch (err) {
    const errClass = _classifyError(err);
    _stageFail('ebay_api_fetch', tFetch, errClass, err);
    report.jobError = `fetch_failed:${safeMsg(err)}`;
    report.completedAt = new Date().toISOString();
    stageLog(`OMS_EBAY_STAGE_DONE stage=final_report elapsed_ms=${Date.now() - Date.parse(startedAt)} jobError=1`);
    return report;
  }

  report.fetched = rawOrders.length;
  const toProcess = limit != null ? rawOrders.slice(0, limit) : rawOrders;
  report.attempted = toProcess.length;

  //   Phase 8P-20.8C · Pre-compute event identity ONCE per order (single canonical
  //   payloadHash source), then bulk-prefetch existing rows. eBay never provides
  //   a stable source_event_id, so all candidates use the payload_hash identity.
  //   The channelEventService.prefetchExistingEvents contract still handles the
  //   source_event_id case for future channels.
  const candidates = toProcess.map((raw) => ({
    sourceEventId: null,   // eBay Trading API has no stable event id
    payloadHash: payloadHash(raw),
  }));
  const tPrefetch = _stageStart('event_prefetch');
  let prefetch = { resolve: () => null, stats: { queries: 0, rowsFound: 0, elapsedMs: 0 } };
  try {
    prefetch = await prefetchExistingEvents({ channel: 'ebay', candidates });
    _stageDone('event_prefetch', tPrefetch, `rows=${prefetch.stats.rowsFound} queries=${prefetch.stats.queries}`);
  } catch (err) {
    //   Fail OPEN · a prefetch failure MUST NOT abort the whole tick. The per-order
    //   persistRawEvent still runs (INSERT + fallback SELECT) and correctness is preserved.
    _stageFail('event_prefetch', tPrefetch, _classifyError(err), err);
  }
  report.timings.prefetchMs = prefetch.stats.elapsedMs;
  report.prefetchQueries = prefetch.stats.queries;
  report.prefetchRowsFound = prefetch.stats.rowsFound;

  // 2) Per-order pipeline (isolated)
  let orderIdx = 0;
  for (const raw of toProcess) {
    let eventId = null;
    orderIdx += 1;
    try {
      const orderIdForRaw = raw?.ebayOrderId ?? raw?.orderId ?? null;

      // 2a) Raw event (idempotent by (channel, payload_hash) or (channel, source_event_id))
      //   Phase 8P-20.8B · per-order stageObserver adapter emits OMS_EBAY_STAGE_*
      //   for the two DB boundaries inside persistRawEvent (INSERT, DUPLICATE_LOOKUP)
      //   AND accumulates elapsed_ms into aggregate report.timings / metrics.
      //   Phase 8P-20.8C · pass the prefetched hint. Verified hits skip the INSERT
      //   entirely; misses or unverified hints fall back to the authoritative path.
      const tPersist = _stageStart(`raw_event_persist#${orderIdx}`);
      const hint = prefetch.resolve(candidates[orderIdx - 1]);
      const ev = await persistRawEvent({
        channel: 'ebay',
        externalOrderId: orderIdForRaw,
        sourceEventId: null,       // eBay Trading API does not give a stable event id
        eventType: 'poll',
        rawStatus: raw?._orderStatus ?? raw?.orderStatus ?? null,
        rawPayload: raw,
        stageObserver: _makeChannelEventObserver(orderIdx, stageLog, report),
        existingEventHint: hint,
      });
      _stageDone(`raw_event_persist#${orderIdx}`, tPersist, `is_new=${ev.isNew ? 1 : 0}${ev.source === 'prefetch' ? ' source=prefetch' : ''}`);
      //   Aggregate the whole-boundary wall-clock. Note: rawEventPersistMs
      //   INCLUDES both DB sub-boundaries + JS/hash/serialize overhead — see
      //   "Timing composition" note in _emptyReport.
      report.timings.rawEventPersistMs += Date.now() - tPersist;
      //   Phase 8P-20.8C · classify the outcome
      if (ev.source === 'prefetch') {
        report.prefetchHits += 1;
      } else {
        report.prefetchMisses += 1;
        //   Race fallback: prefetch had a hint but persistRawEvent did NOT return
        //   source='prefetch' (hint failed to verify OR was absent). If the event
        //   turned out to already exist, the duplicate_lookup boundary fired
        //   inside persistRawEvent — count it as a race fallback.
        if (!ev.isNew) report.prefetchRaceFallbacks += 1;
      }
      eventId = ev.id;
      if (ev.isNew) report.rawEventsInserted += 1;
      else report.rawEventsDeduped += 1;

      // 2a-bis) Phase 8P-20.8A short-circuit.
      //   If this event is a byte-identical duplicate we already processed to
      //   completion (processing_status='processed' AND linked_order_id NOT NULL),
      //   skip the entire downstream pipeline. Existing canonical row is authoritative.
      //   SAFETY:
      //     - eBay payload_hash unchanged → adapter output would be identical
      //     - upsertCanonicalOrder would have produced status='skipped' (patch empty)
      //     - No delete / no mutation on the skip path
      //     - New/changed payloads still hit the full pipeline (isNew=true)
      //     - pending/failed and processed-but-linked-null events still retry (fall through)
      //   TRADE-OFF (documented):
      //     - Removes the implicit rematch-on-every-tick behavior. Historical
      //       unmatched / cost-null rows will remain until a separate
      //       Owner-triggered rematch/backfill job runs. See docs/PHASE-8P-20-8A-*.md
      //       (out-of-scope for this phase).
      if (!ev.isNew && ev.processingStatus === 'processed' && ev.linkedOrderId != null) {
        const tSc = _stageStart(`short_circuit_already_processed#${orderIdx}`);
        report.shortCircuited = (report.shortCircuited || 0) + 1;
        _stageDone(`short_circuit_already_processed#${orderIdx}`, tSc, `linked_order_id=${ev.linkedOrderId}`);
        continue;
      }

      // 2b) Adapter
      let canonical;
      const tAdapt = _stageStart(`canonical_adapt_validate#${orderIdx}`);
      try {
        canonical = toCanonicalOrder(raw);
        _stageDone(`canonical_adapt_validate#${orderIdx}`, tAdapt, `items=${canonical.items?.length ?? 0}`);
      } catch (err) {
        _stageFail(`canonical_adapt_validate#${orderIdx}`, tAdapt, 'adapter_error', err);
        await markProcessed(eventId, {
          processingStatus: 'failed',
          errorMessage: `adapter_error:${safeMsg(err)}`,
        }).catch(() => {});
        report.failed += 1;
        report.failures.push({ eventId, reason: 'adapter_error' });
        continue;
      }

      // 2c) SKU match + cost fill BEFORE persistence
      let enrichedItems = canonical.items;
      const tMatch = _stageStart(`sku_match#${orderIdx}`);
      try {
        const matched = await matchCanonicalItems({ channel: 'ebay', items: canonical.items });
        enrichedItems = matched.map(({ item, match }) => ({
          ...item,
          productId: match.productId,
          skuMasterId: match.skuMasterId,
          matchStatus: match.matchStatus,
          matchConfidence: match.matchConfidence,
          matchReason: match.matchReason,
        }));
        _stageDone(`sku_match#${orderIdx}`, tMatch, `enriched=${enrichedItems.length}`);
      } catch (_err) {
        _stageFail(`sku_match#${orderIdx}`, tMatch, 'match_error', _err);
        /* keep pending */
      }

      const tCost = _stageStart(`cost_fill#${orderIdx}`);
      try {
        enrichedItems = await fillCostSnapshotForItems(enrichedItems);
        _stageDone(`cost_fill#${orderIdx}`, tCost);
      } catch (_err) {
        _stageFail(`cost_fill#${orderIdx}`, tCost, 'cost_error', _err);
        /* leave cost fields null */
      }

      const enrichedCanonical = { ...canonical, items: enrichedItems };

      // 2d) Persist (upsert)
      const tUpsert = _stageStart(`oms_order_upsert#${orderIdx}`);
      const result = await upsertCanonicalOrder(enrichedCanonical, { actorId, actorType });
      _stageDone(`oms_order_upsert#${orderIdx}`, tUpsert, `status=${result.status}`);

      // Tally per-order
      switch (result.status) {
        case 'created': report.created += 1; break;
        case 'updated': report.updated += 1; break;
        case 'skipped': report.skipped += 1; break;
        case 'invalid': {
          report.invalid += 1;
          report.failures.push({ eventId, reason: 'validation', errors: (result.validation?.errors || []).slice(0, 3) });
          await markProcessed(eventId, {
            processingStatus: 'failed',
            errorMessage: `validation:${(result.validation?.errors || []).slice(0, 2).join('|')}`,
          }).catch(() => {});
          continue;
        }
        case 'error': {
          report.failed += 1;
          report.failures.push({ eventId, reason: 'persist', errors: [result.error || 'unknown'] });
          await markProcessed(eventId, {
            processingStatus: 'failed',
            errorMessage: `persist:${result.error || 'unknown'}`,
          }).catch(() => {});
          continue;
        }
      }

      report.itemsInserted += result.itemsInserted || 0;
      report.itemsUpdated += result.itemsUpdated || 0;
      report.itemsSkipped += result.itemsSkipped || 0;
      report.itemsMatched += result.itemsMatched || 0;
      report.itemsUnmatched += result.itemsUnmatched || 0;

      // 2e) Mark raw event processed + linked
      const tMark = _stageStart(`mark_processed#${orderIdx}`);
      await markProcessed(eventId, {
        processingStatus: 'processed',
        linkedOrderId: result.orderId,
      }).catch((e) => { _stageFail(`mark_processed#${orderIdx}`, tMark, 'mark_error', e); });
      _stageDone(`mark_processed#${orderIdx}`, tMark);

    } catch (err) {
      // Any per-order exception NOT caught above — isolate.
      _stageFail(`per_order#${orderIdx}`, Date.now(), 'per_order_exception', err);
      report.failed += 1;
      report.failures.push({ eventId, reason: 'exception', errors: [safeMsg(err)] });
      if (eventId) {
        await markProcessed(eventId, { processingStatus: 'failed', errorMessage: safeMsg(err) }).catch(() => {});
      }
    }
  }

  report.completedAt = new Date().toISOString();
  //   Phase 8P-20.8B · aggregate DB-boundary profiling in final_report line so
  //   Owner can grep exactly where wall-clock was spent, without per-order noise.
  stageLog(
    `OMS_EBAY_STAGE_DONE stage=final_report elapsed_ms=${Date.now() - Date.parse(startedAt)}` +
    ` orders=${report.attempted} created=${report.created} updated=${report.updated} failed=${report.failed}` +
    ` short_circuited=${report.shortCircuited || 0}` +
    ` raw_event_persist_ms=${report.timings.rawEventPersistMs}` +
    ` event_insert_ms=${report.timings.channelEventInsertMs}` +
    ` duplicate_lookup_ms=${report.timings.channelEventDuplicateLookupMs}` +
    ` event_insert_new=${report.eventInsertNew}` +
    ` event_insert_duplicate=${report.eventInsertDuplicate}` +
    ` duplicate_lookup_count=${report.duplicateLookupCount}` +
    //   Phase 8P-20.8C · bulk-prefetch attribution
    ` prefetch_ms=${report.timings.prefetchMs || 0}` +
    ` prefetch_queries=${report.prefetchQueries || 0}` +
    ` prefetch_rows_found=${report.prefetchRowsFound || 0}` +
    ` prefetch_hits=${report.prefetchHits || 0}` +
    ` prefetch_misses=${report.prefetchMisses || 0}` +
    ` prefetch_fallback_duplicate_lookups=${report.prefetchRaceFallbacks || 0}`
  );
  return report;
}

// ─────────────────────────────────────────────────────────────
// Phase 8P-20.8B · per-order channelEventService stageObserver adapter.
// Formats generic (stageName, phase, meta) events into OMS_EBAY_STAGE_* lines
// with the parent order suffix, AND accumulates timings/metrics into the report.
// Zero PII / zero raw payload / zero credential — meta comes from a service
// that never receives buyer data.
// ─────────────────────────────────────────────────────────────
function _makeChannelEventObserver(orderIdx, stageLog, report) {
  const suffix = `#${orderIdx}`;
  return function observer(stageName, phase, meta) {
    const stage = `${stageName}${suffix}`;
    if (phase === 'start') {
      stageLog(`OMS_EBAY_STAGE_START stage=${stage} ts=${new Date().toISOString()}`);
      return;
    }
    if (phase === 'done') {
      const el = meta && Number.isFinite(meta.elapsedMs) ? meta.elapsedMs : 0;
      let extra = '';
      if (stageName === 'channel_event_insert') {
        report.timings.channelEventInsertMs += el;
        if (meta && meta.isNew === true) {
          report.eventInsertNew += 1;
          extra = ' is_new=1';
        } else if (meta && meta.isNew === false) {
          report.eventInsertDuplicate += 1;
          extra = ' is_new=0';
        }
      } else if (stageName === 'channel_event_duplicate_lookup') {
        report.timings.channelEventDuplicateLookupMs += el;
        report.duplicateLookupCount += 1;
      }
      stageLog(`OMS_EBAY_STAGE_DONE stage=${stage} elapsed_ms=${el}${extra}`);
      return;
    }
    if (phase === 'fail') {
      const el = meta && Number.isFinite(meta.elapsedMs) ? meta.elapsedMs : 0;
      const errClass = (meta && meta.errorClass) || 'unknown';
      const msg = _safeStageMsg({ message: (meta && meta.message) || '' });
      stageLog(`OMS_EBAY_STAGE_FAIL stage=${stage} elapsed_ms=${el} error_class=${errClass} message=${msg}`);
      return;
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Stage helpers — safe (no PII, no raw payload, no secrets)
// ─────────────────────────────────────────────────────────────
function _safeStageMsg(err) {
  if (!err) return 'unknown';
  const m = String(err.message || err);
  // Strip potential PII-shaped fields (emails, phone-like sequences) then truncate.
  return m
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\+?\d[\d\s\-()]{7,}\d/g, '<phone>')
    .slice(0, 200);
}
function _classifyError(err) {
  const s = String(err?.message || err || '');
  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(s)) return 'timeout';
  if (/auth|token|expired|unauthor|forbidden|IP_NOT_ALLOWED/i.test(s)) return 'auth';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|network|ENETUNREACH/i.test(s)) return 'network';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────
// Report shape (PII-free)
// ─────────────────────────────────────────────────────────────
/**
 * @typedef {Object} IngestReport
 * @property {string}  channel
 * @property {number}  days
 * @property {number}  fetched
 * @property {number}  attempted
 * @property {number}  created
 * @property {number}  updated
 * @property {number}  skipped
 * @property {number}  invalid
 * @property {number}  failed
 * @property {number}  rawEventsInserted
 * @property {number}  rawEventsDeduped
 * @property {number}  itemsInserted
 * @property {number}  itemsUpdated
 * @property {number}  itemsSkipped
 * @property {number}  itemsMatched
 * @property {number}  itemsUnmatched
 * @property {Array<{ eventId:number|null, reason:string, errors?:string[] }>} failures
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} jobError
 */
function _emptyReport(channel, days) {
  return {
    channel, days,
    fetched: 0, attempted: 0,
    created: 0, updated: 0, skipped: 0, invalid: 0, failed: 0,
    rawEventsInserted: 0, rawEventsDeduped: 0,
    //   Phase 8P-20.8A · orders skipped via already-processed short-circuit
    //   (distinct from `skipped` which comes from upsertCanonicalOrder no-op).
    shortCircuited: 0,
    itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
    itemsMatched: 0, itemsUnmatched: 0,
    failures: [],
    //   Phase 8P-20.8B · DB-boundary profiling aggregates.
    //   Timing composition (avoid double-counting confusion):
    //     rawEventPersistMs        · total wall-clock inside persistRawEvent
    //                                 (INCLUDES the two sub-boundaries below
    //                                 PLUS JS overhead: hash, serialize, meta build).
    //     channelEventInsertMs     · SUM of just the INSERT boundary durations
    //                                 (fires for every order; either succeeds or
    //                                 23505-unique-violates → both count).
    //     channelEventDuplicateLookupMs · SUM of just the DUPLICATE_LOOKUP
    //                                 boundary durations (fires ONLY on isNew=false).
    //   Invariant: rawEventPersistMs ≥ channelEventInsertMs + channelEventDuplicateLookupMs
    timings: {
      rawEventPersistMs: 0,
      channelEventInsertMs: 0,
      channelEventDuplicateLookupMs: 0,
      //   Phase 8P-20.8C · bulk prefetch wall-clock (single upfront pass)
      prefetchMs: 0,
    },
    //   Phase 8P-20.8B · Count metrics (Task 5).
    //   eventInsertNew        · rows newly created (isNew=true) in channel_order_events
    //   eventInsertDuplicate  · rows that hit the UNIQUE index (isNew=false)
    //   duplicateLookupCount  · number of duplicate-lookup SELECTs actually issued
    //     Invariant: eventInsertNew + eventInsertDuplicate === attempted (barring persist failures)
    //     Invariant: duplicateLookupCount === eventInsertDuplicate
    eventInsertNew: 0,
    eventInsertDuplicate: 0,
    duplicateLookupCount: 0,
    //   Phase 8P-20.8C · bulk-prefetch metrics.
    //     prefetchQueries              · number of bounded IN(...) SELECTs issued
    //     prefetchRowsFound            · rows returned by prefetch (any state)
    //     prefetchHits                 · orders whose persistRawEvent short-circuited via verified hint
    //     prefetchMisses               · orders whose persistRawEvent went through the standard path
    //     prefetchRaceFallbacks        · subset of misses where the event turned out to already exist
    //                                     (race between prefetch and INSERT — the DB duplicate SELECT
    //                                     fallback fires; DB UNIQUE remains authoritative)
    //     Invariant: prefetchHits + prefetchMisses === attempted (barring per-order exceptions before persist)
    //     Invariant: prefetchRaceFallbacks <= duplicateLookupCount
    prefetchQueries: 0,
    prefetchRowsFound: 0,
    prefetchHits: 0,
    prefetchMisses: 0,
    prefetchRaceFallbacks: 0,
    startedAt: null, completedAt: null,
    jobError: null,
  };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function safeMsg(err) {
  if (!err) return 'unknown';
  const m = err.message || String(err);
  return String(m).slice(0, 200);
}

module.exports = { ingestEbay, _emptyReport };
