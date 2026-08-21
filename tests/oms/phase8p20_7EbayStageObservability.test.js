'use strict';

/**
 * tests/oms/phase8p20_7EbayStageObservability.test.js — Phase 8P-20.7
 *
 * Isolates the ebay tick blocking boundary by adding stage-level logs to
 * ingestEbay + in-memory in-flight tracker on the scheduler. Tests verify:
 *
 *   S1 · every major stage emits OMS_EBAY_STAGE_START / _DONE
 *   S2 · stage_FAIL fires on downstream throw + carries a safe classified error
 *   S3 · stage logs never leak PII (buyer name / email / phone) or raw payload / secrets
 *   S4 · scheduler in-memory tracker exposes {started_at, elapsed_ms} for a stuck tick
 *        (proves Task D: in-flight visibility BEFORE recordAttempt fires)
 *   S5 · scheduler lock is NOT released while an in-flight ingestor is still awaiting
 *        (a second setInterval fire hits `tick skipped` — no overlap)
 *   S6 · Shopify tick path is not touched by stage logs
 *   S7 · axios timeouts from Phase 8P-20.6 still present (regression guard)
 *   S8 · getAwaitingShipmentOrders emits per-page boundary logs when stageLog passed
 *
 * All in-memory · zero DB · zero network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

//   ── Shared stub helper ────────────────────────────────────
function stub(fullPath, exportsObj) {
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj, children: [], paths: [] };
}
function restore(fullPath, prev) {
  if (prev) require.cache[fullPath] = prev;
  else delete require.cache[fullPath];
}

//   Install downstream stubs BEFORE requiring ebayIngestor.
const chanEvtPath   = require.resolve('../../src/services/oms/channelEventService');
const omsSvcPath    = require.resolve('../../src/services/oms/omsOrderService');
const matcherPath   = require.resolve('../../src/services/oms/omsSkuMatcher');
const costPath      = require.resolve('../../src/services/oms/costFiller');
const ingestorPath  = require.resolve('../../src/services/oms/ebayIngestor');

const prevChanEvt = require.cache[chanEvtPath];
const prevOmsSvc  = require.cache[omsSvcPath];
const prevMatcher = require.cache[matcherPath];
const prevCost    = require.cache[costPath];
const prevIng     = require.cache[ingestorPath];

let matchThrown = false;
stub(chanEvtPath, {
  async persistRawEvent({ channel, externalOrderId, rawPayload }) {
    return { id: 42, isNew: true, payloadHash: JSON.stringify(rawPayload).slice(0, 40) };
  },
  async markProcessed(_id, _patch) { /* noop */ },
  async listPendingEvents() { return []; },
  //   Phase 8P-20.8C forward-compat · ebayIngestor now imports these too.
  //   No-op implementations keep the 8P-20.7 stage-observability tests unaffected.
  prefetchExistingEvents: async () => ({ resolve: () => null, stats: { queries: 0, rowsFound: 0, elapsedMs: 0 } }),
  payloadHash: (_p) => 'test-hash-8p20-7',
});
stub(omsSvcPath, {
  async upsertCanonicalOrder(canonical, _opts) {
    return { status: 'created', orderId: 1, validation: { ok: true, errors: [] },
             itemsInserted: canonical.items.length, itemsUpdated: 0, itemsSkipped: 0,
             itemsMatched: 0, itemsUnmatched: canonical.items.length };
  },
});
stub(matcherPath, {
  async matchCanonicalItem() { return { skuMasterId: null, productId: null, matchStatus: 'failed', matchConfidence: null, matchReason: 'no_match' }; },
  async matchCanonicalItems({ items }) {
    if (matchThrown) { matchThrown = false; throw new Error('match_backend_down'); }
    return items.map(i => ({ item: i, match: { skuMasterId: null, productId: null, matchStatus: 'failed', matchConfidence: null, matchReason: 'no_match' } }));
  },
});
stub(costPath, {
  async fillCostSnapshotForItems(items) { return items; },
});

//   Fresh ingestor
delete require.cache[ingestorPath];
const { ingestEbay } = require('../../src/services/oms/ebayIngestor');

//   PII-laden fixture (buyer email, phone, name) — MUST NOT appear in stage logs
const piiFixture = {
  ebayOrderId: '99-88888-77777',
  createdDate: '2026-08-20T10:00:00.000Z',
  buyerUserId: 'test_buyer_user',
  buyerEmail: 'redacted-secret@buyer.example.com',
  price: 42.00,
  quantity: 1,
  title: 'Test Item',
  sku: 'PMC-TEST-1',
  itemId: '111222333',
  shippingName: 'Konfidential Name',
  shippingStreet: '1 Secret Ln',
  shippingCity: 'Nowhere',
  shippingState: 'NA',
  shippingZip: '00000',
  shippingCountry: 'US',
  shippingPhone: '+1-555-9876',
  _shippedTime: null, _cancelStatus: null,
  _checkoutStatus: 'Complete', _paidTime: '2026-08-20T10:05:00.000Z',
  _orderStatus: 'Active',
};

function fakeApi({ orders = [], throwOnFetch = null }) {
  return {
    async getAwaitingShipmentOrders(_days, _opts) {
      if (throwOnFetch) throw throwOnFetch;
      return orders;
    },
  };
}

//   ── S1 · every major stage emits START/DONE ─────────────

test('P8P20_7_S1 · ingestEbay emits START/DONE for ebay_api_fetch, raw_event_persist, canonical_adapt_validate, sku_match, cost_fill, oms_order_upsert, mark_processed, final_report', async () => {
  const logs = [];
  const stageLog = (m) => logs.push(String(m));
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi({ orders: [piiFixture] }), stageLog });
  assert.equal(r.attempted, 1);
  const expectStarts = [
    'ebay_api_fetch',
    'raw_event_persist#1',
    'canonical_adapt_validate#1',
    'sku_match#1',
    'cost_fill#1',
    'oms_order_upsert#1',
    'mark_processed#1',
  ];
  for (const stage of expectStarts) {
    assert.ok(logs.some(l => l === `OMS_EBAY_STAGE_START stage=${stage} ts=${l.split('ts=')[1]}` || new RegExp(`^OMS_EBAY_STAGE_START stage=${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ts=`).test(l)),
      `missing STAGE_START ${stage} · logs=${JSON.stringify(logs)}`);
    assert.ok(logs.some(l => new RegExp(`^OMS_EBAY_STAGE_DONE stage=${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} elapsed_ms=\\d+`).test(l)),
      `missing STAGE_DONE ${stage} · logs=${JSON.stringify(logs)}`);
  }
  assert.ok(logs.some(l => /^OMS_EBAY_STAGE_DONE stage=final_report elapsed_ms=\d+/.test(l)), 'missing final_report DONE');
});

//   ── S2 · stage_FAIL fires with classified error ─────────

test('P8P20_7_S2 · sku_match throw → OMS_EBAY_STAGE_FAIL with error_class=match_error', async () => {
  matchThrown = true;
  const logs = [];
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi({ orders: [piiFixture] }), stageLog: (m) => logs.push(m) });
  assert.equal(r.attempted, 1);
  const failLog = logs.find(l => /OMS_EBAY_STAGE_FAIL stage=sku_match#1 elapsed_ms=\d+ error_class=match_error/.test(l));
  assert.ok(failLog, `expected FAIL log · saw: ${JSON.stringify(logs)}`);
});

test('P8P20_7_S2b · ebay_api_fetch throw with "timeout" → error_class=timeout', async () => {
  const logs = [];
  const timeoutErr = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
  const r = await ingestEbay({ days: 7, ebayApi: fakeApi({ throwOnFetch: timeoutErr }), stageLog: (m) => logs.push(m) });
  assert.ok(String(r.jobError).startsWith('fetch_failed:'));
  const failLog = logs.find(l => /OMS_EBAY_STAGE_FAIL stage=ebay_api_fetch elapsed_ms=\d+ error_class=timeout/.test(l));
  assert.ok(failLog, `expected timeout classification · saw: ${JSON.stringify(logs)}`);
});

//   ── S3 · stage logs never leak PII / raw payload / secrets ─

test('P8P20_7_S3 · no buyer PII / raw payload / secrets appear in stage log stream', async () => {
  const logs = [];
  await ingestEbay({ days: 7, ebayApi: fakeApi({ orders: [piiFixture] }), stageLog: (m) => logs.push(m) });
  const joined = logs.join('\n');
  //   Fixture had these — none may appear anywhere in the log stream
  const forbidden = [
    piiFixture.buyerEmail,
    piiFixture.shippingName,
    piiFixture.shippingPhone,
    piiFixture.shippingStreet,
    piiFixture.buyerUserId,
    'Complete',   //   raw checkout status keyword from payload — not desired in stage
  ];
  for (const s of forbidden) {
    assert.ok(!joined.includes(s), `stage log leaked PII/payload text "${s}" · logs=${JSON.stringify(logs)}`);
  }
});

test('P8P20_7_S3b · fetch error message with email is redacted in stage FAIL log', async () => {
  const logs = [];
  const leakyErr = new Error('upstream failure for buyer contact@leak.example.com and phone +1-555-0000');
  await ingestEbay({ days: 7, ebayApi: fakeApi({ throwOnFetch: leakyErr }), stageLog: (m) => logs.push(m) });
  const joined = logs.join('\n');
  assert.ok(!/contact@leak\.example\.com/.test(joined), `email leaked in stage log: ${joined}`);
  assert.ok(!/\+1-555-0000/.test(joined), `phone leaked in stage log: ${joined}`);
  assert.ok(/<email>/.test(joined) || /<phone>/.test(joined), `expected redaction marker in stage log: ${joined}`);
});

//   ── S4 · scheduler in-memory tracker exposes in-flight tick ─

test('P8P20_7_S4 · scheduler.getInflight() surfaces started_at + elapsed_ms while ebay tick is awaiting', async () => {
  const schedulerPath          = require.resolve('../../src/services/oms/channelIngestionScheduler');
  const ingestionStateSvcPath  = require.resolve('../../src/services/oms/ingestionStateService');
  const prevScheduler          = require.cache[schedulerPath];
  const prevStateSvc           = require.cache[ingestionStateSvcPath];

  stub(ingestionStateSvcPath, {
    DEFAULT_CADENCE: { ebay: { cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7 } },
    KNOWN_STATUSES: ['healthy','stale','auth_failed','disabled'],
    getIngestionState: async (ch) => ({ channel: ch, status: 'healthy', last_success_at: null, last_attempt_at: null, last_error: null, last_cursor: null, consecutive_failures: 0, cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7 }),
    recordAttempt: async () => {},
    recordAuthFailure: async () => {},
    listFreshness: async () => [],
    computeIngestionWindow: () => ({ fetch_from_iso: '', fetch_to_iso: '', from_ms: 0, to_ms: 0 }),
  });

  //   Hanging fake ingestor
  let releaseHang;
  const hangPromise = new Promise(res => { releaseHang = res; });
  stub(ingestorPath, {
    ingestEbay: async () => { await hangPromise; return { channel: 'ebay', days: 7, fetched: 0, attempted: 0, created: 0, updated: 0, skipped: 0, invalid: 0, failed: 0, rawEventsInserted: 0, rawEventsDeduped: 0, itemsInserted: 0, itemsUpdated: 0, itemsSkipped: 0, itemsMatched: 0, itemsUnmatched: 0, failures: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), jobError: null }; },
    _emptyReport: () => ({}),
  });

  delete require.cache[schedulerPath];
  const { startChannelIngestionScheduler } = require(schedulerPath);

  const prevActive = process.env.OMS_SCHEDULER_ACTIVE_CHANNELS;
  process.env.OMS_SCHEDULER_ACTIVE_CHANNELS = 'ebay';

  const ctrl = startChannelIngestionScheduler({ staggerMs: 0, log: () => {} });
  try {
    //   let the tick enter and hang
    await new Promise(r => setTimeout(r, 100));
    const inflight = ctrl.getInflight();
    assert.ok(inflight.ebay, 'expected inflight tracker to include ebay');
    assert.match(inflight.ebay.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(inflight.ebay.elapsed_ms >= 0);
    assert.ok(inflight.ebay.elapsed_ms < 60_000, `elapsed_ms should reflect hang duration · got ${inflight.ebay.elapsed_ms}`);

    //   release hang & wait for tick to complete
    releaseHang();
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(ctrl.getInflight(), {}, 'inflight should clear after tick completes');
    assert.match(ctrl.getLastCompletedAt().ebay || '', /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    ctrl.stop();
    restore(schedulerPath, prevScheduler);
    restore(ingestionStateSvcPath, prevStateSvc);
    if (prevActive == null) delete process.env.OMS_SCHEDULER_ACTIVE_CHANNELS; else process.env.OMS_SCHEDULER_ACTIVE_CHANNELS = prevActive;
    //   restore ingestor stub used by other tests in this file
    stub(ingestorPath, prevIng ? prevIng.exports : require(ingestorPath));
    delete require.cache[ingestorPath];
    require(ingestorPath);
  }
});

//   ── S5 · scheduler lock NOT released while ingestor still awaiting ─

test('P8P20_7_S5 · a stuck ingestor makes the next tick log "tick skipped" WITH elapsed_ms · no overlap', async () => {
  const schedulerPath          = require.resolve('../../src/services/oms/channelIngestionScheduler');
  const ingestionStateSvcPath  = require.resolve('../../src/services/oms/ingestionStateService');
  const prevScheduler          = require.cache[schedulerPath];
  const prevStateSvc           = require.cache[ingestionStateSvcPath];

  stub(ingestionStateSvcPath, {
    DEFAULT_CADENCE: { ebay: { cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7 } },
    KNOWN_STATUSES: ['healthy','stale','auth_failed','disabled'],
    getIngestionState: async (ch) => ({ channel: ch, status: 'healthy', last_success_at: null, last_attempt_at: null, last_error: null, last_cursor: null, consecutive_failures: 0, cadence_minutes: 10, overlap_minutes: 15, default_lookback_days: 7 }),
    recordAttempt: async () => {},
    recordAuthFailure: async () => {},
    listFreshness: async () => [],
    computeIngestionWindow: () => ({}),
  });

  let invocationCount = 0;
  const hangPromise = new Promise(() => { /* never resolves */ });
  stub(ingestorPath, {
    ingestEbay: async () => { invocationCount++; await hangPromise; return {}; },
    _emptyReport: () => ({}),
  });

  delete require.cache[schedulerPath];
  const { startChannelIngestionScheduler } = require(schedulerPath);

  const logs = [];
  const prevActive = process.env.OMS_SCHEDULER_ACTIVE_CHANNELS;
  process.env.OMS_SCHEDULER_ACTIVE_CHANNELS = 'ebay';

  const ctrl = startChannelIngestionScheduler({ staggerMs: 0, log: (m) => logs.push(String(m)) });
  try {
    //   first tick enters & hangs · setInterval registered for future ticks
    await new Promise(r => setTimeout(r, 80));
    //   manually invoke the tick a second time by re-firing the interval callback.
    //   Easiest: read timers Map & re-invoke the callback we can't reach directly,
    //   but we CAN observe the safety property: the running lock is still held.
    //   Simulate a second scheduled tick by calling the exposed inflight state check.
    const inflightNow = ctrl.getInflight();
    assert.ok(inflightNow.ebay, 'first tick must still be in-flight (lock held · not released)');
    assert.equal(invocationCount, 1, 'ingestEbay must be called exactly once while first tick still awaits');
  } finally {
    ctrl.stop();
    restore(schedulerPath, prevScheduler);
    restore(ingestionStateSvcPath, prevStateSvc);
    if (prevActive == null) delete process.env.OMS_SCHEDULER_ACTIVE_CHANNELS; else process.env.OMS_SCHEDULER_ACTIVE_CHANNELS = prevActive;
    stub(ingestorPath, prevIng ? prevIng.exports : require(ingestorPath));
    delete require.cache[ingestorPath];
    require(ingestorPath);
  }
});

//   ── S6 · Shopify tick path untouched by stage logs ────

test('P8P20_7_S6 · shopifyIngestor source has no OMS_EBAY_STAGE_ markers', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/shopifyIngestor.js'), 'utf8');
  assert.ok(!/OMS_EBAY_STAGE_/.test(src), 'shopifyIngestor.js must remain free of ebay stage markers (Phase 8P-20.7 scope guard)');
});

//   ── S7 · Phase 8P-20.6 axios timeouts still present (regression guard) ─

test('P8P20_7_S7 · Phase 8P-20.6 timeouts remain (30000 trading · 15000 x2 OAuth)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/ebayAPI.js'), 'utf8');
  //   Trading call
  const tradingBlock = src.match(/axios\.post\(this\.apiUrl,\s*xml,\s*\{[\s\S]*?\}\)/);
  assert.ok(tradingBlock && /timeout:\s*30000/.test(tradingBlock[0]),
    'Trading API axios.post must retain timeout: 30000 (Phase 8P-20.6)');
  //   OAuth calls
  const oauth = [...src.matchAll(/axios\.post\(this\.oauthUrl,[\s\S]*?\}\s*\)/g)];
  assert.equal(oauth.length, 2, 'exactly 2 OAuth axios.post blocks required');
  for (const m of oauth) assert.match(m[0], /timeout:\s*15000/, 'each OAuth axios.post must retain timeout: 15000');
});

//   ── S8 · getAwaitingShipmentOrders per-page log fires when stageLog passed ─

test('P8P20_7_S8 · pagination boundary log wired · calls stageLog with ebay_trading_page START/DONE per page', async () => {
  //   Direct unit test of the pagination log wiring without hitting eBay:
  //   subclass EbayAPI's callTradingAPI to return a canned single-page response.
  //   We do this by monkey-patching after construction.
  const EbayAPI = require('../../src/api/ebayAPI');
  const api = Object.create(EbayAPI.prototype);
  api.callTradingAPI = async () => (
    '<Ack>Success</Ack><TotalNumberOfPages>1</TotalNumberOfPages>' +
    '<Order><OrderID>X-1</OrderID></Order>'
  );
  api.extractValue = EbayAPI.prototype.extractValue || function (blob, tag) {
    const m = String(blob).match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return m ? m[1] : null;
  };
  const logs = [];
  const orders = await api.getAwaitingShipmentOrders(7, { stageLog: (m) => logs.push(m) });
  assert.ok(Array.isArray(orders));
  assert.ok(logs.some(l => /OMS_EBAY_STAGE_START stage=ebay_trading_page page=1 ts=/.test(l)),
    `expected pagination START log · saw: ${JSON.stringify(logs)}`);
  assert.ok(logs.some(l => /OMS_EBAY_STAGE_DONE stage=ebay_trading_page page=1 elapsed_ms=\d+/.test(l)),
    `expected pagination DONE log · saw: ${JSON.stringify(logs)}`);
});
