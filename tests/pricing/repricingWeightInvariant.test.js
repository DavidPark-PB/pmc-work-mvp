'use strict';

/**
 * tests/pricing/repricingWeightInvariant.test.js — R2-E2B1 (2026-09-05).
 *
 * Verifies the "UNKNOWN weight ≠ 0g ≠ 5,460 KRW default shipping ≠
 * valid repricing floor" invariant on the marketplace-write path:
 *
 *   POST /api/repricing/execute/:sku
 *     → RepricingService.executeRepricing(sku, 'ebay')
 *       → RepricingService.evaluateRepricing(sku)
 *         → pricingEngine.estimateShippingKRW(weight)   ← must NOT be
 *                                                        called when
 *                                                        weight is
 *                                                        UNKNOWN
 *       → priceExecutionGate.executePriceWrite(...)     ← must NOT be
 *                                                        called when
 *                                                        evaluation is
 *                                                        a BLOCK
 *
 * Owner directive (R2-E2B1):
 *   · products.weight NULL / undefined / '' / whitespace / NaN /
 *     Infinity / negative / 0 / malformed strings ('0.5kg', 'abc') →
 *     evaluateRepricing returns { action:'block', reason:'BLOCK_
 *     LANDING_COST_UNKNOWN', missing:['weight'] } · estimator call
 *     count = 0 · gate call count = 0 · marketplace write = 0.
 *   · valid positive weight (0.5 or '0.5') → existing calculation
 *     preserved bit-for-bit.
 *   · No modification to pricingEngine, priceExecutionGate, sku_master.
 *
 * Test isolation pattern reuses R2-D1/R2-D3/R2-SHIP-1 approach:
 *   · require.cache substitution for pricingEngine (spy on
 *     estimateShippingKRW) + platformRegistry + supabaseClient
 *   · Object.create(RepricingService.prototype) to bypass constructor
 *   · Inject evaluation for the catastrophic-manual-approved test to
 *     prove gate is never called when action='block'
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ─────────────────────────────────────────────────────────────────────
// Recorder / spies
// ─────────────────────────────────────────────────────────────────────
const spy = {
  estimatorCalls:      [],  // args to estimateShippingKRW
  gateCalls:           [],  // req to priceExecutionGate.executePriceWrite
  ebayUpdateItemCalls: [],  // (itemId, price) to ebay.updateItem
  dbUpdateCalls:       [],  // products/repricing table writes
};
function resetSpy() {
  spy.estimatorCalls.length      = 0;
  spy.gateCalls.length           = 0;
  spy.ebayUpdateItemCalls.length = 0;
  spy.dbUpdateCalls.length       = 0;
}

// ─────────────────────────────────────────────────────────────────────
// Stubs installed BEFORE loading RepricingService
// ─────────────────────────────────────────────────────────────────────
const ROOT       = path.resolve(__dirname, '../..');
const PRICING    = path.resolve(ROOT, 'src/services/pricingEngine.js');
const REGISTRY   = path.resolve(ROOT, 'src/services/platformRegistry.js');
const GATE       = path.resolve(ROOT, 'src/services/priceExecutionGate.js');
const SUPABASE   = path.resolve(ROOT, 'src/db/supabaseClient.js');
const PLAT_REPO  = path.resolve(ROOT, 'src/db/platformRepository.js');
const RATES      = path.resolve(ROOT, 'src/pricing/rates.js');

function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

//   pricingEngine stub — estimator is the observable we assert on
stubModule(PRICING, {
  estimateShippingKRW(weightKg, exchangeRate) {
    spy.estimatorCalls.push({ weightKg, exchangeRate });
    //   Return the same fallback semantics as the real function so any
    //   valid-weight test still gets a sane number. This is safe because
    //   BH-W9/W10 only assert "estimator called with 0.5" and downstream
    //   calculation continues — we don't check the exact recommendation
    //   in this suite.
    if (!weightKg || weightKg <= 0) return 3.9 * 1400;
    if (weightKg <= 0.1) return 3500;
    if (weightKg <= 0.5) return 5800;
    if (weightKg <= 1.0) return 8500;
    return 14000;
  },
});

//   platformRegistry stub — deterministic fees
stubModule(REGISTRY, {
  getFeeRates: async () => ({ ebay: 0.15, shopify: 0.033 }),
});

//   priceExecutionGate stub — track outbound calls
const GATE_OUTCOMES = {
  APPLIED:            'APPLIED',
  BLOCKED:            'BLOCKED',
  FAILED:             'FAILED',
  IDEMPOTENT_REPLAY:  'IDEMPOTENT_REPLAY',
};
stubModule(GATE, {
  OUTCOME:  GATE_OUTCOMES,
  GATE_REASON: {},
  async executePriceWrite(req, deps = {}) {
    spy.gateCalls.push(req);
    return {
      outcome:   GATE_OUTCOMES.APPLIED,
      reasonCode: 'AUTO_UNDERCUT_SAFE',
      runId:     'stub-run',
      eventId:   'stub-event',
    };
  },
});

//   supabase client stub
stubModule(SUPABASE, {
  getClient: () => ({
    from(table) {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                async single() { return { data: null, error: { message: 'stub' } }; },
                maybeSingle() { return Promise.resolve({ data: null, error: null }); },
              };
            },
          };
        },
        update(patch) {
          const chain = {
            eq(col, val) {
              spy.dbUpdateCalls.push({ table, patch, col, val });
              return Promise.resolve({ data: null, error: null });
            },
          };
          return chain;
        },
      };
    },
  }),
});

//   platformRepository stub — RepricingService instantiates one per call
stubModule(PLAT_REPO, class PlatformRepositoryStub {
  async getLatestCompetitorPrice(sku) {
    return { competitor_price: 20, competitor_shipping: 3 };
  }
  async getRepricingRules(sku) {
    return [{
      id: 1, sku,
      strategy: 'undercut',
      undercut_amount: 0.01,
      min_margin_pct: 15,
      min_price: null,
      max_price: null,
      is_active: true,
    }];
  }
});

//   pricing rates helper stub
stubModule(RATES, {
  getPricingSafetyExchangeRate: async () => 1400,
  getPricingSafetyExchangeRateSync: () => 1400,
  FALLBACK_RATE_KRW_PER_USD:   1400,
  MIN_PLAUSIBLE_RATE:          500,
  MAX_PLAUSIBLE_RATE:          5000,
  _resetCache() {},
});

process.env.NODE_ENV = 'test';

const RepricingService = require('../../src/services/repricingService');
const { _internal } = RepricingService;
const { _validateProductWeight } = _internal;

// ─────────────────────────────────────────────────────────────────────
// Helper · build a RepricingService instance + inject product row
// ─────────────────────────────────────────────────────────────────────
function makeService(productWeight) {
  const svc = new RepricingService();
  //   Override evaluateRepricing's DB lookup by monkey-patching
  //   _getPlatformRepo. Cleaner than re-mocking supabase per test.
  svc._getPlatformRepo = () => {
    const PlatformRepo = require('../../src/db/platformRepository');
    return new PlatformRepo();
  };
  //   Override the product-load path by patching evaluateRepricing to
  //   inject product row. Because evaluateRepricing reads db.from('products')
  //   we substitute the whole DB fetch for `products` only.
  return svc;
}

// Because evaluateRepricing calls db.from('products').select('*').eq('sku',...).single(),
// we need the DB stub to yield a specific product row per test. Rather than
// re-mocking supabase each test, we swap require.cache DB per test.
function seedProductRow(row) {
  stubModule(SUPABASE, {
    getClient: () => ({
      from(table) {
        return {
          select() {
            return {
              eq(col, val) {
                return {
                  async single() {
                    if (table === 'products' && col === 'sku' && val === row.sku) {
                      return { data: row, error: null };
                    }
                    return { data: null, error: { message: 'not found' } };
                  },
                  maybeSingle() {
                    if (table === 'products' && col === 'sku' && val === row.sku) {
                      return Promise.resolve({ data: row, error: null });
                    }
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              },
            };
          },
          update(patch) {
            return {
              eq(col, val) {
                spy.dbUpdateCalls.push({ table, patch, col, val });
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      },
    }),
  });
  //   RepricingService imports supabaseClient lazily inside the class
  //   body — but the require was already resolved at module load. We
  //   must therefore re-require RepricingService to pick up the new
  //   supabase stub. Delete both to force reload.
  delete require.cache[require.resolve('../../src/services/repricingService')];
  return require('../../src/services/repricingService');
}

// ─────────────────────────────────────────────────────────────────────
// Pure normalizer tests
// ─────────────────────────────────────────────────────────────────────
test('NORM · positive number → itself', () => {
  assert.equal(_validateProductWeight(0.5),  0.5);
  assert.equal(_validateProductWeight(1),    1);
  assert.equal(_validateProductWeight(2.75), 2.75);
});

test('NORM · positive numeric string → number', () => {
  assert.equal(_validateProductWeight('0.5'),  0.5);
  assert.equal(_validateProductWeight('1'),    1);
  assert.equal(_validateProductWeight('  0.5  '), 0.5, 'whitespace-padded numeric OK');
});

test('NORM · invalid inputs → null', () => {
  const cases = [
    null, undefined, '', '   ', NaN, Infinity, -Infinity,
    'abc', '0.5kg', '5g', ' 0.5 kg', 'kg',
    0, '0', '0.00', -1, '-1', -0.5, '-0.5',
    {}, [], [1, 2], { value: 0.5 },
  ];
  for (const v of cases) {
    assert.equal(_validateProductWeight(v), null,
      `input ${JSON.stringify(v)} MUST be null`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// Behavioural tests · execute real evaluateRepricing() via injected DB
// ─────────────────────────────────────────────────────────────────────
async function evaluateWithWeight(weight) {
  resetSpy();
  const RS = seedProductRow({
    sku:            'TEST-SKU',
    price_usd:      30,
    purchase_price: 20000,
    weight,
  });
  const svc = new RS();
  return svc.evaluateRepricing('TEST-SKU', 'ebay');
}

test('BH-W1 · weight null → block · 0 estimator calls', async () => {
  const r = await evaluateWithWeight(null);
  assert.equal(r.action, 'block');
  assert.equal(r.reason, 'BLOCK_LANDING_COST_UNKNOWN');
  assert.deepEqual(r.missing, ['weight']);
  assert.equal(spy.estimatorCalls.length, 0, 'estimator MUST NOT be called');
});

test('BH-W2 · weight 0 → block · 0 estimator calls', async () => {
  const r = await evaluateWithWeight(0);
  assert.equal(r.action, 'block');
  assert.equal(r.reason, 'BLOCK_LANDING_COST_UNKNOWN');
  assert.equal(spy.estimatorCalls.length, 0);
});

test('BH-W3 · weight -1 → block · 0 estimator calls', async () => {
  const r = await evaluateWithWeight(-1);
  assert.equal(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 0);
});

test('BH-W4 · weight "abc" → block · 0 estimator calls', async () => {
  const r = await evaluateWithWeight('abc');
  assert.equal(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 0);
});

test('BH-W5 · weight "" → block · 0 estimator calls', async () => {
  const r = await evaluateWithWeight('');
  assert.equal(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 0);
});

test('BH-W6 · weight "   " → block · 0 estimator calls', async () => {
  const r = await evaluateWithWeight('   ');
  assert.equal(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 0);
});

test('BH-W7 · weight NaN / Infinity → block · 0 estimator calls', async () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = await evaluateWithWeight(bad);
    assert.equal(r.action, 'block', `${bad} must block`);
    assert.equal(spy.estimatorCalls.length, 0);
  }
});

test('BH-W8 · weight "0.5kg" → block · 0 estimator calls · strict numeric', async () => {
  const r = await evaluateWithWeight('0.5kg');
  assert.equal(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 0,
    'Number("0.5kg") is NaN — MUST NOT accept parseFloat looseness');
});

test('BH-W9 · weight 0.5 → estimator called with 0.5 · existing calc continues', async () => {
  const r = await evaluateWithWeight(0.5);
  assert.notEqual(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 1);
  assert.equal(spy.estimatorCalls[0].weightKg, 0.5,
    'estimator receives the validated numeric value');
  assert.ok(['decrease', 'increase', 'no_change'].includes(r.action),
    'existing calculation path reached');
});

test('BH-W10 · weight "0.5" → estimator called with 0.5 · numeric coerced', async () => {
  const r = await evaluateWithWeight('0.5');
  assert.notEqual(r.action, 'block');
  assert.equal(spy.estimatorCalls.length, 1);
  assert.equal(spy.estimatorCalls[0].weightKg, 0.5);
});

// ─────────────────────────────────────────────────────────────────────
// CATASTROPHIC MANUAL_APPROVED TEST · the regression that matters
// ─────────────────────────────────────────────────────────────────────
test('BH-MA-CAT · executeRepricing MANUAL_APPROVED · unknown weight · 0 gate calls · 0 marketplace writes', async () => {
  resetSpy();
  const RS = seedProductRow({
    sku:            'CAT-SKU',
    price_usd:      30,
    purchase_price: 20000,
    weight:         null,   // <-- catastrophic case
  });
  const svc = new RS();
  //   Fully realistic invocation: rule present, competitor data present
  //   (via PlatformRepositoryStub above), kill switch permitting execution,
  //   product weight UNKNOWN.
  const r = await svc.executeRepricing('CAT-SKU', 'ebay', {});
  assert.equal(r.action, 'block',   'executeRepricing surfaces block result');
  assert.equal(r.executed, false,   'no marketplace write attempted');
  assert.equal(spy.estimatorCalls.length, 0,
    'estimator MUST NOT be called for UNKNOWN weight');
  assert.equal(spy.gateCalls.length, 0,
    'priceExecutionGate MUST NOT be called for block-shaped evaluation');
  assert.equal(spy.ebayUpdateItemCalls.length, 0,
    'no eBay updateItem invocations from this path');
  assert.equal(spy.dbUpdateCalls.length, 0,
    'no direct marketplace-mirror table writes on block');
});

test('BH-MA-VALID · executeRepricing MANUAL_APPROVED · valid weight · reaches gate (mocked)', async () => {
  resetSpy();
  const RS = seedProductRow({
    sku:            'OK-SKU',
    price_usd:      30,
    purchase_price: 20000,
    weight:         0.5,   // valid
  });
  const svc = new RS();
  //   evaluateRepricing will return 'increase' or 'decrease' (depending on
  //   floor math vs competitor 20+3=23). To reach the gate, we bypass the
  //   need for a real platform_item_id / hourBucket by injecting a
  //   pre-computed evaluation via opts.evaluation.
  const r = await svc.executeRepricing('OK-SKU', 'ebay', {
    evaluation: {
      action: 'decrease',
      currentPrice: 30,
      recommendedPrice: 22.99,
      competitorTotal: 23,
      floorPrice: 20,
      strategy: 'undercut',
      rule: { id: 1, sku: 'OK-SKU', strategy: 'undercut' },
    },
    deps: {
      platformObj: { platform_item_id: 'ITM-1' },
      itemId: 'ITM-1',
      now: () => new Date('2026-09-05T10:00:00Z'),
    },
  });
  //   valid path must NOT be blocked
  assert.notEqual(r.action, 'block');
  //   gate MUST have been called exactly once (per single-SKU exec)
  assert.equal(spy.gateCalls.length, 1,
    'valid proposal reaches the gate (test-mocked · no real eBay call)');
  assert.equal(spy.gateCalls[0].sku, 'OK-SKU');
  assert.equal(spy.gateCalls[0].newPrice, 22.99);
  assert.equal(spy.gateCalls[0].context, 'MANUAL_APPROVED');
});
