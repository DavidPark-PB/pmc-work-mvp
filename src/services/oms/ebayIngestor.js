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
const { persistRawEvent, markProcessed } = require('./channelEventService');
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

  const report = _emptyReport('ebay', days);
  report.startedAt = startedAt;

  // 1) Fetch (job-level failure is job-level — surface as jobError)
  let rawOrders;
  try {
    const api = opts.ebayApi || new EbayAPI();
    rawOrders = await api.getAwaitingShipmentOrders(days);
    if (!Array.isArray(rawOrders)) rawOrders = [];
  } catch (err) {
    report.jobError = `fetch_failed:${safeMsg(err)}`;
    report.completedAt = new Date().toISOString();
    return report;
  }

  report.fetched = rawOrders.length;
  const toProcess = limit != null ? rawOrders.slice(0, limit) : rawOrders;
  report.attempted = toProcess.length;

  // 2) Per-order pipeline (isolated)
  for (const raw of toProcess) {
    let eventId = null;
    try {
      const orderIdForRaw = raw?.ebayOrderId ?? raw?.orderId ?? null;

      // 2a) Raw event (idempotent by (channel, payload_hash) or (channel, source_event_id))
      const ev = await persistRawEvent({
        channel: 'ebay',
        externalOrderId: orderIdForRaw,
        sourceEventId: null,       // eBay Trading API does not give a stable event id
        eventType: 'poll',
        rawStatus: raw?._orderStatus ?? raw?.orderStatus ?? null,
        rawPayload: raw,
      });
      eventId = ev.id;
      if (ev.isNew) report.rawEventsInserted += 1;
      else report.rawEventsDeduped += 1;

      // 2b) Adapter
      let canonical;
      try {
        canonical = toCanonicalOrder(raw);
      } catch (err) {
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
      } catch (_err) { /* keep pending */ }

      try {
        enrichedItems = await fillCostSnapshotForItems(enrichedItems);
      } catch (_err) { /* leave cost fields null */ }

      const enrichedCanonical = { ...canonical, items: enrichedItems };

      // 2d) Persist (upsert)
      const result = await upsertCanonicalOrder(enrichedCanonical, { actorId, actorType });

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
      await markProcessed(eventId, {
        processingStatus: 'processed',
        linkedOrderId: result.orderId,
      }).catch(() => {});

    } catch (err) {
      // Any per-order exception NOT caught above — isolate.
      report.failed += 1;
      report.failures.push({ eventId, reason: 'exception', errors: [safeMsg(err)] });
      if (eventId) {
        await markProcessed(eventId, { processingStatus: 'failed', errorMessage: safeMsg(err) }).catch(() => {});
      }
    }
  }

  report.completedAt = new Date().toISOString();
  return report;
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
    itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
    itemsMatched: 0, itemsUnmatched: 0,
    failures: [],
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
