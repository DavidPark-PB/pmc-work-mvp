require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');

/**
 * Qoo10 Japan API 클래스
 * Qoo10 QSM (Qoo10 Shop Management) API를 사용하여 일본 시장 상품 관리
 */
class Qoo10API {
  constructor() {
    this.apiKey = process.env.QOO10_API_KEY;
    this.userId = process.env.QOO10_USER_ID;
    this.userPassword = process.env.QOO10_USER_PASSWORD;

    // Qoo10 Japan API
    this.baseUrl = 'https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebaaboratory.qapi';
  }

  /**
   * API 요청 실행
   */
  async request(method, params = {}) {
    try {
      const queryParams = {
        method,
        key: this.apiKey,
        ...params,
      };

      const response = await axios.get(this.baseUrl, {
        params: queryParams,
        timeout: 15000,
      });

      return response.data;
    } catch (error) {
      console.error(`Qoo10 API 오류 [${method}]:`, error.message);
      throw error;
    }
  }

  /**
   * 전체 상품 목록 조회
   */
  async getProducts(page = 1, pageSize = 100) {
    return this.request('ItemsLookup.GetAllGoodsInfo', {
      Page: page,
      PageSize: pageSize,
    });
  }

  /**
   * 상품 상세 정보
   */
  async getProductDetail(itemCode) {
    return this.request('ItemsLookup.GetItemDetailInfo', {
      ItemCode: itemCode,
    });
  }

  /**
   * 상품 가격 수정
   */
  async updatePrice(itemCode, price, taxRate = 10) {
    return this.request('ItemsOrder.SetGoodsPriceInfo', {
      ItemCode: itemCode,
      ItemPrice: price,
      TaxRate: taxRate,
    });
  }

  /**
   * 재고 수정
   */
  async updateStock(itemCode, quantity) {
    return this.request('ItemsOrder.SetGoodsStockInfo', {
      ItemCode: itemCode,
      StockQty: quantity,
    });
  }

  /**
   * 주문 목록 조회
   */
  async getOrders(startDate, endDate, status = 1) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    return this.request('ShippingBasic.GetShippingInfo_v2', {
      ShippingStat: status,
      search_Sdate: startDate || weekAgo.toISOString().split('T')[0],
      search_Edate: endDate || now.toISOString().split('T')[0],
    });
  }

  /**
   * 상품 등록
   */
  async createProduct(productData) {
    return this.request('ItemsBasic.InsertGoodsInfo', {
      ItemTitle: productData.title,
      PromotionName: productData.promotionName || productData.title,
      SellerCode: productData.sku,
      ItemPrice: productData.price,
      ItemQty: productData.quantity || 100,
      ShippingNo: productData.shippingNo || 0,
      ItemDetail: productData.description,
      ...productData.extra,
    });
  }

  /**
   * 판매 현황 조회
   */
  async getSalesSummary(days = 30) {
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    return this.request('ClaimBasic.GetSalesStatInfo', {
      search_Sdate: startDate.toISOString().split('T')[0],
      search_Edate: now.toISOString().split('T')[0],
    });
  }
}

module.exports = Qoo10API;
