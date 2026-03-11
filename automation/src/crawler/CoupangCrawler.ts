/**
 * CoupangCrawler - 쿠팡 상품 크롤러
 *
 * 기능:
 *  - search: 키워드 검색 → 상품 리스트 수집
 *  - scrapeDetail: 상품 상세 페이지 → 셀러, 이미지, 옵션, 상세 HTML 수집
 *  - DB 연동: crawl_results 테이블에 자동 저장
 */
import fs from 'fs';
import { eq, and } from 'drizzle-orm';
import { BaseCrawler, type CrawlerOptions } from './BaseCrawler.js';
import { humanScroll } from './utils/human-behavior.js';
import { db } from '../db/index.js';
import { crawlResults, crawlSources } from '../db/schema.js';

export interface SearchProduct {
  name: string;
  price: number;
  url: string;
  image: string;
}

export interface DetailProduct {
  name: string;
  price: number;
  vendor: string;
  images: string[];
  options: { name: string; values: string[] }[];
  bodyHtml: string;
  url: string;
}

export class CoupangCrawler extends BaseCrawler {
  private sourceId: number | null = null;

  constructor(options: Partial<CrawlerOptions> = {}) {
    super({
      maxPages: 2,
      ...options,
    });
  }

  /** crawl_sources에서 쿠팡 소스 ID를 가져오거나 생성 */
  private async ensureSourceId(): Promise<number> {
    if (this.sourceId) return this.sourceId;

    const existing = await db.query.crawlSources.findFirst({
      where: eq(crawlSources.crawlerType, 'coupang'),
    });

    if (existing) {
      this.sourceId = existing.id;
      return existing.id;
    }

    const [inserted] = await db.insert(crawlSources).values({
      name: '쿠팡',
      baseUrl: 'https://www.coupang.com',
      crawlerType: 'coupang',
      config: {},
      isActive: true,
    }).returning();

    this.sourceId = inserted.id;
    return inserted.id;
  }

  /** 크롤 결과를 DB에 저장 (upsert by externalId) */
  private async saveToDb(product: SearchProduct | DetailProduct, externalId: string): Promise<void> {
    const sourceId = await this.ensureSourceId();

    const existing = await db.query.crawlResults.findFirst({
      where: and(
        eq(crawlResults.sourceId, sourceId),
        eq(crawlResults.externalId, externalId),
      ),
    });

    const isDetail = 'vendor' in product;
    const rawData = isDetail
      ? { vendor: (product as DetailProduct).vendor, images: (product as DetailProduct).images, options: (product as DetailProduct).options, bodyHtml: (product as DetailProduct).bodyHtml }
      : {};

    if (existing) {
      // 업데이트
      await db.update(crawlResults)
        .set({
          title: product.name,
          price: String(product.price),
          url: product.url,
          imageUrl: isDetail ? (product as DetailProduct).images[0] || null : (product as SearchProduct).image || null,
          rawData,
          crawledAt: new Date(),
        })
        .where(eq(crawlResults.id, existing.id));
    } else {
      // 신규 INSERT
      await db.insert(crawlResults).values({
        sourceId,
        externalId,
        title: product.name,
        price: String(product.price),
        currency: 'KRW',
        url: product.url,
        imageUrl: isDetail ? (product as DetailProduct).images[0] || null : (product as SearchProduct).image || null,
        rawData,
        status: 'new',
      });
    }
  }

  /** URL에서 쿠팡 상품 ID 추출 */
  private extractProductId(url: string): string {
    const match = url.match(/products\/(\d+)/);
    return match ? match[1] : url;
  }

  /**
   * 키워드 검색 크롤링
   */
  async search(keyword: string, maxPages?: number): Promise<SearchProduct[]> {
    const pages = maxPages || this.options.maxPages;
    let allProducts: SearchProduct[] = [];

    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      const targetUrl = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&page=${pageNum}`;
      this.log(`[검색] 페이지 ${pageNum}/${pages}: ${keyword}`);

      try {
        await this.navigateTo(targetUrl);
      } catch (e) {
        console.error(`페이지 ${pageNum} 이동 실패:`, (e as Error).message);
        continue;
      }

      await this.randomDelay(2000, 4000);
      await humanScroll(this.page!);

      const products: SearchProduct[] = await this.page!.evaluate(() => {
        let items = document.querySelectorAll('#product-list > li');
        if (items.length === 0) {
          items = document.querySelectorAll('li.search-product');
        }

        const results: { name: string; price: number; url: string; image: string }[] = [];
        items.forEach((item: Element) => {
          try {
            const name =
              item.querySelector('[class*="ProductUnit_productName"]')?.textContent?.trim() ||
              item.querySelector('.name')?.textContent?.trim();

            const priceText =
              item.querySelector('[class*="PriceArea_priceArea"]')?.textContent ||
              item.querySelector('.price-value')?.textContent;

            let url = item.querySelector('a')?.getAttribute('href');

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

      this.log(`[검색] 페이지 ${pageNum}: ${products.length}개 상품 발견`);
      allProducts = [...allProducts, ...products];
    }

    this.log(`[검색] 총 ${allProducts.length}개 상품 수집 완료`);

    if (allProducts.length === 0) {
      const html = await this.page!.content();
      fs.writeFileSync('debug-coupang-search.html', html);
      this.log('[검색] 상품 0개 - debug-coupang-search.html 저장됨');
    }

    // DB 저장
    let savedCount = 0;
    for (const product of allProducts) {
      try {
        const externalId = this.extractProductId(product.url);
        await this.saveToDb(product, externalId);
        savedCount++;
      } catch (e) {
        console.error(`DB 저장 실패: ${product.name.substring(0, 30)}`, (e as Error).message);
      }
    }
    this.log(`[검색] DB 저장: ${savedCount}/${allProducts.length}개`);

    return allProducts;
  }

  /**
   * 상품 상세 페이지 크롤링
   */
  async scrapeDetail(url: string): Promise<DetailProduct> {
    this.log(`[상세] ${url}`);

    try {
      await this.navigateTo(url);
    } catch (e) {
      console.error('상세 페이지 이동 실패:', (e as Error).message);
      throw e;
    }

    await this.randomDelay(2000, 5000);

    // 1. 셀러(판매자) 추출
    let vendor = 'Unknown';
    try {
      const vendorEl = this.page!.locator('.seller-info a').first();
      if (await vendorEl.count() > 0) {
        vendor = await vendorEl.innerText();
      } else {
        const vendorEl2 = this.page!.locator('.prod-sale-vendor a').first();
        if (await vendorEl2.count() > 0) {
          vendor = await vendorEl2.innerText();
        }
      }
      vendor = vendor.split('\n')[0].trim();
    } catch { /* skip */ }

    // 2. 이미지 (고해상도)
    const images: string[] = [];
    try {
      const thumbImgs = this.page!.locator('.product-image .twc-static img');
      const count = await thumbImgs.count();
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const src = await thumbImgs.nth(i).getAttribute('src');
          if (src) images.push(src.replace(/48x48ex/, '492x492ex'));
        }
      } else {
        const standardThumbs = this.page!.locator('.prod-image__item img');
        const stdCount = await standardThumbs.count();
        for (let i = 0; i < stdCount; i++) {
          const src = await standardThumbs.nth(i).getAttribute('src');
          if (src) images.push(src.replace(/60x60ex/, '492x492ex'));
        }
      }
    } catch { /* skip */ }

    if (images.length === 0) {
      try {
        const mainImg = await this.page!.locator('.product-image img').first().getAttribute('src');
        if (mainImg) images.push(mainImg.startsWith('//') ? `https:${mainImg}` : mainImg);
      } catch { /* skip */ }
    }

    // 3. 옵션 추출 (사이즈, 색상 등)
    const options: { name: string; values: string[] }[] = [];
    try {
      const optionSections = this.page!.locator('.fashion-option section');
      const sectionCount = await optionSections.count();

      if (sectionCount > 0) {
        for (let i = 0; i < sectionCount; i++) {
          const section = optionSections.nth(i);
          let name = await section.locator('.twc-font-bold').first().innerText();
          name = name.split(':')[0].trim();

          const values: string[] = [];
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
        const stdOptions = this.page!.locator('.prod-option .prod-option-item');
        const stdCount = await stdOptions.count();
        for (let i = 0; i < stdCount; i++) {
          const item = stdOptions.nth(i);
          let name = await item.locator('.prod-option__title').innerText();
          name = name.split(':')[0].trim();
          options.push({ name, values: ['쿠팡 확인'] });
        }
      }
    } catch { /* skip */ }

    // 4. 상세 설명 HTML
    let bodyHtml = '';
    try {
      const selectors = ['.product-detail-content-inside', '.product-detail-content', '#productDetail'];
      for (const sel of selectors) {
        const el = this.page!.locator(sel);
        if (await el.count() > 0) {
          bodyHtml = await el.first().innerHTML();
          break;
        }
      }
    } catch { /* skip */ }

    // 5. 제목 + 가격
    let title = '';
    let price = 0;
    try {
      title = await this.page!.locator('h1.product-title').innerText();
    } catch { /* skip */ }
    try {
      const priceText = await this.page!.locator('.final-price-amount').first().innerText();
      price = parseInt(priceText.replace(/[^0-9]/g, ''), 10);
    } catch { /* skip */ }

    const result: DetailProduct = { name: title, price, vendor, images, options, bodyHtml, url };
    this.log(`[상세] ${title.substring(0, 30)}... (${price.toLocaleString()}원)`);

    // DB 저장
    try {
      const externalId = this.extractProductId(url);
      await this.saveToDb(result, externalId);
      this.log(`[상세] DB 저장 완료 (externalId: ${externalId})`);
    } catch (e) {
      console.error(`[상세] DB 저장 실패:`, (e as Error).message);
    }

    return result;
  }
}
