/**
 * BaseCrawler - Patchright 기반 크롤러 베이스 클래스
 *
 * Patchright = Playwright 패치 버전 (CDP 리크 수정, Akamai 우회)
 * 주의: addInitScript, page.route, 커스텀 UA 등 런타임 패치 사용 금지
 *       → Patchright 자체 패치와 충돌하여 오히려 탐지됨
 */
import path from 'path';
import os from 'os';
import { chromium } from 'patchright';
import type { BrowserContext, Page } from 'patchright';

export interface CrawlerOptions {
  maxPages: number;
  delayBetweenPages: number;
  delayBetweenRequests: number;
  timeout: number;
  retryCount: number;
  retryDelay: number;
}

const DEFAULT_OPTIONS: CrawlerOptions = {
  maxPages: 10,
  delayBetweenPages: 2000,
  delayBetweenRequests: 1000,
  timeout: 30000,
  retryCount: 3,
  retryDelay: 1000,
};

const USER_DATA_DIR = path.join(os.homedir(), '.pmc-auto', 'chrome-profile');

export class BaseCrawler {
  protected options: CrawlerOptions;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;

  constructor(options: Partial<CrawlerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 브라우저 초기화 — Patchright 권장 방식 (launchPersistentContext) */
  async init(): Promise<void> {
    this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.log('브라우저 초기화 완료 (Patchright)');
  }

  /** 브라우저 종료 */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }

  /** 페이지 이동 (재시도 로직 포함) */
  async navigateTo(url: string, waitUntil: 'domcontentloaded' | 'load' | 'networkidle' = 'domcontentloaded'): Promise<void> {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다');

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.retryCount; attempt++) {
      try {
        await this.page.goto(url, {
          waitUntil,
          timeout: this.options.timeout,
        });
        return;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[BaseCrawler] 페이지 이동 시도 ${attempt + 1}/${this.options.retryCount} 실패:`, lastError.message);
        if (attempt < this.options.retryCount - 1) {
          await this.delay(this.options.retryDelay * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  /** 요소 대기 */
  async waitForSelector(selector: string, timeout?: number): Promise<void> {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다');
    await this.page.waitForSelector(selector, {
      timeout: timeout || this.options.timeout,
    });
  }

  /** 딜레이 */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 랜덤 딜레이 (봇 탐지 우회) */
  async randomDelay(min = 1000, max = 3000): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await this.delay(ms);
  }

  /** HTML 가져오기 */
  async getPageContent(): Promise<string> {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다');
    return await this.page.content();
  }

  /** 로그 출력 */
  protected log(message: string): void {
    const timestamp = new Date().toLocaleTimeString('ko-KR');
    console.log(`[${timestamp}] ${message}`);
  }
}
