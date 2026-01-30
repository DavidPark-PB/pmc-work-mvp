require('dotenv').config();
const axios = require('axios');

/**
 * eBay Fulfillment API로 주문 정보 가져오기
 * OAuth 2.0 User Access Token 사용
 */

async function getOrders() {
  const accessToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/sell/fulfillment/v1/order';

  console.log('=== eBay Fulfillment API 테스트 ===\n');
  console.log(`Token: ${accessToken.substring(0, 30)}...\n`);

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      params: {
        limit: 50
      }
    });

    console.log('✅ API 호출 성공!\n');
    console.log('전체 응답:', JSON.stringify(response.data, null, 2).substring(0, 2000));
    console.log('\n' + '='.repeat(80));
    console.log('\n총 주문:', response.data.total || 0);
    console.log('이번 페이지:', response.data.orders?.length || 0);

    if (response.data.orders && response.data.orders.length > 0) {
      console.log('\n📋 샘플 주문 (처음 3개):\n');
      response.data.orders.slice(0, 3).forEach((order, index) => {
        console.log(`${index + 1}. Order ID: ${order.orderId}`);
        console.log(`   Buyer: ${order.buyer?.username || 'N/A'}`);
        console.log(`   Total: ${order.pricingSummary?.total?.value} ${order.pricingSummary?.total?.currency}`);
        console.log('');
      });
    }

    return response.data;

  } catch (error) {
    console.error('❌ API 호출 실패:', error.message);
    if (error.response) {
      console.log('\n응답 상태:', error.response.status);
      console.log('응답 데이터:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

getOrders();
