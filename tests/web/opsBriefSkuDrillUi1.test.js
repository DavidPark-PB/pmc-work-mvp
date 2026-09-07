'use strict';

/**
 * tests/web/opsBriefSkuDrillUi1.test.js — OPS-BRIEF-SKU-DRILL-UI-1 (2026-09-07).
 *
 * Focused frontend routing tests for the deep-link fix. Covers:
 *   · Initial URL ?page=X parsing (pure function via vm sandbox)
 *   · Route validation (known/unknown/aliased routes)
 *   · Sidebar .active canonical sync inside navigateTo
 *   · Sidebar click handler delegates to navigateTo (single owner)
 *   · Existing exceptionFilter URL param contract unchanged
 *   · Existing opsBriefing drill destination unchanged
 *   · opportunityInbox module NOT loaded on exception-tasks route
 *   · Admin authorization guard remains in exceptionFilter (not duplicated)
 *   · Zero mutation surface added by this fix
 *
 * No jsdom dependency. Tests use Node's `vm` sandbox for pure-function
 * evaluation and file-source structural inspection for observed patterns.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const vm      = require('node:vm');

const DASHBOARD_PATH  = path.resolve(__dirname, '../../public/js/dashboard.js');
const OPSBRIEF_PATH   = path.resolve(__dirname, '../../public/js/opsBriefing.js');
const EXCFILTER_PATH  = path.resolve(__dirname, '../../public/js/exceptionFilter.js');
const INDEXHTML_PATH  = path.resolve(__dirname, '../../public/index.html');

function readSrc(p) { return fs.readFileSync(p, 'utf8'); }
function stripComments(src) {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ─────────────────────────────────────────────────────────────────────
// Extract _readInitialPage + _PLATFORM_PAGES from dashboard.js and run
// it in a real sandbox with a URL polyfill. Node has URL/URLSearchParams
// globals by default.
// ─────────────────────────────────────────────────────────────────────
function loadInitialPageFn() {
  const src = readSrc(DASHBOARD_PATH);
  //   Isolate _PLATFORM_PAGES + _readInitialPage by brace-matching from
  //   `const _PLATFORM_PAGES` down to the closing `}` of the function that
  //   follows it. This avoids extracting only a partial block.
  const startConst = src.indexOf('const _PLATFORM_PAGES = Object.freeze(');
  assert.ok(startConst > 0, 'dashboard.js must declare _PLATFORM_PAGES');
  const fnStart = src.indexOf('function _readInitialPage(', startConst);
  assert.ok(fnStart > startConst, 'dashboard.js must declare _readInitialPage');
  const fnBraceOpen = src.indexOf('{', fnStart);
  let depth = 0, fnEnd = -1;
  for (let i = fnBraceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
  }
  assert.ok(fnEnd > fnStart);
  //   Segment includes: const _PLATFORM_PAGES ...; function _readInitialPage(...) {...}
  const segment = src.slice(startConst, fnEnd + 1);
  //   Compile in a sandbox and export the fn via a wrapper.
  const script = new vm.Script(segment + '\nglobalThis.__fn = _readInitialPage;');
  const sandbox = { URLSearchParams, console };
  vm.createContext(sandbox);
  script.runInContext(sandbox);
  return sandbox.__fn;
}

const _readInitialPage = loadInitialPageFn();

// ─────────────────────────────────────────────────────────────────────
// DRILL-T1 · deep-link routes to exception-tasks
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T1 · ?page=exception-tasks routes to exception-tasks (not dashboard fallback)', () => {
  const has = (id) => id === 'page-exception-tasks';
  assert.equal(
    _readInitialPage('?page=exception-tasks&exceptionType=SKU_MATCH_FAILED&status=open', has),
    'exception-tasks',
    'URL page=exception-tasks must resolve to routable "exception-tasks" (not null)',
  );
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T2 · exceptionType + status URL params still consumed by
// deployed exceptionFilter.js first request
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T2 · exceptionFilter first fetch preserves exceptionType + status server-side', () => {
  const src = readSrc(EXCFILTER_PATH);
  //   Deployed contract from OPS-BRIEF-1A:
  //     - readUrlFilters() reads exceptionType + status from location.search
  //     - refresh() forwards them to /api/tasks server-side
  assert.ok(/URLSearchParams\(location\.search\)/.test(src),
    'exceptionFilter must parse location.search');
  assert.ok(/params\.set\(\s*['"]exceptionType['"]\s*,\s*urlExceptionType\s*\)/.test(src),
    'refresh() must send exceptionType server-side');
  assert.ok(/urlStatusOpen[\s\S]{0,120}params\.set\(\s*['"]status['"]\s*,\s*['"]open['"]\s*\)/.test(src),
    'refresh() must translate urlStatusOpen → server-side status=open');
  //   No client-only filtering substitute (defense in depth):
  //   fetch call must include the params string.
  assert.ok(/fetch\(\s*['"]\/api\/tasks\?['"]\s*\+\s*params\.toString\(\)/.test(src),
    'refresh() must send params.toString() to /api/tasks');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T3 · deep-link to exception-tasks does NOT invoke opportunity
// inbox (structural: opportunity-inbox is a distinct switch case)
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T3 · exception-tasks route MUST NOT invoke pmcOpportunityInbox', () => {
  const src = stripComments(readSrc(DASHBOARD_PATH));
  //   Isolate the `case 'exception-tasks':` block up to `break;` — must
  //   contain only pmcExceptionFilter.load(), never pmcOpportunityInbox.
  const start = src.indexOf("case 'exception-tasks':");
  assert.ok(start > 0);
  const end = src.indexOf('break;', start);
  const body = src.slice(start, end);
  assert.ok(/pmcExceptionFilter\.load\(\)/.test(body),
    'exception-tasks case must call pmcExceptionFilter.load()');
  assert.equal(/pmcOpportunityInbox/.test(body), false,
    'exception-tasks case MUST NOT reference pmcOpportunityInbox');
  //   The two switch cases are independently declared (no shared handler).
  const oiStart = src.indexOf("case 'opportunity-inbox':");
  assert.ok(oiStart > 0, 'opportunity-inbox case still exists (legitimate menu)');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T4 · sidebar sync — target menu item gets .active
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T4 · navigateTo syncs sidebar .active to the target data-page', () => {
  const src = stripComments(readSrc(DASHBOARD_PATH));
  //   Isolate navigateTo body brace-matched.
  const start = src.indexOf('function navigateTo(page)');
  assert.ok(start > 0);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(braceOpen, end + 1);
  //   Must: remove .active from ALL menu items · add to target data-page
  assert.ok(/querySelectorAll\(\s*['"]\.sidebar \.menu-item['"]\s*\)/.test(body),
    'navigateTo must query all sidebar .menu-item elements');
  assert.ok(/classList\.remove\(\s*['"]active['"]\s*\)/.test(body),
    'navigateTo must remove .active from prior sidebar item');
  assert.ok(/menu-item\[data-page=/.test(body),
    'navigateTo must target the menu-item[data-page=<page>] selector');
  assert.ok(/classList\.add\(\s*['"]active['"]\s*\)/.test(body),
    'navigateTo must add .active to the resolved menu item');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T5 · programmatic navigation updates sidebar too
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T5 · sidebar sync lives INSIDE navigateTo (single owner)', () => {
  const src = stripComments(readSrc(DASHBOARD_PATH));
  //   setupNavigation click handler MUST delegate to navigateTo, not do its
  //   own sidebar swap — that was the old two-writer bug.
  const start = src.indexOf('function setupNavigation()');
  assert.ok(start > 0);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(braceOpen, end + 1);
  assert.ok(/navigateTo\(item\.dataset\.page\)/.test(body),
    'setupNavigation click handler must delegate to navigateTo(item.dataset.page)');
  //   The old duplicate active-swap inside the click handler must be GONE.
  //   Only navigateTo should own the `.active` toggle.
  const activeSwapInClick = /classList\.remove\(\s*['"]active['"]\s*\)[\s\S]{0,200}item\.classList\.add\(\s*['"]active['"]\s*\)/;
  assert.equal(activeSwapInClick.test(body), false,
    'setupNavigation MUST NOT swap sidebar .active directly (regression fence for the two-writer bug)');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T6 · normal sidebar click still works (delegation path)
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T6 · sidebar click still triggers navigateTo with data-page', () => {
  const src = stripComments(readSrc(DASHBOARD_PATH));
  //   Delegation pattern present · addEventListener('click', ...) still fires
  //   navigateTo with item.dataset.page.
  assert.ok(
    /addEventListener\(\s*['"]click['"][\s\S]{0,80}navigateTo\(item\.dataset\.page\)/.test(src),
    'click handler must call navigateTo(item.dataset.page)',
  );
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T7 · ?page=invalid falls back to dashboard (initial page → null)
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T7 · unknown ?page= falls back safely (returns null → loadDashboard path)', () => {
  const has = (id) => id === 'page-exception-tasks' || id === 'page-opportunity-inbox';
  assert.equal(_readInitialPage('?page=totally-invalid', has), null,
    'unknown page must return null so DOMContentLoaded takes the loadDashboard branch');
  assert.equal(_readInitialPage('?page=', has), null, 'empty page value → null');
  assert.equal(_readInitialPage('', has), null, 'empty search → null');
  assert.equal(_readInitialPage('?other=1', has), null, 'no page param → null');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T8 · no page param → default dashboard startup preserved
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T8 · DOMContentLoaded default path calls loadDashboard when no ?page=', () => {
  const src = stripComments(readSrc(DASHBOARD_PATH));
  //   Structural: DOMContentLoaded handler must call loadDashboard() when
  //   _readInitialPage returns null (else branch).
  const start = src.indexOf("addEventListener('DOMContentLoaded'");
  assert.ok(start > 0);
  const braceOpen = src.indexOf('=>', start);
  const openCurly = src.indexOf('{', braceOpen);
  let depth = 0, end = -1;
  for (let i = openCurly; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(openCurly, end + 1);
  assert.ok(/_readInitialPage\s*\(/.test(body),
    'DOMContentLoaded must invoke _readInitialPage');
  assert.ok(/navigateTo\(\s*_initialPage\s*\)/.test(body),
    'DOMContentLoaded must call navigateTo(_initialPage) when non-null');
  assert.ok(/loadDashboard\(\)/.test(body),
    'DOMContentLoaded must call loadDashboard() in the else branch');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T9 · exception-tasks admin guard is NOT duplicated in dashboard.js
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T9 · admin authorization stays in exceptionFilter (not duplicated in dashboard)', () => {
  const dashSrc = stripComments(readSrc(DASHBOARD_PATH));
  //   Dashboard must NOT contain an isAdmin check tied to exception-tasks routing.
  //   Authorization must remain solely in pmcExceptionFilter.load(user.isAdmin).
  const idx = dashSrc.indexOf("case 'exception-tasks':");
  const around = dashSrc.slice(Math.max(0, idx - 200), idx + 200);
  assert.equal(/isAdmin[\s\S]{0,80}exception-tasks/.test(around), false,
    'dashboard MUST NOT duplicate admin authorization for exception-tasks');
  assert.equal(/exception-tasks[\s\S]{0,80}isAdmin/.test(around), false,
    'dashboard MUST NOT duplicate admin authorization for exception-tasks');
  //   The guard IS present in exceptionFilter.
  const excSrc = readSrc(EXCFILTER_PATH);
  assert.ok(/user\.isAdmin/.test(excSrc),
    'exceptionFilter.js must retain user.isAdmin guard');
  assert.ok(/관리자 전용 페이지입니다/.test(excSrc),
    'exceptionFilter.js must retain admin-only fallback message');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T10 · opening the drill route performs zero mutation requests
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T10 · exception route opening path has zero mutation surface', () => {
  const dashSrc = readSrc(DASHBOARD_PATH);
  const excSrc  = readSrc(EXCFILTER_PATH);
  //   dashboard.js has no fetch that mutates; verify no non-GET method appears
  //   in the DOMContentLoaded/navigateTo/setupNavigation region.
  const start = dashSrc.indexOf("addEventListener('DOMContentLoaded'");
  const end   = dashSrc.indexOf('// ===== 상품 동기화 =====');
  const region = dashSrc.slice(start, end > 0 ? end : start + 5000);
  assert.equal(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(region), false,
    'DOMContentLoaded + routing region MUST NOT issue non-GET requests');
  //   exceptionFilter still has exactly 1 PATCH call (existing 완료 처리) —
  //   opening the page does NOT invoke it (that's a user-triggered button).
  const patchCount = (excSrc.match(/method:\s*['"]PATCH['"]/g) || []).length;
  assert.equal(patchCount, 1, 'exceptionFilter should still have exactly 1 PATCH (existing 완료 처리)');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T11 · opsBriefing SKU drill destination + params unchanged
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T11 · OPS-BRIEF SKU drill target UNCHANGED (page + params + href)', () => {
  const src = readSrc(OPSBRIEF_PATH);
  assert.ok(/page:\s*['"]exception-tasks['"]/.test(src),
    'skuDrill.page must remain exception-tasks');
  assert.ok(/params:\s*['"]exceptionType=SKU_MATCH_FAILED&status=open['"]/.test(src),
    'skuDrill.params must remain exceptionType=SKU_MATCH_FAILED&status=open');
  assert.ok(/href:\s*['"][^'"]*page=exception-tasks[^'"]*exceptionType=SKU_MATCH_FAILED[^'"]*status=open['"]/.test(src),
    'skuDrill.href must remain the deep-link URL');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T12 · N>0 renders visible rows (renderList exists + iterates cards)
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T12 · exceptionFilter renderList iterates card set → visible rows', () => {
  const src = stripComments(readSrc(EXCFILTER_PATH));
  //   renderList maps over `cards` array and appends per-card HTML.
  assert.ok(/function\s+renderList\s*\(\s*\)/.test(src));
  assert.ok(/cards\.map\(/.test(src) || /cards\.forEach\(/.test(src),
    'renderList must iterate cards[] to render');
  //   Empty state has an explicit message so N=0 doesn't look like a bug.
  assert.ok(/자동 예외 카드가 없습니다/.test(src),
    'renderList must show explicit empty-state message for zero results');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T13 · opportunity_inbox cannot be reached via exception-tasks route
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T13 · exception-tasks route does NOT load pmcOpportunityInbox (no cross-pollination)', () => {
  const src = stripComments(readSrc(DASHBOARD_PATH));
  const excStart = src.indexOf("case 'exception-tasks':");
  const excEnd   = src.indexOf('break;', excStart);
  const excCase  = src.slice(excStart, excEnd);
  assert.equal(/pmcOpportunityInbox/.test(excCase), false,
    'exception-tasks case MUST NOT reference pmcOpportunityInbox');
  assert.equal(/opportunity-inbox/.test(excCase), false,
    'exception-tasks case MUST NOT reference opportunity-inbox');
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T14 · every sidebar data-page value has a routable target
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T14 · every sidebar data-page resolves through _readInitialPage or documented alias', () => {
  const html = readSrc(INDEXHTML_PATH);
  const pages = new Set();
  const re = /\bdata-page=(?:"|')([a-z0-9-]+)(?:"|')/g;
  let m;
  while ((m = re.exec(html)) !== null) pages.add(m[1]);
  assert.ok(pages.size >= 10, 'sanity: at least 10 sidebar data-page values discovered');

  //   For each page, verify either _readInitialPage returns it OR it's an
  //   aliased/platform route documented in the platform list.
  const has = (id) => {
    //   Simulate DOM: page-<X> present for every #page-<X> div in the HTML.
    const domIds = new Set();
    const idRe = /id=(?:"|')(page-[a-z0-9-]+)(?:"|')/g;
    let n;
    while ((n = idRe.exec(html)) !== null) domIds.add(n[1]);
    return domIds.has(id);
  };
  const unresolved = [];
  for (const p of pages) {
    const r = _readInitialPage(`?page=${p}`, has);
    if (r === null && p !== 'dashboard') unresolved.push(p);
  }
  assert.deepEqual(unresolved, [],
    `every sidebar data-page must resolve; unresolved: ${unresolved.join(',')}`);
});

// ─────────────────────────────────────────────────────────────────────
// DRILL-T15 · invalid page cannot select DOM outside registered surface
// ─────────────────────────────────────────────────────────────────────

test('DRILL-T15 · invalid ?page= cannot escape the registered #page-<X> surface', () => {
  //   Adversarial inputs: any docHas() calls MUST be prefixed with `page-`.
  //   The validator never queries a bare user-controlled id.
  const observed = [];
  const has = (id) => { observed.push(id); return false; };
  const inputs = [
    'body', 'html', 'sidebar', 'notifDropdown', 'password-modal',
    '../etc/passwd', '<script>', 'javascript:', 'data:text/html;base64,X',
    'exception-tasks; drop table', 'exception-tasks%00', '__proto__',
  ];
  for (const p of inputs) {
    const r = _readInitialPage(`?page=${encodeURIComponent(p)}`, has);
    assert.equal(r, null, `invalid page ${JSON.stringify(p)} must resolve to null`);
  }
  //   Every DOM lookup performed by _readInitialPage carries the page- prefix.
  for (const id of observed) {
    assert.ok(id.startsWith('page-'),
      `_readInitialPage must only query 'page-<X>' ids; observed unsafe id: ${id}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// Additional pure-function coverage
// ─────────────────────────────────────────────────────────────────────

test('EDGE · dashboard explicit value returns null (preserves untouched startup)', () => {
  assert.equal(_readInitialPage('?page=dashboard', () => true), null);
});

test('EDGE · platform pages resolve without needing #page-<platform> in DOM', () => {
  //   No page-shopify div exists — the router aliases these to #page-products
  //   inside navigateTo. _readInitialPage returns them regardless of DOM.
  const has = () => false;
  assert.equal(_readInitialPage('?page=shopify', has), 'shopify');
  assert.equal(_readInitialPage('?page=ebay',    has), 'ebay');
  assert.equal(_readInitialPage('?page=naver',   has), 'naver');
  assert.equal(_readInitialPage('?page=alibaba', has), 'alibaba');
  assert.equal(_readInitialPage('?page=shopee',  has), 'shopee');
});

test('EDGE · orders alias returns "orders" (navigateTo redirects internally)', () => {
  assert.equal(_readInitialPage('?page=orders', () => false), 'orders');
});

test('EDGE · non-string / undefined / malformed search returns null (no throw)', () => {
  assert.equal(_readInitialPage(undefined, () => false), null);
  assert.equal(_readInitialPage(null,      () => false), null);
  //   Malformed but survivable: URLSearchParams tolerates unusual input.
  assert.equal(_readInitialPage('?%',      () => false), null);
});
