require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const axios = require('axios');
const crypto = require('crypto');

/**
 * Alibaba.com ICBU Open Platform API 클래스
 * IOP 프로토콜 (HMAC-SHA256 서명) 사용
 */
class AlibabaAPI {
  constructor() {
    this.appKey = process.env.ALIBABA_APP_KEY;
    this.appSecret = process.env.ALIBABA_APP_SECRET;
    this.accessToken = process.env.ALIBABA_ACCESS_TOKEN;
    this.gateway = 'https://openapi-api.alibaba.com/rest';
  }

  /**
   * IOP 서명 생성 (HMAC-SHA256, 대문자 HEX)
   */
  generateSign(apiPath, params) {
    const sorted = Object.keys(params).sort();
    let baseString = apiPath;
    for (const key of sorted) {
      baseString += key + params[key];
    }
    return crypto.createHmac('sha256', this.appSecret).update(baseString).digest('hex').toUpperCase();
  }

  /**
   * API 호출
   */
  async request(apiPath, bizParams = {}, method = 'GET') {
    const timestamp = Date.now().toString();
    const params = {
      app_key: this.appKey,
      timestamp,
      sign_method: 'sha256',
      access_token: this.accessToken,
      ...bizParams,
    };
    params.sign = this.generateSign(apiPath, params);

    const url = this.gateway + apiPath;

    try {
      const config = { timeout: 15000 };
      let response;
      if (method === 'POST') {
        response = await axios.post(url, null, { params, ...config });
      } else {
        response = await axios.get(url, { params, ...config });
      }
      return response.data;
    } catch (error) {
      console.error(`Alibaba API 오류 [${apiPath}]:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * 내 상품 목록 조회
   */
  async getProductList(page = 1, pageSize = 20) {
    return this.request('/alibaba/icbu/product/list', {
      current_page: String(page),
      page_size: String(pageSize),
      language: 'en',
    });
  }

  /**
   * 상품 상세 정보
   */
  async getProductDetail(productId) {
    return this.request('/alibaba/icbu/product/detail/get', {
      product_id: String(productId),
      language: 'en',
    });
  }

  /**
   * 카테고리 ID 매핑
   */
  async getCategoryMapping(id, idType = 'cid') {
    return this.request('/alibaba/icbu/category/id/mapping', {
      id: String(id),
      id_type: idType,
    });
  }

  /**
   * 토큰 갱신 (access_token 없이 refresh_token만으로 호출)
   */
  async refreshToken() {
    const { saveToken } = require('../services/tokenStore');
    const refreshToken = process.env.ALIBABA_REFRESH_TOKEN;
    if (!refreshToken) throw new Error('ALIBABA_REFRESH_TOKEN not set');

    const timestamp = Date.now().toString();
    const params = {
      app_key: this.appKey,
      timestamp,
      sign_method: 'sha256',
      refresh_token: refreshToken,
    };
    params.sign = this.generateSign('/auth/token/refresh', params);

    const r = await axios.post(this.gateway + '/auth/token/refresh', null, { params, timeout: 15000 });
    const data = r.data;

    if (!data.access_token) {
      throw new Error('Alibaba token refresh failed: ' + JSON.stringify(data));
    }

    this.accessToken = data.access_token;
    process.env.ALIBABA_ACCESS_TOKEN = data.access_token;
    if (data.refresh_token) process.env.ALIBABA_REFRESH_TOKEN = data.refresh_token;

    // Save to DB instead of .env
    await saveToken('alibaba', {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    });
    console.log('[Alibaba] Token refreshed. expires_in:', data.expires_in);
    return data;
  }

  /**
   * API 호출 (토큰 만료 시 자동 갱신)
   */
  async requestWithRetry(apiPath, bizParams = {}, method = 'GET') {
    const data = await this.request(apiPath, bizParams, method);
    if (data?.code === 'IllegalAccessToken') {
      console.log('[Alibaba] Token expired, refreshing...');
      await this.refreshToken();
      return this.request(apiPath, bizParams, method);
    }
    return data;
  }
}

module.exports = AlibabaAPI;
