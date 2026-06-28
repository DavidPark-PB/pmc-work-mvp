'use strict';
const { chromium } = require('playwright');

async function debug() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const url = 'https://www.ebay.com/sch/onmom_house/m.html?_nkw=&_armrs=1&_ipg=240&rt=nc&LH_BIN=1';
  console.log('페이지 로드 중...');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // 실제 HTML에서 상품 관련 클래스 추출
  const info = await page.evaluate(() => {
    const title = document.title;
    const h1 = document.querySelector('h1')?.textContent?.trim();
    
    // 다양한 셀렉터 시도
    const selectors = [
      '.s-item', '.srp-item', '.lvresult', 
      '[data-viewport]', '.item', '.result',
      'li.s-item', '.srp-results li'
    ];
    const found = {};
    selectors.forEach(s => { found[s] = document.querySelectorAll(s).length; });
    
    // body의 첫 1000자
    const bodySnippet = document.body?.innerHTML?.slice(0, 500);
    
    return { title, h1, found, bodySnippet };
  });

  console.log('title:', info.title);
  console.log('h1:', info.h1);
  console.log('셀렉터 결과:', JSON.stringify(info.found));
  console.log('body snippet:', info.bodySnippet?.slice(0, 300));

  await browser.close();
}

debug().catch(e => console.error('에러:', e.message));
