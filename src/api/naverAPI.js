require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const axios = require('axios');
const bcrypt = require('bcryptjs');

/**
 * 네이버 커머스 API 클래스 (스마트스토어)
 * 네이버 커머스 API를 사용하여 스마트스토어 상품/주문 관리
 * https://apicenter.commerce.naver.com/
 */
class NaverAPI {
  constructor() {
    this.clientId = process.env.NAVER_CLIENT_ID;
    this.clientSecret = process.env.NAVER_CLIENT_SECRET;
    this.accessToken = null;
    this.tokenExpiry = 0;

    this.baseUrl = 'https://api.commerce.naver.com/external';
  }

  /**
   * bcrypt 서명 생성 (네이버 커머스 API 인증)
   * sign = Base64( bcrypt(clientId + "_" + timestamp, clientSecret) )
   */
  generateSignature(timestamp) {
    const password = `${this.clientId}_${timestamp}`;
    const hashed = bcrypt.hashSync(password, this.clientSecret);
    return Buffer.from(hashed).toString('base64');
  }

  /**
   * OAuth 토큰 발급
   */
  async getToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const timestamp = Date.now();
      const signature = this.generateSignature(timestamp);

      const params = new URLSearchParams({
        client_id: this.clientId,
        timestamp: timestamp.toString(),
        client_secret_sign: signature,
        grant_type: 'client_credentials',
        type: 'SELF',
      });

      const response = await axios.post(
        'https://api.commerce.naver.com/external/v1/oauth2/token',
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
      return this.accessToken;
    } catch (error) {
      console.error('네이버 토큰 발급 실패:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * API 요청 실행
   */
  async request(method, path, data = null) {
    try {
      const token = await this.getToken();
      const url = `${this.baseUrl}${path}`;

      const config = {
        method,
        url,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      };

      if (data) config.data = data;

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`네이버 API 오류 [${path}]:`, error.message);
      throw error;
    }
  }

  /**
   * 상품 목록 조회
   */
  async getProducts(page = 1, size = 100) {
    return this.request('POST', '/v1/products/search', {
      page,
      size,
    });
  }

  /**
   * 상품 상세 조회
   */
  async getProductDetail(channelProductNo) {
    return this.request('GET', `/v2/products/channel-products/${channelProductNo}`);
  }

  /**
   * 상품 가격 수정
   */
  async updatePrice(channelProductNo, originProductNo, price) {
    return this.request('PUT', `/v2/products/origin-products/${originProductNo}`, {
      originProduct: {
        salePrice: price,
      },
    });
  }

  /**
   * 재고 수정
   */
  async updateStock(originProductNo, stockQuantity) {
    return this.request('PUT', `/v2/products/origin-products/${originProductNo}`, {
      originProduct: {
        stockQuantity: stockQuantity,
      },
    });
  }

  /**
   * 카테고리 검색 (키워드 기반)
   */
  async searchCategories(query) {
    try {
      const token = await this.getToken();
      // 네이버 커머스 카테고리 검색 API
      const url = `${this.baseUrl}/v1/categories?query=${encodeURIComponent(query)}`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const categories = (response.data || []).map(cat => ({
        id: String(cat.id || cat.categoryId),
        name: cat.wholeCategoryName || cat.name || '',
      }));
      return categories;
    } catch (error) {
      // 카테고리 검색 API가 없으면 빈 배열
      console.error('네이버 카테고리 검색:', error.response?.status, error.response?.data?.message || error.message);
      return [];
    }
  }

  /**
   * 상품 등록
   */
  async createProduct({ productName, salePrice, stockQuantity, categoryId, detailContent, imageUrls }) {
    try {
      const productData = {
        originProduct: {
          statusType: 'SALE',
          saleType: 'NEW',
          leafCategoryId: categoryId || '50000803',
          name: productName,
          detailContent: detailContent || `<p>${productName}</p>`,
          saleStartDate: new Date().toISOString(),
          salePrice: parseInt(salePrice),
          stockQuantity: parseInt(stockQuantity) || 1,
          deliveryInfo: {
            deliveryType: 'DELIVERY',
            deliveryAttributeType: 'NORMAL',
            deliveryFee: { deliveryFeeType: 'FREE', baseFee: 0 },
          },
          detailAttribute: {
            naverShoppingSearchInfo: { manufacturerName: 'PMC' },
            afterServiceInfo: {
              afterServiceTelephoneNumber: '010-0000-0000',
              afterServiceGuideContent: 'AS 문의',
            },
            originAreaInfo: {
              originAreaCode: '0200037',
              importer: 'PMC Corporation',
            },
          },
        },
        smartstoreChannelProduct: {
          channelProductName: productName,
        },
      };

      if (imageUrls && imageUrls.length > 0) {
        productData.originProduct.images = {
          representativeImage: { url: imageUrls[0] },
        };
      }

      const result = await this.request('POST', '/v2/products', productData);
      return {
        success: true,
        originProductNo: result.originProductNo || result.id,
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * 주문 목록 조회 (최근 변경 주문)
   */
  async getOrders(lastChangedFrom = null) {
    const now = new Date();
    const from = lastChangedFrom || new Date(now.getTime() - 7 * 86400000).toISOString();
    const qs = `?lastChangedFrom=${encodeURIComponent(from)}`;
    return this.request('GET', `/v1/pay-order/seller/product-orders/last-changed-statuses${qs}`);
  }

  /**
   * 주문 상세 조회 (productOrderIds 기반)
   */
  async getOrderDetails(productOrderIds) {
    return this.request('POST', `/v1/pay-order/seller/product-orders/query`, {
      productOrderIds,
    });
  }

  /**
   * 발주/발송 처리
   */
  async shipOrder(productOrderId, deliveryCompany, trackingNumber) {
    return this.request('POST', `/v1/pay-order/seller/product-orders/${productOrderId}/ship`, {
      deliveryMethod: {
        deliveryCompanyCode: deliveryCompany,
        trackingNumber: trackingNumber,
      },
    });
  }

  /**
   * 매출 요약 (주문 기반, 최근 N일)
   */
  async getRevenueSummary(days = 30) {
    const now = new Date();
    const WINDOW_DAYS = 1; // 1-day windows to capture today/yesterday without API page truncation
    const seenOrderIds = new Set();
    const allOrderIds = [];

    // Collect productOrderIds across all windows
    for (let offset = 0; offset < days; offset += WINDOW_DAYS) {
      const windowStart = new Date(now.getTime() - Math.min(offset + WINDOW_DAYS, days) * 86400000);
      try {
        const result = await this.getOrders(windowStart.toISOString());
        const statuses = result?.data?.lastChangeStatuses || [];
        for (const s of statuses) {
          if (s.productOrderId && !seenOrderIds.has(s.productOrderId)) {
            seenOrderIds.add(s.productOrderId);
            allOrderIds.push(s.productOrderId);
          }
        }
      } catch (e) {
        if (e.response?.status === 429) break; // stop on rate limit
        console.warn(`Naver window ${offset}d error:`, e.message);
      }
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    if (allOrderIds.length === 0) {
      return { totalRevenue: 0, orderCount: 0, currency: 'KRW', period: `${days}days`, dailySales: {} };
    }

    // Fetch order details in batches of 300
    let allDetails = [];
    for (let i = 0; i < allOrderIds.length; i += 300) {
      const batch = allOrderIds.slice(i, i + 300);
      try {
        const details = await this.getOrderDetails(batch);
        const items = details?.data || [];
        allDetails.push(...(Array.isArray(items) ? items : []));
      } catch (e) {
        console.error('Naver 주문 상세 조회 실패:', e.message);
      }
    }

    // Aggregate revenue by day
    let totalRevenue = 0;
    const dailySales = {};
    allDetails.forEach(item => {
      const po = item.productOrder || {};
      const amount = po.totalPaymentAmount || po.unitPrice || 0;
      totalRevenue += amount;

      const date = (po.placeOrderDate || item.order?.paymentDate || '').split('T')[0] || 'unknown';
      if (!dailySales[date]) dailySales[date] = { revenue: 0, orders: 0 };
      dailySales[date].revenue += amount;
      dailySales[date].orders++;
    });

    return {
      totalRevenue,
      orderCount: allDetails.length,
      currency: 'KRW',
      period: `${days}days`,
      dailySales,
    };
  }
}

module.exports = NaverAPI;
