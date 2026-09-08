'use strict';

/**
 * tests/services/exportProductDryRun.test.js — PMC-EXPORT-SAFETY-2B (2026-09-08).
 *
 * Proves the dry-run-by-default contract on ProductExporter and the strict
 * `execute === true` route-layer parsing. Also verifies UI structural
 * wiring (buttons, invalidation on input change) so the two-step flow
 * cannot regress by accident.
 *
 * ZERO real marketplace calls, zero real DB writes. All collaborators are
 * mocked via require.cache substitution BEFORE ProductExporter is loaded.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO         = path.resolve(__dirname, '../..');
const API_JS       = path.join(REPO, 'src/web/routes/api.js');
const EXPORTER_JS  = path.join(REPO, 'src/services/productExporter.js');
const DASHBOARD_JS = path.join(REPO, 'public/js/dashboard.js');
const INDEX_HTML   = path.join(REPO, 'public/index.html');

// ═════════════════════════════════════════════════════════════════════
// Mock harness · install BEFORE require('src/services/productExporter')
// ═════════════════════════════════════════════════════════════════════

const upsertCalls    = [];   // populated when execute reaches platRepo.upsertExportStatus
const createCalls    = [];   // populated when execute reaches api.createProduct
const translateCalls = [];   // populated when execute reaches translationService.translateProduct

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = {
    id: fullPath, filename: fullPath, loaded: true,
    exports: exportsObj, children: [], paths: [],
  };
}
function resetSpies() { upsertCalls.length = 0; createCalls.length = 0; translateCalls.length = 0; }

//   Fake supabase client — only supports `db.from('products').select().eq('sku', ...).single()`.
function fakeClient() {
  return {
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; },
        eq(col, val) { chain._eqCol = col; chain._eqVal = val; return chain; },
        single() {
          if (table === 'products' && chain._eqCol === 'sku') {
            if (chain._eqVal === 'SKU-KNOWN') {
              return Promise.resolve({ data: {
                id: 42, sku: 'SKU-KNOWN',
                title: 'Test Product', title_ko: '테스트 상품',
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

//   Fake platformRepository — PlatformRepository class exported directly.
class FakePlatformRepository {
  async upsertExportStatus(productId, platformId, patch) {
    upsertCalls.push({ productId, platformId, patch });
    return { ok: true };
  }
  async getMappingForProductPlatform(_pid, _plid) { return null; }
  async getFailedExports(_limit) { return []; }
  async getAllExportStatuses(_pid) { return []; }
}
stub(require.resolve(path.join(REPO, 'src/db/platformRepository')), FakePlatformRepository);

//   Fake platformRegistry.
const fakePlatform = { id: 'plat-1', key: 'ebay', name: 'eBay', active: true, config: {} };
stub(require.resolve(path.join(REPO, 'src/services/platformRegistry')), {
  getFeeRates:       async () => ({ ebay: 0.13, shopify: 0.02, naver: 0.05 }),
  getExchangeRates:  async () => ({ USD_KRW: 1400 }),
  getMarginSettings: async () => ({ default_margin_pct: 30, default_shipping_usd: 3.9 }),
  getPlatform:       async (key) => (key === 'ebay' || key === 'shopify' ? { ...fakePlatform, key } : null),
  getApiInstance:    (_key) => ({
    async createProduct(payload) {
      createCalls.push(payload);
      return { itemId: 'mock-item-99' };
    },
    async getToken() { return 'tok'; },
  }),
});

//   Fake pricingEngine — return per-platform price + currency.
stub(require.resolve(path.join(REPO, 'src/services/pricingEngine')), {
  calculatePrices: (_inputs, _fees, _rates) => ({
    ebay:    { price: 19.99, currency: 'USD' },
    shopify: { price: 21.50, currency: 'USD' },
    naver:   { price: 25000,  currency: 'KRW' },
  }),
});

//   Fake platformOptimizer — echo a minimal shape sufficient for createProduct.
stub(require.resolve(path.join(REPO, 'src/services/platformOptimizer')), {
  optimize: (_key, product, prices, _ctx) => ({
    sku: product.sku, title: product.titleEn || product.title, price: prices[_key]?.price,
  }),
});

//   Fake translationService — spy translateProduct so we can prove dry-run never calls it.
class FakeTranslationService {
  async getTranslation(_pid, _lang) { return null; }
  async translateProduct(pid, lang) {
    translateCalls.push({ pid, lang });
    return { title: 'Auto-translated', description: 'Auto desc', keywords: [] };
  }
}
stub(require.resolve(path.join(REPO, 'src/services/translationService')), FakeTranslationService);

//   PMC-EXPORT-SAFETY-2C added `require('./schedulerLock')` to productExporter.
//   Stub it so this suite never touches the real scheduler_leases DB. The
//   dry-run tests never reach the lease path anyway (2C only leases on
//   execute:true), but the execute-mode PREVIEW-10 test does. Behavior:
//   always-succeeds pass-through so the underlying test contracts remain
//   about dry-run semantics, not lease semantics (that's 2C's own suite).
stub(require.resolve(path.join(REPO, 'src/services/schedulerLock')), {
  withLease: async (_key, _opts, fn) => {
    const value = await fn({ runId: 'test-run', isLeaseLost: () => false, verifyOwnership: async () => true });
    return { acquired: true, ran: true, leaseLost: false, value };
  },
  OWNER_ID: 'test', MAX_TTL_SECONDS: 86400, DEFAULT_TTL_SECONDS: 600, DEFAULT_HEARTBEAT_SEC: 60,
});

//   Now load ProductExporter — its `require(...)` calls will hit our stubs.
delete require.cache[require.resolve(path.join(REPO, 'src/services/productExporter'))];
const ProductExporter = require(path.join(REPO, 'src/services/productExporter'));

function readSrc(p) { return fs.readFileSync(p, 'utf8'); }

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-1 · route parses execute strictly (structural)
// ═════════════════════════════════════════════════════════════════════

test('PREVIEW-1 · api.js /export route parses execute with strict === true', () => {
  const src = readSrc(API_JS);
  //   Extract the /export handler block (up to the next router.post)
  const startRe = /router\.post\(\s*['"]\/export['"]\s*,\s*requireAdmin/;
  const startIdx = src.search(startRe);
  assert.ok(startIdx > 0, '/export route with requireAdmin must exist');
  const nextRouteIdx = src.indexOf("router.post(", startIdx + 20);
  const block = src.slice(startIdx, nextRouteIdx > 0 ? nextRouteIdx : startIdx + 1500);
  //   Must have strict === true parsing.
  assert.ok(/req\.body\?\.execute\s*===\s*true/.test(block),
    "route must parse execute with strict `req.body?.execute === true` (no coercion)");
  //   Must invoke exporter with dryRun: !execute.
  assert.ok(/dryRun\s*:\s*!\s*execute/.test(block),
    'route must forward { dryRun: !execute } to exporter.exportProduct');
});

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-2..6 · exporter dry-run truth table
// ═════════════════════════════════════════════════════════════════════
//
// The route builds `{ dryRun: !execute }` where execute is strict boolean
// true only. Prove each equivalent-to-route call falls into dry-run.

async function exerciseExporter(bodyLike) {
  //   Reproduce the same expression as api.js: strict === true.
  const execute = bodyLike?.execute === true;
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: !execute });
  return { result, execute };
}

test('PREVIEW-2 · execute:false → dry-run · no writes', async () => {
  const { result, execute } = await exerciseExporter({ execute: false });
  assert.equal(execute, false);
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
  assert.equal(result.results.ebay.would_execute, false);
});

test('PREVIEW-3 · execute:"true" (string) → dry-run · no writes', async () => {
  const { result, execute } = await exerciseExporter({ execute: 'true' });
  assert.equal(execute, false, 'string "true" must NOT satisfy === true');
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

test('PREVIEW-4 · execute:1 (number) → dry-run · no writes', async () => {
  const { result, execute } = await exerciseExporter({ execute: 1 });
  assert.equal(execute, false, 'numeric 1 must NOT satisfy === true');
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

test('PREVIEW-4b · other coercible values ("1", "yes", {}, null) all → dry-run', async () => {
  for (const v of ['1', 'yes', {}, null, undefined, 0, '']) {
    const { result, execute } = await exerciseExporter({ execute: v });
    assert.equal(execute, false, `value ${JSON.stringify(v)} must not satisfy === true`);
    assert.equal(result.dryRun, true);
    assert.equal(upsertCalls.length, 0);
    assert.equal(createCalls.length, 0);
  }
});

test('PREVIEW-1b · missing execute (undefined) → dry-run', async () => {
  const { result, execute } = await exerciseExporter({});
  assert.equal(execute, false);
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

test('PREVIEW-5 · execute:true (strict boolean) → dryRun:false is set', async () => {
  const { result, execute } = await exerciseExporter({ execute: true });
  assert.equal(execute, true);
  assert.equal(result.dryRun, false);
});

test('PREVIEW-6 · exportProduct(sku, platforms) with NO options → dry-run by default', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay']);
  assert.equal(result.dryRun, true, 'omitted options must default to dry-run');
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
  assert.equal(translateCalls.length, 0, 'dry-run must not auto-translate (DB write)');
});

test('PREVIEW-6b · exportProduct(..., {}) with empty options → dry-run', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay'], {});
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

test('PREVIEW-6c · exportProduct(..., { dryRun: true }) → dry-run', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0);
  assert.equal(createCalls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-7 · dry-run: 0 upsertExportStatus writes
// ═════════════════════════════════════════════════════════════════════

test('PREVIEW-7 · dry-run across multiple platforms → 0 upsertExportStatus writes', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay', 'shopify']);
  assert.equal(result.dryRun, true);
  assert.equal(upsertCalls.length, 0, 'dry-run must NOT write platform_export_status');
});

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-8 · dry-run: 0 marketplace createProduct calls
// ═════════════════════════════════════════════════════════════════════

test('PREVIEW-8 · dry-run → 0 marketplace createProduct calls', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  await exporter.exportProduct('SKU-KNOWN', ['ebay', 'shopify']);
  assert.equal(createCalls.length, 0, 'api.createProduct must NEVER be invoked in dry-run');
});

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-9 · dry-run returns preview rows for all supported platforms
// ═════════════════════════════════════════════════════════════════════

test('PREVIEW-9 · dry-run returns preview rows for all supported requested platforms', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay', 'shopify', 'unknown-platform']);
  assert.ok(result.results.ebay,    'ebay preview row present');
  assert.ok(result.results.shopify, 'shopify preview row present');
  assert.ok(result.results['unknown-platform'], 'unknown platform row present with supported:false');
  //   Supported rows expose computed_price/currency/would_execute:false
  for (const key of ['ebay', 'shopify']) {
    const r = result.results[key];
    assert.equal(r.supported, true, `${key}.supported = true`);
    assert.equal(r.would_execute, false, `${key}.would_execute = false`);
    assert.ok(r.computed_price != null, `${key}.computed_price present`);
  }
  const unk = result.results['unknown-platform'];
  assert.equal(unk.supported, false);
  assert.equal(unk.would_execute, false);
  assert.ok((unk.blockers || []).length > 0, 'unknown platform must surface blockers[]');
});

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-10 · execute:true reaches mocked createProduct (no real marketplace)
// ═════════════════════════════════════════════════════════════════════

test('PREVIEW-10 · execute:true path reaches mocked api.createProduct + records status', async () => {
  resetSpies();
  const exporter = new ProductExporter();
  const result = await exporter.exportProduct('SKU-KNOWN', ['ebay'], { dryRun: false });
  assert.equal(result.dryRun, false);
  //   Real path: at least one upsert (exporting) + one upsert (success), and one createProduct call.
  assert.ok(createCalls.length >= 1, 'execute path must reach api.createProduct');
  assert.ok(upsertCalls.length >= 2, 'execute path must upsert status ≥ twice (exporting, then success/fail)');
  assert.equal(result.results.ebay.success, true);
  assert.equal(result.results.ebay.itemId, 'mock-item-99');
});

test('PREVIEW-10b · retryFailedExports keeps execution semantics (not accidentally dry-run)', async () => {
  //   Bug guard: since exportProduct now defaults to dry-run, retryFailedExports
  //   must pass { dryRun: false } explicitly. Verify structurally in source.
  const src = readSrc(EXPORTER_JS);
  const retryStart = src.indexOf('async retryFailedExports');
  assert.ok(retryStart > 0);
  const retryBlock = src.slice(retryStart, retryStart + 1500);
  assert.ok(/this\.exportProduct\([^)]*\{\s*dryRun\s*:\s*false\s*\}/.test(retryBlock),
    'retryFailedExports must forward { dryRun: false } to exportProduct');
});

// ═════════════════════════════════════════════════════════════════════
// PREVIEW-11..14 · UI two-step flow (structural)
// ═════════════════════════════════════════════════════════════════════

test('PREVIEW-11 · UI 미리보기 button does NOT send execute:true', () => {
  const dash = readSrc(DASHBOARD_JS);
  //   Locate runExportPreview and confirm the body it sends.
  const startIdx = dash.indexOf('async function runExportPreview');
  assert.ok(startIdx > 0, 'runExportPreview function must exist');
  //   Find its closing brace via brace-count.
  let depth = 0, endIdx = -1;
  for (let i = startIdx; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  assert.ok(endIdx > startIdx);
  const body = dash.slice(startIdx, endIdx + 1);
  //   fetch body must include execute:false OR omit execute entirely.
  //   We require the explicit-intent form: execute: false.
  assert.ok(/execute\s*:\s*false/.test(body),
    'runExportPreview must send execute:false in its POST body');
  assert.ok(!/execute\s*:\s*true/.test(body),
    'runExportPreview MUST NOT send execute:true');
});

test('PREVIEW-12 · UI 실행 button sends strict boolean execute:true only after preview + confirm', () => {
  const dash = readSrc(DASHBOARD_JS);
  const startIdx = dash.indexOf('async function confirmAndExecuteExport');
  assert.ok(startIdx > 0, 'confirmAndExecuteExport function must exist');
  let depth = 0, endIdx = -1;
  for (let i = startIdx; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  const body = dash.slice(startIdx, endIdx + 1);
  //   Must guard on `lastPreview` matching current form key.
  assert.ok(/lastPreview/.test(body) && /formKey/.test(body),
    'execute handler must guard on lastPreview.formKey === current form key');
  //   Must call confirm() before firing the network request.
  const confirmIdx = body.indexOf('confirm(');
  const fetchIdx   = body.indexOf('fetch(');
  assert.ok(confirmIdx > 0 && fetchIdx > 0 && confirmIdx < fetchIdx,
    'confirm() must be called before fetch()');
  //   Must send strict boolean execute:true (not "true" or 1).
  assert.ok(/execute\s*:\s*true\b/.test(body),
    'execute handler must send execute:true (strict boolean)');
});

test('PREVIEW-13 · UI · changing SKU invalidates execute-ready state', () => {
  const dash = readSrc(DASHBOARD_JS);
  //   loadExportPage must wire skuInput.oninput = invalidateExportExecuteState.
  assert.ok(/exportSku[\s\S]*?oninput\s*=\s*invalidateExportExecuteState/.test(dash),
    'SKU input must invalidate execute-ready state on change');
  //   invalidateExportExecuteState must disable the executeExportBtn.
  const invStart = dash.indexOf('function invalidateExportExecuteState');
  assert.ok(invStart > 0);
  const invBlock = dash.slice(invStart, invStart + 400);
  assert.ok(/executeExportBtn/.test(invBlock),
    'invalidateExportExecuteState must reference executeExportBtn');
  assert.ok(/disabled\s*=\s*true/.test(invBlock),
    'invalidateExportExecuteState must set disabled = true');
});

test('PREVIEW-14 · UI · changing platform selection invalidates execute-ready state', () => {
  const dash = readSrc(DASHBOARD_JS);
  //   The platform checkbox container must listen on 'change' → invalidate.
  assert.ok(
    /exportPlatformCheckboxes[\s\S]*?addEventListener\(\s*['"]change['"]\s*,\s*invalidateExportExecuteState\s*\)/.test(dash),
    'platform checkbox container must invalidate execute-ready state on change'
  );
});

test('PREVIEW-14b · index.html · execute button starts disabled with warning color', () => {
  const html = readSrc(INDEX_HTML);
  //   Locate executeExportBtn element and check for `disabled` attribute.
  const btnRe = /<button[^>]*id="executeExportBtn"[^>]*>/;
  const m = html.match(btnRe);
  assert.ok(m, 'executeExportBtn element must exist');
  assert.ok(/\bdisabled\b/.test(m[0]),
    'executeExportBtn must be initially disabled');
});

test('PREVIEW-14c · index.html · preview button labeled "미리보기" (not the old "내보내기 실행")', () => {
  const html = readSrc(INDEX_HTML);
  //   Locate runExportBtn's inner label.
  const re = /<button[^>]*id="runExportBtn"[^>]*>([^<]+)<\/button>/;
  const m = html.match(re);
  assert.ok(m, 'runExportBtn element must exist');
  assert.equal(m[1].trim(), '미리보기',
    'runExportBtn label must be "미리보기" (was "내보내기 실행" before 2B)');
});

// ═════════════════════════════════════════════════════════════════════
// AUTH REGRESSION · 2A gates unchanged
// ═════════════════════════════════════════════════════════════════════

test('AUTH REGRESSION · /export + /export/retry still gated by requireAdmin', () => {
  const src = readSrc(API_JS);
  assert.ok(/router\.post\(\s*['"]\/export['"]\s*,\s*requireAdmin/.test(src),
    'POST /export must retain requireAdmin (PMC-EXPORT-SAFETY-2A)');
  assert.ok(/router\.post\(\s*['"]\/export\/retry['"]\s*,\s*requireAdmin/.test(src),
    'POST /export/retry must retain requireAdmin (PMC-EXPORT-SAFETY-2A)');
});

test('AUTH REGRESSION · WRITE_PATHS_FOR_REAL_USER still includes /api/export', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/middleware/auth.js'), 'utf8');
  const arrMatch = src.match(/const\s+WRITE_PATHS_FOR_REAL_USER\s*=\s*\[([\s\S]*?)\]\s*;/);
  assert.ok(arrMatch);
  const body = arrMatch[1].replace(/\/\/[^\n]*/g, '');
  const items = [...body.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(items.includes('/api/export'), 'legacy write fence must still cover /api/export');
});
