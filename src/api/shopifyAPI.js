require('../config');
const axios = require('axios');

/**
 * Shopify Admin API 클래스
 * REST Admin API를 사용하여 Shopify 상품 데이터를 관리
 */
class ShopifyAPI {
  constructor() {
    this.storeUrl = process.env.SHOPIFY_STORE_URL;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';

    if (!this.storeUrl || !this.accessToken) {
      throw new Error('Shopify credentials not found in .env file');
    }

    this.baseUrl = `https://${this.storeUrl}/admin/api/${this.apiVersion}`;
  }

  /**
   * API 요청 헤더 생성
   */
  getHeaders() {
    return {
      'X-Shopify-Access-Token': this.accessToken,
      'Content-Type': 'application/json',
    };
  }

  /**
   * 모든 상품 가져오기 (페이지네이션 처리)
   * @param {number} limit - 한 번에 가져올 상품 수 (최대 250)
   * @returns {Promise<Array>} 모든 상품 배열
   */
  async getAllProducts(limit = 250) {
    try {
      let allProducts = [];
      let url = `${this.baseUrl}/products.json?limit=${limit}`;

      console.log('🔄 Shopify에서 상품 데이터 가져오는 중...');

      while (url) {
        const response = await axios.get(url, { headers: this.getHeaders() });
        const products = response.data.products;

        allProducts = allProducts.concat(products);
        console.log(`   📦 ${allProducts.length}개 상품 로드됨...`);

        // 다음 페이지 URL 확인 (Link 헤더 사용)
        const linkHeader = response.headers.link;
        url = this.getNextPageUrl(linkHeader);

        // Rate limiting 방지 (0.5초 대기)
        if (url) {
          await this.sleep(500);
        }
      }

      console.log(`✅ 총 ${allProducts.length}개의 상품을 가져왔습니다.`);
      return allProducts;

    } catch (error) {
      console.error('❌ Shopify 상품 가져오기 실패:', error.message);
      if (error.response) {
        console.error('   상태 코드:', error.response.status);
        console.error('   응답:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Link 헤더에서 다음 페이지 URL 추출
   */
  getNextPageUrl(linkHeader) {
    if (!linkHeader) return null;

    const links = linkHeader.split(',');
    for (const link of links) {
      if (link.includes('rel="next"')) {
        const match = link.match(/<([^>]+)>/);
        return match ? match[1] : null;
      }
    }
    return null;
  }

  /**
   * 상품 데이터를 시트 형식으로 변환
   * @param {Array} products - Shopify 상품 배열
   * @returns {Array} [SKU, Title, Price] 형식의 2차원 배열
   */
  formatProductsForSheet(products) {
    const formattedData = [];

    products.forEach(product => {
      // 각 상품의 variant(변형 상품)를 개별 행으로 처리
      product.variants.forEach(variant => {
        const sku = variant.sku || `SHOPIFY-${variant.id}`;
        const title = product.title + (variant.title !== 'Default Title' ? ` - ${variant.title}` : '');
        const price = parseFloat(variant.price);

        formattedData.push([sku, title, price]);
      });
    });

    return formattedData;
  }

  /**
   * 특정 상품 가져오기
   * @param {string} productId - 상품 ID
   */
  async getProduct(productId) {
    try {
      const url = `${this.baseUrl}/products/${productId}.json`;
      const response = await axios.get(url, { headers: this.getHeaders() });
      return response.data.product;
    } catch (error) {
      console.error(`❌ 상품 ${productId} 가져오기 실패:`, error.message);
      throw error;
    }
  }

  /**
   * 상품 수 확인
   */
  async getProductCount() {
    try {
      const url = `${this.baseUrl}/products/count.json`;
      const response = await axios.get(url, { headers: this.getHeaders() });
      return response.data.count;
    } catch (error) {
      console.error('❌ 상품 수 확인 실패:', error.message);
      throw error;
    }
  }

  /**
   * 연결 테스트
   */
  async testConnection() {
    try {
      console.log('\n🔍 Shopify 연결 테스트 중...');
      console.log(`   스토어: ${this.storeUrl}`);
      console.log(`   API 버전: ${this.apiVersion}`);

      const count = await this.getProductCount();
      console.log(`✅ 연결 성공! 총 ${count}개의 상품이 있습니다.`);

      return true;
    } catch (error) {
      console.error('❌ 연결 실패:', error.message);
      return false;
    }
  }

  /**
   * 상품 삭제
   * @param {string} productId - 삭제할 상품 ID
   */
  async deleteProduct(productId) {
    try {
      const url = `${this.baseUrl}/products/${productId}.json`;
      await axios.delete(url, { headers: this.getHeaders() });
      console.log(`   상품 ID ${productId} 삭제 완료`);
      return true;
    } catch (error) {
      console.error(`❌ 상품 ${productId} 삭제 실패:`, error.message);
      throw error;
    }
  }

  /**
   * Sleep 함수 (Rate limiting 방지)
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ShopifyAPI;
