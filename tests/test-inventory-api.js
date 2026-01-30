require('dotenv').config();
const axios = require('axios');

/**
 * eBay Inventory API로 상품 목록 가져오기
 * OAuth 2.0 User Access Token 사용
 */

async function getInventoryItems() {
  const accessToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/sell/inventory/v1/inventory_item';

  console.log('=== eBay Inventory API 테스트 ===\n');
  console.log(`Token: ${accessToken.substring(0, 30)}...\n`);

  try {
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      params: {
        limit: 100,
        offset: 0
      }
    });

    console.log('✅ API 호출 성공!\n');
    console.log('전체 응답:', JSON.stringify(response.data, null, 2).substring(0, 2000));
    console.log('\n' + '='.repeat(80));
    console.log('\n총 상품:', response.data.total || 0);
    console.log('이번 페이지:', response.data.inventoryItems?.length || 0);

    if (response.data.inventoryItems && response.data.inventoryItems.length > 0) {
      console.log('\n📋 샘플 상품 (처음 5개):\n');
      response.data.inventoryItems.slice(0, 5).forEach((item, index) => {
        console.log(`${index + 1}. SKU: ${item.sku}`);
        console.log(`   제목: ${item.product?.title || 'N/A'}`);
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

getInventoryItems();
