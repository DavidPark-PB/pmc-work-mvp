/**
 * skuEnrichmentPresenter.js
 *
 * SKU enrichment 표시용 helper (order → sku_master + supplier + profit_estimate).
 *
 * 원본: src/web/routes/shippingRecommendations.js 안에 있던 lookupSkuMasterMap +
 * estimateProfit + getExchangeRate 를 순수 helper 로 추출 (동작 identical · 재사용 목적).
 *
 * 사용처:
 *   - shippingRecommendations.js (배송 추천 · shipping-recs page · pmcShippingRecs)
 *   - api.js /api/orders/recent (배송 관리 · shipping page · dashboard.js)
 *
 * 공식/상수 재사용:
 *   - omsProfitService.CHANNEL_FEE_RATE (eBay 18% · Shopify 5.5% 등)
 *   - EXCHANGE_RATE_KRW_PER_USD env (omsProfitService 와 동일 소스 · 기본 1350)
 *
 * 별도 profit 공식을 만들지 않는다.
 */
'use strict';

const { getClient } = require('../db/supabaseClient');
const { CHANNEL_FEE_RATE } = require('./omsProfitService');

function getExchangeRate() {
  const raw = Number(process.env.EXCHANGE_RATE_KRW_PER_USD || process.env.PROFIT_EXCHANGE_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : 1350;
}

/**
 * 여러 SKU 를 한 번에 sku_master + suppliers 로 join.
 * 반환: { skuMap: Map<internal_sku, row>, supplierMap: Map<supplier_id, sup> }
 */
async function lookupSkuMasterMap(skus) {
  const unique = [...new Set((skus || []).filter(s => s && String(s).trim()).map(s => String(s).trim()))];
  if (unique.length === 0) return { skuMap: new Map(), supplierMap: new Map() };
  const db = getClient();
  const { data, error } = await db.from('sku_master')
    .select(`
      id, internal_sku, title, weight_gram, status, length_cm, width_cm, height_cm,
      weight_status, default_packaging_weight_g, shipping_group,
      cost_krw, supplier_id,
      weight_source, dims_source, cost_source,
      weight_measured_at, dims_measured_at, cost_updated_at
    `)
    .in('internal_sku', unique);
  if (error) throw error;
  const skuMap = new Map();
  for (const r of data || []) skuMap.set(r.internal_sku, r);

  const supplierIds = [...new Set((data || []).map(r => r.supplier_id).filter(Boolean))];
  const supplierMap = new Map();
  if (supplierIds.length > 0) {
    const { data: sups } = await db.from('suppliers')
      .select('id, name, channel')
      .in('id', supplierIds);
    for (const s of sups || []) supplierMap.set(s.id, s);
  }
  return { skuMap, supplierMap };
}

/**
 * 매출 · 원가 · 배송비 · 수수료율 → { revenueKrw, feeKrw, profitKrw, marginPct, reason }.
 * reason values: 'ok' · 'no_payment_amount' · 'no_cost' · 'no_shipping' · 'unknown_platform'.
 */
function estimateProfit({ paymentAmount, currency, platform, costKrw, shippingKrw }) {
  const exchangeRate = getExchangeRate();
  const feeRate = CHANNEL_FEE_RATE[String(platform || '').toLowerCase()];
  const price = Number(paymentAmount);
  if (!Number.isFinite(price) || price <= 0) return { revenueKrw: null, reason: 'no_payment_amount' };
  const cur = String(currency || 'USD').toUpperCase();
  const revenueKrw = cur === 'KRW' ? price : (cur === 'USD' ? price * exchangeRate : price);
  const feeKrw = feeRate != null ? Math.round(revenueKrw * feeRate) : null;

  if (!Number.isFinite(Number(costKrw)) || Number(costKrw) <= 0) {
    return { revenueKrw: Math.round(revenueKrw), feeKrw, feeRate, profitKrw: null, marginPct: null, reason: 'no_cost' };
  }
  if (!Number.isFinite(Number(shippingKrw)) || Number(shippingKrw) <= 0) {
    return { revenueKrw: Math.round(revenueKrw), feeKrw, feeRate, profitKrw: null, marginPct: null, reason: 'no_shipping' };
  }
  if (feeRate == null) {
    return { revenueKrw: Math.round(revenueKrw), feeKrw: null, feeRate: null, profitKrw: null, marginPct: null, reason: 'unknown_platform' };
  }
  const profitKrw = Math.round(revenueKrw - Number(costKrw) - feeKrw - Number(shippingKrw));
  const marginPct = revenueKrw > 0 ? +((profitKrw / revenueKrw) * 100).toFixed(2) : null;
  return {
    revenueKrw: Math.round(revenueKrw),
    feeKrw, feeRate,
    costKrw: Number(costKrw),
    shippingKrw: Number(shippingKrw),
    profitKrw, marginPct,
    reason: 'ok',
  };
}

/**
 * 하나의 sku_master row → UI 용 sku_enrichment payload.
 * supplier 매핑은 caller 가 supplierMap 로 전달.
 */
function buildSkuEnrichment(skuRow, supplierMap) {
  if (!skuRow) return null;
  const supplier = skuRow.supplier_id ? supplierMap.get(skuRow.supplier_id) : null;
  return {
    sku_master_id:     skuRow.id,
    weight_gram:       skuRow.weight_gram || null,
    weight_status:     skuRow.weight_status || 'unknown',
    weight_source:     skuRow.weight_source || null,
    weight_measured_at: skuRow.weight_measured_at || null,
    default_packaging_weight_g: skuRow.default_packaging_weight_g || null,
    length_cm:         skuRow.length_cm || null,
    width_cm:          skuRow.width_cm || null,
    height_cm:         skuRow.height_cm || null,
    dims_source:       skuRow.dims_source || null,
    cost_krw:          skuRow.cost_krw != null ? Number(skuRow.cost_krw) : null,
    cost_source:       skuRow.cost_source || null,
    cost_updated_at:   skuRow.cost_updated_at || null,
    supplier_id:       skuRow.supplier_id || null,
    supplier_name:     supplier?.name || null,
    supplier_channel:  supplier?.channel || null,
    shipping_group:    skuRow.shipping_group || null,
  };
}

module.exports = {
  lookupSkuMasterMap,
  estimateProfit,
  buildSkuEnrichment,
  getExchangeRate,
  CHANNEL_FEE_RATE,
};
