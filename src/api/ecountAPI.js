'use strict';

const https = require('https');

const ECOUNT_COM_CODE = process.env.ECOUNT_COM_CODE;
const ECOUNT_USER_ID  = process.env.ECOUNT_USER_ID;
const ECOUNT_API_KEY  = process.env.ECOUNT_API_KEY;
const ECOUNT_ZONE     = process.env.ECOUNT_ZONE || '';

const PLATFORM_CODES = {
  ebay:    'EBAY2',
  shopify: 'SHOPIFY',
  shopee:  'SHOPEE',
  naver:   'NAVER',
  coupang: 'COUPANG',
};

class EcountAPI {
  constructor() {
    this.zone      = ECOUNT_ZONE;
    this.sessionId = null;
    this.sessionAt = null;
  }

  _post(url, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const u    = new URL(url);
      const opts = {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json;charset=UTF-8',
          'Content-Length': Buffer.byteLength(data),
          'Accept':         'application/json',
        },
      };
      const req = https.request(opts, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse 실패: ${raw.slice(0, 200)}`)); }
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
    if (!res?.Data?.ZONE) throw new Error(`ZONE 조회 실패: ${JSON.stringify(res)}`);
    this.zone = res.Data.ZONE;
    return this.zone;
  }

  async getSession(forceNew = false) {
    const age = this.sessionAt ? Date.now() - this.sessionAt : Infinity;
    if (!forceNew && this.sessionId && age < 25 * 60 * 1000) return this.sessionId;

    const zone = await this.getZone();
    const res  = await this._post(
      `https://oapi${zone}.ecount.com/OAPI/V2/OAPILogin`,
      {
        COM_CODE:     ECOUNT_COM_CODE,
        USER_ID:      ECOUNT_USER_ID,
        API_CERT_KEY: ECOUNT_API_KEY,
        LAN_TYPE:     'ko-KR',
        ZONE:         zone,
      }
    );
    if (!res?.Data?.SESSION_ID) throw new Error(`로그인 실패: ${JSON.stringify(res)}`);
    this.sessionId = res.Data.SESSION_ID;
    this.sessionAt
