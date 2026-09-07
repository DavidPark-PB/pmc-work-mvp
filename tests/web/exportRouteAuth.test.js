'use strict';

/**
 * tests/web/exportRouteAuth.test.js — PMC-EXPORT-SAFETY-2A (2026-09-08).
 *
 * Proves the authorization perimeter around /api/export:
 *
 *   · POST /api/export           requires admin (route-local requireAdmin)
 *   · POST /api/export/retry     requires admin (route-local requireAdmin)
 *   · Normal authenticated non-admin  → 403 · ProductExporter NEVER instantiated
 *   · Legacy shared-password session  → blocked at blockLegacyWrites BEFORE
 *                                       the route handler runs (defense in depth
 *                                       since legacy sessions synthesize isAdmin=true)
 *   · Real admin                      → passes requireAdmin (route reachable)
 *   · GET/read routes unaffected
 *   · Unauthenticated behavior governed by existing authGuard (unchanged)
 *   · WRITE_PATHS_FOR_REAL_USER covers /api/export AND /api/export/retry via
 *     the single '/api/export' entry (startsWith(w + '/') matching)
 *
 * Fence: this test file must NOT trigger ProductExporter or any adapter.
 * All admin-execution paths short-circuit via mock injection.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO      = path.resolve(__dirname, '../../');
const AUTH_PATH = path.join(REPO, 'src/middleware/auth.js');
const API_PATH  = path.join(REPO, 'src/web/routes/api.js');

function readSrc(p) { return fs.readFileSync(p, 'utf8'); }

// ═════════════════════════════════════════════════════════════════════
// STRUCTURAL · AUTH-1 / AUTH-2
// ═════════════════════════════════════════════════════════════════════

test('AUTH-1 · POST /export has requireAdmin as middleware', () => {
  const src = readSrc(API_PATH);
  //   Route definition must have `requireAdmin` between the path literal and
  //   the handler function. Match the entire router.post(...) signature.
  const re = /router\.post\(\s*['"]\/export['"]\s*,\s*requireAdmin\s*,\s*async\s*\(\s*req\s*,\s*res\s*\)\s*=>/;
  assert.ok(re.test(src),
    'POST /export must have requireAdmin as its middleware (before the handler)');
});

test('AUTH-2 · POST /export/retry has requireAdmin as middleware', () => {
  const src = readSrc(API_PATH);
  const re = /router\.post\(\s*['"]\/export\/retry['"]\s*,\s*requireAdmin\s*,\s*async\s*\(\s*req\s*,\s*res\s*\)\s*=>/;
  assert.ok(re.test(src),
    'POST /export/retry must have requireAdmin as its middleware');
});

// ═════════════════════════════════════════════════════════════════════
// BEHAVIORAL · requireAdmin isolation
// ═════════════════════════════════════════════════════════════════════
//
// Load requireAdmin directly from the middleware module and exercise its
// contract with in-memory req/res/next. This is the most-isolated way to
// prove:
//   AUTH-3 · normal staff → 403
//   AUTH-4 · same (both export routes share the same middleware)
//   AUTH-7 · real admin → next() called
//   AUTH-8 · unauthenticated → 401 (existing authGuard behavior preserved
//           at the middleware layer that runs BEFORE requireAdmin)

const { requireAdmin, blockLegacyWrites } =
  require(path.join(REPO, 'src/middleware/auth'));

function makeResSpy() {
  const spy = { statusCode: null, body: null, ended: false };
  return {
    spy,
    status(code) { spy.statusCode = code; return this; },
    json(body)   { spy.body = body; spy.ended = true; return this; },
  };
}
function mkReq({ user, path: p = '/api/export', method = 'POST' } = {}) {
  return { user, path: p, method };
}

test('AUTH-3 · non-admin real user → requireAdmin returns 403', () => {
  const req  = mkReq({ user: { id: 42, isAdmin: false, isLegacy: false } });
  const res  = makeResSpy();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'next() must NOT be called for non-admin');
  assert.equal(res.spy.statusCode, 403);
  assert.ok(res.spy.body && /관리자 권한/.test(res.spy.body.error),
    '403 body must indicate admin-required (in Korean per existing contract)');
});

test('AUTH-4 · non-admin real user on /export/retry → same requireAdmin 403', () => {
  //   Same middleware function; different path doesn't matter to requireAdmin.
  //   This test proves the middleware behavior is consistent for both export
  //   routes.
  const req  = mkReq({ user: { id: 42, isAdmin: false }, path: '/api/export/retry' });
  const res  = makeResSpy();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.spy.statusCode, 403);
});

test('AUTH-7 · real admin (isAdmin=true, isLegacy=false) → requireAdmin next()', () => {
  const req  = mkReq({ user: { id: 1, isAdmin: true, isLegacy: false } });
  const res  = makeResSpy();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'real admin must pass requireAdmin');
  assert.equal(res.spy.statusCode, null, 'no status set — request continues');
  assert.equal(res.spy.ended, false);
});

test('AUTH-8 · unauthenticated (no req.user) → requireAdmin returns 401', () => {
  //   In the real chain, authGuard rejects before requireAdmin runs, so this
  //   condition ordinarily never reaches here. But if it does (e.g. dev-mode
  //   bypass at auth.js:222 where DASHBOARD_PASSWORD is unset), requireAdmin
  //   MUST NOT silently allow — it must 401.
  const req  = mkReq({ user: undefined });
  const res  = makeResSpy();
  let nextCalled = false;
  requireAdmin(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.spy.statusCode, 401);
  assert.equal(res.spy.body.error, 'Authentication required');
});

// ═════════════════════════════════════════════════════════════════════
// BEHAVIORAL · blockLegacyWrites coverage · AUTH-5 / AUTH-6
// ═════════════════════════════════════════════════════════════════════
//
// The legacy shared-password session synthesizes isAdmin=true, so
// requireAdmin ALONE would let it through. The blockLegacyWrites
// middleware runs BEFORE the /api router and rejects legacy sessions
// writing to any path in WRITE_PATHS_FOR_REAL_USER. This suite proves
// both export routes are covered by the '/api/export' entry via the
// existing startsWith(w + '/') matching.

test('AUTH-5 · legacy session POST /api/export → blockLegacyWrites 400', () => {
  const req  = mkReq({
    user: { id: 0, isAdmin: true, isLegacy: true }, // synthetic legacy admin
    path: '/api/export',
    method: 'POST',
  });
  const res  = makeResSpy();
  let nextCalled = false;
  blockLegacyWrites(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'legacy session MUST be blocked BEFORE handler');
  assert.equal(res.spy.statusCode, 400);
  assert.ok(res.spy.body && /레거시/.test(res.spy.body.error),
    'block message must reference 레거시 (legacy)');
});

test('AUTH-6 · legacy session POST /api/export/retry → blockLegacyWrites 400', () => {
  //   startsWith('/api/export' + '/') matches '/api/export/retry' → blocked.
  const req  = mkReq({
    user: { id: 0, isAdmin: true, isLegacy: true },
    path: '/api/export/retry',
    method: 'POST',
  });
  const res  = makeResSpy();
  let nextCalled = false;
  blockLegacyWrites(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.spy.statusCode, 400);
});

// ═════════════════════════════════════════════════════════════════════
// AUTH-9 · GET/read routes unaffected
// ═════════════════════════════════════════════════════════════════════

test('AUTH-9 · blockLegacyWrites lets GET requests pass regardless of path', () => {
  //   Existing contract at auth.js:281 — GET/HEAD/OPTIONS always pass.
  //   Adding '/api/export' to the write-paths list must NOT accidentally
  //   block any GET route.
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const req = mkReq({
      user: { id: 0, isAdmin: true, isLegacy: true },
      path: '/api/export',
      method,
    });
    const res = makeResSpy();
    let nextCalled = false;
    blockLegacyWrites(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `${method} must pass blockLegacyWrites regardless of legacy status`);
    assert.equal(res.spy.statusCode, null);
  }
});

// ═════════════════════════════════════════════════════════════════════
// AUTH-10 · WRITE_PATHS_FOR_REAL_USER coverage scope
// ═════════════════════════════════════════════════════════════════════

test('AUTH-10 · WRITE_PATHS_FOR_REAL_USER includes /api/export and covers /export/retry', () => {
  const src = readSrc(AUTH_PATH);
  //   The array literal must include the '/api/export' string.
  const arrMatch = src.match(/const\s+WRITE_PATHS_FOR_REAL_USER\s*=\s*\[([\s\S]*?)\]\s*;/);
  assert.ok(arrMatch, 'WRITE_PATHS_FOR_REAL_USER const must exist');
  const items = [...arrMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(items.includes('/api/export'),
    "WRITE_PATHS_FOR_REAL_USER must include '/api/export' entry");
  //   Coverage check: verify the existing matching semantics at auth.js:283
  //   (p === w || p.startsWith(w + '/')) cover both endpoints via that single
  //   entry.
  const w = '/api/export';
  const covers = (p) => p === w || p.startsWith(w + '/');
  assert.ok(covers('/api/export'),       '/api/export MUST match');
  assert.ok(covers('/api/export/retry'), '/api/export/retry MUST match via startsWith');
  //   Sanity: unrelated paths that should NOT be swept up by this new entry.
  assert.equal(covers('/api/exports'),           false, 'partial-word prefix must NOT match');
  assert.equal(covers('/api/export-something'),  false, 'kebab-suffix must NOT match');
  assert.equal(covers('/api/exportsomething'),   false, 'contiguous suffix must NOT match');
  assert.equal(covers('/api/tasks'),             false, 'unrelated path must NOT match /api/export entry');
});

test('AUTH-10b · WRITE_PATHS_FOR_REAL_USER scope narrow · no accidental additions', () => {
  //   Whitelist of expected entries (order-independent). Any new entry beyond
  //   the documented set is a scope violation for this phase.
  const src = readSrc(AUTH_PATH);
  const arrMatch = src.match(/const\s+WRITE_PATHS_FOR_REAL_USER\s*=\s*\[([\s\S]*?)\]\s*;/);
  //   Strip // line-comments before extracting string literals — comments in
  //   the array body may quote slashes (e.g. "startsWith(w + '/')") that would
  //   otherwise be picked up as spurious entries by the regex below.
  const body = arrMatch[1].replace(/\/\/[^\n]*/g, '');
  const items = [...body.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  const EXPECTED = new Set([
    '/api/tasks', '/api/purchase-requests', '/api/attendance', '/api/payroll',
    '/api/bonuses', '/api/feedback', '/api/users', '/api/admin',
    '/api/notifications',
    '/api/export',   // PMC-EXPORT-SAFETY-2A added exactly this
  ]);
  const unexpected = items.filter(x => !EXPECTED.has(x));
  assert.deepEqual(unexpected, [],
    `PMC-EXPORT-SAFETY-2A must add ONLY '/api/export'. Unexpected extras: ${unexpected.join(', ')}`);
  //   And every expected entry must be present.
  const missing = [...EXPECTED].filter(x => !items.includes(x));
  assert.deepEqual(missing, [],
    `WRITE_PATHS_FOR_REAL_USER must contain all baseline paths. Missing: ${missing.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════
// SERVICE-EXECUTION FENCE
// ═════════════════════════════════════════════════════════════════════
//
// Prove the rejected users CANNOT reach ProductExporter. Since Express
// middleware runs in declared order, and requireAdmin at auth.js:249-253
// terminates the chain with res.status(403).json(...) BEFORE calling
// next(), the subsequent async handler that instantiates ProductExporter
// is guaranteed unreachable when the gate returns 403.
//
// The strongest evidence is combination of AUTH-1/AUTH-2 (structural
// proof requireAdmin is FIRST middleware on the route) + AUTH-3/AUTH-4
// (behavioral proof requireAdmin returns 403 without calling next).
// Together those two guarantee non-admin cannot reach the handler.
//
// Additionally, this file NEVER requires ProductExporter, NEVER
// constructs one, NEVER invokes any marketplace adapter — so the test
// harness itself performs zero real marketplace calls even under admin
// execution paths (AUTH-7 stops at requireAdmin.next()).

test('FENCE · this test file does not require ProductExporter or marketplace adapters', () => {
  //   Confirm the test harness itself does not load any marketplace code path.
  //   Strategy: parse require() call sites out of this file and check none
  //   point at forbidden modules. Comparing require targets (rather than raw
  //   substring match) avoids self-referential false positives from strings
  //   used elsewhere in the file.
  const selfSrc = readSrc(__filename);
  //   Strip block/line comments so a forbidden name INSIDE a comment (like
  //   this one) does not trip the check.
  const stripped = selfSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const requireTargets = [...stripped.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map(m => m[1]);
  const FORBIDDEN_TOKENS = [
    'productExporter', 'ebayAPI', 'shopifyAPI', 'naverAPI',
    'alibabaAPI', 'shopeeAPI', 'coupangAPI', 'qoo10API',
    'platformRegistry',
  ];
  //   The api.js router itself is forbidden too: loading it would evaluate
  //   the whole route file, which imports all marketplace adapters
  //   transitively.
  const forbiddenPaths = ['src/web/routes/api', 'src/services/productExporter'];
  for (const target of requireTargets) {
    for (const tok of FORBIDDEN_TOKENS) {
      assert.equal(target.includes(tok), false,
        `this test file MUST NOT require('${target}') — matches forbidden token "${tok}"`);
    }
    for (const p of forbiddenPaths) {
      assert.equal(target.includes(p), false,
        `this test file MUST NOT require('${target}') — matches forbidden path "${p}"`);
    }
  }
});

test('FENCE · api.js /export routes still call ProductExporter INSIDE the handler (not before requireAdmin)', () => {
  //   Structural: within the route definition line and its handler body,
  //   `new ProductExporter()` MUST appear AFTER the requireAdmin middleware
  //   token. Since requireAdmin is the 2nd argument to router.post, and the
  //   handler is the 3rd argument, this ordering is enforced by JavaScript
  //   syntax + Express semantics — but we verify structurally.
  const src = readSrc(API_PATH);
  //   Grab the /export block: from router.post('/export', requireAdmin, ...)
  //   up to the closing router.post('/export/retry', ...).
  const startIdx = src.indexOf("router.post('/export',");
  assert.ok(startIdx > 0);
  const endIdx = src.indexOf("router.post('/export/retry',", startIdx);
  const exportBlock = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 1500);
  //   requireAdmin must appear BEFORE new ProductExporter in the source order.
  const raIdx = exportBlock.indexOf('requireAdmin');
  const peIdx = exportBlock.indexOf('new ProductExporter()');
  assert.ok(raIdx > 0, 'requireAdmin token present in /export block');
  assert.ok(peIdx > 0, 'new ProductExporter() token present in /export block');
  assert.ok(raIdx < peIdx,
    'requireAdmin MUST appear before new ProductExporter() (middleware runs first)');
  //   Same for /export/retry
  const retryStart = src.indexOf("router.post('/export/retry',");
  const retryBlock = src.slice(retryStart, retryStart + 1000);
  const raRetryIdx = retryBlock.indexOf('requireAdmin');
  const peRetryIdx = retryBlock.indexOf('new ProductExporter()');
  assert.ok(raRetryIdx > 0 && peRetryIdx > 0);
  assert.ok(raRetryIdx < peRetryIdx,
    'requireAdmin MUST appear before new ProductExporter() in /export/retry too');
});

test('FENCE · no other /api route was accidentally gated by this phase', () => {
  //   Prove PMC-EXPORT-SAFETY-2A only added requireAdmin to /export and
  //   /export/retry. Count total requireAdmin usages in api.js and compare
  //   to a stable baseline.
  //     Pre-2A: /sync/master had requireAdmin (api.js:6337). That's 1.
  //     Post-2A: /export + /export/retry + /sync/master = 3.
  //   If more appeared, this phase's scope was violated.
  const src = readSrc(API_PATH);
  //   Count `router.post(..., requireAdmin, ...)` and `router.get/put/delete`
  //   variants. Only count route-application (not the import line).
  const routePattern = /router\.(post|get|put|patch|delete)\([^)]{0,200}requireAdmin/g;
  const matches = src.match(routePattern) || [];
  assert.equal(matches.length, 3,
    `PMC-EXPORT-SAFETY-2A must gate exactly /export + /export/retry + preserve /sync/master. Total: ${matches.length}`);
});
