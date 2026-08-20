/**
 * CoupangCrawler - 쿠팡 상품 크롤러
 * 원본: MrCrawler/mr-crawler/workers/scraper.ts (ScraperWorker)
 *
 * 기능:
 *  - SEARCH: 키워드 검색 → 상품 리스트 수집 (이름, 가격, URL, 이미지)
 *  - DETAIL: 상품 상세 페이지 → 셀러, 이미지, 옵션, 상세 HTML 수집
 */
const fs = require('fs');
const { BaseCrawler } = require('./BaseCrawler');
const { randomDelay, humanScroll, humanMouseMove } = require('./utils/human-behavior');
const { parsePrice, cleanText, toAbsoluteUrl } = require('./utils/parsers');

class CoupangCrawler extends BaseCrawler {
  constructor(options = {}) {
    super({
      maxPages: 2,
      headless: false,
      ...options,
    });
  }

  /**
   * 키워드 검색 크롤링
   * @param {string} keyword - 검색어
   * @param {number} maxPages - 최대 페이지 수 (기본 2)
   * @returns {Array} 상품 리스트 [{name, price, url, image}]
   */
  async search(keyword, maxPages) {
    const pages = maxPages || this.options.maxPages;
    let allProducts = [];

    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const targetUrl = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${pageNum}`;
      this.log(`[검색] 페이지 ${pageNum}/${pages}: ${keyword}`);

      try {
        await this.navigateTo(targetUrl);
      } catch (e) {
        console.error(`페이지 ${pageNum} 이동 실패:`, e.message);
        continue;
      }

      await this.randomDelay(2000, 4000);

      // 자연스러운 스크롤 (상품 로딩 + 봇 탐지 우회)
      await humanScroll(this.page);

      const products = await this.page.evaluate(() => {
        // 신규 셀렉터 (해시 클래스) + 구형 셀렉터 폴백
        let items = document.querySelectorAll('#product-list > li');
        if (items.length === 0) {
          items = document.querySelectorAll('li.search-product');
        }

        const results = [];
        items.forEach((item) => {
          try {
            // 이름
            let name =
              item.querySelector('[class*="ProductUnit_productName"]')?.textContent?.trim() ||
              item.querySelector('.name')?.textContent?.trim();

            // 가격
            let priceText =
              item.querySelector('[class*="PriceArea_priceArea"]')?.textContent ||
              item.querySelector('.price-value')?.textContent;

            // URL
            let url = item.querySelector('a')?.getAttribute('href');

            // 이미지
            let image =
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
          } catch (e) { /* skip */ }
        });
        return results;
      });

      this.log(`[검색] 페이지 ${pageNum}: ${products.length}개 상품 발견`);
      allProducts = [...allProducts, ...products];
    }

    this.log(`[검색] 총 ${allProducts.length}개 상품 수집 완료`);

    if (allProducts.length === 0) {
      const html = await this.page.content();
      fs.writeFileSync('debug-coupang-search.html', html);
      this.log('[검색] 상품 0개 - debug-coupang-search.html 저장됨 (봇 탐지 또는 셀렉터 변경 의심)');
    }

    return allProducts;
  }

  /**
   * 상품 상세 페이지 크롤링
   * @param {string} url - 쿠팡 상품 URL
   * @returns {Object} {name, price, vendor, images, options, bodyHtml, url}
   */
  async scrapeDetail(url) {
    this.log(`[상세] ${url}`);

    try {
      await this.navigateTo(url);
    } catch (e) {
      console.error('상세 페이지 이동 실패:', e.message);
      throw e;
    }

    await this.randomDelay(2000, 5000);

    // 1. 셀러(판매자) 추출
    let vendor = 'Unknown';
    try {
      const vendorEl = this.page.locator('.seller-info a').first();
      if (await vendorEl.count() > 0) {
        vendor = await vendorEl.innerText();
      } else {
        const vendorEl2 = this.page.locator('.prod-sale-vendor a').first();
        if (await vendorEl2.count() > 0) {
          vendor = await vendorEl2.innerText();
        }
      }
      vendor = vendor.split('\n')[0].trim();
    } catch (e) { /* skip */ }

    // 2. 이미지 (고해상도)
    const images = [];
    try {
      const thumbImgs = this.page.locator('.product-image .twc-static img');
      const count = await thumbImgs.count();
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const src = await thumbImgs.nth(i).getAttribute('src');
          if (src) images.push(src.replace(/48x48ex/, '492x492ex'));
        }
      } else {
        const standardThumbs = this.page.locator('.prod-image__item img');
        const stdCount = await standardThumbs.count();
        for (let i = 0; i < stdCount; i++) {
          const src = await standardThumbs.nth(i).getAttribute('src');
          if (src) images.push(src.replace(/60x60ex/, '492x492ex'));
        }
      }
    } catch (e) { /* skip */ }

    if (images.length === 0) {
      try {
        const mainImg = await this.page.locator('.product-image img').first().getAttribute('src');
        if (mainImg) images.push(mainImg.startsWith('//') ? `https:${mainImg}` : mainImg);
      } catch (e) { /* skip */ }
    }

    // 3. 옵션 추출 (사이즈, 색상 등)
    const options = [];
    try {
      const optionSections = this.page.locator('.fashion-option section');
      const sectionCount = await optionSections.count();

      if (sectionCount > 0) {
        for (let i = 0; i < sectionCount; i++) {
          const section = optionSections.nth(i);
          let name = await section.locator('.twc-font-bold').first().innerText();
          name = name.split(':')[0].trim();

          const values = [];
          const selectItems = section.locator('.fashion-option-select__content li');
          if (await selectItems.count() > 0) {
            const itemCount = await selectItems.count();
            for (let j = 0; j < itemCount; j++) {
              values.push(await selectItems.nth(j).innerText());
            }
          } else {
            const buttons = section.locator('.fashion-option__button-list li');
            if (await buttons.count() > 0) {
              values.push('이미지 참조 / 쿠팡 확인');
            }
          }

          if (values.length > 0) {
            options.push({ name, values });
          }
        }
      } else {
        const stdOptions = this.page.locator('.prod-option .prod-option-item');
        const stdCount = await stdOptions.count();
        for (let i = 0; i < stdCount; i++) {
          const item = stdOptions.nth(i);
          let name = await item.locator('.prod-option__title').innerText();
          name = name.split(':')[0].trim();
          options.push({ name, values: ['쿠팡 확인'] });
        }
      }
    } catch (e) { /* skip */ }

    // 4. 상세 설명 HTML
    let bodyHtml = '';
    try {
      const selectors = ['.product-detail-content-inside', '.product-detail-content', '#productDetail'];
      for (const sel of selectors) {
        const el = this.page.locator(sel);
        if (await el.count() > 0) {
          bodyHtml = await el.first().innerHTML();
          break;
        }
      }
    } catch (e) { /* skip */ }

    // 5. 제목 + 가격
    let title = '';
    let price = 0;
    try {
      title = await this.page.locator('h1.product-title').innerText();
    } catch (e) { /* skip */ }
    try {
      const priceText = await this.page.locator('.final-price-amount').first().innerText();
      price = parseInt(priceText.replace(/[^0-9]/g, ''), 10);
    } catch (e) { /* skip */ }

    const result = { name: title, price, vendor, images, options, bodyHtml, url };
    this.log(`[상세] ${title.substring(0, 30)}... (${price.toLocaleString()}원)`);
    return result;
  }
}

module.exports = { CoupangCrawler };
