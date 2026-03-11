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

  console.log('1. 네이버 쇼핑 검색 페이지 접속...');
  await page.goto('https://search.shopping.naver.com/search/all?query=포켓몬+카드', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // 잠시 대기 (React 렌더링)
  await new Promise(r => setTimeout(r, 3000));

  const html = await page.content();
  console.log('2. HTML 길이:', html.length);

  // HTML 파일로 저장
  fs.writeFileSync('data/naver-shopping.html', html, 'utf-8');
  console.log('3. data/naver-shopping.html 저장 완료');

  // 상품 카드 구조 탐색
  const structure = await page.evaluate(() => {
    // 다양한 셀렉터 시도
    const selectors = [
      '.product_item',
      '.basicList_item__0T9JD',
      '[data-nclick]',
      '.product_link',
      '.list_basis',
      '.adProduct_item',
      'li.product_item',
      'div.product_item',
      '.thumbnail_thumb',
      'a[data-i]',
      '.product_info_area',
      '.product_title',
      '.price_num',
    ];

    const results: Record<string, number> = {};
    for (const sel of selectors) {
      try {
        results[sel] = document.querySelectorAll(sel).length;
      } catch {
        results[sel] = -1;
      }
    }

    // 첫 번째 상품 카드의 구조를 덤프
    const firstProduct = document.querySelector('.basicList_item__0T9JD')
      || document.querySelector('[data-nclick*="product"]')
      || document.querySelector('.product_item');

    return {
      selectorCounts: results,
      firstProductHTML: firstProduct?.outerHTML?.substring(0, 2000) || 'NOT FOUND',
      bodyClassList: document.body.className,
      title: document.title,
    };
  });

  console.log('\n4. 셀렉터 카운트:');
  for (const [sel, count] of Object.entries(structure.selectorCounts)) {
    if (count > 0) console.log(`   ${sel}: ${count}개`);
  }
  console.log('\n5. 페이지 제목:', structure.title);
  console.log('\n6. 첫 상품 HTML (2000자):');
  console.log(structure.firstProductHTML);

  await context.close();
}

main().catch(e => { console.error(e); process.exit(1); });
