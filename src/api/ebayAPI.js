require('dotenv').config({ path: '../../config/.env' });
const axios = require('axios');

/**
 * eBay API 연동 클래스 (Trading API 직접 호출)
 */
class EbayAPI {
  constructor() {
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.devId = process.env.EBAY_DEV_ID;
    this.userToken = process.env.EBAY_USER_TOKEN;
    this.environment = process.env.EBAY_ENVIRONMENT || 'PRODUCTION';

    this.apiUrl = this.environment === 'PRODUCTION'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';

    this.siteId = '0'; // US
    this.version = '1355';
  }

  /**
   * Trading API 호출 (OAuth 토큰 지원)
   */
  async callTradingAPI(callName, requestBody = {}) {
    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': this.version,
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': this.siteId,
      'Content-Type': 'text/xml'
    };

    // OAuth 토큰 감지 (v^1.1로 시작하는 긴 토큰)
    const isOAuthToken = this.userToken && this.userToken.length > 200;

    let xml;
    if (isOAuthToken) {
      // OAuth 토큰: IAF 헤더 사용
      headers['X-EBAY-API-IAF-TOKEN'] = this.userToken;
      xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  ${requestBody}
</${callName}Request>`;
    } else {
      // Auth'n'Auth 토큰: RequesterCredentials 사용
      xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.userToken}</eBayAuthToken>
  </RequesterCredentials>
  ${requestBody}
</${callName}Request>`;
    }

    try {
      const response = await axios.post(this.apiUrl, xml, { headers });
      return response.data;
    } catch (error) {
      throw new Error(`eBay API Error: ${error.message}`);
    }
  }

  /**
   * 연결 테스트
   */
  async testConnection() {
    try {
      if (!this.userToken) {
        console.log('⚠️  User Token이 설정되지 않았습니다.');
        return false;
      }

      const response = await this.callTradingAPI('GetUser');

      // XML 파싱 (간단하게 정규식 사용)
      const userIdMatch = response.match(/<UserID>(.*?)<\/UserID>/);
      const userId = userIdMatch ? userIdMatch[1] : 'Unknown';

      console.log('✅ eBay API 연결 성공!');
      console.log(`   사용자: ${userId}`);
      console.log(`   환경: ${this.environment}`);
      return true;
    } catch (error) {
      console.error('❌ eBay API 연결 실패:', error.message);
      return false;
    }
  }

  /**
   * 활성 리스팅 가져오기
   */
  async getActiveListings(pageNumber = 1, entriesPerPage = 100) {
    try {
      const requestBody = `
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>`;

      const response = await this.callTradingAPI('GetMyeBaySelling', requestBody);

      // XML 파싱
      const items = this.parseActiveListings(response);
      const totalPagesMatch = response.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
      const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1;

      console.log(`📄 페이지 ${pageNumber}/${totalPages}: ${items.length}개 상품`);

      return {
        items,
        totalPages,
        hasMore: pageNumber < totalPages
      };
    } catch (error) {
      console.error('❌ 리스팅 조회 실패:', error.message);
      return { items: [], totalPages: 0, hasMore: false };
    }
  }

  /**
   * XML에서 활성 리스팅 파싱
   */
  parseActiveListings(xml) {
    const items = [];
    const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];

      const item = {
        itemId: this.extractValue(itemXml, 'ItemID'),
        sku: this.extractValue(itemXml, 'SKU'),
        title: this.extractValue(itemXml, 'Title'),
        price: this.extractValue(itemXml, 'CurrentPrice'),
        quantity: this.extractValue(itemXml, 'Quantity'),
        quantitySold: this.extractValue(itemXml, 'QuantitySold'),
        listingType: this.extractValue(itemXml, 'ListingType'),
        viewUrl: this.extractValue(itemXml, 'ViewItemURL'),
        imageUrl: this.extractValue(itemXml, 'GalleryURL')
      };

      items.push(item);
    }

    return items;
  }

  /**
   * XML에서 값 추출
   */
  extractValue(xml, tagName) {
    const regex = new RegExp(`<${tagName}>(.*?)<\/${tagName}>`);
    const match = xml.match(regex);
    return match ? match[1] : '';
  }

  /**
   * 모든 페이지의 리스팅 가져오기
   */
  async getAllActiveListings() {
    try {
      let allItems = [];
      let pageNumber = 1;
      let hasMore = true;

      while (hasMore) {
        const result = await this.getActiveListings(pageNumber);
        allItems = allItems.concat(result.items);
        hasMore = result.hasMore;
        pageNumber++;

        if (hasMore) {
          await this.sleep(500);
        }
      }

      console.log(`✅ 총 ${allItems.length}개 eBay 리스팅 로드 완료`);
      return allItems;
    } catch (error) {
      console.error('❌ 전체 리스팅 조회 실패:', error.message);
      return [];
    }
  }

  /**
   * 대기 함수
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI 테스트
async function testEbayAPI() {
  console.log('=== eBay API 테스트 ===\n');

  const ebay = new EbayAPI();

  // 연결 테스트
  const isConnected = await ebay.testConnection();

  if (!isConnected) {
    console.log('\n⚠️  eBay Developer Portal에서 User Token을 발급받으세요:');
    console.log('   https://developer.ebay.com/my/keys\n');
    return;
  }

  // 상품 목록 조회
  console.log('\n📦 활성 리스팅 조회 중...\n');
  const listings = await ebay.getAllActiveListings();

  if (listings.length > 0) {
    console.log(`\n샘플 상품 (처음 3개):\n`);
    listings.slice(0, 3).forEach((item, index) => {
      console.log(`${index + 1}. ${item.title}`);
      console.log(`   SKU: ${item.sku}`);
      console.log(`   가격: $${item.price}`);
      console.log(`   수량: ${item.quantity}`);
      console.log(`   판매: ${item.quantitySold}개\n`);
    });
  } else {
    console.log('\n⚠️  활성 리스팅이 없습니다.\n');
  }
}

if (require.main === module) {
  testEbayAPI();
}

module.exports = EbayAPI;
