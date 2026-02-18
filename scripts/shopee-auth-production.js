require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const crypto = require('crypto');
const http = require('http');
const axios = require('axios');

const PARTNER_ID = parseInt(process.env.SHOPEE_PARTNER_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const BASE_URL = 'https://partner.shopeemobile.com';
const REDIRECT_URL = 'http://localhost:5555/callback';

function generateSign(path, timestamp) {
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

// CB 셀러는 merchant 레벨 인증 사용
function generateAuthUrl() {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp);
  return `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(REDIRECT_URL)}`;
}

// code + main_account_id로 토큰 발급 (merchant 레벨)
async function getAccessTokenByMainAccount(code, mainAccountId) {
  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');

  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const body = {
    code,
    partner_id: PARTNER_ID,
    main_account_id: mainAccountId,
  };

  const res = await axios.post(url, body);
  return res.data;
}

// code + shop_id로 토큰 발급 (shop 레벨)
async function getAccessTokenByShop(code, shopId) {
  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');

  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const body = {
    code,
    partner_id: PARTNER_ID,
    shop_id: shopId,
  };

  const res = await axios.post(url, body);
  return res.data;
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/callback')) {
    const url = new URL(req.url, 'http://localhost:5555');
    const code = url.searchParams.get('code');
    const shopId = url.searchParams.get('shop_id');
    const mainAccountId = url.searchParams.get('main_account_id');

    console.log('\n--- 인증 코드 수신 ---');
    console.log('code:', code);
    console.log('shop_id:', shopId);
    console.log('main_account_id:', mainAccountId);

    try {
      let tokenData;
      if (mainAccountId) {
        console.log('\nMerchant(CB) 레벨 토큰 발급 중...');
        tokenData = await getAccessTokenByMainAccount(code, parseInt(mainAccountId));
      } else if (shopId) {
        console.log('\nShop 레벨 토큰 발급 중...');
        tokenData = await getAccessTokenByShop(code, parseInt(shopId));
      }

      console.log('\n--- 토큰 발급 결과 ---');
      console.log(JSON.stringify(tokenData, null, 2));

      if (tokenData.access_token) {
        console.log('\n.env에 아래 값을 업데이트하세요:');
        console.log(`SHOPEE_ACCESS_TOKEN=${tokenData.access_token}`);
        console.log(`SHOPEE_REFRESH_TOKEN=${tokenData.refresh_token}`);
        if (mainAccountId) console.log(`SHOPEE_MERCHANT_ID=${mainAccountId}`);
        if (shopId) console.log(`SHOPEE_SHOP_ID=${shopId}`);
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Shopee Production 인증 완료!</h1>
        <p>merchant_id: ${mainAccountId || 'N/A'}</p>
        <p>shop_id: ${shopId || 'N/A'}</p>
        <p>access_token: ${tokenData.access_token}</p>
        <p>refresh_token: ${tokenData.refresh_token}</p>
        <p>터미널에서도 확인 가능합니다.</p>`);
    } catch (err) {
      console.error('\n토큰 발급 실패:', err.response?.data || err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>토큰 발급 실패</h1><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
    }

    setTimeout(() => server.close(), 2000);
  }
});

server.listen(5555, () => {
  const authUrl = generateAuthUrl();
  console.log('=================================');
  console.log('Shopee Production 인증 (CB 셀러)');
  console.log('=================================');
  console.log('\n아래 URL을 Shopee Seller Center가 로그인된 브라우저에서 열어주세요:\n');
  console.log(authUrl);
  console.log('\n승인 후 자동으로 토큰이 발급됩니다...');
  console.log('(콜백: http://localhost:5555/callback)');
});
