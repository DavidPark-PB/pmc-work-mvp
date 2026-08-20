import path from 'path';
import os from 'os';
import fs from 'fs';
import { chromium } from 'patchright';

const USER_DATA_DIR = path.join(os.homedir(), '.pmc-auto', 'chrome-profile');

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });

  const page = context.pages()[0] || await context.newPage();

  // 1. 네이버 쇼핑 통합 검색 (shopping.naver.com이 아닌 search.shopping.naver.com)
  console.log('=== 테스트 1: 네이버 쇼핑 카탈로그 ===');
  await page.goto('https://shopping.naver.com/ns/home', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 3000));
  let title = await page.title();
  let html = await page.content();
  console.log('제목:', title);
  console.log('HTML:', html.length, '| CAPTCHA:', html.includes('captcha'));

  // 2. 스마트스토어 개별 상점 (실제 존재하는 스토어)
  console.log('\n=== 테스트 2: 스마트스토어 개별 상점 ===');
  await page.goto('https://smartstore.naver.com/thetoyshop', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 3000));
  title = await page.title();
  html = await page.content();
  console.log('제목:', title);
  console.log('HTML:', html.length, '| CAPTCHA:', html.includes('captcha'));

  // 상품 목록 셀렉터 탐색
  const structure = await page.evaluate(() => {
    const selectors = [
      'a[data-nclick]',
      '.product_item',
      'li._3BkGa',
      '[class*="product"]',
      '[class*="Product"]',
      'ul li a',
      '.thumbnail',
      'img[alt]',
    ];
    const results: Record<string, number> = {};
    for (const sel of selectors) {
      try { results[sel] = document.querySelectorAll(sel).length; } catch { results[sel] = -1; }
    }
    return results;
  });
  console.log('셀렉터:', JSON.stringify(structure, null, 2));

  if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/smartstore-shop.html', html, 'utf-8');
  console.log('저장: data/smartstore-shop.html');

  // 3. 네이버 쇼핑 검색 (다시 한번)
  console.log('\n=== 테스트 3: search.shopping.naver.com ===');
  await page.goto('https://search.shopping.naver.com/search/all?query=포켓몬카드&pagingIndex=1', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 5000));
  title = await page.title();
  html = await page.content();
  console.log('제목:', title);
  console.log('HTML:', html.length, '| CAPTCHA:', html.includes('captcha'));
  fs.writeFileSync('data/naver-search2.html', html, 'utf-8');

  await context.close();
  console.log('\ndone');
}

main().catch(e => { console.error(e); process.exit(1); });
