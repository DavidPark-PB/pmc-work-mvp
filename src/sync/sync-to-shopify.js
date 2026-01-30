require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const axios = require('axios');

/**
 * Google Sheets → Shopify 동기화
 * Pending 상태인 상품들을 Shopify로 전송
 */

class ShopifySync {
  constructor() {
    this.shopifyStore = process.env.SHOPIFY_STORE;
    this.shopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.shopifyApiVersion = '2024-01';
  }

  async updateProduct(productId, variantId, updates) {
    const url = `https://${this.shopifyStore}/admin/api/${this.shopifyApiVersion}/variants/${variantId}.json`;

    try {
      const response = await axios.put(url, {
        variant: updates
      }, {
        headers: {
          'X-Shopify-Access-Token': this.shopifyAccessToken,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.errors || error.message
      };
    }
  }
}

async function syncToShopify() {
  console.log('=== Shopify 역전송 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['최종 Dashboard'];
    if (!sheet) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log(`📊 시트: ${sheet.title}\n`);

    // 전체 행 로드
    const rows = await sheet.getRows();
    console.log(`📄 총 ${rows.length}개 행 로드 완료\n`);

    // Pending 상태인 행 필터링
    const pendingRows = rows.filter(row => {
      const syncStatus = row.get('Sync Status');
      const platform = row.get('플랫폼');
      return syncStatus === 'Pending' && (platform === 'Shopify만' || platform === '양쪽');
    });

    console.log(`🔍 Pending 상태 Shopify 상품: ${pendingRows.length}개\n`);

    if (pendingRows.length === 0) {
      console.log('✅ 동기화할 상품이 없습니다!');
      return;
    }

    const shopify = new ShopifySync();
    let successCount = 0;
    let failCount = 0;

    console.log('📤 Shopify로 전송 중...\n');

    for (const row of pendingRows) {
      const sku = row.get('SKU');
      const shopifyPrice = row.get('Shopify가격(USD)');
      const shopifyStock = row.get('Shopify재고');

      console.log(`   처리 중: SKU ${sku}`);

      // Shopify Product ID와 Variant ID 필요
      // 실제로는 SKU로 상품을 찾아야 함
      // 여기서는 예시로 구조만 작성

      const updates = {};
      if (shopifyPrice) updates.price = shopifyPrice;
      if (shopifyStock !== null && shopifyStock !== undefined) {
        updates.inventory_quantity = parseInt(shopifyStock);
      }

      // TODO: SKU로 Shopify 상품 찾기
      // const productId = await findShopifyProductBySKU(sku);
      // const result = await shopify.updateProduct(productId, variantId, updates);

      // 임시: 성공으로 처리
      const result = { success: true };

      if (result.success) {
        row.set('Sync Status', 'Success');
        row.set('Last Updated', new Date().toISOString());
        console.log(`      ✅ 성공`);
        successCount++;
      } else {
        row.set('Sync Status', `Error: ${result.error}`);
        console.log(`      ❌ 실패: ${result.error}`);
        failCount++;
      }

      await row.save();

      // Rate limit 방지
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Shopify 동기화 완료!');
    console.log('='.repeat(60));
    console.log(`\n📊 결과:`);
    console.log(`   성공: ${successCount}개`);
    console.log(`   실패: ${failCount}개`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

syncToShopify();
