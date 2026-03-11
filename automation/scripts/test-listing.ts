/**
 * 리스팅 파이프라인 테스트
 *
 * 사용법:
 *   npx tsx scripts/test-listing.ts ebay-test       (eBay 연결 테스트)
 *   npx tsx scripts/test-listing.ts shopify-test     (Shopify 연결 테스트)
 *   npx tsx scripts/test-listing.ts pricing          (가격 계산 테스트)
 *   npx tsx scripts/test-listing.ts import <id>      (crawl_result → product 임포트)
 *   npx tsx scripts/test-listing.ts create <id> <platform> [--dry-run]  (리스팅 생성)
 */
import 'dotenv/config';
import { EbayClient } from '../src/platforms/ebay/EbayClient.js';
import { ShopifyClient } from '../src/platforms/shopify/ShopifyClient.js';
import { calculatePriceSimple } from '../src/services/pricing.js';
import { importFromCrawl, createListing } from '../src/services/listing-service.js';

async function testEbay() {
  console.log('=== eBay 연결 테스트 ===\n');
  const ebay = new EbayClient();
  const ok = await ebay.testConnection();
  if (ok) {
    console.log('\n활성 리스팅 조회 중...');
    const listings = await ebay.getActiveListings();
    console.log(`총 ${listings.length}개 활성 리스팅`);
    listings.slice(0, 3).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title.substring(0, 50)} | $${item.price} | SKU: ${item.sku}`);
    });
  }
}

async function testShopify() {
  console.log('=== Shopify 연결 테스트 ===\n');
  const shopify = new ShopifyClient();
  await shopify.testConnection();
}

function testPricing() {
  console.log('=== 가격 계산 테스트 ===\n');

  const testCases = [
    { costKRW: 3600, name: '딱풀 3,600원' },
    { costKRW: 6790, name: '주방저울 6,790원' },
    { costKRW: 9940, name: '상토 9,940원' },
    { costKRW: 50000, name: '포켓몬카드 50,000원' },
  ];

  console.log('기본 배송비: 5,500 KRW | 마진율: 30% | 환율: 1,400\n');

  for (const tc of testCases) {
    const ebay = calculatePriceSimple(tc.costKRW, 5500, { platform: 'ebay' });
    const shopify = calculatePriceSimple(tc.costKRW, 5500, { platform: 'shopify' });

    console.log(`${tc.name}:`);
    console.log(`  eBay:    $${ebay.salePrice} + shipping $${ebay.shippingCost}`);
    console.log(`  Shopify: $${shopify.salePrice} + shipping $${shopify.shippingCost}`);
    console.log('');
  }
}

async function testImport(crawlResultId: number) {
  console.log(`=== crawl_result #${crawlResultId} → product 임포트 ===\n`);
  const productId = await importFromCrawl(crawlResultId);
  console.log(`product #${productId} 생성 완료`);
}

async function testCreate(productId: number, platform: string, dryRun: boolean) {
  console.log(`=== product #${productId} → ${platform} 리스팅 생성 ===\n`);
  const result = await createListing(productId, platform, { dryRun });
  console.log('\n결과:', result);
}

async function main() {
  const mode = process.argv[2];

  try {
    switch (mode) {
      case 'ebay-test':
        await testEbay();
        break;
      case 'shopify-test':
        await testShopify();
        break;
      case 'pricing':
        testPricing();
        break;
      case 'import': {
        const id = parseInt(process.argv[3]);
        if (!id) { console.log('사용법: test-listing.ts import <crawl_result_id>'); break; }
        await testImport(id);
        break;
      }
      case 'create': {
        const id = parseInt(process.argv[3]);
        const platform = process.argv[4] || 'ebay';
        const dryRun = process.argv.includes('--dry-run');
        if (!id) { console.log('사용법: test-listing.ts create <product_id> <platform> [--dry-run]'); break; }
        await testCreate(id, platform, dryRun);
        break;
      }
      default:
        console.log('사용법:');
        console.log('  npx tsx scripts/test-listing.ts ebay-test');
        console.log('  npx tsx scripts/test-listing.ts shopify-test');
        console.log('  npx tsx scripts/test-listing.ts pricing');
        console.log('  npx tsx scripts/test-listing.ts import <crawl_result_id>');
        console.log('  npx tsx scripts/test-listing.ts create <product_id> <platform> [--dry-run]');
    }
  } catch (e) {
    console.error('오류:', (e as Error).message);
    process.exit(1);
  }

  process.exit(0);
}

main();
