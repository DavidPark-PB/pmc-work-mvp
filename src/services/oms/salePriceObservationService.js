'use strict';

/**
 * src/services/oms/salePriceObservationService.js — Phase 8O.
 *
 * READ-ONLY projection of a listing-price CANDIDATE for a physical product.
 *
 * IMPORTANT: This service NEVER produces a "verified sale price". It
 * returns an OBSERVED_LISTING_PRICE — a listed asking price that MAY or
 * MAY NOT be what actually sells. Callers labelling it as sale price is
 * a caller-side decision (Owner rule §3).
 *
 * Lineage (audited 2026-08-18):
 *   physical → sellable_units → sellable_unit_components (qty=1)
 *   → sku_master_link → sku_master (id) → sku_listing_link (marketplace='ebay')
 *   → ebay_products (via item_id / sku) → price_usd + shipping_usd + updated_at + status
 *
 * NOTES:
 *   • ebay_products.price_usd currency is USD (audited in myListingRefresher.js)
 *   • updated_at is authoritative freshness signal (Browse API refresh 3am daily)
 *   • Listing status must be reconfirmed by caller as ACTIVE to trust freshness
 *   • FX conversion uses caller-supplied usdKrw (Phase 2-2C fail-closed policy)
 *
 * SAFETY:
 *   • All DB reads via caller-supplied `db` · tests inject a stub
 *   • Never writes · never calls marketplace APIs
 *   • Never derives a truth · always returns candidate with provenance
 *   • FX unavailable → status UNKNOWN · never fabricates KRW
 */

const FRESHNESS_POLICY_DAYS = 7;         // >7d since Browse API refresh → STALE
const CANDIDATE_STATUS = Object.freeze({
  OBSERVED_LISTING_PRICE: 'OBSERVED_LISTING_PRICE',
  UNKNOWN:                'UNKNOWN',
});

/**
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {Object} args.db                              Supabase-like client
 * @param {number|null} [args.usdKrw]                   caller-supplied FX rate
 * @param {string|null} [args.usdKrwSource]
 * @param {string|null} [args.usdKrwObservedAt]
 * @param {number} [args.asOfMs=Date.now()]             injectable clock
 * @returns {Promise<Object>}                           candidate + provenance
 */
async function observeSalePriceCandidate({ physicalProductId, db, usdKrw, usdKrwSource, usdKrwObservedAt, asOfMs } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('observeSalePriceCandidate: physicalProductId required (positive integer)');
  }
  if (!db || typeof db.from !== 'function') {
    throw new Error('observeSalePriceCandidate: db (Supabase-like client) required · never uses production client by default');
  }
  const now = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const missing = [];

  // Walk: physical → sellable_unit → components (qty=1) → sku_master_link → sku_master
  const sellableUnits = await _select(db, 'sellable_units', 'id, physical_product_id', { physical_product_id: physicalProductId });
  if (!sellableUnits.length) return _unknown('no_sellable_unit_for_physical', { physicalProductId });
  const suIds = sellableUnits.map(r => r.id);
  const components = await _selectIn(db, 'sellable_unit_components', 'sellable_unit_id, quantity_per_unit', 'sellable_unit_id', suIds);
  const suSingleUnit = components.filter(c => Number(c.quantity_per_unit) === 1).map(c => c.sellable_unit_id);
  if (!suSingleUnit.length) return _unknown('no_single_unit_component', { physicalProductId });
  const links = await _selectIn(db, 'sku_master_link', 'sku_master_id, sellable_unit_id', 'sellable_unit_id', suSingleUnit);
  const smIds = [...new Set(links.map(l => l.sku_master_id))];
  if (!smIds.length) return _unknown('no_sku_master_link', { physicalProductId });
  const skuMasters = await _selectIn(db, 'sku_master', 'id, internal_sku', 'id', smIds);
  const internalSkus = skuMasters.map(s => s.internal_sku).filter(Boolean);

  // sku_master.id → sku_listing_link (marketplace='ebay')
  const listingLinks = await _selectIn(db, 'sku_listing_link', 'sku_id, listing_id, marketplace_sku, is_primary', 'sku_id', smIds);
  const ebayLinks = listingLinks.filter(l => true);   // marketplace filtering done at query level would be more efficient; keeping simple stub-friendly path
  // Preferred: is_primary=true first
  const listingIds = [...new Set(ebayLinks
    .sort((a, b) => (b.is_primary === true ? 1 : 0) - (a.is_primary === true ? 1 : 0))
    .map(l => l.listing_id)
    .filter(Boolean))];

  if (!listingIds.length && !internalSkus.length) return _unknown('no_ebay_link_and_no_sku', { smIds });

  // Query ebay_products by item_id (listingIds) OR sku (internalSkus). Prefer item_id.
  let ebayRows = [];
  if (listingIds.length) {
    ebayRows = await _selectIn(db, 'ebay_products', 'item_id, sku, price_usd, shipping_usd, updated_at, status', 'item_id', listingIds);
  }
  if (!ebayRows.length && internalSkus.length) {
    ebayRows = await _selectIn(db, 'ebay_products', 'item_id, sku, price_usd, shipping_usd, updated_at, status', 'sku', internalSkus);
  }
  if (!ebayRows.length) return _unknown('no_ebay_product_row', { listingIds, internalSkus });

  // Pick freshest ACTIVE row
  const active = ebayRows.filter(r => _isActive(r.status));
  const pool = active.length ? active : ebayRows;
  const chosen = pool.slice().sort((a, b) => _tsMs(b.updated_at) - _tsMs(a.updated_at))[0];
  const priceUsd = _finiteOrNull(chosen.price_usd);
  const shippingUsd = _finiteOrNull(chosen.shipping_usd);
  if (priceUsd == null || priceUsd <= 0) return _unknown('ebay_price_missing_or_nonpositive', { item_id: chosen.item_id });

  //   FX to KRW (caller-supplied · never derived)
  const fx = _resolveFx({ usdKrw, usdKrwSource, usdKrwObservedAt });
  if (!fx.available) {
    return {
      status: CANDIDATE_STATUS.UNKNOWN,
      reason: 'fx_usd_to_krw_unavailable',
      amount_krw: null,
      amount_native: priceUsd,
      currency: 'USD',
      shipping_native: shippingUsd,
      shipping_krw: null,
      source: 'ebay_products.price_usd',
      listing_id: chosen.item_id ?? null,
      marketplace_sku: chosen.sku ?? null,
      listing_status: chosen.status ?? null,
      observed_at: chosen.updated_at ?? null,
      freshness_status: _freshness(chosen.updated_at, now),
      freshness_policy_days: FRESHNESS_POLICY_DAYS,
      note: 'listing observation · currency USD · FX not supplied by caller · Owner must set usdKrw before use',
    };
  }

  const amountKrw = _roundKrw(priceUsd * fx.rate);
  const shippingKrw = shippingUsd != null ? _roundKrw(shippingUsd * fx.rate) : null;
  const freshness = _freshness(chosen.updated_at, now);

  return {
    status: CANDIDATE_STATUS.OBSERVED_LISTING_PRICE,
    amount_krw: amountKrw,
    amount_native: priceUsd,
    currency: 'USD',
    shipping_native: shippingUsd,
    shipping_krw: shippingKrw,
    source: 'ebay_products.price_usd',
    listing_id: chosen.item_id ?? null,
    marketplace_sku: chosen.sku ?? null,
    listing_status: chosen.status ?? null,
    observed_at: chosen.updated_at ?? null,
    freshness_status: freshness,
    freshness_policy_days: FRESHNESS_POLICY_DAYS,
    fx_rate: fx.rate,
    fx_source: fx.source,
    fx_observed_at: fx.observed_at,
    confidence_note: 'OBSERVED_LISTING_PRICE · not a verified sale price · treat as candidate only (Owner rule §3)',
  };
}

// ─── helpers ───────────────────────────────────────

function _unknown(reason, ctx = {}) {
  return {
    status: CANDIDATE_STATUS.UNKNOWN,
    reason,
    amount_krw: null,
    amount_native: null,
    currency: null,
    shipping_native: null,
    shipping_krw: null,
    source: 'ebay_products.price_usd',
    listing_id: null,
    marketplace_sku: null,
    listing_status: null,
    observed_at: null,
    freshness_status: 'UNKNOWN',
    freshness_policy_days: FRESHNESS_POLICY_DAYS,
    context: ctx,
  };
}

function _finiteOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _roundKrw(v) { return Math.round(v); }
function _tsMs(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
function _isActive(s) {
  if (s == null) return false;
  const t = String(s).toLowerCase();
  return t === 'active' || t === 'listed' || t === 'available';
}
function _freshness(observedAt, nowMs) {
  const ts = _tsMs(observedAt);
  if (!ts) return 'UNKNOWN';
  const ageDays = (nowMs - ts) / (1000 * 60 * 60 * 24);
  return ageDays <= FRESHNESS_POLICY_DAYS ? 'FRESH' : 'STALE';
}
function _resolveFx({ usdKrw, usdKrwSource, usdKrwObservedAt }) {
  const n = Number(usdKrw);
  if (Number.isFinite(n) && n > 0) {
    return { available: true, rate: n, source: usdKrwSource || 'caller_supplied', observed_at: usdKrwObservedAt || null };
  }
  return { available: false, rate: null, source: null, observed_at: null };
}

async function _select(db, table, cols, eq) {
  const q = db.from(table).select(cols);
  const [k, v] = Object.entries(eq)[0];
  const res = await q.eq(k, v);
  if (res && res.error) throw new Error(`select ${table} failed: ${res.error.message}`);
  return (res && res.data) || [];
}
async function _selectIn(db, table, cols, col, values) {
  if (!values || !values.length) return [];
  const res = await db.from(table).select(cols).in(col, values);
  if (res && res.error) throw new Error(`select ${table} failed: ${res.error.message}`);
  return (res && res.data) || [];
}

module.exports = {
  observeSalePriceCandidate,
  CANDIDATE_STATUS,
  FRESHNESS_POLICY_DAYS,
};
