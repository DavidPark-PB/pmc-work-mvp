/**
 * omsProfitService.js — 실제 판매 실적 기반 수익 분석 (Owner 지시 2026-08-30).
 *
 * 배경:
 *   기존 /api/ops/profit 는 products 카탈로그 (등록된 판매가) 기반 예상 마진.
 *   재고에 앉아있는 상품까지 다 포함 · 실제 팔린 것과 무관.
 *   Owner 지시: "OMS 로 불러온거에서 계산해야 되는거 아니냐? 실제 받은거랑 원가랑 계산해서"
 *
 * 계산:
 *   매출  = SUM(item.unit_price × quantity)               (통화 → USD 환산)
 *   원가  = SUM(item.unit_cost_snapshot × quantity)       (cost_currency → USD 환산)
 *   수수료 = 매출 × CHANNEL_FEE_RATE[channel]              (eBay 18%, Shopify 5.5% 등)
 *   배송  = shippingRateEngine.getQuotes(...) 최저가       (예상 배송비 · 실 배송비 확인 불가)
 *   순이익 = 매출 - 원가 - 수수료 - 배송
 *   마진율 = 순이익 / 매출 × 100
 *
 * Owner 결정 사항 (2026-08-30):
 *   - eBay 실효 수수료 18% (FVF + 결제 등)
 *   - Shopify 5.5%
 *   - Coupang / Naver / Qoo10 / Shopee 는 지금 주문 못 불러옴 → 데이터 없어 계산 결과 X
 *   - 환율: 1350 KRW/USD (8월부터) · env EXCHANGE_RATE_KRW_PER_USD override
 *   - 배송비: 무게·부피 기반 예상값 (shippingRateEngine 최저가)
 *
 * 안전:
 *   - unit_cost_snapshot NULL 인 라인은 cost=0 으로 계산 · warnings 카운트
 *   - shipping quote 실패 시 order 별 배송비 0 · warnings 카운트
 *   - order_status IN (shipped·completed·delivered·fulfilled) 만 확정 판매로 취급
 */
'use strict';

const { getClient } = require('../db/supabaseClient');

const CHANNEL_FEE_RATE = Object.freeze({
  ebay:    0.18,   // Owner 지시: 실효 수수료 (FVF + 결제)
  shopify: 0.055,
  qoo10:   0.12,
  shopee:  0.12,
  coupang: 0.12,   // 참고용 (지금 주문 데이터 없음)
  naver:   0.12,   // 참고용 (지금 주문 데이터 없음)
  alibaba: 0.10,
  b2b:     0,
  manual:  0,
});

// 판매 확정 status (환불/취소 제외).
const FULFILLED_STATUSES = ['shipped', 'completed', 'delivered', 'fulfilled', 'closed'];

// 배송비 계산 fallback 상수 · SKU 마스터 dim/weight 없을 때.
const DEFAULT_WEIGHT_KG = 0.30;   // 300g
const DEFAULT_LEN_CM    = 15;
const DEFAULT_WID_CM    = 12;
const DEFAULT_HGT_CM    = 5;

function getExchangeRate() {
  const raw = Number(process.env.EXCHANGE_RATE_KRW_PER_USD || process.env.PROFIT_EXCHANGE_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : 1350;
}

function toUsd(amount, currency, exchangeRate) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const c = String(currency || '').toUpperCase();
  if (c === 'USD' || c === '') return n;
  if (c === 'KRW') return +(n / exchangeRate).toFixed(4);
  //   JPY / CNY 등 · 지금은 원가/매출 통화 확장 시 여기에 추가.
  //   MVP: 알 수 없는 통화는 USD 로 가정.
  return n;
}

/**
 * @param {Object} opts
 * @param {number} [opts.periodDays=30]
 * @param {Object} [opts.db]        supabase client (test 주입)
 * @param {Object} [opts.shipping]  shippingRateEngine (test 주입)
 * @returns {Promise<Object>}
 */
async function computeOmsProfit(opts = {}) {
  const periodDays = Number.isFinite(opts.periodDays) ? opts.periodDays : 30;
  const db = opts.db || getClient();
  const shipping = opts.shipping || require('./shippingRateEngine');
  const exchangeRate = getExchangeRate();
  const since = new Date(Date.now() - periodDays * 86400_000).toISOString();

  // 1) 확정 판매 orders
  const { data: orders, error: eO } = await db.from('oms_orders')
    .select('id, channel, total, currency, order_status, payment_status, ship_country, ship_country_code, shipping_charged, created_at')
    .in('order_status', FULFILLED_STATUSES)
    .gte('created_at', since)
    .limit(10000);
  if (eO) throw new Error(`oms_orders read failed: ${eO.message}`);
  if (!orders || orders.length === 0) {
    return _emptySummary({ periodDays, since, exchangeRate });
  }

  const orderIds = orders.map(o => o.id);

  // 2) 각 order 의 line items
  const { data: items, error: eI } = await db.from('oms_order_items')
    .select('order_id, sku_master_id, quantity, unit_price, currency, unit_cost_snapshot, cost_currency')
    .in('order_id', orderIds)
    .limit(50000);
  if (eI) throw new Error(`oms_order_items read failed: ${eI.message}`);

  // 3) SKU master → weight/dim 조회 (배송 견적용)
  const skuIds = [...new Set((items || []).map(i => i.sku_master_id).filter(Boolean))];
  const skuById = new Map();
  if (skuIds.length > 0) {
    const { data: skus } = await db.from('sku_master')
      .select('id, weight_gram, length_cm, width_cm, height_cm')
      .in('id', skuIds);
    (skus || []).forEach(s => skuById.set(s.id, s));
  }

  // 4) order 별 aggregation
  const itemsByOrder = new Map();
  (items || []).forEach(it => {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  });

  const warnings = { costMissingLines: 0, shippingQuoteFailed: 0, unknownChannel: 0 };
  const byChannel = new Map();
  let totalRevenueUsd = 0, totalCostUsd = 0, totalFeeUsd = 0, totalShippingUsd = 0;
  let totalLines = 0;

  for (const order of orders) {
    const channel = String(order.channel || 'unknown').toLowerCase();
    const feeRate = CHANNEL_FEE_RATE[channel];
    if (feeRate === undefined) warnings.unknownChannel++;
    const orderLines = itemsByOrder.get(order.id) || [];
    let orderRevenueUsd = 0, orderCostUsd = 0, orderWeightKg = 0;
    let maxL = DEFAULT_LEN_CM, maxW = DEFAULT_WID_CM, maxH = DEFAULT_HGT_CM;

    for (const it of orderLines) {
      const qty = Number(it.quantity) || 0;
      if (qty <= 0) continue;
      totalLines++;
      const revenueLineUsd = toUsd(it.unit_price, it.currency || order.currency, exchangeRate) * qty;
      orderRevenueUsd += revenueLineUsd;

      if (it.unit_cost_snapshot != null) {
        const costLineUsd = toUsd(it.unit_cost_snapshot, it.cost_currency, exchangeRate) * qty;
        orderCostUsd += costLineUsd;
      } else {
        warnings.costMissingLines++;
      }

      const sku = it.sku_master_id ? skuById.get(it.sku_master_id) : null;
      const wGram = sku && Number(sku.weight_gram) > 0 ? Number(sku.weight_gram) : (DEFAULT_WEIGHT_KG * 1000);
      orderWeightKg += (wGram / 1000) * qty;
      if (sku) {
        if (Number(sku.length_cm) > maxL) maxL = Number(sku.length_cm);
        if (Number(sku.width_cm)  > maxW) maxW = Number(sku.width_cm);
        if (Number(sku.height_cm) > maxH) maxH = Number(sku.height_cm);
      }
    }

    // 배송 견적
    let orderShippingUsd = 0;
    try {
      const quotes = shipping.getQuotes({
        country: order.ship_country || order.ship_country_code || 'US',
        actualKg: orderWeightKg > 0 ? orderWeightKg : DEFAULT_WEIGHT_KG,
        lengthCm: maxL, widthCm: maxW, heightCm: maxH,
      });
      if (quotes && quotes.length > 0) {
        //   견적 total 은 KRW · USD 로 환산.
        const cheapestKrw = Number(quotes[0].total) || 0;
        orderShippingUsd = cheapestKrw > 0 ? +(cheapestKrw / exchangeRate).toFixed(2) : 0;
      } else {
        warnings.shippingQuoteFailed++;
      }
    } catch (_) {
      warnings.shippingQuoteFailed++;
    }

    const orderFeeUsd = feeRate !== undefined
      ? +(orderRevenueUsd * feeRate).toFixed(2)
      : 0;

    totalRevenueUsd  += orderRevenueUsd;
    totalCostUsd     += orderCostUsd;
    totalFeeUsd      += orderFeeUsd;
    totalShippingUsd += orderShippingUsd;

    if (!byChannel.has(channel)) {
      byChannel.set(channel, { channel, orders: 0, revenueUsd: 0, costUsd: 0, feeUsd: 0, shippingUsd: 0 });
    }
    const c = byChannel.get(channel);
    c.orders++;
    c.revenueUsd  += orderRevenueUsd;
    c.costUsd     += orderCostUsd;
    c.feeUsd      += orderFeeUsd;
    c.shippingUsd += orderShippingUsd;
  }

  const netProfitUsd = totalRevenueUsd - totalCostUsd - totalFeeUsd - totalShippingUsd;
  const marginPct = totalRevenueUsd > 0 ? +(netProfitUsd / totalRevenueUsd * 100).toFixed(2) : 0;

  return {
    period: `${periodDays}d`,
    since,
    exchangeRate,
    summary: {
      totalOrders: orders.length,
      totalLines,
      revenueUsd:    +totalRevenueUsd.toFixed(2),
      costUsd:       +totalCostUsd.toFixed(2),
      feeUsd:        +totalFeeUsd.toFixed(2),
      shippingUsd:   +totalShippingUsd.toFixed(2),
      netProfitUsd:  +netProfitUsd.toFixed(2),
      marginPct,
    },
    byChannel: [...byChannel.values()].map(c => {
      const net = c.revenueUsd - c.costUsd - c.feeUsd - c.shippingUsd;
      return {
        channel:      c.channel,
        feeRate:      CHANNEL_FEE_RATE[c.channel] ?? null,
        orders:       c.orders,
        revenueUsd:   +c.revenueUsd.toFixed(2),
        costUsd:      +c.costUsd.toFixed(2),
        feeUsd:       +c.feeUsd.toFixed(2),
        shippingUsd:  +c.shippingUsd.toFixed(2),
        netProfitUsd: +net.toFixed(2),
        marginPct:    c.revenueUsd > 0 ? +(net / c.revenueUsd * 100).toFixed(2) : 0,
      };
    }).sort((a, b) => b.revenueUsd - a.revenueUsd),
    warnings,
  };
}

function _emptySummary({ periodDays, since, exchangeRate }) {
  return {
    period: `${periodDays}d`,
    since,
    exchangeRate,
    summary: { totalOrders: 0, totalLines: 0, revenueUsd: 0, costUsd: 0, feeUsd: 0, shippingUsd: 0, netProfitUsd: 0, marginPct: 0 },
    byChannel: [],
    warnings: { costMissingLines: 0, shippingQuoteFailed: 0, unknownChannel: 0 },
  };
}

module.exports = { computeOmsProfit, CHANNEL_FEE_RATE, FULFILLED_STATUSES };
