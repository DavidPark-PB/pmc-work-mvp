'use strict';

/**
 * tests/services/exportProductOutcome.test.js — PMC-EXPORT-SAFETY-2D (2026-09-09).
 *
 * Proves the outcome-truth model at ProductExporter boundary:
 *   · CONFIRMED_SUCCESS requires positive `.success === true` AND durable ID
 *   · Returned `{success:false}` → UNKNOWN_MAY_HAVE_CREATED (never success)
 *   · Success with null / undefined / empty durable ID → UNKNOWN
 *   · Adapter with no normalized durable ID (Qoo10 raw JSON) → UNKNOWN
 *   · Thrown pre-createProduct → CONFIRMED_FAILURE
 *   · Thrown post-createProduct → UNKNOWN_MAY_HAVE_CREATED
 *   · getFailedExports filters strict CONFIRMED_FAILURE only
 *   · UNKNOWN rows and NULL-outcome historical rows excluded from retry
 *   · Migration has no UPDATE / no backfill
 *   · 2B dry-run + 2C concurrency invariants preserved
 *
 * All external collaborators (schedulerLock, adapters, DB) are mocked via
 * require.cache substitution BEFORE ProductExporter is loaded.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO           = path.resolve(__dirname, '../..');
const EXPORTER_JS    = path.join(REPO, 'src/services/productExporter.js');
const REPO_JS        = path.join(REPO, 'src/db/platformRepository.js');
const MIGRATION_FILE = path.join(REPO, 'supabase/migrations/111_platform_export_status_outcome_class.sql');

// ═════════════════════════════════════════════════════════════════════
// Mock harness · install BEFORE require('src/services/productExporter')
// ═════════════════════════════════════════════════════════════════════

const upsertCalls = [];   // every upsertExportStatus invocation
const createCalls = [];   // every api.createProduct invocation
let   apiOverride = null; // per-test: (key, payload) => next return / throw
let   pricesOverride = null; // per-test override for pricingEngine

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = {
    id: fullPath, filename: fullPath, loaded: true,
    exports: exportsObj, children: [], paths: [],
  };
}
function resetSpies() {
  upsertCalls.length = 0;
  createCalls.length = 0;
  apiOverride = null;
  pricesOverride = null;
  fakePlatRepo.rows.clear();
}

//   Fake supabase client — products table read only.
function fakeClient() {
  return {
    from(table) {
      const chain = {
        _t: table,
        select() { return chain; },
        eq(col, val) { chain._eqCol = col; chain._eqVal = val; return chain; },
        single() {
          if (table === 'products' && chain._eqCol === 'sku') {
            const sku = chain._eqVal;
            if (typeof sku === 'string' && sku.startsWith('SKU-')) {
              return Promise.resolve({ data: {
                id: sku, sku,
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

//   In-memory FakePlatformRepository that behaves like the real one plus
//   the 2D outcome_class filter — supports both writes and retry queries.
const fakePlatRepo = {
  rows: new Map(), // key: `${product_id}|${platform_id}` → row
};

class FakePlatformRepository {
  async upsertExportStatus(productId, platformId, patch) {
    upsertCalls.push({ productId, platformId, patch });
    const key = `${productId}|${platformId}`;
    const prev = fakePlatRepo.rows.get(key) || {
      product_id: productId, platform_id: platformId,
      retry_count: 0, export_status: 'pending',
      outcome_class: null, platform_item_id: '',
      products: { sku: productId, title: `Test ${productId}` },
      platforms: { key: platformId, name: platformId },
    };
    //   Preserve NULL as valid state — do not overwrite with undefined.
    const next = { ...prev };
    for (const k of Object.keys(patch)) next[k] = patch[k];
    fakePlatRepo.rows.set(key, next);
    return next;
  }
  async getMappingForProductPlatform(_pid, _plid) { return null; }
  async getFailedExports(maxRetries = 3) {
    //   MUST implement the real 2D filter for these tests to be meaningful.
    return [...fakePlatRepo.rows.values()].filter(r =>
      r.export_status === 'failed'
      && r.outcome_class === 'confirmed_failure'
      && (r.retry_count ?? 0) < maxRetries
    );
  }
  async getUnknownExports(limit = 100) {
    return [...fakePlatRepo.rows.values()]
      .filter(r => r.outcome_class === 'unknown_may_have_created')
      .slice(0, limit);
  }
  async getAllExportStatuses(_pid) { return []; }
}
stub(require.resolve(path.join(REPO, 'src/db/platformRepository')), FakePlatformRepository);

//   Fake platformRegistry with a per-key adapter that consults apiOverride.
stub(require.resolve(path.join(REPO, 'src/services/platformRegistry')), {
  getFeeRates:       async () => ({ ebay: 0.13, shopify: 0.02, naver: 0.05, qoo10: 0.10 }),
  getExchangeRates:  async () => ({ USD_KRW: 1400 }),
  getMarginSettings: async () => ({ default_margin_pct: 30, default_shipping_usd: 3.9 }),
  getPlatform: async (key) => (
    ['ebay','shopify','naver','qoo10'].includes(key)
      ? { id: `plat-${key}`, key, name: key, active: true, config: {} }
      : null
  ),
  getApiInstance: (key) => ({
    async createProduct(payload) {
      createCalls.push({ key, payload });
      //   apiOverride shape: { [key]: fn(payload) → result | throws }
      if (apiOverride && typeof apiOverride[key] === 'function') {
        return apiOverride[key](payload);
      }
      //   Default: eBay-style CONFIRMED_SUCCESS (used by regression tests).
      return { success: true, itemId: `mock-${key}-${createCalls.length}` };
    },
    async getToken() {
      if (apiOverride && typeof apiOverride.__getToken === 'function') {
        return apiOverride.__getToken();
      }
      return 'tok';
    },
  }),
});

//   Fake pricingEngine — configurable per test.
stub(require.resolve(path.join(REPO, 'src/services/pricingEngine')), {
  calculatePrices: (_inputs, _fees, _rates) => (pricesOverride ?? {
    ebay:    { price: 19.99, currency: 'USD' },
    shopify: { price: 21.50, currency: 'USD' },
    naver:   { price: 25000,  currency: 'KRW' },
    qoo10:   { price: 24000,  currency: 'KRW' },
  }),
});

//   Fake platformOptimizer — per-test override via apiOverride.__optimize.
stub(require.resolve(path.join(REPO, 'src/services/platformOptimizer')), {
  optimize: (key, product, prices, _ctx) => {
    if (apiOverride && typeof apiOverride.__optimize === 'function') {
      return apiOverride.__optimize(key, product);
    }
    return { sku: product.sku, title: product.titleEn || product.title, price: prices[key]?.price };
  },
});

//   Fake translationService.
class FakeTranslationService {
  async getTranslation(_pid, _lang) { return null; }
  async translateProduct(_pid, _lang) { return { title: 'x', description: 'y', keywords: [] }; }
}
stub(require.resolve(path.join(REPO, 'src/services/translationService')), FakeTranslationService);

//   Fake schedulerLock — always-succeeds pass-through for OUT tests.
//   Ownership always true (2D concerns outcome truth, not lease behavior;
//   2C's own suite covers lease semantics).
stub(require.resolve(path.join(REPO, 'src/services/schedulerLock')), {
  withLease: async (_key, _opts, fn) => {
    const value = await fn({
      runId: 'test-run',
      isLeaseLost: () => false,
      verifyOwnership: async () => true,
    });
    return { acquired: true, ran: true, leaseLost: false, value };
  },
  OWNER_ID: 'test', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
});

//   Load ProductExporter fresh.
delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
const ProductExporter = require(path.join(REPO, 'src/services/productExporter'));

function readSrc(p) { return fs.readFileSync(p, 'utf8'); }

// ═════════════════════════════════════════════════════════════════════
// OUT-1 · pre-marketplace failure → confirmed_failure
// ═════════════════════════════════════════════════════════════════════

test('OUT-1 · pre-createProduct throw (optimizer null) → outcome_class=confirmed_failure', async () => {
  resetSpies();
  apiOverride = { __optimize: () => null }; // optimizer returns null → throws BEFORE createProduct
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 0, 'createProduct must not be reached');
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed');
  assert.equal(finalUpsert.patch.outcome_class, 'confirmed_failure');
  assert.equal(r.results.ebay.success, false);
});

test('OUT-1b · pre-createProduct throw (getToken fails for naver) → confirmed_failure', async () => {
  resetSpies();
  apiOverride = { __getToken: async () => { throw new Error('token acquisition failed'); } };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['naver'], { dryRun: false });
  assert.equal(createCalls.length, 0, 'createProduct must not be reached if getToken throws');
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed');
  assert.equal(finalUpsert.patch.outcome_class, 'confirmed_failure');
});

// ═════════════════════════════════════════════════════════════════════
// OUT-2 · post-createProduct thrown error → unknown_may_have_created
// ═════════════════════════════════════════════════════════════════════

test('OUT-2 · adapter throws after createProduct entered → outcome_class=unknown_may_have_created', async () => {
  resetSpies();
  apiOverride = { ebay: () => { throw new Error('ETIMEDOUT — request may have hit marketplace'); } };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  assert.equal(createCalls.length, 1, 'createProduct was entered (we track that)');
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed');
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created',
    'thrown error after createProduct started must never be classified as confirmed_failure');
  assert.equal(r.results.ebay.success, false);
});

// ═════════════════════════════════════════════════════════════════════
// OUT-3 · returned {success:false} → UNKNOWN (never success)
// ═════════════════════════════════════════════════════════════════════

test('OUT-3 · adapter returns {success:false, error} → outcome_class=unknown_may_have_created', async () => {
  resetSpies();
  apiOverride = { shopify: () => ({ success: false, error: 'HTTP 500 upstream' }) };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-A', ['shopify'], { dryRun: false });
  assert.equal(createCalls.length, 1);
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed',
    'returned success:false must NEVER be persisted as success');
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created',
    'no HTTP status / send-phase evidence available → fail-closed to UNKNOWN');
  //   platform_item_id was never set on the failed row (real repo default = '')
  assert.equal(finalUpsert.patch.platform_item_id, undefined,
    'must not write platform_item_id on UNKNOWN row (leave repo default empty)');
  assert.equal(r.results.shopify.code, 'MARKETPLACE_RESULT_UNCONFIRMED');
});

// ═════════════════════════════════════════════════════════════════════
// OUT-4 · success:true but null durable ID → UNKNOWN
// ═════════════════════════════════════════════════════════════════════

test('OUT-4 · adapter returns {success:true, itemId:null} → UNKNOWN · platform_item_id NOT "null"', async () => {
  resetSpies();
  apiOverride = { ebay: () => ({ success: true, itemId: null }) };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status, 'failed',
    'success:true with null durable ID must not be classified as success');
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created');
  //   Critical: MUST NOT write literal string "null" as platform_item_id.
  assert.notEqual(finalUpsert.patch.platform_item_id, 'null');
  assert.notEqual(finalUpsert.patch.platform_item_id, 'undefined');
  assert.equal(finalUpsert.patch.platform_item_id, undefined,
    'platform_item_id must be omitted from the patch (repo default preserved)');
});

test('OUT-4b · success:true with empty-string durable ID → UNKNOWN', async () => {
  resetSpies();
  apiOverride = { shopify: () => ({ success: true, productId: '' }) };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['shopify'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created',
    'empty durable ID is not a durable ID');
});

// ═════════════════════════════════════════════════════════════════════
// OUT-5..OUT-7 · Confirmed success per adapter
// ═════════════════════════════════════════════════════════════════════

test('OUT-5 · eBay success:true + valid itemId → confirmed_success', async () => {
  resetSpies();
  apiOverride = { ebay: () => ({ success: true, itemId: '285712345678' }) };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status,    'success');
  assert.equal(finalUpsert.patch.outcome_class,    'confirmed_success');
  assert.equal(finalUpsert.patch.platform_item_id, '285712345678');
  assert.equal(r.results.ebay.success, true);
  assert.equal(r.results.ebay.itemId,  '285712345678');
});

test('OUT-6 · Shopify success:true + valid productId → confirmed_success', async () => {
  resetSpies();
  apiOverride = { shopify: () => ({ success: true, productId: 'gid://shopify/Product/1', variantId: 'v-1' }) };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['shopify'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.export_status,    'success');
  assert.equal(finalUpsert.patch.outcome_class,    'confirmed_success');
  assert.equal(finalUpsert.patch.platform_item_id, 'gid://shopify/Product/1');
});

test('OUT-7 · Naver success:true + valid originProductNo → confirmed_success', async () => {
  resetSpies();
  apiOverride = { naver: () => ({ success: true, originProductNo: '9876543210' }) };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['naver'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.outcome_class,    'confirmed_success');
  assert.equal(finalUpsert.patch.platform_item_id, '9876543210');
});

// ═════════════════════════════════════════════════════════════════════
// OUT-8 · Qoo10 raw response → UNKNOWN
// ═════════════════════════════════════════════════════════════════════

test('OUT-8 · Qoo10 raw response (no .success + no normalized durable ID) → UNKNOWN', async () => {
  resetSpies();
  //   Simulate current Qoo10 adapter behavior: returns raw QSM JSON with
  //   ResultCode in the body, no `.success`, no normalized `.itemId`/etc.
  apiOverride = { qoo10: () => ({ ResultCode: 0, ResultMsg: 'Success', ReturnedItemCode: 'Q123' }) };
  const e = new ProductExporter();
  const r = await e.exportProduct('SKU-A', ['qoo10'], { dryRun: false });
  assert.equal(createCalls.length, 1);
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.outcome_class, 'unknown_may_have_created',
    'Qoo10 has no proven success signal → must NOT become confirmed_success');
  assert.equal(r.results.qoo10.success, false);
});

// ═════════════════════════════════════════════════════════════════════
// OUT-9..OUT-11 · getFailedExports filter behavior
// ═════════════════════════════════════════════════════════════════════

test('OUT-9 · getFailedExports selects rows with outcome_class=confirmed_failure', async () => {
  resetSpies();
  const repo = new FakePlatformRepository();
  await repo.upsertExportStatus('P1', 'plat-ebay', {
    export_status: 'failed', outcome_class: 'confirmed_failure', retry_count: 0,
  });
  const rows = await repo.getFailedExports(3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome_class, 'confirmed_failure');
});

test('OUT-10 · getFailedExports EXCLUDES outcome_class=unknown_may_have_created', async () => {
  resetSpies();
  const repo = new FakePlatformRepository();
  await repo.upsertExportStatus('P1', 'plat-ebay', {
    export_status: 'failed', outcome_class: 'unknown_may_have_created', retry_count: 0,
  });
  const rows = await repo.getFailedExports(3);
  assert.equal(rows.length, 0,
    'UNKNOWN rows must never be auto-retried');
});

test('OUT-11 · getFailedExports EXCLUDES NULL outcome_class (historical pre-2D rows)', async () => {
  resetSpies();
  const repo = new FakePlatformRepository();
  await repo.upsertExportStatus('P1', 'plat-ebay', {
    export_status: 'failed', outcome_class: null, retry_count: 0,
  });
  const rows = await repo.getFailedExports(3);
  assert.equal(rows.length, 0,
    'historical NULL rows have no evidence — must never be auto-retried');
});

test('OUT-11b · getFailedExports also excludes stale exporting + success rows', async () => {
  resetSpies();
  const repo = new FakePlatformRepository();
  await repo.upsertExportStatus('P1', 'plat-ebay', { export_status: 'exporting', outcome_class: 'confirmed_failure' });
  await repo.upsertExportStatus('P2', 'plat-ebay', { export_status: 'success',   outcome_class: 'confirmed_success' });
  const rows = await repo.getFailedExports(3);
  assert.equal(rows.length, 0);
});

test('OUT-11c · getFailedExports enforces retry_count cap', async () => {
  resetSpies();
  const repo = new FakePlatformRepository();
  await repo.upsertExportStatus('P1', 'plat-ebay', {
    export_status: 'failed', outcome_class: 'confirmed_failure', retry_count: 3,
  });
  const rows = await repo.getFailedExports(3);
  assert.equal(rows.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// OUT-12..OUT-14 · retryFailedExports end-to-end
// ═════════════════════════════════════════════════════════════════════

test('OUT-12 · retryFailedExports · UNKNOWN rows cause 0 createProduct calls', async () => {
  resetSpies();
  const e = new ProductExporter();
  //   Seed the fake DB with an UNKNOWN row.
  await new FakePlatformRepository().upsertExportStatus('SKU-A', 'plat-ebay', {
    export_status: 'failed', outcome_class: 'unknown_may_have_created', retry_count: 0,
  });
  const results = await e.retryFailedExports();
  assert.equal(createCalls.length, 0,
    'UNKNOWN rows MUST NOT trigger marketplace retries');
  assert.deepEqual(results, [], 'retry loop finds 0 eligible rows');
});

test('OUT-13 · retryFailedExports · historical NULL rows cause 0 createProduct calls', async () => {
  resetSpies();
  const e = new ProductExporter();
  await new FakePlatformRepository().upsertExportStatus('SKU-A', 'plat-ebay', {
    export_status: 'failed', outcome_class: null, retry_count: 0,
  });
  const results = await e.retryFailedExports();
  assert.equal(createCalls.length, 0,
    'historical rows without evidence MUST NOT be auto-retried');
  assert.deepEqual(results, []);
});

test('OUT-14 · retryFailedExports · fresh confirmed_failure row is retry-eligible', async () => {
  resetSpies();
  const e = new ProductExporter();
  //   Seed a CF row for (SKU-A, plat-ebay) — key '{sku}|{platform_id}' in fake DB.
  //   Note fake repo derives platform_id from the getFailedExports platforms.key
  //   → 'ebay'. Configure that mapping.
  await new FakePlatformRepository().upsertExportStatus('SKU-A', 'plat-ebay', {
    export_status: 'failed', outcome_class: 'confirmed_failure', retry_count: 0,
    platforms: { key: 'ebay', name: 'eBay' },
    products:  { sku: 'SKU-A', title: 'Test SKU-A' },
  });
  //   Confirmed success on retry → createProduct called exactly once.
  apiOverride = { ebay: () => ({ success: true, itemId: 'retry-item-1' }) };
  const results = await e.retryFailedExports();
  assert.equal(createCalls.length, 1, 'fresh confirmed_failure is retryable');
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
});

// ═════════════════════════════════════════════════════════════════════
// OUT-15..OUT-17 · 2C preservation
// ═════════════════════════════════════════════════════════════════════

test('OUT-15 · 2C concurrency invariant preserved · same SKU/platform → createProduct total = 1', async () => {
  resetSpies();
  //   Re-stub schedulerLock as a serializing simulator (like the 2C suite).
  const leaseState = new Map();
  require.cache[require.resolve(path.join(REPO, 'src/services/schedulerLock'))].exports = {
    withLease: async (lockKey, _opts, fn) => {
      if (leaseState.has(lockKey)) return { acquired: false, ran: false, leaseLost: false };
      leaseState.set(lockKey, true);
      try {
        const value = await fn({ runId: 'r', isLeaseLost: () => false, verifyOwnership: async () => true });
        return { acquired: true, ran: true, leaseLost: false, value };
      } finally {
        leaseState.delete(lockKey);
      }
    },
    OWNER_ID: 'test', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  };
  //   Reload exporter with the new schedulerLock stub.
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));
  apiOverride = { ebay: async () => { await new Promise(r => setTimeout(r, 10)); return { success: true, itemId: 'x' }; } };
  const e = new PE();
  await Promise.all([
    e.exportProduct('SKU-A', ['ebay'], { dryRun: false }),
    e.exportProduct('SKU-A', ['ebay'], { dryRun: false }),
  ]);
  assert.equal(createCalls.length, 1, '2C concurrency fence still active');
});

test('OUT-16 · CONCURRENT_EXPORT_IN_PROGRESS produces no outcome_class write', async () => {
  resetSpies();
  //   schedulerLock returns SKIP_LOCKED unconditionally to simulate contention.
  require.cache[require.resolve(path.join(REPO, 'src/services/schedulerLock'))].exports = {
    withLease: async () => ({ acquired: false, ran: false, leaseLost: false }),
    OWNER_ID: 'test', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  };
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));
  const e = new PE();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  assert.equal(r.results.ebay.code, 'CONCURRENT_EXPORT_IN_PROGRESS');
  //   No upsert with outcome_class should occur — lease-state signal only.
  const outcomeWrites = upsertCalls.filter(u => u.patch.outcome_class !== undefined);
  assert.equal(outcomeWrites.length, 0,
    'lease contention must not touch outcome_class');
});

test('OUT-17 · LEASE_LOST_BEFORE_MARKETPLACE_WRITE produces no marketplace outcome_class', async () => {
  resetSpies();
  //   verifyOwnership returns false → LEASE_LOST_BEFORE_MARKETPLACE_WRITE.
  require.cache[require.resolve(path.join(REPO, 'src/services/schedulerLock'))].exports = {
    withLease: async (_key, _opts, fn) => {
      const value = await fn({
        runId: 'r', isLeaseLost: () => false,
        verifyOwnership: async () => false,
      });
      return { acquired: true, ran: true, leaseLost: true, value };
    },
    OWNER_ID: 'test', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  };
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));
  const e = new PE();
  const r = await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  assert.equal(r.results.ebay.code, 'LEASE_LOST_BEFORE_MARKETPLACE_WRITE');
  //   No outcome_class write — this is lease-state, not marketplace evidence.
  const outcomeWrites = upsertCalls.filter(u => u.patch.outcome_class !== undefined);
  assert.equal(outcomeWrites.length, 0,
    'lease-lost path must not carry a marketplace outcome_class');
  //   And createProduct was never called.
  assert.equal(createCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// OUT-18 · 2B dry-run preservation
// ═════════════════════════════════════════════════════════════════════

test('OUT-18 · dry-run produces zero outcome writes', async () => {
  resetSpies();
  //   Re-stub schedulerLock to pass-through for this test.
  require.cache[require.resolve(path.join(REPO, 'src/services/schedulerLock'))].exports = {
    withLease: async (_k, _o, fn) => {
      const value = await fn({ runId: 'r', isLeaseLost: () => false, verifyOwnership: async () => true });
      return { acquired: true, ran: true, leaseLost: false, value };
    },
    OWNER_ID: 'test', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
  };
  delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
  const PE = require(path.join(REPO, 'src/services/productExporter'));
  const e = new PE();
  const r = await e.exportProduct('SKU-A', ['ebay']); // no options → dry-run
  assert.equal(r.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// OUT-19 · durable ID exact preservation (no "null"/"undefined")
// ═════════════════════════════════════════════════════════════════════

test('OUT-19 · success path writes durable platform_item_id exactly · never literal "null"/"undefined"', async () => {
  resetSpies();
  apiOverride = { ebay: () => ({ success: true, itemId: '3-legit-id_42' }) };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['ebay'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.platform_item_id, '3-legit-id_42');
  assert.notEqual(finalUpsert.patch.platform_item_id, 'null');
  assert.notEqual(finalUpsert.patch.platform_item_id, 'undefined');
});

test('OUT-19b · unknown path never writes platform_item_id (repo default preserved)', async () => {
  resetSpies();
  apiOverride = { shopify: () => ({ success: true, productId: null }) };
  const e = new ProductExporter();
  await e.exportProduct('SKU-A', ['shopify'], { dryRun: false });
  const finalUpsert = upsertCalls[upsertCalls.length - 1];
  assert.equal(finalUpsert.patch.platform_item_id, undefined,
    'UNKNOWN path must omit platform_item_id from the patch entirely');
});

// ═════════════════════════════════════════════════════════════════════
// OUT-20 · migration has no UPDATE / no backfill
// ═════════════════════════════════════════════════════════════════════

test('OUT-20 · migration 111 is ALTER TABLE ADD COLUMN only · no UPDATE / no backfill / no CHECK', () => {
  const sql = readSrc(MIGRATION_FILE);
  //   Strip line-comments so keyword grep doesn't false-positive on prose.
  const nc = sql.replace(/--[^\n]*/g, '');
  //   Required: exactly ADD COLUMN
  assert.ok(/ALTER\s+TABLE\s+platform_export_status[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+outcome_class\s+TEXT/i.test(nc),
    'must contain ALTER TABLE platform_export_status ADD COLUMN outcome_class TEXT');
  //   Forbidden: any UPDATE / INSERT / DELETE
  assert.ok(!/\bUPDATE\b/i.test(nc), 'must not contain UPDATE (would backfill historical)');
  assert.ok(!/\bINSERT\b/i.test(nc), 'must not contain INSERT');
  assert.ok(!/\bDELETE\b/i.test(nc), 'must not contain DELETE');
  //   Forbidden: DEFAULT — would silently classify future writes without evidence.
  assert.ok(!/DEFAULT\s+(['"])?[a-zA-Z_]+\1?/i.test(nc.replace(/COMMENT ON COLUMN[\s\S]*/i,'')),
    'must not add a DEFAULT — new writes MUST specify outcome_class');
  //   Forbidden: CHECK constraint (spec §4 — no CHECK).
  assert.ok(!/\bCHECK\s*\(/i.test(nc), 'must not add CHECK constraint');
});

// ═════════════════════════════════════════════════════════════════════
// Structural: repository filter has the fail-closed clause
// ═════════════════════════════════════════════════════════════════════

test('STRUCT · platformRepository.getFailedExports has .eq(outcome_class, confirmed_failure)', () => {
  const src = readSrc(REPO_JS);
  const fnStart = src.indexOf('async getFailedExports(');
  assert.ok(fnStart > 0);
  //   Slice to next method definition
  const rest = src.slice(fnStart);
  const nextFn = rest.indexOf('async ', 10);
  const block = rest.slice(0, nextFn > 0 ? nextFn : 1500);
  assert.ok(/\.eq\(\s*['"]outcome_class['"]\s*,\s*['"]confirmed_failure['"]\s*\)/.test(block),
    'getFailedExports MUST filter outcome_class = confirmed_failure');
  assert.ok(/\.eq\(\s*['"]export_status['"]\s*,\s*['"]failed['"]\s*\)/.test(block),
    'still filters export_status = failed');
  assert.ok(/\.lt\(\s*['"]retry_count['"]\s*,\s*maxRetries\s*\)/.test(block),
    'still enforces retry_count cap');
});
