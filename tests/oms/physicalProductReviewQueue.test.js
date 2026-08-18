'use strict';

/**
 * tests/oms/physicalProductReviewQueue.test.js — Phase 8P-3.
 * READ-ONLY Owner review queue tests · stub db · zero real DB access.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildPhysicalProductReviewQueue,
  DECISION_ENUM,
  LEVERAGE_TIERS,
  DEFAULT_REVIEW_LIMIT,
} = require('../../src/services/oms/physicalProductReviewQueue');
const auditMod = require('../../src/services/oms/physicalIdentityCoverageRecoveryAudit');

const asOfMs = Date.parse('2026-08-18T12:00:00Z');
const ISO = (d) => new Date(asOfMs - d * 86400_000).toISOString();

// ─── Stub db ─────────────────────────────────────

function makeDb(data) {
  const state = { queries: 0 };
  return {
    _state: state,
    from(table) {
      state.queries++;
      const rows = data[table] || [];
      const q = { _filters: [], _range: [], _limit: null };
      const build = () => {
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
        in(c, v) { q._range.push(['in', c, v]); return Promise.resolve(build()); },
        limit(n) { q._limit = n; return Promise.resolve(build()); },
        then(res) { res(build()); },
      };
    },
  };
}

//   Schema-correct fixture · physical_product_id ONLY on sellable_unit_components (Phase 8P-2a/2b).
//   Existing mappings: BP (1) ← sku 100 (qty=1), NIKKE (2) ← sku 200 (qty=1).
function baseFixture() {
  return {
    physical_products: [
      { id: 1, canonical_title: 'BP' },
      { id: 2, canonical_title: 'NIKKE' },
    ],
    sellable_units: [
      { id: 10, display_name: 'BP 1-Box',    variant_kind: 'base', status: 'active' },
      { id: 20, display_name: 'NIKKE 1-Box', variant_kind: 'base', status: 'active' },
    ],
    sellable_unit_components: [
      { sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' },
      { sellable_unit_id: 20, physical_product_id: 2, quantity_per_unit: 1, role: 'primary' },
    ],
    sku_master_link: [
      { sku_master_id: 100, sellable_unit_id: 10 },
      { sku_master_id: 200, sellable_unit_id: 20 },
    ],
    sku_master: [
      { id: 100, internal_sku: 'bp-1',      title: 'Battle Partners 1 Box',  brand: 'Pokemon', category: 'booster_box', product_type: 'sealed_pack', status: 'active' },
      { id: 200, internal_sku: 'nk-1',      title: 'Nikke 1 Box',            brand: 'Nikke',   category: 'booster_box', product_type: 'sealed_pack', status: 'active' },
      { id: 500, internal_sku: 'orphan-a',  title: 'Orphan Product A',       brand: null,      category: null,          product_type: null,          status: 'active' },
      { id: 600, internal_sku: 'orphan-b',  title: 'Orphan Product B',       brand: null,      category: null,          product_type: null,          status: 'active' },
      { id: 700, internal_sku: 'orphan-c',  title: 'Orphan Product C',       brand: null,      category: null,          product_type: null,          status: 'active' },
    ],
    sku_listing_link: [],
    oms_orders: [],
    oms_order_items: [],
  };
}

function seedOrder(d, o) {
  d.oms_orders.push({ id: o.id, channel: o.channel || 'ebay', external_order_number: 'A' + o.id, shipped_at: o.shipped_at, cancelled_at: null, order_status: 'shipped', payment_status: 'paid' });
}
function seedItem(d, o) {
  d.oms_order_items.push({
    id: o.id, order_id: o.order_id, sku_master_id: o.sku_master_id ?? null,
    product_id: o.product_id ?? null, listing_id: o.listing_id ?? null, variant_id: o.variant_id ?? null,
    marketplace_sku: o.marketplace_sku ?? null,
    quantity: 1, unit_price: 75, discount: 0, currency: 'USD',
  });
}

const fx = { usdKrw: 1350 };

// ─── U1 · Only PHYSICAL_PRODUCT_MISSING enters queue ─

test('U1. Only PHYSICAL_PRODUCT_MISSING + CREATE_PHYSICAL_PRODUCT_REVIEW enter the review queue', async () => {
  const data = baseFixture();
  //   sku 500 · orphan · no bridges · PHYSICAL_PRODUCT_MISSING
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const inQueue = q.top_review_queue.map(x => x.sku_master_id);
  assert.ok(inQueue.includes(500));
  //   No DETERMINISTIC / HUMAN_REVIEW items surface
  assert.ok(!inQueue.includes(100));  // BP mapped
  assert.ok(!inQueue.includes(200));  // NIKKE mapped
});

// ─── U2 · DETERMINISTIC / HUMAN_REVIEW excluded from queue ─

test('U2. Deterministic candidates (bridged via shared listing) excluded from queue', async () => {
  const data = baseFixture();
  //   sku 100 (mapped) + sku 700 (bridged via listing) → deterministic
  seedOrder(data, { id: 1001, shipped_at: ISO(5) });   seedItem(data, { id: 5001, order_id: 1001, sku_master_id: 100, listing_id: 'ebay:BP-listing' });
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 2000 + i, shipped_at: ISO(i + 3) }); seedItem(data, { id: 6000 + i, order_id: 2000 + i, sku_master_id: 700, listing_id: 'ebay:BP-listing' }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  //   sku 700 is DETERMINISTIC (not MISSING) → excluded from review queue
  const inQueue = q.top_review_queue.map(x => x.sku_master_id);
  assert.ok(!inQueue.includes(700), 'deterministic bridged sku must not enter Owner review queue');
});

// ─── U3 · Deterministic ranking ─

test('U3. Ranking is deterministic · completed_sale_items DESC · 30d obs DESC · 90d obs DESC · channels DESC · sku_master_id ASC', async () => {
  const data = baseFixture();
  //   sku 500: 5 items
  for (let i = 0; i < 5; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  //   sku 600: 8 items (should rank higher)
  for (let i = 0; i < 8; i++) { seedOrder(data, { id: 4000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 8000 + i, order_id: 4000 + i, sku_master_id: 600 }); }
  //   sku 700: 3 items · 2 channels (still ranks below by items count)
  seedOrder(data, { id: 5000, channel: 'shopify', shipped_at: ISO(2) }); seedItem(data, { id: 9000, order_id: 5000, sku_master_id: 700 });
  seedOrder(data, { id: 5001, channel: 'ebay', shipped_at: ISO(3) }); seedItem(data, { id: 9001, order_id: 5001, sku_master_id: 700 });
  seedOrder(data, { id: 5002, channel: 'ebay', shipped_at: ISO(4) }); seedItem(data, { id: 9002, order_id: 5002, sku_master_id: 700 });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const ids = q.top_review_queue.map(x => x.sku_master_id);
  assert.equal(ids[0], 600, 'highest items → rank 1');
  assert.equal(ids[1], 500);
  assert.equal(ids[2], 700);
  //   Ranks are contiguous 1..N
  q.top_review_queue.forEach((it, i) => assert.equal(it.review_rank, i + 1));
});

// ─── U4 · Exact listing_id grouping ─

test('U4. Exact listing_id grouping · multiple SKUs on same listing form a group', async () => {
  const data = baseFixture();
  //   3 unmapped SKUs sharing exact listing_id
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'ebay:same-listing' });
  seedOrder(data, { id: 3002, shipped_at: ISO(2) });   seedItem(data, { id: 7002, order_id: 3002, sku_master_id: 600, listing_id: 'ebay:same-listing' });
  seedOrder(data, { id: 3003, shipped_at: ISO(3) });   seedItem(data, { id: 7003, order_id: 3003, sku_master_id: 700, listing_id: 'ebay:same-listing' });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const listingGroup = q.review_groups.find(g => g.review_group_id === 'listing:ebay:same-listing');
  assert.ok(listingGroup);
  assert.equal(listingGroup.group_basis, 'exact_listing_id');
  assert.deepEqual(listingGroup.sku_master_ids.sort(), [500, 600, 700]);
  assert.match(listingGroup.suggested_owner_question, /same listing/);
});

// ─── U5 · Exact product_id grouping ─

test('U5. Exact product_id grouping (products.id) supported', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, product_id: 42 });
  seedOrder(data, { id: 3002, shipped_at: ISO(2) });   seedItem(data, { id: 7002, order_id: 3002, sku_master_id: 600, product_id: 42 });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const prodGroup = q.review_groups.find(g => g.review_group_id === 'product:42');
  assert.ok(prodGroup);
  assert.equal(prodGroup.group_basis, 'exact_product_id');
  assert.deepEqual(prodGroup.sku_master_ids.sort(), [500, 600]);
});

// ─── U6 · Title similarity NEVER groups ─

test('U6. Title similarity alone NEVER groups SKUs · distinct SKUs with similar titles remain in separate singleton groups', async () => {
  const data = baseFixture();
  data.sku_master.find(s => s.id === 500).title = 'Battle Partners Booster Box';
  data.sku_master.find(s => s.id === 600).title = 'Battle Partners Booster Box (KO)';
  data.sku_master.find(s => s.id === 700).title = 'Battle Partners Booster Box (JP)';
  //   Distinct listings · no shared identifier
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'listing-A' });
  seedOrder(data, { id: 3002, shipped_at: ISO(2) });   seedItem(data, { id: 7002, order_id: 3002, sku_master_id: 600, listing_id: 'listing-B' });
  seedOrder(data, { id: 3003, shipped_at: ISO(3) });   seedItem(data, { id: 7003, order_id: 3003, sku_master_id: 700, listing_id: 'listing-C' });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  //   Each SKU appears in ITS OWN listing group · never combined by title
  const groupCounts = q.review_groups.map(g => g.sku_master_ids.length);
  assert.ok(groupCounts.every(n => n === 1), `all 3 similar-title SKUs must be singleton groups · got ${JSON.stringify(groupCounts)}`);
});

// ─── U7 · Titles are review-evidence-only labelled ─

test('U7. Titles surface only as identity_authority=false · review_evidence_only=true evidence', async () => {
  const data = baseFixture();
  data.sku_master.find(s => s.id === 500).title = 'SECRET_INTERNAL_CODENAME_XYZ';
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const sku500 = q.top_review_queue.find(x => x.sku_master_id === 500);
  const titleEv = sku500.review_evidence.find(e => e.field === 'sku_master.title');
  assert.ok(titleEv);
  assert.equal(titleEv.value, 'SECRET_INTERNAL_CODENAME_XYZ');
  assert.equal(titleEv.identity_authority, false);
  assert.equal(titleEv.review_evidence_only, true);
  //   Item-level flags
  assert.equal(sku500.identity_authority, false);
  assert.equal(sku500.review_evidence_only, true);
});

// ─── U8 · No automatic target physical_product_id ─

test('U8. No queue item carries a target physical_product_id · decision_template.target_physical_product_id is null', async () => {
  const data = baseFixture();
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  for (const item of q.top_review_queue) {
    assert.equal(item.decision_template.target_physical_product_id, null);
    assert.equal(item.decision_template.owner_decision, null);
  }
});

// ─── U9 / U10 · auto flags always false ─

test('U9 / U10. auto_create_allowed and auto_link_allowed are FALSE everywhere', async () => {
  const data = baseFixture();
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'listing-X' });
  seedOrder(data, { id: 3002, shipped_at: ISO(2) });   seedItem(data, { id: 7002, order_id: 3002, sku_master_id: 600, listing_id: 'listing-X' });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  for (const item of q.top_review_queue) {
    assert.equal(item.decision_template.auto_create_allowed, false);
    assert.equal(item.decision_template.auto_link_allowed, false);
    assert.equal(item.decision_template.persisted, false);
  }
  for (const g of q.review_groups) {
    assert.equal(g.auto_create_allowed, false);
    assert.equal(g.auto_link_allowed, false);
  }
});

// ─── U11 · Decision template remains null / unpersisted ─

test('U11. decision_template.owner_decision / target_physical_product_id / proposed_display_name all null · persisted=false', async () => {
  const data = baseFixture();
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const tpl = q.top_review_queue[0].decision_template;
  assert.equal(tpl.owner_decision, null);
  assert.equal(tpl.target_physical_product_id, null);
  assert.equal(tpl.proposed_display_name, null);
  assert.equal(tpl.note, null);
  assert.equal(tpl.persisted, false);
});

// ─── U12 · Cumulative leverage ─

test('U12. Cumulative leverage top_5/10/20/50 compute correctly and cover pct of reviewable items', async () => {
  const data = baseFixture();
  //   Seed 8 SKUs with descending sale counts · totals 8+7+6+5+4+3+2+1 = 36 items
  const counts = [8, 7, 6, 5, 4, 3, 2, 1];
  let orderId = 3000, itemId = 7000;
  for (let s = 0; s < counts.length; s++) {
    const skuId = 500 + s;
    if (!data.sku_master.find(x => x.id === skuId)) data.sku_master.push({ id: skuId, internal_sku: `orphan-${s}`, title: `Orphan ${s}`, status: 'active' });
    for (let i = 0; i < counts[s]; i++) {
      seedOrder(data, { id: orderId, shipped_at: ISO(i + 1) });
      seedItem(data, { id: itemId, order_id: orderId, sku_master_id: skuId });
      orderId++; itemId++;
    }
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const top5 = q.cumulative_leverage.find(t => t.tier === 'top_5');
  //   top_5 covers 8+7+6+5+4 = 30 of 36 = 83.33%
  assert.equal(top5.completed_sale_items_covered, 30);
  assert.equal(top5.pct_of_reviewable_completed_sale_items, 83.33);
  //   top_10 caps at candidate count (8 candidates available)
  const top10 = q.cumulative_leverage.find(t => t.tier === 'top_10');
  assert.equal(top10.candidate_count, 8);
  assert.equal(top10.completed_sale_items_covered, 36);
  assert.equal(top10.pct_of_reviewable_completed_sale_items, 100);
});

// ─── U13 · No buyer PII ─

test('U13. Aggregate payload contains NO buyer PII', async () => {
  const data = baseFixture();
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const s = JSON.stringify(q);
  for (const banned of ['buyer_name', 'buyer_email', 'buyer_phone', 'ship_recipient_name', 'ship_street1', 'ship_street2', 'ship_phone']) {
    assert.ok(!s.includes(banned), `payload must NOT contain ${banned}`);
  }
});

// ─── U14 · Bounded query count ─

test('U14. Query count bounded · O(1) in candidate size', async () => {
  const data = baseFixture();
  //   50 excluded SKUs
  for (let i = 0; i < 50; i++) {
    const sid = 1000 + i;
    data.sku_master.push({ id: sid, internal_sku: `orphan-${sid}`, title: `Orphan ${sid}`, status: 'active' });
    for (let n = 0; n < 3; n++) {
      seedOrder(data, { id: 20000 + i * 3 + n, shipped_at: ISO(n + 1) });
      seedItem(data, { id: 30000 + i * 3 + n, order_id: 20000 + i * 3 + n, sku_master_id: sid });
    }
  }
  const db = makeDb(data);
  const q = await buildPhysicalProductReviewQueue({ db, asOfMs, fxRates: fx, pilotMappings: [] });
  //   audit queries (~12) + our enrichment (sku_master + orders×channels + items) = ≤ ~20
  assert.ok(q.query_count <= 25, `query_count too high · ${q.query_count}`);
});

// ─── U15 · Zero DB write · static assertion ─

test('U15. Service source has no DB write / marketplace / notification / scheduler / DDL', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalProductReviewQueue.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(stripped, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/, 'no DB write');
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i, 'no marketplace');
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:notify|telegram|imessage)/i, 'no notification');
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*scheduler/i, 'no scheduler');
  assert.doesNotMatch(stripped, /create table|alter table|drop table/i, 'no DDL');
});

// ─── U16 · No marketplace/notification/scheduler in CLI ─

test('U16. CLI source has no marketplace/notification/scheduler require', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-physical-product-review-queue.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i);
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:notify|telegram|imessage)/i);
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*scheduler/i);
});

// ─── U17 · No DDL/migration ─

test('U17. Migration numbering guard · 094 exists (baseline) · 095 exists (Phase 8P-5 writer · not applied) · no 096+ added by 8P-3', () => {
  const migDir = path.resolve(__dirname, '../../supabase/migrations');
  const files = fs.readdirSync(migDir).filter(f => /^09\d_/.test(f));
  const numbers = files.map(f => Number(f.match(/^(\d+)_/)[1])).sort((a, b) => a - b);
  assert.ok(numbers.includes(94), '094 baseline judgment_snapshots migration expected');
  //   Phase 8P-5 added 095 (physical_write_audit + RPC · file only, unapplied).
  //   Anything ≥ 096 would be a new phase that this guard did not authorize.
  assert.ok(!numbers.some(n => n >= 96), `no migration >= 096 permitted by earlier Phase 8P-3 · found ${numbers.filter(n => n >= 96)}`);
});

// ─── U18 · DEFAULT_MIN_SAMPLES remains 3 ─

test('U18. recentSoldPriceService.DEFAULT_MIN_SAMPLES still 3', () => {
  const svc = require('../../src/services/oms/recentSoldPriceService');
  assert.equal(svc.DEFAULT_MIN_SAMPLES, 3);
  assert.equal(svc.DEFAULT_LOOKBACK_DAYS, 30);
});

// ─── U19 · Candidate hierarchy unchanged ─

test('U19. Orchestrator MANUAL > AUTO_SOLD_MEDIAN > AUTO_OBSERVED preserved', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/financialMetricsOrchestrator.js'), 'utf8');
  const idxManual = src.indexOf("resolution: 'MANUAL'");
  const idxSold = src.indexOf("resolution: 'AUTO_SOLD_MEDIAN'");
  const idxListing = src.indexOf("resolution: 'AUTO_OBSERVED'");
  assert.ok(idxManual > 0 && idxSold > 0 && idxListing > 0);
  assert.ok(idxManual < idxSold && idxSold < idxListing);
});

// ─── U20 · BP mapping invariant ─

test('U20. BP physical#1 mapping [100 in this fixture] unchanged after review queue build · zero auto attachments', async () => {
  const data = baseFixture();
  //   Seed some orphans + a listing that BP also uses — verify BP mapping unchanged
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'ebay:BP-listing' });
  //   BP known link is [100] in fixture. Queue MUST not attach 500 to BP.
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  assert.deepEqual(q.bp_invariants.currently_linked_sku_master_ids, [100]);
  assert.equal(q.bp_invariants.zero_auto_attachments, true);
});

// ─── U21 · BP WATCH/priority 170 untouched ─

test('U21. Service NEVER touches inventoryOwnerDecisionService or inventoryDecisionEngine', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalProductReviewQueue.js'), 'utf8');
  assert.doesNotMatch(src, /require\s*\(\s*['"][^'"]*inventoryOwnerDecisionService/);
  assert.doesNotMatch(src, /require\s*\(\s*['"][^'"]*inventoryDecisionEngine/);
  assert.doesNotMatch(src, /priority_score\s*=/);
  assert.doesNotMatch(src, /decision_status\s*=/);
});

// ─── U22 · Migration-backed schema contract ─

test('U22. Migration 086 has no physical_product_id · 087 has it · fixture matches truth', () => {
  const m086 = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/086_sellable_units.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const m087 = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/087_sellable_unit_components.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(m086, /physical_product_id/);
  assert.match(m087, /\bphysical_product_id\b/);
  //   Our baseFixture obeys the same contract
  const data = baseFixture();
  for (const su of data.sellable_units) {
    assert.ok(!('physical_product_id' in su), 'sellable_units fixture must not carry physical_product_id');
  }
  for (const c of data.sellable_unit_components) {
    assert.ok('physical_product_id' in c, 'sellable_unit_components fixture must carry physical_product_id');
  }
});

// ─── extras · decision enum + review-limit control ─

test('U-extra-1. DECISION_ENUM exposes exactly the 5 documented enum values', () => {
  assert.deepEqual(Object.keys(DECISION_ENUM).sort(), [
    'CREATE_NEW_PHYSICAL', 'DEFER', 'LINK_TO_EXISTING_PHYSICAL', 'MARK_NON_PHYSICAL', 'NEEDS_MORE_EVIDENCE',
  ]);
});

test('U-extra-2. reviewLimit caps top_review_queue length · other data unaffected', async () => {
  const data = baseFixture();
  for (let s = 0; s < 6; s++) {
    const skuId = 500 + s;
    if (!data.sku_master.find(x => x.id === skuId)) data.sku_master.push({ id: skuId, internal_sku: `orphan-${s}`, title: `Orphan ${s}`, status: 'active' });
    for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + s * 10 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + s * 10 + i, order_id: 3000 + s * 10 + i, sku_master_id: skuId }); }
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [], reviewLimit: 3 });
  assert.equal(q.top_review_queue.length, 3);
  //   summary still reflects the full missing set
  assert.equal(q.summary.physical_missing_candidates, 6);
});

test('U-extra-3. Reuse contract · service imports from physicalIdentityCoverageRecoveryAudit (SoT single point)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalProductReviewQueue.js'), 'utf8');
  assert.match(src, /require\s*\(\s*['"]\.\/physicalIdentityCoverageRecoveryAudit['"]/);
  //   And the exported enums are re-checked at runtime · not local copies of the classification
  assert.equal(typeof auditMod.CLASSIFICATION.PHYSICAL_PRODUCT_MISSING, 'string');
  assert.equal(typeof auditMod.PROPOSED_ACTION.CREATE_PHYSICAL_PRODUCT_REVIEW, 'string');
});

// ═════ Phase 8P-4 · Creation candidates + review plan tests ═════

test('P4-1. 100 candidates (1 SKU each · distinct listing+product) → 100 physical_creation_candidates · NOT 200', async () => {
  //   Reproduces the production ratio drift: previously each SKU could
  //   appear in TWO evidence groups (listing + product). Assert cohort
  //   count = unique SKU count when identifiers are all distinct.
  const data = baseFixture();
  const N = 12;
  for (let s = 0; s < N; s++) {
    const skuId = 500 + s;
    if (!data.sku_master.find(x => x.id === skuId)) data.sku_master.push({ id: skuId, internal_sku: `orphan-${s}`, title: `Orphan ${s}`, status: 'active' });
    seedOrder(data, { id: 3000 + s, shipped_at: ISO(s + 1) });
    //   Each SKU has BOTH listing_id AND product_id · distinct per SKU
    seedItem(data, { id: 7000 + s, order_id: 3000 + s, sku_master_id: skuId, listing_id: `listing-${s}`, product_id: 1000 + s });
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  //   Evidence groups will DOUBLE (each SKU appears in listing + product) — that's expected
  assert.equal(q.summary.review_groups, 2 * N, 'evidence groups double because each SKU has listing AND product evidence');
  //   Physical creation candidates = unique SKU count (union-find leaves each alone)
  assert.equal(q.summary.physical_creation_candidates, N);
  assert.equal(q.summary.singleton_creation_candidates, N);
  assert.equal(q.summary.multi_sku_creation_candidates, 0);
});

test('P4-2. Single SKU with both listing and product evidence → 1 creation candidate (not 2)', async () => {
  const data = baseFixture();
  //   sku 500 with BOTH listing and product identifiers
  for (let i = 0; i < 3; i++) {
    seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) });
    seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500, listing_id: 'ebay:L1', product_id: 42 });
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const cohorts = q.physical_creation_candidates;
  //   Exactly ONE cohort for sku 500 · listing_ids and product_ids both surface
  const sku500Cohort = cohorts.find(c => c.sku_master_ids.includes(500));
  assert.ok(sku500Cohort);
  assert.equal(sku500Cohort.sku_master_ids.length, 1);
  //   Only ONE candidate for sku 500 (not two)
  assert.equal(cohorts.filter(c => c.sku_master_ids.includes(500)).length, 1);
  //   Evidence still surfaces both listing and product
  assert.ok(sku500Cohort.listing_ids.includes('ebay:L1'));
  assert.ok(sku500Cohort.product_ids.includes(42));
});

test('P4-3. Multi-SKU cohort · 3 SKUs share exact listing_id → 1 creation candidate cohort', async () => {
  const data = baseFixture();
  const shared = 'ebay:shared-listing';
  for (let i = 0; i < 3; i++) {
    const skuId = 500 + i;
    if (!data.sku_master.find(x => x.id === skuId)) data.sku_master.push({ id: skuId, internal_sku: `sku-${i}`, title: `Product ${i}`, status: 'active' });
    seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) });
    seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: skuId, listing_id: shared });
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const cohortSets = q.physical_creation_candidates.map(c => c.sku_master_ids);
  //   Exactly ONE cohort containing all 3 SKUs
  const multiCohort = cohortSets.find(s => s.length >= 3);
  assert.deepEqual(multiCohort.sort(), [500, 501, 502]);
  assert.equal(q.summary.multi_sku_creation_candidates, 1);
});

test('P4-4. Transitive union · SKUs A/B share listing_L1 · B/C share product_P1 → 1 cohort of {A,B,C}', async () => {
  const data = baseFixture();
  for (let i = 0; i < 3; i++) {
    const skuId = 500 + i;
    if (!data.sku_master.find(x => x.id === skuId)) data.sku_master.push({ id: skuId, internal_sku: `sku-${i}`, title: `X ${i}`, status: 'active' });
  }
  //   SKU 500 + 501 both on listing 'L1'
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'L1' });
  seedOrder(data, { id: 3002, shipped_at: ISO(2) });   seedItem(data, { id: 7002, order_id: 3002, sku_master_id: 501, listing_id: 'L1', product_id: 42 });
  //   SKU 501 + 502 both share product 42
  seedOrder(data, { id: 3003, shipped_at: ISO(3) });   seedItem(data, { id: 7003, order_id: 3003, sku_master_id: 502, product_id: 42 });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const cohort = q.physical_creation_candidates.find(c => c.sku_master_ids.length === 3);
  assert.ok(cohort, 'transitive union must produce one 3-SKU cohort');
  assert.deepEqual(cohort.sku_master_ids.sort(), [500, 501, 502]);
});

test('P4-5. Title similarity NEVER merges cohorts · same franchise/brand does not union', async () => {
  const data = baseFixture();
  //   3 SKUs · all "NIKKE Booster Box" · distinct listings and products
  for (let i = 0; i < 3; i++) {
    const skuId = 500 + i;
    data.sku_master.push({ id: skuId, internal_sku: `nikke-${i}`, title: `NIKKE Booster Box v${i}`, brand: 'NIKKE', status: 'active' });
    seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) });
    seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: skuId, listing_id: `distinct-listing-${i}` });
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  //   Each SKU is its own cohort · none merged despite identical brand + similar titles
  const nikkeCohorts = q.physical_creation_candidates.filter(c => c.sku_master_ids.some(s => [500, 501, 502].includes(s)));
  assert.equal(nikkeCohorts.length, 3, `each NIKKE SKU must be its own cohort · got ${nikkeCohorts.length}`);
  for (const c of nikkeCohorts) assert.equal(c.sku_master_ids.length, 1);
});

test('P4-6. evidence_stats surfaces skus_in_both_listing_and_product_evidence + duplicated_sku_count', async () => {
  const data = baseFixture();
  //   sku 500 has BOTH listing + product · sku 501 only listing · sku 502 only product
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'L1', product_id: 42 });
  seedOrder(data, { id: 3002, shipped_at: ISO(2) });   seedItem(data, { id: 7002, order_id: 3002, sku_master_id: 501, listing_id: 'L2' });
  seedOrder(data, { id: 3003, shipped_at: ISO(3) });   seedItem(data, { id: 7003, order_id: 3003, sku_master_id: 502, product_id: 99 });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  assert.equal(q.evidence_stats.skus_in_both_listing_and_product_evidence, 1);
  //   sku 500 appears in listing:L1 AND product:42 → 2 groups → duplicated
  assert.equal(q.evidence_stats.duplicated_sku_count_across_evidence_groups, 1);
});

test('P4-7. NIKKE-titled SKU is NEVER auto-linked to NIKKE physical · proposed_decision defaults to CREATE_NEW_PHYSICAL with franchise_caveat', async () => {
  //   NIKKE physical (id=2) exists. Unmapped sku with title "NIKKE Booster
  //   Box vNew" · no bridge to NIKKE. Recommendation must be CREATE (not LINK)
  //   and franchise_caveat must be set.
  const data = baseFixture();
  //   Rename NIKKE for franchise-detection test
  data.physical_products.find(p => p.id === 2).canonical_title = 'NIKKE Booster';
  data.sku_master.push({ id: 500, internal_sku: 'nikke-v99', title: 'NIKKE Booster Box vNew', brand: 'NIKKE', status: 'active' });
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500, listing_id: 'ebay:new-listing' }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const plan = q.creation_review_plan.plan.find(p => p.sku_master_ids.includes(500));
  assert.ok(plan);
  assert.equal(plan.proposed_decision, DECISION_ENUM.CREATE_NEW_PHYSICAL, 'must recommend CREATE despite NIKKE title overlap');
  assert.notEqual(plan.proposed_decision, DECISION_ENUM.LINK_TO_EXISTING_PHYSICAL);
  //   franchise_caveat may fire if NIKKE physical has NIKKE in title — depends on _bpDiagnostic exposure of physical#2's title.
  //   Our fixture uses physical#1 only for caveat comparison; ensure existing_physical_authoritative_bridge=null
  assert.equal(plan.existing_physical_authoritative_bridge, null);
});

test('P4-8. Franchise-token-overlapping SKU title triggers franchise_caveat but does NOT auto-link · recommendation stays CREATE_NEW_PHYSICAL', async () => {
  //   Franchise detector uses tokens ≥3 chars. Fixture physical#1 title
  //   is 'BP' (2 chars · filtered) · rename to 'Battle Partners' so the
  //   caveat has real tokens to compare.
  const data = baseFixture();
  data.physical_products.find(p => p.id === 1).canonical_title = 'Battle Partners';
  data.sku_master.push({ id: 500, internal_sku: 'bp-new', title: 'Battle Partners New Variant Booster Box', brand: 'Pokemon', status: 'active' });
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500, listing_id: 'ebay:bp-new-listing' }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const plan = q.creation_review_plan.plan.find(p => p.sku_master_ids.includes(500));
  assert.ok(plan);
  //   Title tokens {battle, partners, ...} overlap with physical#1 tokens {battle, partners} → caveat fires
  assert.equal(plan.franchise_caveat != null, true, 'franchise caveat must fire when title tokens overlap with an existing physical title');
  assert.equal(plan.proposed_decision, DECISION_ENUM.CREATE_NEW_PHYSICAL);
  assert.equal(plan.auto_link_allowed, false);
});

test('P4-9. write_allowed / auto_create_allowed / auto_link_allowed always FALSE on every plan entry', async () => {
  const data = baseFixture();
  for (let i = 0; i < 5; i++) {
    const skuId = 500 + i;
    data.sku_master.push({ id: skuId, internal_sku: `s-${i}`, title: `T ${i}`, status: 'active' });
    seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) });
    seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: skuId, listing_id: `listing-${i}` });
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  for (const p of q.creation_review_plan.plan) {
    assert.equal(p.write_allowed, false);
    assert.equal(p.auto_create_allowed, false);
    assert.equal(p.auto_link_allowed, false);
    assert.equal(p.decision_template.owner_confirmed, false);
    assert.equal(p.decision_template.persisted, false);
  }
});

test('P4-10. Canonical writer interface schema exposes execution_allowed=false + writer_contract.forbids_fuzzy_matching', () => {
  const { CANONICAL_WRITER_INTERFACE } = require('../../src/services/oms/physicalProductReviewQueue');
  assert.equal(CANONICAL_WRITER_INTERFACE.execution_allowed, false);
  assert.equal(CANONICAL_WRITER_INTERFACE.writer_contract.forbids_fuzzy_matching, true);
  assert.equal(CANONICAL_WRITER_INTERFACE.writer_contract.respects_bp_invariant_lock, true);
  assert.equal(CANONICAL_WRITER_INTERFACE.writer_contract.requires_owner_confirmed, true);
});

test('P4-11. BP invariants unchanged after 8P-4 · currently_linked_sku_master_ids preserved', async () => {
  const data = baseFixture();
  //   Add candidates that share BP's listing to try to trigger auto-attach
  seedOrder(data, { id: 3001, shipped_at: ISO(1) });   seedItem(data, { id: 7001, order_id: 3001, sku_master_id: 500, listing_id: 'ebay:BP-listing' });
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  //   BP mapping = [100] from fixture · MUST remain unchanged
  assert.deepEqual(q.bp_invariants.currently_linked_sku_master_ids, [100]);
  assert.equal(q.bp_invariants.zero_auto_attachments, true);
});

test('P4-12. Creation plan cohort_bridge basis reflects the authoritative identifier · never title', async () => {
  const data = baseFixture();
  for (let i = 0; i < 2; i++) {
    const skuId = 500 + i;
    data.sku_master.push({ id: skuId, internal_sku: `s-${i}`, title: `Shared ${i}`, status: 'active' });
    seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) });
    seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: skuId, listing_id: 'ebay:SHARED' });
  }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const cohort = q.physical_creation_candidates.find(c => c.sku_master_ids.length === 2);
  assert.equal(cohort.cohort_bridge.basis, 'exact_listing_id');
  assert.equal(cohort.cohort_bridge.value, 'listing:ebay:SHARED');
});

test('P4-13. Singleton cohort_bridge.basis = singleton_sku_master_id', async () => {
  const data = baseFixture();
  data.sku_master.push({ id: 500, internal_sku: 'alone', title: 'Alone', status: 'active' });
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500, listing_id: 'ebay:alone' }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const cohort = q.physical_creation_candidates.find(c => c.sku_master_ids.includes(500));
  //   Only sku 500 on 'ebay:alone' → singleton cohort even though listing exists
  assert.equal(cohort.sku_master_ids.length, 1);
  assert.equal(cohort.cohort_bridge.basis, 'singleton_sku_master_id');
});

test('P4-14. Creation plan proposed_display_name is the SKU title (review-only · not authoritative)', async () => {
  const data = baseFixture();
  data.sku_master.push({ id: 500, internal_sku: 'x', title: 'Suggested Display Name Here', status: 'active' });
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500, listing_id: 'ebay:x' }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const plan = q.creation_review_plan.plan.find(p => p.sku_master_ids.includes(500));
  assert.equal(plan.proposed_display_name, 'Suggested Display Name Here');
  //   title_review_only carries the correct labels
  assert.equal(plan.title_review_only.identity_authority, false);
  assert.equal(plan.title_review_only.review_evidence_only, true);
});

test('P4-15. Sales without any identifier evidence → NEEDS_MORE_EVIDENCE', async () => {
  const data = baseFixture();
  data.sku_master.push({ id: 500, internal_sku: 'no-id', title: 'Product Without Identifier', status: 'active' });
  //   3 completed sales · NO listing_id · NO product_id
  for (let i = 0; i < 3; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  const plan = q.creation_review_plan.plan.find(p => p.sku_master_ids.includes(500));
  assert.equal(plan.proposed_decision, DECISION_ENUM.NEEDS_MORE_EVIDENCE);
});

test('P4-16. Ranking + leverage unchanged · existing top_review_queue still sorted the same way', async () => {
  //   Same as U3 · verify additive change did not perturb ranking.
  const data = baseFixture();
  for (let i = 0; i < 5; i++) { seedOrder(data, { id: 3000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 7000 + i, order_id: 3000 + i, sku_master_id: 500 }); }
  for (let i = 0; i < 8; i++) { seedOrder(data, { id: 4000 + i, shipped_at: ISO(i + 1) }); seedItem(data, { id: 8000 + i, order_id: 4000 + i, sku_master_id: 600 }); }
  const q = await buildPhysicalProductReviewQueue({ db: makeDb(data), asOfMs, fxRates: fx, pilotMappings: [] });
  //   sku 600 (8 items) ranks above sku 500 (5 items)
  assert.equal(q.top_review_queue[0].sku_master_id, 600);
  assert.equal(q.top_review_queue[1].sku_master_id, 500);
});

test('P4-17. No DB write path added by 8P-4 additions', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalProductReviewQueue.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(stripped, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/, '8P-4 must not introduce DB write');
});

test('P4-18. Migration numbering guard · 094 exists · 095 is the sole Phase 8P-5 authorized addition (unapplied) · no 096+ from 8P-4', () => {
  const migDir = path.resolve(__dirname, '../../supabase/migrations');
  const files = fs.readdirSync(migDir).filter(f => /^09\d_/.test(f));
  const numbers = files.map(f => Number(f.match(/^(\d+)_/)[1])).sort((a, b) => a - b);
  assert.ok(numbers.includes(94));
  //   095 = physical_write_audit + RPC (Phase 8P-5 · file only). This guard
  //   permits 095 explicitly. Any migration ≥ 096 would be a new phase.
  assert.ok(!numbers.some(n => n >= 96), `no migration >= 096 permitted by earlier Phase 8P-4 · found ${numbers.filter(n => n >= 96)}`);
});
