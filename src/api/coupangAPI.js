require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');
const crypto = require('crypto');

/**
 * 쿠팡 WING API 클래스
 * 쿠팡 오픈 API (Wing)를 사용하여 상품, 주문, 재고 관리
 * https://developers.coupangcorp.com/
 */
class CoupangAPI {
  constructor() {
    this.accessKey = process.env.COUPANG_ACCESS_KEY;
    this.secretKey = process.env.COUPANG_SECRET_KEY;
    this.vendorId = process.env.COUPANG_VENDOR_ID;

    this.baseUrl = 'https://api-gateway.coupang.com';
  }

  /**
   * HMAC 서명 생성 (쿠팡 인증 방식)
   */
  generateSignature(method, path, datetime) {
    const message = `${datetime}${method}${path}`;
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(message)
      .digest('hex');
  }

  /**
   * 인증 헤더 생성
   */
  getAuthHeaders(method, path) {
    const datetime = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const signature = this.generateSignature(method, path, datetime);

    return {
      'Content-Type': 'application/json;charset=UTF-8',
      'Authorization': `CEA algorithm=HmacSHA256, access-key=${this.accessKey}, signed-date=${datetime}, signature=${signature}`,
    };
  }

  /**
   * API 요청 실행
   */
  async request(method, path, data = null) {
    try {
      const url = `${this.baseUrl}${path}`;
      const headers = this.getAuthHeaders(method, path);

      const config = { method, url, headers, timeout: 15000 };
      if (data) config.data = data;

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`쿠팡 API 오류 [${path}]:`, error.message);
      throw error;
    }
  }

  /**
   * 상품 목록 조회
   */
  async getProducts(nextToken = null, maxPerPage = 100) {
    let path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products?vendorId=${this.vendorId}&maxPerPage=${maxPerPage}`;
    if (nextToken) path += `&nextToken=${nextToken}`;
    return this.request('GET', path);
  }

  /**
   * 상품 상세 조회
   */
  async getProductDetail(sellerProductId) {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;
    return this.request('GET', path);
  }

  /**
   * 상품 가격 수정
   */
  async updatePrice(sellerProductId, items) {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/prices`;
    return this.request('PUT', path, items);
  }

  /**
   * 재고 수정
   */
  async updateStock(sellerProductId, items) {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/quantities`;
    return this.request('PUT', path, items);
  }

  /**
   * 주문 목록 조회
   */
  async getOrders(status = 'ACCEPT', createdAtFrom = null, createdAtTo = null) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const from = createdAtFrom || weekAgo.toISOString();
    const to = createdAtTo || now.toISOString();

    const path = `/v2/providers/openapi/apis/api/v4/vendors/${this.vendorId}/ordersheets?createdAtFrom=${from}&createdAtTo=${to}&status=${status}`;
    return this.request('GET', path);
  }

  /**
   * 발주 확인 (주문 승인)
   */
  async confirmOrder(shipmentBoxId) {
    const path = `/v2/providers/openapi/apis/api/v4/vendors/${this.vendorId}/ordersheets/${shipmentBoxId}/confirm`;
    return this.request('PUT', path);
  }

  /**
   * 반품 목록 조회
   */
  async getReturns(createdAtFrom = null) {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const from = createdAtFrom || monthAgo.toISOString();

    const path = `/v2/providers/openapi/apis/api/v4/vendors/${this.vendorId}/returnRequests?createdAtFrom=${from}`;
    return this.request('GET', path);
  }
}

module.exports = CoupangAPI;
