'use strict';

/**
 * eBay Seller Listing Scraper
 *
 * 수집 방법 (우선순위):
 *   1. ScraperAPI (SCRAPER_API_KEY 있을 때) — Cloudflare 우회, 월 5000 크레딧 무료
 *   2. Playwright-Extra Stealth (fallback)
 *
 * ScraperAPI 가입: https://www.scraperapi.com (무료 5000크레딧/월)
 * .env에 SCRAPER_API_KEY=your_key 추가하면 자동 활성화
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const axios = require('axios');
const cheerio = require('cheerio');

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const ITEMS_PER_PAGE = 240;

/**
 * ScraperAPI를 통해 URL HTML 수집
 */
async function fetchViaScraperAPI(url) {
  const apiUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=false`;
  const resp = await axios.get(apiUrl, { timeout: 30000 });
  return resp.data;
}

/**
 * Playwright-Extra Stealth fallback
 */
async function fetchViaPlaywright(url) {
  const { chromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  // 이미 등록돼 있을 수 있으니 try-catch
  try { chromium.use(StealthPlugin()); } catch (_) {}

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2}', r => r.abort()).catch(() => {});

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('.s-item__title', { timeout: 12000 }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * HTML → 상품 목록 파싱 (cheerio)
 */
function parseListings(html, sellerName) {
  const $ = cheerio.load(html);
  const items = [];

  $('.s-item').each(function () {
    const title = $(this).find('.s-item__title').text().trim();
    if (!title || title === 'Shop on eBay') return;

    const href = $(this).find('a.s-item__link').attr('href') || '';
    const itemId = href.match(/\/(\d{10,})/)?.[1] || '';
    if (!itemId) return;

    const priceText = $(this).find('.s-item__price').text().trim();
    const pm = priceText.match(/[\d,]+\.?\d*/);
    const price = pm ? parseFloat(pm[0].replace(/,/g, '')) : 0;

    const shipText = $(this).find('.s-item__shipping, .s-item__freeXDays').text().trim();
    const sm = shipText.match(/[\d,]+\.?\d*/);
    const shipping = sm ? parseFloat(sm[0].replace(/,/g, '')) : 0;

    const img = $(this).find('.s-item__image-img').attr('src') || '';

    items.push({
      itemId,
      title,
      price,
      shipping,
      url: href.split('?')[0],
      imageUrl: img,
      seller: sellerName,
    });
  });

  return items;
}

/**
 * 단일 셀러 전체 리스팅 수집
 * @param {string} sellerName - eBay seller username
 * @param {number} maxPages   - 최대 페이지 수 (기본 5 = 최대 1200개)
 */
async function scrapeSellerListings(sellerName, maxPages = 5) {
  const allItems = [];
  const seenIds = new Set();
  const useScraperAPI = !!SCRAPER_API_KEY;

  console.log(`[Scraper] ${sellerName}: ${useScraperAPI ? 'ScraperAPI' : 'Playwright'} 사용`);

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const url = `https://www.ebay.com/sch/${sellerName}/m.html` +
      `?_nkw=&_armrs=1&_ipg=${ITEMS_PER_PAGE}&_pgn=${pageNum}&rt=nc&LH_BIN=1`;

    let html = '';
    try {
      html = useScraperAPI
        ? await fetchViaScraperAPI(url)
        : await fetchViaPlaywright(url);
    } catch (e) {
      console.warn(`[Scraper] ${sellerName} p${pageNum} 실패:`, e.message?.slice(0, 60));
      break;
    }

    const pageItems = parseListings(html, sellerName);

    for (const item of pageItems) {
      if (!seenIds.has(item.itemId)) {
        seenIds.add(item.itemId);
        allItems.push(item);
      }
    }

    console.log(`[Scraper] ${sellerName} p${pageNum}: ${pageItems.length}개 (누적 ${allItems.length})`);

    if (pageItems.length < 10) break;

    await new Promise(r => setTimeout(r, useScraperAPI ? 500 : 1200));
  }

  console.log(`[Scraper] ${sellerName}: 총 ${allItems.length}개`);
  return allItems;
}

module.exports = { scrapeSellerListings };
