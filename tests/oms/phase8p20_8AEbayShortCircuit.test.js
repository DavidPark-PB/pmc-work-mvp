'use strict';

/**
 * tests/oms/phase8p20_8AEbayShortCircuit.test.js — Phase 8P-20.8A
 *
 * Implements the "already-processed unchanged event" short-circuit and proves:
 *   A. new event → full pipeline
 *   B. duplicate + processing_status='processed' + linked_order_id != null → short-circuit
 *   C. duplicate + processing_status='pending' → full retry
 *   D. duplicate + processing_status='failed' → full retry
 *   E. duplicate + processing_status='processed' + linked_order_id == null → full retry
 *   F. changed payload (different hash) → full pipeline (isNew=true)
 *   G. short-circuit branch makes ZERO matcher / cost / upsert / markProcessed calls
 *   H. report.shortCircuited increments exactly once per short-circuited order
 *
 * Also verified separately (I, J) by re-running:
 *   - tests/oms/phase8p20_6EbayTimeout.test.js
 *   - tests/oms/phase8p20_7EbayStageObservability.test.js
 *
 * All in-memory · zero DB · zero network. Shopify path intentionally untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Shared stubs ───────────────────────────────────────────

function stub(fullPath, exportsObj) {
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj, children: [], paths: [] };
}

const chanEvtPath   = require.resolve('../../src/services/oms/channelEventService');
const omsSvcPath    = require.resolve('../../src/services/oms/omsOrderService');
const matcherPath   = require.resolve('../../src/services/oms/omsSkuMatcher');
const costPath      = require.resolve('../../src/services/oms/costFiller');
const ingestorPath  = require.resolve('../../src/services/oms/ebayIngestor');

// Call-count spies
let matcherCalls = 0;
let costCalls = 0;
let upsertCalls = 0;
let markProcessedCalls = 0;
let persistRawEventCalls = 0;

// Programmable persistRawEvent — one queued return per order.
let persistQueue = [];  // Array<{ id, isNew, processingStatus, linkedOrderId }>

function _resetSpies() {
  matcherCalls = 0; costCalls = 0; upsertCalls = 0; markProcessedCalls = 0; persistRawEventCalls = 0;
  persistQueue = [];
}

// Install stubs BEFORE requiring the ingestor
stub(chanEvtPath, {
  async persistRawEvent(_args) {
    persistRawEventCalls++;
    const next = persistQueue.shift();
    if (!next) throw new Error('persistQueue empty — test forgot to queue a return');
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
stub(costPath, {
  async fillCostSnapshotForItems(items) { costCalls++; return items; },
});

// Fresh ingestor
delete require.cache[ingestorPath];
const { ingestEbay } = require('../../src/services/oms/ebayIngestor');

// ── Fixtures ────────────────────────────────────────────

const orderA = {
  ebayOrderId: 'ORD-A', createdDate: '2026-08-21T10:00:00.000Z',
  buyerUserId: 'BuyerUserSecretUnique',
  buyerEmail: 'secret-buyer@leaktest.example.com',
  price: 10, quantity: 1, title: 'A', sku: 'PMC-A', itemId: 'IA-1',
  shippingName: 'PrivateNameXYZ',
  shippingStreet: 'SecretStreet-Alpha-42',
  shippingCity: 'ConfidentialCity', shippingState: 'CS',
  shippingZip: '99999', shippingCountry: 'US',
  shippingPhone: '+1-555-7777-9999',
  _shippedTime: null, _cancelStatus: null, _checkoutStatus: 'Complete',
  _paidTime: '2026-08-21T10:05:00.000Z', _orderStatus: 'Active',
};
const orderB = { ...orderA, ebayOrderId: 'ORD-B', sku: 'PMC-B' };
const orderC = { ...orderA, ebayOrderId: 'ORD-C', sku: 'PMC-C' };

const fakeApi = (orders) => ({
  async getAwaitingShipmentOrders(_days, _opts) { return orders; },
});

const stageSink = () => {
  const buf = [];
  return { log: (m) => buf.push(String(m)), buf };
};

// ── A. new event → full pipeline ─────────────────────────

test('P8P20_8A_A · new event runs full pipeline (matcher + cost + upsert + markProcessed)', async () => {
  _resetSpies();
  persistQueue.push({ id: 1, isNew: true, processingStatus: 'pending', linkedOrderId: null });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([orderA]), stageLog: sink.log });
  assert.equal(r.attempted, 1);
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1, 'matcher called on new event');
  assert.equal(costCalls, 1, 'cost filler called on new event');
  assert.equal(upsertCalls, 1, 'upsert called on new event');
  assert.equal(markProcessedCalls, 1, 'markProcessed called on new event');
});

// ── B. duplicate + processed + linked → short-circuit ────

test('P8P20_8A_B · duplicate + processed + linked_order_id set → short-circuit (no downstream calls)', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'processed', linkedOrderId: 42 });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([orderA]), stageLog: sink.log });
  assert.equal(r.attempted, 1);
  assert.equal(r.shortCircuited, 1, 'shortCircuited must be 1');
  assert.equal(matcherCalls, 0);
  assert.equal(costCalls, 0);
  assert.equal(upsertCalls, 0);
  assert.equal(markProcessedCalls, 0);
  //   short-circuit stage log present
  assert.ok(sink.buf.some(l => /OMS_EBAY_STAGE_DONE stage=short_circuit_already_processed#1 elapsed_ms=\d+ linked_order_id=42/.test(l)),
    `short-circuit stage log missing · buf=${JSON.stringify(sink.buf)}`);
  //   final_report includes short_circuited count
  assert.ok(sink.buf.some(l => /OMS_EBAY_STAGE_DONE stage=final_report .*short_circuited=1/.test(l)),
    'final_report must surface short_circuited count');
});

// ── C. duplicate + pending → full retry ──────────────────

test('P8P20_8A_C · duplicate + processing_status="pending" → full retry (short-circuit NOT triggered)', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'pending', linkedOrderId: null });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([orderA]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1, 'matcher must run for pending event (retry semantics)');
  assert.equal(upsertCalls, 1);
});

// ── D. duplicate + failed → full retry ───────────────────

test('P8P20_8A_D · duplicate + processing_status="failed" → full retry', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'failed', linkedOrderId: null });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([orderA]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1);
  assert.equal(costCalls, 1);
  assert.equal(upsertCalls, 1);
  assert.equal(markProcessedCalls, 1);
});

// ── E. duplicate + processed + linked_order_id NULL → full retry ──

test('P8P20_8A_E · duplicate + processed + linked_order_id NULL → full retry (data-inconsistency safeguard)', async () => {
  _resetSpies();
  persistQueue.push({ id: 100, isNew: false, processingStatus: 'processed', linkedOrderId: null });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([orderA]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 0, 'must NOT short-circuit when linked_order_id is null');
  assert.equal(matcherCalls, 1);
  assert.equal(upsertCalls, 1);
});

// ── F. changed payload (isNew=true) → full pipeline ─────

test('P8P20_8A_F · changed payload returns isNew=true → full pipeline (proves hash-change path unaffected)', async () => {
  _resetSpies();
  persistQueue.push({ id: 200, isNew: true, processingStatus: 'pending', linkedOrderId: null });
  const sink = stageSink();
  const changedA = { ...orderA, _orderStatus: 'Completed', _shippedTime: '2026-08-21T12:00:00.000Z' };
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([changedA]), stageLog: sink.log });
  assert.equal(r.shortCircuited, 0);
  assert.equal(matcherCalls, 1);
  assert.equal(upsertCalls, 1);
});

// ── G. mixed batch: short-circuit only touches processed/linked; others run full ──

test('P8P20_8A_G · mixed batch (short-circuit + new + pending) · exact call-count guarantee', async () => {
  _resetSpies();
  //   order 1: short-circuit  |  order 2: new  |  order 3: pending retry
  persistQueue.push({ id: 1, isNew: false, processingStatus: 'processed', linkedOrderId: 500 });
  persistQueue.push({ id: 2, isNew: true,  processingStatus: 'pending',   linkedOrderId: null });
  persistQueue.push({ id: 3, isNew: false, processingStatus: 'pending',   linkedOrderId: null });
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi([orderA, orderB, orderC]), stageLog: sink.log });
  assert.equal(r.attempted, 3);
  assert.equal(r.shortCircuited, 1, 'exactly one short-circuited order');
  //   two survivors ran the full pipeline
  assert.equal(matcherCalls, 2, 'matcher runs exactly twice (skip #1)');
  assert.equal(costCalls, 2);
  assert.equal(upsertCalls, 2);
  assert.equal(markProcessedCalls, 2);
  assert.equal(persistRawEventCalls, 3, 'persistRawEvent runs once per order regardless');
});

// ── H. shortCircuited increments per-order (5 processed dups) ─

test('P8P20_8A_H · report.shortCircuited increments correctly across many short-circuits', async () => {
  _resetSpies();
  const N = 5;
  for (let i = 0; i < N; i++) persistQueue.push({ id: 10 + i, isNew: false, processingStatus: 'processed', linkedOrderId: 700 + i });
  const orders = Array.from({ length: N }, (_, i) => ({ ...orderA, ebayOrderId: `BULK-${i}` }));
  const sink = stageSink();
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi(orders), stageLog: sink.log });
  assert.equal(r.shortCircuited, N);
  assert.equal(matcherCalls, 0);
  assert.equal(upsertCalls, 0);
  assert.equal(markProcessedCalls, 0);
  //   Each order emits its own stage log line
  const scLines = sink.buf.filter(l => /^OMS_EBAY_STAGE_DONE stage=short_circuit_already_processed#\d+ /.test(l));
  assert.equal(scLines.length, N, `expected ${N} short-circuit stage-done lines · saw ${scLines.length}`);
});

// ── PII / secret safety on short-circuit path (defense-in-depth) ─

test('P8P20_8A_PII · short-circuit stage log carries no buyer PII', async () => {
  _resetSpies();
  persistQueue.push({ id: 999, isNew: false, processingStatus: 'processed', linkedOrderId: 88 });
  const sink = stageSink();
  await ingestEbay({ days: 7, ebayApi: fakeApi([orderA]), stageLog: sink.log });
  const joined = sink.buf.join('\n');
  for (const s of [orderA.buyerEmail, orderA.shippingName, orderA.shippingPhone, orderA.shippingStreet, orderA.buyerUserId]) {
    assert.ok(!joined.includes(s), `short-circuit stage log leaked "${s}"`);
  }
});
