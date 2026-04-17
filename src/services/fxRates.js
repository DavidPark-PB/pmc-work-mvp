/**
 * FX rate helper — live USD-based exchange rates with a 6-hour in-memory cache.
 *
 * Source: open.er-api.com (free, no key, updated daily). Returns rates as
 * "1 USD = N <currency>", so to convert local → USD we use 1 / rate.
 *
 * Falls back to hardcoded defaults if the API is unreachable. The fallback
 * was last sanity-checked 2026-04 and is intentionally close to realistic
 * so a single fetch failure doesn't distort reports.
 */
const axios = require('axios');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_USD_PER_UNIT = {
  SGD: 0.74, MYR: 0.22, PHP: 0.018, VND: 0.000041,
  TWD: 0.031, THB: 0.029, IDR: 0.000063, BRL: 0.19,
  USD: 1, KRW: 0.00072, JPY: 0.0067, CNY: 0.14, EUR: 1.08,
};

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

async function _fetchRates() {
  try {
    const r = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
    if (r.data?.result !== 'success' || !r.data.rates) throw new Error('bad response');
    // API returns "1 USD = N ccy"; invert for "local → USD" lookup.
    const perUnit = {};
    for (const [ccy, rate] of Object.entries(r.data.rates)) {
      if (typeof rate === 'number' && rate > 0) perUnit[ccy] = 1 / rate;
    }
    perUnit.USD = 1;
    return perUnit;
  } catch (e) {
    console.warn('[fxRates] live fetch failed, using fallback:', e.message);
    return { ...FALLBACK_USD_PER_UNIT };
  }
}

/**
 * Returns a map { CCY: usd_per_1_unit } covering all fiat currencies the
 * upstream API knows. Cached 6h across callers.
 */
async function getUsdPerUnit() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = _fetchRates().then(rates => {
    _cache = rates;
    _cacheAt = Date.now();
    _inflight = null;
    return rates;
  });
  return _inflight;
}

/**
 * Convenience: convert an amount from `currency` → USD using the cached table.
 * Unknown currencies return `amount` unchanged (logged once).
 */
async function toUsd(amount, currency) {
  const ccy = String(currency || '').toUpperCase();
  if (!ccy || ccy === 'USD') return amount;
  const rates = await getUsdPerUnit();
  const rate = rates[ccy] ?? FALLBACK_USD_PER_UNIT[ccy];
  if (rate == null) return amount;
  return amount * rate;
}

module.exports = { getUsdPerUnit, toUsd };
