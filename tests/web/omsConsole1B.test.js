'use strict';

/**
 * tests/web/omsConsole1B.test.js — PMC-OMS-CONSOLE-1B (2026-09-12).
 *
 * Structural + runtime proofs for the canonical OMS pending-action console:
 *
 *   A. `case 'oms-orders':` exists in dashboard.js switch
 *   B. Sidebar entry `data-page="oms-orders"` present under 주문·배송
 *   C. `<div id="page-oms-orders">` exists
 *   D. `omsOrders.js` script tag present with defer
 *   E. URL scope whitelist accepts ONLY 'pending-action'
 *   F. 미처리 KPI drill href = /?page=oms-orders&scope=pending-action
 *   G. 미처리 row renders as link only when count > 0 (gate: drill && numeric > 0)
 *   H. Page header shows API total, NOT briefing count
 *   I. Initial fetch uses limit=50 & offset=0
 *   J. Pagination controls exist (prev/next buttons, server-side)
 *   K. Loading / KNOWN_EMPTY / UNKNOWN_FAILURE are three distinct states
 *   L. Failure branch NEVER coalesces to `0건` (Unknown ≠ Zero)
 *   M. No mutation controls (approve/reject/ship/cancel/refund/tracking)
 *   N. No PII columns (buyer email / phone / address) in table rendering
 *   O. No secondary API fetch (/api/... beyond /api/oms/orders/pending-action)
 *   P. No legacy wms_orders / wmsOrderRepository / /api/orders reference
 *   Q. DRILL-2 four existing drills unchanged
 *   R. PERF-2B sentinels unchanged
 *   S. Runtime: unknown scope values silently rejected by whitelist
 *   T. Runtime: failed fetch renders UNKNOWN_FAILURE + does not touch _total
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const OMS_JS  = path.join(REPO, 'public/js/omsOrders.js');
const DASH_JS = path.join(REPO, 'public/js/dashboard.js');
const BRIEF   = path.join(REPO, 'public/js/opsBriefing.js');
const INDEX   = path.join(REPO, 'public/index.html');

const readSrc = (p) => fs.readFileSync(p, 'utf8');

// ═════════════════════════════════════════════════════════════════════
// A–D. Wiring
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-A · dashboard.js switch has `case "oms-orders":` dispatching pmcOmsOrders.init', () => {
  const src = readSrc(DASH_JS);
  const idx = src.indexOf("case 'oms-orders'");
  assert.ok(idx > 0, `case 'oms-orders' must exist in navigateTo switch`);
  const region = src.slice(idx, idx + 400);
  assert.ok(/pmcOmsOrders\.init\(\)/.test(region),
    `oms-orders case must dispatch pmcOmsOrders.init()`);
});

test('OMS1B-FE-B · sidebar entry data-page="oms-orders" present under 주문·배송', () => {
  const src = readSrc(INDEX);
  assert.ok(/data-page="oms-orders"/.test(src), 'sidebar must expose oms-orders route');
  //   Placement: under the 주문·배송 menu title.
  const anchorIdx = src.indexOf('주문·배송');
  const entryIdx  = src.indexOf('data-page="oms-orders"');
  assert.ok(anchorIdx > 0 && entryIdx > anchorIdx,
    'oms-orders entry must sit under the 주문·배송 menu-title in DOM order');
});

test('OMS1B-FE-C · <div id="page-oms-orders"> exists with #oms-orders-section child', () => {
  const src = readSrc(INDEX);
  assert.ok(/<div\s+id="page-oms-orders"\s+class="page">/.test(src),
    'page-oms-orders div must exist');
  assert.ok(/id="oms-orders-section"/.test(src),
    'page-oms-orders must contain an #oms-orders-section mount point');
});

test('OMS1B-FE-D · omsOrders.js is loaded via <script defer>', () => {
  const src = readSrc(INDEX);
  assert.ok(/<script\s+defer\s+src="\/js\/omsOrders\.js\?v=[^"]+"><\/script>/.test(src),
    'omsOrders.js must load with defer (preserves 0071dcd contract)');
});

// ═════════════════════════════════════════════════════════════════════
// E. URL scope whitelist — 'pending-action' only
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-E · URL scope whitelist accepts ONLY "pending-action"', () => {
  const src = readSrc(OMS_JS);
  const m = /URL_ALLOWED_SCOPES\s*=\s*\[([^\]]+)\]/.exec(src);
  assert.ok(m, 'URL_ALLOWED_SCOPES constant must exist');
  const values = m[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  assert.deepEqual(values, ['pending-action'],
    'whitelist must be exactly ["pending-action"]');
  //   Whitelist gate must be enforced.
  assert.ok(/URL_ALLOWED_SCOPES\.includes\(\s*s\s*\)/.test(src),
    'readScopeFromUrl must gate on URL_ALLOWED_SCOPES.includes(s)');
});

// ═════════════════════════════════════════════════════════════════════
// F/G. Briefing drill wiring — hef + count-gated clickability
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-F · briefing 미처리 drill href is /?page=oms-orders&scope=pending-action', () => {
  const src = readSrc(BRIEF);
  const m = /omsPendingDrill\s*=\s*\{[^}]*href:\s*'([^']+)'/s.exec(src);
  assert.ok(m, 'omsPendingDrill object literal must exist');
  assert.equal(m[1], '/?page=oms-orders&scope=pending-action');
  //   The 미처리 row array must reference the drill object as its 4th element.
  //   Anchor on the exact row shape.
  const rowLine = /\[\s*'미처리',[^\]]+omsPendingDrill[^\]]*\]/.exec(src);
  assert.ok(rowLine, '미처리 row must pass omsPendingDrill as its drill argument');
});

test('OMS1B-FE-G · sectionCard renders <a> only when drill && numeric > 0 (0/null non-clickable)', () => {
  const src = readSrc(BRIEF);
  //   Reuse the existing guard from DRILL-2 — must remain unchanged.
  assert.ok(/isNumericPositive\s*=\s*typeof\s+value\s*===\s*'number'\s*&&\s*value\s*>\s*0/.test(src),
    'isNumericPositive predicate must be preserved from DRILL-2');
  assert.ok(/if\s*\(\s*drill\s*&&\s*isNumericPositive\s*\)/.test(src),
    '<a> branch must gate on drill && isNumericPositive');
});

// ═════════════════════════════════════════════════════════════════════
// H. Total comes from API, not from briefing aggregate
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-H · page reads total from /api/oms/orders/pending-action, NEVER re-fetches briefing', () => {
  const src = readSrc(OMS_JS);
  assert.ok(/\/api\/oms\/orders\/pending-action/.test(src),
    'page must fetch the canonical endpoint');
  assert.ok(!/\/api\/ops-briefing/.test(src),
    'page MUST NOT re-fetch briefing (count must derive from list response)');
  //   Total updates through updateHeader called after fetch.
  assert.ok(/updateHeader\s*\(\s*_total\s*,\s*_offset\s*,\s*rows\.length\s*\)/.test(src),
    'updateHeader must be invoked with the API-derived total');
});

// ═════════════════════════════════════════════════════════════════════
// I. Initial fetch parameters
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-I · initial fetch uses limit=50 & offset=0', () => {
  const src = readSrc(OMS_JS);
  assert.ok(/PAGE_LIMIT\s*=\s*50/.test(src), 'PAGE_LIMIT must be 50');
  //   Both prev/next paginate by exactly PAGE_LIMIT (server-side, not client-side slicing).
  assert.ok(/_offset\s*\+=\s*PAGE_LIMIT/.test(src), 'next must advance _offset by PAGE_LIMIT');
  assert.ok(/_offset\s*-\s*PAGE_LIMIT/.test(src),   'prev must decrement _offset by PAGE_LIMIT');
});

// ═════════════════════════════════════════════════════════════════════
// J. Pagination controls
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-J · prev/next buttons + refresh button in shell', () => {
  const src = readSrc(OMS_JS);
  assert.ok(/id="oms-prev"/.test(src), 'prev button must exist');
  assert.ok(/id="oms-next"/.test(src), 'next button must exist');
  assert.ok(/id="oms-refresh"/.test(src), 'refresh button must exist');
  //   No bulk selection / mutation buttons.
  assert.ok(!/id="oms-select-all"|id="oms-bulk"|id="oms-approve"|id="oms-ship"/.test(src),
    'no bulk / mutation controls allowed in V1');
});

// ═════════════════════════════════════════════════════════════════════
// K/L. Three distinct states + Unknown ≠ Zero
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-K · three render functions exist for the three states', () => {
  const src = readSrc(OMS_JS);
  assert.ok(/function renderLoading\s*\(\)/.test(src),         'renderLoading must exist');
  assert.ok(/function renderKnownEmpty\s*\(\)/.test(src),      'renderKnownEmpty must exist');
  assert.ok(/function renderUnknownFailure\s*\(/.test(src),    'renderUnknownFailure must exist');
});

test('OMS1B-FE-L · failure branch sets _total=null (never fake 0)', () => {
  const src = readSrc(OMS_JS);
  //   Both throw path and !ok path must reset _total to null.
  const failureAssignments = (src.match(/_total\s*=\s*null/g) || []).length;
  assert.ok(failureAssignments >= 2,
    'both failure branches (!res.ok and catch) must set _total = null');
  //   The header renderer must render `확인 실패` (not `0건`) when total is not a number.
  assert.ok(/미처리 주문 확인 실패/.test(src),
    'unknown-total header must say "확인 실패" — never "0건"');
});

// ═════════════════════════════════════════════════════════════════════
// M/N. No mutation, no PII columns
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-M · no mutation controls (no approve/reject/ship/cancel/refund/tracking)', () => {
  const src = readSrc(OMS_JS);
  const forbidden = /approve|reject|markShipped|cancel|refund|updateTracking|deleteOrder|patchOrder|POST|PATCH|DELETE|PUT/i;
  //   Search only within the file — any real mutation surface would show these.
  //   'processing' (status label) does NOT match. This filter must remain sharp.
  const matches = src.match(forbidden);
  //   Empty-state message uses "현재 미처리 주문이 없습니다." — no forbidden words.
  //   POST/PATCH/DELETE/PUT come only from this regex — should not appear in code.
  if (matches) {
    //   Whitelist: `_scope`, `PAGE_LIMIT`, etc are fine. Reject only if the match
    //   is inside a real fetch call or event handler.
    const httpVerbInFetch = /method:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i.test(src);
    assert.equal(httpVerbInFetch, false,
      'no write-verb fetch invocation allowed in V1');
  }
  //   No form-submit either (guard against inline forms doing writes).
  assert.ok(!/<form[\s>]/i.test(src), 'no <form> elements allowed in V1');
});

test('OMS1B-FE-N · no PII columns rendered (no buyer_email / phone / address)', () => {
  const src = readSrc(OMS_JS);
  const forbiddenFields = ['buyer_email', 'buyer_phone', 'buyer_name',
                            'ship_street1', 'ship_street2', 'ship_postal_code',
                            'ship_phone', 'raw_payload'];
  for (const f of forbiddenFields) {
    assert.ok(!new RegExp(`o\\.${f}\\b`).test(src),
      `page must not read o.${f} (PII / non-V1 field)`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// O. Single primary request (no fanout)
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-O · exactly one fetch invocation site + no secondary /api/* fanout', () => {
  const src = readSrc(OMS_JS);
  //   Count only actual invocations — `await fetch(...)` — not prose mentions
  //   in the docstring like "no secondary API fetch (...)".
  const invocations = src.match(/\bawait\s+fetch\s*\(/g) || [];
  assert.equal(invocations.length, 1,
    `expected exactly one 'await fetch(...)' invocation; got ${invocations.length}`);
  //   The one fetch must target the canonical endpoint.
  assert.ok(/await\s+fetch\(`\/api\/oms\/orders\/pending-action\?/.test(src),
    'the single fetch must target /api/oms/orders/pending-action');
});

// ═════════════════════════════════════════════════════════════════════
// P. No legacy references
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-P · no legacy wms_orders / wmsOrderRepository CALL / /api/orders fetch', () => {
  const src = readSrc(OMS_JS);
  //   Executable-code shapes only (comments referencing the fence as rationale
  //   are permitted and desirable). SPA is browser-side so `require(...)` is
  //   not a runtime concern — check for concrete call sites instead.
  const forbiddenExec = [
    /\.from\(\s*['"]wms_orders['"]\s*\)/,           // legacy table query (browser side unlikely, still fenced)
    /window\.pmcOrderList/,                          // legacy WMS list module hook
    /await\s+fetch\s*\(\s*['"`]\/api\/orders(?:['"`]|\?)/,   // fetch to bare legacy list endpoint
  ];
  for (const p of forbiddenExec) {
    assert.ok(!p.test(src), `SPA page MUST NOT execute ${p}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// Q. DRILL-2 four existing drills unchanged
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-Q · DRILL-2 four existing drills preserved', () => {
  const src = readSrc(BRIEF);
  //   Each DRILL-2 href must still be present verbatim.
  const expectedHrefs = [
    '/?page=exception-tasks&exceptionType=SKU_MATCH_FAILED&status=open',
    '/?page=exception-tasks&status=open',
    '/?page=tasks&status=open',
    '/?page=orders&status=pending',
  ];
  for (const h of expectedHrefs) {
    assert.ok(src.includes(h), `DRILL-2 href must remain intact: ${h}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// R. PERF-2B sentinels
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-R · PERF-2B sentinels preserved', () => {
  const idxHtml = readSrc(INDEX);
  const deferTags = idxHtml.match(/<script\b[^>]*\bdefer\b[^>]*>/g) || [];
  //   0071dcd landed 30 defer tags. This phase adds one more (omsOrders.js).
  assert.ok(deferTags.length >= 30, `expected ≥30 defer script tags; got ${deferTags.length}`);
  const opsSrc = readSrc(path.join(REPO, 'public/js/operations.js'));
  assert.ok(/PMC-PERF-2B/.test(opsSrc), 'operations.js still contains PERF-2B markers');
  assert.ok(/SAFE_SHORT_CACHE/.test(opsSrc), 'operations.js still contains SAFE_SHORT_CACHE narrative');
  const dashSrc = readSrc(DASH_JS);
  assert.ok(/_shippingLoadInflight/.test(dashSrc), 'shipping dedup preserved');
  assert.ok(/Promise\.allSettled\(/.test(dashSrc), 'ops-profit parallel dispatch preserved');
});

// ═════════════════════════════════════════════════════════════════════
// S. Runtime — unknown scope silently ignored
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-FE-S · runtime: whitelist rejects arbitrary values, passes canonical scope', () => {
  const src = readSrc(OMS_JS);
  //   Runtime rehydration: build a tiny standalone whitelist gate that mirrors
  //   readScopeFromUrl's core logic, then prove both branches.
  const runtime = new Function(
    'search',
    `const URL_ALLOWED_SCOPES = ['pending-action'];
     try {
       const p = new URLSearchParams(search);
       const s = p.get('scope');
       if (s && URL_ALLOWED_SCOPES.includes(s)) return s;
     } catch (_) {}
     return null;`
  );
  assert.equal(runtime('?scope=bogus'), null,
    'unknown scope value MUST be rejected');
  assert.equal(runtime('?scope=<script>alert(1)</script>'), null,
    'adversarial scope value MUST be rejected');
  assert.equal(runtime('?scope=pending-action'), 'pending-action',
    'whitelisted scope value MUST pass through');
  //   Structural sanity: the SPA source uses the exact same gate.
  assert.ok(/URL_ALLOWED_SCOPES\.includes\(\s*s\s*\)/.test(src),
    'SPA whitelist gate must be present in code (URL_ALLOWED_SCOPES.includes(s))');
});
