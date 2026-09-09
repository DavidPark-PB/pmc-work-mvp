'use strict';

/**
 * tests/services/exportProductConcurrency.test.js — PMC-EXPORT-SAFETY-2C (2026-09-09).
 *
 * Proves per-(SKU, platform) distributed lease around the marketplace write
 * path in ProductExporter. All external collaborators (schedulerLock,
 * adapters, DB, translation) are mocked via require.cache substitution
 * BEFORE ProductExporter is loaded.
 *
 * Explicit non-goal: full idempotency. CONC-12 documents that sequential
 * calls after lease release can still duplicate — that lives in 2D.
 *
 * ZERO real marketplace calls · ZERO real DB writes · ZERO scheduler_leases
 * touches — the entire schedulerLock module is replaced with an in-memory
 * behavioral simulator.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '../..');

// ═════════════════════════════════════════════════════════════════════
// Mock harness · install BEFORE require('src/services/productExporter')
// ═════════════════════════════════════════════════════════════════════

const upsertCalls    = [];   // populated when execute reaches platRepo.upsertExportStatus
const createCalls    = [];   // populated when execute reaches api.createProduct
const leaseCalls     = [];   // populated on every schedulerLock.withLease invocation
let   leaseOverride  = null; // per-test knob (see below)
const leaseState     = new Map(); // key -> holderId while held
let   holderCounter  = 0;

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = {
    id: fullPath, filename: fullPath, loaded: true,
    exports: exportsObj, children: [], paths: [],
  };
}
function resetSpies() {
  upsertCalls.length = 0;
  createCalls.length = 0;
  leaseCalls.length  = 0;
  leaseState.clear();
  holderCounter = 0;
  leaseOverride = null;
}

//   Fake supabase client — products table read only.
function fakeClient() {
  return {
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; },
        eq(col, val) { chain._eqCol = col; chain._eqVal = val; return chain; },
        single() {
          if (table === 'products' && chain._eqCol === 'sku') {
            const sku = chain._eqVal;
            if (sku === 'SKU-A' || sku === 'SKU-B' || sku === 'SKU-KNOWN') {
              return Promise.resolve({ data: {
                id: sku === 'SKU-A' ? 1 : sku === 'SKU-B' ? 2 : 42,
                sku,
                title: `Test ${sku}`, title_ko: `테스트 ${sku}`,
                purchase_price: 10000, weight: 0.5, target_margin: 30,
                quantity: 3, condition: 'new',
                image_urls: ['http://x/img.png'],
              }, error: null });
            }
            return Promise.resolve({ data: null, error: { message: 'not found' } });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}
stub(require.resolve(path.join(REPO, 'src/db/supabaseClient')), { getClient: fakeClient });

//   Fake platformRepository (spy on upsertExportStatus).
class FakePlatformRepository {
  async upsertExportStatus(productId, platformId, patch) {
    upsertCalls.push({ productId, platformId, patch });
    return { ok: true };
  }
  async getMappingForProductPlatform(_pid, _plid) { return null; }
  async getFailedExports(_limit) {
    //   For CONC-11 retry test: return one fixed failed row for SKU-KNOWN/ebay.
    return [
      { product_id: 42, platform_id: 'plat-ebay', retry_count: 0,
        products: { sku: 'SKU-KNOWN' }, platforms: { key: 'ebay' } },
    ];
  }
  async getAllExportStatuses(_pid) { return []; }
}
stub(require.resolve(path.join(REPO, 'src/db/platformRepository')), FakePlatformRepository);

//   Fake platformRegistry.
stub(require.resolve(path.join(REPO, 'src/services/platformRegistry')), {
  getFeeRates:       async () => ({ ebay: 0.13, shopify: 0.02, naver: 0.05 }),
  getExchangeRates:  async () => ({ USD_KRW: 1400 }),
  getMarginSettings: async () => ({ default_margin_pct: 30, default_shipping_usd: 3.9 }),
  getPlatform:       async (key) => (
    key === 'ebay' ? { id: 'plat-ebay',    key: 'ebay',    name: 'eBay',    active: true, config: {} }
    : key === 'shopify' ? { id: 'plat-shopify', key: 'shopify', name: 'Shopify', active: true, config: {} }
    : null
  ),
  getApiInstance: (key) => ({
    async createProduct(payload) {
      //   Optional delay to let concurrent tests deterministically show
      //   that fn is in-flight when the second caller checks lease state.
      await new Promise(r => setTimeout(r, 10));
      createCalls.push({ key, payload });
      //   PMC-EXPORT-SAFETY-2D · strict success contract requires BOTH
      //   `.success === true` AND a durable ID. Mock returns both.
      return { success: true, itemId: `mock-${key}-${createCalls.length}` };
    },
    async getToken() { return 'tok'; },
  }),
});

//   Fake pricingEngine.
stub(require.resolve(path.join(REPO, 'src/services/pricingEngine')), {
  calculatePrices: (_inputs, _fees, _rates) => ({
    ebay:    { price: 19.99, currency: 'USD' },
    shopify: { price: 21.50, currency: 'USD' },
  }),
});

//   Fake platformOptimizer.
stub(require.resolve(path.join(REPO, 'src/services/platformOptimizer')), {
  optimize: (key, product, prices, _ctx) => ({
    sku: product.sku, title: product.titleEn || product.title, price: prices[key]?.price,
  }),
});

//   Fake translationService.
class FakeTranslationService {
  async getTranslation(_pid, _lang) { return null; }
  async translateProduct(_pid, _lang) { return { title: 'x', description: 'y', keywords: [] }; }
}
stub(require.resolve(path.join(REPO, 'src/services/translationService')), FakeTranslationService);

//   Fake schedulerLock — the star of the show. In-memory simulator with
//   knobs for concurrency, verifyOwnership failure, acquire error.
stub(require.resolve(path.join(REPO, 'src/services/schedulerLock')), {
  withLease: async (lockKey, opts, fn) => {
    leaseCalls.push({ lockKey, opts });

    //   Per-test knob: acquire returns a synthetic RPC error.
    if (leaseOverride?.acquireErrorKeys?.has(lockKey)) {
      return {
        acquired: false, ran: false, leaseLost: false,
        error: new Error(leaseOverride.acquireErrorMsg || 'simulated acquire error'),
      };
    }

    //   Serialize on lockKey: if another run holds it right now, SKIP_LOCKED.
    if (leaseState.has(lockKey)) {
      return { acquired: false, ran: false, leaseLost: false };
    }

    const myHolderId = ++holderCounter;
    leaseState.set(lockKey, myHolderId);
    try {
      const ctx = {
        runId: `run-${myHolderId}`,
        isLeaseLost: () => false,
        verifyOwnership: async () => {
          if (leaseOverride?.verifyFailsKeys?.has(lockKey)) {
            if (leaseOverride?.verifyThrows) throw new Error('simulated verifyOwnership RPC failure');
            return false;
          }
          return true;
        },
      };
      const value = await fn(ctx);
      return { acquired: true, ran: true, leaseLost: false, value };
    } finally {
      //   Release only if we still hold it (paranoid, since only setter can be us).
      if (leaseState.get(lockKey) === myHolderId) leaseState.delete(lockKey);
    }
  },
  //   Constants read by consumers · not used by ProductExporter but export
  //   for defensive completeness so require('schedulerLock').DEFAULT_TTL_SECONDS
  //   in unrelated code doesn't blow up.
  OWNER_ID: 'test-owner',
  MAX_TTL_SECONDS: 86400,
  DEFAULT_TTL_SECONDS: 600,
  DEFAULT_HEARTBEAT_SEC: 60,
});

//   Load ProductExporter — its require() calls resolve to the stubs above.
delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
const ProductExporter = require(path.join(REPO, 'src/services/productExporter'));

// ═════════════════════════════════════════════════════════════════════
// CONC-1..CONC-3 · Same SKU + same platform, concurrent
// ═════════════════════════════════════════════════════════════════════

test('CONC-1 · two simultaneous write-mode calls (same SKU + same platform) → createProduct total = 1', async () => {
  resetSpies();
  const e = new ProductExporter();
  const [rA, rB] = await Promise.all([
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
  ]);
  assert.equal(createCalls.length, 1,
    'exactly ONE marketplace createProduct call must escape the lease');
  //   Exactly one caller succeeded; the other returned CONCURRENT_EXPORT_IN_PROGRESS.
  const winner = rA.results.ebay.success ? rA : rB;
  const loser  = rA.results.ebay.success ? rB : rA;
  assert.ok(winner.results.ebay.success, 'winner must have success:true');
  assert.equal(loser.results.ebay.success, false, 'loser must have success:false');
});

test('CONC-2 · loser returns code:CONCURRENT_EXPORT_IN_PROGRESS', async () => {
  resetSpies();
  const e = new ProductExporter();
  const [rA, rB] = await Promise.all([
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
  ]);
  const loser = rA.results.ebay.success ? rB : rA;
  assert.equal(loser.results.ebay.code,  'CONCURRENT_EXPORT_IN_PROGRESS');
  assert.equal(loser.results.ebay.error, 'CONCURRENT_EXPORT_IN_PROGRESS');
});

test('CONC-3 · loser causes 0 platform_export_status writes', async () => {
  resetSpies();
  const e = new ProductExporter();
  await Promise.all([
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
  ]);
  //   Only the winner writes to platform_export_status. The winner writes
  //   twice (exporting → success). If the loser had written anything, count
  //   would be ≥ 3. Prove exactly 2.
  assert.equal(upsertCalls.length, 2,
    'exactly 2 upserts by winner (exporting + success). Loser must write nothing.');
  assert.equal(upsertCalls[0].patch.export_status, 'exporting');
  assert.equal(upsertCalls[1].patch.export_status, 'success');
});

// ═════════════════════════════════════════════════════════════════════
// CONC-4 / CONC-5 · Independent lease keys
// ═════════════════════════════════════════════════════════════════════

test('CONC-4 · same SKU + DIFFERENT platforms → independent lease keys → both execute', async () => {
  resetSpies();
  const e = new ProductExporter();
  //   Two concurrent exportProduct calls, each with a single but different platform.
  const [rA, rB] = await Promise.all([
    e.exportProduct('SKU-KNOWN', ['ebay'],    { dryRun: false }),
    e.exportProduct('SKU-KNOWN', ['shopify'], { dryRun: false }),
  ]);
  assert.equal(createCalls.length, 2, 'both platforms must reach createProduct');
  assert.ok(rA.results.ebay.success);
  assert.ok(rB.results.shopify.success);
  //   Lease keys must be distinct.
  const keys = leaseCalls.map(c => c.lockKey);
  assert.equal(new Set(keys).size, 2, 'two distinct lease keys');
  assert.deepEqual(keys.slice().sort(), ['export:ebay:SKU-KNOWN', 'export:shopify:SKU-KNOWN']);
});

test('CONC-5 · different SKUs + same platform → independent lease keys → both execute', async () => {
  resetSpies();
  const e = new ProductExporter();
  const [rA, rB] = await Promise.all([
    e.exportProduct('SKU-A', ['ebay'], { dryRun: false }),
    e.exportProduct('SKU-B', ['ebay'], { dryRun: false }),
  ]);
  assert.equal(createCalls.length, 2, 'different SKUs must not block each other');
  assert.ok(rA.results.ebay.success);
  assert.ok(rB.results.ebay.success);
  const keys = leaseCalls.map(c => c.lockKey);
  assert.deepEqual(keys.slice().sort(), ['export:ebay:SKU-A', 'export:ebay:SKU-B']);
});

// ═════════════════════════════════════════════════════════════════════
// CONC-6 / CONC-7 · Dry-run regression (no lease, no createProduct)
// ═════════════════════════════════════════════════════════════════════

test('CONC-6 · dry-run → 0 lease acquisitions', async () => {
  resetSpies();
  const e = new ProductExporter();
  await e.exportProduct('SKU-KNOWN', ['ebay', 'shopify']); // no options → dry-run
  assert.equal(leaseCalls.length, 0,
    'dry-run must NOT acquire any lease (preview path never enters _exportToSinglePlatform)');
});

test('CONC-7 · dry-run → 0 createProduct calls', async () => {
  resetSpies();
  const e = new ProductExporter();
  await e.exportProduct('SKU-KNOWN', ['ebay', 'shopify']);
  assert.equal(createCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// CONC-8 / CONC-9 · Ownership fence
// ═════════════════════════════════════════════════════════════════════

test('CONC-8 · verifyOwnership false immediately before marketplace write → 0 createProduct', async () => {
  resetSpies();
  leaseOverride = { verifyFailsKeys: new Set(['export:ebay:SKU-KNOWN']) };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 0, 'verifyOwnership=false must block createProduct');
  assert.equal(r.results.ebay.success, false);
});

test('CONC-9 · ownership-loss outcome = LEASE_LOST_BEFORE_MARKETPLACE_WRITE (NOT marketplace failure)', async () => {
  resetSpies();
  leaseOverride = { verifyFailsKeys: new Set(['export:ebay:SKU-KNOWN']) };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  const ebayRes = r.results.ebay;
  assert.equal(ebayRes.code,  'LEASE_LOST_BEFORE_MARKETPLACE_WRITE');
  assert.equal(ebayRes.error, 'LEASE_LOST_BEFORE_MARKETPLACE_WRITE');
  //   Post-condition: platform_export_status was reverted from 'exporting'
  //   back to 'pending' with a distinct last_error tag — NOT 'failed'.
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'pending',
    'ownership loss must revert to pending, not classify as marketplace failure');
  assert.equal(finalUpsert.patch.last_error, 'LEASE_LOST_BEFORE_MARKETPLACE_WRITE');
  //   Also: any prior upsert should be the transitional 'exporting'; no
  //   'failed' status was ever written for this outcome.
  const statuses = upsertCalls.map(u => u.patch.export_status);
  assert.ok(!statuses.includes('failed'),
    'must NOT write status=failed for lease-lost outcome');
});

test('CONC-9b · verifyOwnership THROWING (RPC infra failure) is treated as ownership-lost', async () => {
  resetSpies();
  leaseOverride = {
    verifyFailsKeys: new Set(['export:ebay:SKU-KNOWN']),
    verifyThrows: true,
  };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 0);
  assert.equal(r.results.ebay.code, 'LEASE_LOST_BEFORE_MARKETPLACE_WRITE');
});

// ═════════════════════════════════════════════════════════════════════
// CONC-10 · Lease acquisition error (fail-closed)
// ═════════════════════════════════════════════════════════════════════

test('CONC-10 · lease acquire error (failPolicy:closed) → 0 createProduct + LEASE_INFRA_FAILURE', async () => {
  resetSpies();
  leaseOverride = {
    acquireErrorKeys: new Set(['export:ebay:SKU-KNOWN']),
    acquireErrorMsg:  'simulated RPC down',
  };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 0, 'lease infra failure must NOT proceed to marketplace');
  assert.equal(upsertCalls.length, 0, 'lease infra failure must NOT touch platform_export_status');
  assert.equal(r.results.ebay.code,  'LEASE_INFRA_FAILURE');
  assert.equal(r.results.ebay.error, 'LEASE_INFRA_FAILURE');
});

// ═════════════════════════════════════════════════════════════════════
// CONC-11 · Direct execute vs retry (same SKU/platform, concurrent)
// ═════════════════════════════════════════════════════════════════════

test('CONC-11 · concurrent direct execute + retry for same SKU/platform → createProduct total = 1', async () => {
  resetSpies();
  const e = new ProductExporter();
  //   FakePlatformRepository.getFailedExports returns one failed row for
  //   (SKU-KNOWN, ebay). Retry calls exportProduct(...,{dryRun:false}),
  //   which enters the same lease key as the direct call.
  const [rDirect, rRetry] = await Promise.all([
    e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false }),
    e.retryFailedExports(),
  ]);
  assert.equal(createCalls.length, 1,
    'direct execute + retry for the same SKU/platform must serialize into 1 createProduct');
  const rRetrySucceeded = Array.isArray(rRetry) && rRetry[0] && rRetry[0].success === true;
  const rDirectSucceeded = rDirect.results.ebay.success === true;
  assert.equal((rDirectSucceeded ? 1 : 0) + (rRetrySucceeded ? 1 : 0), 1,
    'exactly one of direct / retry must succeed; the other must lose the lease race');
});

// ═════════════════════════════════════════════════════════════════════
// CONC-12 · Sequential calls · REQUIRED · documents 2C limitation
// ═════════════════════════════════════════════════════════════════════

test('CONC-12 · sequential calls after lease release → BOTH can reach createProduct (2C is concurrency-only, not idempotency)', async () => {
  resetSpies();
  const e = new ProductExporter();
  await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  //   Second call starts after the first completes and the lease is released.
  await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 2,
    'SEQUENTIAL DUPLICATE STILL POSSIBLE. 2C is CONCURRENCY-only. Idempotency (UNKNOWN state + retry exclusion) is deferred to EXPORT-SAFETY-2D.');
});

// ═════════════════════════════════════════════════════════════════════
// CONC-13 · Existing execute path still works when lease acquired
// ═════════════════════════════════════════════════════════════════════

test('CONC-13 · execute:true with no contention reaches mocked createProduct + records success', async () => {
  resetSpies();
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 1);
  assert.equal(r.results.ebay.success, true);
  assert.ok(String(r.results.ebay.itemId).startsWith('mock-ebay-'));
  //   Persistence trail: 'exporting' → 'success'
  assert.equal(upsertCalls.length, 2);
  assert.equal(upsertCalls[0].patch.export_status, 'exporting');
  assert.equal(upsertCalls[1].patch.export_status, 'success');
  //   Lease was acquired for the expected key.
  assert.equal(leaseCalls.length, 1);
  assert.equal(leaseCalls[0].lockKey, 'export:ebay:SKU-KNOWN');
  //   TTL contract: exporter passes conservative TTL (> Shopify worst-case 135s)
  //   and heartbeat < TTL.
  assert.ok(leaseCalls[0].opts.ttlSec >= 150, `ttlSec ≥ 150 (got ${leaseCalls[0].opts.ttlSec})`);
  assert.ok(leaseCalls[0].opts.heartbeatSec < leaseCalls[0].opts.ttlSec,
    'heartbeatSec must be < ttlSec');
  assert.equal(leaseCalls[0].opts.failPolicy, 'closed',
    'fail-closed on lease infra failure');
});

// ═════════════════════════════════════════════════════════════════════
// CONC-14 · 2B default dry-run regression
// ═════════════════════════════════════════════════════════════════════

test('CONC-14 · exportProduct(sku, platforms) with NO options → dry-run · lease/DB/adapter untouched', async () => {
  resetSpies();
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay']);
  assert.equal(r.dryRun, true, '2B: no-options → dry-run');
  assert.equal(leaseCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

test('CONC-14b · exportProduct(sku, platforms, {}) → dry-run · no lease', async () => {
  resetSpies();
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-KNOWN', ['ebay'], {});
  assert.equal(r.dryRun, true);
  assert.equal(leaseCalls.length, 0);
});

test('CONC-14c · exportProduct(sku, platforms, { dryRun: true }) → dry-run · no lease', async () => {
  resetSpies();
  const e = new ProductExporter();
  await e.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: true });
  assert.equal(leaseCalls.length, 0);
});
