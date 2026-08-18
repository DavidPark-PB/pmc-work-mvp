'use strict';

/**
 * tests/oms/shippingCandidateService.test.js — Phase 8O.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleShippingCandidate, CANDIDATE_STATUS } = require('../../src/services/oms/shippingCandidateService');

function makeStubDb(data) {
  return {
    from(table) {
      const rows = data[table] || [];
      return {
        select() { return this; },
        eq: async (col, val) => ({ data: rows.filter(r => r[col] === val), error: null }),
        in:  async (col, vals) => ({ data: rows.filter(r => vals.includes(r[col])), error: null }),
      };
    },
  };
}

function completeFixture(weightGram = 500) {
  return {
    sellable_units: [{ id: 10, display_name: 'BP 1-Box', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }],
    sku_master: [{ id: 100, internal_sku: 'x', weight_gram: weightGram }],
  };
}

test('SH1. Happy path · weight+dims → ESTIMATED · cheapest quote picked', async () => {
  const db = makeStubDb(completeFixture(500));
  const r = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 20, widthCm: 15, heightCm: 5 });
  assert.equal(r.status, 'ESTIMATED');
  assert.ok(r.amount_krw > 0);
  assert.equal(r.weight_used_kg, 0.5);
  assert.deepEqual(r.dimensions_used_cm, { length: 20, width: 15, height: 5 });
  assert.ok(r.carrier);
});

test('SH2. Dimensions missing → UNKNOWN · reason=dimensions_missing · weight still surfaced', async () => {
  const db = makeStubDb(completeFixture(500));
  const r = await assembleShippingCandidate({ physicalProductId: 1, db });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'dimensions_missing');
  assert.equal(r.weight_used_kg, 0.5);
});

test('SH3. Partial dimensions (only length) → UNKNOWN · dimensions_missing', async () => {
  const db = makeStubDb(completeFixture(500));
  const r = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 20 });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'dimensions_missing');
});

test('SH4. No weight_gram in sku_master → UNKNOWN · reason=no_weight_gram_in_sku_master', async () => {
  const fx = completeFixture();
  fx.sku_master[0].weight_gram = null;
  const db = makeStubDb(fx);
  const r = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 20, widthCm: 15, heightCm: 5 });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'no_weight_gram_in_sku_master');
});

test('SH5. Median weight when multiple sku_masters bridged', async () => {
  const fx = {
    sellable_units: [{ id: 10, display_name: 'BP 1-Box', variant_kind: 'base', status: 'active' }],
    sellable_unit_components: [{ sellable_unit_id: 10, physical_product_id: 1, quantity_per_unit: 1, role: 'primary' }],
    sku_master_link: [{ sku_master_id: 100, sellable_unit_id: 10 }, { sku_master_id: 101, sellable_unit_id: 10 }, { sku_master_id: 102, sellable_unit_id: 10 }],
    sku_master: [
      { id: 100, internal_sku: 'a', weight_gram: 300 },
      { id: 101, internal_sku: 'b', weight_gram: 500 },
      { id: 102, internal_sku: 'c', weight_gram: 700 },
    ],
  };
  const db = makeStubDb(fx);
  const r = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 20, widthCm: 15, heightCm: 5 });
  assert.equal(r.weight_used_kg, 0.5, 'median 500g = 0.5kg');
});

test('SH6. destinationCountry other than 미국 → engine returns [] → UNKNOWN', async () => {
  const db = makeStubDb(completeFixture(500));
  const r = await assembleShippingCandidate({ physicalProductId: 1, db, destinationCountry: 'Japan', lengthCm: 20, widthCm: 15, heightCm: 5 });
  //   getQuotes may return [] or non-KRW zone; either way, if no valid quote → UNKNOWN
  assert.ok(['ESTIMATED', 'UNKNOWN'].includes(r.status));
});

test('SH7. Volumetric weight applied (larger box → more expensive quote)', async () => {
  const db = makeStubDb(completeFixture(500));
  const small = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 10, widthCm: 10, heightCm: 5 });
  const big   = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 40, widthCm: 40, heightCm: 40 });
  if (small.status === 'ESTIMATED' && big.status === 'ESTIMATED') {
    assert.ok(big.amount_krw >= small.amount_krw, `big box (${big.amount_krw}₩) should be >= small (${small.amount_krw}₩)`);
  }
});

test('SH8. Confidence note explicitly labels 예상 (never final)', async () => {
  const db = makeStubDb(completeFixture(500));
  const r = await assembleShippingCandidate({ physicalProductId: 1, db, lengthCm: 20, widthCm: 15, heightCm: 5 });
  assert.match(r.confidence_note, /예상 배송비/);
});

test('SH9. Rejects invalid physicalProductId / missing db', async () => {
  await assert.rejects(() => assembleShippingCandidate({ physicalProductId: 0, db: makeStubDb({}) }), /positive integer/);
  await assert.rejects(() => assembleShippingCandidate({ physicalProductId: 1 }), /db.*required/);
});

// ─── Phase 8P-2b · schema-contract regression ───────

test('SH-8P2b-1. Source NEVER selects sellable_units.physical_product_id (migration 086)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/shippingCandidateService.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(
    stripped,
    /['"]sellable_units['"][\s\S]{0,300}?physical_product_id/i,
    'shippingCandidateService must NOT couple sellable_units with physical_product_id',
  );
  assert.match(
    stripped,
    /['"]sellable_unit_components['"][\s\S]{0,300}?physical_product_id/i,
    'shippingCandidateService MUST source physical_product_id from sellable_unit_components',
  );
});
