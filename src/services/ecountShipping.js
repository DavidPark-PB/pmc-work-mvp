'use strict';

const EcountAPI     = require('../api/ecountAPI');
const CarrierSheets = require('./carrierSheets');

const KPACKET_COUNTRIES = new Set([
  'US','CA','GB','AU','DE','FR','IT','ES','JP','CN','HK','TW','SG','MY',
  'TH','VN','PH','ID','NZ','NL','BE','AT','CH','SE','NO','DK','FI','PT',
  'IE','PL','CZ',
]);

const SHIPTER_COUNTRIES = new Set([
  'AU','SE','IT','GB','DE','FR','ES','NL','BE','AT','CH','NO','DK','FI',
  'PT','IE','PL','CZ','HU','NZ','SG','MX','BR','LU','JP','HK','TW','CA',
]);

const KPL_COUNTRIES = new Set([
  'US','CA','JP','HK','TW','MY','TH','VN','PH','ID','CN',
]);

function selectCarrier(countryCode, weightKg) {
  const cc = (countryCode || '').toUpperCase();
  const wt = weightKg || 0;
  if (wt > 0 && wt <= 2.0 && KPACKET_COUNTRIES.has(cc)) return 'KPACKET';
  if (SHIPTER_COUNTRIES.has(cc)) return '쉽터';
  if (KPL_COUNTRIES.has(cc)) return 'KPL';
  return '윤익스프레스';
}

class EcountShippingService {
  constructor() {
    this.ecount = new EcountAPI();
    this.sheets = new CarrierSheets();
  }

  async run(opts) {
    const days      = opts.days      || 1;
    const startDate = opts.startDate || EcountAPI.daysAgo(days);
    const platform  = opts.platform  || undefined;
    const orderIds  = opts.orderIds  || undefined;
    const dryRun    = opts.dryRun    || false;
    const end       = EcountAPI.today();

    console.log('[EcountShipping] 시작: ' + startDate + ' ~ ' + end);

    const platforms = platform
      ? [platform]
      : ['ebay', 'shopify', 'shopee', 'naver', 'coupang'];

    let rawOrders = [];
    for (const p of platforms) {
      try {
        const rows = await this.ecount.getOrders({ startDate: startDate, endDate: end, platform: p });
        console.log('[' + p + '] ' + rows.length + '건');
        rawOrders = rawOrders.concat(rows.map(function(r) {
          r._platform = p;
          return r;
        }));
      } catch (err) {
        console.warn('[' + p + '] 실패: ' + err.message);
      }
    }

    if (orderIds && orderIds.length > 0) {
      const idSet = new Set(orderIds);
      rawOrders = rawOrders.filter(function(r) {
        return idSet.has(r.ORDER_NO) || idSet.has(r.MALL_ORDER_NO);
      });
    }

    const results = {
      total:   rawOrders.length,
      success: [],
      kpacket: [],
      skipped: [],
      failed:  [],
    };

    for (const raw of rawOrders) {
      const order   = this.ecount.normalizeOrder(raw);
      const carrier = selectCarrier(order.countryCode, order.weightKg);
      const summary = {
        orderId:  order.orderId,
        platform: raw._platform,
        country:  order.countryCode,
        weight:   order.weightKg,
        carrier:  carrier,
        buyer:    order.buyerName,
      };

      if (!order.orderId)     { results.skipped.push({ reason: '주문번호 없음' }); continue; }
      if (!order.countryCode) { results.skipped.push({ reason: '국가코드 없음', orderId: order.orderId }); continue; }

      if (carrier === 'KPACKET') { results.kpacket.push(summary); continue; }
      if (dryRun)                { results.success.push(summary); continue; }

      try {
        await this.sheets.addToCarrierSheet(carrier, order);
        results.success.push(summary);
      } catch (err) {
        results.failed.push(Object.assign({}, summary, { error: err.message }));
      }

      await new Promise(function(r) { setTimeout(r, 500); });
    }

    return results;
  }
}

module.exports = EcountShippingService;
