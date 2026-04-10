/**
 * eBay/Shopify 카테고리 매핑 테스트 스크립트
 * 실행: npx tsx scripts/test-category.ts [ebay|shopify|all]
 */
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { ShopifyClient } from '../src/platforms/shopify/ShopifyClient.js';

const testKeywords = [
  'Trading Card',
  'Pokemon Card Booster Box',
  'Toy',
  'Electronics',
  'Beauty',
  'K-Pop Album',
];

async function testEbayCategory() {
  console.log('=== eBay 카테고리 매핑 테스트 ===\n');

  const ebay = new EbayClient();

  for (const keyword of testKeywords) {
    try {
      const categoryId = await ebay.suggestCategoryId(keyword);
      console.log(`  "${keyword}" → categoryId: ${categoryId}`);
    } catch (e) {
      console.error(`  "${keyword}" → ERROR: ${(e as Error).message}`);
    }
  }

  console.log('\n=== eBay 캐시 테스트 (2번째 호출은 DB 캐시에서) ===\n');
  const start = Date.now();
  const cached = await ebay.suggestCategoryId('Trading Card');
  console.log(`  "Trading Card" (캐시) → ${cached} (${Date.now() - start}ms)`);
}

async function testShopifyCategory() {
  console.log('=== Shopify 카테고리 매핑 테스트 ===\n');

  let shopify: ShopifyClient;
  try {
    shopify = new ShopifyClient();
  } catch (e) {
    console.error(`  Shopify 초기화 실패: ${(e as Error).message}`);
    return;
  }

  for (const keyword of testKeywords) {
    try {
      const categoryId = await shopify.suggestCategoryId(keyword);
      console.log(`  "${keyword}" → categoryId: ${categoryId}`);
    } catch (e) {
      console.error(`  "${keyword}" → ERROR: ${(e as Error).message}`);
    }
  }

  console.log('\n=== Shopify 캐시 테스트 (2번째 호출은 DB 캐시에서) ===\n');
  const start = Date.now();
  const cached = await shopify.suggestCategoryId('Trading Card');
  console.log(`  "Trading Card" (캐시) → ${cached} (${Date.now() - start}ms)`);
}

const target = process.argv[2] || 'all';

async function main() {
  if (target === 'ebay' || target === 'all') {
    await testEbayCategory();
    console.log('');
  }
  if (target === 'shopify' || target === 'all') {
    await testShopifyCategory();
  }
}

main()
  .then(() => {
    console.log('\n완료');
    process.exit(0);
  })
  .catch(e => {
    console.error('테스트 실패:', e);
    process.exit(1);
  });
