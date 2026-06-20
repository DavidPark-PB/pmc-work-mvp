'use strict';

const https = require('https');

const ECOUNT_COM_CODE = process.env.ECOUNT_COM_CODE;
const ECOUNT_USER_ID  = process.env.ECOUNT_USER_ID;
const ECOUNT_API_KEY  = process.env.ECOUNT_API_KEY;
const ECOUNT_ZONE     = process.env.ECOUNT_ZONE || '';

const PLATFORM_CODES = {
  ebay: 'EBAY2', shopify: 'SHOPIFY',
  shopee: 'SHOPEE', naver: 'NAVER', coupang: 'COUPANG',
};

class EcountAPI {
  constructor() {
    this.zone = ECOUNT_ZONE;
    this.sessionId = null;
    this.sessionAt = null;
  }

  _post(url, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const u = new URL(url);
      const opts = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Content-Length': Buffer.byteLength(data),
          'Accept': 'application/json',
        },
      };
      const req = https.request(opts, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('JSON parse 실패: ' + raw.slice(0, 200))); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async getZone() {
    if (this.zone) return this.zone;
    const res = await this._post(
      'https://sboapi.ecount.com/OAPI/V2/Zone',
      { COM_CODE: ECOUNT_COM_CODE }
    );
    if (!res || !res.Data || !res.Data.ZONE) {
      throw new Error('ZONE 조회 실패: ' + JSON.stringify(res));
    }
    this.zone = res.Data.ZONE;
    return this.zone;
  }

  async getSession(forceNew) {
    const age = this.sessionAt ? Date.now() - this.sessionAt : Infinity;
    if (!forceNew && this.sessionId && age < 25 * 60 * 1000) return this.sessionId;
    const zone = await this.getZone();
    const res = await this._post(
      'https://oapi' + zone + '.ecount.com/OAPI/V2/OAPILogin',
      {
        COM_CODE: ECOUNT_COM_CODE,
        USER_ID: ECOUNT_USER_ID,
        API_CERT_KEY: ECOUNT_API_KEY,
        LAN_TYPE: 'ko-KR',
        ZONE: zone,
      }
    );
    const sessionData = (res.Data && res.Data.Datas) ? res.Data.Datas : res.Data;
if (!sessionData || !sessionData.SESSION_ID) {
  throw new Error('로그인 실패: ' + JSON.stringify(res));
}
this.sessionId = sessionData.SESSION_ID;
  }

  async call(path, body, retry) {
    if (retry === undefined) retry = true;
    const zone = await this.getZone();
    const sessionId = await this.getSession();
    const url = 'https://oapi' + zone + '.ecount.com' + path;
    const res = await this._post(url, Object.assign({}, body, { SESSION_ID: sessionId }));
    if (res && res.Error && res.Error.Code === 'E001' && retry) {
      await this.getSession(true);
      return this.call(path, body, false);
    }
    return res;
  }

  async getOrders(opts) {
    const body = {
      START_DATE: opts.startDate,
      END_DATE: opts.endDate,
      ORDER_STATUS: opts.status || '1',
    };
    if (opts.platform && PLATFORM_CODES[opts.platform]) {
      body.MALL_CODE = PLATFORM_CODES[opts.platform];
    }
    const res = await this.call('/OAPI/V2/Sale/GetOrderListMall', body);
    if (!res || !res.Data) return [];
    return Array.isArray(res.Data) ? res.Data : [];
  }

  normalizeOrder(r) {
    return {
      orderId: r.ORDER_NO || r.MALL_ORDER_NO || '',
      platform: r.MALL_CODE || '',
      buyerName: r.BUY_NM || r.RECEIVE_NM || '',
      phone: r.RECEIVE_TEL || r.BUY_TEL || '',
      email: r.RECEIVE_EMAIL || r.BUY_EMAIL || '',
      countryCode: (r.RECEIVE_COUNTRY || '').toUpperCase(),
      zipCode: r.RECEIVE_ZIP || '',
      province: r.RECEIVE_STATE || '',
      city: r.RECEIVE_CITY || '',
      street: [r.RECEIVE_ADDR1, r.RECEIVE_ADDR2].filter(Boolean).join(' '),
      weightKg: r.WGT ? parseFloat(r.WGT) : null,
      itemName: r.ITEM_NM || 'Toy samples',
      qty: r.QTY || 1,
      unitPrice: r.PRICE || r.AMT || 0,
      currency: r.CURR_CD || 'USD',
      createdAt: r.WRT_DATE || '',
    };
  }

  static today() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  static daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }
}

module.exports = EcountAPI;
