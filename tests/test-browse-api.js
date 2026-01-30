require('dotenv').config();
const axios = require('axios');

/**
 * eBay Browse API로 판매자(psychobear1)의 상품 검색
 * 공개 API로 OAuth Application Token 사용
 */

async function searchSellerItems(sellerUsername) {
  // 먼저 Application Token 발급
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  console.log('=== eBay Browse API 테스트 ===\n');
  console.log('1단계: Application Access Token 발급 중...\n');

  try {
    // Application Token 발급
    const tokenResponse = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`
        }
      }
    );

    const appToken = tokenResponse.data.access_token;
    console.log('✅ Application Token 발급 성공!');
    console.log('Token:', appToken.substring(0, 50) + '...\n');

    // Browse API로 판매자 상품 검색
    console.log('2단계: Browse API로 판매자 상품 검색 중...\n');
    console.log('판매자:', sellerUsername);

    const searchUrl = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

    const searchResponse = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      },
      params: {
        q: `seller:${sellerUsername}`,
        limit: 200
      }
    });

    console.log('✅ 검색 성공!\n');
    console.log('총 상품:', searchResponse.data.total || 0);
    console.log('이번 페이지:', searchResponse.data.itemSummaries?.length || 0);

    if (searchResponse.data.itemSummaries && searchResponse.data.itemSummaries.length > 0) {
      console.log('\n📋 샘플 상품 (처음 5개):\n');
      searchResponse.data.itemSummaries.slice(0, 5).forEach((item, index) => {
        console.log(`${index + 1}. ${item.title}`);
        console.log(`   Item ID: ${item.itemId}`);
        console.log(`   Price: ${item.price?.value} ${item.price?.currency}`);
        console.log('');
      });
    }

    return searchResponse.data;

  } catch (error) {
    console.error('❌ API 호출 실패:', error.message);
    if (error.response) {
      console.log('\n응답 상태:', error.response.status);
      console.log('응답 데이터:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

// 판매자 username
const sellerUsername = 'psychobear1';

searchSellerItems(sellerUsername);
