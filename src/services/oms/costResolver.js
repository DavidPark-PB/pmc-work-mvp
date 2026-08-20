/**
 * src/services/oms/costResolver.js — Cost snapshot resolver.
 *
 * Owner directive §9:
 *   Cost snapshot 은 master 값을 매 sync 때 계속 overwrite 하면 안 된다.
 *   처음 신뢰 가능한 원가가 확보되는 시점에 snapshot 저장.
 *   이미 snapshot 이 있는 과거 주문은 master cost 변경 때문에 자동 변경하지 않는다.
 *
 *   우선 source 후보:
 *     1. sku_master landed cost
 *     2. sku_master unit cost
 *     3. products cost
 *     4. null
 *
 *   실제 코드의 현재 필드명을 확인해서 적용한다. cost_source 도 함께 기록한다.
 *
 * 순수 함수. DB fetch 는 호출자 책임 (skuMasterRow / productsRow 전달).
 *
 * sku_master 실제 필드 (038 / 069):
 *   - cost_krw (numeric, KRW 단위)
 *   - default_packaging_weight_g, weight_gram, dims (배송 계산용)
 *   - suppliers 는 069 에 별도
 *
 * products 실제 필드 (002 / 005):
 *   - cost_price (numeric)
 *   - price_usd
 */
'use strict';

/**
 * @typedef {Object} CostSnapshot
 * @property {number|null} unitCostSnapshot
 * @property {number|null} landedCostSnapshot
 * @property {string|null} costCurrency
 * @property {string|null} costSource            'sku_master' | 'products' | 'manual' | 'ai_estimate' | null
 */

/**
 * Build a cost snapshot from available master data.
 * Returns { unitCostSnapshot, landedCostSnapshot, costCurrency, costSource }.
 * All-null result is acceptable — caller may still persist the item.
 *
 * @param {Object} args
 * @param {Object|null} args.skuMasterRow    sku_master row (or null if unmatched)
 * @param {Object|null} args.productsRow     products row (or null if unmatched)
 * @param {Object|null} args.override        manual override { unitCostSnapshot, costCurrency, costSource }
 * @returns {CostSnapshot}
 */
function resolveCostSnapshot({ skuMasterRow = null, productsRow = null, override = null } = {}) {
  // 1) Manual override wins
  if (override && override.unitCostSnapshot != null && Number.isFinite(Number(override.unitCostSnapshot))) {
    return {
      unitCostSnapshot: Number(override.unitCostSnapshot),
      landedCostSnapshot: override.landedCostSnapshot != null && Number.isFinite(Number(override.landedCostSnapshot))
        ? Number(override.landedCostSnapshot) : null,
      costCurrency: override.costCurrency || null,
      costSource: override.costSource || 'manual',
    };
  }

  // 2) sku_master.cost_krw (unit cost in KRW · Engine 1 canonical)
  if (skuMasterRow && skuMasterRow.cost_krw != null) {
    const n = Number(skuMasterRow.cost_krw);
    if (Number.isFinite(n) && n >= 0) {
      return {
        unitCostSnapshot: n,
        landedCostSnapshot: null,
        costCurrency: 'KRW',
        costSource: 'sku_master',
      };
    }
  }

  // 3) products.cost_price (legacy · currency 불명확 → null)
  if (productsRow && productsRow.cost_price != null) {
    const n = Number(productsRow.cost_price);
    if (Number.isFinite(n) && n >= 0) {
      return {
        unitCostSnapshot: n,
        landedCostSnapshot: null,
        costCurrency: null,        // products.cost_price 컬럼은 currency 명시 없음 — 호출자가 알면 override 사용
        costSource: 'products',
      };
    }
  }

  return { unitCostSnapshot: null, landedCostSnapshot: null, costCurrency: null, costSource: null };
}

/**
 * Decide whether to WRITE a fresh cost snapshot for an existing order item.
 * Owner §9: 이미 snapshot 이 있으면 master 변경 때문에 자동 변경하지 않는다.
 *
 * @param {Object} existingItem      existing oms_order_items row (may be null for new item)
 * @param {CostSnapshot} freshSnap
 * @returns {boolean}                true = write, false = keep existing
 */
function shouldWriteCostSnapshot(existingItem, freshSnap) {
  if (!existingItem) return true;                         // new item — always write
  if (existingItem.unit_cost_snapshot == null && freshSnap.unitCostSnapshot != null) {
    return true;                                          // existing had none, now we can fill
  }
  return false;                                           // existing has snapshot — do NOT overwrite
}

module.exports = {
  resolveCostSnapshot,
  shouldWriteCostSnapshot,
};
