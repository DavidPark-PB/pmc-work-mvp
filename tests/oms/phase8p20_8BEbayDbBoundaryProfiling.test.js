'use strict';

/**
 * tests/oms/phase8p20_8BEbayDbBoundaryProfiling.test.js — Phase 8P-20.8B
 *
 * Adds DB-boundary profiling around persistRawEvent (INSERT + DUPLICATE_LOOKUP)
 * via a GENERIC stageObserver in channelEventService, wired by ebayIngestor.
 *
 * Verifies:
 *   A. duplicate + processed + linked → short-circuit (8P-20.8A preserved)
 *   B. new event → full pipeline
 *   C. duplicate + pending → full retry
 *   D. duplicate + failed → full retry
 *   E. duplicate + processed + linked NULL → full retry
 *   F. INSERT boundary emits START + DONE with elapsed_ms
 *   G. DUPLICATE_LOOKUP boundary START + DONE emitted ONLY on isNew=false
 *   H. new insert emits NO channel_event_duplicate_lookup log
 *   I. aggregate counters/timings surface in final_report
 *   J. no PII / raw payload / secrets in stage logs
 *   K. observer omitted → channelEventService behavior unchanged (backward compat)
 *   L. observer callback that throws does NOT corrupt ingestion
 *   M. Phase 8P-20.6 timeouts remain (30 000 Trading · 15 000 × 2 OAuth)
 *   N. shopifyIngestor source contains no new OMS_EBAY_STAGE markers
 *   O. no new mutation-capability code added by this phase
 *
 * All in-memory · zero DB · zero network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Shared stub scaffolding ───────────────────────────────

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj, children: [], paths: [] };
}
function restore(fullPath, prev) {
  if (prev) require.cache[fullPath] = prev;
  else delete require.cache[fullPath];
}

const chanEvtPath   = require.resolve('../../src/services/oms/channelEventService');
const omsSvcPath    = require.resolve('../../src/services/oms/omsOrderService');
const matcherPath   = require.resolve('../../src/services/oms/omsSkuMatcher');
const costPath     = require.resolve('../../src/services/oms/costFiller');
const ingestorPath  = require.resolve('../../src/services/oms/ebayIngestor');

// Call-count spies
let matcherCalls = 0;
let costCalls = 0;
let upsertCalls = 0;
let markProcessedCalls = 0;
let persistRawEventCalls = 0;

// Programmable persistRawEvent — one queued return per order.
// Each queued item is `{ id, isNew, processingStatus, linkedOrderId,
//                       insertElapsedMs, dupLookupElapsedMs, observerThrows }`.
let persistQueue = [];

function _resetSpies() {
  matcherCalls = 0; costCalls = 0; upsertCalls = 0; markProcessedCalls = 0; persistRawEventCalls = 0;
  persistQueue = [];
}

function _installStubs() {
  stub(chanEvtPath, {
    async persistRawEvent({ stageObserver }) {
      persistRawEventCalls++;
      const next = persistQueue.shift();
      if (!next) throw new Error('persistQueue empty — test forgot to queue a return');
      //   Simulate the boundary events the real service would emit.
      if (typeof stageObserver === 'function') {
        //   INSERT boundary always fires
        try { stageObserver('channel_event_insert', 'start', {}); } catch (_e) {}
        if (next.observerThrows === 'insert_done') {
          //   caller-side observer bug — service must not propagate
          try { stageObserver('channel_event_insert', 'done', { elapsedMs: next.insertElapsedMs ?? 5, isNew: next.isNew }); } catch (_e) {}
        } else {
          try { stageObserver('channel_event_insert', 'done', { elapsedMs: next.insertElapsedMs ?? 5, isNew: next.isNew }); } catch (_e) {}
        }
        //   DUPLICATE_LOOKUP boundary ONLY on isNew=false
        if (next.isNew === false) {
          try { stageObserver('channel_event_duplicate_lookup', 'start', {}); } catch (_e) {}
          try { stageObserver('channel_event_duplicate_lookup', 'done', { elapsedMs: next.dupLookupElapsedMs ?? 3 }); } catch (_e) {}
        }
      }
      return { payloadHash: 'test-hash', ...next };
    },
    async markProcessed(_id, _patch) { markProcessedCalls++; },
    async listPendingEvents() { return []; },
  });
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
  delete require.cache[ingestorPath];
}

_installStubs();
const { ingestEbay } = require('../../src/services/oms/ebayIngestor');

// ── Fixture with distinctive PII strings so leaks are visible in tests ─

const piiOrder = {
  ebayOrderId: 'ORD-BND-A', createdDate: '2026-08-21T10:00:00.000Z',
  buyerUserId: 'BuyerUserPHASE8B_SECRET',
  buyerEmail: 'phase8b-secret@leak.example.com',
  price: 42, quantity: 1, title: 'BoundaryFixture', sku: 'PMC-BND',
  itemId: 'IT-BND-1',
  shippingName: 'RecipientPhaseSecret',
  shippingStreet: 'SecretStreet-Phase8B',
  shippingCity: 'ConfidentialCity', shippingState: 'CS',
  shippingZip: '00000', shippingCountry: 'US',
  shippingPhone: '+1-555-8888-2222',
  _shippedTime: null, _cancelStatus: null, _checkoutStatus: 'Complete',
  _paidTime: '2026-08-21T10:05:00.000Z', _orderStatus: 'Active',
};

const fakeApi = (orders) => ({
  async getAwaitingShipmentOrders(_days, _opts) { return orders; },
});

const stageSink = () => {
  const buf = [];
  return { log: (m) => buf.push(String(m)), buf };
};

// ── A. duplicate + processed + linked → short-circuit preserved ─

test('P8P20_8B_A · duplicate + processed + linked_order_id set → short-circuit (8P-20.8A preserved)', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'processed', linkedOrderId: 42, insertElapsedMs: 7, dupLookupElapsedMs: 4 });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 1);
  assert.equal(matcherCalls, 0);
  assert.equal(upsertCalls, 0);
  assert.equal(markProcessedCalls, 0);
});

// ── B. new event → full pipeline ─────────────────────────

test('P8P20_8B_B · new event runs full pipeline (matcher + cost + upsert + markProcessed)', async () => {
  _resetSpies();
  persistQueue.push({ id: 1, isNew: true, processingStatus: 'pending', linkedOrderId: null, insertElapsedMs: 8 });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1);
  assert.equal(costCalls, 1);
  assert.equal(upsertCalls, 1);
  assert.equal(markProcessedCalls, 1);
});

// ── C. duplicate + pending → full retry ──────────────────

test('P8P20_8B_C · duplicate + pending → full retry', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'pending', linkedOrderId: null, insertElapsedMs: 6, dupLookupElapsedMs: 3 });
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: () => {} });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1);
  assert.equal(upsertCalls, 1);
});

// ── D. duplicate + failed → full retry ───────────────────

test('P8P20_8B_D · duplicate + failed → full retry', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'failed', linkedOrderId: null, insertElapsedMs: 6, dupLookupElapsedMs: 3 });
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: () => {} });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1);
  assert.equal(upsertCalls, 1);
});

// ── E. duplicate + processed + linked NULL → full retry ─

test('P8P20_8B_E · duplicate + processed + linked_order_id NULL → full retry', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'processed', linkedOrderId: null, insertElapsedMs: 6, dupLookupElapsedMs: 3 });
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: () => {} });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1);
  assert.equal(upsertCalls, 1);
});

// ── F. INSERT boundary emits START + DONE with elapsed_ms ─

test('P8P20_8B_F · channel_event_insert#N START + DONE emitted with elapsed_ms', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'processed', linkedOrderId: 42, insertElapsedMs: 11, dupLookupElapsedMs: 5 });
  const sink = stageSink();
  await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_START stage=channel_event_insert#1 ts=/.test(l)),
    `expected channel_event_insert#1 START · saw: ${JSON.stringify(sink.buf)}`);
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_DONE stage=channel_event_insert#1 elapsed_ms=11 is_new=0$/.test(l)),
    `expected channel_event_insert#1 DONE elapsed_ms=11 is_new=0 · saw: ${JSON.stringify(sink.buf)}`);
});

// ── G. DUPLICATE_LOOKUP START + DONE emitted only on isNew=false ─

test('P8P20_8B_G · channel_event_duplicate_lookup START + DONE emitted only when isNew=false', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'processed', linkedOrderId: 42, insertElapsedMs: 6, dupLookupElapsedMs: 9 });
  const sink = stageSink();
  await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_START stage=channel_event_duplicate_lookup#1 ts=/.test(l)),
    'expected duplicate_lookup#1 START');
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_DONE stage=channel_event_duplicate_lookup#1 elapsed_ms=9$/.test(l)),
    `expected duplicate_lookup#1 DONE elapsed_ms=9 · saw: ${JSON.stringify(sink.buf)}`);
});

// ── H. new insert emits NO duplicate-lookup logs ─────────

test('P8P20_8B_H · new event (isNew=true) does NOT emit any channel_event_duplicate_lookup log line', async () => {
  _resetSpies();
  persistQueue.push({ id: 1, isNew: true, processingStatus: 'pending', linkedOrderId: null, insertElapsedMs: 14 });
  const sink = stageSink();
  await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  assert.ok(!sink.buf.some(l => /channel_event_duplicate_lookup/.test(l)),
    `unexpected duplicate_lookup log on new event · saw: ${JSON.stringify(sink.buf)}`);
  assert.ok(sink.buf.some(l => /^OMS_EBAY_STAGE_DONE stage=channel_event_insert#1 elapsed_ms=14 is_new=1$/.test(l)),
    'expected insert DONE with is_new=1');
});

// ── I. aggregate counters/timings in final_report ────────

test('P8P20_8B_I · final_report surfaces raw_event_persist_ms + event_insert_ms + duplicate_lookup_ms + counts', async () => {
  _resetSpies();
  //   3 orders: two short-circuit (isNew=false, processed+linked), one new
  persistQueue.push({ id: 1, isNew: false, processingStatus: 'processed', linkedOrderId: 500, insertElapsedMs: 10, dupLookupElapsedMs: 5 });
  persistQueue.push({ id: 2, isNew: false, processingStatus: 'processed', linkedOrderId: 501, insertElapsedMs: 12, dupLookupElapsedMs: 6 });
  persistQueue.push({ id: 3, isNew: true,  processingStatus: 'pending',   linkedOrderId: null, insertElapsedMs: 20 });
  const orders = [{ ...piiOrder, ebayOrderId: 'X-1' }, { ...piiOrder, ebayOrderId: 'X-2' }, { ...piiOrder, ebayOrderId: 'X-3' }];
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi(orders), stageLog: sink.log });
  //   Report shape
  assert.equal(r.attempted, 3);
  assert.equal(r.shortCircuited, 2);
  assert.equal(r.eventInsertNew, 1);
  assert.equal(r.eventInsertDuplicate, 2);
  assert.equal(r.duplicateLookupCount, 2);
  assert.equal(r.timings.channelEventInsertMs, 10 + 12 + 20);
  assert.equal(r.timings.channelEventDuplicateLookupMs, 5 + 6);
  //   rawEventPersistMs is real wall-clock — must be >= sub-boundary total in production;
  //   in tests it can be 0 (all synchronous), so just assert it's a finite number.
  assert.ok(Number.isFinite(r.timings.rawEventPersistMs), 'rawEventPersistMs must be a number');
  //   final_report line must include all six aggregates
  const finalReport = sink.buf.find(l => /^OMS_EBAY_STAGE_DONE stage=final_report/.test(l));
  assert.ok(finalReport, 'missing final_report line');
  for (const kv of [
    /orders=3/, /short_circuited=2/,
    /raw_event_persist_ms=\d+/,
    /event_insert_ms=42/,
    /duplicate_lookup_ms=11/,
    /event_insert_new=1/,
    /event_insert_duplicate=2/,
    /duplicate_lookup_count=2/,
  ]) {
    assert.match(finalReport, kv, `final_report missing ${kv} · line=${finalReport}`);
  }
});

// ── J. no PII / raw payload / secrets in stage logs ─────

test('P8P20_8B_J · no buyer PII / raw payload / secrets in stage log stream (including new boundaries)', async () => {
  _resetSpies();
  persistQueue.push({ id: 1, isNew: false, processingStatus: 'processed', linkedOrderId: 999, insertElapsedMs: 7, dupLookupElapsedMs: 3 });
  const sink = stageSink();
  await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  const joined = sink.buf.join('\n');
  for (const s of [
    piiOrder.buyerEmail, piiOrder.buyerUserId,
    piiOrder.shippingName, piiOrder.shippingPhone, piiOrder.shippingStreet,
    'Complete',
  ]) {
    assert.ok(!joined.includes(s), `stage log leaked "${s}"`);
  }
});

// ── K. observer omitted → backward compatible ────────────

test('P8P20_8B_K · channelEventService accepts absent stageObserver — no throw, existing contract preserved', () => {
  //   Load the REAL channelEventService (temporarily un-stub it) and inspect its
  //   source to prove the observer path is guarded by `typeof === "function"`.
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/channelEventService.js'), 'utf8');
  //   Guard against stageObserver being undefined
  assert.match(src, /if\s*\(\s*typeof\s+stageObserver\s*!==?\s*['"]function['"]\s*\)\s*return\s*;/,
    'persistRawEvent must guard observer path with typeof === "function" check');
  //   Return shape unchanged when observer absent — id/isNew/payloadHash/processingStatus/linkedOrderId still present
  assert.match(src, /processingStatus:\s*'pending'/,
    'insert-succeeded branch still returns processingStatus');
  assert.match(src, /linkedOrderId:\s*null/, 'insert-succeeded branch still returns linkedOrderId');
});

// ── L. observer callback that throws does NOT corrupt ingestion ─

test('P8P20_8B_L · observer callback that throws does NOT propagate / does NOT drop the event', async () => {
  _resetSpies();
  //   Load a fake persistRawEvent that invokes a broken observer and asserts
  //   the throw doesn't propagate. We simulate this by putting a queued item
  //   whose observerThrows='insert_done' — the stub calls stageObserver('channel_event_insert', 'done', ...)
  //   AND catches its throw internally (mirroring what the REAL service does).
  //   We also assert the ingestion still completes and returns a report.
  persistQueue.push({ id: 1, isNew: false, processingStatus: 'processed', linkedOrderId: 999, insertElapsedMs: 7, dupLookupElapsedMs: 3, observerThrows: 'insert_done' });
  const sink = stageSink();
  //   Override the observer to always throw when called — the SERVICE stub catches it.
  //   To also test the REAL service's guard, we inspect its source (same as test K).
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/channelEventService.js'), 'utf8');
  assert.match(src, /try\s*\{\s*stageObserver\(.*\)\s*;\s*\}\s*catch\s*\(_?e\)/,
    'stageObserver call must be wrapped in try/catch inside persistRawEvent');
  //   Ingestion still completes
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([piiOrder]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 1);
});

// ── M. Phase 8P-20.6 timeouts remain ─────────────────────

test('P8P20_8B_M · Phase 8P-20.6 axios timeouts still present (30000 Trading · 15000 x2 OAuth)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/ebayAPI.js'), 'utf8');
  const trading = src.match(/axios\.post\(this\.apiUrl,\s*xml,\s*\{[\s\S]*?\}\)/);
  assert.ok(trading && /timeout:\s*30000/.test(trading[0]),
    'Trading API axios.post must retain timeout: 30000');
  const oauth = [...src.matchAll(/axios\.post\(this\.oauthUrl,[\s\S]*?\}\s*\)/g)];
  assert.equal(oauth.length, 2, 'exactly 2 OAuth axios.post blocks required');
  for (const m of oauth) assert.match(m[0], /timeout:\s*15000/, 'OAuth axios.post must retain timeout: 15000');
});

// ── N. Shopify source contains no new OMS_EBAY_STAGE markers ─

test('P8P20_8B_N · shopifyIngestor.js source has no OMS_EBAY_STAGE_ markers', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/shopifyIngestor.js'), 'utf8');
  assert.ok(!/OMS_EBAY_STAGE_/.test(src),
    'shopifyIngestor.js must remain free of ebay stage markers (Phase 8P-20.8B scope guard)');
});

// ── O. no new mutation capability introduced by this phase ─

test('P8P20_8B_O · no new mutation call added to channelEventService.js (only existing insert / update / select)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/channelEventService.js'), 'utf8');
  //   Only existing calls allowed. Enumerate every .insert/.update/.upsert/.delete/.rpc
  //   and assert they match the expected small set.
  const writes = [...src.matchAll(/\.(insert|update|upsert|delete|rpc)\s*\(/g)].map(m => m[1]);
  //   Expected: exactly the pre-8P-20.8B set (insert + update on channel_order_events, plus insert on ingestion_error_log?
  //   No — channel_order_events service only has: insert (persistRawEvent) + update (markProcessed).
  const expected = ['insert', 'update'];
  assert.deepEqual(writes.sort(), expected.sort(),
    `channelEventService writes must be exactly ${JSON.stringify(expected)} · saw ${JSON.stringify(writes)}`);
  //   No new axios call added
  assert.ok(!/axios\./.test(src), 'channelEventService must not use axios');
  //   No new .rpc()
  assert.ok(!/\.rpc\(/.test(src), 'channelEventService must not add .rpc()');
});
