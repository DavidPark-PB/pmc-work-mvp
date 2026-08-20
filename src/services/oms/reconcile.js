/**
 * src/services/oms/reconcile.js — Legacy public.orders vs Canonical OMS diff.
 *
 * Owner directive §4 · §5 · §6 · §8 · §10-12 (Step 4.1 bug fix):
 *   - Explicit windowStart / windowEnd, computed ONCE, applied to BOTH sides.
 *   - New mode: latestIngest — reconcile the last N canonical rows by external_order_id
 *     (timezone-agnostic · 정확한 1:1 검증).
 *   - Legacy grain (1 row = 1 line): unique orders = distinct order_no.
 *   - Mismatches surfaced with cause hints (§13). No auto-correction.
 *
 * READ-ONLY. Zero writes.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const {
  normalizeShopifyOrderNumberForLegacy,
  extractLegacyOrderIdentity,
} = require('./shopifyOrderNumber');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @typedef {Object} ReconcileWindow
 * @property {Date}   windowStart
 * @property {Date}   windowEnd
 * @property {string} field           'ordered_at' | 'imported_at'
 */

/**
 * Reconcile eBay orders — WINDOW MODE.
 *
 * The window is computed once (default: last 24h from now) and applied to BOTH sides:
 *   Legacy public.orders  → filter on order_date  (DATE column, UTC calendar day range)
 *   Canonical oms_orders  → filter on `field` (default 'ordered_at')
 *
 * `field='imported_at'` is more useful when the aim is "orders written in the last N hours"
 * regardless of when the buyer originally placed the order on eBay.
 *
 * @param {Object} [opts]
 * @param {number} [opts.hours=24]              lookback in hours (preferred over days)
 * @param {number} [opts.days=null]             convenience — overrides hours if set
 * @param {'ordered_at'|'imported_at'} [opts.field='ordered_at']
 * @param {number} [opts.limit=2000]
 * @returns {Promise<ReconcileReport>}
 */
async function reconcileEbay(opts = {}) {
  const hours = opts.days != null ? Number(opts.days) * 24 : (Number(opts.hours) || 24);
  const field = opts.field === 'imported_at' ? 'imported_at' : 'ordered_at';
  const limit = Number(opts.limit) || 2000;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - hours * 3600_000);

  return _runReconcile({
    mode: 'window',
    hours,
    field,
    limit,
    windowStart,
    windowEnd,
    lockedExternalIds: null,
  });
}

/**
 * Reconcile the last N canonical orders — IDENTITY MODE (§5).
 *
 * Fetches the last `limit` canonical orders by imported_at desc, then queries legacy
 * for the same `order_no`s. Timezone-agnostic. Precise 1:1 comparison of the exact
 * order set that was just ingested.
 *
 * @param {Object} [opts]
 * @param {number} [opts.latestIngest=10]
 * @param {number} [opts.limit=2000]
 */
async function reconcileEbayByLatestIngested(opts = {}) {
  const n = Math.max(1, Math.min(500, parseInt(opts.latestIngest ?? 10, 10)));
  const db = getClient();

  const { data: latest, error } = await db.from('oms_orders')
    .select('external_order_id, imported_at')
    .eq('channel', 'ebay')
    .order('imported_at', { ascending: false })
    .limit(n);
  if (error) throw error;

  const ids = (latest || []).map(r => String(r.external_order_id)).filter(Boolean);
  const importedTimes = (latest || []).map(r => r.imported_at).filter(Boolean);
  const windowEnd = importedTimes.length
    ? new Date(Math.max(...importedTimes.map(t => new Date(t).getTime())))
    : new Date();
  const windowStart = importedTimes.length
    ? new Date(Math.min(...importedTimes.map(t => new Date(t).getTime())))
    : new Date(windowEnd.getTime() - 24 * 3600_000);

  return _runReconcile({
    mode: 'latest-ingest',
    hours: null,
    field: 'imported_at',
    limit: Number(opts.limit) || 2000,
    windowStart,
    windowEnd,
    lockedExternalIds: ids,
  });
}

// ─────────────────────────────────────────────────────────────
// Core reconcile — one function, two modes.
//
// N=1 boundary rule (Owner §3-5):
//   When lockedExternalIds is non-null we NEVER also apply a timestamp filter.
//   Otherwise windowStart === windowEnd (which happens naturally when N=1
//   because Math.min([t]) === Math.max([t])) would exclude the locked row.
//   Timestamps travel through only as report metadata.
// ─────────────────────────────────────────────────────────────
async function _runReconcile({ mode, hours, field, limit, windowStart, windowEnd, lockedExternalIds }) {
  const db = getClient();
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();

  // Legacy calendar-day range from UTC iso.
  //   order_date is DATE (no tz) — inclusive both ends.
  const startDate = startIso.slice(0, 10);
  const endDate = endIso.slice(0, 10);

  // ── Canonical fetch ───────────────────────────────────────
  let canQ = db.from('oms_orders')
    .select('id,external_order_id,total,currency,buyer_country,order_status,fulfillment_status,shipped_at,ordered_at,imported_at')
    .eq('channel', 'ebay')
    .limit(limit);
  if (lockedExternalIds != null) {
    if (lockedExternalIds.length === 0) {
      // nothing ingested yet — return empty report early
      return _emptyReport(mode, hours, field, windowStart, windowEnd, lockedExternalIds);
    }
    canQ = canQ.in('external_order_id', lockedExternalIds);
  } else {
    canQ = canQ.gte(field, startIso).lte(field, endIso);
  }
  const { data: canOrders, error: ce1 } = await canQ;
  if (ce1) throw ce1;

  const canOrderIds = (canOrders || []).map(o => o.id);
  const canByExtId = new Map((canOrders || []).map(o => [String(o.external_order_id), o]));

  // ── Canonical items ───────────────────────────────────────
  let canItems = [];
  if (canOrderIds.length) {
    const { data: itemsRows, error: ce2 } = await db.from('oms_order_items')
      .select('id,order_id,external_line_id,marketplace_sku,quantity,unit_price,sku_master_id,product_id,match_status,unit_cost_snapshot,cost_currency')
      .in('order_id', canOrderIds)
      .limit(limit * 10);
    if (ce2) throw ce2;
    canItems = itemsRows || [];
  }

  // ── Legacy fetch ──────────────────────────────────────────
  let legacyQ = db.from('orders')
    .select('order_no,sku,quantity,payment_amount,currency,country,country_code,status,tracking_no,order_date')
    .eq('platform', 'eBay')
    .limit(limit);
  if (lockedExternalIds != null) {
    // identity-first: fetch only the same order_nos as canonical → timezone-agnostic
    legacyQ = legacyQ.in('order_no', lockedExternalIds);
  } else {
    legacyQ = legacyQ.gte('order_date', startDate).lte('order_date', endDate);
  }
  const { data: legacyRows, error: le } = await legacyQ;
  if (le) throw le;

  // ── Aggregate legacy ──────────────────────────────────────
  const legacyOrdersByNo = new Map();
  let legacyLines = 0;
  let legacyQuantity = 0;
  let legacyAmount = 0;
  let legacyShipped = 0;
  const legacySkus = new Set();

  for (const r of (legacyRows || [])) {
    legacyLines += 1;
    const qty = Number(r.quantity) || 0;
    legacyQuantity += qty;
    legacyAmount += Number(r.payment_amount) || 0;
    if (r.sku) legacySkus.add(String(r.sku));
    if (String(r.status || '').toUpperCase() === 'SHIPPED' || r.tracking_no) legacyShipped += 1;

    const key = String(r.order_no || '');
    if (!key) continue;
    const g = legacyOrdersByNo.get(key) || {
      order_no: key, lineCount: 0, quantity: 0, amount: 0,
      currency: r.currency || null, country: r.country || null,
      shipped: false,
    };
    g.lineCount += 1;
    g.quantity += qty;
    g.amount += Number(r.payment_amount) || 0;
    if (String(r.status || '').toUpperCase() === 'SHIPPED' || r.tracking_no) g.shipped = true;
    legacyOrdersByNo.set(key, g);
  }

  // ── Aggregate canonical ───────────────────────────────────
  const canItemCount = canItems.length;
  const canQuantity = canItems.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
  const canUnmatched = canItems.filter(r => r.sku_master_id == null && r.product_id == null).length;
  const canShipped = (canOrders || []).filter(o => o.shipped_at != null || o.fulfillment_status === 'fulfilled').length;
  const canAmount = (canOrders || []).reduce((a, r) => a + (Number(r.total) || 0), 0);
  const canSkus = new Set();
  for (const r of canItems) if (r.marketplace_sku) canSkus.add(String(r.marketplace_sku));

  const matchStatusCounts = {};
  for (const r of canItems) {
    const s = r.match_status || 'pending';
    matchStatusCounts[s] = (matchStatusCounts[s] || 0) + 1;
  }

  // Data quality (Owner Step 5 §9) — separate coverage metrics.
  const matchedItems = canItems.filter(r => r.sku_master_id != null || r.product_id != null);
  const matchedWithoutCost = matchedItems.filter(r => r.unit_cost_snapshot == null).length;
  const matchedWithoutProduct = canItems.filter(r => r.sku_master_id != null && r.product_id == null).length;

  // items with an available master cost — requires reading sku_master.cost_krw
  const skuIdsToCheck = [...new Set(canItems.map(r => r.sku_master_id).filter(v => Number.isInteger(v) && v > 0))];
  const skuMasterCosts = await _fetchSkuMasterCosts(db, skuIdsToCheck);
  let itemsWithAvailableMasterCost = 0;
  let snapshotCoverageForAvailableCost = 0;
  for (const it of canItems) {
    if (!Number.isInteger(it.sku_master_id) || it.sku_master_id <= 0) continue;
    const masterCost = skuMasterCosts.get(it.sku_master_id);
    if (masterCost != null) {
      itemsWithAvailableMasterCost += 1;
      if (it.unit_cost_snapshot != null) snapshotCoverageForAvailableCost += 1;
    }
  }

  const costCoverage = {
    items_total: canItems.length,
    items_with_cost_snapshot: canItems.filter(r => r.unit_cost_snapshot != null).length,
    matched_without_cost: matchedWithoutCost,
    matched_without_product: matchedWithoutProduct,
    items_with_available_master_cost: itemsWithAvailableMasterCost,
    snapshot_coverage_for_available_cost: snapshotCoverageForAvailableCost,
  };

  // ── Order-level intersection diff ─────────────────────────
  const unmatchedOrders = [];
  for (const key of legacyOrdersByNo.keys()) {
    if (!canByExtId.has(key)) unmatchedOrders.push({ side: 'legacy_only', external_order_id: key });
  }
  for (const key of canByExtId.keys()) {
    if (!legacyOrdersByNo.has(key)) unmatchedOrders.push({ side: 'canonical_only', external_order_id: key });
  }

  const fieldMismatches = [];
  for (const [key, lg] of legacyOrdersByNo.entries()) {
    const cn = canByExtId.get(key);
    if (!cn) continue;
    const legAmount = r2(lg.amount);
    const canA = r2(cn.total);
    if (Math.abs(legAmount - canA) > 0.01) {
      fieldMismatches.push({
        external_order_id: key,
        field: 'amount',
        legacy: legAmount,
        canonical: canA,
        note: 'legacy payment_amount = eBay Total; canonical total may differ if shipping/tax handled differently by adapter',
      });
    }
    if (lg.currency && cn.currency && lg.currency !== cn.currency) {
      fieldMismatches.push({ external_order_id: key, field: 'currency', legacy: lg.currency, canonical: cn.currency });
    }
    if (lg.country && cn.buyer_country && String(lg.country).toLowerCase() !== String(cn.buyer_country).toLowerCase()) {
      fieldMismatches.push({ external_order_id: key, field: 'country', legacy: lg.country, canonical: cn.buyer_country });
    }
    if (lg.shipped && cn.shipped_at == null && cn.fulfillment_status !== 'fulfilled') {
      fieldMismatches.push({ external_order_id: key, field: 'shipped', legacy: 'shipped', canonical: cn.fulfillment_status });
    }
    const canQty = canItems.filter(i => i.order_id === cn.id).reduce((a, x) => a + (Number(x.quantity) || 0), 0);
    if (lg.quantity !== canQty) {
      fieldMismatches.push({
        external_order_id: key,
        field: 'quantity_sum',
        legacy: lg.quantity,
        canonical: canQty,
        note: 'legacy shows only first transaction per eBay order; canonical may have accurate multi-line count',
      });
    }
  }

  return {
    channel: 'ebay',
    mode,
    windowStart: startIso,
    windowEnd: endIso,
    canonicalField: field,
    hours,
    lockedExternalIds: lockedExternalIds ? lockedExternalIds.length : null,
    fetched: {
      legacy_rows: (legacyRows || []).length,
      canonical_orders: (canOrders || []).length,
      canonical_items: canItems.length,
    },
    legacyUniqueOrders: legacyOrdersByNo.size,
    canonicalOrders: (canOrders || []).length,
    legacyLines,
    canonicalItems: canItemCount,
    legacyQuantity,
    canonicalQuantity: canQuantity,
    legacyAmount: r2(legacyAmount),
    canonicalAmount: r2(canAmount),
    amountDifference: r2(legacyAmount - canAmount),
    legacyShipped,
    canonicalShipped: canShipped,
    distinctSkus: { legacy: legacySkus.size, canonical: canSkus.size },
    matchStatusCounts,
    costCoverage,
    unmatchedItems: canUnmatched,
    unmatchedOrders,
    fieldMismatches,
    generatedAt: new Date().toISOString(),
  };
}

function _emptyReport(mode, hours, field, windowStart, windowEnd, lockedExternalIds) {
  return {
    channel: 'ebay', mode,
    windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
    canonicalField: field, hours,
    lockedExternalIds: lockedExternalIds ? lockedExternalIds.length : 0,
    fetched: { legacy_rows: 0, canonical_orders: 0, canonical_items: 0 },
    legacyUniqueOrders: 0, canonicalOrders: 0,
    legacyLines: 0, canonicalItems: 0,
    legacyQuantity: 0, canonicalQuantity: 0,
    legacyAmount: 0, canonicalAmount: 0, amountDifference: 0,
    legacyShipped: 0, canonicalShipped: 0,
    distinctSkus: { legacy: 0, canonical: 0 },
    matchStatusCounts: {},
    costCoverage: { items_total: 0, items_with_cost_snapshot: 0 },
    unmatchedItems: 0, unmatchedOrders: [], fieldMismatches: [],
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Head-only counts (foundational · kept for admin status view).
// ─────────────────────────────────────────────────────────────
async function summaryCounts({ sinceIso = null } = {}) {
  const db = getClient();
  let legacyQ = db.from('orders').select('*', { count: 'exact', head: true });
  if (sinceIso) legacyQ = legacyQ.gte('order_date', sinceIso.slice(0, 10));
  const legacyRowCount = await _headCount(legacyQ);
  const canonicalOrderCount = await _headCount(
    db.from('oms_orders').select('*', { count: 'exact', head: true }),
  );
  const canonicalItemCount = await _headCount(
    db.from('oms_order_items').select('*', { count: 'exact', head: true }),
  );
  const canonicalUnmatched = await _headCount(
    db.from('oms_order_items').select('*', { count: 'exact', head: true })
      .is('sku_master_id', null).is('product_id', null),
  );
  return {
    legacy: { rowCount: legacyRowCount },
    canonical: {
      orderCount: canonicalOrderCount,
      itemCount: canonicalItemCount,
      unmatchedItems: canonicalUnmatched,
    },
  };
}
async function _headCount(builder) {
  try { const { count, error } = await builder; if (error) return 0; return count ?? 0; }
  catch { return 0; }
}

async function _fetchSkuMasterCosts(db, ids) {
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;
  try {
    const { data } = await db.from('sku_master').select('id, cost_krw').in('id', ids);
    (data || []).forEach(r => out.set(r.id, r.cost_krw));
  } catch { /* empty */ }
  return out;
}

// ═════════════════════════════════════════════════════════════
// Shopify reconciliation
// ═════════════════════════════════════════════════════════════
/**
 * Shopify identifier mapping between legacy and canonical:
 *   canonical.external_order_id     = Shopify raw.id (immutable numeric system id)
 *   canonical.external_order_number = Shopify raw.name (e.g. '#1001')
 *   legacy.orders.order_no          = orderSync writes '${order_number}-${line_item.id}'
 *                                     (grain-exploded, one row per line)
 *
 * Reconcile joins by stripping '#' from external_order_number, then LIKE match on
 * legacy.order_no with pattern '<number>-%' (plus exact match for orders with
 * a single line_item where '-<line>' may or may not be present).
 */

async function reconcileShopify(opts = {}) {
  const hours = opts.days != null ? Number(opts.days) * 24 : (Number(opts.hours) || 24);
  const field = opts.field === 'imported_at' ? 'imported_at' : 'ordered_at';
  const limit = Number(opts.limit) || 2000;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - hours * 3600_000);
  return _runShopifyReconcile({
    mode: 'window', hours, field, limit, windowStart, windowEnd, lockedNumbers: null,
  });
}

async function reconcileShopifyByLatestIngested(opts = {}) {
  const n = Math.max(1, Math.min(500, parseInt(opts.latestIngest ?? 10, 10)));
  const db = getClient();
  // Identity locking (§3): use external_order_id (Shopify raw.id · immutable system id)
  //   — external_order_number (#1001) is human-friendly but adapter-dependent · MAY be NULL.
  //   Legacy joins still use external_order_number, but NULL there is a data-quality issue
  //   surfaced as unmatched, NOT a reason to return an empty reconcile report.
  const { data: latest, error } = await db.from('oms_orders')
    .select('id, external_order_id, external_order_number, imported_at')
    .eq('channel', 'shopify')
    .order('imported_at', { ascending: false })
    .limit(n);
  if (error) throw error;

  const lockedIds = (latest || []).map(r => String(r.external_order_id)).filter(Boolean);
  const importedTimes = (latest || []).map(r => r.imported_at).filter(Boolean);
  const nowTs = new Date();
  const windowEnd = importedTimes.length
    ? new Date(Math.max(...importedTimes.map(t => new Date(t).getTime())))
    : nowTs;
  const windowStart = importedTimes.length
    ? new Date(Math.min(...importedTimes.map(t => new Date(t).getTime())))
    : new Date(nowTs.getTime() - 24 * 3600_000);

  return _runShopifyReconcile({
    mode: 'latest-ingest', hours: null, field: 'imported_at',
    limit: Number(opts.limit) || 2000,
    windowStart, windowEnd,
    lockedExternalIds: lockedIds,
  });
}

async function _runShopifyReconcile({ mode, hours, field, limit, windowStart, windowEnd, lockedExternalIds }) {
  const db = getClient();
  const startIso = windowStart.toISOString();
  const endIso = windowEnd.toISOString();

  // ── Canonical fetch (identity-first · Owner §3-5)
  //   In latest-ingest mode we lock by external_order_id (system id · always present).
  //   Timestamp filter is NEVER applied on top of an identity lock — this prevents the
  //   N=1 boundary problem where windowStart === windowEnd could exclude the row.
  let canQ = db.from('oms_orders')
    .select('id,external_order_id,external_order_number,total,currency,buyer_country,order_status,payment_status,fulfillment_status,shipped_at,cancelled_at,ordered_at,imported_at')
    .eq('channel', 'shopify')
    .limit(limit);
  if (lockedExternalIds != null) {
    if (lockedExternalIds.length === 0) {
      return _emptyShopifyReport(mode, hours, field, windowStart, windowEnd, 0);
    }
    canQ = canQ.in('external_order_id', lockedExternalIds);
  } else {
    canQ = canQ.gte(field, startIso).lte(field, endIso);
  }
  const { data: canOrders, error: ce1 } = await canQ;
  if (ce1) throw ce1;

  const canOrderIds = (canOrders || []).map(o => o.id);
  // canByLegacyIdentity[normalizedIdentity] = canonical row
  //   normalizedIdentity is the string that legacy `order_no` prefix (before '-')
  //   must equal. See shopifyOrderNumber.js for the rule.
  const canByLegacyIdentity = new Map();
  const canonicalOrdersMissingNumber = [];
  for (const o of (canOrders || [])) {
    const norm = normalizeShopifyOrderNumberForLegacy({
      external_order_number: o.external_order_number,
      external_order_id: o.external_order_id,
    });
    if (norm) canByLegacyIdentity.set(norm, o);
    else canonicalOrdersMissingNumber.push(String(o.external_order_id));
  }

  // ── Canonical items
  let canItems = [];
  if (canOrderIds.length) {
    const { data: itemsRows, error: ce2 } = await db.from('oms_order_items')
      .select('id,order_id,external_line_id,marketplace_sku,quantity,unit_price,sku_master_id,product_id,match_status,unit_cost_snapshot,cost_currency')
      .in('order_id', canOrderIds)
      .limit(limit * 10);
    if (ce2) throw ce2;
    canItems = itemsRows || [];
  }

  // ── Legacy fetch — Shopify sync writes order_no = "<order_number>-<line_id>"
  //    Use normalizeShopifyOrderNumberForLegacy to derive the correct legacy join key
  //    from canonical rows (canonical name may have a store-specific prefix like 'CC').
  //    Canonical rows for which no legacy join key can be derived surface below as
  //    canonical_only unmatched (with reason: missing_external_order_number).
  //
  //    Owner §7: no ILIKE '%<n>%' — exact identity only. We use PostgREST
  //    `.or(order_no.like.<n>-%,order_no.eq.<n>)` then post-filter via
  //    extractLegacyOrderIdentity(order_no) === <n> as a second safety layer.
  let legacyRows = [];
  const legacyLookupNumbers = [...canByLegacyIdentity.keys()];
  if (lockedExternalIds != null) {
    if (legacyLookupNumbers.length > 0) {
      for (const num of legacyLookupNumbers) {
        const { data, error: le } = await db.from('orders')
          .select('order_no,sku,quantity,payment_amount,currency,country,status,tracking_no,order_date')
          .eq('platform', 'Shopify')
          .or(`order_no.like.${num}-%,order_no.eq.${num}`)
          .limit(200);
        if (le) throw le;
        // Post-filter safety: reject rows whose identity prefix != num
        (data || []).forEach((r) => {
          if (extractLegacyOrderIdentity(r.order_no) === num) legacyRows.push(r);
        });
      }
    }
  } else {
    const startDate = startIso.slice(0, 10);
    const endDate = endIso.slice(0, 10);
    const { data, error: le } = await db.from('orders')
      .select('order_no,sku,quantity,payment_amount,currency,country,status,tracking_no,order_date')
      .eq('platform', 'Shopify')
      .gte('order_date', startDate).lte('order_date', endDate)
      .limit(limit);
    if (le) throw le;
    legacyRows = data || [];
  }

  // Aggregate legacy per underlying Shopify order identity (order_no prefix before '-').
  // NOTE: legacy `payment_amount` here is written by orderSync.js:395 from
  //   Shopify `line_item.price` (per-unit line price), NOT `order.total_price`.
  //   We aggregate it for reporting only — comparing sum(legacy line prices) with
  //   canonical order total is NOT valid (see fieldMismatches below · not_comparable).
  const legacyByIdentity = new Map();
  let legacyLines = 0, legacyQuantity = 0, legacyAmount = 0, legacyShipped = 0;
  const legacySkus = new Set();

  for (const r of legacyRows) {
    legacyLines += 1;
    const qty = Number(r.quantity) || 0;
    legacyQuantity += qty;
    legacyAmount += Number(r.payment_amount) || 0;
    if (r.sku) legacySkus.add(String(r.sku));
    if (String(r.status || '').toUpperCase() === 'SHIPPED' || r.tracking_no) legacyShipped += 1;

    const identity = extractLegacyOrderIdentity(r.order_no);
    if (!identity) continue;
    const g = legacyByIdentity.get(identity) || {
      identity, lineCount: 0, quantity: 0,
      lineAmountSum: 0,           // sum of legacy `payment_amount` — line unit prices · NOT order total
      currency: r.currency || null, country: r.country || null, shipped: false,
    };
    g.lineCount += 1;
    g.quantity += qty;
    g.lineAmountSum += Number(r.payment_amount) || 0;
    if (String(r.status || '').toUpperCase() === 'SHIPPED' || r.tracking_no) g.shipped = true;
    legacyByIdentity.set(identity, g);
  }

  // ── Canonical aggregates
  const canQuantity = canItems.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
  const canUnmatched = canItems.filter(r => r.sku_master_id == null && r.product_id == null).length;
  const canShipped = (canOrders || []).filter(o => o.shipped_at != null || o.fulfillment_status === 'fulfilled').length;
  const canAmount = (canOrders || []).reduce((a, r) => a + (Number(r.total) || 0), 0);
  const canSkus = new Set();
  for (const r of canItems) if (r.marketplace_sku) canSkus.add(String(r.marketplace_sku));

  const matchStatusCounts = {};
  for (const r of canItems) {
    const s = r.match_status || 'pending';
    matchStatusCounts[s] = (matchStatusCounts[s] || 0) + 1;
  }

  // Data quality
  const matchedWithoutCost = canItems.filter(r => (r.sku_master_id != null || r.product_id != null) && r.unit_cost_snapshot == null).length;
  const matchedWithoutProduct = canItems.filter(r => r.sku_master_id != null && r.product_id == null).length;
  const skuIdsToCheck = [...new Set(canItems.map(r => r.sku_master_id).filter(v => Number.isInteger(v) && v > 0))];
  const skuMasterCosts = await _fetchSkuMasterCosts(db, skuIdsToCheck);
  let itemsWithAvailableMasterCost = 0;
  let snapshotCoverageForAvailableCost = 0;
  for (const it of canItems) {
    if (!Number.isInteger(it.sku_master_id) || it.sku_master_id <= 0) continue;
    const masterCost = skuMasterCosts.get(it.sku_master_id);
    if (masterCost != null) {
      itemsWithAvailableMasterCost += 1;
      if (it.unit_cost_snapshot != null) snapshotCoverageForAvailableCost += 1;
    }
  }

  const costCoverage = {
    items_total: canItems.length,
    items_with_cost_snapshot: canItems.filter(r => r.unit_cost_snapshot != null).length,
    matched_without_cost: matchedWithoutCost,
    matched_without_product: matchedWithoutProduct,
    items_with_available_master_cost: itemsWithAvailableMasterCost,
    snapshot_coverage_for_available_cost: snapshotCoverageForAvailableCost,
  };

  // ── Order-level intersection diff (join key = normalized identity)
  const unmatchedOrders = [];
  for (const identity of legacyByIdentity.keys()) {
    if (!canByLegacyIdentity.has(identity)) {
      unmatchedOrders.push({ side: 'legacy_only', order_number: identity });
    }
  }
  for (const identity of canByLegacyIdentity.keys()) {
    if (!legacyByIdentity.has(identity)) {
      const cn = canByLegacyIdentity.get(identity);
      unmatchedOrders.push({
        side: 'canonical_only',
        order_number: identity,
        external_order_number: cn.external_order_number || null,
        external_order_id: String(cn.external_order_id),
      });
    }
  }
  // Canonical rows lacking a derivable legacy join key — surface explicitly.
  for (const extId of canonicalOrdersMissingNumber) {
    unmatchedOrders.push({
      side: 'canonical_only',
      order_number: null,
      external_order_id: extId,
      reason: 'missing_external_order_number',
    });
  }

  const fieldMismatches = [];
  for (const [identity, lg] of legacyByIdentity.entries()) {
    const cn = canByLegacyIdentity.get(identity);
    if (!cn) continue;

    // Financial (Owner §5): legacy `payment_amount` is per-line unit price,
    // canonical `total` is the whole-order total. Different semantics → not_comparable.
    // Never auto-correct, never claim mismatch as failure.
    fieldMismatches.push({
      order_number: identity,
      field: 'amount',
      legacy_line_amount_sum: r2(lg.lineAmountSum),
      legacy_row_count: lg.lineCount,
      canonical_order_total: r2(cn.total),
      status: 'not_comparable',
      reason: 'legacy_row_is_line_unit_price · canonical_row_is_order_total (see orderSync.js:395)',
    });

    // Currency
    if (lg.currency && cn.currency && lg.currency !== cn.currency) {
      fieldMismatches.push({
        order_number: identity, field: 'currency',
        legacy: lg.currency, canonical: cn.currency,
      });
    }

    // Country
    if (lg.country && cn.buyer_country && String(lg.country).toLowerCase() !== String(cn.buyer_country).toLowerCase()) {
      fieldMismatches.push({
        order_number: identity, field: 'country',
        legacy: lg.country, canonical: cn.buyer_country,
      });
    }

    // Shipped
    if (lg.shipped && cn.shipped_at == null && cn.fulfillment_status !== 'fulfilled') {
      fieldMismatches.push({
        order_number: identity, field: 'shipped',
        legacy: 'shipped', canonical: cn.fulfillment_status,
      });
    }

    // Line count — legacy line rows == canonical items count for the same order
    const canonicalItemsForOrder = canItems.filter(i => i.order_id === cn.id).length;
    if (lg.lineCount !== canonicalItemsForOrder) {
      fieldMismatches.push({
        order_number: identity, field: 'line_count',
        legacy: lg.lineCount, canonical: canonicalItemsForOrder,
        note: 'Shopify legacy explodes N line_items into N rows; canonical stores N items — these should match',
      });
    }

    // Quantity — legacy sum(quantity) across lines == canonical sum(items.quantity)
    const canonicalQtyForOrder = canItems.filter(i => i.order_id === cn.id).reduce((a, i) => a + (Number(i.quantity) || 0), 0);
    if (lg.quantity !== canonicalQtyForOrder) {
      fieldMismatches.push({
        order_number: identity, field: 'quantity_sum',
        legacy: lg.quantity, canonical: canonicalQtyForOrder,
      });
    }
  }

  return {
    channel: 'shopify',
    mode,
    windowStart: startIso, windowEnd: endIso,
    canonicalField: field, hours,
    lockedExternalIds: lockedExternalIds ? lockedExternalIds.length : null,
    fetched: {
      legacy_rows: legacyRows.length,
      canonical_orders: (canOrders || []).length,
      canonical_items: canItems.length,
    },
    legacyUniqueOrders: legacyByIdentity.size,
    canonicalOrders: (canOrders || []).length,
    legacyLines,
    canonicalItems: canItems.length,
    legacyQuantity, canonicalQuantity: canQuantity,
    legacyAmount: r2(legacyAmount), canonicalAmount: r2(canAmount),
    amountDifference: r2(legacyAmount - canAmount),
    legacyShipped, canonicalShipped: canShipped,
    distinctSkus: { legacy: legacySkus.size, canonical: canSkus.size },
    matchStatusCounts,
    costCoverage,
    unmatchedItems: canUnmatched,
    unmatchedOrders, fieldMismatches,
    generatedAt: new Date().toISOString(),
  };
}

function _emptyShopifyReport(mode, hours, field, windowStart, windowEnd, lockedCount) {
  return {
    channel: 'shopify', mode,
    windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
    canonicalField: field, hours,
    lockedExternalIds: lockedCount,
    fetched: { legacy_rows: 0, canonical_orders: 0, canonical_items: 0 },
    legacyUniqueOrders: 0, canonicalOrders: 0,
    legacyLines: 0, canonicalItems: 0,
    legacyQuantity: 0, canonicalQuantity: 0,
    legacyAmount: 0, canonicalAmount: 0, amountDifference: 0,
    legacyShipped: 0, canonicalShipped: 0,
    distinctSkus: { legacy: 0, canonical: 0 },
    matchStatusCounts: {},
    costCoverage: { items_total: 0, items_with_cost_snapshot: 0,
      matched_without_cost: 0, matched_without_product: 0,
      items_with_available_master_cost: 0, snapshot_coverage_for_available_cost: 0 },
    unmatchedItems: 0, unmatchedOrders: [], fieldMismatches: [],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  reconcileEbay,
  reconcileEbayByLatestIngested,
  reconcileShopify,
  reconcileShopifyByLatestIngested,
  summaryCounts,
};
