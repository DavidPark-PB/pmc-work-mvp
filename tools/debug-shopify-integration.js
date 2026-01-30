require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * Shopify 통합 디버깅
 * - 실제 칼럼명 확인
 * - 샘플 데이터 확인
 */

async function debugShopifyIntegration() {
  console.log('=== Shopify 통합 디버깅 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    // 1. Shopify 시트 헤더
    console.log('📊 Shopify 시트 헤더:\n');
    const shopifySheet = doc.sheetsByTitle['Shopify'];
    const shopifyRows = await shopifySheet.getRows({ limit: 5 });
    console.log('   헤더:', shopifySheet.headerValues);
    console.log('\n   샘플 데이터 (첫 3행):');
    shopifyRows.slice(0, 3).forEach((row, i) => {
      console.log(`   Row ${i + 1}:`);
      console.log(`      SKU: ${row.get('SKU')}`);
      console.log(`      Price: ${row.get('Price')}`);
      console.log(`      Shipping Cost: ${row.get('Shipping Cost')}`);
    });

    // 2. Dashboard 헤더
    console.log('\n📋 Dashboard 헤더:\n');
    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    const dashboardRows = await dashboard.getRows({ limit: 5 });
    console.log('   헤더:', dashboard.headerValues);
    console.log('\n   샘플 데이터 (첫 3행):');
    dashboardRows.slice(0, 3).forEach((row, i) => {
      console.log(`   Row ${i + 1}:`);
      console.log(`      SKU: ${row.get('SKU')}`);
      console.log(`      플랫폼: ${row.get('플랫폼')}`);
      console.log(`      판매가(USD): "${row.get('판매가(USD)')}"`);
      console.log(`      국제 배송비(USD): "${row.get('국제 배송비(USD)')}"`);
    });

    // 3. 빈 칸 카운트
    console.log('\n🔍 빈 칸 분석:\n');
    const allRows = await dashboard.getRows();

    let emptyPriceCount = 0;
    let emptyShippingCount = 0;
    let shopifyOnlyCount = 0;

    allRows.forEach(row => {
      const platform = row.get('플랫폼');
      const price = row.get('판매가(USD)');
      const shipping = row.get('국제 배송비(USD)');

      if (platform === 'Shopify만') {
        shopifyOnlyCount++;
      }

      if (!price || price === '' || price === null) {
        emptyPriceCount++;
      }

      if (!shipping || shipping === '' || shipping === null) {
        emptyShippingCount++;
      }
    });

    console.log(`   총 행: ${allRows.length}개`);
    console.log(`   Shopify만 상품: ${shopifyOnlyCount}개`);
    console.log(`   빈 판매가: ${emptyPriceCount}개`);
    console.log(`   빈 국제 배송비: ${emptyShippingCount}개`);

    // 4. 샘플 Shopify 상품 확인
    console.log('\n🔎 Shopify 상품 샘플 (첫 5개):\n');
    const shopifyProducts = allRows.filter(r => r.get('플랫폼') === 'Shopify만').slice(0, 5);
    shopifyProducts.forEach((row, i) => {
      console.log(`   ${i + 1}. SKU: ${row.get('SKU')}`);
      console.log(`      판매가(USD): "${row.get('판매가(USD)')}"`);
      console.log(`      국제 배송비(USD): "${row.get('국제 배송비(USD)')}"`);
    });

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
  }
}

debugShopifyIntegration();
