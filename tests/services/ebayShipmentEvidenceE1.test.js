'use strict';

/**
 * tests/services/ebayShipmentEvidenceE1.test.js — OMS-SHIP-EVIDENCE-E1 (2026-09-06).
 *
 * Behavioral suite for eBay shipment-evidence persistence:
 *
 *   · Extended parser retains raw_order_status / shipped_time_raw / paid_time_raw /
 *     cancel_status_raw / trackings[] per <Order>
 *   · Neutral evidence persists into `channel_order_events` (mig 080) with
 *     event_type='shipment_evidence' · deterministic payload_hash
 *   · SAME external fact → SAME payload_hash across runs (fetched_at MUST NOT
 *     be in the hash · owner rule §7, §8)
 *   · OMS identity resolution: EXACT match only · unlinked/ambiguous surfaced
 *   · Evidence-first ordering: per-order evidence failure blocks that order's
 *     legacy tracking write (owner rule §23 conservative contract) · other
 *     orders unaffected
 *   · dryRun=true → zero writes (evidence + legacy both suppressed)
 *   · Duplicate observation → ON CONFLICT DO NOTHING (23505 benign)
 *   · MULTI_PACKAGE → full trackings[] persisted · legacy scalar write blocked
 *   · Fetch-all-first: RUN_INCOMPLETE → zero evidence + zero legacy writes
 *   · OPS-BRIEF-1A/B semantics UNCHANGED · R2-SHIP-6F1C-D contract UNCHANGED
 *
 * All tests use fabricated synthetic XML + in-memory DB stub. No real eBay,
 * no real Supabase writes.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const crypto  = require('node:crypto');
const fs      = require('node:fs');
const path    = require('node:path');

const observer = require('../../src/services/ebayTrackingObserver');
const shipEv   = require('../../src/services/oms/ebayShipmentEvidence');
const { OUTCOME, ORDER_CLASS, WRITE_OUTCOME } = observer._internals;

// ─────────────────────────────────────────────────────────────────────
// Synthetic XML fixtures · PII-free
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

//   Rich order XML including all evidence fields E1 parses.
function orderXmlRich({ orderId, orderStatus = 'Completed', shippedTime = '', paidTime = '', cancelStatus = '', transactions = [] }) {
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
            <OrderStatus>${orderStatus}</OrderStatus>
            ${shippedTime  ? `<ShippedTime>${shippedTime}</ShippedTime>` : ''}
            ${paidTime     ? `<PaidTime>${paidTime}</PaidTime>` : ''}
            ${cancelStatus ? `<CancelStatus>${cancelStatus}</CancelStatus>` : ''}
            <TransactionArray>${txns}</TransactionArray>
          </Order>`;
}

// ─────────────────────────────────────────────────────────────────────
// DB stub · models orders + oms_orders + channel_order_events
// ─────────────────────────────────────────────────────────────────────

function makeStub({ orders = [], omsRows = [], evidenceRows = [], evidenceFailOn = null } = {}) {
  const orderState = new Map();
  const omsState   = new Map();  // key: external_order_id → array of rows
  const evidence   = new Map();  // key: `${channel}|${payload_hash}` → row
  const upd        = { updateCalls: [], statusWrites: [], carrierWrites: [] };
  const evidenceInserts = [];
  orders.forEach(r => orderState.set(r.order_no, { ...r }));
  omsRows.forEach(r => {
    const list = omsState.get(r.external_order_id) || [];
    list.push({ ...r });
    omsState.set(r.external_order_id, list);
  });
  evidenceRows.forEach(r => evidence.set(`${r.channel}|${r.payload_hash}`, { ...r }));

  return {
    from(table) {
      if (table === 'oms_orders') {
        const filters = [];
        const q = {
          select() { return q; },
          eq(col, val) { filters.push({ col, val }); return q; },
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
      if (table === 'channel_order_events') {
        return {
          insert(row) {
            const chain = {
              select() { return chain; },
              async then(resolve) {
                evidenceInserts.push({ ...row });
                if (evidenceFailOn && evidenceFailOn(row)) {
                  resolve({ data: null, error: { code: 'FAKE_INFRA', message: 'simulated evidence infra failure' } });
                  return;
                }
                const key = `${row.channel}|${row.payload_hash}`;
                if (evidence.has(key)) {
                  resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
                  return;
                }
                const idNext = evidence.size + 1;
                evidence.set(key, { ...row, id: idNext });
                resolve({ data: [{ id: idNext }], error: null });
              },
            };
            return chain;
          },
        };
      }
      // orders (legacy)
      const orderFilters = [];
      const selQ = {
        select() { return selQ; },
        eq(col, val) { orderFilters.push({ op: 'eq', col, val }); return selQ; },
        in(col, vals) { orderFilters.push({ op: 'in', col, vals }); return selQ; },
        or(str) { orderFilters.push({ op: 'or', str }); return selQ; },
        async then(resolve) {
          const platformFilter = orderFilters.find(f => f.op === 'eq' && f.col === 'platform');
          const inFilter       = orderFilters.find(f => f.op === 'in' && f.col === 'order_no');
          const wantSet        = inFilter ? new Set(inFilter.vals) : null;
          const result = [];
          for (const r of orderState.values()) {
            if (platformFilter && r.platform !== platformFilter.val) continue;
            if (wantSet && !wantSet.has(r.order_no)) continue;
            result.push({ order_no: r.order_no, platform: r.platform, tracking_no: r.tracking_no, status: r.status });
          }
          resolve({ data: result, error: null });
        },
      };
      const updateChain = (patch) => {
        const filters = [];
        const chain = {
          eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
          in(col, vals) { filters.push({ op: 'in', col, vals }); return chain; },
          or(str) { filters.push({ op: 'or', str }); return chain; },
          select() { return chain; },
          async then(resolve) {
            upd.updateCalls.push({ table, patch, filters });
            if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
              upd.statusWrites.push({ table, status: patch.status });
            }
            if (patch && Object.prototype.hasOwnProperty.call(patch, 'carrier')) {
              upd.carrierWrites.push({ table, carrier: patch.carrier });
            }
            const orderNoFilter  = filters.find(f => f.op === 'eq' && f.col === 'order_no');
            const platformFilter = filters.find(f => f.op === 'eq' && f.col === 'platform');
            const orFilter       = filters.find(f => f.op === 'or');
            const statusInFilter = filters.find(f => f.op === 'in' && f.col === 'status');
            if (!orderNoFilter || !platformFilter) { resolve({ data: [], error: null }); return; }
            const row = orderState.get(orderNoFilter.val);
            if (!row) { resolve({ data: [], error: null }); return; }
            if (row.platform !== platformFilter.val) { resolve({ data: [], error: null }); return; }
            if (orFilter) {
              const tn = row.tracking_no;
              if (!(tn == null || tn === '')) { resolve({ data: [], error: null }); return; }
            }
            if (statusInFilter && !statusInFilter.vals.includes(row.status)) { resolve({ data: [], error: null }); return; }
            Object.assign(row, patch);
            resolve({ data: [{ order_no: row.order_no, tracking_no: row.tracking_no }], error: null });
          },
        };
        return chain;
      };
      return { select: () => selQ, update: (patch) => updateChain(patch) };
    },
    _orders: orderState,
    _oms: omsState,
    _evidence: evidence,
    _evidenceInserts: evidenceInserts,
    _writes: upd,
  };
}

function makeEbayStub({ pages = [], throwOnPage = null } = {}) {
  const calls = [];
  return {
    calls,
    async callTradingAPI(callName, body) {
      calls.push({ callName, body });
      const m = body.match(/<PageNumber>(\d+)<\/PageNumber>/);
      const page = m ? parseInt(m[1], 10) : 1;
      if (throwOnPage != null && page === throwOnPage) throw new Error('SIMULATED_NETWORK_ERROR');
      const xml = pages[page - 1];
      if (xml == null) throw new Error(`test bug · no fixture for page ${page}`);
      return xml;
    },
  };
}

// ═════════════════════════════════════════════════════════════════════
// EVIDENCE HELPER PURE-FUNCTION TESTS
// ═════════════════════════════════════════════════════════════════════

test('HELPER · canonical shape stable · minimal · PII-free', () => {
  const c = shipEv.buildEvidenceCanonical({
    orderId: 'E-1', rawOrderStatus: 'Completed',
    shippedTimeRaw: '2026-09-06T01:00:00Z', paidTimeRaw: '2026-09-05T22:00:00Z',
    cancelStatusRaw: null,
    trackings: [{ number: 'SF-A', carrier: 'SF Express' }],
  });
  assert.deepEqual(Object.keys(c).sort(),
    ['cancel_status_raw','observed_via','order_id','paid_time_raw','raw_order_status','shipped_time_raw','trackings']);
  //   Absolutely no buyer / address / phone / email fields present
  const asStr = JSON.stringify(c);
  assert.equal(/buyer|email|phone|address|street|zip|city|state|country/i.test(asStr), false);
});

test('HELPER · empty/whitespace values → null (never invented)', () => {
  const c = shipEv.buildEvidenceCanonical({
    orderId: 'E-2', rawOrderStatus: '   ',
    shippedTimeRaw: '', paidTimeRaw: null, cancelStatusRaw: '',
    trackings: [],
  });
  assert.equal(c.raw_order_status,  null);
  assert.equal(c.shipped_time_raw,  null);
  assert.equal(c.paid_time_raw,     null);
  assert.equal(c.cancel_status_raw, null);
  assert.deepEqual(c.trackings, []);
});

test('HELPER · trackings deduplicated + sorted deterministically', () => {
  const a = shipEv.buildEvidenceCanonical({
    orderId: 'E-3', trackings: [
      { number: 'ZZZ', carrier: 'C1' },
      { number: 'AAA', carrier: 'C2' },
      { number: 'ZZZ', carrier: 'C1' },  // duplicate
    ],
  });
  const b = shipEv.buildEvidenceCanonical({
    orderId: 'E-3', trackings: [
      { number: 'AAA', carrier: 'C2' },
      { number: 'ZZZ', carrier: 'C1' },
    ],
  });
  assert.deepEqual(a.trackings, b.trackings);
  assert.equal(a.trackings[0].number, 'AAA'); // sorted lexical
  assert.equal(a.trackings[1].number, 'ZZZ');
});

test('HELPER · tracking numbers text-only (no numeric coercion)', () => {
  const c = shipEv.buildEvidenceCanonical({
    orderId: 'E-4', trackings: [{ number: 871151747955, carrier: 'X' }],
  });
  assert.equal(typeof c.trackings[0].number, 'string');
  assert.equal(c.trackings[0].number, '871151747955');
});

test('HELPER · hash is deterministic sha256 · same input → same hash', () => {
  const canonical = shipEv.buildEvidenceCanonical({
    orderId: 'H-1', rawOrderStatus: 'Completed',
    shippedTimeRaw: '2026-09-06T01:00:00Z', paidTimeRaw: '2026-09-05T22:00:00Z',
    trackings: [{ number: 'T-1', carrier: 'X' }],
  });
  const h1 = shipEv.hashEvidence(canonical);
  const h2 = shipEv.hashEvidence(canonical);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T1 · Completed + ShippedTime + one tracking
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T1 · Completed + ShippedTime + one tracking → evidence + linked_order_id + legacy write', async () => {
  const xml = makeGetOrdersXml({ pages: 1, orderBlocks: [orderXmlRich({
    orderId: 'E-1', orderStatus: 'Completed',
    shippedTime: '2026-09-06T01:00:00Z', paidTime: '2026-09-05T22:00:00Z',
    transactions: [{ tracking: [{ number: 'SF-A', carrier: 'SF Express' }] }],
  })]});
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeStub({
    orders: [{ order_no: 'E-1', platform: 'eBay', tracking_no: null, status: 'SHIPPED', carrier: 'KPL' }],
    omsRows: [{ id: 42, channel: 'ebay', external_order_id: 'E-1' }],
  });
  const now = () => new Date('2026-09-06T12:00:00Z');
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], now, deps: { ebay, db } });

  assert.equal(r.counters.outcome, OUTCOME.RUN_COMPLETE);
  //   Evidence
  assert.equal(r.counters.evidence_inserted, 1);
  assert.equal(r.counters.evidence_duplicate, 0);
  assert.equal(r.counters.evidence_identity_unlinked, 0);
  assert.equal(r.counters.evidence_error, 0);
  //   Legacy write still succeeds
  assert.equal(r.counters.inserted, 1);
  //   Exact evidence row shape
  assert.equal(db._evidenceInserts.length, 1);
  const ev = db._evidenceInserts[0];
  assert.equal(ev.channel, 'ebay');
  assert.equal(ev.external_order_id, 'E-1');
  assert.equal(ev.event_type, 'shipment_evidence');
  assert.equal(ev.source_event_id, null);
  assert.equal(ev.processing_status, 'pending');
  assert.equal(ev.processed_at, null);
  assert.equal(ev.linked_order_id, 42);
  assert.equal(ev.raw_status, 'Completed');
  assert.equal(ev.fetched_at, '2026-09-06T12:00:00.000Z');
  assert.equal(ev.raw_payload.shipped_time_raw, '2026-09-06T01:00:00Z');
  assert.equal(ev.raw_payload.paid_time_raw,   '2026-09-05T22:00:00Z');
  assert.equal(ev.raw_payload.trackings[0].number, 'SF-A');
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T2 · tracking only / no ShippedTime → evidence stored · no OMS mutation
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T2 · tracking only · no ShippedTime → evidence stored · oms_orders NOT mutated', async () => {
  const xml = makeGetOrdersXml({ pages: 1, orderBlocks: [orderXmlRich({
    orderId: 'E-2', orderStatus: 'Completed', shippedTime: '', paidTime: '2026-09-05T22:00:00Z',
    transactions: [{ tracking: [{ number: 'T2-TN', carrier: 'X' }] }],
  })]});
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeStub({
    orders: [{ order_no: 'E-2', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }],
    omsRows: [{ id: 200, channel: 'ebay', external_order_id: 'E-2', order_status: 'ready_to_ship', shipped_at: null }],
  });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.evidence_inserted, 1);
  //   OMS row untouched (E1 does not project · E2 will)
  const omsList = db._oms.get('E-2') || [];
  assert.equal(omsList[0].order_status, 'ready_to_ship');
  assert.equal(omsList[0].shipped_at, null);
  //   Evidence records the absent ShippedTime as null (not invented)
  assert.equal(db._evidenceInserts[0].raw_payload.shipped_time_raw, null);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T3 · ShippedTime only / no tracking → evidence stored
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T3 · ShippedTime only · no tracking → evidence stored · trackings=[]', async () => {
  const xml = makeGetOrdersXml({ pages: 1, orderBlocks: [orderXmlRich({
    orderId: 'E-3', orderStatus: 'Completed', shippedTime: '2026-09-06T02:00:00Z',
    transactions: [{ tracking: [] }],
  })]});
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeStub({ orders: [{ order_no: 'E-3', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.evidence_inserted, 1);
  assert.equal(db._evidenceInserts[0].raw_payload.shipped_time_raw, '2026-09-06T02:00:00Z');
  assert.deepEqual(db._evidenceInserts[0].raw_payload.trackings, []);
  //   Legacy has nothing to write (NO_TRACKING classification)
  assert.equal(r.counters.inserted, 0);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T4 · neither tracking nor ShippedTime → evidence stored once
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T4 · no tracking + no ShippedTime → evidence still persists · UNKNOWN preserved', async () => {
  const xml = makeGetOrdersXml({ pages: 1, orderBlocks: [orderXmlRich({
    orderId: 'E-4', orderStatus: 'Completed', shippedTime: '', paidTime: '2026-09-05T22:00:00Z',
    transactions: [{ tracking: [] }],
  })]});
  const ebay = makeEbayStub({ pages: [xml] });
  const db = makeStub({ orders: [{ order_no: 'E-4', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({ dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db } });
  assert.equal(r.counters.evidence_inserted, 1);
  const ev = db._evidenceInserts[0];
  assert.equal(ev.raw_payload.shipped_time_raw, null);
  assert.equal(ev.raw_payload.trackings.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T5 · same fact twice with different fetched_at → SAME hash · 1 row
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T5 · re-observation across runs → SAME payload_hash · idempotent (1 evidence row)', async () => {
  const buildXml = () => makeGetOrdersXml({ pages: 1, orderBlocks: [orderXmlRich({
    orderId: 'E-5', orderStatus: 'Completed',
    shippedTime: '2026-09-06T01:00:00Z', paidTime: '2026-09-05T22:00:00Z',
    transactions: [{ tracking: [{ number: 'T5', carrier: 'X' }] }],
  })]});
  const db = makeStub({ orders: [{ order_no: 'E-5', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });

  //   Run 1
  const r1 = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    now: () => new Date('2026-09-06T06:00:00Z'),
    deps: { ebay: makeEbayStub({ pages: [buildXml()] }), db },
  });
  assert.equal(r1.counters.evidence_inserted, 1);
  assert.equal(r1.counters.evidence_duplicate, 0);
  const firstHash = db._evidenceInserts[0].payload_hash;

  //   Run 2 · same external fact · different fetched_at
  const r2 = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    now: () => new Date('2026-09-06T12:00:00Z'),
    deps: { ebay: makeEbayStub({ pages: [buildXml()] }), db },
  });
  assert.equal(r2.counters.evidence_inserted, 0);
  assert.equal(r2.counters.evidence_duplicate, 1, 'duplicate observation must be idempotent · not a new row');
  assert.equal(db._evidence.size, 1, 'only 1 durable evidence row');
  //   Second insert attempted with the SAME hash · confirms hash excludes fetched_at
  assert.equal(db._evidenceInserts[1].payload_hash, firstHash);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T6 · same tracking set · different XML order → SAME hash
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T6 · trackings in different XML order → SAME payload_hash', async () => {
  //   Direct hash comparison via the helper (deterministic sort inside).
  const a = shipEv.hashEvidence(shipEv.buildEvidenceCanonical({
    orderId: 'X', trackings: [
      { number: 'B', carrier: 'C1' }, { number: 'A', carrier: 'C2' },
    ],
  }));
  const b = shipEv.hashEvidence(shipEv.buildEvidenceCanonical({
    orderId: 'X', trackings: [
      { number: 'A', carrier: 'C2' }, { number: 'B', carrier: 'C1' },
    ],
  }));
  assert.equal(a, b);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T7 · new tracking added later → DIFFERENT hash → new evidence row
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T7 · new tracking added later → new evidence row', async () => {
  const db = makeStub({ orders: [{ order_no: 'E-7', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });

  //   Run 1 · one tracking
  await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    deps: { ebay: makeEbayStub({ pages: [makeGetOrdersXml({ orderBlocks: [orderXmlRich({
      orderId: 'E-7', shippedTime: '2026-09-06T01:00:00Z',
      transactions: [{ tracking: [{ number: 'FIRST', carrier: 'X' }] }],
    })] })] }), db },
  });

  //   Run 2 · new tracking added
  const r2 = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    deps: { ebay: makeEbayStub({ pages: [makeGetOrdersXml({ orderBlocks: [orderXmlRich({
      orderId: 'E-7', shippedTime: '2026-09-06T01:00:00Z',
      transactions: [{ tracking: [{ number: 'FIRST', carrier: 'X' }, { number: 'SECOND', carrier: 'Y' }] }],
    })] })] }), db },
  });
  assert.equal(r2.counters.evidence_inserted, 1, 'new tracking → new hash → new evidence row');
  assert.equal(db._evidence.size, 2);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T8 · ShippedTime null → value → DIFFERENT hash → new row
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T8 · ShippedTime null → truthy across runs → new evidence row', async () => {
  const db = makeStub({ orders: [{ order_no: 'E-8', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });

  await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    deps: { ebay: makeEbayStub({ pages: [makeGetOrdersXml({ orderBlocks: [orderXmlRich({
      orderId: 'E-8', shippedTime: '', transactions: [{ tracking: [{ number: 'T8', carrier: 'X' }] }],
    })] })] }), db },
  });
  const r2 = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    deps: { ebay: makeEbayStub({ pages: [makeGetOrdersXml({ orderBlocks: [orderXmlRich({
      orderId: 'E-8', shippedTime: '2026-09-06T05:00:00Z',
      transactions: [{ tracking: [{ number: 'T8', carrier: 'X' }] }],
    })] })] }), db },
  });
  assert.equal(r2.counters.evidence_inserted, 1);
  assert.equal(db._evidence.size, 2);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T9 · MULTI_PACKAGE → full trackings persisted · legacy scalar 0
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T9 · multi-package → trackings[] all preserved · legacy scalar write=0', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-9', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [
      { number: 'PKG-A', carrier: 'X' },
      { number: 'PKG-B', carrier: 'Y' },
      { number: 'PKG-C', carrier: 'Z' },
    ]}],
  })]});
  const db = makeStub({ orders: [{ order_no: 'E-9', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  assert.equal(r.counters.evidence_inserted, 1);
  assert.equal(db._evidenceInserts[0].raw_payload.trackings.length, 3);
  //   Legacy classifies MULTI_PACKAGE · scalar tracking write = 0 (unchanged)
  assert.equal(r.counters.multi_package, 1);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._orders.get('E-9').tracking_no, null);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T10 · unknown OMS identity → evidence still persists · linked=null
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T10 · no matching OMS row → linked_order_id=null · counter surfaced', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-10', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [{ number: 'T10', carrier: 'X' }] }],
  })]});
  const db = makeStub({
    orders: [{ order_no: 'E-10', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }],
    omsRows: [], // no OMS row for E-10
  });
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  assert.equal(r.counters.evidence_inserted, 1);
  assert.equal(r.counters.evidence_identity_unlinked, 1);
  assert.equal(db._evidenceInserts[0].linked_order_id, null);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T11 · non-eBay OMS row with same external_order_id → MUST NOT link
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T11 · same external_order_id under different channel → MUST NOT link', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'X-11', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [{ number: 'T11', carrier: 'X' }] }],
  })]});
  const db = makeStub({
    orders: [{ order_no: 'X-11', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }],
    omsRows: [{ id: 999, channel: 'shopify', external_order_id: 'X-11' }], // wrong channel
  });
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  assert.equal(r.counters.evidence_identity_unlinked, 1);
  assert.equal(db._evidenceInserts[0].linked_order_id, null,
    'cross-channel external_order_id collision must not link to shopify row');
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T12 · API error page 1 → evidence 0 · legacy 0 (RUN_INCOMPLETE)
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T12 · page 1 error → RUN_INCOMPLETE → 0 evidence · 0 legacy', async () => {
  const ebay = makeEbayStub({ pages: [], throwOnPage: 1 });
  const db = makeStub({ orders: [{ order_no: 'E-12', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db },
  });
  assert.equal(r.counters.outcome, OUTCOME.RUN_INCOMPLETE);
  assert.equal(r.counters.evidence_inserted, 0);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._evidence.size, 0);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T13 · API error middle page → evidence 0 · legacy 0
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T13 · middle-page error → RUN_INCOMPLETE → 0 evidence · 0 legacy', async () => {
  const page1 = makeGetOrdersXml({ pages: 3, orderBlocks: [orderXmlRich({ orderId: 'E-13-A', shippedTime: '2026-09-06T01:00:00Z', transactions: [{ tracking: [{ number: 'T13A', carrier: 'X' }] }] })] });
  const ebay = makeEbayStub({ pages: [page1], throwOnPage: 2 });
  const db = makeStub({ orders: [{ order_no: 'E-13-A', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay, db },
  });
  assert.equal(r.counters.outcome, OUTCOME.RUN_INCOMPLETE);
  assert.equal(r.counters.evidence_inserted, 0);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._evidence.size, 0);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T14 · dryRun=true → evidence 0 · legacy 0
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T14 · dryRun=true → observation happens · 0 evidence writes · 0 legacy writes', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-14', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [{ number: 'T14', carrier: 'X' }] }],
  })]});
  const db = makeStub({ orders: [{ order_no: 'E-14', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });
  const r = await observer.run({
    dryRun: true, deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  assert.equal(r.counters.outcome, OUTCOME.RUN_COMPLETE);
  assert.equal(r.counters.evidence_inserted, 0);
  assert.equal(r.counters.inserted, 0);
  assert.equal(db._evidence.size, 0);
  assert.equal(db._evidenceInserts.length, 0);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T15 · pre-existing identical evidence → ON CONFLICT benign
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T15 · pre-existing identical evidence hash → duplicate benign · 0 new rows', async () => {
  const canonical = shipEv.buildEvidenceCanonical({
    orderId: 'E-15', rawOrderStatus: 'Completed',
    shippedTimeRaw: '2026-09-06T01:00:00Z', paidTimeRaw: null,
    trackings: [{ number: 'T15', carrier: 'X' }],
  });
  const preHash = shipEv.hashEvidence(canonical);
  const db = makeStub({
    orders: [{ order_no: 'E-15', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }],
    evidenceRows: [{ channel: 'ebay', payload_hash: preHash, event_type: 'shipment_evidence' }],
  });
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-15', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [{ number: 'T15', carrier: 'X' }] }],
  })]});
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  assert.equal(r.counters.evidence_duplicate, 1);
  assert.equal(r.counters.evidence_inserted, 0);
  assert.equal(r.counters.evidence_error, 0);
  //   Legacy write still proceeds (evidence didn't fail · duplicate is benign)
  assert.equal(r.counters.inserted, 1);
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T16 · Payload hash excludes fetched_at / runtime
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T16 · payload hash excludes fetched_at (structural)', () => {
  //   Structural: the helper file's hashEvidence function inputs must NOT
  //   reference fetched_at / imported_at / runtime keys.
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/oms/ebayShipmentEvidence.js'), 'utf8'
  );
  //   Isolate hashEvidence body strictly: from its opening `{` to the matching
  //   top-level closing `}` (brace-counting). Regex boundary-matching mis-
  //   selects when neighboring functions use `async function` syntax.
  const start = src.indexOf('function hashEvidence(');
  assert.ok(start >= 0);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start);
  const body = src.slice(braceOpen, end + 1);
  //   Body must NOT reference runtime timestamps.
  assert.equal(/fetched_at/.test(body), false, 'hashEvidence must not reference fetched_at');
  assert.equal(/imported_at/.test(body), false, 'hashEvidence must not reference imported_at');
  assert.equal(/new Date\(/.test(body), false, 'hashEvidence must not construct a new Date()');
  assert.equal(/Date\.now\(/.test(body), false, 'hashEvidence must not read Date.now()');
});

test('EVID-E1-T16b · behavioral: same canonical → same hash across different fetched_at runs', async () => {
  const buildXml = () => makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-16', orderStatus: 'Completed',
    shippedTime: '2026-09-06T01:00:00Z', paidTime: null,
    transactions: [{ tracking: [{ number: 'T16', carrier: 'X' }] }],
  })]});
  const db = makeStub({ orders: [{ order_no: 'E-16', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }] });

  await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    now: () => new Date('2026-01-01T00:00:00Z'),
    deps: { ebay: makeEbayStub({ pages: [buildXml()] }), db },
  });
  await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'],
    now: () => new Date('2026-12-31T23:59:59Z'),
    deps: { ebay: makeEbayStub({ pages: [buildXml()] }), db },
  });
  assert.equal(db._evidence.size, 1, 'same external fact across different runs must yield ONE evidence row');
  const [insert1, insert2] = db._evidenceInserts;
  assert.equal(insert1.payload_hash, insert2.payload_hash);
  assert.notEqual(insert1.fetched_at, insert2.fetched_at, 'fetched_at DID vary · hash did not');
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T17 · Observer never writes oms_orders status/shipped_at
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T17 · observer never writes oms_orders.order_status / shipped_at', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-17', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [{ number: 'T17', carrier: 'X' }] }],
  })]});
  const db = makeStub({
    orders: [{ order_no: 'E-17', platform: 'eBay', tracking_no: null, status: 'SHIPPED' }],
    omsRows: [{ id: 17, channel: 'ebay', external_order_id: 'E-17', order_status: 'ready_to_ship', shipped_at: null }],
  });
  await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  const oms = (db._oms.get('E-17') || [])[0];
  assert.equal(oms.order_status, 'ready_to_ship', 'oms order_status UNCHANGED · E1 does not project');
  assert.equal(oms.shipped_at, null, 'oms shipped_at UNCHANGED · E1 does not project');
  //   Structural: observer source must contain zero .update() on oms_orders
  const observerSrc = fs.readFileSync(path.resolve(__dirname, '../../src/services/ebayTrackingObserver.js'), 'utf8');
  assert.equal(/from\(\s*['"]oms_orders['"]\s*\)[\s\S]{0,200}\.update\(/.test(observerSrc), false,
    'observer MUST NOT call .update on oms_orders');
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T18 · Observer never writes legacy status/carrier
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1-T18 · observer never writes orders.status / orders.carrier (R2-SHIP frozen)', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [orderXmlRich({
    orderId: 'E-18', shippedTime: '2026-09-06T01:00:00Z',
    transactions: [{ tracking: [{ number: 'T18', carrier: 'X' }] }],
  })]});
  const db = makeStub({
    orders: [{ order_no: 'E-18', platform: 'eBay', tracking_no: null, status: 'SHIPPED', carrier: 'KPL' }],
  });
  await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  assert.equal(db._writes.statusWrites.length, 0);
  assert.equal(db._writes.carrierWrites.length, 0);
  assert.equal(db._orders.get('E-18').status, 'SHIPPED');
  assert.equal(db._orders.get('E-18').carrier, 'KPL');
});

// ═════════════════════════════════════════════════════════════════════
// EVID-E1-T-EVIDENCE-FAILURE-BLOCKS-LEGACY · per-order isolation (§23)
// ═════════════════════════════════════════════════════════════════════

test('EVID-E1 · evidence persistence failure for order X → legacy skipped for X · other orders unaffected', async () => {
  const xml = makeGetOrdersXml({ orderBlocks: [
    orderXmlRich({ orderId: 'GOOD', shippedTime: '2026-09-06T01:00:00Z',
      transactions: [{ tracking: [{ number: 'T-GOOD', carrier: 'X' }] }] }),
    orderXmlRich({ orderId: 'BAD', shippedTime: '2026-09-06T02:00:00Z',
      transactions: [{ tracking: [{ number: 'T-BAD', carrier: 'X' }] }] }),
  ]});
  const db = makeStub({
    orders: [
      { order_no: 'GOOD', platform: 'eBay', tracking_no: null, status: 'SHIPPED' },
      { order_no: 'BAD',  platform: 'eBay', tracking_no: null, status: 'SHIPPED' },
    ],
    //   Force evidence insert failure ONLY for BAD.
    evidenceFailOn: (row) => row.external_order_id === 'BAD',
  });
  const r = await observer.run({
    dryRun: false, eligibleStatuses: ['SHIPPED'], deps: { ebay: makeEbayStub({ pages: [xml] }), db },
  });
  //   GOOD: evidence + legacy both succeed
  assert.equal(r.counters.evidence_inserted, 1);
  assert.equal(r.counters.evidence_error, 1);
  assert.equal(r.counters.inserted, 1, 'only GOOD gets legacy write');
  assert.equal(r.counters.legacy_skipped_due_to_evidence, 1, 'BAD legacy skipped due to evidence failure');
  assert.equal(db._orders.get('GOOD').tracking_no, 'T-GOOD');
  assert.equal(db._orders.get('BAD').tracking_no, null, 'BAD legacy unchanged · evidence-first ordering enforced');
});
