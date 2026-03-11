/**
 * 크롤러 테스트 스크립트
 *
 * 사용법:
 *   npx tsx scripts/test-crawler.ts search "아이폰 케이스"      (쿠팡 검색)
 *   npx tsx scripts/test-crawler.ts detail "https://..."        (쿠팡 상세)
 *   npx tsx scripts/test-crawler.ts naver "포켓몬 카드"          (네이버 쇼핑)
 */
import 'dotenv/config';
import fs from 'fs';
import { CoupangCrawler } from '../src/crawler/CoupangCrawler.js';
import { NaverShoppingCrawler } from '../src/crawler/NaverShoppingCrawler.js';

async function testCoupangSearch(keyword: string) {
  console.log('='.repeat(60));
  console.log(`쿠팡 검색 테스트: "${keyword}"`);
  console.log('='.repeat(60));

  const crawler = new CoupangCrawler();

  try {
    await crawler.init();
    const products = await crawler.search(keyword, 1);

    console.log(`\n--- 결과: ${products.length}개 상품 ---`);
    products.slice(0, 5).forEach((p, i) => {
      console.log(`${i + 1}. ${p.name.substring(0, 50)}...`);
      console.log(`   가격: ${p.price.toLocaleString()}원`);
      console.log(`   URL: ${p.url.substring(0, 80)}...`);
      console.log('');
    });

    if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/crawl-search-result.json', JSON.stringify(products, null, 2), 'utf-8');
    console.log(`결과 저장: data/crawl-search-result.json (${products.length}개)`);
    return products;
  } finally {
    await crawler.close();
  }
}

async function testCoupangDetail(url: string) {
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

    if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/crawl-detail-result.json', JSON.stringify(detail, null, 2), 'utf-8');
    console.log(`\n결과 저장: data/crawl-detail-result.json`);
    return detail;
  } finally {
    await crawler.close();
  }
}

async function testNaverSearch(keyword: string) {
  console.log('='.repeat(60));
  console.log(`네이버 쇼핑 검색 테스트: "${keyword}"`);
  console.log('='.repeat(60));

  const crawler = new NaverShoppingCrawler();
  const products = await crawler.search(keyword, 100);

  console.log(`\n--- 결과: ${products.length}개 상품 ---`);
  products.slice(0, 10).forEach((p, i) => {
    console.log(`${i + 1}. ${p.name.substring(0, 50)}...`);
    console.log(`   가격: ${p.price.toLocaleString()}원 | ${p.mallName} | ${p.brand || '-'}`);
    console.log(`   카테고리: ${p.category}`);
    console.log('');
  });

  if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/naver-search-result.json', JSON.stringify(products, null, 2), 'utf-8');
  console.log(`결과 저장: data/naver-search-result.json (${products.length}개)`);
  return products;
}

async function main() {
  const mode = process.argv[2] || 'search';
  const arg = process.argv[3];

  try {
    if (mode === 'search') {
      await testCoupangSearch(arg || '아이폰 케이스');
    } else if (mode === 'detail') {
      await testCoupangDetail(arg || 'https://www.coupang.com/vp/products/7854711967');
    } else if (mode === 'naver') {
      await testNaverSearch(arg || '포켓몬 카드');
    } else {
      console.log('사용법:');
      console.log('  npx tsx scripts/test-crawler.ts search "키워드"     (쿠팡)');
      console.log('  npx tsx scripts/test-crawler.ts detail "URL"        (쿠팡 상세)');
      console.log('  npx tsx scripts/test-crawler.ts naver "키워드"      (네이버 쇼핑)');
    }
  } catch (error) {
    console.error('테스트 실패:', (error as Error).message);
    process.exit(1);
  }
}

main();
