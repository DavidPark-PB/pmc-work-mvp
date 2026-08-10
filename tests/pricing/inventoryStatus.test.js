'use strict';

/**
 * inventoryStatus.test.js — Phase 1 Commit 8
 * ---------------------------------------------------------------------------
 * Pin the UNKNOWN vs ZERO contract at the helper level and at every
 * downstream caller that was previously silently coalescing null → 0.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const inv = require('../../src/pricing/inventoryStatus');
const { STATUS } = inv;

/* ─────────────────────────── 1. classifyQuantity ─────────────────────────── */

test('classifyQuantity — null → UNKNOWN', () => {
  assert.deepEqual(inv.classifyQuantity(null), { status: STATUS.UNKNOWN, quantity: null });
});
test('classifyQuantity — undefined → UNKNOWN', () => {
  assert.deepEqual(inv.classifyQuantity(undefined), { status: STATUS.UNKNOWN, quantity: null });
});
test('classifyQuantity — non-numeric string → UNKNOWN', () => {
  assert.deepEqual(inv.classifyQuantity('abc'), { status: STATUS.UNKNOWN, quantity: null });
});
test('classifyQuantity — empty string → UNKNOWN', () => {
  // Number('') === 0 — DO NOT let that path treat missing input as sold-out
  assert.deepEqual(inv.classifyQuantity(''), { status: STATUS.UNKNOWN, quantity: null });
});
test('classifyQuantity — boolean → INVALID', () => {
  assert.deepEqual(inv.classifyQuantity(true), { status: STATUS.INVALID, quantity: null });
  assert.deepEqual(inv.classifyQuantity(false), { status: STATUS.INVALID, quantity: null });
});
test('classifyQuantity — negative → INVALID', () => {
  assert.deepEqual(inv.classifyQuantity(-1), { status: STATUS.INVALID, quantity: null });
});
test('classifyQuantity — 0 → OUT_OF_STOCK', () => {
  assert.deepEqual(inv.classifyQuantity(0), { status: STATUS.OUT_OF_STOCK, quantity: 0 });
  assert.deepEqual(inv.classifyQuantity('0'), { status: STATUS.OUT_OF_STOCK, quantity: 0 });
});
test('classifyQuantity — positive integer → KNOWN_STOCK', () => {
  assert.deepEqual(inv.classifyQuantity(5), { status: STATUS.KNOWN_STOCK, quantity: 5 });
  assert.deepEqual(inv.classifyQuantity('5'), { status: STATUS.KNOWN_STOCK, quantity: 5 });
});
test('classifyQuantity — non-integer float → INVALID', () => {
  assert.deepEqual(inv.classifyQuantity(2.5), { status: STATUS.INVALID, quantity: null });
});
test('classifyQuantity — Infinity → UNKNOWN', () => {
  assert.deepEqual(inv.classifyQuantity(Infinity), { status: STATUS.UNKNOWN, quantity: null });
  assert.deepEqual(inv.classifyQuantity(NaN), { status: STATUS.UNKNOWN, quantity: null });
});

/* ─────────────────────────── 2. fromEbayProductsRow ─────────────────────────── */

test('fromEbayProductsRow — null row → UNKNOWN', () => {
  assert.equal(inv.fromEbayProductsRow(null).status, STATUS.UNKNOWN);
});
test('fromEbayProductsRow — row missing ebay_api_stock → UNKNOWN', () => {
  assert.equal(inv.fromEbayProductsRow({ stock: 5 }).status, STATUS.UNKNOWN);
});
test('fromEbayProductsRow — NEVER coalesces to row.stock (that was the bug)', () => {
  // Historic bug: `row.ebay_api_stock ?? row.stock, 0` silently substituted
  // local `stock` when marketplace snapshot was UNKNOWN.
  const row = { ebay_api_stock: null, stock: 3 };
  const c = inv.fromEbayProductsRow(row);
  assert.equal(c.status, STATUS.UNKNOWN);
  assert.equal(c.quantity, null);
});

/* ─────────────────────────── 3. predicates ─────────────────────────── */

test('isSellable — only KNOWN_STOCK returns true', () => {
  assert.equal(inv.isSellable({ ebay_api_stock: 5 }), true);
  assert.equal(inv.isSellable({ ebay_api_stock: 0 }), false);
  assert.equal(inv.isSellable({ ebay_api_stock: null }), false);
  assert.equal(inv.isSellable({}), false);
});
test('isConfirmedOutOfStock — only OUT_OF_STOCK returns true (UNKNOWN != sold out)', () => {
  assert.equal(inv.isConfirmedOutOfStock({ ebay_api_stock: 0 }), true);
  assert.equal(inv.isConfirmedOutOfStock({ ebay_api_stock: null }), false);
  assert.equal(inv.isConfirmedOutOfStock({}), false);
  assert.equal(inv.isConfirmedOutOfStock({ ebay_api_stock: 5 }), false);
});
test('isKnown — KNOWN_STOCK or OUT_OF_STOCK returns true; UNKNOWN/INVALID false', () => {
  assert.equal(inv.isKnown({ ebay_api_stock: 5 }), true);
  assert.equal(inv.isKnown({ ebay_api_stock: 0 }), true);
  assert.equal(inv.isKnown({ ebay_api_stock: null }), false);
  assert.equal(inv.isKnown({ ebay_api_stock: -1 }), false);
});

/* ─────────────────────────── 4. toDbValue (write path) ─────────────────────────── */

test('toDbValue — null in → null out (preserves UNKNOWN on INSERT/UPDATE)', () => {
  assert.equal(inv.toDbValue(null), null);
  assert.equal(inv.toDbValue(undefined), null);
});
test('toDbValue — 0 → 0 (do not lose confirmed sold-out)', () => {
  assert.equal(inv.toDbValue(0), 0);
});
test('toDbValue — positive int → number', () => {
  assert.equal(inv.toDbValue(5), 5);
  assert.equal(inv.toDbValue('5'), 5);
});
test('toDbValue — invalid → null (never write garbage)', () => {
  assert.equal(inv.toDbValue(-1), null);
  assert.equal(inv.toDbValue(2.5), null);
  assert.equal(inv.toDbValue('abc'), null);
  assert.equal(inv.toDbValue(NaN), null);
  assert.equal(inv.toDbValue(true), null);
});

/* ─────────────────────────── 5. productSync uses the helper ─────────────────────────── */

test('AUDIT: productSync.mapToRow uses toDbValue and drops UNKNOWN so DB default (removed) does not fill', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/productSync.js'), 'utf8');
  // The old `parseInt(item.quantity) || 0` pattern is gone
  assert.equal(/ebay_api_stock:\s*parseInt\(item\.quantity\)\s*\|\|\s*0/.test(src), false);
  // The new pattern uses toDbValue
  assert.match(src, /toDbValue\(item\.quantity\)/);
  // And drops the key when null so we don't overwrite with a fake value
  assert.match(src, /if \(row\.ebay_api_stock === null\) delete row\.ebay_api_stock/);
});

/* ─────────────────────────── 6. hermesExecutionApproval — UNKNOWN blocks signals ─────────────────────────── */

test('AUDIT: hermes overstock / slow_mover signals guard against null availability', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/hermesExecutionApproval.js'), 'utf8');
  // The three `?? sourceRow.ebay_api_stock ?? sourceRow.stock, 0` sites are gone
  assert.equal(/sourceRow\.ebay_api_stock\s*\?\?\s*sourceRow\.stock,\s*0/.test(src), false);
  assert.equal(/row\.ebay_api_stock\s*\?\?\s*row\.stock,\s*0/.test(src), false);
  // Guard: overstock signal requires available != null
  assert.match(src, /if \(available != null && available >= 10 && recentSales === 0\)/);
  assert.match(src, /else if \(available != null && available > 0 && totalSales <= 1 && recentSales === 0\)/);
});

test('AUDIT: hermes imports inventoryStatus helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/hermesExecutionApproval.js'), 'utf8');
  assert.match(src, /require\(['"]\.\.\/pricing\/inventoryStatus['"]\)/);
});

/* ─────────────────────────── 7. skuContextBuilder ─────────────────────────── */

test('AUDIT: skuContextBuilder.dbInventoryToCanonical uses inventoryStatus, not stock fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/skuContextBuilder.js'), 'utf8');
  // Old `toInteger(row.ebay_api_stock ?? row.stock, 0)` gone
  assert.equal(/toInteger\(row\.ebay_api_stock\s*\?\?\s*row\.stock,\s*0\)/.test(src), false);
  // New helper import + status derivation
  assert.match(src, /require\(['"]\.\.\/pricing\/inventoryStatus['"]\)/);
  assert.match(src, /fromEbayProductsRow\(row\)/);
});

const skuCtx = require('../../src/services/skuContextBuilder');

test('dbInventoryToCanonical — UNKNOWN row → available_quantity null, stock_status "unknown"', () => {
  const row = { item_id: '1', sku: 'S', ebay_api_stock: null, stock: 5, sales_count: 3 };
  const canonical = skuCtx.dbInventoryToCanonical(row);
  assert.equal(canonical.available_quantity, null);
  assert.equal(canonical.stock_status, 'unknown');
  assert.equal(canonical.sold_quantity, 3);
});

test('dbInventoryToCanonical — 0 → available_quantity 0, stock_status "out_of_stock"', () => {
  const row = { item_id: '1', sku: 'S', ebay_api_stock: 0, sales_count: 0 };
  const canonical = skuCtx.dbInventoryToCanonical(row);
  assert.equal(canonical.available_quantity, 0);
  assert.equal(canonical.stock_status, 'out_of_stock');
});

test('dbInventoryToCanonical — positive → in_stock', () => {
  const row = { item_id: '1', sku: 'S', ebay_api_stock: 7 };
  const canonical = skuCtx.dbInventoryToCanonical(row);
  assert.equal(canonical.available_quantity, 7);
  assert.equal(canonical.stock_status, 'in_stock');
});

test('dbInventoryToCanonical — never coalesces to row.stock (regression guard)', () => {
  const row = { item_id: '1', sku: 'S', ebay_api_stock: null, stock: 999 };
  const canonical = skuCtx.dbInventoryToCanonical(row);
  assert.notEqual(canonical.available_quantity, 999);
  assert.equal(canonical.available_quantity, null);
});

/* ─────────────────────────── 8. api.js P0 — silent stock=0 fallback removed ─────────────────────────── */

test('AUDIT: /anomalies handler no longer falls back to stock=0 for out-of-stock list', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/web/routes/api.js'), 'utf8');
  // The block that ran a stock=0 query when ebay_api_stock query returned empty is gone
  assert.equal(/if \(outOfStock\.length === 0\) \{\s*try \{[\s\S]*?\.eq\('stock', 0\)[\s\S]*?prevStock: 0/.test(src), false);
  // The new block surfaces schema errors instead of silently substituting
  assert.match(src, /silent corruption/);
  assert.match(src, /outOfStockError/);
});

/* ─────────────────────────── 9. migration 076 file exists and is idempotent-safe ─────────────────────────── */

test('migration 076 exists and drops default on ebay_api_stock', () => {
  const p = path.join(__dirname, '../../supabase/migrations/076_ebay_api_stock_drop_default.sql');
  assert.equal(fs.existsSync(p), true);
  const sql = fs.readFileSync(p, 'utf8');
  assert.match(sql, /ALTER COLUMN ebay_api_stock DROP DEFAULT/);
  assert.match(sql, /NEVER default to 0 in code — UNKNOWN != ZERO/);
});
