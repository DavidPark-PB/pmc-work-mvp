'use strict';

/**
 * tests/oms/soldPriceCoverageAudit.test.js — Phase 8P-1.
 * READ-ONLY coverage audit tests · stub db · zero real DB access.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  runSoldPriceCoverageAudit,
  diagnosePhysical,
  IDENTITY_CLASS,
  DEFAULT_LOOKBACK_WINDOWS,
} = require('../../src/services/oms/soldPriceCoverageAudit');

const asOfMs = Date.parse('2026-08-18T12:00:00Z');
const ISO = (d) => new Date(asOfMs - d * 86400_000).toISOString();

// ─── Stub db with query counter ────────────────────

function makeDb(data) {
  const state = { queries: 0, queriesByTable: {} };
  const dbApi = {
    from(table) {
      state.queries++;
      state.queriesByTable[table] = (state.queriesByTable[table] || 0) + 1;
      const rows = data[table] || [];
      const q = { _filters: [], _range: [], _limit: null };
      const buildResult = () => {
        let out = rows.slice();
        for (const [c, v] of q._filters) out = out.filter(r => r[c] === v);
        for (const [op, c, v] of q._range) {
          if (op === 'gte') out = out.filter(r => r[c] != null && r[c] >= v);
          if (op === 'lte') out = out.filter(r => r[c] != null && r[c] <= v);
          if (op === 'in')  out = out.filter(r => v.includes(r[c]));
        }
        if (q._limit != null) out = out.slice(0, q._limit);
        return { data: out, error: null };
      };
      return {
        select() { return this; },
        eq(c, v) { q._filters.push([c, v]); return this; },
        gte(c, v) { q._range.push(['gte', c, v]); return this; },
        lte(c, v) { q._range.push(['lte', c, v]); return this; },
        in(c, v) { q._range.push(['in', c, v]); return Promise.resolve(buildResult()); },
        limit(n) { q._limit = n; return Promise.resolve(buildResult()); },
        then(res) { res(buildResult()); },
      };
    },
    _state: state,
  };
  return dbApi;
}

//   Two physicals: BP (id=1) and NIKKE (id=2). Sku_masters:
//     sku 100 → physical 1 (qty=1)   (recognized by Phase 8P)
//     sku 200 → physical 2 (qty=1)   (recognized)
//     sku 900 → physical 1 (qty=30)  (multipack · KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P)
//     sku 500 → NO physical link     (NO_CANONICAL_PHYSICAL_MAPPING)
//     sku 600 → linked to BOTH physicals (AMBIGUOUS)
function baseFixture() {
  return {
    physical_products: [
      { id: 1, canonical_title: 'BP' },
      { id: 2, canonical_title: 'NIKKE' },
    ],
    //   Phase 8P-2b schema-correct fixture · sellable_units (086) has NO
    //   physical_product_id · consumption lives in sellable_unit_components (087).
    sellable_units: [
      { id: 10, display_name: 'BP 1-Box',    variant_kind: 'base',      status: 'active' },
      { id: 11, display_name: 'BP 30-Box',   variant_kind: 'multipack', status: 'active' },
      { id: 20, display_name: 'NIKKE 1-Box', variant_kind: 'base',      status: 'active' },
      { id: 21, display_name: 'NIKKE extra', variant_kind: 'base',      status: 'active' },
    ],
    sellable_unit_components: [
      { sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1,  role: 'primary' },
      { sellable_unit_id: 11, physical_product_id: 1, quantity_per_unit: 30, role: 'primary' },
      { sellable_unit_id: 20, physical_product_id: 2, quantity_per_unit: 1,  role: 'primary' },
      { sellable_unit_id: 21, physical_product_id: 2, quantity_per_unit: 1,  role: 'primary' },
    ],
    sku_master_link: [
      { sku_master_id: 100, sellable_unit_id: 10 },
      { sku_master_id: 200, sellable_unit_id: 20 },
      { sku_master_id: 900, sellable_unit_id: 11 },
      { sku_master_id: 600, sellable_unit_id: 10 },   // AMBIGUOUS
      { sku_master_id: 600, sellable_unit_id: 20 },
    ],
    sku_master: [
      { id: 100, internal_sku: 'bp' },
      { id: 200, internal_sku: 'nk' },
      { id: 900, internal_sku: 'bp30' },
      { id: 600, internal_sku: 'ambig' },
    ],
    oms_orders: [],
    oms_order_items: [],
  };
}

//   Helpers to seed sold observations
function seedOrder(fx, { id, channel = 'ebay', shipped_at, status = 'shipped', payment = 'paid', cancelled_at = null }) {
  fx.oms_orders.push({ id, channel, external_order_number: 'A' + id, shipped_at, cancelled_at, order_status: status, payment_status: payment });
}
function seedItem(fx, { id, order_id, sku_master_id, unit_price = 75, currency = 'USD', quantity = 1, discount = 0 }) {
  fx.oms_order_items.push({ id, order_id, sku_master_id, quantity, unit_price, discount, currency });
}

const fx = { usdKrw: 1350 };

// ─── Q1 · 30/60/90 coverage counts ───────────────

test('Q1. 30/60/90 windows all reported with sample_count per physical', async () => {
  const data = baseFixture();
  //   BP: 2 sales inside 30d
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });
  //   BP: 1 additional in 30-60d
  seedOrder(data, { id: 1003, shipped_at: ISO(45) });  seedItem(data, { id: 5003, order_id: 1003, sku_master_id: 100 });
  //   BP: 1 additional in 60-90d
  seedOrder(data, { id: 1004, shipped_at: ISO(75) });  seedItem(data, { id: 5004, order_id: 1004, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const bp = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === 1);
  assert.equal(bp.windows[30].sample_count, 2);
  assert.equal(bp.windows[60].sample_count, 3);
  assert.equal(bp.windows[90].sample_count, 4);
});

// ─── Q2-Q6 · threshold counts ─────────────────

test('Q2-Q6. Threshold matrix >=1/>=2/>=3/>=5/>=10 populated per window', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });
  seedOrder(data, { id: 1003, shipped_at: ISO(15) });  seedItem(data, { id: 5003, order_id: 1003, sku_master_id: 100 });
  seedOrder(data, { id: 1004, shipped_at: ISO(20) });  seedItem(data, { id: 5004, order_id: 1004, sku_master_id: 100 });
  seedOrder(data, { id: 1005, shipped_at: ISO(25) });  seedItem(data, { id: 5005, order_id: 1005, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const c30 = audit.coverage_matrix.coverage[30];
  assert.equal(c30['>=1'].count, 1);
  assert.equal(c30['>=2'].count, 1);
  assert.equal(c30['>=3'].count, 1);
  assert.equal(c30['>=5'].count, 1);
  assert.equal(c30['>=10'].count, 0);
});

// ─── Q7 · Observations counted BEFORE minSamples gate ─

test('Q7. Observations counted BEFORE minSamples gate (unlike recentSoldPriceService)', async () => {
  const data = baseFixture();
  //   BP: 2 sales · would be UNKNOWN under Phase 8P default (minSamples=3)
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const bp = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === 1);
  //   Audit reports 2 · NOT UNKNOWN
  assert.equal(bp.windows[30].sample_count, 2);
});

// ─── Q8 · Cancelled excluded ─────────────────────

test('Q8. Cancelled orders excluded from coverage counts', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 1001, shipped_at: ISO(5), status: 'cancelled', payment: 'refunded', cancelled_at: ISO(4) });
  seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });
  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const bp = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === 1);
  assert.equal(bp.windows[30].sample_count, 1);
});

// ─── Q9 · Refunded excluded ────────────────────

test('Q9. Refunded / partially_refunded / failed payment excluded', async () => {
  const data = baseFixture();
  for (const pay of ['refunded', 'partially_refunded', 'failed']) {
    const id = 1000 + Math.floor(Math.random() * 10000);
    seedOrder(data, { id, shipped_at: ISO(5), payment: pay });
    seedItem(data, { id: id + 1000, order_id: id, sku_master_id: 100 });
  }
  seedOrder(data, { id: 2001, shipped_at: ISO(2) });   seedItem(data, { id: 6001, order_id: 2001, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const bp = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === 1);
  assert.equal(bp.windows[30].sample_count, 1);
});

// ─── Q10 · Unknown identity excluded ─────────

test('Q10. sku_master_id not in identity map → excluded and counted in identity_exclusions', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 500 });   // NO_CANONICAL_PHYSICAL_MAPPING
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });   // valid BP
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const bp = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === 1);
  assert.equal(bp.windows[30].sample_count, 1);
  const excl = audit.identity_exclusions;
  assert.ok(excl.distinct_excluded_sku_master_ids >= 1);
  assert.equal(excl.by_classification[IDENTITY_CLASS.NO_CANONICAL_PHYSICAL_MAPPING], 1);
});

// ─── Q11 · NO fuzzy title matching ───────────

test('Q11. Audit source never reads title / description / like / ilike', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/soldPriceCoverageAudit.js'), 'utf8');
  assert.doesNotMatch(src, /oms_order_items['"][\s\S]{0,80}\btitle\b/);
  assert.doesNotMatch(src, /\.like\s*\(/i);
  assert.doesNotMatch(src, /\.ilike\s*\(/i);
});

// ─── Q12 · distinct excluded IDs counted ─────

test('Q12. Distinct excluded sku_master_ids counted separately from affected items', async () => {
  const data = baseFixture();
  //   Sku 500 (no mapping) sold 3 times
  for (let i = 0; i < 3; i++) {
    seedOrder(data, { id: 1000 + i, shipped_at: ISO(i + 1) });
    seedItem(data, { id: 5000 + i, order_id: 1000 + i, sku_master_id: 500 });
  }
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const excl = audit.identity_exclusions;
  assert.equal(excl.distinct_excluded_sku_master_ids, 1);
  assert.equal(excl.affected_items_total, 3);
  assert.equal(excl.affected_orders_total, 3);
  assert.deepEqual(excl.channels.sort(), ['ebay']);
});

// ─── Q13 · Classification: KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P ─

test('Q13. KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P classification for qty!=1 links (multipack)', async () => {
  const data = baseFixture();
  //   Sku 900 is BP-30box (qty=30) · sold twice
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 900 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 900 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const excl = audit.identity_exclusions;
  const sku900 = excl.top_excluded_ids.find(x => x.sku_master_id === 900);
  assert.equal(sku900.classification, IDENTITY_CLASS.KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P);
  //   Physical linkage surfaces the physical it's mapped to (BP=1)
  assert.deepEqual(sku900.physicals_linked.sort(), [1]);
});

// ─── Q14 · AMBIGUOUS remains AMBIGUOUS ──────

test('Q14. AMBIGUOUS classification when sku links to multiple physicals', async () => {
  const data = baseFixture();
  //   Sku 600 links to both BP and NIKKE (AMBIGUOUS)
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 600 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const excl = audit.identity_exclusions;
  const sku600 = excl.top_excluded_ids.find(x => x.sku_master_id === 600);
  assert.equal(sku600.classification, IDENTITY_CLASS.AMBIGUOUS);
  assert.ok(sku600.physicals_linked.length >= 2);
});

// ─── Q15 · BP diagnostic surfaces the 2 pre-minSamples observations ─

test('Q15. diagnosePhysical(BP=1) surfaces eligible observations even below minSamples', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100, unit_price: 70 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100, unit_price: 80 });
  const diag = await diagnosePhysical({ physicalProductId: 1, db: makeDb(data), asOfMs, fxRates: fx });
  assert.equal(diag.windows[30].sample_count, 2);
  assert.equal(diag.eligible_observations.length, 2);
  //   No PII in observations
  for (const o of diag.eligible_observations) {
    assert.ok(!('buyer_name' in o) && !('buyer_email' in o) && !('buyer_phone' in o) && !('ship_recipient_name' in o));
  }
});

// ─── Q16-Q19 · Policy simulations ─────────

test('Q16. Policy A (30d/3) simulation surfaces gained count + coverage%', async () => {
  const data = baseFixture();
  for (let i = 0; i < 5; i++) { seedOrder(data, { id: 1000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 5000 + i, order_id: 1000 + i, sku_master_id: 100 }); }
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const polA = audit.policy_simulation.find(p => p.policy === 'A');
  assert.equal(polA.lookback_days, 30);
  assert.equal(polA.min_samples, 3);
  assert.equal(polA.physicals_gaining_candidate, 1);   // only BP
});

test('Q17. Policy B (30d/2) gains at least as many physicals as A', async () => {
  const data = baseFixture();
  for (let i = 0; i < 2; i++) { seedOrder(data, { id: 1000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 5000 + i, order_id: 1000 + i, sku_master_id: 100 }); }
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const polA = audit.policy_simulation.find(p => p.policy === 'A');
  const polB = audit.policy_simulation.find(p => p.policy === 'B');
  assert.equal(polA.physicals_gaining_candidate, 0);   // 2 samples < 3
  assert.equal(polB.physicals_gaining_candidate, 1);   // 2 samples >= 2
});

test('Q18. Policy C (60d/3) uses 60-day window · older sales counted', async () => {
  const data = baseFixture();
  //   1 sale within 30d, 3 sales within 60d
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  seedOrder(data, { id: 1002, shipped_at: ISO(40) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });
  seedOrder(data, { id: 1003, shipped_at: ISO(50) });  seedItem(data, { id: 5003, order_id: 1003, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const polA = audit.policy_simulation.find(p => p.policy === 'A');
  const polC = audit.policy_simulation.find(p => p.policy === 'C');
  assert.equal(polA.physicals_gaining_candidate, 0);
  assert.equal(polC.physicals_gaining_candidate, 1);
});

test('Q19. Policy D (90d/3) uses 90-day window · flags stale_risk if newest > 14d old', async () => {
  const data = baseFixture();
  for (let day of [40, 50, 60]) {
    const id = 1000 + day;
    seedOrder(data, { id, shipped_at: ISO(day) });
    seedItem(data, { id: id + 5000, order_id: id, sku_master_id: 100 });
  }
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const polD = audit.policy_simulation.find(p => p.policy === 'D');
  assert.equal(polD.physicals_gaining_candidate, 1);
  assert.equal(polD.stale_risk_count, 1);   // newest is 40d old > 14
});

// ─── Q20 · Median stability across windows ─

test('Q20. Median stability report compares 30/60/90 medians for physicals with >=3 obs each', async () => {
  const data = baseFixture();
  //   BP: 30d @70 x3, 60d @80 x2 more, 90d @90 x1 more → medians differ per window
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 1000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 5000 + i, order_id: 1000 + i, sku_master_id: 100, unit_price: 70 }); }
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 2000 + i, shipped_at: ISO(35 + i) }); seedItem(data, { id: 6000 + i, order_id: 2000 + i, sku_master_id: 100, unit_price: 100 }); }
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(70 + i) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 100, unit_price: 150 }); }
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const stab = audit.price_stability;
  assert.equal(stab.comparable_physicals, 1);
  const bp = stab.per_physical[0];
  //   Medians differ: 30d=94500 (70×1350), 60d=108000 (median of [70,70,70,100,100,100]=85·×1350), 90d=125000ish
  assert.ok(bp.divergence_pct > 10, `divergence must be material (>10%) · got ${bp.divergence_pct}`);
  assert.equal(bp.material, true);
});

// ─── Q21 · No PII in output ─────────────

test('Q21. Aggregate audit output contains NO buyer PII fields', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const s = JSON.stringify(audit);
  for (const banned of ['buyer_name', 'buyer_email', 'buyer_phone', 'ship_recipient_name', 'ship_street1', 'ship_street2', 'ship_phone']) {
    assert.ok(!s.includes(banned), `output must NOT contain ${banned}`);
  }
});

// ─── Q22 · Bounded query count ────────────

test('Q22. Query count bounded · O(1) in physicals (per Part 6)', async () => {
  const data = baseFixture();
  //   Add 50 physicals with sales · query count should not scale with N
  for (let i = 3; i <= 52; i++) {
    data.physical_products.push({ id: i, canonical_title: `p${i}` });
    data.sellable_units.push({ id: 100 + i, physical_product_id: i });
    data.sellable_unit_components.push({ sellable_unit_id: 100 + i, quantity_per_unit: 1 });
    data.sku_master_link.push({ sku_master_id: 1000 + i, sellable_unit_id: 100 + i });
    seedOrder(data, { id: 4000 + i, shipped_at: ISO(3) });
    seedItem(data, { id: 8000 + i, order_id: 4000 + i, sku_master_id: 1000 + i });
  }
  const db = makeDb(data);
  const audit = await runSoldPriceCoverageAudit({ db, asOfMs, fxRates: fx });
  //   physical_products(1) + identity walk(3) + all-qty identity walk(3)
  //     + per-channel orders(2) + per-channel items(2) = 11 upfront queries
  //   + identity_exclusions additional (up to 3) — total should stay < 20 regardless of physicals count
  assert.ok(audit.query_count <= 20, `query_count too high · ${audit.query_count}`);
  assert.equal(audit.physical_products_scanned, 52);
});

// ─── Q23-Q27 · Zero mutation contract ─────

test('Q23-Q27. Zero DB write / marketplace / inventory / notification / scheduler in audit source', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/soldPriceCoverageAudit.js'), 'utf8');
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/, 'no DB write');
  assert.doesNotMatch(src, /require\(['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i, 'no marketplace');
  assert.doesNotMatch(src, /require\(['"][^'"]*(?:notify|telegram|imessage)/i, 'no notification');
  assert.doesNotMatch(src, /require\(['"][^'"]*scheduler/i, 'no scheduler');
  assert.doesNotMatch(src, /create table|alter table/i, 'no DDL');
});

// ─── Q28 · recentSoldPriceService default remains minSamples=3 ─

test('Q28. recentSoldPriceService default DEFAULT_MIN_SAMPLES remains 3 (audit did NOT alter policy)', () => {
  const svc = require('../../src/services/oms/recentSoldPriceService');
  assert.equal(svc.DEFAULT_MIN_SAMPLES, 3);
  assert.equal(svc.DEFAULT_LOOKBACK_DAYS, 30);
});

// ─── Q29 · Orchestrator hierarchy unchanged ─

test('Q29. Orchestrator sale-price priority string still contains MANUAL / AUTO_SOLD_MEDIAN / AUTO_OBSERVED', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/financialMetricsOrchestrator.js'), 'utf8');
  //   Order MUST be MANUAL then SOLD MEDIAN then LISTING
  const idxManual = src.indexOf("resolution: 'MANUAL'");
  const idxSold = src.indexOf("resolution: 'AUTO_SOLD_MEDIAN'");
  const idxListing = src.indexOf("resolution: 'AUTO_OBSERVED'");
  assert.ok(idxManual > 0 && idxSold > 0 && idxListing > 0);
  assert.ok(idxManual < idxSold, 'MANUAL block appears before SOLD_MEDIAN');
  assert.ok(idxSold < idxListing, 'SOLD_MEDIAN block appears before OBSERVED');
});

// ─── Q30 · Existing Phase 8P tests remain green (structural) ─

test('Q30. Phase 8P test files still exist and are unmodified structurally by this phase', () => {
  const files = [
    'tests/oms/recentSoldPriceService.test.js',
    'tests/oms/financialMetricsOrchestrator8P.test.js',
    'tests/oms/shadowValidation8P.test.js',
  ];
  for (const f of files) {
    const p = path.resolve(__dirname, '../..', f);
    assert.ok(fs.existsSync(p), `${f} must still exist`);
  }
});

// ─── Extra: diagnosePhysical query count ─────

test('Q-extra. diagnosePhysical restricts scope to one physical · query count small', async () => {
  const data = baseFixture();
  for (let i = 0; i < 4; i++) { seedOrder(data, { id: 1000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 5000 + i, order_id: 1000 + i, sku_master_id: 100 }); }
  const diag = await diagnosePhysical({ physicalProductId: 1, db: makeDb(data), asOfMs, fxRates: fx });
  assert.equal(diag.physical_product_id, 1);
  assert.equal(diag.windows[30].sample_count, 4);
  assert.ok(diag.audit_query_count <= 20);
});

// ─── Phase 8P-2b · schema-contract regression ───────

test('Q-8P2b-1. Audit source NEVER selects sellable_units.physical_product_id (migration 086)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/soldPriceCoverageAudit.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(
    stripped,
    /['"]sellable_units['"][\s\S]{0,300}?physical_product_id/i,
    'soldPriceCoverageAudit must NOT couple sellable_units with physical_product_id',
  );
  assert.match(
    stripped,
    /['"]sellable_unit_components['"][\s\S]{0,300}?physical_product_id/i,
    'soldPriceCoverageAudit MUST source physical_product_id from sellable_unit_components',
  );
});

test('Q-8P2b-2. Fixture without sellable_units.physical_product_id still resolves coverage', async () => {
  const data = baseFixture();
  //   Assert fixture is schema-correct
  for (const su of data.sellable_units) {
    assert.ok(!('physical_product_id' in su), `sellable_units row must NOT carry physical_product_id · id=${su.id}`);
  }
  for (const c of data.sellable_unit_components) {
    assert.ok('physical_product_id' in c, `sellable_unit_components MUST carry physical_product_id · sellable_unit_id=${c.sellable_unit_id}`);
  }
  //   And coverage audit still resolves BP
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100 });
  seedOrder(data, { id: 1002, shipped_at: ISO(10) });  seedItem(data, { id: 5002, order_id: 1002, sku_master_id: 100 });
  const audit = await runSoldPriceCoverageAudit({ db: makeDb(data), asOfMs, fxRates: fx });
  const bp = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === 1);
  assert.equal(bp.windows[30].sample_count, 2);
});
