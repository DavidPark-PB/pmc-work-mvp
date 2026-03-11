import path from 'path';
import os from 'os';
import { chromium } from 'patchright';

const USER_DATA_DIR = path.join(os.homedir(), '.pmc-auto', 'chrome-profile');

async function main() {
  console.log('1. Patchright 브라우저 시작 (launchPersistentContext + chrome)...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('2. 쿠팡 메인페이지 접속...');
  try {
    await page.goto('https://www.coupang.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const title = await page.title();
    console.log('3. 페이지 제목:', title);

    const html = await page.content();
    console.log('4. HTML 길이:', html.length);

    if (html.includes('Access Denied')) {
      console.log('FAIL - Access Denied');
    } else {
      console.log('SUCCESS - 쿠팡 메인페이지 로딩됨!');

      // 검색도 시도
      console.log('\n5. 검색 페이지 시도...');
      await page.goto('https://www.coupang.com/np/search?q=포켓몬+카드&page=1', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const searchHtml = await page.content();
      console.log('6. 검색 HTML 길이:', searchHtml.length);
      if (searchHtml.includes('Access Denied')) {
        console.log('FAIL - 검색 Access Denied');
      } else {
        console.log('SUCCESS - 검색 페이지도 로딩됨!');
      }
    }
  } catch (e) {
    console.error('ERROR:', (e as Error).message);
  }

  await context.close();
  console.log('\ndone');
}

main().catch(e => { console.error(e); process.exit(1); });
