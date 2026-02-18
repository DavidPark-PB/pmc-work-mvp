require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const axios = require('axios');

const APP_ID = process.env.EBAY_APP_ID;
const CERT_ID = process.env.EBAY_CERT_ID;
const REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN;
const ENV = process.env.EBAY_ENVIRONMENT || 'PRODUCTION';

const TOKEN_URL = ENV === 'PRODUCTION'
  ? 'https://api.ebay.com/identity/v1/oauth2/token'
  : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';

const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
].join(' ');

async function refreshToken() {
  console.log('=================================');
  console.log('eBay OAuth 토큰 갱신');
  console.log('=================================');
  console.log('환경:', ENV);
  console.log('APP_ID:', APP_ID);
  console.log('REFRESH_TOKEN:', REFRESH_TOKEN?.substring(0, 30) + '...');

  const auth = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');

  try {
    const res = await axios.post(TOKEN_URL, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      scope: SCOPES,
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
      },
      timeout: 15000,
    });

    console.log('\n--- 토큰 갱신 성공 ---');
    console.log('access_token:', res.data.access_token?.substring(0, 50) + '...');
    console.log('expires_in:', res.data.expires_in, '초');
    console.log('token_type:', res.data.token_type);
    console.log('\n.env의 EBAY_USER_TOKEN을 아래 값으로 교체하세요:');
    console.log(`EBAY_USER_TOKEN=${res.data.access_token}`);

    return res.data;
  } catch (err) {
    const errData = err.response?.data;
    console.error('\n--- 토큰 갱신 실패 ---');
    console.error('상태:', err.response?.status);
    console.error('에러:', JSON.stringify(errData, null, 2));

    if (errData?.error === 'invalid_grant') {
      console.log('\nRefresh Token이 만료되었습니다.');
      console.log('eBay Developer Portal에서 새로 발급받아야 합니다:');
      console.log('  https://developer.ebay.com/my/keys');
      console.log('  → [Production] User Tokens → Get a Token from eBay via Your Application');
    }
    throw err;
  }
}

refreshToken().catch(() => process.exit(1));
