'use strict';

/**
 * src/services/oms/recentSoldPriceService.js — Phase 8P · READ-ONLY.
 *
 * Derives a RECENT_SOLD_PRICE_MEDIAN candidate from canonical OMS
 * completed-sale data (oms_orders + oms_order_items).
 *
 * SCOPE:
 *   • READ-ONLY · zero DB write · zero marketplace call · zero migration
 *   • Never inserts or invents physical identity — reuses canonical
 *     analysePhysicalIdentityCoverage per channel
 *   • Never fuzzy-matches by title
 *   • Never mixes currencies as raw numbers; caller-supplied FX only
 *   • Never uses listing / supplier / secondary / accounting cost as
 *     "sold price evidence"
 *   • Never fabricates confidence when samples are insufficient
 *
 * ELIGIBILITY (Phase 8P Owner Part 2):
 *   Order:
 *     • shipped_at BETWEEN window_start AND window_end
 *     • order_status IN ('shipped','completed')
 *     • payment_status = 'paid'
 *     • cancelled_at IS NULL
 *   Line:
 *     • sku_master_id ∈ known identities for this physical (SoT)
 *     • quantity > 0                       (schema CHECK already · re-verified)
 *     • unit_price > 0                     (positive KRW/USD/JPY/CNY per-unit)
 *     • currency ∈ {'KRW','USD','JPY','CNY'} — else exclude
 *     • (discount IS NULL OR discount = 0) — discounted lines have ambiguous
 *       per-unit price semantics · exclude conservatively (Owner §2 UNKNOWN
 *       must be excluded, not guessed)
 *   Physical identity gate:
 *     • analysePhysicalIdentityCoverage(...).velocity_trusted === true
 *       (per channel). Untrusted channels contribute zero observations.
 *
 * Never treats `returned` orders as valid — return typically implies refund,
 * making price unreliable per Owner rule §2.
 */

//   Lazy reference · destructured import would cache a binding that
//   test monkey-patches never reach. Access via `identityMod.<name>` so
//   tests can override the export by mutating the module object.
const identityMod = require('./physicalSpecificCoverage');

const CANDIDATE_TYPE = 'RECENT_SOLD_PRICE_MEDIAN';
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_CHANNELS = ['shopify', 'ebay'];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const CONFIDENCE = Object.freeze({
  HIGH:    'HIGH',
  MEDIUM:  'MEDIUM',
  LOW:     'LOW',
  UNKNOWN: 'UNKNOWN',
});

const CANDIDATE_STATUS = Object.freeze({
  RECENT_SOLD_PRICE_MEDIAN: 'RECENT_SOLD_PRICE_MEDIAN',
  UNKNOWN:                  'UNKNOWN',
});

const ELIGIBLE_ORDER_STATUS = new Set(['shipped', 'completed']);
const ELIGIBLE_PAYMENT_STATUS = new Set(['paid']);
const KNOWN_CURRENCIES = new Set(['KRW', 'USD', 'JPY', 'CNY']);

/**
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {Object} args.db                       Supabase-like client (injectable)
 * @param {number} [args.lookbackDays=30]
 * @param {number} [args.minSamples=3]
 * @param {string[]} [args.channels=['shopify','ebay']]
 * @param {number} [args.asOfMs=Date.now()]      injectable clock
 * @param {number|null} [args.usdKrw]            caller-supplied FX (Phase 2-2C)
 * @param {string|null} [args.usdKrwSource]
 * @param {string|null} [args.usdKrwObservedAt]
 * @param {number|null} [args.krwJpyRate]        caller-supplied · KRW per JPY
 * @param {number|null} [args.krwCnyRate]        caller-supplied · KRW per CNY
 * @param {Function} [args.identityCoverageFn]   injectable analysePhysicalIdentityCoverage
 * @returns {Promise<Object>}
 */
async function getRecentSoldPriceCandidate(args = {}) {
  const {
    physicalProductId, db,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    minSamples = DEFAULT_MIN_SAMPLES,
    channels = DEFAULT_CHANNELS,
    asOfMs,
    usdKrw = null, usdKrwSource = null, usdKrwObservedAt = null,
    krwJpyRate = null, krwCnyRate = null,
    identityCoverageFn = null,
  } = args;
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('getRecentSoldPriceCandidate: physicalProductId required (positive integer)');
  }
  if (!db || typeof db.from !== 'function') {
    throw new Error('getRecentSoldPriceCandidate: db (Supabase-like client) required');
  }
  const nowMs = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const daysN = Math.max(1, Number(lookbackDays) || DEFAULT_LOOKBACK_DAYS);
  const minN  = Math.max(1, Number(minSamples) || DEFAULT_MIN_SAMPLES);
  const windowStartIso = new Date(nowMs - daysN * ONE_DAY_MS).toISOString();
  const windowEndIso   = new Date(nowMs).toISOString();

  const fxRates = _fxTable({ usdKrw, krwJpyRate, krwCnyRate });
  const coverageFn = identityCoverageFn || identityMod.analysePhysicalIdentityCoverage;
  const exclusions = _emptyExclusions();
  const perChannel = [];
  const observations = [];

  for (const ch of channels) {
    const chReport = await _runChannel({
      channel: ch, physicalProductId, db, windowStartIso, windowEndIso,
      coverageFn, fxRates, exclusions,
    });
    perChannel.push(chReport);
    for (const obs of chReport.observations) observations.push(obs);
  }

  if (observations.length === 0) {
    return _unknownResult({
      physicalProductId, daysN, windowStartIso, windowEndIso, channels,
      exclusions, perChannel, minSamples: minN,
      reason: 'no_trustworthy_observations',
    });
  }
  if (observations.length < minN) {
    exclusions.insufficient_samples = { observed: observations.length, required: minN };
    return _unknownResult({
      physicalProductId, daysN, windowStartIso, windowEndIso, channels,
      exclusions, perChannel, minSamples: minN,
      reason: 'insufficient_samples',
    });
  }

  // Compute KRW median · every observation must have amount_krw != null
  const krwValues = observations.map(o => o.amount_krw).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (krwValues.length < minN) {
    exclusions.insufficient_samples = { observed: krwValues.length, required: minN };
    return _unknownResult({
      physicalProductId, daysN, windowStartIso, windowEndIso, channels,
      exclusions, perChannel, minSamples: minN,
      reason: 'insufficient_krw_samples',
    });
  }

  const median = _median(krwValues);
  const min = krwValues[0];
  const max = krwValues[krwValues.length - 1];
  const sortedByTs = observations.slice().sort((a, b) => new Date(a.shipped_at) - new Date(b.shipped_at));
  const oldest = sortedByTs[0]?.shipped_at ?? null;
  const newest = sortedByTs[sortedByTs.length - 1]?.shipped_at ?? null;

  const confidence = _confidenceFromSampleCount(krwValues.length);
  const currencies = [...new Set(observations.map(o => o.currency))].sort();
  const channelsSeen = [...new Set(observations.map(o => o.channel))].sort();

  return {
    status: CANDIDATE_STATUS.RECENT_SOLD_PRICE_MEDIAN,
    candidate_type: CANDIDATE_TYPE,
    value: median,
    currency: 'KRW',
    sample_count: krwValues.length,
    lookback_days: daysN,
    window_start: windowStartIso,
    window_end: windowEndIso,
    min, max, median,
    newest_sale_at: newest,
    oldest_sale_at: oldest,
    channels: channelsSeen,
    currencies_observed: currencies,
    physical_identity_basis: 'analysePhysicalIdentityCoverage.known_identities · SoT · no fuzzy title match',
    confidence,
    exclusions,
    per_channel: perChannel,
    fx: _fxProvenance({ usdKrw, usdKrwSource, usdKrwObservedAt, krwJpyRate, krwCnyRate }),
    provenance: observations.map(o => ({
      order_item_id: o.order_item_id,
      order_id: o.order_id,
      external_order_number: o.external_order_number,
      channel: o.channel,
      sku_master_id: o.sku_master_id,
      unit_price_native: o.unit_price_native,
      currency: o.currency,
      amount_krw: o.amount_krw,
      fx_rate_used: o.fx_rate_used,
      shipped_at: o.shipped_at,
    })),
    note: 'RECENT SOLD MEDIAN · one observation per line (Owner §4 · not weighted by quantity)',
  };
}

async function _runChannel({ channel, physicalProductId, db, windowStartIso, windowEndIso, coverageFn, fxRates, exclusions }) {
  const daysN = Math.round((new Date(windowEndIso) - new Date(windowStartIso)) / ONE_DAY_MS);
  const coverage = await coverageFn({ physicalProductId, channel, days: daysN });
  if (!coverage.velocity_trusted) {
    exclusions.channels_untrusted_identity.push({ channel, reason: coverage.trust_reason });
    return { channel, observations: [], reason: `identity_untrusted:${coverage.trust_reason}`, sku_master_ids: [] };
  }
  const skuIds = new Set((coverage.known_shopify_identities || []).map(k => k.sku_master_id).filter(Boolean));
  if (skuIds.size === 0) {
    exclusions.channels_no_known_sku.push({ channel });
    return { channel, observations: [], reason: 'no_known_sku_master_ids', sku_master_ids: [] };
  }
  //   Trust-gated candidate query. Read orders first (small filter set), then items.
  const orders = await _selectOrders(db, channel, windowStartIso, windowEndIso);
  const eligibleOrders = new Map();     // id → { external_order_number, shipped_at }
  for (const o of orders) {
    if (!o.shipped_at) { exclusions.orders_no_shipped_at++; continue; }
    if (o.cancelled_at) { exclusions.orders_cancelled++; continue; }
    if (!ELIGIBLE_ORDER_STATUS.has(String(o.order_status))) { exclusions.orders_wrong_status[o.order_status] = (exclusions.orders_wrong_status[o.order_status] || 0) + 1; continue; }
    if (!ELIGIBLE_PAYMENT_STATUS.has(String(o.payment_status))) { exclusions.orders_wrong_payment[o.payment_status] = (exclusions.orders_wrong_payment[o.payment_status] || 0) + 1; continue; }
    eligibleOrders.set(o.id, { external_order_number: o.external_order_number, shipped_at: o.shipped_at });
  }
  if (eligibleOrders.size === 0) {
    return { channel, observations: [], reason: 'no_eligible_orders_after_status_filter', sku_master_ids: [...skuIds] };
  }
  const items = await _selectItems(db, [...eligibleOrders.keys()]);
  const observations = [];
  for (const it of items) {
    if (!it.sku_master_id || !skuIds.has(it.sku_master_id)) { exclusions.items_sku_not_in_known++; continue; }
    if (!(Number(it.quantity) > 0)) { exclusions.items_zero_quantity++; continue; }
    const unit = Number(it.unit_price);
    if (!Number.isFinite(unit) || unit <= 0) { exclusions.items_nonpositive_price++; continue; }
    const disc = Number(it.discount);
    if (Number.isFinite(disc) && disc > 0) { exclusions.items_discounted++; continue; }
    const cur = String(it.currency || '').toUpperCase();
    if (!KNOWN_CURRENCIES.has(cur)) { exclusions.items_unknown_currency[cur || '(null)'] = (exclusions.items_unknown_currency[cur || '(null)'] || 0) + 1; continue; }
    const fxRate = fxRates[cur];
    if (!Number.isFinite(fxRate) || fxRate <= 0) { exclusions.items_fx_unavailable[cur] = (exclusions.items_fx_unavailable[cur] || 0) + 1; continue; }
    const ord = eligibleOrders.get(it.order_id);
    const amountKrw = _roundKrw(unit * fxRate);
    observations.push({
      order_item_id: it.id, order_id: it.order_id,
      external_order_number: ord?.external_order_number ?? null,
      shipped_at: ord?.shipped_at ?? null,
      channel, sku_master_id: it.sku_master_id,
      unit_price_native: unit, currency: cur,
      amount_krw: amountKrw, fx_rate_used: fxRate,
    });
  }
  return { channel, observations, reason: null, sku_master_ids: [...skuIds] };
}

async function _selectOrders(db, channel, windowStartIso, windowEndIso) {
  const res = await db.from('oms_orders')
    .select('id, external_order_number, shipped_at, cancelled_at, order_status, payment_status, channel')
    .eq('channel', channel)
    .gte('shipped_at', windowStartIso)
    .lte('shipped_at', windowEndIso);
  if (res && res.error) throw new Error(`oms_orders select failed: ${res.error.message}`);
  return (res && res.data) || [];
}

async function _selectItems(db, orderIds) {
  if (orderIds.length === 0) return [];
  const res = await db.from('oms_order_items')
    .select('id, order_id, sku_master_id, quantity, unit_price, discount, currency')
    .in('order_id', orderIds);
  if (res && res.error) throw new Error(`oms_order_items select failed: ${res.error.message}`);
  return (res && res.data) || [];
}

function _fxTable({ usdKrw, krwJpyRate, krwCnyRate }) {
  const t = { KRW: 1 };
  if (Number.isFinite(Number(usdKrw))     && Number(usdKrw)     > 0) t.USD = Number(usdKrw);
  if (Number.isFinite(Number(krwJpyRate)) && Number(krwJpyRate) > 0) t.JPY = Number(krwJpyRate);
  if (Number.isFinite(Number(krwCnyRate)) && Number(krwCnyRate) > 0) t.CNY = Number(krwCnyRate);
  return t;
}

function _fxProvenance({ usdKrw, usdKrwSource, usdKrwObservedAt, krwJpyRate, krwCnyRate }) {
  const out = { KRW: { rate: 1, source: 'identity' } };
  if (Number.isFinite(Number(usdKrw)) && Number(usdKrw) > 0) {
    out.USD = { rate: Number(usdKrw), source: usdKrwSource || 'caller_supplied', observed_at: usdKrwObservedAt || null };
  }
  if (Number.isFinite(Number(krwJpyRate)) && Number(krwJpyRate) > 0) out.JPY = { rate: Number(krwJpyRate), source: 'caller_supplied' };
  if (Number.isFinite(Number(krwCnyRate)) && Number(krwCnyRate) > 0) out.CNY = { rate: Number(krwCnyRate), source: 'caller_supplied' };
  return out;
}

function _emptyExclusions() {
  return {
    channels_untrusted_identity: [],
    channels_no_known_sku: [],
    orders_no_shipped_at: 0,
    orders_cancelled: 0,
    orders_wrong_status: {},
    orders_wrong_payment: {},
    items_sku_not_in_known: 0,
    items_zero_quantity: 0,
    items_nonpositive_price: 0,
    items_discounted: 0,
    items_unknown_currency: {},
    items_fx_unavailable: {},
    insufficient_samples: null,
  };
}

function _unknownResult({ physicalProductId, daysN, windowStartIso, windowEndIso, channels, exclusions, perChannel, minSamples, reason }) {
  return {
    status: CANDIDATE_STATUS.UNKNOWN,
    candidate_type: CANDIDATE_TYPE,
    reason,
    value: null,
    currency: null,
    sample_count: 0,
    lookback_days: daysN,
    window_start: windowStartIso,
    window_end: windowEndIso,
    min: null, max: null, median: null,
    newest_sale_at: null, oldest_sale_at: null,
    channels_queried: channels,
    channels: [], currencies_observed: [],
    physical_identity_basis: 'analysePhysicalIdentityCoverage.known_identities · SoT · no fuzzy title match',
    confidence: CONFIDENCE.UNKNOWN,
    min_samples_required: minSamples,
    exclusions, per_channel: perChannel,
    provenance: [],
    physical_product_id: physicalProductId,
  };
}

function _median(arrSortedAsc) {
  const n = arrSortedAsc.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? arrSortedAsc[mid] : (arrSortedAsc[mid - 1] + arrSortedAsc[mid]) / 2;
}
function _roundKrw(v) { return Math.round(v); }
function _confidenceFromSampleCount(n) {
  if (n >= 10) return CONFIDENCE.HIGH;
  if (n >= 5)  return CONFIDENCE.MEDIUM;
  if (n >= 2)  return CONFIDENCE.LOW;
  return CONFIDENCE.UNKNOWN;
}

module.exports = {
  getRecentSoldPriceCandidate,
  CANDIDATE_TYPE,
  CANDIDATE_STATUS,
  CONFIDENCE,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_CHANNELS,
  ELIGIBLE_ORDER_STATUS,
  ELIGIBLE_PAYMENT_STATUS,
  KNOWN_CURRENCIES,
};
