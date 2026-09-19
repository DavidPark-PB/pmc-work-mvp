'use strict';

/**
 * tests/services/aiWorkflowPublisherEbayInstance.test.js
 * PMC · aiWorkflowPublisher must NOT singleton the EbayAPI instance
 * (2026-09-19).
 *
 * Owner-reported bug: 4th (and every subsequent) AI 상품제작 attempt
 * failed with `EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN: AddFixedPriceItem`,
 * forcing a Railway restart to unblock. Root cause: aiWorkflowPublisher
 * cached the EbayAPI instance module-level, and EbayAPI._ensureToken()
 * only reads DB once per instance. Another code path rotating the token
 * in DB then made the singleton's cached refresh_token stale, and the
 * mutation-safe fail-closed path (PMC-EXPORT-SAFETY-2F) refused to
 * auto-retry — leaving the operator with permanent lockout until
 * process restart.
 *
 * Fix: aiWorkflowPublisher._getEbay() now returns a fresh EbayAPI per
 * call. Each fresh instance triggers _ensureToken() on first Trading
 * call → reads latest token from DB → uses it. Overhead: one DB SELECT
 * per registration (~50ms) — trivial at any listing volume.
 *
 * This test locks in the invariant so nobody accidentally reintroduces
 * the singleton in the future.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const SRC     = path.join(REPO, 'src/services/aiWorkflowPublisher.js');
const EBAYAPI = path.join(REPO, 'src/api/ebayAPI.js');

//   ─────────────────────────────────────────────────────────────
//   Level A · source-level: no module-scope EbayAPI singleton
//   ─────────────────────────────────────────────────────────────

test('AI-EBAY-A1 · aiWorkflowPublisher.js MUST NOT hold a module-scope EbayAPI singleton', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  //   The old pattern that caused the bug — must not come back.
  assert.ok(!/^\s*let\s+_ebayInstance\s*=/m.test(src),
    'aiWorkflowPublisher MUST NOT declare `let _ebayInstance = …` at module scope');
  assert.ok(!/if\s*\(\s*!\s*_ebayInstance\s*\)/.test(src),
    'aiWorkflowPublisher MUST NOT contain the `if (!_ebayInstance)` singleton guard');
});

test('AI-EBAY-A2 · _getEbay() MUST return a fresh EbayAPI per call (new EbayAPI() in the body)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  //   Extract the function body between `function _getEbay(` and the matching `}`.
  const startIdx = src.indexOf('function _getEbay(');
  assert.ok(startIdx > 0, '_getEbay must exist');
  //   Simple brace-scan.
  const openBrace = src.indexOf('{', startIdx);
  let depth = 0;
  let endIdx = -1;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  assert.ok(endIdx > openBrace, 'could not find _getEbay body end');
  const body = src.slice(openBrace, endIdx);
  //   Fresh instantiation on every call.
  assert.ok(/new\s+EbayAPI\s*\(\s*\)/.test(body),
    '_getEbay body must contain `new EbayAPI()`');
  //   Must not re-introduce singleton caching inside.
  assert.ok(!/_ebayInstance/.test(body),
    '_getEbay must not reference _ebayInstance');
});

//   ─────────────────────────────────────────────────────────────
//   Level B · runtime: each _getEbay() call returns a DISTINCT
//   object that will re-read DB on its first Trading call.
//   ─────────────────────────────────────────────────────────────

test('AI-EBAY-B1 · runtime · two _getEbay() calls yield distinct EbayAPI instances', () => {
  //   Load the module in isolation with the real EbayAPI class.
  //   We do NOT trigger any DB call — just verify object identity differs.
  //   Purge require caches to guarantee a clean module load.
  const publisherPath = require.resolve(SRC);
  const ebayApiPath   = require.resolve(EBAYAPI);
  delete require.cache[publisherPath];
  delete require.cache[ebayApiPath];

  //   Stub tokenStore so a stray _ensureToken doesn't hit a real DB.
  const tokenStorePath = require.resolve(path.join(REPO, 'src/services/tokenStore'));
  delete require.cache[tokenStorePath];
  require.cache[tokenStorePath] = {
    id: tokenStorePath, filename: tokenStorePath, loaded: true,
    exports: {
      loadToken: async () => ({ accessToken: 'stub', refreshToken: 'stub' }),
      saveToken: async () => ({}),
    },
  };

  //   Load fresh — this pulls in the EbayAPI class too.
  const publisher = require(publisherPath);
  //   The module exports don't expose _getEbay directly, but the test can
  //   trigger it via verifyEbay/publishToEbay indirectly. Simplest: reach
  //   into require.cache and reload the module source to read _getEbay by
  //   evaluating the file text — too fragile. Instead, prove the invariant
  //   via a smoke test on the code: monkey-patch EbayAPI constructor and
  //   invoke verifyEbay twice to count constructions.
  const EbayAPI = require(ebayApiPath);
  let ctorCount = 0;
  const origVerify = EbayAPI.prototype.verifyProduct;
  const origEnsure = EbayAPI.prototype._ensureToken;
  //   Hook the constructor via a Proxy on the prototype — we can just count
  //   `_ensureToken` invocations across two verifyEbay calls; the fix
  //   guarantees a NEW instance for each verifyEbay, so _ensureToken (which
  //   is one-shot per instance) must fire once PER call = twice total.
  //   Under the old singleton behavior, _ensureToken would fire ONCE across
  //   both calls.
  let ensureCallCount = 0;
  EbayAPI.prototype._ensureToken = async function () {
    ensureCallCount++;
    this._tokenLoaded = true;
  };
  EbayAPI.prototype.verifyProduct = async function () {
    //   Force _ensureToken to fire the way callTradingAPI does at line 233.
    await this._ensureToken();
    return { success: true, ack: 'Success', errors: [], criticalErrors: [], warnings: [] };
  };
  try {
    return Promise.all([
      publisher.verifyEbay({ title: 'T1', price: 10, sku: 'S1' }, { categoryId: '183456' }),
      publisher.verifyEbay({ title: 'T2', price: 10, sku: 'S2' }, { categoryId: '183456' }),
    ]).then(() => {
      assert.equal(ensureCallCount, 2,
        `_ensureToken MUST fire per call (2 verifies → 2 fresh instances → 2 _ensureToken calls). Got ${ensureCallCount}.`);
    });
  } finally {
    EbayAPI.prototype.verifyProduct = origVerify;
    EbayAPI.prototype._ensureToken  = origEnsure;
  }
});

//   ─────────────────────────────────────────────────────────────
//   Level C · fail-closed for MUTATIONS is still in place
//   (regression guard for PMC-EXPORT-SAFETY-2F — the singleton
//   removal MUST NOT weaken the mutation-uncertainty protection)
//   ─────────────────────────────────────────────────────────────

test('AI-EBAY-C1 · AddFixedPriceItem is still NOT in the READ_ONLY allowlist (fail-closed intact)', () => {
  const src = fs.readFileSync(EBAYAPI, 'utf8');
  const allowMatch = src.match(/EBAY_READ_ONLY_TRADING_VERBS\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\)/);
  assert.ok(allowMatch, 'READ_ONLY allowlist must exist');
  const allowed = allowMatch[1];
  assert.ok(!/['"]AddFixedPriceItem['"]/.test(allowed),
    'AddFixedPriceItem MUST NOT be in the READ_ONLY allowlist (fail-closed for mutations)');
  assert.ok(!/['"]ReviseFixedPriceItem['"]/.test(allowed),
    'ReviseFixedPriceItem MUST NOT be in the READ_ONLY allowlist');
  assert.ok(!/['"]ReviseInventoryStatus['"]/.test(allowed),
    'ReviseInventoryStatus MUST NOT be in the READ_ONLY allowlist');
});

test('AI-EBAY-C2 · the mutation-uncertainty throw still exists in callTradingAPI', () => {
  const src = fs.readFileSync(EBAYAPI, 'utf8');
  assert.ok(/EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN/.test(src),
    'callTradingAPI must still throw EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN for non-allowlisted verbs');
  assert.ok(/EBAY_READ_ONLY_TRADING_VERBS\.has\(callName\)/.test(src),
    'callTradingAPI must gate the auto-refresh path on the READ_ONLY allowlist');
});
