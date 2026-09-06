'use strict';

/**
 * tests/services/ebayTrackingObserverInvariant.test.js — R2-SHIP-6F1A (2026-09-06).
 *
 * Invariant suite for the eBay Tracking Observer:
 *
 *   · SAFE_INSERT_ONLY · never overwrite existing tracking, never touch status,
 *     never touch carrier, no cross-platform bleed
 *   · Atomic race safety · conditional UPDATE preserves any concurrent-write
 *     winner
 *   · RUN_INCOMPLETE preservation · any pagination error aborts the entire
 *     sweep before any DB write
 *   · MULTI_PACKAGE_REVIEW · distinct tracking values across one order emit no
 *     scalar write
 *   · Provenance stamping · tracking_source='ebay_observation' ·
 *     tracking_imported_at=NOW · tracking_observed_at=NULL (owner rule §27)
 *
 * All tests use fabricated synthetic XML (no PII) + in-memory DB stub. No real
 * eBay calls · no real Supabase writes.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const observer = require('../../src/services/ebayTrackingObserver');
const {
  classifyOrderObservations,
  _extractAllShipmentTracking,
  _extractAllOrderBlocks,
  _normalizeTrackingNumber,
  ORDER_CLASS,
  WRITE_OUTCOME,
  OUTCOME,
  TRACKING_SOURCE,
} = observer._internals;

// ─────────────────────────────────────────────────────────────────────
// Synthetic XML fixtures · sanitized · no PII
// ─────────────────────────────────────────────────────────────────────

function makeGetOrdersXml({ pages = 1, orderBlocks = [] }) {
  const orders = orderBlocks.join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Timestamp>2026-09-06T00:00:00.000Z</Timestamp>
  <Ack>Success</Ack>
  <Version>1355</Version>
  <TotalNumberOfPages>${pages}</TotalNumberOfPages>
  <OrderArray>
    ${orders}
  </OrderArray>
</GetOrdersResponse>`;
}

function orderXml({ orderId, transactions = [] }) {
  //   Each transaction may have its own ShipmentTrackingDetails block.
  const txns = transactions.map(t => {
    const tracking = (t.tracking || []).map(tr =>
      `<ShipmentTrackingDetails>
         <ShipmentTrackingNumber>${tr.number}</ShipmentTrackingNumber>
         <ShippingCarrierUsed>${tr.carrier}</ShippingCarrierUsed>
       </ShipmentTrackingDetails>`
    ).join('');
    return `<Transaction>
              <ShippingDetails>${tracking}</ShippingDetails>
              <Item><ItemID>${t.itemId || 'ITM'}</ItemID></Item>
            </Transaction>`;
  }).join('');
  return `<Order>
            <OrderID>${orderId}</OrderID>
            <OrderStatus>Completed</OrderStatus>
            <TransactionArray>${txns}</TransactionArray>
          </Order>`;
}

function ackFailureXml({ shortMessage = 'test-error' } = {}) {
  return `<?xml version="1.0"?><GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
    <Ack>Failure</Ack>
    <Errors><ShortMessage>${shortMessage}</ShortMessage></Errors>
    <TotalNumberOfPages>1</TotalNumberOfPages>
  </GetOrdersResponse>`;
}

// ─────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────

function makeEbayStub({ pages = [], throwOnPage = null } = {}) {
  //   `pages` is an array of XML responses indexed by pageNumber-1.
  //   throwOnPage forces a network error on that pageNumber.
  const calls = [];
  return {
    calls,
    async callTradingAPI(callName, body) {
      calls.push({ callName, body });
      const pageMatch = body.match(/<PageNumber>(\d+)<\/PageNumber>/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      if (throwOnPage != null && page === throwOnPage) throw new Error('SIMULATED_NETWORK_ERROR');
      const xml = pages[page - 1];
      if (xml == null) throw new Error(`test bug · no fixture for page ${page}`);
      return xml;
    },
  };
}

function makeDbStub({ rows = [], omsRows = [], evidenceRows = [] } = {}) {
  //   `rows`         → simulates the current `orders` table.
  //   `omsRows`      → simulates `oms_orders` for OMS-SHIP-EVIDENCE-E1 identity
  //                    resolution. Default empty → resolveOmsLinkedOrderId returns
  //                    {linkedOrderId:null, ambiguous:false} · evidence still
  //                    persists · legacy path behavior identical to pre-E1.
  //   `evidenceRows` → pre-existing `channel_order_events` rows (for idempotency
  //                    tests) · dedup by (channel, payload_hash) partial UNIQUE.
  const state     = new Map();
  const omsState  = new Map();  // key: external_order_id → array of {id, channel, external_order_id}
  const evidence  = new Map();  // key: `${channel}|${payload_hash}` → row
  const upd       = { updateCalls: [], statusWrites: [], carrierWrites: [] };
  rows.forEach(r => state.set(r.order_no, { ...r }));
  omsRows.forEach(r => {
    const list = omsState.get(r.external_order_id) || [];
    list.push({ ...r });
    omsState.set(r.external_order_id, list);
  });
  evidenceRows.forEach(r => evidence.set(`${r.channel}|${r.payload_hash}`, { ...r }));
  const evidenceInserts = [];

  function makeUpdateChain({ table, patch }) {
    const filters = [];
    const chain = {
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      in(col, vals) { filters.push({ op: 'in', col, vals }); return chain; },
      is(col, val)  { filters.push({ op: 'is', col, val }); return chain; },
      or(str)       { filters.push({ op: 'or', str }); return chain; },
      select()      { return chain; },
      async then(resolve) {
        //   Track every write attempt for behavioural assertions
        upd.updateCalls.push({ table, patch, filters });
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
          upd.statusWrites.push({ table, status: patch.status });
        }
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'carrier')) {
          upd.carrierWrites.push({ table, carrier: patch.carrier });
        }
        //   Evaluate the WHERE conditions against `state` to model the
        //   atomic conditional UPDATE.
        const orderNoFilter  = filters.find(f => f.op === 'eq' && f.col === 'order_no');
        const platformFilter = filters.find(f => f.op === 'eq' && f.col === 'platform');
        const orFilter       = filters.find(f => f.op === 'or');
        if (!orderNoFilter || !platformFilter) {
          resolve({ data: [], error: null });
          return;
        }
        const row = state.get(orderNoFilter.val);
        if (!row) { resolve({ data: [], error: null }); return; }
        if (row.platform !== platformFilter.val) { resolve({ data: [], error: null }); return; }
        //   Model the or('tracking_no.is.null,tracking_no.eq.') predicate:
        //   only match when tracking_no is null or empty string.
        if (orFilter) {
          const currentTn = row.tracking_no;
          const passes = (currentTn == null) || currentTn === '';
          if (!passes) { resolve({ data: [], error: null }); return; }
        }
        //   R2-SHIP-6F1B-S · model .in('status', [...]) atomic predicate.
        //   If observer passed a status-scope filter, only rows whose current
        //   status is in the list may mutate. This closes the SHIPPED→READY
        //   race in the DB predicate itself, matching production PostgREST
        //   .in() semantics.
        const statusInFilter = filters.find(f => f.op === 'in' && f.col === 'status');
        if (statusInFilter) {
          if (!statusInFilter.vals.includes(row.status)) {
            resolve({ data: [], error: null });
            return;
          }
        }
        //   Apply patch to the row · return updated row
        Object.assign(row, patch);
        resolve({ data: [{ order_no: row.order_no, tracking_no: row.tracking_no }], error: null });
      },
    };
    return chain;
  }

  const db = {
    from(table) {
      //   OMS-SHIP-EVIDENCE-E1 · oms_orders identity resolution.
      //     EXACT (channel, external_order_id) match only. Multiple rows for
      //     the same key model the ambiguous branch (should never happen in
      //     production due to unique constraint · but caller must handle it).
      if (table === 'oms_orders') {
        const filters = [];
        const q = {
          select(_cols) { return q; },
          eq(col, val) { filters.push({ op: 'eq', col, val }); return q; },
          async then(resolve) {
            const chan = filters.find(f => f.col === 'channel');
            const ext  = filters.find(f => f.col === 'external_order_id');
            if (!chan || !ext) { resolve({ data: [], error: null }); return; }
            const list = omsState.get(ext.val) || [];
            const matched = list.filter(r => r.channel === chan.val);
            resolve({ data: matched.map(r => ({ id: r.id })), error: null });
          },
        };
        return q;
      }
      //   OMS-SHIP-EVIDENCE-E1 · channel_order_events insert.
      //     Models the (channel, payload_hash) partial UNIQUE via in-memory
      //     Map lookup. Duplicate → PG error code 23505 · helper interprets
      //     as benign duplicate (not error).
      if (table === 'channel_order_events') {
        return {
          insert(row) {
            const captured = { ...row };
            const chain = {
              select() { return chain; },
              async then(resolve) {
                evidenceInserts.push(captured);
                const key = `${captured.channel}|${captured.payload_hash}`;
                if (evidence.has(key)) {
                  resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
                  return;
                }
                const idNext = evidence.size + 1;
                evidence.set(key, { ...captured, id: idNext });
                resolve({ data: [{ id: idNext }], error: null });
              },
            };
            return chain;
          },
        };
      }
      //   Legacy `orders` table path — unchanged from R2-SHIP-6F1A.
      return {
        select(_cols) {
          const filters = [];
          const q = {
            eq(col, val) { filters.push({ op: 'eq', col, val }); return q; },
            in(col, vals) { filters.push({ op: 'in', col, vals }); return q; },
            or(str) { filters.push({ op: 'or', str }); return q; },
            async then(resolve) {
              const platformFilter = filters.find(f => f.op === 'eq' && f.col === 'platform');
              const inFilter       = filters.find(f => f.op === 'in' && f.col === 'order_no');
              const wantSet        = inFilter ? new Set(inFilter.vals) : null;
              const result = [];
              for (const r of state.values()) {
                if (platformFilter && r.platform !== platformFilter.val) continue;
                if (wantSet && !wantSet.has(r.order_no)) continue;
                result.push({
                  order_no:    r.order_no,
                  platform:    r.platform,
                  tracking_no: r.tracking_no,
                  //   R2-SHIP-6F1B-S · observer selects status too so it can
                  //   classify NOT_ELIGIBLE_STATUS accurately for reporting.
                  status:      r.status,
                });
              }
              resolve({ data: result, error: null });
            },
          };
          return q;
        },
        update(patch) { return makeUpdateChain({ table, patch }); },
      };
    },
    _state: state,
    _writes: upd,
    _evidence: evidence,
    _evidenceInserts: evidenceInserts,
    _omsState: omsState,
  };
  return db;
}

// ─────────────────────────────────────────────────────────────────────
// Pure helper tests
// ─────────────────────────────────────────────────────────────────────

test('NORM · tracking string · trim only · never numeric coerce', () => {
  assert.equal(_normalizeTrackingNumber(' ABC123 '), 'ABC123');
  assert.equal(_normalizeTrackingNumber('LI084296316KR'), 'LI084296316KR');
  assert.equal(_normalizeTrackingNumber(''), '');
  assert.equal(_normalizeTrackingNumber('   '), '');
  assert.equal(_normalizeTrackingNumber(null), '');
  assert.equal(_normalizeTrackingNumber(undefined), '');
  //   Purely-numeric tracking is a STRING · not a number
  assert.equal(_normalizeTrackingNumber('871151747955'), '871151747955');
  assert.equal(_normalizeTrackingNumber(871151747955), '871151747955');
});

test('CLASSIFY · empty → NO_TRACKING', () => {
  const r = classifyOrderObservations([]);
  assert.equal(r.classification, ORDER_CLASS.NO_TRACKING);
});

test('CLASSIFY · one tracking → ONE_UNIQUE_TRACKING', () => {
  const r = classifyOrderObservations([{ number: 'SF123', carrier: 'SF Express' }]);
  assert.equal(r.classification, ORDER_CLASS.ONE_UNIQUE_TRACKING);
  assert.equal(r.unique.length, 1);
  assert.equal(r.unique[0].number, 'SF123');
});

test('CLASSIFY · same tracking N times → ONE_UNIQUE_TRACKING (dedupe)', () => {
  const r = classifyOrderObservations([
    { number: 'SF123', carrier: 'SF Express' },
    { number: 'SF123', carrier: 'SF Express' },
    { number: 'SF123', carrier: 'SF Express' },
  ]);
  assert.equal(r.classification, ORDER_CLASS.ONE_UNIQUE_TRACKING);
  assert.equal(r.unique.length, 1);
});

test('CLASSIFY · two distinct → MULTIPLE_DISTINCT_TRACKING', () => {
  const r = classifyOrderObservations([
    { number: 'SF123', carrier: 'SF Express' },
    { number: 'FE456', carrier: 'FedEx' },
  ]);
  assert.equal(r.classification, ORDER_CLASS.MULTIPLE_DISTINCT_TRACKING);
  assert.equal(r.unique.length, 2);
});

test('CLASSIFY · malformed (empty) filtered · then NO_TRACKING', () => {
  const r = classifyOrderObservations([{ number: '', carrier: 'SF Express' }]);
  assert.equal(r.classification, ORDER_CLASS.NO_TRACKING);
});

// ─────────────────────────────────────────────────────────────────────
// Behavioural tests · full run() invocation
// ─────────────────────────────────────────────────────────────────────

test('BH-T1 · single eBay tracking + DB NULL → INSERTED + provenance + status/carrier untouched', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-1', transactions: [{ tracking: [{ number: 'SF-A', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-1', platform: 'eBay', tracking_no: null, status: 'SHIPPED', carrier: 'KPL' }] });
  const now = () => new Date('2026-09-06T12:00:00Z');
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], now, deps: { ebay, db } });
  assert.equal(r.counters.outcome, OUTCOME.RUN_COMPLETE);
  assert.equal(r.counters.inserted, 1);
  //   provenance stamped correctly
  const row = db._state.get('E-1');
  assert.equal(row.tracking_no, 'SF-A');
  assert.equal(row.tracking_source, TRACKING_SOURCE);
  assert.equal(row.tracking_imported_at, '2026-09-06T12:00:00.000Z');
  assert.equal(row.tracking_observed_at, null, 'eBay does not expose observation timestamp · NULL');
  //   status + carrier untouched
  assert.equal(row.status, 'SHIPPED');
  assert.equal(row.carrier, 'KPL');
  assert.equal(db._writes.statusWrites.length, 0);
  assert.equal(db._writes.carrierWrites.length, 0);
});

test('BH-T2 · same tracking repeated across 3 transactions → dedupe → INSERTED', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({
      orderId: 'E-2',
      transactions: [
        { tracking: [{ number: 'SF-B', carrier: 'SF Express' }] },
        { tracking: [{ number: 'SF-B', carrier: 'SF Express' }] },
        { tracking: [{ number: 'SF-B', carrier: 'SF Express' }] },
      ],
    }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-2', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.one_unique_tracking, 1);
  assert.equal(r.counters.inserted, 1);
  assert.equal(db._state.get('E-2').tracking_no, 'SF-B');
});

test('BH-T3 · two DISTINCT tracking values → MULTI_PACKAGE_REVIEW · 0 writes', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({
      orderId: 'E-3',
      transactions: [
        { tracking: [{ number: 'SF-C', carrier: 'SF Express' }] },
        { tracking: [{ number: 'FE-D', carrier: 'FedEx' }] },
      ],
    }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-3', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.multi_package, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('E-3').tracking_no, null);
});

test('BH-T4 · eBay no tracking → 0 writes', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-4', transactions: [{ tracking: [] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-4', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.no_tracking, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('E-4').tracking_no, null);
});

test('BH-T5 · DB already has same tracking → ALREADY_KNOWN_OR_RACED · 0 writes', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-5', transactions: [{ tracking: [{ number: 'SAME', carrier: 'X' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-5', platform: 'eBay', tracking_no: 'SAME', status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.already_known_or_raced, 1);
  assert.equal(r.counters.inserted, 0);
});

test('BH-T6 · DB has DIFFERENT tracking → CONFLICT · 0 writes · no overwrite', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-6', transactions: [{ tracking: [{ number: 'EBAY-VAL', carrier: 'X' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-6', platform: 'eBay', tracking_no: 'DB-VAL', status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.conflict, 1);
  assert.equal(r.counters.inserted, 0);
  //   Value stays DB-VAL · no overwrite
  assert.equal(db._state.get('E-6').tracking_no, 'DB-VAL');
});

test('BH-T7 · API error on page 1 → RUN_INCOMPLETE · 0 writes', async () => {
  const ebay = makeEbayStub({ pages: [], throwOnPage: 1 });
  const db = makeDbStub({ rows: [{ order_no: 'E-7', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.outcome, OUTCOME.RUN_INCOMPLETE);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._writes.updateCalls.length, 0);
  assert.ok((r.counters.fetch_reason || '').includes('page=1'));
});

test('BH-T8 · API error on middle page → RUN_INCOMPLETE · 0 writes · early orders not committed', async () => {
  const page1 = makeGetOrdersXml({
    pages: 3,
    orderBlocks: [ orderXml({ orderId: 'E-8a', transactions: [{ tracking: [{ number: 'GOOD-A', carrier: 'X' }] }] }) ],
  });
  const page2 = makeGetOrdersXml({
    pages: 3,
    orderBlocks: [ orderXml({ orderId: 'E-8b', transactions: [{ tracking: [{ number: 'GOOD-B', carrier: 'X' }] }] }) ],
  });
  //   Page 3 will throw · sweep must abort before any writes
  const ebay = makeEbayStub({ pages: [page1, page2, null], throwOnPage: 3 });
  const db = makeDbStub({ rows: [
    { order_no: 'E-8a', platform: 'eBay', tracking_no: null, status: 'SHIPPED' },
    { order_no: 'E-8b', platform: 'eBay', tracking_no: null, status: 'SHIPPED' },
  ]});
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.outcome, OUTCOME.RUN_INCOMPLETE);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._writes.updateCalls.length, 0);
  assert.equal(db._state.get('E-8a').tracking_no, null);
  assert.equal(db._state.get('E-8b').tracking_no, null);
});

test('BH-T9 · eBay OrderID unknown to DB → DB_ORDER_NOT_ELIGIBLE · 0 writes', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-UNKNOWN', transactions: [{ tracking: [{ number: 'X', carrier: 'Y' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.db_order_not_eligible, 1);
  assert.equal(r.counters.inserted, 0);
});

test('BH-T10 · same order_no on non-eBay platform → not eligible · 0 writes (cross-platform bleed guard)', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'CROSS-ID', transactions: [{ tracking: [{ number: 'X', carrier: 'Y' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  //   Row exists but platform='Shopify' · must not match
  const db = makeDbStub({ rows: [{ order_no: 'CROSS-ID', platform: 'Shopify', tracking_no: null }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.db_order_not_eligible, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('CROSS-ID').tracking_no, null);
});

test('BH-T11 · whitespace-only tracking → treated as absent · NO_TRACKING', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-11', transactions: [{ tracking: [{ number: '   ', carrier: 'X' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-11', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.no_tracking, 1);
  assert.equal(r.counters.inserted, 0);
});

test('BH-T12 · dryRun=true → reports safe_insert_candidates · 0 DB writes', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-12', transactions: [{ tracking: [{ number: 'DRY', carrier: 'X' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-12', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: true, deps: { ebay, db } });
  assert.equal(r.counters.safe_insert_candidates, 1);
  assert.equal(r.counters.inserted, 0, 'dryRun MUST NOT write');
  assert.equal(db._writes.updateCalls.length, 0);
  assert.equal(db._state.get('E-12').tracking_no, null);
});

test('BH-T13 · atomic race · DB gets populated between fetch and update → no overwrite', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-13', transactions: [{ tracking: [{ number: 'OBSERVER-VAL', carrier: 'X' }] }] }) ],
  });
  //   Custom DB stub · row is NULL at fetch time but gets populated by
  //   concurrent writer before update fires. Simulate by having the stub's
  //   .update chain check for a race flag set between fetch and update.
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-13', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  //   Inject race: monkey-patch the update chain builder to first mutate
  //   state, then run atomic predicate.
  const origFrom = db.from.bind(db);
  db.from = function(table) {
    const q = origFrom(table);
    //   OMS-SHIP-EVIDENCE-E1 · only the legacy `orders` table exposes .update;
    //   oms_orders / channel_order_events branches don't and would crash the
    //   race-simulating wrapper. Guard preserves the intent (race is on legacy).
    if (typeof q.update !== 'function') return q;
    const origUpdate = q.update.bind(q);
    q.update = function(patch) {
      //   Simulate concurrent writer stealing the row
      const cur = db._state.get('E-13');
      if (cur && (cur.tracking_no == null || cur.tracking_no === '')) cur.tracking_no = 'RACE-WINNER';
      return origUpdate(patch);
    };
    return q;
  };
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  //   Observer sees the atomic predicate return 0 rows · classifies as
  //   ALREADY_KNOWN_OR_RACED · does not overwrite
  assert.equal(r.counters.already_known_or_raced, 1);
  assert.equal(r.counters.inserted, 0);
  //   Race winner survives
  assert.equal(db._state.get('E-13').tracking_no, 'RACE-WINNER');
});

test('BH-T14 · observer NEVER writes orders.status', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [
      orderXml({ orderId: 'E-14a', transactions: [{ tracking: [{ number: 'A', carrier: 'X' }] }] }),
      orderXml({ orderId: 'E-14b', transactions: [{ tracking: [] }] }),
      orderXml({ orderId: 'E-14c', transactions: [{ tracking: [{ number: 'B1', carrier: 'X' }, { number: 'B2', carrier: 'Y' }] }] }),
    ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [
    { order_no: 'E-14a', platform: 'eBay', tracking_no: null, status: 'NEW' },
    { order_no: 'E-14b', platform: 'eBay', tracking_no: null, status: 'NEW' },
    { order_no: 'E-14c', platform: 'eBay', tracking_no: null, status: 'NEW' },
  ]});
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(db._writes.statusWrites.length, 0, 'observer must never write status');
  //   Also verify state unchanged
  assert.equal(db._state.get('E-14a').status, 'NEW');
  assert.equal(db._state.get('E-14b').status, 'NEW');
  assert.equal(db._state.get('E-14c').status, 'NEW');
});

test('BH-T15 · observer NEVER writes orders.carrier', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'E-15', transactions: [{ tracking: [{ number: 'FIF', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'E-15', platform: 'eBay', tracking_no: null, carrier: 'KPL', status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ["SHIPPED","READY","NEW"], deps: { ebay, db } });
  assert.equal(r.counters.inserted, 1);
  assert.equal(db._writes.carrierWrites.length, 0, 'observer must never write carrier');
  //   PMC carrier stays KPL · eBay ShippingCarrierUsed=SF Express NOT propagated
  assert.equal(db._state.get('E-15').carrier, 'KPL');
});

// ─────────────────────────────────────────────────────────────────────
// R2-SHIP-6F1B-S · SHIPPED-only controlled activation tests
// ─────────────────────────────────────────────────────────────────────

test('BH-S1 · SHIPPED + DB tracking NULL + one eBay tracking → INSERTED', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-1', transactions: [{ tracking: [{ number: 'SF-S1', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-1', platform: 'eBay', tracking_no: null, status: 'SHIPPED', carrier: 'KPL' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.inserted, 1);
  assert.equal(db._state.get('S-1').tracking_no, 'SF-S1');
  assert.equal(db._state.get('S-1').tracking_source, TRACKING_SOURCE);
});

test('BH-S2 · READY + DB tracking NULL + one eBay tracking → NOT_ELIGIBLE_STATUS · writes 0', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-2', transactions: [{ tracking: [{ number: 'SF-S2', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-2', platform: 'eBay', tracking_no: null, status: 'READY' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.not_eligible_status, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('S-2').tracking_no, null);
  assert.equal(db._state.get('S-2').status, 'READY', 'status not touched');
});

test('BH-S3 · NEW + DB tracking NULL + one eBay tracking → NOT_ELIGIBLE_STATUS · writes 0', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-3', transactions: [{ tracking: [{ number: 'SF-S3', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-3', platform: 'eBay', tracking_no: null, status: 'NEW' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.not_eligible_status, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('S-3').tracking_no, null);
});

test('BH-S4 · dryRun=false WITHOUT eligibleStatuses → MUTATION_SCOPE_REQUIRED · writes 0', async () => {
  const ebay = makeEbayStub({ pages: [] });
  const db = makeDbStub({ rows: [{ order_no: 'S-4', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, deps: { ebay, db } });
  assert.equal(r.counters.outcome, OUTCOME.MUTATION_SCOPE_REQUIRED);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._writes.updateCalls.length, 0);
  assert.equal(ebay.calls.length, 0, 'MUTATION_SCOPE_REQUIRED returns before eBay is called');
});

test('BH-S5 · status changes SHIPPED → READY between fetch and UPDATE → 0 rows · no overwrite', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-5', transactions: [{ tracking: [{ number: 'SF-S5', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-5', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  //   Inject race: flip status to READY between fetch and update
  const origFrom = db.from.bind(db);
  db.from = function(table) {
    const q = origFrom(table);
    //   OMS-SHIP-EVIDENCE-E1 · only the legacy `orders` table exposes .update;
    //   oms_orders / channel_order_events branches don't and would crash the
    //   race-simulating wrapper. Guard preserves the intent (race is on legacy).
    if (typeof q.update !== 'function') return q;
    const origUpdate = q.update.bind(q);
    q.update = function(patch) {
      const cur = db._state.get('S-5');
      if (cur && cur.status === 'SHIPPED') cur.status = 'READY';
      return origUpdate(patch);
    };
    return q;
  };
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.already_known_or_raced, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('S-5').tracking_no, null, 'no overwrite when status raced');
});

test('BH-S6 · tracking populated by another writer before UPDATE → 0 rows · preserve winner', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-6', transactions: [{ tracking: [{ number: 'SF-S6', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-6', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const origFrom = db.from.bind(db);
  db.from = function(table) {
    const q = origFrom(table);
    //   OMS-SHIP-EVIDENCE-E1 · only the legacy `orders` table exposes .update;
    //   oms_orders / channel_order_events branches don't and would crash the
    //   race-simulating wrapper. Guard preserves the intent (race is on legacy).
    if (typeof q.update !== 'function') return q;
    const origUpdate = q.update.bind(q);
    q.update = function(patch) {
      const cur = db._state.get('S-6');
      if (cur && (cur.tracking_no == null || cur.tracking_no === '')) cur.tracking_no = 'RACE-WON';
      return origUpdate(patch);
    };
    return q;
  };
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.already_known_or_raced, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('S-6').tracking_no, 'RACE-WON');
});

test('BH-S7 · multi-package SHIPPED → MULTI_PACKAGE · writes 0', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({
      orderId: 'S-7',
      transactions: [
        { tracking: [{ number: 'PKG-A', carrier: 'SF' }] },
        { tracking: [{ number: 'PKG-B', carrier: 'FedEx' }] },
      ],
    }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-7', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.multi_package, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('S-7').tracking_no, null);
});

test('BH-S8 · SHIPPED with existing DIFFERENT tracking → CONFLICT · writes 0', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-8', transactions: [{ tracking: [{ number: 'EBAY-NEW', carrier: 'SF' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-8', platform: 'eBay', tracking_no: 'DB-OLD', status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.conflict, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._state.get('S-8').tracking_no, 'DB-OLD');
});

test('BH-S9 · SHIPPED positive insert · status + carrier unchanged', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [ orderXml({ orderId: 'S-9', transactions: [{ tracking: [{ number: 'SF-S9', carrier: 'SF Express' }] }] }) ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [{ order_no: 'S-9', platform: 'eBay', tracking_no: null, status: 'SHIPPED', carrier: 'KPL' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.inserted, 1);
  assert.equal(db._state.get('S-9').status, 'SHIPPED', 'status untouched');
  assert.equal(db._state.get('S-9').carrier, 'KPL', 'carrier untouched');
  assert.equal(db._writes.statusWrites.length, 0);
  assert.equal(db._writes.carrierWrites.length, 0);
});

test('BH-S10 · dryRun=true broad observation · READY/NEW reported · writes 0', async () => {
  const xml = makeGetOrdersXml({
    pages: 1,
    orderBlocks: [
      orderXml({ orderId: 'S-10a', transactions: [{ tracking: [{ number: 'TA', carrier: 'X' }] }] }),
      orderXml({ orderId: 'S-10b', transactions: [{ tracking: [{ number: 'TB', carrier: 'X' }] }] }),
      orderXml({ orderId: 'S-10c', transactions: [{ tracking: [{ number: 'TC', carrier: 'X' }] }] }),
    ],
  });
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeDbStub({ rows: [
    { order_no: 'S-10a', platform: 'eBay', tracking_no: null, status: 'SHIPPED' },
    { order_no: 'S-10b', platform: 'eBay', tracking_no: null, status: 'READY' },
    { order_no: 'S-10c', platform: 'eBay', tracking_no: null, status: 'NEW' },
  ]});
  //   dryRun=true WITHOUT eligibleStatuses = broad reporting (no scope filter)
  const r = await observer.run({ dryRun: true, deps: { ebay, db } });
  //   All 3 are safe_insert_candidates in dry-run mode
  assert.equal(r.counters.safe_insert_candidates, 3);
  assert.equal(r.counters.not_eligible_status, 0);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._writes.updateCalls.length, 0, 'dryRun writes 0');
  //   All 3 rows unchanged
  assert.equal(db._state.get('S-10a').tracking_no, null);
  assert.equal(db._state.get('S-10b').tracking_no, null);
  assert.equal(db._state.get('S-10c').tracking_no, null);
});
