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
   * 주문 목록 조회
   */
  async getOrders(status = 'PAYED', lastChangedFrom = null) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    return this.request('GET', `/v1/pay-order/seller/product-orders/last-changed-statuses`, {
      params: {
        lastChangedFrom: lastChangedFrom || weekAgo.toISOString(),
      },
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
   * 판매 통계
   */
  async getSalesStats(startDate, endDate) {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    return this.request('GET', `/v1/statistics/channel/sales`, {
      params: {
        startDate: startDate || monthAgo.toISOString().split('T')[0],
        endDate: endDate || now.toISOString().split('T')[0],
      },
    });
  }
}

module.exports = NaverAPI;
