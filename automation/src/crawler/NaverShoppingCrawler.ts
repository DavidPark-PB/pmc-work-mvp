/**
 * NaverShoppingCrawler - 네이버 쇼핑 검색 API 기반 크롤러
 *
 * 네이버 쇼핑은 CAPTCHA로 브라우저 크롤링을 차단하므로
 * 공식 Open API (https://openapi.naver.com/v1/search/shop) 사용.
 * 일일 25,000건 호출 가능.
 */
import axios from 'axios';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, crawlSources } from '../db/schema.js';
import { env } from '../lib/config.js';

interface NaverShopItem {
  title: string;
  link: string;
  image: string;
  lprice: string;
  hprice: string;
  mallName: string;
  productId: string;
  productType: string;
  brand: string;
  maker: string;
  category1: string;
  category2: string;
  category3: string;
  category4: string;
}

interface NaverShopResponse {
  lastBuildDate: string;
  total: number;
  start: number;
  display: number;
  items: NaverShopItem[];
}

export interface SearchProduct {
  name: string;
  price: number;
  url: string;
  image: string;
  mallName: string;
  brand: string;
  maker: string;
  category: string;
  productId: string;
}

export class NaverShoppingCrawler {
  private sourceId: number | null = null;
  private clientId: string;
  private clientSecret: string;

  constructor() {
    if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
      throw new Error('NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 환경변수가 필요합니다');
    }
    this.clientId = env.NAVER_CLIENT_ID;
    this.clientSecret = env.NAVER_CLIENT_SECRET;
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString('ko-KR');
    console.log(`[${timestamp}] ${message}`);
  }

  /** crawl_sources에서 네이버쇼핑 소스 ID를 가져오거나 생성 */
  private async ensureSourceId(): Promise<number> {
    if (this.sourceId) return this.sourceId;

    const existing = await db.query.crawlSources.findFirst({
      where: eq(crawlSources.crawlerType, 'naver_shopping'),
    });

    if (existing) {
      this.sourceId = existing.id;
      return existing.id;
    }

    const [inserted] = await db.insert(crawlSources).values({
      name: '네이버 쇼핑',
      baseUrl: 'https://search.shopping.naver.com',
      crawlerType: 'naver_shopping',
      config: {},
      isActive: true,
    }).returning();

    this.sourceId = inserted.id;
    return inserted.id;
  }

  /** 크롤 결과를 DB에 저장 (upsert by externalId) */
  private async saveToDb(product: SearchProduct): Promise<void> {
    const sourceId = await this.ensureSourceId();

    const existing = await db.query.crawlResults.findFirst({
      where: and(
        eq(crawlResults.sourceId, sourceId),
        eq(crawlResults.externalId, product.productId),
      ),
    });

    const rawData = {
      mallName: product.mallName,
      brand: product.brand,
      maker: product.maker,
      category: product.category,
    };

    if (existing) {
      await db.update(crawlResults)
        .set({
          title: product.name,
          price: String(product.price),
          url: product.url,
          imageUrl: product.image || null,
          rawData,
          crawledAt: new Date(),
        })
        .where(eq(crawlResults.id, existing.id));
    } else {
      await db.insert(crawlResults).values({
        sourceId,
        externalId: product.productId,
        title: product.name,
        price: String(product.price),
        currency: 'KRW',
        url: product.url,
        imageUrl: product.image || null,
        rawData,
        status: 'new',
      });
    }
  }

  /** HTML 태그 제거 (네이버 API는 title에 <b> 태그 포함) */
  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '');
  }

  /**
   * 키워드 검색
   * @param keyword 검색어
   * @param maxItems 최대 상품 수 (기본 100, 최대 1000)
   * @param sort 정렬: sim(유사도), date(날짜), asc(가격↑), dsc(가격↓)
   */
  async search(keyword: string, maxItems = 100, sort = 'sim'): Promise<SearchProduct[]> {
    const allProducts: SearchProduct[] = [];
    const displayPerPage = Math.min(maxItems, 100); // API 최대 100개/요청
    const totalPages = Math.ceil(maxItems / displayPerPage);

    for (let page = 0; page < totalPages; page++) {
      const start = page * displayPerPage + 1;
      if (start > 1000) break; // API 제한: start <= 1000

      this.log(`[네이버] 검색 "${keyword}" (start=${start}, display=${displayPerPage})`);

      try {
        const response = await axios.get<NaverShopResponse>(
          'https://openapi.naver.com/v1/search/shop.json',
          {
            params: {
              query: keyword,
              display: displayPerPage,
              start,
              sort,
            },
            headers: {
              'X-Naver-Client-Id': this.clientId,
              'X-Naver-Client-Secret': this.clientSecret,
            },
          },
        );

        const { items, total } = response.data;
        this.log(`[네이버] ${items.length}개 수신 (전체 ${total.toLocaleString()}개)`);

        for (const item of items) {
          allProducts.push({
            name: this.stripHtml(item.title),
            price: parseInt(item.lprice, 10) || 0,
            url: item.link,
            image: item.image,
            mallName: item.mallName,
            brand: item.brand,
            maker: item.maker,
            category: [item.category1, item.category2, item.category3, item.category4]
              .filter(Boolean)
              .join(' > '),
            productId: item.productId,
          });
        }

        // 더 이상 결과가 없으면 중단
        if (items.length < displayPerPage || start + displayPerPage > total) break;

      } catch (e) {
        const err = e as any;
        if (err.response) {
          console.error(`[네이버] API 에러 ${err.response.status}:`, err.response.data);
        } else {
          console.error(`[네이버] 요청 실패:`, (e as Error).message);
        }
        break;
      }
    }

    this.log(`[네이버] 총 ${allProducts.length}개 상품 수집 완료`);

    // DB 저장
    let savedCount = 0;
    for (const product of allProducts) {
      try {
        await this.saveToDb(product);
        savedCount++;
      } catch (e) {
        console.error(`DB 저장 실패: ${product.name.substring(0, 30)}`, (e as Error).message);
      }
    }
    this.log(`[네이버] DB 저장: ${savedCount}/${allProducts.length}개`);

    return allProducts;
  }
}
