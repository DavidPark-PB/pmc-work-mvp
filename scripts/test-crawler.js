/**
 * 쿠팡 크롤러 테스트 스크립트
 *
 * 사용법: node scripts/test-crawler.js [search|detail] [키워드|URL]
 *
 * 예시:
 *   node scripts/test-crawler.js search "아이폰 케이스"
 *   node scripts/test-crawler.js detail "https://www.coupang.com/vp/products/7854711967"
 */
const { CoupangCrawler } = require('../src/crawler/CoupangCrawler');
const { generateShopifyCSV } = require('../src/crawler/shopify-transformer');
const fs = require('fs');

async function testSearch(keyword) {
  console.log('='.repeat(60));
  console.log(`쿠팡 검색 테스트: "${keyword}"`);
  console.log('='.repeat(60));

  const crawler = new CoupangCrawler();

  try {
    await crawler.init();
    const products = await crawler.search(keyword, 1); // 1페이지만

    console.log(`\n--- 결과: ${products.length}개 상품 ---`);
    products.slice(0, 5).forEach((p, i) => {
      console.log(`${i + 1}. ${p.name.substring(0, 50)}...`);
      console.log(`   가격: ${p.price.toLocaleString()}원`);
      console.log(`   URL: ${p.url.substring(0, 80)}...`);
      console.log('');
    });

    // 결과 저장
    fs.writeFileSync(
      'data/crawl-search-result.json',
      JSON.stringify(products, null, 2),
      'utf-8'
    );
    console.log(`결과 저장: data/crawl-search-result.json (${products.length}개)`);

    return products;
  } finally {
    await crawler.close();
  }
}

async function testDetail(url) {
  console.log('='.repeat(60));
  console.log(`쿠팡 상세 테스트: ${url}`);
  console.log('='.repeat(60));

  const crawler = new CoupangCrawler();

  try {
    await crawler.init();
    const detail = await crawler.scrapeDetail(url);

    console.log('\n--- 상세 결과 ---');
    console.log(`상품명: ${detail.name}`);
    console.log(`가격: ${detail.price.toLocaleString()}원`);
    console.log(`판매자: ${detail.vendor}`);
    console.log(`이미지: ${detail.images.length}개`);
    console.log(`옵션: ${detail.options.length}개`);
    detail.options.forEach((opt) => {
      console.log(`  - ${opt.name}: ${opt.values.join(', ')}`);
    });
    console.log(`상세 HTML: ${detail.bodyHtml.length}자`);

    // 결과 저장
    fs.writeFileSync(
      'data/crawl-detail-result.json',
      JSON.stringify(detail, null, 2),
      'utf-8'
    );
    console.log(`\n결과 저장: data/crawl-detail-result.json`);

    // Shopify CSV 테스트
    const csv = generateShopifyCSV([detail], 1.5);
    fs.writeFileSync('data/crawl-shopify-export.csv', csv, 'utf-8');
    console.log(`Shopify CSV 저장: data/crawl-shopify-export.csv`);

    return detail;
  } finally {
    await crawler.close();
  }
}

async function main() {
  const mode = process.argv[2] || 'search';
  const arg = process.argv[3];

  // data 폴더 확인
  if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });

  try {
    if (mode === 'search') {
      const keyword = arg || '아이폰 케이스';
      await testSearch(keyword);
    } else if (mode === 'detail') {
      const url = arg || 'https://www.coupang.com/vp/products/7854711967';
      await testDetail(url);
    } else {
      console.log('사용법: node scripts/test-crawler.js [search|detail] [키워드|URL]');
    }
  } catch (error) {
    console.error('테스트 실패:', error.message);
    process.exit(1);
  }
}

main();
