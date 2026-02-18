require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');
const crypto = require('crypto');

/**
 * Shopee Open Platform API 클래스 (CB 셀러용)
 * Shopee Partner API를 사용하여 동남아 시장 상품 관리
 * CB(Cross-Border) 셀러는 merchant_id + global_product API 사용
 */
class ShopeeAPI {
  constructor() {
    this.partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    this.partnerKey = process.env.SHOPEE_PARTNER_KEY;
    this.shopId = parseInt(process.env.SHOPEE_SHOP_ID);
    this.merchantId = parseInt(process.env.SHOPEE_MERCHANT_ID);
    this.accessToken = process.env.SHOPEE_ACCESS_TOKEN;
    this.refreshToken = process.env.SHOPEE_REFRESH_TOKEN;

    this.baseUrl = process.env.SHOPEE_ENV === 'test'
      ? 'https://openplatform.sandbox.test-stable.shopee.sg'
      : 'https://partner.shopeemobile.com';
  }

  /**
   * API 서명 생성 (HMAC-SHA256)
   * merchant 레벨: partner_id + path + timestamp + access_token + merchant_id
   * shop 레벨: partner_id + path + timestamp + access_token + shop_id
   */
  generateSignature(path, timestamp, useShopId = false) {
    const id = useShopId ? this.shopId : this.merchantId;
    const baseString = `${this.partnerId}${path}${timestamp}${this.accessToken}${id}`;
    return crypto.createHmac('sha256', this.partnerKey).update(baseString).digest('hex');
  }

  /**
   * API 요청 실행 (merchant 레벨)
   */
  async request(method, path, data = null) {
    return this._doRequest(method, path, data, false);
  }

  /**
   * API 요청 실행 (shop 레벨)
   */
  async shopRequest(method, path, data = null) {
    return this._doRequest(method, path, data, true);
  }

  async _doRequest(method, path, data, useShopId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.generateSignature(path, timestamp, useShopId);

    const url = `${this.baseUrl}${path}`;
    const params = {
      partner_id: this.partnerId,
      timestamp: timestamp,
      sign: sign,
      access_token: this.accessToken,
    };
    if (useShopId) params.shop_id = this.shopId;
    else params.merchant_id = this.merchantId;

    try {
      const config = {
        method,
        url,
        params,
        timeout: 15000,
      };

      if (data && method === 'GET') {
        Object.assign(config.params, data);
      } else if (data) {
        config.data = data;
        config.headers = { 'Content-Type': 'application/json' };
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`Shopee API 오류 [${path}]:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * 카테고리 목록 조회
   */
  async getCategories(language = 'en') {
    return this.request('GET', '/api/v2/global_product/get_category', { language });
  }

  /**
   * 글로벌 상품 등록
   */
  async addGlobalItem(itemData) {
    return this.request('POST', '/api/v2/global_product/add_global_item', itemData);
  }

  /**
   * 글로벌 상품 수정
   */
  async updateGlobalItem(itemData) {
    return this.request('POST', '/api/v2/global_product/update_global_item', itemData);
  }

  /**
   * 글로벌 상품 삭제
   */
  async deleteGlobalItem(globalItemId) {
    return this.request('POST', '/api/v2/global_product/delete_global_item', {
      global_item_id: globalItemId,
    });
  }

  /**
   * 글로벌 모델 목록 조회
   */
  async getGlobalModelList(globalItemId) {
    return this.request('GET', '/api/v2/global_product/get_global_model_list', {
      global_item_id: globalItemId,
    });
  }

  /**
   * 발행 가능한 샵 목록 조회
   */
  async getPublishableShop(globalItemId) {
    return this.request('GET', '/api/v2/global_product/get_publishable_shop', {
      global_item_id: globalItemId,
    });
  }

  /**
   * 글로벌 상품을 샵에 발행
   */
  async publishGlobalItem(globalItemId, shopRegionPublishInfo) {
    return this.request('POST', '/api/v2/global_product/publish_global_item', {
      global_item_id: globalItemId,
      shop_region_publish_info: shopRegionPublishInfo,
    });
  }

  /**
   * 머천트 정보 조회
   */
  async getMerchantInfo() {
    return this.request('GET', '/api/v2/merchant/get_merchant_info');
  }

  /**
   * 주문 목록 조회
   */
  async getOrders(timeFrom, timeTo, status = 'READY_TO_SHIP') {
    return this.shopRequest('GET', '/api/v2/order/get_order_list', {
      time_range_field: 'create_time',
      time_from: timeFrom || Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
      time_to: timeTo || Math.floor(Date.now() / 1000),
      page_size: 100,
      order_status: status,
    });
  }
}

module.exports = ShopeeAPI;
