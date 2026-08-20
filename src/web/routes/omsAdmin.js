/**
 * src/web/routes/omsAdmin.js — Admin-only OMS ingestion + reconciliation.
 *
 * Owner directive §6 · §17:
 *   Admin-only endpoints. Manual trigger. Scheduler 자동 연결 X.
 *   최소 상태 표시 — 화려한 dashboard 아님, 운영 확인용.
 *
 * Routes:
 *   POST /api/oms-admin/ingest/ebay          — Trigger one eBay ingestion pass (admin)
 *   GET  /api/oms-admin/reconcile/ebay       — Legacy vs canonical diff (admin)
 *   GET  /api/oms-admin/status               — Recent ingestion counts + reconcile snapshot (admin)
 */
'use strict';

const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { getClient } = require('../../db/supabaseClient');
const { ingestEbay } = require('../../services/oms/ebayIngestor');
const { ingestShopify } = require('../../services/oms/shopifyIngestor');
const {
  reconcileEbay, reconcileEbayByLatestIngested,
  reconcileShopify, reconcileShopifyByLatestIngested,
} = require('../../services/oms/reconcile');
const { linkOrderItemToSku, listUnmatchedItems } = require('../../services/oms/skuMappingService');
const { getBaselineProposal, applyInitialBaseline } = require('../../services/oms/inventoryBaselineService');
const { proposeLifecycleForOrder, applyLifecycleForOrder } = require('../../services/oms/inventoryLifecycleService');

const router = express.Router();
router.use(requireAdmin);

const MAX_INGEST_LIMIT = 500;

// ── POST /api/oms-admin/ingest/ebay ─────────────────────────
router.post('/ingest/ebay', async (req, res) => {
  const days = clampInt(req.body?.days ?? req.query?.days, 7, 1, 30);
  const limit = req.body?.limit != null
    ? Math.max(1, Math.min(MAX_INGEST_LIMIT, parseInt(req.body.limit, 10) || 1))
    : null;
  const actorId = req.user?.id ?? null;

  try {
    const report = await ingestEbay({ days, limit, actorId, actorType: 'user' });
    // Log summary only — no PII
    console.log(`[oms-admin/ingest/ebay] actor=${actorId} days=${days} `
      + `fetched=${report.fetched} created=${report.created} updated=${report.updated} `
      + `failed=${report.failed} invalid=${report.invalid}`);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'ingest_failed', message: err.message || String(err) });
  }
});

// ── GET /api/oms-admin/reconcile/ebay ───────────────────────
// Query:
//   ?latestIngest=10             identity-first (RECOMMENDED for small runs)
//   ?hours=24                    window on ordered_at
//   ?days=1&field=imported_at    window on imported_at
router.get('/reconcile/ebay', async (req, res) => {
  try {
    const latestIngest = req.query?.latestIngest != null
      ? Math.max(1, Math.min(500, parseInt(req.query.latestIngest, 10)))
      : null;
    if (latestIngest != null) {
      return res.json(await reconcileEbayByLatestIngested({ latestIngest }));
    }
    const hours = req.query?.hours != null ? clampInt(req.query.hours, 24, 1, 2160) : null;
    const days = req.query?.days != null ? clampInt(req.query.days, 1, 1, 90) : null;
    const field = req.query?.field === 'imported_at' ? 'imported_at' : 'ordered_at';
    const report = await reconcileEbay({ hours, days, field });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'reconcile_failed', message: err.message || String(err) });
  }
});

// ── POST /api/oms-admin/ingest/shopify ──────────────────────
router.post('/ingest/shopify', async (req, res) => {
  const days = clampInt(req.body?.days ?? req.query?.days, 3, 1, 90);
  const limit = req.body?.limit != null
    ? Math.max(1, Math.min(MAX_INGEST_LIMIT, parseInt(req.body.limit, 10) || 1))
    : 10;
  const status = req.body?.status || 'any';
  const financialStatus = req.body?.financialStatus || 'paid';
  const actorId = req.user?.id ?? null;

  try {
    const report = await ingestShopify({ days, limit, status, financialStatus, actorId, actorType: 'user' });
    console.log(`[oms-admin/ingest/shopify] actor=${actorId} days=${days} limit=${limit} `
      + `fetched=${report.fetched} created=${report.created} updated=${report.updated} `
      + `failed=${report.failed} invalid=${report.invalid}`);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'ingest_failed', message: err.message || String(err) });
  }
});

// ── GET /api/oms-admin/reconcile/shopify ────────────────────
router.get('/reconcile/shopify', async (req, res) => {
  try {
    const latestIngest = req.query?.latestIngest != null
      ? Math.max(1, Math.min(500, parseInt(req.query.latestIngest, 10)))
      : null;
    if (latestIngest != null) {
      return res.json(await reconcileShopifyByLatestIngested({ latestIngest }));
    }
    const hours = req.query?.hours != null ? clampInt(req.query.hours, 24, 1, 2160) : null;
    const days = req.query?.days != null ? clampInt(req.query.days, 3, 1, 90) : null;
    const field = req.query?.field === 'imported_at' ? 'imported_at' : 'ordered_at';
    const report = await reconcileShopify({ hours, days, field });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'reconcile_failed', message: err.message || String(err) });
  }
});

// ── GET /api/oms-admin/unmatched-items ─────────────────────
// Query: ?channel=shopify | ebay · ?limit · ?offset
router.get('/unmatched-items', async (req, res) => {
  try {
    const channel = req.query?.channel ? String(req.query.channel).trim().toLowerCase() : null;
    const limit = req.query?.limit != null ? parseInt(req.query.limit, 10) : 100;
    const offset = req.query?.offset != null ? parseInt(req.query.offset, 10) : 0;
    const rows = await listUnmatchedItems({ channel, limit, offset });
    res.json({ count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ error: 'list_failed', message: err.message || String(err) });
  }
});

// ── POST /api/oms-admin/order-items/:id/link-sku ───────────
// Body: { skuMasterId: number }
// Admin-only per current guard (staff-visibility can be widened later).
router.post('/order-items/:id/link-sku', async (req, res) => {
  const orderItemId = parseInt(req.params?.id, 10);
  const skuMasterId = parseInt(req.body?.skuMasterId, 10);
  const actorId = req.user?.id ?? null;

  if (!Number.isInteger(orderItemId) || orderItemId <= 0) {
    return res.status(400).json({ error: 'invalid_order_item_id' });
  }
  if (!Number.isInteger(skuMasterId) || skuMasterId <= 0) {
    return res.status(400).json({ error: 'invalid_sku_master_id' });
  }
  try {
    const result = await linkOrderItemToSku({ orderItemId, skuMasterId, actorId });
    // Log-line: counts only (PII-free · sanitiser also applied in activityLogger)
    console.log(`[oms-admin/link-sku] actor=${actorId} item=${orderItemId} sku=${skuMasterId} `
      + `status=${result.status} upgraded=${result.itemsUpgraded} already=${result.itemsAlreadyOk} conflicts=${result.itemsInConflict}`);
    if (result.status === 'invalid') return res.status(400).json(result);
    if (result.status === 'conflict') return res.status(409).json(result);
    if (result.status === 'error') return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'link_failed', message: err.message || String(err) });
  }
});

// ── GET /api/oms-admin/inventory/baseline/:physicalProductId ─
// READ-ONLY proposal · legacy evidence · never writes.
router.get('/inventory/baseline/:physicalProductId', async (req, res) => {
  const id = parseInt(req.params?.physicalProductId, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_physical_product_id' });
  try {
    const p = await getBaselineProposal(id);
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: 'proposal_failed', message: err.message || String(err) });
  }
});

// ── POST /api/oms-admin/inventory/baseline/:physicalProductId ─
// Body: { countedQuantity: N, confirm: true, note?: string }
// countedQuantity : integer >= 0 (zero explicitly allowed)
// confirm         : MUST be true to write · dry-run default otherwise
router.post('/inventory/baseline/:physicalProductId', async (req, res) => {
  const id = parseInt(req.params?.physicalProductId, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_physical_product_id' });

  const body = req.body || {};
  const countedQuantity = Number.isInteger(body.countedQuantity) ? body.countedQuantity : NaN;
  if (!Number.isInteger(countedQuantity)) return res.status(400).json({ error: 'countedQuantity_required_integer' });
  if (countedQuantity < 0) return res.status(400).json({ error: 'countedQuantity_must_be_nonneg' });
  if (body.confirm !== true) return res.status(400).json({ error: 'confirm_must_be_true' });

  const actorId = req.user?.id ?? null;
  try {
    const r = await applyInitialBaseline({
      physicalProductId: id, countedQuantity,
      actorId, confirm: true, note: body.note || null,
    });
    // PII-free log line
    console.log(`[oms-admin/baseline] actor=${actorId} physical=${id} count=${countedQuantity} status=${r.status}`);
    const httpCode = r.status === 'applied' ? 200
                   : r.status === 'idempotent' ? 200
                   : r.status === 'invalid' ? 400
                   : r.status === 'blocked' ? 409
                   : 500;
    return res.status(httpCode).json(r);
  } catch (err) {
    res.status(500).json({ error: 'baseline_failed', message: err.message || String(err) });
  }
});

// ── GET /api/oms-admin/inventory/lifecycle/:orderId/:eventType ─
// READ-ONLY proposal (never writes)
router.get('/inventory/lifecycle/:orderId/:eventType', async (req, res) => {
  const orderId = parseInt(req.params?.orderId, 10);
  const eventType = String(req.params?.eventType || '').trim();
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
  if (!eventType) return res.status(400).json({ error: 'eventType_required' });
  try {
    const r = await proposeLifecycleForOrder({ orderId, eventType });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: 'proposal_failed', message: err.message || String(err) });
  }
});

// ── POST /api/oms-admin/inventory/lifecycle/:orderId/:eventType ─
// Body: { confirm: true }
router.post('/inventory/lifecycle/:orderId/:eventType', async (req, res) => {
  const orderId = parseInt(req.params?.orderId, 10);
  const eventType = String(req.params?.eventType || '').trim();
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'invalid_order_id' });
  if (!eventType) return res.status(400).json({ error: 'eventType_required' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_must_be_true' });
  const actorId = req.user?.id ?? null;
  try {
    const r = await applyLifecycleForOrder({ orderId, eventType, actorId, confirm: true });
    console.log(`[oms-admin/lifecycle] actor=${actorId} order=${orderId} event=${eventType} writes=${r.writes.length}`);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: 'apply_failed', message: err.message || String(err) });
  }
});

// ── GET /api/oms-admin/status ───────────────────────────────
// Small operational-only summary. No PII.
router.get('/status', async (_req, res) => {
  try {
    const db = getClient();

    // Last raw event ingested
    const { data: lastEv } = await db.from('channel_order_events')
      .select('id,channel,fetched_at,processing_status')
      .eq('channel', 'ebay')
      .order('fetched_at', { ascending: false })
      .limit(1);

    // Counts today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startIso = startOfToday.toISOString();

    const [totalEvHead, processedEvHead, failedEvHead, ordersHead, itemsHead, unmatchedHead] = await Promise.all([
      db.from('channel_order_events').select('*', { count: 'exact', head: true })
        .eq('channel', 'ebay').gte('fetched_at', startIso),
      db.from('channel_order_events').select('*', { count: 'exact', head: true })
        .eq('channel', 'ebay').gte('fetched_at', startIso).eq('processing_status', 'processed'),
      db.from('channel_order_events').select('*', { count: 'exact', head: true })
        .eq('channel', 'ebay').gte('fetched_at', startIso).eq('processing_status', 'failed'),
      db.from('oms_orders').select('*', { count: 'exact', head: true })
        .eq('channel', 'ebay').gte('imported_at', startIso),
      db.from('oms_order_items').select('*', { count: 'exact', head: true }).gte('created_at', startIso),
      db.from('oms_order_items').select('*', { count: 'exact', head: true })
        .is('sku_master_id', null).is('product_id', null),
    ]);

    res.json({
      channel: 'ebay',
      lastEbayEventAt: lastEv?.[0]?.fetched_at || null,
      today: {
        rawEventsFetched: totalEvHead.count ?? 0,
        rawEventsProcessed: processedEvHead.count ?? 0,
        rawEventsFailed: failedEvHead.count ?? 0,
        ordersImported: ordersHead.count ?? 0,
        itemsCreated: itemsHead.count ?? 0,
      },
      cumulative: {
        unmatchedItems: unmatchedHead.count ?? 0,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'status_failed', message: err.message || String(err) });
  }
});

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

module.exports = router;
