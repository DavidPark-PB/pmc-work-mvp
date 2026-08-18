'use strict';

/**
 * tests/oms/recentSoldPriceService.test.js — Phase 8P.
 *
 * READ-ONLY sold-price observation service tests.
 * Uses stub db + injected identityCoverageFn.
 * Covers P1-P19, P24-P26 (P20-P23 in orchestrator suite · P27 in shadow suite).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getRecentSoldPriceCandidate,
  CANDIDATE_STATUS,
  CANDIDATE_TYPE,
  CONFIDENCE,
} = require('../../src/services/oms/recentSoldPriceService');

const asOfMs = Date.parse('2026-08-18T12:00:00Z');
const ISO = (offsetDays) => new Date(asOfMs - offsetDays * 86400_000).toISOString();

// ─── Stub db and fake identityCoverageFn ─────────────

function makeDb(data) {
  return {
    from(table) {
      const rows = data[table] || [];
      const q = { _filters: [], _rangeFilters: [] };
      const buildResult = () => {
        let out = rows.slice();
        for (const [col, val] of q._filters) out = out.filter(r => r[col] === val);
        for (const [op, col, val] of q._rangeFilters) {
          if (op === 'gte') out = out.filter(r => r[col] != null && r[col] >= val);
          if (op === 'lte') out = out.filter(r => r[col] != null && r[col] <= val);
          if (op === 'in') out = out.filter(r => val.includes(r[col]));
        }
        return { data: out, error: null };
      };
      const api = {
        select() { return this; },
        eq(col, val) { q._filters.push([col, val]); return this; },
        gte(col, val) { q._rangeFilters.push(['gte', col, val]); return this; },
        lte(col, val) { q._rangeFilters.push(['lte', col, val]); return this; },
        in(col, vals) { q._rangeFilters.push(['in', col, vals]); return Promise.resolve(buildResult()); },
        then(resolve) { resolve(buildResult()); },   // await support for terminal chains without .in
      };
      return api;
    },
  };
}

function trustedCoverage(overrides = {}) {
  return async () => ({
    physical_product_id: 1, channel: 'ebay', days: 30,
    velocity_trusted: true,
    trust_reason: 'known_identity_items_fully_mapped_and_no_potential_related',
    known_shopify_identities: [{ listing_id: 'e_1', variant_id: null, sku_master_id: 100 }],
    ...overrides,
  });
}
function untrustedCoverage(reason = 'potential_unmapped_same_physical(2)') {
  return async () => ({
    physical_product_id: 1, channel: 'ebay', days: 30,
    velocity_trusted: false, trust_reason: reason,
    known_shopify_identities: [],
  });
}

function orderRow(overrides = {}) {
  return {
    id: 1000, external_order_number: 'A', channel: 'ebay',
    shipped_at: ISO(2), cancelled_at: null, order_status: 'shipped', payment_status: 'paid',
    ...overrides,
  };
}
function itemRow(overrides = {}) {
  return {
    id: 5000, order_id: 1000, sku_master_id: 100,
    quantity: 1, unit_price: 75, discount: 0, currency: 'USD',
    ...overrides,
  };
}

const fxOpts = { usdKrw: 1350, usdKrwSource: 'pricing_safety_sot' };

// ─── P1 · Trustworthy completed sales included ───────

test('P1. Completed trustworthy sales included · returns RECENT_SOLD_PRICE_MEDIAN', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1, 2, 3, 4].map(i => itemRow({ id: 5000 + i, order_id: 1000 + i, unit_price: 70 + i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({
    physicalProductId: 1, db, ...fxOpts, asOfMs,
    identityCoverageFn: trustedCoverage(),
    channels: ['ebay'],
  });
  assert.equal(r.status, CANDIDATE_STATUS.RECENT_SOLD_PRICE_MEDIAN);
  assert.equal(r.sample_count, 4);
  //   Values [71,72,73,74]USD × 1350 = [95850,97200,98550,99900] · median even = (97200+98550)/2 = 97875
  assert.equal(r.value, 97875);
  assert.equal(r.currency, 'KRW');
});

// ─── P2 · Cancelled excluded ─────────────────────────

test('P2. Cancelled orders excluded · never contribute to median', async () => {
  const orders = [
    orderRow({ id: 1001, order_status: 'cancelled', cancelled_at: ISO(2), payment_status: 'refunded' }),
    orderRow({ id: 1002, shipped_at: ISO(3) }),
    orderRow({ id: 1003, shipped_at: ISO(4) }),
    orderRow({ id: 1004, shipped_at: ISO(5) }),
  ];
  const items = [1001, 1002, 1003, 1004].map(i => itemRow({ id: i, order_id: i, unit_price: 70 }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 3);
  assert.equal(r.exclusions.orders_cancelled >= 1 || (r.exclusions.orders_wrong_status.cancelled || 0) >= 1, true);
});

// ─── P3 · Refunded/failed payment excluded ───────────

test('P3. payment_status refunded/partially_refunded/failed → excluded as unreliable', async () => {
  const orders = [
    orderRow({ id: 1001, payment_status: 'refunded' }),
    orderRow({ id: 1002, payment_status: 'partially_refunded' }),
    orderRow({ id: 1003, payment_status: 'failed' }),
    orderRow({ id: 1004, shipped_at: ISO(2) }),
    orderRow({ id: 1005, shipped_at: ISO(3) }),
    orderRow({ id: 1006, shipped_at: ISO(4) }),
  ];
  const items = [1001, 1002, 1003, 1004, 1005, 1006].map(i => itemRow({ id: i, order_id: i, unit_price: 70 }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 3);
  assert.ok(r.exclusions.orders_wrong_payment.refunded >= 1);
});

// ─── P4 · Zero quantity excluded (schema enforces >0 but service double-checks) ─

test('P4. Zero-quantity line excluded (defensive · schema CHECK also enforces)', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, quantity: 0, unit_price: 70 }),
    itemRow({ id: 5002, order_id: 1002 }),
    itemRow({ id: 5003, order_id: 1003 }),
    itemRow({ id: 5004, order_id: 1004 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 3);
  assert.equal(r.exclusions.items_zero_quantity, 1);
});

// ─── P5 · Zero/negative price excluded ───────────────

test('P5. Zero / negative / NaN unit_price → excluded', async () => {
  const orders = [1, 2, 3, 4, 5].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 0 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: -10 }),
    itemRow({ id: 5003, order_id: 1003 }),
    itemRow({ id: 5004, order_id: 1004 }),
    itemRow({ id: 5005, order_id: 1005 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 3);
  assert.equal(r.exclusions.items_nonpositive_price, 2);
});

// ─── P6 · UNKNOWN currency excluded safely ───────────

test('P6. Unknown currency (null / "" / "BTC") excluded · never guessed KRW · minSamples relaxed to 1 for this assertion', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, currency: null }),
    itemRow({ id: 5002, order_id: 1002, currency: '' }),
    itemRow({ id: 5003, order_id: 1003, currency: 'BTC' }),
    itemRow({ id: 5004, order_id: 1004 }),   // USD valid
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  //   Use minSamples=1 so we can assert 1 valid sample got through and 3 were excluded
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'], minSamples: 1 });
  assert.equal(r.sample_count, 1);   // only USD row passes
  const excl = r.exclusions.items_unknown_currency || {};
  assert.ok(Object.keys(excl).length >= 2, `expected >=2 unknown-currency exclusions · got ${Object.keys(excl).length}: ${JSON.stringify(excl)}`);
});

// ─── P7 · Uncertain physical identity → whole channel excluded ─

test('P7. Untrusted physical identity (velocity_trusted=false) → channel excluded · no median from that channel', async () => {
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1001, 1002, 1003].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({
    physicalProductId: 1, db, ...fxOpts, asOfMs,
    identityCoverageFn: untrustedCoverage(),
    channels: ['ebay'],
  });
  assert.equal(r.status, CANDIDATE_STATUS.UNKNOWN);
  assert.ok(r.exclusions.channels_untrusted_identity.length >= 1);
});

// ─── P8 · No fuzzy / title matching ─────────────────

test('P8. Service NEVER reads title, description, or fuzzy matches — only sku_master_id', () => {
  //   Static assertion: source must not read title/description/fuzzy fields.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').resolve(__dirname, '../../src/services/oms/recentSoldPriceService.js'), 'utf8');
  //   Selects should NOT include title
  assert.doesNotMatch(src, /oms_order_items['"][\s\S]{0,60}\btitle\b/, 'must not select title from oms_order_items');
  //   No like / ilike / regex-name fuzzy paths
  assert.doesNotMatch(src, /\.like\s*\(/i);
  assert.doesNotMatch(src, /\.ilike\s*\(/i);
});

// ─── P9 · 1 sample behavior explicit ─────────────────

test('P9. 1 trustworthy sample · minSamples=3 → UNKNOWN insufficient_samples', async () => {
  const db = makeDb({ oms_orders: [orderRow({ shipped_at: ISO(1) })], oms_order_items: [itemRow()] });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.status, CANDIDATE_STATUS.UNKNOWN);
  assert.equal(r.reason, 'insufficient_samples');
  assert.equal(r.exclusions.insufficient_samples.observed, 1);
});

// ─── P10 · Insufficient samples behavior ─────────────

test('P10. 2 samples with default minSamples=3 → UNKNOWN · never claims confidence', async () => {
  const orders = [1, 2].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1001, 1002].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.status, CANDIDATE_STATUS.UNKNOWN);
  assert.equal(r.confidence, CONFIDENCE.UNKNOWN);
});

// ─── P11 · Median odd count ─────────────────────────

test('P11. Median with odd sample count · middle value', async () => {
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 60 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 75 }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 90 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  //   KRW: [81000, 101250, 121500] · median odd = 101250
  assert.equal(r.value, 101250);
});

// ─── P12 · Median even count ─────────────────────────

test('P12. Median with even sample count · average of two middle values', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 60 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 70 }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 80 }),
    itemRow({ id: 5004, order_id: 1004, unit_price: 90 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  //   KRW: [81000, 94500, 108000, 121500] · median = (94500+108000)/2 = 101250
  assert.equal(r.value, 101250);
});

// ─── P13 · Outlier does NOT dominate median ─────────

test('P13. Extreme outlier does NOT dominate median (unlike mean)', async () => {
  const orders = [1, 2, 3, 4, 5].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 70 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 75 }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 80 }),
    itemRow({ id: 5004, order_id: 1004, unit_price: 85 }),
    itemRow({ id: 5005, order_id: 1005, unit_price: 9999 }),   // outlier
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  //   Sorted KRW: [94500, 101250, 108000, 114750, 13498650] · median = 108000
  assert.equal(r.value, 108000);
});

// ─── P14 · 30-day boundary ─────────────────────────

test('P14. Sale exactly at the lookback boundary is included · older is not', async () => {
  //   30d window · sale at 30d ago should be included, 31d not.
  const orders = [
    orderRow({ id: 1001, shipped_at: ISO(30) }),   // boundary
    orderRow({ id: 1002, shipped_at: ISO(31) }),   // outside
    orderRow({ id: 1003, shipped_at: ISO(1) }),
    orderRow({ id: 1004, shipped_at: ISO(5) }),
  ];
  const items = [1001, 1002, 1003, 1004].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'], lookbackDays: 30 });
  assert.equal(r.sample_count, 3);   // 30d boundary IN, 31d OUT
});

// ─── P15 · Older rows excluded ────────────────────

test('P15. Rows older than lookback are entirely excluded', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(60 + i) }));
  const items = [1001, 1002, 1003, 1004].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'], lookbackDays: 30 });
  assert.equal(r.status, CANDIDATE_STATUS.UNKNOWN);
});

// ─── P16 · Mixed channels with compatible semantics ─

test('P16. Mixed channels (ebay+shopify) both trusted · both contribute · combined median', async () => {
  const orders = [
    orderRow({ id: 1001, channel: 'ebay', shipped_at: ISO(2) }),
    orderRow({ id: 1002, channel: 'ebay', shipped_at: ISO(3) }),
    orderRow({ id: 2001, channel: 'shopify', shipped_at: ISO(4) }),
    orderRow({ id: 2002, channel: 'shopify', shipped_at: ISO(5) }),
  ];
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 70 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 80 }),
    itemRow({ id: 6001, order_id: 2001, unit_price: 75, currency: 'KRW' }),   // Shopify KRW
    itemRow({ id: 6002, order_id: 2002, unit_price: 100000, currency: 'KRW' }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({
    physicalProductId: 1, db, ...fxOpts, asOfMs,
    identityCoverageFn: async ({ channel }) => ({
      velocity_trusted: true, trust_reason: 'ok', channel, days: 30,
      known_shopify_identities: [{ listing_id: 'x', sku_master_id: 100 }],
    }),
    channels: ['ebay', 'shopify'],
  });
  assert.ok(r.sample_count === 4);
  //   KRW: [70×1350=94500, 80×1350=108000, 75, 100000] · sorted [75, 94500, 100000, 108000]
  //   median = (94500+100000)/2 = 97250
  assert.equal(r.value, 97250);
  assert.deepEqual(r.channels.sort(), ['ebay', 'shopify']);
});

// ─── P17 · Mixed currencies NEVER raw-combined ─────

test('P17. Mixed currencies are FX-normalized to KRW before median · never combined raw', async () => {
  const orders = [
    orderRow({ id: 1001, shipped_at: ISO(1) }),
    orderRow({ id: 1002, shipped_at: ISO(2) }),
    orderRow({ id: 1003, shipped_at: ISO(3) }),
  ];
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 100, currency: 'KRW' }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 75,  currency: 'USD' }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 90,  currency: 'USD' }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  //   Not raw-combined: KRW native [100, 75, 90] median would be 90 (WRONG)
  //   Correctly normalized KRW: [100, 101250, 121500] · median = 101250
  assert.notEqual(r.value, 90);
  assert.equal(r.value, 101250);
});

// ─── P18 · FX provenance preserved ─────────────────

test('P18. Every observation and result carries FX provenance', async () => {
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1001, 1002, 1003].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.fx.USD.rate, 1350);
  assert.equal(r.fx.USD.source, 'pricing_safety_sot');
  for (const p of r.provenance) {
    assert.ok(p.fx_rate_used === 1350 || p.currency === 'KRW', 'each provenance entry stamps fx_rate_used or is native KRW');
    assert.ok(p.unit_price_native != null);
    assert.ok(p.currency);
  }
});

// ─── P19 · Missing FX handled safely ───────────────

test('P19. Missing USD FX → USD rows excluded · never fabricates KRW', async () => {
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1001, 1002, 1003].map(i => itemRow({ id: i, order_id: i, currency: 'USD' }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({
    physicalProductId: 1, db, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'],
    /* no usdKrw */
  });
  assert.equal(r.status, CANDIDATE_STATUS.UNKNOWN);
  assert.ok(r.exclusions.items_fx_unavailable.USD >= 3);
});

// ─── P24-P26 · Provenance rendering shape ─────────

test('P24. Provenance array includes per-observation fields (order_item_id/order_id/channel/sku/unit_price/currency/amount_krw/shipped_at)', async () => {
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1001, 1002, 1003].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.provenance.length, 3);
  for (const p of r.provenance) {
    for (const k of ['order_item_id', 'order_id', 'channel', 'sku_master_id', 'unit_price_native', 'currency', 'amount_krw', 'shipped_at']) {
      assert.ok(k in p, `provenance must include ${k}`);
    }
  }
});

test('P25. sample_count rendered · matches provenance array length', async () => {
  const orders = [1, 2, 3, 4, 5].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [1001, 1002, 1003, 1004, 1005].map(i => itemRow({ id: i, order_id: i }));
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 5);
  assert.equal(r.provenance.length, 5);
  assert.equal(r.confidence, CONFIDENCE.MEDIUM);
});

test('P26. min / max range rendered', async () => {
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 60 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 75 }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 90 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.min, 81000);
  assert.equal(r.max, 121500);
});

// ─── P28-P32 zero-mutation contract ────────────────

test('P28-P32. Service source has zero mutation paths (marketplace / DB write / notify / schema / cron)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').resolve(__dirname, '../../src/services/oms/recentSoldPriceService.js'), 'utf8');
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/);
  assert.doesNotMatch(src, /require\(['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*(?:notify|telegram|imessage)/i);
  assert.doesNotMatch(src, /require\(['"][^'"]*scheduler/i);
  assert.doesNotMatch(src, /create table|alter table/i);
});

// ─── Extra guards ─────────────────────────────────

test('P-extra-1. Discounted lines excluded (ambiguous per-unit semantics)', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, unit_price: 70, discount: 10 }),
    itemRow({ id: 5002, order_id: 1002, unit_price: 75 }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 80 }),
    itemRow({ id: 5004, order_id: 1004, unit_price: 85 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 3);
  assert.equal(r.exclusions.items_discounted, 1);
});

test('P-extra-2. sku_master_id NOT in known set → excluded even if order otherwise eligible', async () => {
  const orders = [1, 2, 3, 4].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, sku_master_id: 999 }),   // not in known
    itemRow({ id: 5002, order_id: 1002 }),
    itemRow({ id: 5003, order_id: 1003 }),
    itemRow({ id: 5004, order_id: 1004 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  assert.equal(r.sample_count, 3);
  assert.equal(r.exclusions.items_sku_not_in_known, 1);
});

test('P-extra-3. One observation per LINE · large-qty line does NOT get amplified', async () => {
  //   Owner rule §4: unusual large orders should not dominate. We use lines
  //   not units. This test pins that behavior.
  const orders = [1, 2, 3].map(i => orderRow({ id: 1000 + i, shipped_at: ISO(i) }));
  const items = [
    itemRow({ id: 5001, order_id: 1001, quantity: 60, unit_price: 40 }),   // bulk cheap
    itemRow({ id: 5002, order_id: 1002, unit_price: 80 }),
    itemRow({ id: 5003, order_id: 1003, unit_price: 90 }),
  ];
  const db = makeDb({ oms_orders: orders, oms_order_items: items });
  const r = await getRecentSoldPriceCandidate({ physicalProductId: 1, db, ...fxOpts, asOfMs, identityCoverageFn: trustedCoverage(), channels: ['ebay'] });
  //   3 samples (one per line) · KRW [54000, 108000, 121500] · median = 108000
  assert.equal(r.sample_count, 3);
  assert.equal(r.value, 108000);
});
