/**
 * Shopee Open Platform v2 클라이언트 — CBSC Merchant + Shop Level
 *
 * CBSC 구조: Merchant Level (정보) + Shop Level (상품/주문, 5개 shop)
 * Production: https://partner.shopeemobile.com
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
  private merchantId: number;
  private baseUrl: string;
  private defaultCategoryId: number;

  // Merchant-level tokens
  private merchantAccessToken: string;
  private merchantRefreshToken: string;
  private merchantTokenExpiresAt = 0;

  // Shop-level tokens (shared across all 5 shops)
  private shopAccessToken: string;
  private shopRefreshToken: string;
  private shopTokenExpiresAt = 0;
  private shopIds: number[];

  private initialized = false;

  constructor() {
    this.partnerId = env.SHOPEE_PARTNER_ID || 0;
    this.partnerKey = env.SHOPEE_PARTNER_KEY || '';
    this.merchantId = env.SHOPEE_MERCHANT_ID || 0;
    this.defaultCategoryId = env.SHOPEE_DEFAULT_CATEGORY_ID || 0;

    this.merchantAccessToken = env.SHOPEE_ACCESS_TOKEN || '';
    this.merchantRefreshToken = env.SHOPEE_REFRESH_TOKEN || '';

    this.shopAccessToken = env.SHOPEE_SHOP_ACCESS_TOKEN || '';
    this.shopRefreshToken = env.SHOPEE_SHOP_REFRESH_TOKEN || '';
    this.shopIds = (env.SHOPEE_SHOP_IDS || '')
      .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

    const isTest = (env.SHOPEE_ENV || 'test') === 'test';
    this.baseUrl = isTest
      ? 'https://partner.test-stable.shopeemobile.com'
      : 'https://partner.shopeemobile.com';
  }

  // ─── 서명 ───────────────────────────────────────

  private signPublic(path: string, ts: number): string {
    return crypto.createHmac('sha256', this.partnerKey).update(`${this.partnerId}${path}${ts}`).digest('hex');
  }

  private signMerchant(path: string, ts: number): string {
    return crypto.createHmac('sha256', this.partnerKey)
      .update(`${this.partnerId}${path}${ts}${this.merchantAccessToken}${this.merchantId}`)
      .digest('hex');
  }

  private signShop(path: string, ts: number, shopId: number): string {
    return crypto.createHmac('sha256', this.partnerKey)
      .update(`${this.partnerId}${path}${ts}${this.shopAccessToken}${shopId}`)
      .digest('hex');
  }

  // ─── URL 생성 ────────────────────────────────────

  private buildMerchantUrl(path: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const sign = this.signMerchant(path, ts);
    return `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${ts}&sign=${sign}&access_token=${this.merchantAccessToken}&merchant_id=${this.merchantId}`;
  }

  private buildShopUrl(path: string, shopId: number): string {
    const ts = Math.floor(Date.now() / 1000);
    const sign = this.signShop(path, ts, shopId);
    return `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${ts}&sign=${sign}&access_token=${this.shopAccessToken}&shop_id=${shopId}`;
  }

  // ─── 토큰 갱신 ───────────────────────────────────

  private isExpired(expiresAt: number): boolean {
    if (!expiresAt) return false;
    return Date.now() >= expiresAt - 5 * 60 * 1000;
  }

  private async refreshMerchantToken(): Promise<void> {
    const path = '/api/v2/auth/access_token/get';
    const ts = Math.floor(Date.now() / 1000);
    const sign = this.signPublic(path, ts);
    const url = `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${ts}&sign=${sign}`;

    const res = await axios.post(url, {
      refresh_token: this.merchantRefreshToken,
      partner_id: this.partnerId,
      merchant_id: this.merchantId,
    }, { timeout: 15000 });

    const data = res.data;
    if (data.error) throw new Error(`Shopee merchant 토큰 갱신 실패: ${data.error} - ${data.message}`);

    this.merchantAccessToken = data.access_token;
    this.merchantRefreshToken = data.refresh_token;
    this.merchantTokenExpiresAt = Date.now() + (data.expire_in || 14400) * 1000;
    console.log('Shopee: merchant 토큰 갱신 완료');

    await saveToken('shopee', {
      accessToken: this.merchantAccessToken,
      refreshToken: this.merchantRefreshToken,
      expiresAt: new Date(this.merchantTokenExpiresAt),
      metadata: { merchantId: this.merchantId },
    });
  }

  private async refreshShopToken(): Promise<void> {
    const path = '/api/v2/auth/access_token/get';
    const ts = Math.floor(Date.now() / 1000);
    const sign = this.signPublic(path, ts);
    const url = `${this.baseUrl}${path}?partner_id=${this.partnerId}&timestamp=${ts}&sign=${sign}`;

    const res = await axios.post(url, {
      refresh_token: this.shopRefreshToken,
      partner_id: this.partnerId,
      shop_id: this.shopIds[0],
    }, { timeout: 15000 });

    const data = res.data;
    if (data.error) throw new Error(`Shopee shop 토큰 갱신 실패: ${data.error} - ${data.message}`);

    this.shopAccessToken = data.access_token;
    this.shopRefreshToken = data.refresh_token;
    this.shopTokenExpiresAt = Date.now() + (data.expire_in || 14400) * 1000;
    console.log('Shopee: shop 토큰 갱신 완료');
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const saved = await loadToken('shopee');
    if (saved) {
      this.merchantAccessToken = saved.accessToken;
      if (saved.refreshToken) this.merchantRefreshToken = saved.refreshToken;
      this.merchantTokenExpiresAt = saved.expiresAt?.getTime() || 0;
    }
  }

  private async ensureValidMerchantToken(): Promise<void> {
    await this.ensureInitialized();
    if (this.isExpired(this.merchantTokenExpiresAt)) await this.refreshMerchantToken();
  }

  private async ensureValidShopToken(): Promise<void> {
    if (!this.shopAccessToken) throw new Error('Shopee: SHOPEE_SHOP_ACCESS_TOKEN 미설정');
    if (this.isExpired(this.shopTokenExpiresAt)) await this.refreshShopToken();
  }

  // ─── API 호출 ─────────────────────────────────────

  private async callMerchantApi(method: 'GET' | 'POST', path: string, body?: Record<string, any>, extraParams?: string): Promise<any> {
    await this.ensureValidMerchantToken();
    let url = this.buildMerchantUrl(path);
    if (extraParams) url += extraParams;

    const res = method === 'GET'
      ? await axios.get(url, { timeout: 30000 })
      : await axios.post(url, body, { timeout: 30000 });

    const data = res.data;
    if (data.error && data.error !== '') throw new Error(`Shopee merchant API [${path}]: ${data.error} - ${data.message}`);
    return data;
  }

  private async callShopApi(method: 'GET' | 'POST', path: string, shopId: number, body?: Record<string, any>, extraParams?: string): Promise<any> {
    await this.ensureValidShopToken();
    let url = this.buildShopUrl(path, shopId);
    if (extraParams) url += extraParams;

    let res;
    try {
      res = method === 'GET'
        ? await axios.get(url, { timeout: 30000 })
        : await axios.post(url, body, { timeout: 30000 });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response && (e.response.status === 401 || e.response.status === 403)) {
        await this.refreshShopToken();
        const retryUrl = this.buildShopUrl(path, shopId) + (extraParams || '');
        res = method === 'GET'
          ? await axios.get(retryUrl, { timeout: 30000 })
          : await axios.post(retryUrl, body, { timeout: 30000 });
      } else {
        throw e;
      }
    }

    const data = res.data;
    if (data.error && data.error !== '') throw new Error(`Shopee shop API [${path}] shop ${shopId}: ${data.error} - ${data.message}`);
    return data;
  }

  // ─── Public API ───────────────────────────────────

  async testConnection(): Promise<boolean> {
    try {
      if (!this.merchantAccessToken || !this.partnerId || !this.merchantId) {
        console.log('Shopee: 필수 설정 미입력');
        return false;
      }
      const data = await this.callMerchantApi('GET', '/api/v2/merchant/get_merchant_info');
      console.log(`Shopee merchant 연결 성공: ${data.merchant_name} (merchant_id: ${this.merchantId})`);

      if (this.shopAccessToken && this.shopIds.length > 0) {
        console.log(`Shopee shop 토큰 준비: ${this.shopIds.length}개 shop`);
      }
      return true;
    } catch (e) {
      console.error('Shopee 연결 실패:', (e as Error).message);
      return false;
    }
  }

  /** 특정 shop 상품 목록 */
  async getProducts(shopId?: number, offset = 0, limit = 50): Promise<any[]> {
    const sid = shopId || this.shopIds[0];
    if (!sid) throw new Error('Shopee: shop_id 없음');
    const data = await this.callShopApi('GET', '/api/v2/product/get_item_list', sid,
      undefined, `&offset=${offset}&page_size=${limit}&item_status=NORMAL`);
    return data.response?.item || [];
  }

  /** 모든 shop 상품 목록 */
  async getAllShopsProducts(offset = 0, limit = 50): Promise<{ shopId: number; items: any[] }[]> {
    const results = [];
    for (const shopId of this.shopIds) {
      try {
        const items = await this.getProducts(shopId, offset, limit);
        results.push({ shopId, items });
      } catch (e) {
        console.error(`Shopee shop ${shopId} 상품 조회 실패:`, (e as Error).message);
        results.push({ shopId, items: [] });
      }
    }
    return results;
  }

  /** 단일 상품 조회 */
  async getProduct(itemId: string, shopId?: number): Promise<any> {
    const sid = shopId || this.shopIds[0];
    if (!sid) throw new Error('Shopee: shop_id 없음');
    const data = await this.callShopApi('GET', '/api/v2/product/get_item_base_info', sid,
      undefined, `&item_id_list=${itemId}`);
    return data.response?.item_list?.[0];
  }

  async updateInventory(itemId: string, price: number, quantity: number, shopId?: number): Promise<void> {
    const sid = shopId || this.shopIds[0];
    if (!sid) throw new Error('Shopee: shop_id 없음');
    await this.callShopApi('POST', '/api/v2/product/update_item', sid, {
      item_id: parseInt(itemId), original_price: price,
    });
    await this.callShopApi('POST', '/api/v2/product/update_stock', sid, {
      item_id: parseInt(itemId), stock_list: [{ seller_stock: [{ stock: quantity }] }],
    });
  }

  async createListing(input: ListingInput): Promise<ListingResult> {
    const sid = this.shopIds[0];
    if (!sid) throw new Error('Shopee: shop_id 없음');

    const body: Record<string, any> = {
      item_name: input.title,
      description: input.description,
      original_price: input.price,
      weight: (input.weight || 500) / 1000,
      item_sku: input.sku,
      condition: input.condition === 'used' ? 'USED' : 'NEW',
      item_status: 'NORMAL',
      seller_stock: [{ stock: input.quantity }],
    };
    if (this.defaultCategoryId) body.category_id = this.defaultCategoryId;

    const data = await this.callShopApi('POST', '/api/v2/product/add_item', sid, body);
    const itemId = String(data.response?.item_id || 'unknown');
    return { itemId, url: `https://shopee.com/product/${sid}/${itemId}` };
  }

  async updateListing(itemId: string, updates: Partial<ListingInput>): Promise<void> {
    const sid = this.shopIds[0];
    const body: Record<string, any> = { item_id: parseInt(itemId) };
    if (updates.title) body.item_name = updates.title;
    if (updates.description) body.description = updates.description;
    if (updates.price !== undefined) body.original_price = updates.price;
    await this.callShopApi('POST', '/api/v2/product/update_item', sid, body);
  }

  async deleteListing(itemId: string): Promise<void> {
    const sid = this.shopIds[0];
    await this.callShopApi('POST', '/api/v2/product/delete_item', sid, { item_id: parseInt(itemId) });
  }

  get shopIdList(): number[] { return this.shopIds; }
}
