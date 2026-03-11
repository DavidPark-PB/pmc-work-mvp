/**
 * Alibaba ICBU Open Platform 클라이언트
 *
 * Taobao Open API Gateway를 사용하여 국제 B2B 마켓 통신.
 * 토큰 자동갱신 포함.
 *
 * Gateway: https://eco.taobao.com/router/rest (international)
 * 서명: MD5 기반 (파라미터 정렬 후 app_secret으로 감싸기)
 */
import crypto from 'crypto';
import axios from 'axios';
import { env } from '../../lib/config.js';
import { loadToken, saveToken } from '../../lib/token-store.js';
import type { PlatformAdapter, ListingInput, ListingResult } from '../index.js';

export class AlibabaClient implements PlatformAdapter {
  readonly platform = 'alibaba';

  private appKey: string;
  private appSecret: string;
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiresAt = 0;
  private initialized = false;
  private gatewayUrl: string;
  private defaultCategoryId: string;

  constructor() {
    this.appKey = env.ALIBABA_APP_KEY || '';
    this.appSecret = env.ALIBABA_APP_SECRET || '';
    this.accessToken = env.ALIBABA_ACCESS_TOKEN || '';
    this.refreshToken = env.ALIBABA_REFRESH_TOKEN || '';
    this.defaultCategoryId = env.ALIBABA_DEFAULT_CATEGORY_ID || '';

    // ICBU (International) → gw.api.alibaba.com
    this.gatewayUrl = 'https://eco.taobao.com/router/rest';
  }

  // ─── 에러 메시지 포맷팅 ──────────────────────────────

  private formatErrorResponse(errResp: Record<string, any>, method: string, suffix = ''): string {
    const parts = [
      errResp.code != null && `code=${errResp.code}`,
      errResp.msg && `msg=${errResp.msg}`,
      errResp.sub_code && `sub_code=${errResp.sub_code}`,
      errResp.sub_msg && `sub_msg=${errResp.sub_msg}`,
      errResp.request_id && `request_id=${errResp.request_id}`,
    ].filter(Boolean);
    const label = suffix ? `[${method}] (${suffix})` : `[${method}]`;
    return `Alibaba API 오류 ${label}: ${parts.join(', ') || JSON.stringify(errResp)}`;
  }

  // ─── 서명 생성 (MD5) ───────────────────────────────

  private generateSign(params: Record<string, string>): string {
    // 파라미터를 키 기준 정렬 후 연결
    const sorted = Object.keys(params).sort();
    let baseString = this.appSecret;
    for (const key of sorted) {
      baseString += key + params[key];
    }
    baseString += this.appSecret;

    return crypto.createHash('md5').update(baseString, 'utf8').digest('hex').toUpperCase();
  }

  // ─── OAuth 토큰 자동갱신 ────────────────────────────

  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false;
    return Date.now() >= this.tokenExpiresAt - 5 * 60 * 1000;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('Alibaba: ALIBABA_REFRESH_TOKEN 미설정 — 토큰 갱신 불가');
    }

    const params: Record<string, string> = {
      method: 'taobao.top.auth.token.refresh',
      app_key: this.appKey,
      format: 'json',
      v: '2.0',
      sign_method: 'md5',
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      refresh_token: this.refreshToken,
    };

    params.sign = this.generateSign(params);

    let response;
    try {
      response = await axios.get(this.gatewayUrl, { params, timeout: 15000 });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        throw new Error(`Alibaba 토큰 갱신 HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`);
      }
      throw e;
    }

    const data = response.data;
    if (data.error_response) {
      throw new Error(`Alibaba 토큰 갱신 실패: ${this.formatErrorResponse(data.error_response, 'token.refresh')}`);
    }

    const tokenData = data.top_auth_token_refresh_response || data.token_result;
    if (tokenData) {
      const result = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
      this.accessToken = result.access_token || this.accessToken;
      this.refreshToken = result.refresh_token || this.refreshToken;
      // Alibaba 토큰은 보통 24시간 유효
      this.tokenExpiresAt = Date.now() + (result.expires_in || 86400) * 1000;
      console.log(`Alibaba: 토큰 갱신 완료 (만료: ${new Date(this.tokenExpiresAt).toLocaleTimeString()})`);

      // DB에 갱신된 토큰 저장
      await saveToken('alibaba', {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: new Date(this.tokenExpiresAt),
      });
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const saved = await loadToken('alibaba');
    if (saved) {
      this.accessToken = saved.accessToken;
      if (saved.refreshToken) this.refreshToken = saved.refreshToken;
      this.tokenExpiresAt = saved.expiresAt?.getTime() || 0;
      console.log('Alibaba: DB에서 토큰 로드 완료');
    }
  }

  private async ensureValidToken(): Promise<void> {
    await this.ensureInitialized();
    if (this.isTokenExpired()) {
      await this.refreshAccessToken();
    }
  }

  // ─── API 호출 ──────────────────────────────────────

  private async callApi(method: string, apiParams: Record<string, string> = {}): Promise<any> {
    await this.ensureValidToken();

    const params: Record<string, string> = {
      method,
      app_key: this.appKey,
      session: this.accessToken,
      format: 'json',
      v: '2.0',
      sign_method: 'md5',
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      ...apiParams,
    };

    params.sign = this.generateSign(params);

    let response;
    try {
      response = await axios.get(this.gatewayUrl, { params, timeout: 30000 });
    } catch (e) {
      if (axios.isAxiosError(e) && e.response) {
        throw new Error(`Alibaba HTTP ${e.response.status} [${method}]: ${JSON.stringify(e.response.data)}`);
      }
      throw e;
    }

    const data = response.data;

    // 토큰 만료 에러 감지 → 갱신 후 1회 재시도
    if (data.error_response?.code === 27 || data.error_response?.sub_code === 'accesscontrol.invalid-sessionkey') {
      console.log('Alibaba: 토큰 만료 감지, 갱신 후 재시도...');
      await this.refreshAccessToken();
      params.session = this.accessToken;
      params.timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
      params.sign = this.generateSign(params);

      let retryResponse;
      try {
        retryResponse = await axios.get(this.gatewayUrl, { params, timeout: 30000 });
      } catch (e) {
        if (axios.isAxiosError(e) && e.response) {
          throw new Error(`Alibaba HTTP ${e.response.status} [${method}] (재시도): ${JSON.stringify(e.response.data)}`);
        }
        throw e;
      }

      const retryData = retryResponse.data;
      if (retryData.error_response) {
        throw new Error(this.formatErrorResponse(retryData.error_response, method, '재시도'));
      }
      return retryData;
    }

    if (data.error_response) {
      throw new Error(this.formatErrorResponse(data.error_response, method));
    }

    return data;
  }

  // ─── PlatformAdapter 구현 ─────────────────────────

  async testConnection(): Promise<boolean> {
    try {
      if (!this.accessToken) {
        console.log('Alibaba: Access Token 미설정');
        return false;
      }
      // alibaba.icbu.product.list로 연결 확인
      const data = await this.callApi('alibaba.icbu.product.list', {
        current_page: '1',
        page_size: '1',
      });
      console.log('Alibaba 연결 성공');
      return true;
    } catch (e) {
      console.error('Alibaba 연결 실패:', (e as Error).message);
      return false;
    }
  }

  async createListing(input: ListingInput): Promise<ListingResult> {
    if (!this.defaultCategoryId) {
      console.warn('Alibaba: ALIBABA_DEFAULT_CATEGORY_ID 미설정 — API 호출이 실패할 수 있습니다');
    }

    // alibaba.icbu.product.add
    const productData: Record<string, string> = {
      language: 'en',
      subject: input.title,
      description: input.description,
      keywords: input.brand || input.productType || '',
      product_type: 'sourcing',
      group_id: '0',
      product_sku_infos: JSON.stringify([{
        sku_code: input.sku,
        price: input.price.toFixed(2),
        stock: input.quantity,
      }]),
      image_u_r_ls: input.imageUrls.join(','),
    };

    if (this.defaultCategoryId) {
      productData.category_id = this.defaultCategoryId;
    }

    const data = await this.callApi('alibaba.icbu.product.add', productData);

    // 응답에서 product_id 추출
    const resultKey = Object.keys(data).find(k => k.includes('response'));
    const result = resultKey ? data[resultKey] : data;
    const productId = result?.product_id || result?.productId || 'unknown';

    return {
      itemId: String(productId),
      url: `https://www.alibaba.com/product-detail/${productId}.html`,
    };
  }

  async updateListing(itemId: string, updates: Partial<ListingInput>): Promise<void> {
    const params: Record<string, string> = {
      product_id: itemId,
    };

    if (updates.title) params.subject = updates.title;
    if (updates.description) params.description = updates.description;
    if (updates.price !== undefined) {
      params.product_sku_infos = JSON.stringify([{
        price: updates.price.toFixed(2),
      }]);
    }

    await this.callApi('alibaba.icbu.product.update', params);
  }

  async deleteListing(itemId: string): Promise<void> {
    await this.callApi('alibaba.icbu.product.delete', {
      product_id: itemId,
    });
  }

  async updateInventory(itemId: string, price: number, quantity: number): Promise<void> {
    await this.callApi('alibaba.icbu.product.update', {
      product_id: itemId,
      product_sku_infos: JSON.stringify([{
        price: price.toFixed(2),
        stock: quantity,
      }]),
    });
  }
}
