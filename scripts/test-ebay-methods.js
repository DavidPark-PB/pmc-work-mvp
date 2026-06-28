'use strict';
const axios = require('axios');

// eBay seller page with different Accept headers / formats
async function test() {
  const seller = 'onmom_house';
  
  // 방법 1: /sch/ 페이지에 API 헤더
  console.log('-- 방법 1: Accept JSON header --');
  try {
    const r = await axios.get(`https://www.ebay.com/sch/${seller}/m.html`, {
      params: { _nkw: '', _armrs: 1, _ipg: 10, rt: 'nc', LH_BIN: 1 },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      },
      timeout: 10000,
    });
    console.log('status:', r.status, 'type:', typeof r.data, 'len:', JSON.stringify(r.data).length);
    if (typeof r.data === 'object') console.log('keys:', Object.keys(r.data).slice(0, 5));
  } catch(e) { console.log('실패:', e.response?.status, e.message?.slice(0,50)); }

  await new Promise(r => setTimeout(r, 2000));

  // 방법 2: eBay open.api (다른 도메인)
  console.log('-- 방법 2: svcs.ebay.com findItemsAdvanced (다른 appId 시도) --');
  try {
    const r = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
      params: {
        'OPERATION-NAME': 'findItemsAdvanced',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': process.env.EBAY_APP_ID || require('./config/.env'),
        'RESPONSE-DATA-FORMAT': 'JSON',
        'itemFilter(0).name': 'Seller',
        'itemFilter(0).value': seller,
        'paginationInput.entriesPerPage': 5,
        'paginationInput.pageNumber': 1,
      },
      timeout: 10000,
    });
    console.log('status:', r.status);
    const res = r.data?.findItemsAdvancedResponse?.[0];
    console.log('ack:', res?.ack?.[0], 'total:', res?.paginationOutput?.[0]?.totalEntries?.[0]);
  } catch(e) { console.log('실패:', e.response?.status, e.message?.slice(0,50)); }
}

require('dotenv').config({ path: require('path').join(__dirname, 'config/.env') });
test().catch(e => console.error(e.message));
