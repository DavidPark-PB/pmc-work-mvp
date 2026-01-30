require('dotenv').config();
const axios = require('axios');

/**
 * eBay Account API로 계정 정보 확인
 * OAuth 2.0 User Access Token 사용
 */

async function getAccount() {
  const accessToken = process.env.EBAY_USER_TOKEN;

  console.log('=== eBay Account API 테스트 ===\n');
  console.log(`Token: ${accessToken.substring(0, 30)}...\n`);

  // 여러 엔드포인트 테스트
  const endpoints = [
    { name: 'Fulfillment Policies', url: 'https://api.ebay.com/sell/account/v1/fulfillment_policy' },
    { name: 'Payment Policies', url: 'https://api.ebay.com/sell/account/v1/payment_policy' },
    { name: 'Return Policies', url: 'https://api.ebay.com/sell/account/v1/return_policy' },
    { name: 'Privileges', url: 'https://api.ebay.com/sell/account/v1/privilege' }
  ];

  for (const endpoint of endpoints) {
    console.log(`\n테스트: ${endpoint.name}`);
    console.log(`URL: ${endpoint.url}\n`);

    try {
      const response = await axios.get(endpoint.url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      console.log('✅ 성공!');
      console.log('응답:', JSON.stringify(response.data, null, 2).substring(0, 500));
      return response.data;

    } catch (error) {
      console.log('❌ 실패:', error.response?.status || error.message);
      if (error.response?.data) {
        console.log('에러:', JSON.stringify(error.response.data, null, 2).substring(0, 300));
      }
    }
  }

  return null;
}

getAccount();
