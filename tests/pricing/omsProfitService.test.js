'use strict';
/**
 * omsProfitService.test.js — 실적 기반 수익 계산 검증.
 * Owner 지시 (2026-08-30): OMS 기반 실 매출 · 원가 · 채널별 fee · 예상 배송비.
 */

process.env.EXCHANGE_RATE_KRW_PER_USD = '1350';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOmsProfit, CHANNEL_FEE_RATE } = require('../../src/services/omsProfitService');

// Supabase-호환 chain stub.
function makeDb(dataByTable) {
  return {
    from(table) {
      const rows = dataByTable[table] || [];
      const chain = {
        _rows: rows,
        select() { return chain; },
        in()     { return chain; },
        gte()    { return chain; },
        eq()     { return chain; },
        limit()  { return Promise.resolve({ data: chain._rows, error: null }); },
      };
      return chain;
    },
  };
}

//   getQuotes 는 KRW 총액 반환. Owner 지시 · 배송비는 최저가 사용.
//   `null` 을 명시하면 실패 시나리오 (getQuotes → []) · nullish coalescing 회피.
function makeShipping(krwByCountry) {
  return {
    getQuotes({ country }) {
      let krw;
      if (Object.prototype.hasOwnProperty.call(krwByCountry, country)) krw = krwByCountry[country];
      else if (Object.prototype.hasOwnProperty.call(krwByCountry, '_default')) krw = krwByCountry._default;
      else krw = 5400;
      if (krw === null) return [];
      return [{ total: krw, carrier: 'stub', isCheapest: true }];
    },
  };
}

//   ── 1) 빈 결과 ──
test('확정 판매 0건 → 빈 summary', async () => {
  const db = makeDb({ oms_orders: [] });
  const r = await computeOmsProfit({ periodDays: 30, db, shipping: makeShipping({}) });
  assert.equal(r.summary.totalOrders, 0);
  assert.equal(r.summary.revenueUsd, 0);
  assert.deepEqual(r.byChannel, []);
});

//   ── 2) eBay 1건 · 원가 KRW · 배송 예상 · fee 18% ──
test('eBay 주문 1건 · USD 매출 · KRW 원가 · 배송 예상 · fee 18%', async () => {
  const orders = [
    { id: 1, channel: 'ebay', total: 40, currency: 'USD', order_status: 'shipped', payment_status: 'paid', ship_country: 'US', shipping_charged: 10, created_at: '2026-08-15T00:00:00Z' },
  ];
  const items = [
    { order_id: 1, sku_master_id: 100, quantity: 2, unit_price: 20, currency: 'USD', unit_cost_snapshot: 5400, cost_currency: 'KRW' },
  ];
  const db = makeDb({
    oms_orders: orders,
    oms_order_items: items,
    sku_master: [{ id: 100, weight_gram: 200, length_cm: 15, width_cm: 12, height_cm: 5 }],
  });
  const r = await computeOmsProfit({ periodDays: 30, db, shipping: makeShipping({ US: 5400 }) });
  //   revenue = 20 × 2 = 40
  //   cost    = (5400/1350) × 2 = 4 × 2 = 8
  //   fee     = 40 × 0.18 = 7.2
  //   ship    = 5400 / 1350 = 4
  //   net     = 40 - 8 - 7.2 - 4 = 20.8
  assert.equal(r.summary.revenueUsd, 40);
  assert.equal(r.summary.costUsd, 8);
  assert.equal(r.summary.feeUsd, 7.2);
  assert.equal(r.summary.shippingUsd, 4);
  assert.equal(r.summary.netProfitUsd, 20.8);
  assert.equal(r.summary.marginPct, 52);   //  20.8 / 40 * 100 = 52%
  assert.equal(r.byChannel.length, 1);
  assert.equal(r.byChannel[0].channel, 'ebay');
  assert.equal(r.byChannel[0].feeRate, 0.18);
});

//   ── 3) Shopify 5.5% fee ──
test('Shopify 주문 · fee 5.5% 적용', async () => {
  const db = makeDb({
    oms_orders: [{ id: 2, channel: 'shopify', total: 100, currency: 'USD', order_status: 'fulfilled', payment_status: 'paid', ship_country: 'US', created_at: '2026-08-15T00:00:00Z' }],
    oms_order_items: [{ order_id: 2, sku_master_id: 200, quantity: 1, unit_price: 100, currency: 'USD', unit_cost_snapshot: 40, cost_currency: 'USD' }],
    sku_master: [{ id: 200, weight_gram: 500 }],
  });
  const r = await computeOmsProfit({ periodDays: 30, db, shipping: makeShipping({ _default: 6750 }) });
  //   fee = 100 × 0.055 = 5.5 · ship = 6750/1350 = 5 · net = 100 - 40 - 5.5 - 5 = 49.5
  assert.equal(r.byChannel[0].feeUsd, 5.5);
  assert.equal(r.byChannel[0].feeRate, 0.055);
  assert.equal(r.summary.netProfitUsd, 49.5);
});

//   ── 4) unit_cost_snapshot NULL → cost 0 · warning ──
test('원가 스냅샷 NULL → 원가 0 처리 + warning 카운트', async () => {
  const db = makeDb({
    oms_orders: [{ id: 3, channel: 'ebay', total: 30, currency: 'USD', order_status: 'shipped', ship_country: 'US', created_at: '2026-08-15T00:00:00Z' }],
    oms_order_items: [{ order_id: 3, sku_master_id: null, quantity: 1, unit_price: 30, currency: 'USD', unit_cost_snapshot: null, cost_currency: null }],
    sku_master: [],
  });
  const r = await computeOmsProfit({ periodDays: 30, db, shipping: makeShipping({ US: 4050 }) });
  assert.equal(r.summary.costUsd, 0);
  assert.equal(r.warnings.costMissingLines, 1);
});

//   ── 5) 여러 채널 aggregate ──
test('eBay + Shopify 혼합 · 채널별 breakdown · 매출 desc 정렬', async () => {
  const orders = [
    { id: 10, channel: 'ebay',    total: 50, currency: 'USD', order_status: 'shipped',   ship_country: 'US', created_at: '2026-08-15T00:00:00Z' },
    { id: 11, channel: 'shopify', total: 30, currency: 'USD', order_status: 'fulfilled', ship_country: 'CA', created_at: '2026-08-16T00:00:00Z' },
  ];
  const items = [
    { order_id: 10, sku_master_id: 1, quantity: 1, unit_price: 50, currency: 'USD', unit_cost_snapshot: 10, cost_currency: 'USD' },
    { order_id: 11, sku_master_id: 2, quantity: 1, unit_price: 30, currency: 'USD', unit_cost_snapshot: 5,  cost_currency: 'USD' },
  ];
  const db = makeDb({
    oms_orders: orders, oms_order_items: items,
    sku_master: [{ id: 1, weight_gram: 100 }, { id: 2, weight_gram: 100 }],
  });
  const r = await computeOmsProfit({ periodDays: 30, db, shipping: makeShipping({ _default: 5400 }) });
  assert.equal(r.byChannel.length, 2);
  assert.equal(r.byChannel[0].channel, 'ebay');   // 매출 desc 정렬 (50 > 30)
  assert.equal(r.byChannel[1].channel, 'shopify');
  assert.equal(r.summary.revenueUsd, 80);
});

//   ── 6) 배송 견적 실패 → shipping 0 · warning ──
test('배송 견적 실패 (getQuotes []) → shipping 0 + warning', async () => {
  const db = makeDb({
    oms_orders: [{ id: 20, channel: 'ebay', total: 20, currency: 'USD', order_status: 'shipped', ship_country: 'XX', created_at: '2026-08-15T00:00:00Z' }],
    oms_order_items: [{ order_id: 20, sku_master_id: 1, quantity: 1, unit_price: 20, currency: 'USD', unit_cost_snapshot: 5, cost_currency: 'USD' }],
    sku_master: [{ id: 1, weight_gram: 100 }],
  });
  const r = await computeOmsProfit({ periodDays: 30, db, shipping: makeShipping({ XX: null }) });
  assert.equal(r.summary.shippingUsd, 0);
  assert.equal(r.warnings.shippingQuoteFailed, 1);
});

//   ── 7) CHANNEL_FEE_RATE 상수 Owner-정의 값 검증 ──
test('CHANNEL_FEE_RATE: eBay 18% · Shopify 5.5% · Qoo10/Shopee 12%', () => {
  assert.equal(CHANNEL_FEE_RATE.ebay, 0.18);
  assert.equal(CHANNEL_FEE_RATE.shopify, 0.055);
  assert.equal(CHANNEL_FEE_RATE.qoo10, 0.12);
  assert.equal(CHANNEL_FEE_RATE.shopee, 0.12);
});

//   ── 8) 취소/환불 주문 제외 ──
test('order_status=cancelled 등 fulfilled 아닌 주문은 read 필터로 제외됨 (stub 은 그대로 반환하지만 실제 DB 는 IN 필터)', () => {
  //   stub 은 IN() 을 무시하고 rows 전량 반환하므로 여기서는 파일 상수만 검증.
  const { FULFILLED_STATUSES } = require('../../src/services/omsProfitService');
  assert.ok(FULFILLED_STATUSES.includes('shipped'));
  assert.ok(FULFILLED_STATUSES.includes('completed'));
  assert.ok(FULFILLED_STATUSES.includes('fulfilled'));
  assert.ok(!FULFILLED_STATUSES.includes('cancelled'));
  assert.ok(!FULFILLED_STATUSES.includes('refunded'));
});
