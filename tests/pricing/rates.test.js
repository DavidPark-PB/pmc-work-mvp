'use strict';

/**
 * rates.test.js — Phase 2-1A
 * ---------------------------------------------------------------------------
 * Verifies the pricing safety exchange rate helper reads from
 * margin_settings.exchange_rate_usd via platformRegistry and falls back
 * cleanly. Also pins the audit assertions that no caller in the pricing
 * path uses a raw `|| 1400` literal for the exchange rate anymore.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const rates = require('../../src/pricing/rates');

/* ─────────────────────────── 1. helper behaviour ─────────────────────────── */

test('FALLBACK_RATE_KRW_PER_USD is 1400 (matches historical behaviour)', () => {
  assert.equal(rates.FALLBACK_RATE_KRW_PER_USD, 1400);
});

test('MIN/MAX plausible bounds guard obvious garbage', () => {
  assert.equal(rates.MIN_PLAUSIBLE_RATE < rates.MAX_PLAUSIBLE_RATE, true);
  assert.equal(rates.MIN_PLAUSIBLE_RATE >= 500, true);
  assert.equal(rates.MAX_PLAUSIBLE_RATE <= 5000, true);
});

test('getPricingSafetyExchangeRateSync returns fallback before warm-up', () => {
  rates._resetCache();
  assert.equal(rates.getPricingSafetyExchangeRateSync(), 1400);
});

test('helper reads from platformRegistry.getExchangeRates.usd when valid', async () => {
  rates._resetCache();
  // stub platformRegistry via cache invalidation and require override
  const platformRegistry = require('../../src/services/platformRegistry');
  const orig = platformRegistry.getExchangeRates;
  platformRegistry.getExchangeRates = async () => ({ usd: 1300 });
  try {
    const v = await rates.getPricingSafetyExchangeRate({ bypassCache: true });
    assert.equal(v, 1300);
    assert.equal(rates.getPricingSafetyExchangeRateSync(), 1300);
  } finally {
    platformRegistry.getExchangeRates = orig;
    rates._resetCache();
  }
});

test('helper falls back when platformRegistry throws', async () => {
  rates._resetCache();
  const platformRegistry = require('../../src/services/platformRegistry');
  const orig = platformRegistry.getExchangeRates;
  platformRegistry.getExchangeRates = async () => { throw new Error('db down'); };
  try {
    const v = await rates.getPricingSafetyExchangeRate({ bypassCache: true });
    assert.equal(v, 1400);
  } finally {
    platformRegistry.getExchangeRates = orig;
    rates._resetCache();
  }
});

test('helper falls back when platformRegistry returns garbage', async () => {
  rates._resetCache();
  const platformRegistry = require('../../src/services/platformRegistry');
  const orig = platformRegistry.getExchangeRates;
  for (const garbage of [{ usd: null }, { usd: 'abc' }, { usd: -100 }, { usd: 100000 }, {}, null]) {
    platformRegistry.getExchangeRates = async () => garbage;
    const v = await rates.getPricingSafetyExchangeRate({ bypassCache: true });
    assert.equal(v, 1400, `expected fallback for ${JSON.stringify(garbage)}`);
    rates._resetCache();
  }
  platformRegistry.getExchangeRates = orig;
});

test('helper caches within TTL', async () => {
  rates._resetCache();
  const platformRegistry = require('../../src/services/platformRegistry');
  const orig = platformRegistry.getExchangeRates;
  let calls = 0;
  platformRegistry.getExchangeRates = async () => { calls++; return { usd: 1350 }; };
  try {
    await rates.getPricingSafetyExchangeRate();
    await rates.getPricingSafetyExchangeRate();
    await rates.getPricingSafetyExchangeRate();
    assert.equal(calls, 1, 'should hit DB once within TTL');
  } finally {
    platformRegistry.getExchangeRates = orig;
    rates._resetCache();
  }
});

test('helper hits DB again when bypassCache=true', async () => {
  rates._resetCache();
  const platformRegistry = require('../../src/services/platformRegistry');
  const orig = platformRegistry.getExchangeRates;
  let calls = 0;
  platformRegistry.getExchangeRates = async () => { calls++; return { usd: 1350 }; };
  try {
    await rates.getPricingSafetyExchangeRate();
    await rates.getPricingSafetyExchangeRate({ bypassCache: true });
    assert.equal(calls, 2);
  } finally {
    platformRegistry.getExchangeRates = orig;
    rates._resetCache();
  }
});

/* ─────────────────────────── 2. static audit — pricing callers use helper ─────────────────────────── */

const readSrc = f => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

test('AUDIT: repricingService.evaluateRepricing uses rates helper, not raw || 1400', () => {
  const src = readSrc('src/services/repricingService.js');
  // Extract the evaluateRepricing block (starts here, next method after)
  const start = src.indexOf('async evaluateRepricing');
  const rest = src.slice(start);
  const next = rest.slice(80).search(/async\s+\w+\s*\(/);
  const block = next === -1 ? rest : rest.slice(0, 80 + next);
  assert.match(block, /getPricingSafetyExchangeRate/);
  // Old pattern gone
  assert.equal(/rates\.usd\s*\|\|\s*1400/.test(block), false,
    'evaluateRepricing should not read rates.usd || 1400 anymore');
});

test('AUDIT: operations.js /profit route uses rates helper', () => {
  const src = readSrc('src/web/routes/operations.js');
  // Only checking the exchange-rate section — grep near line 906-912.
  // The old block hardcoded `|| 1400`; now uses getPricingSafetyExchangeRate.
  assert.match(src, /getPricingSafetyExchangeRate/);
  const oldBlock = src.match(/const \{ data: settings \} = await supabase[\s\S]*?\|\|\s*1400/);
  assert.equal(oldBlock, null, 'legacy inline settings + || 1400 block should be removed');
});

test('AUDIT: api.js revenue summary uses rates helper', () => {
  const src = readSrc('src/web/routes/api.js');
  // Look for the specific line region
  assert.match(src, /getPricingSafetyExchangeRate\(\)/);
  // The exact old expression should no longer appear
  assert.equal(/const exchangeRate = rates\.usd \|\| 1400;/.test(src), false);
});

/* ─────────────────────────── 3. Operations fee_rate percent-safe (2-1B) ─────────────────────────── */

test('AUDIT: operations.js /profit fee_rate now percent-safe', () => {
  const src = readSrc('src/web/routes/operations.js');
  // Old decimal-assumption pattern
  assert.equal(/const feeRate = targetListing\?\.fee_rate \|\| 0\.18;/.test(src), false);
  // New pattern converts percent → decimal
  assert.match(src, /rawFeeRate/);
  assert.match(src, /Number\(rawFeeRate\)\s*\/\s*100/);
  assert.match(src, /Phase 2-1B/);
});

/* ─────────────────────────── 4. Contract enforcement (2-2A) ─────────────────────────── */
// Phase 2-1C shipped log-only; Phase 2-2A promoted it to hard enforcement
// with a 3-way classifier (VALID / INVALID_DATA / MISSING_DATA / NO_ROW).
// See tests/pricing/contractEnforcement.test.js for the behavioural
// contract; the audit below just pins that the old log-only markers are
// gone and the new enforcement markers are present.

test('AUDIT: engine1DryRunJob promoted from log-only to hard enforcement (2-2A)', () => {
  const src = readSrc('src/jobs/engine1DryRunJob.js');
  assert.match(src, /require\(['"]\.\.\/pricing\/contract['"]\)/);
  // Legacy log-only markers removed
  assert.equal(/_logOnlyContractCheck/.test(src), false,
    'log-only helper should be gone in Phase 2-2A');
  assert.equal(/_flushContractViolations/.test(src), false,
    'log-only flush should be gone in Phase 2-2A');
  // New enforcement markers
  assert.match(src, /classifyPricingInputs/);
  assert.match(src, /classifySharedParams/);
  assert.match(src, /_flushCoverageTelemetry/);
  assert.match(src, /Phase 2-2A/);
  assert.match(src, /REASON\.BLOCK_CONTRACT_VIOLATION/);
});
