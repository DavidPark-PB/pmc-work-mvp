/**
 * src/services/oms/costFiller.js — Fill cost snapshot on CanonicalOrderItems
 * after SKU match, using sku_master / products masters.
 *
 * Owner directive §8:
 *   SKU match 성공 후:
 *     우선순위 1. sku_master landed cost   (현재 컬럼 없음 · nullable)
 *              2. sku_master cost_krw
 *              3. products cost_price
 *              4. null
 *   unitCostSnapshot / landedCostSnapshot / costCurrency / costSource 저장.
 *   이미 snapshot 존재 시 덮어쓰지 않는다. (persistence 단계에서 강제 — costResolver.shouldWriteCostSnapshot)
 *
 * sku_master 실제 컬럼 확인 (038 · 069):
 *   cost_krw NUMERIC — Engine 1 canonical unit cost. Currency = KRW.
 *   landed_cost 컬럼 존재하지 않음 → 항상 null 반환.
 *
 * products 실제 컬럼 (002/005):
 *   cost_price NUMERIC — currency 명시 없음 → null 로 저장.
 */
'use strict';

const { resolveCostSnapshot } = require('./costResolver');
const { getClient } = require('../../db/supabaseClient');

/**
 * Fill cost snapshot on canonical items in-place. Non-destructive to input arr.
 *
 * @param {import('./canonicalOrder').CanonicalOrderItem[]} items
 * @returns {Promise<import('./canonicalOrder').CanonicalOrderItem[]>}
 */
async function fillCostSnapshotForItems(items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // Collect distinct ids to batch-fetch.
  const skuIds = [...new Set(items.map(i => i.skuMasterId).filter((v) => Number.isInteger(v) && v > 0))];
  const productIds = [...new Set(items.map(i => i.productId).filter((v) => Number.isInteger(v) && v > 0))];

  const [skuRowsById, productRowsById] = await Promise.all([
    _fetchSkuMasterRows(skuIds),
    _fetchProductsRows(productIds),
  ]);

  return items.map((item) => {
    // Only fill if we have some master to consult
    if (!item.skuMasterId && !item.productId) return item;
    const skuRow = item.skuMasterId ? skuRowsById.get(item.skuMasterId) : null;
    const prodRow = item.productId ? productRowsById.get(item.productId) : null;
    const snap = resolveCostSnapshot({ skuMasterRow: skuRow, productsRow: prodRow });
    if (snap.unitCostSnapshot == null) return item;
    return {
      ...item,
      unitCostSnapshot: snap.unitCostSnapshot,
      landedCostSnapshot: snap.landedCostSnapshot,
      costCurrency: snap.costCurrency,
      costSource: snap.costSource,
    };
  });
}

async function _fetchSkuMasterRows(ids) {
  const out = new Map();
  if (ids.length === 0) return out;
  try {
    const { data } = await getClient().from('sku_master')
      .select('id, cost_krw, internal_sku')
      .in('id', ids);
    (data || []).forEach((r) => out.set(r.id, r));
  } catch (_e) { /* leave empty */ }
  return out;
}

async function _fetchProductsRows(ids) {
  const out = new Map();
  if (ids.length === 0) return out;
  try {
    const { data } = await getClient().from('products')
      .select('id, cost_price')
      .in('id', ids);
    (data || []).forEach((r) => out.set(r.id, r));
  } catch (_e) { /* leave empty */ }
  return out;
}

module.exports = { fillCostSnapshotForItems };
