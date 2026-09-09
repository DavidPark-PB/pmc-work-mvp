'use strict';

/**
 * tests/api/ebayTradingApiRetryPolicy.test.js — PMC-EXPORT-SAFETY-2F
 * (2026-09-09).
 *
 * Proves the READ/WRITE-aware retry policy in EbayAPI.callTradingAPI:
 *
 *   · READ_ONLY Trading verbs (allow-list): token-invalid → refresh + 1 retry.
 *     Max 2 Trading POSTs total, max 1 refresh.
 *   · MUTATING Trading verbs (fail-closed default for anything NOT in the
 *     allow-list): token-invalid → throw
 *     `EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN` with `.code` and `.callName`;
 *     NO refresh, NO resend. Exactly 1 Trading POST.
 *   · Unknown/future Trading verbs: same as MUTATING (fail-closed).
 *
 * All HTTP mocked via require.cache substitution of `axios`. No real
 * network. No real DB. No marketplace calls.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '../..');

// ═════════════════════════════════════════════════════════════════════
// Mock harness · install BEFORE require('src/api/ebayAPI')
// ═════════════════════════════════════════════════════════════════════

const tradingCalls = []; // { xml, headers, callName }
const oauthCalls   = []; // OAuth refresh calls
let   tradingPostBehavior = null;  // (url, xml, cfg) → response | throws
let   oauthPostBehavior   = null;  // configurable per test

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = {
    id: fullPath, filename: fullPath, loaded: true,
    exports: exportsObj, children: [], paths: [],
  };
}
function resetSpies() {
  tradingCalls.length = 0;
  oauthCalls.length   = 0;
  tradingPostBehavior = null;
  oauthPostBehavior   = null;
}

//   Fake axios · discriminates Trading POST from OAuth POST by URL.
function fakeAxiosPost(url, body, cfg) {
  if (/\/ws\/api\.dll$/.test(String(url))) {
    //   Trading API — extract callName from headers.
    const callName = cfg?.headers?.['X-EBAY-API-CALL-NAME'];
    tradingCalls.push({ url, xml: body, headers: cfg?.headers, callName });
    if (typeof tradingPostBehavior === 'function') return tradingPostBehavior(url, body, cfg);
    //   Default success response with valid Ack.
    return Promise.resolve({ status: 200, data: '<GetUserResponse><Ack>Success</Ack></GetUserResponse>' });
  }
  if (/\/identity\/v1\/oauth2\/token$/.test(String(url))) {
    //   OAuth token endpoint.
    oauthCalls.push({ url, body, cfg });
    if (typeof oauthPostBehavior === 'function') return oauthPostBehavior(url, body, cfg);
    //   Default: successful refresh returning a new access_token.
    return Promise.resolve({ status: 200, data: { access_token: 'new-token-' + oauthCalls.length, refresh_token: 'new-refresh', expires_in: 7200 } });
  }
  throw new Error('fakeAxiosPost: unexpected URL: ' + url);
}
const fakeAxios = function(config) {
  throw new Error('fakeAxios: unexpected direct call (Trading uses .post)');
};
fakeAxios.post   = fakeAxiosPost;
fakeAxios.get    = async () => { throw new Error('fakeAxios.get: unused'); };
fakeAxios.put    = async () => { throw new Error('fakeAxios.put: unused'); };
fakeAxios.delete = async () => { throw new Error('fakeAxios.delete: unused'); };

stub(require.resolve('axios'), fakeAxios);
stub(require.resolve(path.join(REPO, 'src/config')), {});
stub(require.resolve(path.join(REPO, 'src/services/tokenStore')), {
  //   Prevent DB access from constructor's _ensureToken.
  async loadToken(_platform) { return null; },
  async saveToken(_platform, _tokens) { return; },
});

//   Constructor env requirements.
process.env.EBAY_APP_ID = 'app-id';
process.env.EBAY_CERT_ID = 'cert-id';
process.env.EBAY_DEV_ID = 'dev-id';
process.env.EBAY_USER_TOKEN = 'v^1.1#i^1#f^0#r^0#p^3#I^3#t^H4sIAAAAAAAAAOVYbWwUx' + 'x'.repeat(250);
process.env.EBAY_REFRESH_TOKEN = 'refresh-tok-seed';
process.env.EBAY_ENVIRONMENT = 'PRODUCTION';

//   Load EbayAPI fresh.
delete require.cache[require.resolve(path.join(REPO, 'src/api/ebayAPI'))];
const EbayAPI = require(path.join(REPO, 'src/api/ebayAPI'));

//   Helper to build a token-invalid Trading response.
function tokenInvalidResponse() {
  return Promise.resolve({
    status: 200,
    data: '<eBayApiErrorResponse><Ack>Failure</Ack><Errors><ErrorCode>931</ErrorCode><ShortMessage>Auth token is invalid</ShortMessage></Errors></eBayApiErrorResponse>',
  });
}
function successResponse(callName) {
  return Promise.resolve({
    status: 200,
    data: `<${callName}Response><Ack>Success</Ack><ItemID>ITEM-999</ItemID></${callName}Response>`,
  });
}
function nonTokenBusinessFailure() {
  return Promise.resolve({
    status: 400,
    data: '<ItemFailure><Ack>Failure</Ack><Errors><ErrorCode>50</ErrorCode><ShortMessage>Invalid Category</ShortMessage></Errors></ItemFailure>',
  });
}

// ═════════════════════════════════════════════════════════════════════
// MUTATING calls — every MUTATING verb must fail-closed on token-invalid
// ═════════════════════════════════════════════════════════════════════

for (const mutatingVerb of [
  'AddFixedPriceItem',
  'ReviseInventoryStatus',
  'ReviseFixedPriceItem',
  'AddMemberMessageRTQ',
  'UploadSiteHostedPictures',
]) {
  test(`2F-MUT · ${mutatingVerb} · token-invalid → 1 POST · 0 refresh · throws EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN`, async () => {
    resetSpies();
    tradingPostBehavior = () => tokenInvalidResponse();
    const api = new EbayAPI();
    let caught = null;
    try { await api.callTradingAPI(mutatingVerb, '<x/>'); }
    catch (e) { caught = e; }
    //   Exactly ONE Trading POST — no resend.
    assert.equal(tradingCalls.length, 1, 'exactly one Trading POST for a mutating verb on token-invalid');
    //   ZERO refresh calls.
    assert.equal(oauthCalls.length, 0, 'no OAuth refresh for a mutating verb on token-invalid');
    //   Deterministic uncertainty error with structured metadata.
    assert.ok(caught, 'must throw');
    assert.equal(caught.code, 'EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN');
    assert.equal(caught.callName, mutatingVerb);
    assert.ok(String(caught.message).includes(mutatingVerb), 'message must include callName for logs');
    //   Message must NOT include the XML payload or token (structured metadata only).
    assert.ok(!/eBayAuthToken/.test(caught.message), 'must not leak eBayAuthToken');
    assert.ok(!/v\^1\.1#/.test(caught.message), 'must not leak IAF token pattern');
  });
}

// ═════════════════════════════════════════════════════════════════════
// UNKNOWN/future verb — fail-closed default
// ═════════════════════════════════════════════════════════════════════

test('2F-UNK · unknown Trading verb · token-invalid → 1 POST · 0 refresh · throws EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN', async () => {
  resetSpies();
  tradingPostBehavior = () => tokenInvalidResponse();
  const api = new EbayAPI();
  let caught = null;
  try { await api.callTradingAPI('SomeFutureTradingMutation', '<x/>'); }
  catch (e) { caught = e; }
  assert.equal(tradingCalls.length, 1, 'unknown verb must NOT auto-retry');
  assert.equal(oauthCalls.length, 0, 'unknown verb must NOT refresh');
  assert.equal(caught?.code, 'EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN');
  assert.equal(caught?.callName, 'SomeFutureTradingMutation');
});

// ═════════════════════════════════════════════════════════════════════
// READ_ONLY calls — retain refresh + 1 retry semantics
// ═════════════════════════════════════════════════════════════════════

for (const readVerb of ['GetOrders', 'GetItem', 'GetUser']) {
  test(`2F-READ · ${readVerb} · attempt1 token-invalid → refresh → attempt2 success · POST=2 · refresh=1`, async () => {
    resetSpies();
    let attempts = 0;
    tradingPostBehavior = () => {
      attempts++;
      return attempts === 1 ? tokenInvalidResponse() : successResponse(readVerb);
    };
    const api = new EbayAPI();
    const result = await api.callTradingAPI(readVerb, '<x/>');
    assert.equal(tradingCalls.length, 2, `${readVerb}: exactly 2 Trading POSTs (attempt + retry)`);
    assert.equal(oauthCalls.length, 1, `${readVerb}: exactly 1 OAuth refresh`);
    //   Both attempts sent the same callName.
    assert.equal(tradingCalls[0].callName, readVerb);
    assert.equal(tradingCalls[1].callName, readVerb);
    //   Second-attempt success returned to caller.
    assert.ok(/Ack>Success/.test(String(result)));
  });

  test(`2F-READ · ${readVerb} · both attempts token-invalid → POST=2 · refresh=1 · NO third attempt`, async () => {
    resetSpies();
    tradingPostBehavior = () => tokenInvalidResponse();
    const api = new EbayAPI();
    let caught = null;
    let result = null;
    try { result = await api.callTradingAPI(readVerb, '<x/>'); }
    catch (e) { caught = e; }
    //   Central invariant of §4: max 2 Trading POSTs, max 1 refresh, no third
    //   attempt regardless of whether the second attempt succeeds or still
    //   looks token-invalid.
    assert.equal(tradingCalls.length, 2, `${readVerb}: cap at 2 POSTs · no third`);
    assert.equal(oauthCalls.length, 1, `${readVerb}: cap at 1 refresh`);
    //   Under the preserved pre-2F contract, a status:200 body with
    //   ErrorCode 931 on the SECOND attempt returns the body as-is (the
    //   caller is responsible for inspecting Ack). Whether the read
    //   ultimately resolves or throws depends on the callTradingAPI-external
    //   caller. What 2F guarantees here: read verbs are NEVER classified as
    //   EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN.
    if (caught) {
      assert.notEqual(caught.code, 'EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN',
        'read verb must NOT be classified as mutation uncertainty');
    }
  });
}

// ═════════════════════════════════════════════════════════════════════
// Normal success / normal business failure regressions
// ═════════════════════════════════════════════════════════════════════

test('2F-OK-MUT · mutating verb · normal success on first POST → 1 POST · 0 refresh', async () => {
  resetSpies();
  tradingPostBehavior = () => successResponse('AddFixedPriceItem');
  const api = new EbayAPI();
  const result = await api.callTradingAPI('AddFixedPriceItem', '<x/>');
  assert.equal(tradingCalls.length, 1);
  assert.equal(oauthCalls.length, 0);
  assert.ok(/Ack>Success/.test(String(result)));
});

test('2F-OK-READ · read verb · normal success on first POST → 1 POST · 0 refresh', async () => {
  resetSpies();
  tradingPostBehavior = () => successResponse('GetOrders');
  const api = new EbayAPI();
  const result = await api.callTradingAPI('GetOrders', '<x/>');
  assert.equal(tradingCalls.length, 1);
  assert.equal(oauthCalls.length, 0);
  assert.ok(/Ack>Success/.test(String(result)));
});

test('2F-BIZ · non-token 4xx business failure → 1 POST · 0 refresh · existing wrapping preserved', async () => {
  resetSpies();
  tradingPostBehavior = () => nonTokenBusinessFailure();
  const api = new EbayAPI();
  let caught = null;
  try { await api.callTradingAPI('AddFixedPriceItem', '<x/>'); }
  catch (e) { caught = e; }
  assert.equal(tradingCalls.length, 1, 'business failure must NOT trigger auto-retry');
  assert.equal(oauthCalls.length, 0, 'business failure must NOT trigger refresh');
  //   Existing wrapper `eBay API Error: eBay API 400: ...` preserved (per spec §9C).
  assert.ok(caught, 'must throw');
  assert.notEqual(caught.code, 'EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN',
    'business failure is not mutation-uncertainty (marketplace explicitly rejected)');
});

test('2F-BIZ-READ · read verb non-token business failure → 1 POST · 0 refresh', async () => {
  resetSpies();
  //   400 without token-related content — pure business rejection.
  tradingPostBehavior = () => Promise.resolve({
    status: 400,
    data: '<Ack>Failure</Ack><Errors><ErrorCode>17</ErrorCode><ShortMessage>Invalid item</ShortMessage></Errors>',
  });
  const api = new EbayAPI();
  let caught = null;
  try { await api.callTradingAPI('GetOrders', '<x/>'); }
  catch (e) { caught = e; }
  assert.equal(tradingCalls.length, 1, '400 non-token must NOT retry even for reads');
  //   Note: current detector regex is broad — /token|auth|expired|unauthorized/i on 4xx.
  //   If ShortMessage doesn't include those, no retry. This test proves the detector
  //   is not accidentally too broad here.
  assert.equal(oauthCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// Structural / source assertion — supplements behavioral proofs above
// ═════════════════════════════════════════════════════════════════════

test('2F-STRUCT · EBAY_READ_ONLY_TRADING_VERBS declared at module top with expected verbs', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'src/api/ebayAPI.js'), 'utf8');
  const constMatch = src.match(/const\s+EBAY_READ_ONLY_TRADING_VERBS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\s*\)/);
  assert.ok(constMatch, 'EBAY_READ_ONLY_TRADING_VERBS Set must be declared');
  const body = constMatch[1];
  for (const v of ['GetUser','GetMyeBaySelling','GetSuggestedCategories','VerifyAddFixedPriceItem','GetOrders','GetSellerTransactions','GetMyMessages','GetItem','GetApiAccessRules']) {
    assert.ok(body.includes(`'${v}'`) || body.includes(`"${v}"`), `allow-list must include ${v}`);
  }
  //   MUTATING verbs must NOT be in the set.
  for (const v of ['AddFixedPriceItem','ReviseInventoryStatus','ReviseFixedPriceItem','AddMemberMessageRTQ','UploadSiteHostedPictures']) {
    assert.ok(!body.includes(`'${v}'`) && !body.includes(`"${v}"`), `allow-list must NOT include mutating verb ${v}`);
  }
});

test('2F-STRUCT · callTradingAPI checks allow-list BEFORE deciding to refresh', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'src/api/ebayAPI.js'), 'utf8');
  //   Find the isTokenInvalid branch. Ensure allow-list check happens before any
  //   refresh call (in source order).
  const branchStart = src.indexOf('if (isTokenInvalid');
  assert.ok(branchStart > 0);
  const branchBlock = src.slice(branchStart, branchStart + 3000);
  const allowIdx = branchBlock.indexOf('EBAY_READ_ONLY_TRADING_VERBS.has(callName)');
  const refreshIdx = branchBlock.indexOf('refreshAccessToken');
  assert.ok(allowIdx > 0, 'allow-list check must appear inside the token-invalid branch');
  assert.ok(refreshIdx > 0, 'refresh call must still exist for the read path');
  assert.ok(allowIdx < refreshIdx, 'allow-list check must happen BEFORE refresh (fail-closed)');
});

test('2F-STRUCT · outer catch preserves EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN (does not wrap it)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'src/api/ebayAPI.js'), 'utf8');
  //   The catch handler at the end of callTradingAPI must have an early rethrow
  //   for the mutation-uncertainty code.
  const catchIdx = src.indexOf('} catch (error) {', src.indexOf('async callTradingAPI'));
  assert.ok(catchIdx > 0);
  const catchBlock = src.slice(catchIdx, catchIdx + 600);
  assert.ok(/EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN[\s\S]*throw\s+error/.test(catchBlock),
    'outer catch must rethrow mutation-uncertainty error unchanged');
});

// ═════════════════════════════════════════════════════════════════════
// 2D integration · mutation uncertainty → outcome_class=unknown_may_have_created
// ═════════════════════════════════════════════════════════════════════

test('2D-INT · eBay createProduct mutation-uncertainty from callTradingAPI → outcome_class=unknown_may_have_created (retry-excluded)', async () => {
  //   Fresh module graph for the integration.
  const origCache = { ...require.cache };
  const upserts = [];
  class FakeRepo {
    async upsertExportStatus(productId, platformId, patch) { upserts.push({ productId, platformId, patch }); }
    async getMappingForProductPlatform() { return null; }
    async getFailedExports() { return []; }
  }
  stub(require.resolve(path.join(REPO, 'src/db/platformRepository')), FakeRepo);
  stub(require.resolve(path.join(REPO, 'src/db/supabaseClient')), {
    getClient: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: {
          id: 1, sku: 'SKU-A', title: 't', title_ko: 't',
          purchase_price: 10000, weight: 0.5, target_margin: 30, quantity: 1,
          image_urls: [], condition: 'new',
        }, error: null })})}),
      }),
    }),
  });
  //   Fake platformRegistry that hands back a fake eBay adapter whose createProduct
  //   throws exactly what the real EbayAPI would throw when callTradingAPI hits
  //   a mutation-uncertainty branch.
  stub(require.resolve(path.join(REPO, 'src/services/platformRegistry')), {
    getFeeRates:       async () => ({ ebay: 0.13 }),
    getExchangeRates:  async () => ({ USD_KRW: 1400 }),
    getMarginSettings: async () => ({ default_margin_pct: 30, default_shipping_usd: 3.9 }),
    getPlatform:       async () => ({ id: 'plat-ebay', key: 'ebay', name: 'eBay', active: true, config: {} }),
    getApiInstance:    () => ({
      async createProduct() {
        //   Simulate what EbayAPI.createProduct experiences after 2F throws:
        //   the callTradingAPI throw propagates unchanged out of createProduct's
        //   try (nothing catches inside createProduct — it just awaits).
        const err = new Error('EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN: AddFixedPriceItem');
        err.code = 'EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN';
        err.callName = 'AddFixedPriceItem';
        throw err;
      },
      async getToken() { return 'tok'; },
    }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/pricingEngine')), {
    calculatePrices: () => ({ ebay: { price: 19.99, currency: 'USD' } }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/platformOptimizer')), {
    optimize: (k, p) => ({ sku: p.sku, title: p.title, price: 19.99 }),
  });
  class FakeTx { async getTranslation() { return null; } async translateProduct() { return null; } }
  stub(require.resolve(path.join(REPO, 'src/services/translationService')), FakeTx);
  stub(require.resolve(path.join(REPO, 'src/services/schedulerLock')), {
    withLease: async (_k, _o, fn) => {
      const value = await fn({ runId: 'r', isLeaseLost: () => false, verifyOwnership: async () => true });
      return { acquired: true, ran: true, leaseLost: false, value };
    },
    OWNER_ID: 't', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  });
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));

  const e = new PE();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });

  //   Restore require.cache before assertions to avoid contaminating downstream tests.
  for (const k of Object.keys(require.cache)) {
    if (!origCache[k]) delete require.cache[k];
    else require.cache[k] = origCache[k];
  }

  //   ProductExporter's outer catch classifies the thrown mutation-uncertainty
  //   as UNKNOWN because marketplaceCallStarted=true (2D).
  const finalUpsert = upserts[upserts.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed');
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created',
    'mutation-uncertainty from eBay must classify as UNKNOWN — never confirmed_failure');
  assert.equal(r.results.ebay.success, false);
  //   last_error preserves the deterministic code (via err.message) for ops introspection.
  assert.ok(String(finalUpsert.patch.last_error).includes('EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN'),
    'last_error should preserve the deterministic code for ops introspection');
});

// ═════════════════════════════════════════════════════════════════════
// Normal eBay success → confirmed_success regression (2D integration)
// ═════════════════════════════════════════════════════════════════════

test('2D-INT · eBay createProduct normal success → outcome_class=confirmed_success (regression)', async () => {
  const origCache = { ...require.cache };
  const upserts = [];
  class FakeRepo {
    async upsertExportStatus(productId, platformId, patch) { upserts.push({ productId, platformId, patch }); }
    async getMappingForProductPlatform() { return null; }
    async getFailedExports() { return []; }
  }
  stub(require.resolve(path.join(REPO, 'src/db/platformRepository')), FakeRepo);
  stub(require.resolve(path.join(REPO, 'src/db/supabaseClient')), {
    getClient: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: {
          id: 1, sku: 'SKU-A', title: 't', title_ko: 't',
          purchase_price: 10000, weight: 0.5, target_margin: 30, quantity: 1,
          image_urls: [], condition: 'new',
        }, error: null })})}),
      }),
    }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/platformRegistry')), {
    getFeeRates:       async () => ({ ebay: 0.13 }),
    getExchangeRates:  async () => ({ USD_KRW: 1400 }),
    getMarginSettings: async () => ({ default_margin_pct: 30, default_shipping_usd: 3.9 }),
    getPlatform:       async () => ({ id: 'plat-ebay', key: 'ebay', name: 'eBay', active: true, config: {} }),
    getApiInstance:    () => ({
      async createProduct() { return { success: true, itemId: '123456789012' }; },
      async getToken() { return 'tok'; },
    }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/pricingEngine')), {
    calculatePrices: () => ({ ebay: { price: 19.99, currency: 'USD' } }),
  });
  stub(require.resolve(path.join(REPO, 'src/services/platformOptimizer')), {
    optimize: (k, p) => ({ sku: p.sku, title: p.title, price: 19.99 }),
  });
  class FakeTx { async getTranslation() { return null; } async translateProduct() { return null; } }
  stub(require.resolve(path.join(REPO, 'src/services/translationService')), FakeTx);
  stub(require.resolve(path.join(REPO, 'src/services/schedulerLock')), {
    withLease: async (_k, _o, fn) => {
      const value = await fn({ runId: 'r', isLeaseLost: () => false, verifyOwnership: async () => true });
      return { acquired: true, ran: true, leaseLost: false, value };
    },
    OWNER_ID: 't', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  });
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));

  const e = new PE();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });

  for (const k of Object.keys(require.cache)) {
    if (!origCache[k]) delete require.cache[k];
    else require.cache[k] = origCache[k];
  }

  const finalUpsert = upserts[upserts.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'success');
  assert.equal(finalUpsert.patch.outcome_class, 'confirmed_success');
  assert.equal(finalUpsert.patch.platform_item_id, '123456789012');
  assert.equal(r.results.ebay.success, true);
});
