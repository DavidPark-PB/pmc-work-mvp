'use strict';

/**
 * ebayProductEdit.test.js — Phase 1 Commit 4 unit tests
 * ---------------------------------------------------------------------------
 * Every marketplace call happens through the injected stubs; no real eBay.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../../src/services/priceExecutionGate');
const {
  executeEbayProductEdit,
} = require('../../src/services/ebayProductEditService');

/* ─────────────────────────── mocks ─────────────────────────── */

function makeDb() {
  const stockUpdates = [];
  return {
    stockUpdates,
    from(table) {
      return {
        update(patch) {
          return {
            eq(col, val) {
              if (table === 'ebay_products') {
                stockUpdates.push({ col, val, patch });
                return Promise.resolve({ error: null });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function makeEbay({ response = { success: true }, throwErr = null } = {}) {
  const calls = [];
  return {
    calls,
    async updateItem(itemId, opts) {
      calls.push({ itemId, opts });
      if (throwErr) throw throwErr;
      return response;
    },
  };
}

/** captures every gate invocation and returns a scripted outcome. */
function makeGateStub(behavior = { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 2 }) {
  const calls = [];
  const stub = async (req, deps) => {
    calls.push({ req, deps });
    return typeof behavior === 'function' ? behavior(req, calls.length) : behavior;
  };
  stub.calls = calls;
  return stub;
}

function makeDataSource() {
  const updateProductCalls = [];
  return {
    updateProductCalls,
    updateProduct: async (col, val, patch, sku) => {
      updateProductCalls.push({ col, val, patch, sku });
      return { success: true };
    },
  };
}

const CTX = () => ({ userId: 7, actor: 'user:7' });

/* ─────────────────────────── 1. Input validation ─────────────────────────── */

test('missing itemId → 400 without touching gate/eBay', async () => {
  const gateStub = makeGateStub();
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '', price: 59 }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.httpStatus, 400);
  assert.equal(gateStub.calls.length, 0);
  assert.equal(ebay.calls.length, 0);
  assert.equal(r.marketplaceCalls, 0);
});

test('neither price nor quantity → 400', async () => {
  const gateStub = makeGateStub();
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '236000000001' }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.httpStatus, 400);
  assert.equal(gateStub.calls.length, 0);
  assert.equal(ebay.calls.length, 0);
});

test('invalid price (NaN / negative / 0 / string) → 400 gate 0 eBay 0', async () => {
  for (const p of [NaN, -3, 0, 'abc']) {
    const gateStub = makeGateStub();
    const ebay = makeEbay();
    const r = await executeEbayProductEdit(
      { itemId: '236000000001', price: p }, CTX(),
      { db: makeDb(), ebay, gateExecute: gateStub },
    );
    assert.equal(r.httpStatus, 400, `expected 400 for price=${p}`);
    assert.equal(gateStub.calls.length, 0);
    assert.equal(ebay.calls.length, 0);
  }
});

test('invalid quantity (negative / non-numeric) → 400 gate 0 eBay 0', async () => {
  for (const q of [-1, 'abc']) {
    const gateStub = makeGateStub();
    const ebay = makeEbay();
    const r = await executeEbayProductEdit(
      { itemId: '236000000001', quantity: q }, CTX(),
      { db: makeDb(), ebay, gateExecute: gateStub },
    );
    assert.equal(r.httpStatus, 400, `expected 400 for quantity=${q}`);
    assert.equal(gateStub.calls.length, 0);
    assert.equal(ebay.calls.length, 0);
  }
});

/* ─────────────────────────── 2. Kill switch ─────────────────────────── */

test('kill_switch=true (gate returns BLOCKED) → eBay 0, no quantity leg', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.BLOCKED, reasonCode: gate.GATE_REASON.KILL_SWITCH,
    runId: 100, eventId: 200,
  });
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '236000000001', price: 59, quantity: 5 }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.ok, false);
  assert.equal(r.body.blocked, true);
  assert.equal(r.body.reason, gate.GATE_REASON.KILL_SWITCH);
  assert.equal(r.priceMarketplaceCalls, 0);
  assert.equal(r.quantityMarketplaceCalls, 0);           // quantity leg skipped
  assert.equal(ebay.calls.length, 0);
});

/* ─────────────────────────── 3. Idempotency ─────────────────────────── */

test('duplicate requestId → gate returns IDEMPOTENT_REPLAY, eBay call 0 in this invocation', async () => {
  // First call: normal APPLIED
  const first = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 1, eventId: 1,
  });
  const ebay1 = makeEbay();
  const uuid1 = () => 'fixed-uuid-abc';
  await executeEbayProductEdit(
    { itemId: '236000000001', price: 59 }, CTX(),
    { db: makeDb(), ebay: ebay1, gateExecute: first, uuid: uuid1 },
  );
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].req.requestId, 'fixed-uuid-abc');

  // Second call with same requestId simulates a client retry;
  // gate returns IDEMPOTENT_REPLAY (this stub simulates that outcome).
  const second = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS',
    priorRunId: 1, eventId: 1,
  });
  const ebay2 = makeEbay();
  await executeEbayProductEdit(
    { itemId: '236000000001', price: 59, requestId: 'fixed-uuid-abc' },
    CTX(),
    { db: makeDb(), ebay: ebay2, gateExecute: second, uuid: uuid1 },
  );
  assert.equal(second.calls[0].req.requestId, 'fixed-uuid-abc');
  // In this test the gate stub doesn't itself call eBay, so
  // priceMarketplaceCalls stays 0 for the replay.
  assert.equal(ebay2.calls.length, 0);       // no quantity leg either (short-circuit)
});

test('IDEMPOTENT_REPLAY skips quantity leg to avoid partial re-execution', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS',
    priorRunId: 1, eventId: 1,
  });
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '236000000001', price: 59, quantity: 5 }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.body.idempotent, true);
  assert.equal(ebay.calls.length, 0);      // quantity leg NOT run
});

test('uuid generated per request (no 1-second bucket) → two rapid edits get distinct requestIds', async () => {
  const seen = [];
  const gateStub = async (req) => {
    seen.push(req.requestId);
    return { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1 };
  };
  const ebay = makeEbay();
  // No client-supplied requestId — service must synthesise unique UUIDs.
  await executeEbayProductEdit({ itemId: '1', price: 59 }, CTX(), { db: makeDb(), ebay, gateExecute: gateStub });
  await executeEbayProductEdit({ itemId: '1', price: 59 }, CTX(), { db: makeDb(), ebay, gateExecute: gateStub });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'each call must get a fresh UUID (MANUAL_DIRECT semantics)');
});

test('client-supplied requestId honoured verbatim', async () => {
  const seen = [];
  const gateStub = async (req) => { seen.push(req.requestId); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1,
  }; };
  await executeEbayProductEdit(
    { itemId: '1', price: 59, requestId: 'user-supplied-xyz' }, CTX(),
    { db: makeDb(), ebay: makeEbay(), gateExecute: gateStub },
  );
  assert.equal(seen[0], 'user-supplied-xyz');
});

/* ─────────────────────────── 4. eBay marketplace outcomes ─────────────────────────── */

test('eBay throws inside gate (FAILED) → success:false, quantity leg NOT run', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.FAILED, reasonCode: gate.GATE_REASON.MARKETPLACE_FAILED,
    runId: 1, eventId: 1, error: 'eBay 500',
  });
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '1', price: 59, quantity: 5 }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.ok, false);
  assert.equal(r.body.error, 'eBay 500');
  assert.equal(ebay.calls.length, 0);              // quantity leg skipped
  assert.equal(r.quantityMarketplaceCalls, 0);
  // priceMarketplaceCalls counts the gate's attempted eBay call
  assert.equal(r.priceMarketplaceCalls, 1);
});

test('eBay returns {success:false} inside gate → same as throw', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.FAILED, reasonCode: gate.GATE_REASON.MARKETPLACE_FAILED,
    runId: 1, eventId: 1, error: 'InvalidItem',
  });
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '1', price: 59, quantity: 5 }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.body.error, 'InvalidItem');
  assert.equal(ebay.calls.length, 0);
});

test('mocked eBay success → APPLIED, price returned in body.updates, quantity leg runs', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 10, eventId: 20,
  });
  const ebay = makeEbay({ response: { success: true } });
  const db = makeDb();
  const r = await executeEbayProductEdit(
    { itemId: '1', price: 59, quantity: 5 }, CTX(),
    { db, ebay, gateExecute: gateStub },
  );
  assert.equal(r.ok, true);
  assert.equal(r.body.success, true);
  assert.equal(r.body.updates.price, 59);
  assert.equal(r.body.updates.quantity, 5);
  // Quantity leg calls eBay once (stock only) and updates stock in DB.
  assert.equal(ebay.calls.length, 1);
  assert.deepEqual(ebay.calls[0].opts, { quantity: 5 });
  assert.equal(db.stockUpdates.length, 1);
  assert.equal(db.stockUpdates[0].patch.stock, 5);
  // priceOutcome carries the gate result for observability
  assert.equal(r.body.priceOutcome.outcome, gate.OUTCOME.APPLIED);
  assert.equal(r.body.priceOutcome.runId, 10);
});

test('price-only edit → gate runs, quantity leg completely skipped', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 1, eventId: 1,
  });
  const ebay = makeEbay();
  const r = await executeEbayProductEdit(
    { itemId: '1', price: 59 }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub },
  );
  assert.equal(r.ok, true);
  assert.equal(ebay.calls.length, 0);          // no quantity leg
  assert.equal(gateStub.calls.length, 1);
  assert.equal(r.priceMarketplaceCalls, 1);    // gate's own eBay call
  assert.equal(r.quantityMarketplaceCalls, 0);
});

test('quantity-only edit → gate NOT called, only quantity leg', async () => {
  const gateStub = makeGateStub();
  const ebay = makeEbay({ response: { success: true } });
  const db = makeDb();
  const r = await executeEbayProductEdit(
    { itemId: '1', quantity: 10 }, CTX(),
    { db, ebay, gateExecute: gateStub },
  );
  assert.equal(r.ok, true);
  assert.equal(gateStub.calls.length, 0);      // gate never touched for pure stock
  assert.equal(ebay.calls.length, 1);
  assert.equal(ebay.calls[0].opts.quantity, 10);
  assert.equal(db.stockUpdates.length, 1);
});

/* ─────────────────────────── 5. Gate contract passthrough ─────────────────────────── */

test('gate is called with context=MANUAL_DIRECT and actor=user:<id>', async () => {
  const seen = [];
  const gateStub = async (req) => {
    seen.push(req);
    return { outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1 };
  };
  await executeEbayProductEdit(
    { itemId: '236000000001', price: 59, sku: 'PMC-X' }, CTX(),
    { db: makeDb(), ebay: makeEbay(), gateExecute: gateStub },
  );
  assert.equal(seen[0].context, 'MANUAL_DIRECT');
  assert.equal(seen[0].actor, 'user:7');
  assert.equal(seen[0].currency, 'USD');
  assert.equal(seen[0].sku, 'PMC-X');
  assert.equal(seen[0].itemId, '236000000001');
  assert.equal(seen[0].newPrice, 59);
});

test('missing sku → gate receives synthesised sku (ebay-item-<itemId>)', async () => {
  const seen = [];
  const gateStub = async (req) => { seen.push(req); return {
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE', runId: 1, eventId: 1,
  }; };
  await executeEbayProductEdit(
    { itemId: '236000000001', price: 59 }, CTX(),
    { db: makeDb(), ebay: makeEbay(), gateExecute: gateStub },
  );
  assert.equal(seen[0].sku, 'ebay-item-236000000001');
});

/* ─────────────────────────── 6. Legacy dataSource sync ─────────────────────────── */

test('legacy dataSource.updateProduct is called after successful gate + quantity', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.APPLIED, reasonCode: 'AUTO_UNDERCUT_SAFE',
    runId: 1, eventId: 1,
  });
  const ebay = makeEbay({ response: { success: true } });
  const ds = makeDataSource();
  const r = await executeEbayProductEdit(
    { itemId: '1', price: 59, quantity: 5, sku: 'PMC-A' }, CTX(),
    { db: makeDb(), ebay, gateExecute: gateStub, dataSource: ds },
  );
  assert.equal(r.body.dbSync, true);
  assert.equal(ds.updateProductCalls.length, 1);
  assert.deepEqual(ds.updateProductCalls[0].patch, { priceUSD: 59, stock: 5 });
  assert.equal(ds.updateProductCalls[0].sku, 'PMC-A');
});

test('legacy dataSource NOT called on price BLOCK (no successful edit to sync)', async () => {
  const gateStub = makeGateStub({
    outcome: gate.OUTCOME.BLOCKED, reasonCode: gate.GATE_REASON.KILL_SWITCH,
    runId: 1, eventId: 1,
  });
  const ds = makeDataSource();
  await executeEbayProductEdit(
    { itemId: '1', price: 59, sku: 'PMC-A' }, CTX(),
    { db: makeDb(), ebay: makeEbay(), gateExecute: gateStub, dataSource: ds },
  );
  assert.equal(ds.updateProductCalls.length, 0);
});

/* ─────────────────────────── 7. Static bypass audit ─────────────────────────── */

test('AUDIT: PUT /api/products/ebay/:itemId handler has NO direct eBay/DB write', () => {
  const apiPath = path.join(__dirname, '../../src/web/routes/api.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  const start = apiSrc.indexOf("router.put('/products/ebay/:itemId'");
  assert.notEqual(start, -1, 'PUT /products/ebay/:itemId route not found');
  const rest = apiSrc.slice(start);
  const nextRoute = rest.slice(50).search(/router\.(post|get|put|delete)\('/);
  const handlerBlock = nextRoute === -1 ? rest : rest.slice(0, 50 + nextRoute);
  for (const p of [
    /getEbayAPI\s*\(\s*\)\s*\.\s*updateItem/,
    /api\.updateItem\s*\(/,
    /ebay\.updateItem\s*\(/,
    /\.from\(\s*['"]ebay_products['"]\s*\)\s*\.\s*update/,
    /ReviseFixedPriceItem/,
    /ReviseInventoryStatus/,
  ]) {
    assert.equal(p.test(handlerBlock), false, `handler must not match ${p}`);
  }
  // Positive: must import and use the new service
  assert.match(handlerBlock, /executeEbayProductEdit/);
  assert.match(handlerBlock, /require\(['"]\.\.\/\.\.\/services\/ebayProductEditService['"]\)/);
});
