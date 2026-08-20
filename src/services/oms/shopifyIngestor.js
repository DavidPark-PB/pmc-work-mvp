/**
 * src/services/oms/shopifyIngestor.js — Shopify orders → Canonical OMS pipeline.
 *
 * Owner directive Step 5:
 *   Flow: shopifyAPI.getOrders(...)
 *     → persistRawEvent()
 *     → shopifyOrderAdapter.toCanonicalOrder()
 *     → matchCanonicalItems (existing skuMatcher)
 *     → fillCostSnapshotForItems
 *     → upsertCanonicalOrder()
 *     → markProcessed()
 *
 *   Legacy Shopify sync (orderSync.js) UNCHANGED. This is a sidecar.
 *   Multi-line grain (§5): N line_items → N canonical items.
 *   Batch isolation · idempotency · PII-free logging identical to eBay ingestor.
 */
'use strict';

const ShopifyAPI = require('../../api/shopifyAPI');
const { toCanonicalOrder } = require('./adapters/shopifyOrderAdapter');
const { persistRawEvent, markProcessed } = require('./channelEventService');
const { upsertCanonicalOrder } = require('./omsOrderService');
const { fillCostSnapshotForItems } = require('./costFiller');
const { matchCanonicalItems } = require('./omsSkuMatcher');

/**
 * Run one Shopify ingestion pass.
 *
 * @param {Object} opts
 * @param {number} [opts.days=3]                 lookback in days (created_at_min)
 * @param {number|null} [opts.limit=null]        cap orders processed
 * @param {string|null} [opts.status='any']      Shopify order status filter
 * @param {string|null} [opts.financialStatus='paid']  default 'paid' to match legacy behaviour
 * @param {number|null} [opts.actorId]
 * @param {'user'|'system'|'automation'|'external'} [opts.actorType='automation']
 * @param {Object} [opts.shopifyApi]             injectable (for tests)
 * @returns {Promise<IngestReport>}
 */
async function ingestShopify(opts = {}) {
  const days = clampInt(opts.days, 3, 1, 90);
  const limit = opts.limit != null ? Math.max(1, parseInt(opts.limit, 10)) : null;
  const status = opts.status || 'any';
  const financialStatus = opts.financialStatus || 'paid';
  const actorId = opts.actorId ?? null;
  const actorType = opts.actorType || 'automation';

  const report = _emptyReport('shopify', days);
  report.startedAt = new Date().toISOString();

  let rawOrders;
  try {
    const api = opts.shopifyApi || new ShopifyAPI();
    const createdAtMin = new Date(Date.now() - days * 86400000).toISOString();
    rawOrders = await api.getOrders({
      created_at_min: createdAtMin,
      status,
      financial_status: financialStatus,
      limit: 250,
    });
    if (!Array.isArray(rawOrders)) rawOrders = [];
  } catch (err) {
    report.jobError = `fetch_failed:${safeMsg(err)}`;
    report.completedAt = new Date().toISOString();
    return report;
  }

  report.fetched = rawOrders.length;
  const toProcess = limit != null ? rawOrders.slice(0, limit) : rawOrders;
  report.attempted = toProcess.length;

  for (const raw of toProcess) {
    let eventId = null;
    try {
      const orderIdForRaw = raw?.id != null ? String(raw.id) : null;

      // Shopify webhooks provide a stable event id in X-Shopify-Webhook-Id header, but
      // orders fetched via REST poll don't have one. Use payload_hash dedup instead.
      const ev = await persistRawEvent({
        channel: 'shopify',
        externalOrderId: orderIdForRaw,
        sourceEventId: null,
        eventType: 'poll',
        rawStatus: raw?.financial_status ?? raw?.fulfillment_status ?? null,
        rawPayload: raw,
      });
      eventId = ev.id;
      if (ev.isNew) report.rawEventsInserted += 1;
      else report.rawEventsDeduped += 1;

      let canonical;
      try { canonical = toCanonicalOrder(raw); }
      catch (err) {
        await markProcessed(eventId, { processingStatus: 'failed', errorMessage: `adapter_error:${safeMsg(err)}` }).catch(() => {});
        report.failed += 1;
        report.failures.push({ eventId, reason: 'adapter_error' });
        continue;
      }

      let enrichedItems = canonical.items;
      try {
        const matched = await matchCanonicalItems({ channel: 'shopify', items: canonical.items });
        enrichedItems = matched.map(({ item, match }) => ({
          ...item,
          productId: match.productId,
          skuMasterId: match.skuMasterId,
          matchStatus: match.matchStatus,
          matchConfidence: match.matchConfidence,
          matchReason: match.matchReason,
        }));
      } catch (_err) { /* keep pending */ }

      try { enrichedItems = await fillCostSnapshotForItems(enrichedItems); }
      catch (_err) { /* leave null */ }

      const result = await upsertCanonicalOrder({ ...canonical, items: enrichedItems }, { actorId, actorType });

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

      await markProcessed(eventId, {
        processingStatus: 'processed',
        linkedOrderId: result.orderId,
      }).catch(() => {});

    } catch (err) {
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

function _emptyReport(channel, days) {
  return {
    channel, days,
    fetched: 0, attempted: 0,
    created: 0, updated: 0, skipped: 0, invalid: 0, failed: 0,
    rawEventsInserted: 0, rawEventsDeduped: 0,
    itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0,
    itemsMatched: 0, itemsUnmatched: 0,
    failures: [],
    startedAt: null, completedAt: null, jobError: null,
  };
}
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function safeMsg(err) {
  if (!err) return 'unknown';
  return String(err.message || err).slice(0, 200);
}

module.exports = { ingestShopify, _emptyReport };
