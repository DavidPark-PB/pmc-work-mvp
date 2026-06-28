'use strict';
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

async function debug() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort()).catch(() => {});

  const url = 'https://www.ebay.com/sch/onmom_house/m.html?_nkw=&_armrs=1&_ipg=240&rt=nc&LH_BIN=1';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));

  // 상품 관련 가능한 셀렉터 모두 체크
  const found = await page.evaluate(() => {
    const sels = [
      'li[id^="item"]', 'li[data-itemid]', 'div[data-itemid]',
      '[data-pl-id]', '[data-view]', 'li.sresult',
      '.srp-river-answer li', '.srp-results li',
      'ul.srp-results li', '.lvresult',
      'div[data-gtm-pd]', '[itemprop="itemListElement"]',
      '.s-item', '.s-item__wrapper',
    ];
    const r = {};
    sels.forEach(s => { r[s] = document.querySelectorAll(s).length; });
    
    // 가격이 있는 요소 찾기
    const priceEls = document.querySelectorAll('[class*="price"]');
    r['price-elements'] = priceEls.length;
    if (priceEls.length > 0) {
      r['first-price-class'] = priceEls[0]?.className;
      r['first-price-text'] = priceEls[0]?.textContent?.trim()?.slice(0, 30);
    }
    
    // 링크 패턴
    const ebayLinks = [...document.querySelectorAll('a[href*="/itm/"]')];
    r['itm-links'] = ebayLinks.length;
    if (ebayLinks.length > 0) {
      r['first-link-parent-class'] = ebayLinks[0]?.parentElement?.className?.slice(0, 50);
    }
    
    return r;
  });
  
  console.log(JSON.stringify(found, null, 2));
  await browser.close();
}

debug().catch(e => console.error('에러:', e.message));
