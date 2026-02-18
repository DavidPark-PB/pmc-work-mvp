require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const bcrypt = require('bcryptjs');
const axios = require('axios');

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET; // bcrypt salt

const TOKEN_URL = 'https://api.commerce.naver.com/external/v1/oauth2/token';

/**
 * 네이버 커머스 API 토큰 발급
 * client_secret_sign = bcrypt(clientId + "_" + timestamp, clientSecret)
 */
async function getToken() {
  const timestamp = Date.now();
  const password = `${CLIENT_ID}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, CLIENT_SECRET);
  const clientSecretSign = Buffer.from(hashed).toString('base64');

  console.log('=================================');
  console.log('네이버 커머스 API 토큰 발급');
  console.log('=================================');
  console.log('CLIENT_ID:', CLIENT_ID);
  console.log('timestamp:', timestamp);

  try {
    const res = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id: CLIENT_ID,
      timestamp: String(timestamp),
      client_secret_sign: clientSecretSign,
      grant_type: 'client_credentials',
      type: 'SELF',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    console.log('\n--- 토큰 발급 성공 ---');
    console.log('access_token:', res.data.access_token);
    console.log('expires_in:', res.data.expires_in, '초');
    console.log('token_type:', res.data.token_type);

    return res.data;
  } catch (err) {
    console.error('\n토큰 발급 실패:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * 토큰 발급 후 간단한 API 테스트 (채널 상품 목록 조회)
 */
async function testAPI(token) {
  console.log('\n--- API 테스트: 상품 목록 검색 ---');
  try {
    const res = await axios.post('https://api.commerce.naver.com/external/v1/products/search', {
      page: 1,
      size: 5,
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    console.log('상태:', res.status);
    const data = res.data;
    console.log('총 상품 수:', data.totalElements || data.total || 'N/A');
    const items = data.contents || data.products || [];
    console.log('조회된 상품:', items.length);
    items.forEach((p, i) => {
      console.log(`  ${i + 1}. [${p.channelProductNo || p.productNo || ''}] ${p.name || p.channelProductName || ''}`);
    });
  } catch (err) {
    console.error('API 테스트 실패:', err.response?.status, err.response?.data || err.message);
  }
}

(async () => {
  const tokenData = await getToken();
  if (tokenData.access_token) {
    await testAPI(tokenData.access_token);
  }
})();
