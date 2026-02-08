require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');

/**
 * Alibaba/1688 API 클래스
 * Alibaba Open Platform API를 사용하여 소싱 데이터를 관리
 */
class AlibabaAPI {
  constructor() {
    this.appKey = process.env.ALIBABA_APP_KEY;
    this.appSecret = process.env.ALIBABA_APP_SECRET;
    this.accessToken = process.env.ALIBABA_ACCESS_TOKEN;

    // Alibaba.com (국제) 또는 1688.com (중국 내수)
    this.platform = process.env.ALIBABA_PLATFORM || 'international';
    this.baseUrl = this.platform === '1688'
      ? 'https://gw.open.1688.com/openapi'
      : 'https://eco.taobao.com/router/rest';
  }

  /**
   * 상품 검색 (소싱용)
   * @param {string} keyword - 검색 키워드
   * @param {Object} options - 검색 옵션
   */
  async searchProducts(keyword, options = {}) {
    try {
      const {
        page = 1,
        pageSize = 20,
        sortBy = 'price_asc',
        minPrice,
        maxPrice,
      } = options;

      // Alibaba.com Product Search API
      const params = {
        app_key: this.appKey,
        keyword: keyword,
        page_no: page,
        page_size: pageSize,
        sort: sortBy,
      };

      if (minPrice) params.min_price = minPrice;
      if (maxPrice) params.max_price = maxPrice;

      const response = await axios.get(`${this.baseUrl}/product/search`, {
        params,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
        timeout: 15000,
      });

      return response.data;
    } catch (error) {
      console.error('Alibaba 상품 검색 실패:', error.message);
      throw error;
    }
  }

  /**
   * 상품 상세 정보
   * @param {string} productId - 상품 ID
   */
  async getProductDetail(productId) {
    try {
      const response = await axios.get(`${this.baseUrl}/product/detail`, {
        params: {
          app_key: this.appKey,
          product_id: productId,
        },
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
        timeout: 15000,
      });

      return response.data;
    } catch (error) {
      console.error('Alibaba 상품 상세 실패:', error.message);
      throw error;
    }
  }

  /**
   * 공급업체 정보 조회
   * @param {string} supplierId - 공급업체 ID
   */
  async getSupplierInfo(supplierId) {
    try {
      const response = await axios.get(`${this.baseUrl}/supplier/detail`, {
        params: {
          app_key: this.appKey,
          supplier_id: supplierId,
        },
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
        timeout: 15000,
      });

      return response.data;
    } catch (error) {
      console.error('공급업체 정보 조회 실패:', error.message);
      throw error;
    }
  }

  /**
   * 가격 비교 (여러 공급업체)
   * @param {string} keyword - 검색 키워드
   * @param {number} topN - 상위 N개
   */
  async comparePrices(keyword, topN = 10) {
    try {
      const results = await this.searchProducts(keyword, {
        pageSize: topN,
        sortBy: 'price_asc',
      });

      const products = results?.products || results?.data?.products || [];

      return products.map(p => ({
        id: p.product_id || p.id,
        title: p.subject || p.title,
        price: p.price || p.min_price,
        moq: p.moq || p.min_order_quantity,
        supplier: p.supplier_name || p.company_name,
        rating: p.supplier_rating,
        trade_assurance: p.trade_assurance || false,
      }));
    } catch (error) {
      console.error('가격 비교 실패:', error.message);
      throw error;
    }
  }
}

module.exports = AlibabaAPI;
