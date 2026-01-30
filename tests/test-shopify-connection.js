require('dotenv').config();
const ShopifyAPI = require('./shopifyAPI');

/**
 * Shopify API 연결 테스트 스크립트
 */
async function testShopifyConnection() {
  console.log('\n=== Shopify API 연결 테스트 ===\n');

  try {
    // 환경 변수 확인
    console.log('1. 환경 변수 확인:');
    console.log(`   SHOPIFY_STORE_URL: ${process.env.SHOPIFY_STORE_URL ? '✅ 설정됨' : '❌ 없음'}`);
    console.log(`   SHOPIFY_ACCESS_TOKEN: ${process.env.SHOPIFY_ACCESS_TOKEN ? '✅ 설정됨' : '❌ 없음'}`);
    console.log(`   SHOPIFY_API_VERSION: ${process.env.SHOPIFY_API_VERSION || '2024-01 (기본값)'}`);

    if (!process.env.SHOPIFY_STORE_URL || !process.env.SHOPIFY_ACCESS_TOKEN) {
      console.log('\n❌ .env 파일에 Shopify 자격증명을 설정해주세요.');
      console.log('   .env.example 파일을 참고하세요.\n');
      return;
    }

    // Shopify API 초기화
    const shopify = new ShopifyAPI();

    // 연결 테스트
    console.log('\n2. Shopify 연결 테스트:');
    const isConnected = await shopify.testConnection();

    if (!isConnected) {
      console.log('\n❌ 연결 실패. 다음을 확인하세요:');
      console.log('   1. SHOPIFY_STORE_URL이 올바른지 (예: your-store.myshopify.com)');
      console.log('   2. SHOPIFY_ACCESS_TOKEN이 유효한지');
      console.log('   3. API 권한에 read_products가 포함되어 있는지');
      return;
    }

    // 샘플 상품 3개 가져오기
    console.log('\n3. 샘플 상품 데이터 미리보기:');
    const products = await shopify.getAllProducts(3);

    if (products.length === 0) {
      console.log('   📭 상품이 없습니다.');
    } else {
      console.log(`\n   처음 ${products.length}개 상품:\n`);
      products.forEach((product, index) => {
        console.log(`   ${index + 1}. ${product.title}`);
        console.log(`      - ID: ${product.id}`);
        console.log(`      - Variants: ${product.variants.length}개`);
        product.variants.forEach(variant => {
          console.log(`         • SKU: ${variant.sku || '없음'} | Price: $${variant.price}`);
        });
        console.log('');
      });
    }

    console.log('✅ 모든 테스트 통과!\n');
    console.log('이제 sync-shopify-to-sheets.js를 실행하여 데이터를 동기화할 수 있습니다.');

  } catch (error) {
    console.error('\n❌ 테스트 실패:', error.message);
  }
}

testShopifyConnection();
