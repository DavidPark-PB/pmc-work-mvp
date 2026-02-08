require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');
const crypto = require('crypto');

/**
 * Shopee Open Platform API 클래스
 * Shopee Partner API를 사용하여 동남아 시장 상품 관리
 * 지원 마켓: SG, MY, TH, PH, VN, ID, TW, BR
 */
class ShopeeAPI {
  constructor() {
    this.partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    this.partnerKey = process.env.SHOPEE_PARTNER_KEY;
    this.shopId = parseInt(process.env.SHOPEE_SHOP_ID);
    this.accessToken = process.env.SHOPEE_ACCESS_TOKEN;
    this.refreshToken = process.env.SHOPEE_REFRESH_TOKEN;

    this.baseUrl = process.env.SHOPEE_ENV === 'test'
      ? 'https://partner.test-stable.shopeemobile.com'
      : 'https://partner.shopeemobile.com';
  }

  /**
   * API 서명 생성 (HMAC-SHA256)
   */
  generateSignature(path, timestamp) {
    const baseString = `${this.partnerId}${path}${timestamp}${this.accessToken}${this.shopId}`;
    return crypto.createHmac('sha256', this.partnerKey).update(baseString).digest('hex');
  }

  /**
   * API 요청 실행
   */
  async request(method, path, data = null) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.generateSignature(path, timestamp);

    const url = `${this.baseUrl}${path}`;
    const params = {
      partner_id: this.partnerId,
      timestamp: timestamp,
      sign: sign,
      shop_id: this.shopId,
      access_token: this.accessToken,
    };

    try {
      const config = {
        method,
        url,
        params,
        timeout: 15000,
      };

      if (data && method !== 'GET') {
        config.data = data;
        config.headers = { 'Content-Type': 'application/json' };
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`Shopee API 오류 [${path}]:`, error.message);
      throw error;
    }
  }

  /**
   * 상품 목록 조회
   */
  async getProducts(offset = 0, pageSize = 50, status = 'NORMAL') {
    return this.request('GET', '/api/v2/product/get_item_list', null, {
      offset,
      page_size: pageSize,
      item_status: status,
    });
  }

  /**
   * 상품 상세 정보
   */
  async getProductDetail(itemId) {
    return this.request('GET', '/api/v2/product/get_item_base_info', null, {
      item_id_list: itemId,
    });
  }

  /**
   * 상품 가격 수정
   */
  async updatePrice(itemId, modelId, price) {
    return this.request('POST', '/api/v2/product/update_price', {
      item_id: itemId,
      price_list: [{
        model_id: modelId || 0,
        original_price: price,
      }],
    });
  }

  /**
   * 재고 수정
   */
  async updateStock(itemId, modelId, stock) {
    return this.request('POST', '/api/v2/product/update_stock', {
      item_id: itemId,
      stock_list: [{
        model_id: modelId || 0,
        normal_stock: stock,
      }],
    });
  }

  /**
   * 주문 목록 조회
   */
  async getOrders(timeFrom, timeTo, status = 'READY_TO_SHIP') {
    return this.request('GET', '/api/v2/order/get_order_list', null, {
      time_range_field: 'create_time',
      time_from: timeFrom || Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
      time_to: timeTo || Math.floor(Date.now() / 1000),
      page_size: 100,
      order_status: status,
    });
  }

  /**
   * 카테고리 목록
   */
  async getCategories(language = 'en') {
    return this.request('GET', '/api/v2/product/get_category', null, {
      language,
    });
  }
}

module.exports = ShopeeAPI;
