/**
 * Shopee Open Platform v2 클라이언트
 *
 * HMAC-SHA256 서명, 4시간 토큰 자동갱신 포함.
 *
 * Production: https://partner.shopeemobile.com
 * Sandbox:    https://partner.test-stable.shopeemobile.com
 */
import crypto from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { env } from '../../lib/config.js';
import { loadToken, saveToken } from '../../lib/token-store.js';
import type { PlatformAdapter, ListingInput, ListingResult } from '../index.js';

export class ShopeeClient implements PlatformAdapter {
  readonly platform = 'shopee';

  private partnerId: number;
  private partnerKey: string;
  private shopId: number;
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiresAt = 0;
  private initialized = false;
  private baseUrl: string;
  private defaultCategoryId: number;

  constructor() {
    this.partnerId = env.SHOPEE_PARTNER_ID || 0;
    this.partnerKey = env.SHOPEE_PARTNER_KEY || '';
    this.shopId = env.SHOPEE_SHOP_ID || 0;
    this.accessToken = env.SHOPEE_ACCESS_TOKEN || '';
    this.refreshToken = env.SHOPEE_REFRESH_TOKEN || '';
    this.defaultCategoryId = env.SHOPEE_DEFAULT_CATEGORY_ID || 0;

    const isTest = (env.SHOPEE_ENV || 'test') === 'test';
    this.baseUrl = isTest
      ? 'https://partner.test-stable.shopeemobile.com'
      : 'https://partner.shopeemobile.com';
  }

  // ─── HMAC-SHA256 서명 생성 ──────────────────────────

  /** Public API (인증): partner_id + path + timestamp */
  private signPublic(path: string, timestamp: number): string {
    const baseString = `${this.partnerId}${path}${timestamp}`;
    return crypto.createHmac('sha256', this.partnerKey)
      .update(baseString)
      .digest('hex');
  }

  /** Shop Level API: partner_id + path + timestamp + access_token + shop_id */
  private signShop(path: string, timestamp: number): string {
    const baseString = `${this.partnerId}${path}${timestamp}${this.accessToken}${this.shopId}`;
    return crypto.createHmac('sha256', this.partnerKey)
      .update(baseString)
      .digest('hex');
  }

  // ─── URL 생성 헬퍼 ────────────────────────────────

  private buildShopUrl(path: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.signShop(path, timestamp);
    return `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${timestamp}&sign=${sign}&access_token=${this.accessToken}&shop_id=${this.shopId}`;
  }

  /** Public Level URL (media_space 등 partner 서명만 필요한 API) */
  private buildPublicUrl(path: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.signPublic(path, timestamp);
    return `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${timestamp}&sign=${sign}`;
  }

  // ─── OAuth 토큰 자동갱신 (4시간 만료) ──────────────

  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false;
    return Date.now() >= this.tokenExpiresAt - 5 * 60 * 1000;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('Shopee: SHOPEE_REFRESH_TOKEN 미설정 — 토큰 갱신 불가');
    }

    const path = '/api/v2/auth/access_token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.signPublic(path, timestamp);

    const url = `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${timestamp}&sign=${sign}`;

    let response;
    try {
      response = await axios.post(url, {
        refresh_token: this.refreshToken,
        partner_id: this.partnerId,
        shop_id: this.shopId,
      }, { timeout: 15000 });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        throw new Error(`Shopee 토큰 갱신 HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`);
      }
      throw e;
    }

    const data = response.data;
    if (data.error) {
      throw new Error(`Shopee 토큰 갱신 실패: ${data.error} - ${data.message}`);
    }

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + (data.expire_in || 14400) * 1000;
    console.log(`Shopee: 토큰 갱신 완료 (만료: ${new Date(this.tokenExpiresAt).toLocaleTimeString()})`);

    // DB에 갱신된 토큰 저장 (Shopee는 refresh_token도 매번 바뀜)
    await saveToken('shopee', {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: new Date(this.tokenExpiresAt),
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const saved = await loadToken('shopee');
    if (saved) {
      this.accessToken = saved.accessToken;
      if (saved.refreshToken) this.refreshToken = saved.refreshToken;
      this.tokenExpiresAt = saved.expiresAt?.getTime() || 0;
      console.log('Shopee: DB에서 토큰 로드 완료');
    }
  }

  private async ensureValidToken(): Promise<void> {
    await this.ensureInitialized();
    if (this.isTokenExpired()) {
      await this.refreshAccessToken();
    }
  }

  // ─── Shop Level API 호출 ───────────────────────────

  private async callApi(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, any>,
  ): Promise<any> {
    await this.ensureValidToken();

    const url = this.buildShopUrl(path);

    let response;
    try {
      response = method === 'GET'
        ? await axios.get(url, { timeout: 30000 })
        : await axios.post(url, body, { timeout: 30000 });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        const status = e.response.status;
        const errorData = e.response.data;
        console.error(`Shopee HTTP ${status} [${path}]:`, JSON.stringify(errorData));

        // 403/401은 토큰 문제일 가능성 → 갱신 후 1회 재시도
        if (status === 403 || status === 401) {
          console.log(`Shopee: HTTP ${status} 감지, 토큰 갱신 후 재시도...`);
          await this.refreshAccessToken();
          const retryUrl = this.buildShopUrl(path);
          try {
            response = method === 'GET'
              ? await axios.get(retryUrl, { timeout: 30000 })
              : await axios.post(retryUrl, body, { timeout: 30000 });
          } catch (retryErr) {
            if (axios.isAxiosError(retryErr) && retryErr.response) {
              throw new Error(`Shopee API HTTP ${retryErr.response.status} [${path}] (재시도): ${JSON.stringify(retryErr.response.data)}`);
            }
            throw retryErr;
          }
        } else {
          throw new Error(`Shopee API HTTP ${status} [${path}]: ${JSON.stringify(errorData)}`);
        }
      } else {
        throw e;
      }
    }

    const data = response.data;

    // 토큰 만료 에러 감지 (Shopee는 200으로 응답하면서 error 필드에 넣는 경우도 있음)
    if (data.error === 'error_auth' || (data.error === 'error_param' && data.message?.includes('token'))) {
      console.log('Shopee: 토큰 만료 감지 (응답 body), 갱신 후 재시도...');
      await this.refreshAccessToken();
      const retryUrl = this.buildShopUrl(path);
      const retry = method === 'GET'
        ? await axios.get(retryUrl, { timeout: 30000 })
        : await axios.post(retryUrl, body, { timeout: 30000 });
      return retry.data;
    }

    if (data.error && data.error !== '') {
      throw new Error(`Shopee API 오류 [${path}]: ${data.error} - ${data.message}${data.request_id ? ` (request_id: ${data.request_id})` : ''}`);
    }

    return data;
  }

  // ─── 이미지 업로드 ───────────────────────────────

  /** 이미지 URL을 다운로드하여 Shopee에 업로드, image_id 반환 */
  private async uploadImage(imageUrl: string): Promise<string> {
    // 1. 이미지 다운로드
    const imgResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const buffer = Buffer.from(imgResponse.data);

    // 2. Shopee media_space에 업로드 (Shop Level 서명)
    await this.ensureValidToken();
    const path = '/api/v2/media_space/upload_image';
    const url = this.buildShopUrl(path);

    const form = new FormData();
    form.append('image', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

    let response;
    try {
      response = await axios.post(url, form, {
        headers: form.getHeaders(),
        timeout: 60000,
      });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        throw new Error(`Shopee 이미지 업로드 HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`);
      }
      throw e;
    }

    const data = response.data;
    if (data.error && data.error !== '') {
      throw new Error(`Shopee 이미지 업로드 오류: ${data.error} - ${data.message}`);
    }

    const imageId = data.response?.image_info?.image_id;
    if (!imageId) {
      throw new Error(`Shopee 이미지 업로드: image_id 없음 (응답: ${JSON.stringify(data)})`);
    }

    return imageId;
  }

  // ─── PlatformAdapter 구현 ─────────────────────────

  async testConnection(): Promise<boolean> {
    try {
      if (!this.accessToken || !this.partnerId) {
        console.log('Shopee: 필수 설정 미입력 (PARTNER_ID, ACCESS_TOKEN)');
        return false;
      }
      const data = await this.callApi('GET', '/api/v2/shop/get_shop_info');
      const shopName = data.response?.shop_name || 'unknown';
      console.log(`Shopee 연결 성공: ${shopName}`);
      return true;
    } catch (e) {
      console.error('Shopee 연결 실패:', (e as Error).message);
      return false;
    }
  }

  async createListing(input: ListingInput): Promise<ListingResult> {
    if (!this.defaultCategoryId) {
      console.warn('Shopee: SHOPEE_DEFAULT_CATEGORY_ID 미설정 — API 호출이 실패할 수 있습니다');
    }

    // 이미지 사전 업로드 (Shopee는 image_id 필요)
    const imageIds: string[] = [];
    for (const url of input.imageUrls) {
      try {
        const imageId = await this.uploadImage(url);
        imageIds.push(imageId);
        console.log(`Shopee: 이미지 업로드 성공 (${imageIds.length}/${input.imageUrls.length})`);
      } catch (e) {
        console.warn(`Shopee 이미지 업로드 실패 (${url}):`, (e as Error).message);
      }
    }

    if (imageIds.length === 0) {
      throw new Error('Shopee: 업로드된 이미지가 없어 리스팅 생성 불가');
    }

    const body: Record<string, any> = {
      item_name: input.title,
      description: input.description,
      original_price: input.price,
      weight: (input.weight || 500) / 1000, // g → kg
      item_sku: input.sku,
      condition: input.condition === 'used' ? 'USED' : 'NEW',
      item_status: 'NORMAL',
      seller_stock: [{ stock: input.quantity }],
      image: {
        image_id_list: imageIds,
      },
    };

    if (this.defaultCategoryId) {
      body.category_id = this.defaultCategoryId;
    }

    const data = await this.callApi('POST', '/api/v2/product/add_item', body);

    const itemId = String(data.response?.item_id || 'unknown');
    return {
      itemId,
      url: `https://shopee.com/product/${this.shopId}/${itemId}`,
    };
  }

  async updateListing(itemId: string, updates: Partial<ListingInput>): Promise<void> {
    const body: Record<string, any> = {
      item_id: parseInt(itemId),
    };

    if (updates.title) body.item_name = updates.title;
    if (updates.description) body.description = updates.description;
    if (updates.price !== undefined) body.original_price = updates.price;

    await this.callApi('POST', '/api/v2/product/update_item', body);
  }

  async deleteListing(itemId: string): Promise<void> {
    await this.callApi('POST', '/api/v2/product/delete_item', {
      item_id: parseInt(itemId),
    });
  }

  async updateInventory(itemId: string, price: number, quantity: number): Promise<void> {
    // 가격 업데이트
    await this.callApi('POST', '/api/v2/product/update_item', {
      item_id: parseInt(itemId),
      original_price: price,
    });

    // 재고 업데이트
    await this.callApi('POST', '/api/v2/product/update_stock', {
      item_id: parseInt(itemId),
      stock_list: [{ seller_stock: [{ stock: quantity }] }],
    });
  }

  // ─── 추가 메서드 ──────────────────────────────────

  /** 단일 상품 조회 */
  async getProduct(itemId: string): Promise<any> {
    const data = await this.callApi('GET', `/api/v2/product/get_item_base_info`);
    // item_id_list는 쿼리 파라미터로 전달해야 하므로 별도 처리 필요
    // 현재는 기본 구현
    return data.response?.item_list?.[0];
  }
}
