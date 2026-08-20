/**
 * src/services/oms/physicalInventoryReconcile.js — Legacy stock vs new physical shadow.
 *
 * Owner directive (§5):
 *   products.stock 는 제거하지 않는다. Legacy observed value 로 유지.
 *   같은 physical_product 를 표현하는 products row 가 여러 개일 수 있으므로
 *   무조건 SUM 하지 마라. Candidate rows / stock / conflict 를 보여주는
 *   report 로 노출하고 initial on_hand write 는 Owner 승인 없이 금지.
 *
 * READ-ONLY. Zero writes.
 *
 * Path (physical → legacy candidates):
 *   physical_products (id)
 *     ← sellable_unit_components (physical_product_id)
 *     ← sku_master_link (sellable_unit_id)   → sku_master_id list
 *     ↔ sku_master.internal_sku              → products.sku list (string match)
 *     ↔ sku_listing_link.sku_id (marketplace=ebay) → ebay_products.item_id → ebay_products.stock
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { getPhysicalInventoryState } = require('./inventoryShadowService');

/**
 * Build a legacy candidate report for one physical_product.
 * Never sums / never writes. Lists every candidate stock value with source.
 *
 * @param {number} physicalProductId
 */
async function buildLegacyStockCandidatesForPhysical(physicalProductId) {
  const db = getClient();
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }

  // 1) Find sellable_units linked to this physical (via sellable_unit_components)
  const { data: compRows } = await db.from('sellable_unit_components')
    .select('sellable_unit_id, quantity_per_unit, role')
    .eq('physical_product_id', physicalProductId);
  const sellableIds = [...new Set((compRows || []).map(c => c.sellable_unit_id))];

  // 2) Find linked sku_master rows (through sku_master_link)
  let linkedSkuMasterIds = [];
  if (sellableIds.length) {
    const { data: links } = await db.from('sku_master_link')
      .select('sku_master_id, sellable_unit_id')
      .in('sellable_unit_id', sellableIds);
    linkedSkuMasterIds = [...new Set((links || []).map(l => l.sku_master_id))];
  }

  // 3) Resolve internal_sku values
  let internalSkus = [];
  const skuMasterRows = [];
  if (linkedSkuMasterIds.length) {
    const { data: sm } = await db.from('sku_master')
      .select('id, internal_sku, title, cost_krw, status')
      .in('id', linkedSkuMasterIds);
    for (const r of (sm || [])) { skuMasterRows.push(r); if (r.internal_sku) internalSkus.push(r.internal_sku); }
  }
  internalSkus = [...new Set(internalSkus)];

  // 4) Fetch legacy products rows matching those SKUs
  const legacyProducts = [];
  if (internalSkus.length) {
    const { data } = await db.from('products')
      .select('id, sku, title, stock, ebay_item_id, source_platform, updated_at')
      .in('sku', internalSkus);
    (data || []).forEach(p => legacyProducts.push(p));
  }

  // 5) Fetch ebay_products via sku_listing_link → ebay_item_id
  const ebayListings = [];
  if (linkedSkuMasterIds.length) {
    const { data: sll } = await db.from('sku_listing_link')
      .select('sku_id, marketplace, listing_id, marketplace_sku')
      .eq('marketplace', 'ebay')
      .in('sku_id', linkedSkuMasterIds);
    const itemIds = [...new Set((sll || []).map(r => r.listing_id).filter(Boolean))];
    if (itemIds.length) {
      const { data: ep } = await db.from('ebay_products')
        .select('item_id, sku, title, stock, ebay_api_stock, status, updated_at')
        .in('item_id', itemIds);
      for (const l of (sll || [])) {
        const e = (ep || []).find(x => String(x.item_id) === String(l.listing_id));
        ebayListings.push({
          sku_id: l.sku_id,
          listing_id: l.listing_id,
          marketplace_sku: l.marketplace_sku,
          ebay_stock: e?.stock ?? null,
          ebay_api_stock: e?.ebay_api_stock ?? null,
          ebay_status: e?.status ?? null,
        });
      }
    }
  }

  // 6) New physical shadow state (should be 0 in Phase 6D-1)
  const shadow = await getPhysicalInventoryState(physicalProductId);

  // 7) Detect conflict: candidate stock values differ
  const productStockValues = legacyProducts.map(p => Number(p.stock) || 0);
  const ebayStockValues = ebayListings.map(e => Number(e.ebay_stock) || 0);
  const distinctProductStocks = [...new Set(productStockValues)];
  const distinctEbayStocks = [...new Set(ebayStockValues)];
  const conflicts = [];
  if (distinctProductStocks.length > 1) {
    conflicts.push({ kind: 'products_stock_multiple_values', values: distinctProductStocks, note: 'Multiple products rows have different stock — cannot simply SUM' });
  }
  if (distinctEbayStocks.length > 1) {
    conflicts.push({ kind: 'ebay_stock_multiple_values', values: distinctEbayStocks, note: 'Multiple eBay listings mirror different stock — listing quantity is not warehouse stock' });
  }

  // Baseline approval flags (Owner §4 · Phase 6D-2)
  //   legacy_auto_approvable = "legacy 값을 사람 실사 없이 자동 채택 가능한가"
  //   physical_count_required = 사람 실사 입력 필요 (현 Phase 6D-2 는 항상 true — 안전 default)
  //   baseline_already_exists = idempotency_key로 판정 (아래 별도 lookup 함수)
  const legacyAutoApprovable = conflicts.length === 0
    && distinctProductStocks.length === 1
    && shadow.movement_count === 0;

  return {
    physical_product_id: physicalProductId,
    linked_sellable_unit_ids: sellableIds,
    linked_sku_master_count: skuMasterRows.length,
    linked_sku_master_ids: skuMasterRows.map(r => r.id),
    internal_skus: internalSkus,
    legacy_products_candidates: legacyProducts.map(p => ({
      product_id: p.id, sku: p.sku, title: p.title, stock: p.stock,
      ebay_item_id: p.ebay_item_id, source_platform: p.source_platform,
    })),
    legacy_ebay_listings: ebayListings,
    new_shadow_state: shadow,
    conflicts,
    legacy_auto_approvable: legacyAutoApprovable,
    physical_count_required: true,   // Owner §4 default · manual count is required
    // deprecated alias — kept for backwards compat with existing CLI/report readers
    can_owner_approve_initial_on_hand: legacyAutoApprovable,
    proposed_initial_on_hand: (conflicts.length === 0 && distinctProductStocks.length === 1)
      ? distinctProductStocks[0] : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Reconcile all physical_products (or a limited slice).
 */
async function reconcileAllPhysicalProducts({ limit = 20 } = {}) {
  const db = getClient();
  const { data: physicals } = await db.from('physical_products')
    .select('id, canonical_title, set_code, unit_type, status')
    .order('id', { ascending: true })
    .limit(Math.max(1, Math.min(500, parseInt(limit, 10) || 20)));

  const reports = [];
  for (const p of (physicals || [])) {
    const r = await buildLegacyStockCandidatesForPhysical(p.id);
    reports.push({ ...p, ...r });
  }
  return { generatedAt: new Date().toISOString(), count: reports.length, reports };
}

module.exports = {
  buildLegacyStockCandidatesForPhysical,
  reconcileAllPhysicalProducts,
};
