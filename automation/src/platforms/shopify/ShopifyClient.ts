/**
 * Shopify REST Admin API 클라이언트
 *
 * zipzip_mvp의 shopifyAPI.js에서 포팅 + createProduct 추가.
 */
import axios, { type AxiosInstance } from 'axios';
import { eq, and } from 'drizzle-orm';
import { env } from '../../lib/config.js';
import { db } from '../../db/index.js';
import { categoryCache } from '../../db/schema.js';
import type { PlatformAdapter, ListingInput, ListingResult } from '../index.js';

export class ShopifyClient implements PlatformAdapter {
  readonly platform = 'shopify';

  private client: AxiosInstance;
  private baseUrl: string;
  private graphqlUrl: string;
  private accessToken: string;

  constructor() {
    const storeUrl = env.SHOPIFY_STORE_URL;
    const accessToken = env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = env.SHOPIFY_API_VERSION || '2024-01';

    if (!storeUrl || !accessToken) {
      throw new Error('SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN 환경변수가 필요합니다');
    }

    this.accessToken = accessToken;
    this.baseUrl = `https://${storeUrl}/admin/api/${apiVersion}`;
    this.graphqlUrl = `https://${storeUrl}/admin/api/${apiVersion}/graphql.json`;
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  // ─── GraphQL 호출 ────────────────────────────────────────

  private async callGraphQL(query: string, variables?: Record<string, any>): Promise<any> {
    const response = await axios.post(this.graphqlUrl, { query, variables }, {
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    return response.data;
  }

  // ─── 카테고리 매핑 ──────────────────────────────────────

  /**
   * 키워드로 Shopify 표준 카테고리 ID 조회
   * GraphQL taxonomy.categories 검색 → category_cache 캐싱
   */
  async suggestCategoryId(keyword: string): Promise<string | null> {
    if (!keyword) return null;
    const cacheKey = keyword.toLowerCase().trim();

    // 1. DB 캐시 확인 (30일 TTL)
    try {
      const cached = await db.query.categoryCache.findFirst({
        where: and(
          eq(categoryCache.platform, 'shopify'),
          eq(categoryCache.keyword, cacheKey),
        ),
      });
      if (cached) {
        const age = Date.now() - new Date(cached.cachedAt).getTime();
        if (age < 30 * 24 * 60 * 60 * 1000) {
          return cached.categoryId;
        }
      }
    } catch { /* 캐시 실패는 무시 */ }

    // 2. GraphQL로 카테고리 검색 (원본 → 단순화 키워드 순서로 시도)
    const searchVariants = this.buildSearchVariants(keyword);

    for (const searchTerm of searchVariants) {
      const result = await this.searchCategory(searchTerm);
      if (result) {
        // 캐시는 원본 키워드로 저장 (같은 키워드 재검색 방지)
        try {
          await db.insert(categoryCache).values({
            platform: 'shopify',
            keyword: cacheKey,
            categoryId: result.id,
            categoryName: result.fullName,
          }).onConflictDoUpdate({
            target: [categoryCache.platform, categoryCache.keyword],
            set: { categoryId: result.id, categoryName: result.fullName, cachedAt: new Date() },
          });
        } catch { /* 캐시 저장 실패 무시 */ }

        console.log(`[Shopify] 카테고리 매핑: "${keyword}" → ${result.fullName} (${result.id})${searchTerm !== keyword ? ` [검색어: "${searchTerm}"]` : ''}`);
        return result.id;
      }
    }

    console.warn(`[Shopify] 카테고리 매핑 실패: "${keyword}" — 모든 변형 시도 후 결과 없음`);
    return null;
  }

  /**
   * 키워드에서 검색 변형을 생성 (구체적 → 일반적 순서)
   *
   * Shopify taxonomy 검색은 정확한 카테고리명 매칭이 필요하므로:
   * 1. 원본 키워드 그대로
   * 2. 뒤에서 단어 줄이기 (최소 2단어)
   * 3. 도메인별 키워드 별칭 (우리 주력 상품에 맞춤)
   *
   * 단어 단독 검색은 오매칭이 심해서 제외 (Card→Cardio, Box→Boxers 등)
   */
  private buildSearchVariants(keyword: string): string[] {
    const variants: string[] = [keyword];

    // 도메인 별칭을 먼저 시도 (오매칭 방지 — 단어 줄이기보다 정확)
    const kw = keyword.toLowerCase();
    const aliases = this.getDomainAliases(kw);
    for (const alias of aliases) {
      if (!variants.includes(alias)) variants.push(alias);
    }

    // 뒤에서부터 단어를 하나씩 줄여가며 시도 (최소 2단어)
    const words = keyword.split(/\s+/).filter(Boolean);
    if (words.length > 2) {
      for (let i = words.length - 1; i >= 2; i--) {
        const shorter = words.slice(0, i).join(' ');
        if (!variants.includes(shorter)) variants.push(shorter);
      }
    }

    return variants;
  }

  /**
   * 상품 키워드를 Shopify taxonomy에 매칭되는 검색어로 변환
   * 우리 주력 상품: 트레이딩 카드, K-Pop 앨범, 장난감, 뷰티 등
   */
  private getDomainAliases(keyword: string): string[] {
    const aliases: string[] = [];

    // 카드/TCG 관련
    if (/card|tcg|pokemon|yugioh|digimon|one piece|weiss/i.test(keyword)) {
      aliases.push('Collectible Card Game', 'Trading Cards');
    }
    // 음악/앨범 관련
    if (/album|k-?pop|bts|blackpink|twice|stray|aespa|music|cd\b/i.test(keyword)) {
      aliases.push('Music Recording', 'Music');
    }
    // 피규어/장난감
    if (/figure|toy|plush|doll|lego|gundam|model kit/i.test(keyword)) {
      aliases.push('Toys');
    }
    // 뷰티/화장품
    if (/beauty|skincare|cosmetic|serum|mask|cream|makeup/i.test(keyword)) {
      aliases.push('Skin Care Products');
    }
    // 전자제품
    if (/electronic|gadget|device|phone|tablet|headphone/i.test(keyword)) {
      aliases.push('Electronics');
    }
    // 식품/스낵
    if (/snack|ramen|noodle|food|candy|chocolate|tea|coffee/i.test(keyword)) {
      aliases.push('Food Items');
    }

    return aliases;
  }

  /** GraphQL taxonomy 단일 검색 */
  private async searchCategory(searchTerm: string): Promise<{ id: string; fullName: string } | null> {
    try {
      const result = await this.callGraphQL(`
        query($search: String!) {
          taxonomy {
            categories(first: 1, search: $search) {
              edges {
                node {
                  id
                  name
                  fullName
                  isLeaf
                }
              }
            }
          }
        }
      `, { search: searchTerm });

      const categories = result.data?.taxonomy?.categories?.edges;
      if (!categories || categories.length === 0) return null;

      const cat = categories[0].node;
      return { id: cat.id, fullName: cat.fullName || cat.name };
    } catch (e) {
      console.warn(`[Shopify] 카테고리 검색 실패 (${searchTerm}):`, (e as Error).message);
      return null;
    }
  }

  /**
   * 생성된 상품에 표준 카테고리 설정 (GraphQL productUpdate)
   */
  private async setProductCategory(productGid: string, categoryGid: string): Promise<void> {
    try {
      await this.callGraphQL(`
        mutation($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id }
            userErrors { field message }
          }
        }
      `, {
        input: {
          id: productGid,
          category: categoryGid,
        },
      });
    } catch (e) {
      console.warn(`[Shopify] 카테고리 설정 실패:`, (e as Error).message);
    }
  }

  // ─── PlatformAdapter 구현 ─────────────────────────────────

  private async postWithRetry(url: string, data: any, maxRetries = 3): Promise<any> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.post(url, data);
      } catch (e: any) {
        if (e?.response?.status === 429 && attempt < maxRetries) {
          const retryAfter = parseFloat(e.response.headers['retry-after'] || '2');
          const waitMs = Math.ceil(retryAfter * 1000) * (attempt + 1);
          console.warn(`[Shopify] 429 Rate Limit — ${waitMs}ms 대기 후 재시도 (${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          throw e;
        }
      }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/products/count.json');
      console.log(`Shopify 연결 성공: ${response.data.count}개 상품`);
      return true;
    } catch (e) {
      console.error('Shopify 연결 실패:', (e as Error).message);
      return false;
    }
  }

  async createListing(input: ListingInput): Promise<ListingResult> {
    const productData = {
      product: {
        title: input.title,
        body_html: input.description,
        vendor: input.brand || '',
        product_type: input.productType || '',
        tags: [],
        variants: [
          {
            price: input.price.toFixed(2),
            sku: input.sku,
            inventory_quantity: input.quantity,
            weight: input.weight || 0,
            weight_unit: 'g',
            requires_shipping: true,
          },
        ],
        images: input.imageUrls.map(url => ({ src: url })),
      },
    };

    const response = await this.postWithRetry('/products.json', productData);
    const product = response.data.product;

    // 생성 후 표준 카테고리 설정 (GraphQL)
    const categoryKeyword = input.productType || input.title;
    const categoryGid = await this.suggestCategoryId(categoryKeyword);
    if (categoryGid) {
      await this.setProductCategory(`gid://shopify/Product/${product.id}`, categoryGid);
    }

    return {
      itemId: String(product.id),
      url: `https://${env.SHOPIFY_STORE_URL}/products/${product.handle}`,
    };
  }

  async updateListing(itemId: string, updates: Partial<ListingInput>): Promise<void> {
    const productData: Record<string, any> = {};

    if (updates.title) productData.title = updates.title;
    if (updates.description) productData.body_html = updates.description;
    if (updates.brand) productData.vendor = updates.brand;

    if (updates.price !== undefined || updates.quantity !== undefined) {
      // 기존 상품 정보를 가져와서 variant 업데이트
      const existing = await this.client.get(`/products/${itemId}.json`);
      const variantId = existing.data.product.variants[0]?.id;
      if (variantId) {
        const variantData: Record<string, any> = {};
        if (updates.price !== undefined) variantData.price = updates.price.toFixed(2);
        if (updates.quantity !== undefined) variantData.inventory_quantity = updates.quantity;
        await this.client.put(`/variants/${variantId}.json`, { variant: variantData });
      }
    }

    if (Object.keys(productData).length > 0) {
      await this.client.put(`/products/${itemId}.json`, { product: productData });
    }
  }

  async deleteListing(itemId: string): Promise<void> {
    await this.client.delete(`/products/${itemId}.json`);
  }

  async updateInventory(itemId: string, price: number, quantity: number): Promise<void> {
    const existing = await this.client.get(`/products/${itemId}.json`);
    const variantId = existing.data.product.variants[0]?.id;
    if (variantId) {
      await this.client.put(`/variants/${variantId}.json`, {
        variant: {
          price: price.toFixed(2),
          inventory_quantity: quantity,
        },
      });
    }
  }

  // ─── 추가 메서드 ──────────────────────────────────────────

  /** 단일 상품 조회 */
  async getProduct(productId: string): Promise<any> {
    const response = await this.client.get(`/products/${productId}.json`);
    return response.data.product;
  }

  /** 모든 상품 조회 (페이지네이션) */
  async getAllProducts(): Promise<any[]> {
    let allProducts: any[] = [];
    let url = '/products.json?limit=250';

    while (url) {
      const response = await this.client.get(url);
      allProducts = allProducts.concat(response.data.products);

      // Link 헤더에서 다음 페이지 URL 추출
      const linkHeader = response.headers.link;
      url = this.getNextPageUrl(linkHeader) || '';

      if (url) await new Promise(r => setTimeout(r, 500));
    }

    return allProducts;
  }

  private getNextPageUrl(linkHeader: string | undefined): string | null {
    if (!linkHeader) return null;
    const links = linkHeader.split(',');
    for (const link of links) {
      if (link.includes('rel="next"')) {
        const match = link.match(/<([^>]+)>/);
        return match ? match[1] : null;
      }
    }
    return null;
  }
}
