'use strict';

/**
 * tests/services/omsOrdersListPendingAction.test.js — PMC-OMS-CONSOLE-1B (2026-09-12).
 *
 * Proves the canonical READ-ONLY pending-action orders API contract:
 *
 *   A. Route file is GET-only (no POST/PATCH/DELETE handlers introduced)
 *   B. PENDING_ACTION_STATUSES SoT is imported from omsBriefingCounts —
 *      never redeclared inside the route or the repository
 *   C. Default limit=50 / max limit=200 / offset clamp
 *   D. Repository query pattern: .in('order_status', statuses) +
 *      .order('ordered_at', {ascending:false}) + .range()
 *   E. Exact total returned alongside rows
 *   F. DB failure surfaces as {ok:false, error:...} — never {ok:true, total:0, rows:[]}
 *   G. Repository never falls back to wms_orders
 *   H. V1 field allowlist excludes buyer_email / buyer_phone / ship_street / etc.
 *   I. Router is admin-gated (requireAdmin)
 *   J. No POST/PATCH/DELETE route added
 *   K. Route mounted at /api/oms/orders in server.js
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO         = path.resolve(__dirname, '../..');
const ROUTE_JS     = path.join(REPO, 'src/web/routes/omsOrders.js');
const REPO_JS      = path.join(REPO, 'src/services/oms/omsOrderRepository.js');
const BRIEF_JS     = path.join(REPO, 'src/services/oms/omsBriefingCounts.js');
const SERVER_JS    = path.join(REPO, 'server.js');

const readSrc = (p) => fs.readFileSync(p, 'utf8');

// ═════════════════════════════════════════════════════════════════════
// A. Route surface — GET only
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-A · route file registers only GET handlers (no write verbs)', () => {
  const src = readSrc(ROUTE_JS);
  //   Anchor on `router.<verb>(...)` patterns.
  const gets    = (src.match(/router\.get\s*\(/g)    || []).length;
  const posts   = (src.match(/router\.post\s*\(/g)   || []).length;
  const patches = (src.match(/router\.patch\s*\(/g)  || []).length;
  const deletes = (src.match(/router\.delete\s*\(/g) || []).length;
  const puts    = (src.match(/router\.put\s*\(/g)    || []).length;
  assert.ok(gets >= 1, 'must register at least one GET handler');
  assert.equal(posts, 0,   'route file MUST NOT introduce POST handlers');
  assert.equal(patches, 0, 'route file MUST NOT introduce PATCH handlers');
  assert.equal(deletes, 0, 'route file MUST NOT introduce DELETE handlers');
  assert.equal(puts, 0,    'route file MUST NOT introduce PUT handlers');
});

// ═════════════════════════════════════════════════════════════════════
// B. SoT — one and only one PENDING_ACTION_STATUSES declaration in the repo
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-B · PENDING_ACTION_STATUSES is imported from omsBriefingCounts, never redeclared', () => {
  const routeSrc = readSrc(ROUTE_JS);
  const repoSrc  = readSrc(REPO_JS);
  const briefSrc = readSrc(BRIEF_JS);

  //   Route must import from the SoT module.
  assert.ok(
    /PENDING_ACTION_STATUSES\s*\}\s*=\s*require\s*\(\s*['"]\.\.\/\.\.\/services\/oms\/omsBriefingCounts['"]\s*\)/.test(routeSrc),
    'route MUST import PENDING_ACTION_STATUSES from src/services/oms/omsBriefingCounts',
  );
  //   Route must NOT redeclare the array.
  assert.ok(
    !/const\s+PENDING_ACTION_STATUSES\s*=/.test(routeSrc),
    'route MUST NOT redeclare the PENDING_ACTION_STATUSES array',
  );
  //   Repository must NOT redeclare it either.
  assert.ok(
    !/const\s+PENDING_ACTION_STATUSES\s*=/.test(repoSrc),
    'repository MUST NOT redeclare PENDING_ACTION_STATUSES — caller passes the array',
  );
  //   Repository must accept a `statuses` parameter (never hardcoded).
  assert.ok(
    /function\s+listOrders\s*\(\s*\{\s*statuses/.test(repoSrc),
    'repository listOrders must accept a `statuses` parameter (SoT lives outside)',
  );
  //   Only one canonical declaration exists — in the briefing module.
  const briefDecls = (briefSrc.match(/const\s+PENDING_ACTION_STATUSES\s*=/g) || []).length;
  assert.equal(briefDecls, 1,
    'exactly one PENDING_ACTION_STATUSES declaration must exist (in omsBriefingCounts.js)');
});

// ═════════════════════════════════════════════════════════════════════
// C. Limit/offset clamping
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-C · route clamps limit to [1, 200] with default 50 and offset ≥ 0', () => {
  const src = readSrc(ROUTE_JS);
  assert.ok(/clampInt\(\s*req\.query\.limit\s*,\s*50\s*,\s*1\s*,\s*200\s*\)/.test(src),
    'limit must clamp to default 50, min 1, max 200');
  assert.ok(/clampInt\(\s*req\.query\.offset\s*,\s*0\s*,\s*0\s*/.test(src),
    'offset must clamp to default 0, min 0');
});

// ═════════════════════════════════════════════════════════════════════
// D. Repository query pattern
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-D · repository listOrders queries oms_orders with correct predicate', () => {
  const src = readSrc(REPO_JS);
  //   Query must hit oms_orders (never wms_orders).
  assert.ok(/from\(\s*['"]oms_orders['"]\s*\)/.test(src),
    'listOrders must query oms_orders');
  //   Row query pattern: .in('order_status', statuses).order('ordered_at', descending).range(...)
  assert.ok(/\.in\(\s*['"]order_status['"]\s*,\s*statuses\.slice\(\)\s*\)/.test(src),
    'listOrders must .in(order_status, statuses)');
  assert.ok(/\.order\(\s*['"]ordered_at['"]\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/.test(src),
    'listOrders must .order(ordered_at, descending)');
  assert.ok(/\.range\(\s*offset\s*,\s*offset\s*\+\s*limit\s*-\s*1\s*\)/.test(src),
    'listOrders must use server-side .range(offset, offset+limit-1)');
});

// ═════════════════════════════════════════════════════════════════════
// E. Total returned alongside rows (same predicate)
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-E · repository returns { total, rows } where total is a HEAD count on the same predicate', () => {
  const src = readSrc(REPO_JS);
  //   Count query pattern: .select('id', { count:'exact', head:true }).in('order_status', statuses)
  assert.ok(/count:\s*['"]exact['"]\s*,\s*head:\s*true/.test(src),
    'listOrders must issue an exact HEAD count');
  //   Count and row queries must both use the same `statuses` array (SoT).
  const inStatusCalls = (src.match(/\.in\(\s*['"]order_status['"]\s*,\s*statuses\.slice\(\)\s*\)/g) || []).length;
  assert.ok(inStatusCalls >= 2,
    'both count and row queries must call .in(order_status, statuses) — same predicate');
  //   Return shape.
  assert.ok(/return\s*\{[\s\S]{0,200}total[\s\S]{0,100}rows[\s\S]{0,100}\}/.test(src),
    'listOrders must return {total, rows}');
});

// ═════════════════════════════════════════════════════════════════════
// F. Failure surfaces as {ok:false}, never fake {ok:true, total:0}
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-F · route error path returns {ok:false} — never fake {ok:true, total:0}', () => {
  const src = readSrc(ROUTE_JS);
  const catchBlock = /catch\s*\([^)]+\)\s*\{[\s\S]*?\n\s*\}\s*\)\s*;/m.exec(src);
  assert.ok(catchBlock, 'route must have a catch block');
  //   Explicit failure envelope with ok:false.
  assert.ok(/ok:\s*false/.test(catchBlock[0]),
    'error path must return {ok:false, ...}');
  //   Must NOT fabricate a successful zero response.
  assert.ok(!/ok:\s*true[\s\S]{0,200}total:\s*0/.test(catchBlock[0]),
    'error path MUST NOT return {ok:true, total:0}');
  //   Non-2xx status code.
  assert.ok(/res\.status\(\s*5\d{2}\s*\)/.test(catchBlock[0]),
    'error path must send a 5xx status');
});

test('OMS1B-F2 · repository throw propagates — no silent fallback to []', () => {
  const src = readSrc(REPO_JS);
  //   Both count and row queries must `throw` on error, never coalesce.
  const throws = (src.match(/if\s*\(\s*[a-zA-Z]+\.error\s*\)\s*throw/g) || []).length;
  assert.ok(throws >= 2,
    'listOrders count + row queries must both throw on .error (UNKNOWN ≠ ZERO)');
});

// ═════════════════════════════════════════════════════════════════════
// G. No wms_orders fallback anywhere in the OMS console surface
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-G · new OMS console files never CALL wms_orders / wmsOrderRepository (comments OK)', () => {
  //   The fence is against RUNTIME dependencies — the docstring may (and does)
  //   reference "wms_orders" as a fence rationale ("No wms_orders fallback."),
  //   which is a feature, not a leak. Test only executable code shapes:
  //     · .from('wms_orders')     — legacy table query
  //     · require(...wms...)      — legacy repo import
  //     · fetch('/api/orders')    — legacy list endpoint (not '/api/orders/...' — that's the sync-recent shipping path)
  const forbiddenExecPatterns = [
    /\.from\(\s*['"]wms_orders['"]\s*\)/,           // legacy table query
    /require\s*\(\s*['"][^'"]*wmsOrder[^'"]*['"]\s*\)/,  // legacy repo import
    /fetch\s*\(\s*['"]\/api\/orders(?:\?|\s*,|\s*\))/,   // legacy list endpoint (bare)
  ];
  const routeSrc = readSrc(ROUTE_JS);
  for (const p of forbiddenExecPatterns) {
    assert.ok(!p.test(routeSrc),
      `omsOrders.js route MUST NOT execute ${p} (legacy wms surface)`);
  }
  //   Repository — new listOrders block must not import/query wms.
  const repoSrc = readSrc(REPO_JS);
  const block = /async function listOrders[\s\S]+?^}/m.exec(repoSrc);
  assert.ok(block, 'listOrders function must exist in repo');
  for (const p of forbiddenExecPatterns) {
    assert.ok(!p.test(block[0]),
      `listOrders body MUST NOT execute ${p}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// H. V1 field allowlist — no PII leaked in list response
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-H · repository projects only V1 fields — no buyer PII / no shipping address', () => {
  const src = readSrc(REPO_JS);
  const fieldsMatch = /LIST_ORDER_FIELDS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(fieldsMatch, 'LIST_ORDER_FIELDS constant must exist and be inspectable');
  const listed = fieldsMatch[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  const allowed = new Set([
    'id', 'channel', 'external_order_id', 'external_order_number',
    'order_status', 'hold_reason', 'ship_country_code', 'currency', 'total', 'ordered_at',
  ]);
  for (const f of listed) {
    assert.ok(allowed.has(f), `V1 field ${f} not in allowlist — potential PII creep`);
  }
  //   Forbidden fields must NOT appear.
  const forbidden = ['buyer_email', 'buyer_phone', 'buyer_name', 'ship_street1', 'ship_street2',
                     'ship_postal_code', 'ship_phone', 'raw_payload'];
  for (const f of forbidden) {
    assert.ok(!listed.includes(f), `field ${f} MUST NOT appear in V1 list projection`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// I. Router is admin-gated
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-I · route requires admin (owner-only)', () => {
  const src = readSrc(ROUTE_JS);
  assert.ok(/router\.use\(\s*requireAdmin\s*\)/.test(src),
    'route file must apply requireAdmin at router-level');
});

// ═════════════════════════════════════════════════════════════════════
// J. Server mount + no route duplication
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-J · server.js mounts new route at /api/oms/orders', () => {
  const src = readSrc(SERVER_JS);
  assert.ok(
    /app\.use\(\s*['"]\/api\/oms\/orders['"]\s*,\s*require\(\s*['"]\.\/src\/web\/routes\/omsOrders['"]\s*\)\s*\)/.test(src),
    'server.js must mount omsOrders at /api/oms/orders',
  );
});

// ═════════════════════════════════════════════════════════════════════
// K. Runtime shape — listOrders returns {total, rows} when called with a stubbed client
// ═════════════════════════════════════════════════════════════════════

test('OMS1B-K · listOrders runtime: {total, rows} shape with stubbed supabase', async () => {
  //   Stub supabaseClient before requiring the repo.
  const stubClient = {
    from(_table) {
      let mode = null;
      const chain = {
        select(_cols, opts) {
          if (opts && opts.head) mode = 'count';
          return chain;
        },
        in(_c, _v)         { return chain; },
        order(_c, _o)      { return chain; },
        range(_a, _b)      {
          //   Row branch resolves as a thenable — supabase-js returns { data, error }
          return Promise.resolve({ data: [{ id: 1, channel: 'ebay', order_status: 'new' }], error: null });
        },
      };
      //   `count` HEAD path — .in().select() returns promise-like directly.
      //   Actual supabase awaits after .in(). We fake that by making .in() awaitable when in count mode.
      const originalIn = chain.in;
      chain.in = (col, val) => {
        const c = originalIn(col, val);
        if (mode === 'count') {
          return Promise.resolve({ count: 3, error: null });
        }
        return c;
      };
      return chain;
    },
  };
  //   Purge cache and inject stub.
  const supPath = require.resolve(path.join(REPO, 'src/db/supabaseClient'));
  const repoPath = require.resolve(REPO_JS);
  delete require.cache[supPath];
  delete require.cache[repoPath];
  require.cache[supPath] = { id: supPath, filename: supPath, loaded: true, exports: { getClient: () => stubClient } };
  const repo = require(REPO_JS);
  const result = await repo.listOrders({ statuses: ['new'], limit: 50, offset: 0 });
  assert.equal(typeof result, 'object');
  assert.equal(result.total, 3, 'total must come from HEAD count');
  assert.ok(Array.isArray(result.rows), 'rows must be an array');
  assert.equal(result.rows.length, 1, 'rows length reflects range result');
  //   Cleanup so subsequent tests get a fresh module.
  delete require.cache[supPath];
  delete require.cache[repoPath];
});

test('OMS1B-K2 · listOrders throws when statuses is empty (never queries all orders)', async () => {
  const repo = require(REPO_JS);
  await assert.rejects(
    () => repo.listOrders({ statuses: [], limit: 50, offset: 0 }),
    /non-empty statuses/,
  );
  await assert.rejects(
    () => repo.listOrders({ statuses: null }),
    /non-empty statuses/,
  );
});
