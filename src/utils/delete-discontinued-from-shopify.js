require('dotenv').config({ path: '../../config/.env' });
const ShopifyAPI = require('../api/shopifyAPI');
const GoogleSheetsAPI = require('../api/googleSheetsAPI');
const readline = require('readline');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * 사용자 확인 받기
 */
function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * '삭제예정' 상품을 Shopify에서 삭제
 */
async function deleteDiscontinuedFromShopify() {
  console.log('\n=== Shopify에서 Discontinued 상품 삭제 ===\n');

  try {
    const sheets = new GoogleSheetsAPI('../../config/credentials.json');
    const shopify = new ShopifyAPI();

    await sheets.authenticate();

    // 1. '삭제예정' 상품 찾기
    console.log('1. Google Sheets에서 "삭제예정" 상품 찾기 중...');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:J');

    const toDelete = [];
    data.forEach((row, index) => {
      const [sku, name, , , , , , , , status] = row;
      if (status === '삭제예정') {
        toDelete.push({
          rowNum: index + 2,
          sku,
          name
        });
      }
    });

    console.log(`   발견: ${toDelete.length}개 상품\n`);

    if (toDelete.length === 0) {
      console.log('✅ 삭제할 상품이 없습니다.');
      return;
    }

    // 2. 삭제할 상품 목록 출력
    console.log('2. 삭제 예정 상품 목록:\n');
    toDelete.forEach((product, index) => {
      console.log(`   ${index + 1}. ${product.sku}`);
      console.log(`      ${product.name}`);
    });

    console.log('\n⚠️  경고: 이 작업은 되돌릴 수 없습니다!');
    console.log('   Shopify에서 상품이 영구적으로 삭제됩니다.\n');

    // 3. 사용자 확인
    const confirmed = await askConfirmation(`정말로 ${toDelete.length}개 상품을 Shopify에서 삭제하시겠습니까? (y/n): `);

    if (!confirmed) {
      console.log('\n❌ 취소되었습니다.');
      return;
    }

    console.log('\n3. Shopify에서 상품 삭제 중...\n');

    // 4. Shopify에서 모든 상품 가져오기 (SKU로 매칭하기 위해)
    console.log('   Shopify 상품 목록 로딩 중...');
    const allProducts = await shopify.getAllProducts();

    // SKU -> Product ID 매핑 생성
    const skuToProductId = new Map();
    allProducts.forEach(product => {
      product.variants.forEach(variant => {
        const sku = variant.sku || `SHOPIFY-${variant.id}`;
        skuToProductId.set(sku, product.id);
      });
    });

    console.log(`   총 ${skuToProductId.size}개 SKU 매핑 완료\n`);

    // 5. 삭제 실행
    let deleted = 0;
    let notFound = 0;
    const errors = [];

    for (const product of toDelete) {
      const productId = skuToProductId.get(product.sku);

      if (!productId) {
        console.log(`   ⚠️  SKU ${product.sku} - Shopify에서 찾을 수 없음`);
        notFound++;
        continue;
      }

      try {
        // Shopify에서 상품 삭제
        await shopify.deleteProduct(productId);
        console.log(`   ✅ 삭제됨: ${product.sku} (${product.name})`);
        deleted++;

        // Rate limiting 방지
        await shopify.sleep(500);

      } catch (error) {
        console.log(`   ❌ 실패: ${product.sku} - ${error.message}`);
        errors.push({ sku: product.sku, error: error.message });
      }
    }

    console.log('\n4. Google Sheets 업데이트 중...\n');

    // 6. Google Sheets에서도 삭제된 행 제거 (역순으로)
    // 주의: Google Sheets API로 행 삭제는 복잡하므로, 대신 상태를 '삭제완료'로 변경
    for (const product of toDelete) {
      if (skuToProductId.get(product.sku)) {
        await sheets.writeData(SPREADSHEET_ID, `시트1!J${product.rowNum}`, [['삭제완료']]);
      }
    }

    console.log('\n✅ 작업 완료!');
    console.log(`\n📊 결과:`);
    console.log(`   - Shopify에서 삭제: ${deleted}개`);
    console.log(`   - 찾을 수 없음: ${notFound}개`);
    console.log(`   - 실패: ${errors.length}개`);

    if (errors.length > 0) {
      console.log(`\n❌ 삭제 실패 목록:`);
      errors.forEach(err => {
        console.log(`   - ${err.sku}: ${err.error}`);
      });
    }

    console.log(`\n🔗 스프레드시트 확인:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

deleteDiscontinuedFromShopify();
