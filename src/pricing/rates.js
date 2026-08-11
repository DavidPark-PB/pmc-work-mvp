'use strict';

/**
 * pricing/rates.js — Phase 2-1A
 * ---------------------------------------------------------------------------
 * Single source of truth for the KRW/USD exchange rate used in pricing math.
 *
 * Owner directive (2026-08-10):
 *   "USD 매출을 KRW로 환산할 때 보수적인 환율을 사용한다.
 *    market rate = 1410 KRW/USD, pricing safety rate = 1300 KRW/USD.
 *    1300은 stale market rate가 아니라 의도적인 conservative pricing parameter다."
 *
 * Current SoT: margin_settings.setting_key='exchange_rate_usd'
 *   - Not auto-updated (grep confirmed: only PUT /api/platform-registry/settings
 *     writes it, and only from the operator UI).
 *   - Currently holds 1400 (5 months stale as of 2026-08-11).
 *   - Semantically already used as "conservative pricing rate", though the
 *     column name suggests market rate. Rename is deferred to Phase 2-2.
 *
 * All pricing calculators MUST read via getPricingSafetyExchangeRate() and
 * NOT hardcode 1400 / 1450 / 1350 / any literal.
 */

const platformRegistry = require('../services/platformRegistry');

// Fallback used ONLY when the DB lookup fails. Kept at 1400 to preserve
// prior behaviour bit-for-bit until owner explicitly updates margin_settings.
// Not a semantic default — the DB value is the source.
const FALLBACK_RATE_KRW_PER_USD = 1400;

// Minimum plausible KRW/USD (sanity guard; owner can change via contract.js).
const MIN_PLAUSIBLE_RATE = 500;
const MAX_PLAUSIBLE_RATE = 5000;

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Return the conservative pricing exchange rate (KRW per 1 USD).
 * Cached for 30s to avoid hammering platformRegistry on hot paths.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.bypassCache=false]
 * @returns {Promise<number>}
 */
async function getPricingSafetyExchangeRate(opts = {}) {
  const now = Date.now();
  if (!opts.bypassCache && _cache != null && (now - _cacheAt) < CACHE_TTL_MS) {
    return _cache;
  }
  let raw;
  try {
    const rates = await platformRegistry.getExchangeRates();
    raw = Number(rates?.usd);
  } catch (e) {
    // Log only; fallback below.
    // eslint-disable-next-line no-console
    console.warn('[pricing/rates] margin_settings.exchange_rate_usd read failed, using fallback:', e.message);
  }
  const value = Number.isFinite(raw) && raw >= MIN_PLAUSIBLE_RATE && raw <= MAX_PLAUSIBLE_RATE
    ? raw
    : FALLBACK_RATE_KRW_PER_USD;
  _cache = value;
  _cacheAt = now;
  return value;
}

/** Synchronous access after `getPricingSafetyExchangeRate` has cached at
 *  least once. Callers on hot loops should pre-warm the cache. Returns the
 *  fallback if never warmed. */
function getPricingSafetyExchangeRateSync() {
  return _cache != null ? _cache : FALLBACK_RATE_KRW_PER_USD;
}

/** For tests only. */
function _resetCache() { _cache = null; _cacheAt = 0; }

module.exports = {
  getPricingSafetyExchangeRate,
  getPricingSafetyExchangeRateSync,
  FALLBACK_RATE_KRW_PER_USD,
  MIN_PLAUSIBLE_RATE,
  MAX_PLAUSIBLE_RATE,
  _resetCache,
};
