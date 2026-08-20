/**
 * Shopify REST Admin API 클라이언트
 *
 * zipzip_mvp의 shopifyAPI.js에서 포팅 + createProduct 추가.
 */
import axios, { type AxiosInstance } from 'axios';
import { env } from '../../lib/config.js';
import type { PlatformAdapter, ListingInput, ListingResult } from '../index.js';

export class ShopifyClient implements PlatformAdapter {
  readonly platform = 'shopify';

  private client: AxiosInstance;
  private baseUrl: string;

  constructor() {
    const storeUrl = env.SHOPIFY_STORE_URL;
    const accessToken = env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = env.SHOPIFY_API_VERSION || '2024-01';

    if (!storeUrl || !accessToken) {
      throw new Error('SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN 환경변수가 필요합니다');
    }

    this.baseUrl = `https://${storeUrl}/admin/api/${apiVersion}`;
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  // ─── PlatformAdapter 구현 ─────────────────────────────────

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

    const response = await this.client.post('/products.json', productData);
    const product = response.data.product;

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
