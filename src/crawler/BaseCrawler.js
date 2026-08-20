/**
 * BaseCrawler - Playwright 기반 크롤러 베이스 클래스
 * 원본: MrCrawler/mr-crawler/lib/crawler/BaseCrawler.ts
 *
 * 기능: 브라우저 초기화, 페이지 이동(재시도), 페이지네이션, 리소스 차단
 */
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(stealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/122.0.0.0 Safari/537.36',
];

const DEFAULT_OPTIONS = {
  maxPages: 10,
  delayBetweenPages: 2000,
  delayBetweenRequests: 1000,
  timeout: 30000,
  headless: false,       // headed 모드 기본 (봇 탐지 우회)
  retryCount: 3,
  retryDelay: 1000,
};

class BaseCrawler {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /** 브라우저 초기화 (Stealth + Anti-detection) */
  async init() {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.context = await this.browser.newContext({
      userAgent,
      viewport: { width: 1280, height: 720 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    this.page = await this.context.newPage();

    // navigator.webdriver 제거 (봇 탐지 우회)
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 광고/트래커 차단
    await this.page.route('**/*', (route) => {
      const url = route.request().url();
      const blockedDomains = [
        'google-analytics.com',
        'googletagmanager.com',
        'facebook.net',
        'doubleclick.net',
      ];
      if (blockedDomains.some((domain) => url.includes(domain))) {
        route.abort();
      } else {
        route.continue();
      }
    });

    console.log('[BaseCrawler] 브라우저 초기화 완료 (Stealth Mode)');
  }

  /** 브라우저 종료 */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  /** 페이지 이동 (재시도 로직 포함) */
  async navigateTo(url, waitUntil = 'domcontentloaded') {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다');

    let lastError = null;
    for (let attempt = 0; attempt < this.options.retryCount; attempt++) {
      try {
        await this.page.goto(url, {
          waitUntil,
          timeout: this.options.timeout,
        });
        return;
      } catch (error) {
        lastError = error;
        console.warn(`[BaseCrawler] 페이지 이동 시도 ${attempt + 1}/${this.options.retryCount} 실패:`, error.message);
        if (attempt < this.options.retryCount - 1) {
          await this.delay(this.options.retryDelay * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  /** 요소 대기 */
  async waitForSelector(selector, timeout) {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다');
    await this.page.waitForSelector(selector, {
      timeout: timeout || this.options.timeout,
    });
  }

  /** 딜레이 */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 랜덤 딜레이 (봇 탐지 우회) */
  async randomDelay(min = 1000, max = 3000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.delay(ms);
  }

  /** HTML 가져오기 */
  async getPageContent() {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다');
    return await this.page.content();
  }

  /** 로그 출력 (하위 클래스에서 사용) */
  log(message) {
    const timestamp = new Date().toLocaleTimeString('ko-KR');
    console.log(`[${timestamp}] ${message}`);
  }
}

module.exports = { BaseCrawler, USER_AGENTS, DEFAULT_OPTIONS };
