require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const crypto = require('crypto');
const http = require('http');
const axios = require('axios');

const PARTNER_ID = parseInt(process.env.SHOPEE_PARTNER_ID);
// Partner Key는 shpk 접두사 포함하여 그대로 사용
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const SHOP_ID = parseInt(process.env.SHOPEE_SHOP_ID);
const BASE_URL = 'https://openplatform.sandbox.test-stable.shopee.sg';
const REDIRECT_URL = 'http://localhost:5555/callback';

function generateSign(path, timestamp) {
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

function generateAuthUrl() {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = generateSign(path, timestamp);
  return `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(REDIRECT_URL)}`;
}

async function getAccessToken(code, shopId) {
  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');

  const url = `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const res = await axios.post(url, {
    code,
    partner_id: PARTNER_ID,
    shop_id: shopId,
  });

  return res.data;
}

// 로컬 서버로 콜백 받기
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/callback')) {
    const url = new URL(req.url, 'http://localhost:5555');
    const code = url.searchParams.get('code');
    const shopId = parseInt(url.searchParams.get('shop_id')) || SHOP_ID;

    console.log('\n--- 인증 코드 수신 ---');
    console.log('code:', code);
    console.log('shop_id:', shopId);

    try {
      const tokenData = await getAccessToken(code, shopId);
      console.log('\n--- Access Token 발급 완료 ---');
      console.log('access_token:', tokenData.access_token);
      console.log('refresh_token:', tokenData.refresh_token);
      console.log('expire_in:', tokenData.expire_in, '초');
      console.log('\n.env에 아래 값을 입력하세요:');
      console.log(`SHOPEE_ACCESS_TOKEN=${tokenData.access_token}`);
      console.log(`SHOPEE_REFRESH_TOKEN=${tokenData.refresh_token}`);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>인증 완료!</h1><p>Access Token: ${tokenData.access_token}</p><p>Refresh Token: ${tokenData.refresh_token}</p><p>터미널에서도 확인할 수 있습니다. 이 창을 닫아도 됩니다.</p>`);
    } catch (err) {
      console.error('토큰 발급 실패:', err.response?.data || err.message);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>토큰 발급 실패</h1><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
    }

    setTimeout(() => server.close(), 2000);
  }
});

server.listen(5555, () => {
  const authUrl = generateAuthUrl();
  console.log('=================================');
  console.log('Shopee Sandbox 인증');
  console.log('=================================');
  console.log('\n아래 URL을 브라우저에서 열어주세요:\n');
  console.log(authUrl);
  console.log('\n승인 후 자동으로 토큰이 발급됩니다...');
});
