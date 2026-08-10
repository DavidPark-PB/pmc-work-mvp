'use strict';

/**
 * pricing/contract.js — Phase 1 Commit 9
 * ---------------------------------------------------------------------------
 * Source-aware validators for the units and currencies that enter the
 * pricing pipeline. This module deliberately does NOT define a
 * `normalizeFeeRate(v)` that guesses. 13 and 0.13 are both valid numbers
 * and the only way to know what a raw `v` means is to ask which column
 * or setting it came from.
 *
 * Owner directive (2026-08-10):
 *   "normalize 가 아니라 VALIDATE 우선. 13을 보고 자동으로 0.13으로
 *    바꾸는 식의 추측 금지. 애매하면 BLOCK."
 *
 * Canonical target units (used by all pricing engines):
 *   fee_rate                 → decimal fraction (0.13 = 13%)
 *   selling_price / new_price → USD (Number)
 *   cost                     → KRW integer
 *   weight                   → gram integer
 *   exchange_rate            → KRW per 1 USD (positive number)
 *   currency                 → uppercase ISO-4217 string; v1 only accepts 'USD'
 *
 * Source semantics (confirmed by supabase/migrations grep, 2026-08-10):
 *
 *   fee_rate:
 *     platforms.fee_rate        NUMERIC(5,3) DEFAULT 0        → decimal (0.180)
 *     ebay_products.fee_rate    NUMERIC(5,2) DEFAULT 13       → percent (13)
 *     master_products.fee_rate  NUMERIC(5,2) DEFAULT 15 / 5.5 → percent
 *     platform_listings.fee_rate NUMERIC(5,2) DEFAULT 0       → AMBIGUOUS
 *
 *   exchange_rate (KRW per USD):
 *     margin_settings.setting_key='exchange_rate_usd' (value=1400)
 *     platform_listings.exchange_rate NUMERIC(10,2) DEFAULT 1400
 *
 *   weight:
 *     sku_master.weight_gram                INTEGER (g)
 *     master_products.weight_kg             NUMERIC(8,3) DEFAULT 0 (kg)
 *     order_shipments.product_weight_g      NUMERIC(10,2) (g)
 *     b2b_shipments.weight_kg               NUMERIC(8,2) (kg)
 *
 *   currency:
 *     price_events.currency VARCHAR(8) DEFAULT 'USD'
 *     wms_orders.currency   varies
 *     ebay_products.price_usd  (column name is authoritative)
 *
 *   cost:
 *     sku_master.cost_krw        integer (KRW, column-named)
 *     products.purchase_price    NUMERIC(10,2) (KRW, column-name-less)
 *     master_products.total_cost INTEGER (KRW)
 *     platform_listings.purchase_price_krw NUMERIC (KRW, column-named)
 *
 * SoT consolidation is a Phase 2 concern. This module keeps the current
 * columns and semantics but forces every conversion to be explicit.
 */

/* ─────────────────────────── shared primitives ─────────────────────────── */

const CONTRACT_ERRORS = Object.freeze({
  NULL_OR_MISSING: 'CONTRACT_NULL_OR_MISSING',
  NOT_A_NUMBER: 'CONTRACT_NOT_A_NUMBER',
  NEGATIVE: 'CONTRACT_NEGATIVE',
  ZERO_WHERE_POSITIVE_REQUIRED: 'CONTRACT_ZERO_WHERE_POSITIVE_REQUIRED',
  OUT_OF_EXPECTED_RANGE: 'CONTRACT_OUT_OF_EXPECTED_RANGE',
  AMBIGUOUS_SCALE: 'CONTRACT_AMBIGUOUS_SCALE',
  UNSUPPORTED_CURRENCY: 'CONTRACT_UNSUPPORTED_CURRENCY',
  MISSING_UNIT_TAG: 'CONTRACT_MISSING_UNIT_TAG',
  NON_INTEGER: 'CONTRACT_NON_INTEGER',
});

function _ok(value) { return { ok: true, value, error: null }; }
function _fail(errorCode, detail) { return { ok: false, value: null, error: errorCode, detail: detail || null }; }

function _finiteNumber(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: CONTRACT_ERRORS.NULL_OR_MISSING };
  if (typeof raw === 'boolean') return { ok: false, error: CONTRACT_ERRORS.NOT_A_NUMBER };
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, error: CONTRACT_ERRORS.NULL_OR_MISSING };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: CONTRACT_ERRORS.NOT_A_NUMBER };
  return { ok: true, value: n };
}

/* ─────────────────────────── fee_rate (source-aware) ─────────────────────────── */

/**
 * platforms.fee_rate → canonical decimal (0..1).
 * Valid range is [0, 1]. Anything else → OUT_OF_EXPECTED_RANGE.
 * The stored NUMERIC(5,3) supports up to 99.999 physically, so we reject
 * values > 1 to catch the "13 was written to the wrong table" mistake.
 */
function feeRateFromPlatforms(raw) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value < 0) return _fail(CONTRACT_ERRORS.NEGATIVE);
  if (n.value > 1) return _fail(CONTRACT_ERRORS.OUT_OF_EXPECTED_RANGE, 'platforms.fee_rate must be a decimal 0..1');
  return _ok(n.value);
}

/**
 * ebay_products.fee_rate → canonical decimal.
 * Source is stored as percent points (e.g., 13 = 13%). Valid raw range
 * [0, 100]; divides by 100. Value already ≤ 1 is likely mis-classified
 * → AMBIGUOUS_SCALE (fail-closed, do not guess).
 */
function feeRateFromEbayProducts(raw) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value < 0) return _fail(CONTRACT_ERRORS.NEGATIVE);
  if (n.value > 100) return _fail(CONTRACT_ERRORS.OUT_OF_EXPECTED_RANGE, 'ebay_products.fee_rate percent must be 0..100');
  // A value in [0..1] is either 0% (rare) or a decimal accidentally stored
  // in a percent column. 0 itself is allowed (real "no fee"). Between 0 and
  // 1 exclusive is ambiguous.
  if (n.value > 0 && n.value < 1) return _fail(CONTRACT_ERRORS.AMBIGUOUS_SCALE, 'ebay_products.fee_rate looks like a decimal, expected percent');
  return _ok(n.value / 100);
}

/** master_products.fee_rate (percent, 0..100) → canonical decimal. Same
 *  rules as ebay_products. */
function feeRateFromMasterProducts(raw) {
  return feeRateFromEbayProducts(raw);
}

/**
 * platform_listings.fee_rate — AMBIGUOUS SOURCE.
 * NUMERIC(5,2) DEFAULT 0. Zero-only rows tell us nothing about scale.
 * v1 refuses to interpret this field.
 */
function feeRateFromPlatformListings(raw, opts = {}) {
  // Owner can pass { scaleHint: 'decimal' | 'percent' } when a specific row
  // is known-good. Without a hint we fail-closed.
  if (!opts.scaleHint) return _fail(CONTRACT_ERRORS.AMBIGUOUS_SCALE, 'platform_listings.fee_rate scale undefined; caller must pass scaleHint');
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value < 0) return _fail(CONTRACT_ERRORS.NEGATIVE);
  if (opts.scaleHint === 'decimal') {
    if (n.value > 1) return _fail(CONTRACT_ERRORS.OUT_OF_EXPECTED_RANGE, 'decimal scale must be 0..1');
    return _ok(n.value);
  }
  if (opts.scaleHint === 'percent') {
    if (n.value > 100) return _fail(CONTRACT_ERRORS.OUT_OF_EXPECTED_RANGE, 'percent scale must be 0..100');
    return _ok(n.value / 100);
  }
  return _fail(CONTRACT_ERRORS.AMBIGUOUS_SCALE, `unknown scaleHint: ${opts.scaleHint}`);
}

/* ─────────────────────────── currency ─────────────────────────── */

const SUPPORTED_CURRENCIES = new Set(['USD']);

/**
 * Validate an explicit currency field. v1 only accepts USD for the eBay
 * pricing path. Missing / mismatched → BLOCK candidate.
 * @param raw currency string (case-insensitive)
 * @param opts.expected default 'USD'
 */
function currencyForEbayPrice(raw, opts = {}) {
  const expected = String(opts.expected || 'USD').toUpperCase();
  if (raw === null || raw === undefined || raw === '') return _fail(CONTRACT_ERRORS.NULL_OR_MISSING);
  if (typeof raw !== 'string') return _fail(CONTRACT_ERRORS.NOT_A_NUMBER, 'currency must be string');
  const up = raw.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(up)) return _fail(CONTRACT_ERRORS.UNSUPPORTED_CURRENCY, `unsupported currency: ${raw}`);
  if (up !== expected) return _fail(CONTRACT_ERRORS.UNSUPPORTED_CURRENCY, `currency ${up} != expected ${expected}`);
  return _ok(up);
}

/* ─────────────────────────── exchange_rate ─────────────────────────── */

/**
 * Exchange rate: KRW per 1 USD. Must be a positive finite number.
 * Zero, negative, missing → BLOCK. No silent 1400 default here.
 *
 * Reasonable production range 800..3000 for KRW/USD; outside that we
 * refuse. Owner can override with opts.rangeMax / rangeMin for testing.
 */
function exchangeRateKrwPerUsd(raw, opts = {}) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value <= 0) return _fail(CONTRACT_ERRORS.ZERO_WHERE_POSITIVE_REQUIRED);
  const min = opts.rangeMin ?? 500;
  const max = opts.rangeMax ?? 5000;
  if (n.value < min || n.value > max) {
    return _fail(CONTRACT_ERRORS.OUT_OF_EXPECTED_RANGE, `expected KRW/USD in ${min}..${max}, got ${n.value}`);
  }
  return _ok(n.value);
}

/* ─────────────────────────── weight ─────────────────────────── */

/** Read a `weight_gram`-typed field. Must be a positive integer or 0 is
 *  business-invalid for shipping. Owner can pass { allowZero: true } when
 *  0 means "not weighed yet" and BLOCK is the shipping caller's problem. */
function weightGram(raw, opts = {}) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (!Number.isInteger(n.value)) return _fail(CONTRACT_ERRORS.NON_INTEGER, 'weight_gram must be integer');
  if (n.value < 0) return _fail(CONTRACT_ERRORS.NEGATIVE);
  if (n.value === 0 && !opts.allowZero) return _fail(CONTRACT_ERRORS.ZERO_WHERE_POSITIVE_REQUIRED, 'zero weight invalid for shipping');
  return _ok(n.value);
}

/** Read a `weight_kg`-typed field and convert to canonical grams.
 *  Multiplies by 1000 explicitly. Fails on negative / non-finite. */
function weightKgToGram(raw, opts = {}) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value < 0) return _fail(CONTRACT_ERRORS.NEGATIVE);
  const g = Math.round(n.value * 1000);
  if (g === 0 && !opts.allowZero) return _fail(CONTRACT_ERRORS.ZERO_WHERE_POSITIVE_REQUIRED, 'zero weight invalid for shipping');
  return _ok(g);
}

/** Raw weight with NO unit tag — refuse. Callers must know their source
 *  column. */
function weightWithoutUnitTag(_raw) {
  return _fail(CONTRACT_ERRORS.MISSING_UNIT_TAG, 'weight source unit not specified; use weightGram or weightKgToGram');
}

/* ─────────────────────────── price / cost ─────────────────────────── */

/** USD selling price. Positive finite; hard upper bound 1M to catch
 *  runaway decimals (99999999 sneaking through). */
function sellingPriceUsd(raw) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value <= 0) return _fail(CONTRACT_ERRORS.ZERO_WHERE_POSITIVE_REQUIRED);
  if (n.value > 1_000_000) return _fail(CONTRACT_ERRORS.OUT_OF_EXPECTED_RANGE, `USD price too large: ${n.value}`);
  return _ok(n.value);
}

/** KRW cost. Must be finite; 0 allowed (for a free giveaway or an
 *  unpopulated sku_master row treated elsewhere). */
function costKrw(raw, opts = {}) {
  const n = _finiteNumber(raw);
  if (!n.ok) return _fail(n.error);
  if (n.value < 0) return _fail(CONTRACT_ERRORS.NEGATIVE);
  if (!opts.allowNonInteger && !Number.isInteger(n.value)) {
    // KRW is nominally integer. Accept decimals only with an explicit flag.
    return _fail(CONTRACT_ERRORS.NON_INTEGER, 'KRW should be integer; pass allowNonInteger to relax');
  }
  return _ok(n.value);
}

/* ─────────────────────────── batch validators ─────────────────────────── */

/**
 * Validate every field a pricing decision needs. Returns { ok, errors, value }.
 * If any field fails, ok=false and errors[] lists them. Downstream callers
 * that already have their own validation are not required to use this —
 * it's a convenience for the pricing entry points.
 *
 * @param inputs {
 *   feeRate:      { source: 'platforms'|'ebay_products'|'master_products'|'platform_listings', raw, scaleHint? }
 *   currency:     raw string
 *   exchangeRate: raw number (KRW per USD)
 *   weight:       { source: 'weight_gram'|'weight_kg', raw }
 *   sellingPriceUsd: raw number
 *   costKrw:      raw number
 * }
 */
function validatePricingInputs(inputs) {
  const errors = [];
  const value = {};

  if (inputs.feeRate !== undefined) {
    const src = inputs.feeRate.source;
    let r;
    if (src === 'platforms')          r = feeRateFromPlatforms(inputs.feeRate.raw);
    else if (src === 'ebay_products') r = feeRateFromEbayProducts(inputs.feeRate.raw);
    else if (src === 'master_products') r = feeRateFromMasterProducts(inputs.feeRate.raw);
    else if (src === 'platform_listings') r = feeRateFromPlatformListings(inputs.feeRate.raw, { scaleHint: inputs.feeRate.scaleHint });
    else r = _fail(CONTRACT_ERRORS.MISSING_UNIT_TAG, `unknown fee_rate source: ${src}`);
    if (!r.ok) errors.push({ field: 'feeRate', ...r });
    else value.feeRate = r.value;
  }
  if (inputs.currency !== undefined) {
    const r = currencyForEbayPrice(inputs.currency);
    if (!r.ok) errors.push({ field: 'currency', ...r });
    else value.currency = r.value;
  }
  if (inputs.exchangeRate !== undefined) {
    const r = exchangeRateKrwPerUsd(inputs.exchangeRate);
    if (!r.ok) errors.push({ field: 'exchangeRate', ...r });
    else value.exchangeRate = r.value;
  }
  if (inputs.weight !== undefined) {
    const src = inputs.weight.source;
    let r;
    if (src === 'weight_gram')      r = weightGram(inputs.weight.raw);
    else if (src === 'weight_kg')   r = weightKgToGram(inputs.weight.raw);
    else r = weightWithoutUnitTag(inputs.weight.raw);
    if (!r.ok) errors.push({ field: 'weight', ...r });
    else value.weightGram = r.value;
  }
  if (inputs.sellingPriceUsd !== undefined) {
    const r = sellingPriceUsd(inputs.sellingPriceUsd);
    if (!r.ok) errors.push({ field: 'sellingPriceUsd', ...r });
    else value.sellingPriceUsd = r.value;
  }
  if (inputs.costKrw !== undefined) {
    const r = costKrw(inputs.costKrw);
    if (!r.ok) errors.push({ field: 'costKrw', ...r });
    else value.costKrw = r.value;
  }

  return { ok: errors.length === 0, errors, value };
}

module.exports = {
  CONTRACT_ERRORS,
  SUPPORTED_CURRENCIES,
  feeRateFromPlatforms,
  feeRateFromEbayProducts,
  feeRateFromMasterProducts,
  feeRateFromPlatformListings,
  currencyForEbayPrice,
  exchangeRateKrwPerUsd,
  weightGram,
  weightKgToGram,
  weightWithoutUnitTag,
  sellingPriceUsd,
  costKrw,
  validatePricingInputs,
};
