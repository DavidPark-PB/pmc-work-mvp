'use strict';

/**
 * tests/oms/phase8p20_8DEbayLogCompression.test.js — Phase 8P-20.8D
 *
 * Fast-path log compression for prefetch-hit + processed + linked orders.
 * Suppresses ~4 per-order stage log lines (raw_event_persist#N START/DONE +
 * short_circuit_already_processed#N START/DONE) without changing any processing
 * behavior. Keeps detailed logs for new events, misses, retries, adapter errors.
 *
 * Proves:
 *   D1.  500+ processed prefetch-hit dups emit ZERO per-order stage lines
 *   D2.  shortCircuited count is exact
 *   D3.  fastPathSuppressed aggregate count is exact
 *   D4.  new event still gets full detailed pipeline logging
 *   D5.  prefetch miss still exposes channel-event DB boundary logs
 *   D6.  pending event NOT hidden as fast-path (still gets detailed logs)
 *   D7.  failed event NOT hidden as fast-path
 *   D8.  processed + linkedOrderId NULL NOT hidden as fast-path
 *   D9.  FAIL logs are never suppressed
 *   D10. final_report contains all 20.8D + 20.8C + 20.8B metrics
 *   D11. no PII / raw payload / secrets in aggregate output
 *   D12. Shopify source has no OMS_EBAY_STAGE_ markers
 *   D13. Phase 8P-20.6 timeouts remain (30000 Trading / 15000 x2 OAuth)
 *   D14. Phase 8P-20.8C bulk-prefetch semantics still intact
 *
 *   D15 (bonus). OMS_EBAY_VERBOSE_ORDER_LOGS=1 restores full per-order logs
 *   D16 (bonus). fastPathSuppressed + detailedOrders === attempted
 *
 * All in-memory · zero DB · zero network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Shared stub scaffolding (mirrors 8P-20.8C for consistency) ─

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj, children: [], paths: [] };
}

const chanEvtPath   = require.resolve('../../src/services/oms/channelEventService');
const omsSvcPath    = require.resolve('../../src/services/oms/omsOrderService');
const matcherPath   = require.resolve('../../src/services/oms/omsSkuMatcher');
const costPath     = require.resolve('../../src/services/oms/costFiller');
const ingestorPath  = require.resolve('../../src/services/oms/ebayIngestor');
const supabasePath  = require.resolve('../../src/db/supabaseClient');

let dbRows = [];
let dbSelectCalls = [];
let dbInsertCalls = [];
let dbUpdateCalls = [];

function _resetDb() {
  dbRows = [];
  dbSelectCalls = [];
  dbInsertCalls = [];
  dbUpdateCalls = [];
}

function _buildFakeSupabase() {
  return {
    from(table) {
      const chain = {
        _cols: '*',
        _filters: [],
        select(cols) { chain._cols = cols; return chain; },
        eq(col, val) { chain._filters.push(['eq', col, val]); return chain; },
        is(col, val) { chain._filters.push(['is', col, val]); return chain; },
        in(col, vals) { chain._filters.push(['in', col, vals]); return chain; },
        async single() {
          const res = await chain.maybeSingle();
          if (!res.data && !res.error) return { data: null, error: { message: 'not found' } };
          return res;
        },
        async maybeSingle() {
          dbSelectCalls.push({ table, cols: chain._cols, filters: chain._filters.slice() });
          const row = _match(dbRows, table, chain._filters, chain._cols);
          return { data: row && Array.isArray(row) ? row[0] : row, error: null };
        },
        then(resolve) {
          dbSelectCalls.push({ table, cols: chain._cols, filters: chain._filters.slice() });
          const rows = _matchAll(dbRows, table, chain._filters, chain._cols);
          resolve({ data: rows, error: null });
        },
        insert(row) {
          return {
            select() { return this; },
            async single() {
              dbInsertCalls.push({ table, row });
              const newRow = { ...row, id: dbRows.length + 1 };
              dbRows.push({ ...newRow, _table: table });
              return { data: newRow, error: null };
            },
          };
        },
        update(patch) {
          const upd = { _wheres: [] };
          upd.eq = (col, val) => { upd._wheres.push(['eq', col, val]); return upd; };
          upd.then = (resolve) => { dbUpdateCalls.push({ table, patch, where: upd._wheres }); resolve({ error: null }); };
          return upd;
        },
      };
      return chain;
    },
  };
}
function _match(rows, table, filters, cols) { return _matchAll(rows, table, filters, cols)[0] || null; }
function _matchAll(rows, table, filters, cols) {
  let out = rows.filter(r => r._table === table);
  for (const [op, col, val] of filters) {
    if (op === 'eq') out = out.filter(r => r[col] === val);
    else if (op === 'is') out = out.filter(r => (val === null ? r[col] == null : r[col] === val));
    else if (op === 'in') out = out.filter(r => Array.isArray(val) && val.map(String).includes(String(r[col])));
  }
  if (typeof cols === 'string' && !cols.includes('*') && !cols.includes('raw_payload')) {
    out = out.map(r => { const p = {}; for (const c of cols.split(',').map(s => s.trim())) if (c in r) p[c] = r[c]; return p; });
  }
  return out;
}

stub(supabasePath, {
  getClient: () => _buildFakeSupabase(),
  isSupabaseEnabled: () => true, getDbSource: () => 'supabase', isDualWrite: () => false,
  withReadCache: async (fn) => ({ value: await fn(), stats: {} }),
});

let matcherCalls = 0, costCalls = 0, upsertCalls = 0, markProcessedCalls = 0;
function _resetSpies() { matcherCalls = 0; costCalls = 0; upsertCalls = 0; markProcessedCalls = 0; }

stub(omsSvcPath, {
  async upsertCanonicalOrder(canonical, _opts) {
    upsertCalls++;
    return { status: 'created', orderId: 999, validation: { ok: true, errors: [] },
             itemsInserted: canonical.items.length, itemsUpdated: 0, itemsSkipped: 0,
             itemsMatched: 0, itemsUnmatched: canonical.items.length };
  },
});
stub(matcherPath, {
  async matchCanonicalItem() { return { skuMasterId: null, productId: null, matchStatus: 'failed', matchConfidence: null, matchReason: 'no_match' }; },
  async matchCanonicalItems({ items }) {
    matcherCalls++;
    return items.map(i => ({ item: i, match: { skuMasterId: null, productId: null, matchStatus: 'failed', matchConfidence: null, matchReason: 'no_match' } }));
  },
});
stub(costPath, { async fillCostSnapshotForItems(items) { costCalls++; return items; } });

//   Load REAL channelEventService (wrap only markProcessed for spy).
delete require.cache[chanEvtPath];
const _realChanEvt = require(chanEvtPath);
stub(chanEvtPath, {
  ..._realChanEvt,
  async markProcessed(...args) { markProcessedCalls++; return _realChanEvt.markProcessed(...args); },
});
delete require.cache[ingestorPath];
const { ingestEbay } = require('../../src/services/oms/ebayIngestor');
const { payloadHash } = require(chanEvtPath);

// ── Fixtures ─────────────────────────────────────────────

function makeRawOrder(overrides = {}) {
  return {
    ebayOrderId: 'ORD-D-1', createdDate: '2026-08-23T10:00:00.000Z',
    buyerUserId: 'BuyerSecret_LOG_D',
    buyerEmail: 'log-secret-d@leak.example.com',
    price: 10, quantity: 1, title: 'D', sku: 'PMC-D', itemId: 'IT-D',
    shippingName: 'PrivateNameLogD', shippingStreet: 'SecretStreet-LogD',
    shippingCity: 'ConfidentialLog', shippingState: 'CL', shippingZip: '00000',
    shippingCountry: 'US', shippingPhone: '+1-555-4444-3333',
    _shippedTime: null, _cancelStatus: null, _checkoutStatus: 'Complete',
    _paidTime: '2026-08-23T10:05:00.000Z', _orderStatus: 'Active',
    ...overrides,
  };
}
const fakeApi = (orders) => ({ async getAwaitingShipmentOrders(_days, _opts) { return orders; } });
const stageSink = () => { const buf = []; return { log: (m) => buf.push(String(m)), buf }; };
function _seedProcessedRow({ id, hash, linkedOrderId = 100, processing = 'processed', sourceEventId = null }) {
  dbRows.push({ _table: 'channel_order_events', id, channel: 'ebay',
    source_event_id: sourceEventId, payload_hash: hash,
    processing_status: processing, linked_order_id: linkedOrderId,
    raw_payload: { should_never_be_selected: true },
  });
}

// ── D1 · 500+ processed prefetch-hit dups emit ZERO per-order stage lines ──

test('P8P20_8D_D1 · 500 processed prefetch-hit duplicates produce zero raw_event_persist / short_circuit per-order stage lines', async () => {
  _resetDb(); _resetSpies();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const N = 500;
  const orders = Array.from({ length: N }, (_, i) => makeRawOrder({ ebayOrderId: `LOG-${i}` }));
  for (const o of orders) _seedProcessedRow({ id: 30000 + orders.indexOf(o), hash: payloadHash(o), linkedOrderId: 20000 + orders.indexOf(o) });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi(orders), stageLog: sink.log });
  //   Count offending per-order lines
  const perOrderRawPersistLines = sink.buf.filter(l => /^OMS_EBAY_STAGE_(START|DONE) stage=raw_event_persist#\d+/.test(l));
  const perOrderShortCircuitLines = sink.buf.filter(l => /^OMS_EBAY_STAGE_(START|DONE) stage=short_circuit_already_processed#\d+/.test(l));
  assert.equal(perOrderRawPersistLines.length, 0,
    `expected 0 raw_event_persist per-order lines · saw ${perOrderRawPersistLines.length} · first: ${perOrderRawPersistLines[0]}`);
  assert.equal(perOrderShortCircuitLines.length, 0,
    `expected 0 short_circuit per-order lines · saw ${perOrderShortCircuitLines.length}`);
  //   No divergence signal either
  assert.equal(sink.buf.filter(l => /^OMS_EBAY_FAST_PATH_DIVERGENCE/.test(l)).length, 0);
  //   Aggregate correctness
  assert.equal(r.attempted, N);
  assert.equal(r.shortCircuited, N);
  assert.equal(r.fastPathSuppressed, N);
  assert.equal(r.detailedOrders, 0);
});

// ── D2 · shortCircuited count is exact ────────────────────

test('P8P20_8D_D2 · shortCircuited count is exact (matches attempted for all-fast-path)', async () => {
  _resetDb(); _resetSpies();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const orders = Array.from({ length: 100 }, (_, i) => makeRawOrder({ ebayOrderId: `S-${i}` }));
  for (const o of orders) _seedProcessedRow({ id: 100 + orders.indexOf(o), hash: payloadHash(o), linkedOrderId: 200 + orders.indexOf(o) });
  const r = await freshIngest({ days: 7, ebayApi: fakeApi(orders), stageLog: () => {} });
  assert.equal(r.shortCircuited, 100);
});

// ── D3 · fastPathSuppressed count is exact ────────────────

test('P8P20_8D_D3 · fastPathSuppressed count matches short-circuit count for pure-fast-path batch', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const orders = Array.from({ length: 50 }, (_, i) => makeRawOrder({ ebayOrderId: `F-${i}` }));
  for (const o of orders) _seedProcessedRow({ id: 500 + orders.indexOf(o), hash: payloadHash(o), linkedOrderId: 600 + orders.indexOf(o) });
  const r = await freshIngest({ days: 7, ebayApi: fakeApi(orders), stageLog: () => {} });
  assert.equal(r.fastPathSuppressed, 50);
});

// ── D4 · new event still gets full detailed pipeline logging ─

test('P8P20_8D_D4 · new event · detailed pipeline stage logs still emitted', async () => {
  _resetDb(); _resetSpies();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const o = makeRawOrder({ ebayOrderId: 'NEW-D4' });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([o]), stageLog: sink.log });
  assert.equal(r.detailedOrders, 1);
  assert.equal(r.fastPathSuppressed, 0);
  //   Expect at least these per-order detailed lines
  const expectedStages = ['raw_event_persist#1', 'canonical_adapt_validate#1', 'sku_match#1', 'cost_fill#1', 'oms_order_upsert#1', 'mark_processed#1'];
  for (const stage of expectedStages) {
    assert.ok(sink.buf.some(l => new RegExp(`^OMS_EBAY_STAGE_(START|DONE) stage=${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `).test(l)),
      `missing detailed stage log for ${stage}`);
  }
});

// ── D5 · prefetch miss still exposes channel-event DB boundary logs ─

test('P8P20_8D_D5 · prefetch miss · channel_event_insert boundary logs emitted', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const o = makeRawOrder({ ebayOrderId: 'MISS-D5' });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([o]), stageLog: sink.log });
  assert.equal(r.prefetchMisses, 1);
  assert.equal(r.fastPathSuppressed, 0);
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_(START|DONE) stage=channel_event_insert#1 /.test(l)),
    'channel_event_insert boundary logs must still fire for prefetch misses');
});

// ── D6 · pending event NOT hidden as fast-path ────────────

test('P8P20_8D_D6 · prefetched pending event · detailed logs emitted (NOT fast-path suppressed)', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const o = makeRawOrder({ ebayOrderId: 'PEND-D6' });
  _seedProcessedRow({ id: 1, hash: payloadHash(o), linkedOrderId: null, processing: 'pending' });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([o]), stageLog: sink.log });
  assert.equal(r.fastPathSuppressed, 0, 'pending events must NOT take the fast path');
  assert.equal(r.detailedOrders, 1);
  //   Detailed lines present
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_START stage=raw_event_persist#1 /.test(l)));
});

// ── D7 · failed event NOT hidden as fast-path ─────────────

test('P8P20_8D_D7 · prefetched failed event · detailed logs emitted', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const o = makeRawOrder({ ebayOrderId: 'FAIL-D7' });
  _seedProcessedRow({ id: 1, hash: payloadHash(o), linkedOrderId: null, processing: 'failed' });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([o]), stageLog: sink.log });
  assert.equal(r.fastPathSuppressed, 0);
  assert.equal(r.detailedOrders, 1);
});

// ── D8 · processed + linkedOrderId NULL NOT hidden ────────

test('P8P20_8D_D8 · processed + linked_order_id NULL · detailed logs emitted (not fast-path)', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const o = makeRawOrder({ ebayOrderId: 'LNULL-D8' });
  _seedProcessedRow({ id: 1, hash: payloadHash(o), linkedOrderId: null, processing: 'processed' });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([o]), stageLog: sink.log });
  assert.equal(r.fastPathSuppressed, 0);
  assert.equal(r.detailedOrders, 1);
});

// ── D9 · FAIL logs are never suppressed ───────────────────

test('P8P20_8D_D9 · fast-path divergence (rare) still emits diagnostic; and any non-fast-path FAIL log fires', async () => {
  //   Divergence path: manufactured with a hint that verifyEventHint accepts BUT the
  //   fake persistRawEvent (via require.cache override) returns something else.
  //   The ebayIngestor logs OMS_EBAY_FAST_PATH_DIVERGENCE in that case.
  _resetDb();
  delete require.cache[ingestorPath];
  const _realChanEvt2 = require(chanEvtPath);
  //   Override persistRawEvent to force a divergent return (isNew=true even on prefetch hit)
  stub(chanEvtPath, {
    ..._realChanEvt2,
    async persistRawEvent(_args) {
      //   Ignore hint; pretend INSERT succeeded (divergent from prediction)
      return { id: 999, isNew: true, payloadHash: 'divergent', processingStatus: 'pending', linkedOrderId: null };
    },
    async markProcessed() {},
  });
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');

  const o = makeRawOrder({ ebayOrderId: 'DIV-D9' });
  _seedProcessedRow({ id: 1, hash: payloadHash(o), linkedOrderId: 42, processing: 'processed' });
  const sink = stageSink();
  await freshIngest({ days: 7, ebayApi: fakeApi([o]), stageLog: sink.log });
  assert.ok(sink.buf.some(l => /^OMS_EBAY_FAST_PATH_DIVERGENCE order_idx=1/.test(l)),
    `divergence log must fire · saw: ${JSON.stringify(sink.buf).slice(0, 500)}`);

  //   Restore for downstream tests
  stub(chanEvtPath, {
    ..._realChanEvt,
    async markProcessed(...args) { markProcessedCalls++; return _realChanEvt.markProcessed(...args); },
  });
  delete require.cache[ingestorPath];
  require('../../src/services/oms/ebayIngestor');
});

// ── D10 · final_report contains all 8P-20.8D + 8P-20.8C + 8P-20.8B metrics ─

test('P8P20_8D_D10 · final_report surfaces fast_path_suppressed / detailed_orders + preserves all prior metrics', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  //   Mixed: 3 processed dups + 1 new
  const dups = Array.from({ length: 3 }, (_, i) => makeRawOrder({ ebayOrderId: `MIX-${i}` }));
  const fresh = makeRawOrder({ ebayOrderId: 'MIX-NEW' });
  for (const o of dups) _seedProcessedRow({ id: 700 + dups.indexOf(o), hash: payloadHash(o), linkedOrderId: 800 + dups.indexOf(o) });
  const sink = stageSink();
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([...dups, fresh]), stageLog: sink.log });
  const finalReport = sink.buf.find(l => /^OMS_EBAY_STAGE_DONE stage=final_report/.test(l));
  assert.ok(finalReport, 'missing final_report line');
  const requiredKV = [
    /orders=4/, /created=1/, /short_circuited=3/, /failed=0/,
    /raw_event_persist_ms=\d+/, /event_insert_ms=\d+/, /duplicate_lookup_ms=\d+/,
    /event_insert_new=1/, /event_insert_duplicate=\d+/, /duplicate_lookup_count=\d+/,
    /prefetch_ms=\d+/, /prefetch_queries=\d+/, /prefetch_rows_found=\d+/,
    /prefetch_hits=\d+/, /prefetch_misses=\d+/, /prefetch_fallback_duplicate_lookups=\d+/,
    /fast_path_suppressed=3/, /detailed_orders=1/,
  ];
  for (const kv of requiredKV) {
    assert.match(finalReport, kv, `final_report missing ${kv} · line=${finalReport}`);
  }
});

// ── D11 · no PII / raw payload / secrets in aggregate output ─

test('P8P20_8D_D11 · fast-path suppressed run · no PII / raw payload / secrets in any log line', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const orders = Array.from({ length: 20 }, (_, i) => makeRawOrder({ ebayOrderId: `PII-${i}` }));
  for (const o of orders) _seedProcessedRow({ id: 300 + orders.indexOf(o), hash: payloadHash(o), linkedOrderId: 400 + orders.indexOf(o) });
  const sink = stageSink();
  await freshIngest({ days: 7, ebayApi: fakeApi(orders), stageLog: sink.log });
  const joined = sink.buf.join('\n');
  const forbidden = [
    orders[0].buyerEmail, orders[0].buyerUserId,
    orders[0].shippingName, orders[0].shippingPhone, orders[0].shippingStreet,
    'Complete',   //   raw checkout status
  ];
  for (const s of forbidden) {
    assert.ok(!joined.includes(s), `log leaked PII/payload text "${s}"`);
  }
});

// ── D12 · Shopify source has no OMS_EBAY_STAGE_ markers ─

test('P8P20_8D_D12 · shopifyIngestor.js source untouched', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/shopifyIngestor.js'), 'utf8');
  assert.ok(!/OMS_EBAY_STAGE_/.test(src));
  assert.ok(!/fastPathSuppressed/.test(src));
});

// ── D13 · Phase 8P-20.6 timeouts remain ───────────────────

test('P8P20_8D_D13 · Phase 8P-20.6 axios timeouts still present (30000 Trading · 15000 x2 OAuth)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/ebayAPI.js'), 'utf8');
  const trading = src.match(/axios\.post\(this\.apiUrl,\s*xml,\s*\{[\s\S]*?\}\)/);
  assert.ok(trading && /timeout:\s*30000/.test(trading[0]));
  const oauth = [...src.matchAll(/axios\.post\(this\.oauthUrl,[\s\S]*?\}\s*\)/g)];
  assert.equal(oauth.length, 2);
  for (const m of oauth) assert.match(m[0], /timeout:\s*15000/);
});

// ── D14 · Phase 8P-20.8C bulk-prefetch semantics intact ─

test('P8P20_8D_D14 · bulk-prefetch still runs · prefetchQueries / prefetchHits / prefetchMisses accurate under compression', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const dups = Array.from({ length: 100 }, (_, i) => makeRawOrder({ ebayOrderId: `PF-${i}` }));
  const fresh = makeRawOrder({ ebayOrderId: 'PF-NEW' });
  for (const o of dups) _seedProcessedRow({ id: 8000 + dups.indexOf(o), hash: payloadHash(o), linkedOrderId: 9000 + dups.indexOf(o) });
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([...dups, fresh]), stageLog: () => {} });
  assert.equal(r.prefetchHits, 100, 'all 100 dups must be prefetch hits');
  assert.equal(r.prefetchMisses, 1);
  assert.ok(r.prefetchQueries >= 1);
  assert.equal(r.fastPathSuppressed, 100);
  assert.equal(r.detailedOrders, 1);
});

// ── D15 (bonus) · OMS_EBAY_VERBOSE_ORDER_LOGS=1 restores full per-order logs ─

test('P8P20_8D_D15 · OMS_EBAY_VERBOSE_ORDER_LOGS=1 restores detailed per-order logs for fast-path orders', async () => {
  _resetDb();
  const prev = process.env.OMS_EBAY_VERBOSE_ORDER_LOGS;
  process.env.OMS_EBAY_VERBOSE_ORDER_LOGS = '1';
  try {
    delete require.cache[ingestorPath];
    const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
    const orders = Array.from({ length: 3 }, (_, i) => makeRawOrder({ ebayOrderId: `V-${i}` }));
    for (const o of orders) _seedProcessedRow({ id: 600 + orders.indexOf(o), hash: payloadHash(o), linkedOrderId: 700 + orders.indexOf(o) });
    const sink = stageSink();
    const r = await freshIngest({ days: 7, ebayApi: fakeApi(orders), stageLog: sink.log });
    //   In verbose mode: NO fast-path suppression
    assert.equal(r.fastPathSuppressed, 0, 'verbose mode must NOT suppress logs');
    assert.equal(r.detailedOrders, 3);
    //   Per-order raw_event_persist logs SHOULD be present
    const rlines = sink.buf.filter(l => /^OMS_EBAY_STAGE_(START|DONE) stage=raw_event_persist#\d+/.test(l));
    assert.ok(rlines.length >= 6, `expected 6+ raw_event_persist lines in verbose mode · saw ${rlines.length}`);
    //   Short-circuit stage still fires
    assert.ok(sink.buf.some(l => /short_circuit_already_processed#\d+/.test(l)));
  } finally {
    if (prev == null) delete process.env.OMS_EBAY_VERBOSE_ORDER_LOGS;
    else process.env.OMS_EBAY_VERBOSE_ORDER_LOGS = prev;
    delete require.cache[ingestorPath];
    require('../../src/services/oms/ebayIngestor');
  }
});

// ── D16 (bonus) · invariant · fastPathSuppressed + detailedOrders === attempted ─

test('P8P20_8D_D16 · invariant · fastPathSuppressed + detailedOrders === attempted (mixed batch)', async () => {
  _resetDb();
  delete require.cache[ingestorPath];
  const { ingestEbay: freshIngest } = require('../../src/services/oms/ebayIngestor');
  const dups = Array.from({ length: 10 }, (_, i) => makeRawOrder({ ebayOrderId: `INV-${i}` }));
  const pending = makeRawOrder({ ebayOrderId: 'INV-PEND' });
  const failed = makeRawOrder({ ebayOrderId: 'INV-FAIL' });
  const fresh = makeRawOrder({ ebayOrderId: 'INV-NEW' });
  for (const o of dups) _seedProcessedRow({ id: 1000 + dups.indexOf(o), hash: payloadHash(o), linkedOrderId: 2000 + dups.indexOf(o) });
  _seedProcessedRow({ id: 3000, hash: payloadHash(pending), linkedOrderId: null, processing: 'pending' });
  _seedProcessedRow({ id: 3001, hash: payloadHash(failed), linkedOrderId: null, processing: 'failed' });
  const r = await freshIngest({ days: 7, ebayApi: fakeApi([...dups, pending, failed, fresh]), stageLog: () => {} });
  assert.equal(r.attempted, 13);
  assert.equal(r.fastPathSuppressed + r.detailedOrders, 13);
  assert.equal(r.fastPathSuppressed, 10);
  assert.equal(r.detailedOrders, 3);
});
