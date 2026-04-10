/**
 * 크롤링 → CSV 저장 스크립트 (DB 연결 불필요)
 *
 * 사용법:
 *   npx tsx scripts/crawl-to-csv.ts coupang "아이폰 케이스"           (쿠팡 검색, 기본 2페이지)
 *   npx tsx scripts/crawl-to-csv.ts coupang "아이폰 케이스" 5         (쿠팡 검색, 5페이지)
 *   npx tsx scripts/crawl-to-csv.ts naver "포켓몬 카드"               (네이버 100개)
 *   npx tsx scripts/crawl-to-csv.ts naver "포켓몬 카드" 300           (네이버 300개)
 *
 * 출력: data/crawl-{platform}-{keyword}-{timestamp}.csv
 * → 이후 import-csv.ts로 DB에 수동 임포트
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- CSV 유틸 ---

function escapeCsvField(value: string): string {
  if (!value) return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// crawl_results 테이블과 1:1 매핑되는 컬럼
const CSV_HEADERS = [
  'external_id',
  'title',
  'price',
  'currency',
  'url',
  'image_url',
  'raw_data',
];

interface CsvRow {
  externalId: string;
  title: string;
  price: string;
  currency: string;
  url: string;
  imageUrl: string;
  rawData: string;
}

function rowToCsvLine(row: CsvRow): string {
  return [
    escapeCsvField(row.externalId),
    escapeCsvField(row.title),
    escapeCsvField(row.price),
    escapeCsvField(row.currency),
    escapeCsvField(row.url),
    escapeCsvField(row.imageUrl),
    escapeCsvField(row.rawData),
  ].join(',');
}

function saveCsv(rows: CsvRow[], filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = [CSV_HEADERS.join(','), ...rows.map(rowToCsvLine)];
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\n'), 'utf-8'); // BOM for Excel 한글 호환
}

function makeFilePath(platform: string, keyword: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeKeyword = keyword.replace(/[^가-힣a-zA-Z0-9]/g, '_');
  return `data/crawl-${platform}-${safeKeyword}-${timestamp}.csv`;
}

// --- 쿠팡 크롤링 (Patchright 직접 사용, DB 불필요) ---

async function crawlCoupangToCsv(keyword: string, maxPages: number): Promise<string> {
  const { chromium } = await import('patchright');
  const { humanScroll } = await import('../src/crawler/utils/human-behavior.js');

  const userDataDir = path.join(os.homedir(), '.pmc-auto', 'chrome-profile');
  const rows: CsvRow[] = [];

  console.log(`[쿠팡] 브라우저 시작 (Patchright)...`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const targetUrl = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${pageNum}`;
      console.log(`[쿠팡] 페이지 ${pageNum}/${maxPages}: ${keyword}`);

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        console.error(`  페이지 ${pageNum} 이동 실패:`, (e as Error).message);
        continue;
      }

      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      await humanScroll(page);

      const products = await page.evaluate(() => {
        let items = document.querySelectorAll('#product-list > li');
        if (items.length === 0) items = document.querySelectorAll('li.search-product');

        const results: { name: string; price: number; url: string; image: string }[] = [];
        items.forEach((item: Element) => {
          try {
            const name =
              item.querySelector('[class*="ProductUnit_productName"]')?.textContent?.trim() ||
              item.querySelector('.name')?.textContent?.trim();

            const priceText =
              item.querySelector('[class*="PriceArea_priceArea"]')?.textContent ||
              item.querySelector('.price-value')?.textContent;

            const url = item.querySelector('a')?.getAttribute('href');

            const image =
              item.querySelector('figure img')?.getAttribute('src') ||
              item.querySelector('figure img')?.getAttribute('data-img-src') ||
              item.querySelector('img.search-product-wrap-img')?.getAttribute('src') ||
              item.querySelector('img.search-product-wrap-img')?.getAttribute('data-img-src');

            const price = priceText ? parseInt(priceText.replace(/,/g, ''), 10) : 0;

            if (name && url) {
              results.push({
                name,
                price: price || 0,
                url: url.startsWith('http') ? url : `https://www.coupang.com${url}`,
                image: image ? (image.startsWith('//') ? `https:${image}` : image) : '',
              });
            }
          } catch { /* skip */ }
        });
        return results;
      });

      console.log(`  → ${products.length}개 상품 발견`);

      for (const p of products) {
        const match = p.url.match(/products\/(\d+)/);
        rows.push({
          externalId: match ? match[1] : p.url,
          title: p.name,
          price: String(p.price),
          currency: 'KRW',
          url: p.url,
          imageUrl: p.image,
          rawData: JSON.stringify({}),
        });
      }
    }

    if (rows.length === 0) {
      const html = await page.content();
      fs.writeFileSync('debug-coupang-search.html', html);
      console.log('[쿠팡] 상품 0개 - debug-coupang-search.html 저장됨');
    }
  } finally {
    await context.close();
  }

  const filePath = makeFilePath('coupang', keyword);
  saveCsv(rows, filePath);
  console.log(`\n✓ [쿠팡] ${rows.length}개 상품 → ${filePath}`);
  return filePath;
}

// --- 네이버 쇼핑 크롤링 (API, DB 불필요) ---

async function crawlNaverToCsv(keyword: string, maxItems: number): Promise<string> {
  const axios = (await import('axios')).default;

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 환경변수가 필요합니다');
  }

  const rows: CsvRow[] = [];
  const displayPerPage = Math.min(maxItems, 100);
  const totalPages = Math.ceil(maxItems / displayPerPage);

  for (let page = 0; page < totalPages; page++) {
    const start = page * displayPerPage + 1;
    if (start > 1000) break;

    console.log(`[네이버] 검색 "${keyword}" (start=${start}, display=${displayPerPage})`);

    try {
      const response = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
        params: { query: keyword, display: displayPerPage, start, sort: 'sim' },
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      });

      const { items, total } = response.data;
      console.log(`  → ${items.length}개 수신 (전체 ${total.toLocaleString()}개)`);

      for (const item of items) {
        const name = item.title.replace(/<[^>]*>/g, '');
        const category = [item.category1, item.category2, item.category3, item.category4]
          .filter(Boolean)
          .join(' > ');

        rows.push({
          externalId: item.productId,
          title: name,
          price: item.lprice || '0',
          currency: 'KRW',
          url: item.link,
          imageUrl: item.image,
          rawData: JSON.stringify({
            mallName: item.mallName,
            brand: item.brand,
            maker: item.maker,
            category,
            hprice: item.hprice,
            productType: item.productType,
          }),
        });
      }

      if (items.length < displayPerPage || start + displayPerPage > total) break;
    } catch (e: any) {
      if (e.response) {
        console.error(`[네이버] API 에러 ${e.response.status}:`, e.response.data);
      } else {
        console.error(`[네이버] 요청 실패:`, e.message);
      }
      break;
    }
  }

  const filePath = makeFilePath('naver', keyword);
  saveCsv(rows, filePath);
  console.log(`\n✓ [네이버] ${rows.length}개 상품 → ${filePath}`);
  return filePath;
}

// --- 메인 ---

async function main() {
  const platform = process.argv[2];
  const keyword = process.argv[3];
  const count = parseInt(process.argv[4] || '0', 10);

  if (!platform || !keyword) {
    console.log('크롤링 → CSV 저장 (DB 연결 불필요)\n');
    console.log('사용법:');
    console.log('  npx tsx scripts/crawl-to-csv.ts coupang "아이폰 케이스" [페이지수]');
    console.log('  npx tsx scripts/crawl-to-csv.ts naver "포켓몬 카드" [최대개수]\n');
    console.log('임포트:');
    console.log('  npx tsx scripts/import-csv.ts data/crawl-xxx.csv [소스명]');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log(`크롤링 → CSV: ${platform} "${keyword}"`);
  console.log('='.repeat(60));

  if (platform === 'coupang') {
    await crawlCoupangToCsv(keyword, count || 2);
  } else if (platform === 'naver') {
    await crawlNaverToCsv(keyword, count || 100);
  } else {
    console.error(`지원하지 않는 플랫폼: ${platform} (coupang, naver)`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => { console.error('크롤링 실패:', e.message); process.exit(1); });
