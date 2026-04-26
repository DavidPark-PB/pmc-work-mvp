require('../config');
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
    this.refreshToken = process.env.EBAY_REFRESH_TOKEN;
    this.environment = process.env.EBAY_ENVIRONMENT || 'PRODUCTION';

    this.apiUrl = this.environment === 'PRODUCTION'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';

    this.oauthUrl = this.environment === 'PRODUCTION'
      ? 'https://api.ebay.com/identity/v1/oauth2/token'
      : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';

    this.siteId = '0'; // US
    this.version = '1355';
    this._tokenRefreshed = false;
    this._appToken = null; // Shopping API용 application token
    this._appTokenExpiry = 0;
  }

  /**
   * Application Token 발급 (Shopping API용, client_credentials grant)
   */
  async getApplicationToken() {
    // 캐시된 토큰이 아직 유효하면 재사용
    if (this._appToken && Date.now() < this._appTokenExpiry) {
      return this._appToken;
    }

    const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
    const scope = 'https://api.ebay.com/oauth/api_scope';

    try {
      const response = await axios.post(this.oauthUrl,
        `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`,
          },
        }
      );

      this._appToken = response.data.access_token;
      this._appTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
      console.log('eBay Application Token 발급 성공 (expires_in:', response.data.expires_in + 's)');
      return this._appToken;
    } catch (error) {
      const errData = error.response?.data;
      console.error('eBay Application Token 발급 실패:', errData?.error_description || error.message);
      throw error;
    }
  }

  /**
   * OAuth 토큰 자동 갱신 (refresh_token 사용)
   */
  async refreshAccessToken() {
    if (!this.refreshToken || !this.appId || !this.certId) {
      throw new Error('Refresh token 또는 App credentials 없음');
    }

    const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');
    const scopes = [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    ].join(' ');

    try {
      const response = await axios.post(this.oauthUrl,
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}&scope=${encodeURIComponent(scopes)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${credentials}`,
          },
        }
      );

      this.userToken = response.data.access_token;
      this._tokenRefreshed = true;
      console.log('eBay OAuth 토큰 갱신 성공 (expires_in:', response.data.expires_in + 's)');
      return this.userToken;
    } catch (error) {
      const errData = error.response?.data;
      console.error('eBay 토큰 갱신 실패:', errData?.error_description || error.message);
      throw error;
    }
  }

  /**
   * Trading API 호출 (OAuth 토큰 지원 + 자동 갱신)
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
      const data = response.data;

      // 토큰 만료/무효 감지 → 자동 갱신 후 재시도 (1회)
      const isTokenInvalid = typeof data === 'string' && (
        data.includes('token is hard expired') ||
        data.includes('Expired IAF token') ||
        data.includes('Auth token is invalid') ||
        data.includes('<ErrorCode>931</ErrorCode>')
      );
      if (!this._tokenRefreshed && isTokenInvalid && this.refreshToken) {
        console.log('eBay 토큰 무효/만료 감지, 자동 갱신 시도...');
        const newToken = await this.refreshAccessToken();
        process.env.EBAY_USER_TOKEN = newToken;
        this.userToken = newToken;
        // 갱신된 토큰으로 재시도
        return this.callTradingAPI(callName, requestBody);
      }

      this._tokenRefreshed = false; // 다음 호출을 위해 리셋
      return data;
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
      const totalEntriesMatch = response.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
      const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1;
      const totalEntries = totalEntriesMatch ? parseInt(totalEntriesMatch[1]) : items.length;

      console.log(`📄 페이지 ${pageNumber}/${totalPages}: ${items.length}개 상품 (총 ${totalEntries})`);

      return {
        items,
        totalPages,
        totalEntries,
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

      // GetMyeBaySelling returns WRONG shipping costs (transaction-based, not listing setting).
      // 이전엔 $3.90 으로 하드코딩 → 사장님이 4.90 으로 바꿔도 sync 시 덮어쓰기 됨.
      // 이제 null 로 두고 productSync 가 shipping_usd 를 omit → 기존 DB 값 유지.
      // 정확한 값은 /api/battle/listing/:itemId/refresh (Browse API) 로 갱신.
      const shippingCost = null;

      // Extract price from <SellingStatus><CurrentPrice> only (not from transactions)
      const sellingStatusMatch = itemXml.match(/<SellingStatus>[\s\S]*?<CurrentPrice[^>]*>([\d.]+)<\/CurrentPrice>/);
      const accuratePrice = sellingStatusMatch ? sellingStatusMatch[1] : this.extractValue(itemXml, 'CurrentPrice');

      const item = {
        itemId: this.extractValue(itemXml, 'ItemID'),
        sku: this.extractValue(itemXml, 'SKU'),
        title: this.extractValue(itemXml, 'Title'),
        price: accuratePrice,
        quantity: this.extractValue(itemXml, 'Quantity'),
        quantitySold: this.extractValue(itemXml, 'QuantitySold'),
        shippingCost,
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
    const regex = new RegExp(`<${tagName}[^>]*>(.*?)<\/${tagName}>`);
    const match = xml.match(regex);
    return match ? match[1] : '';
  }

  /**
   * 가격/수량 수정 (ReviseInventoryStatus → 실패시 ReviseFixedPriceItem fallback)
   */
  async updateItem(itemId, { price, quantity }) {
    try {
      let inventoryFields = `<ItemID>${itemId}</ItemID>`;
      if (price !== undefined) inventoryFields += `<StartPrice>${price}</StartPrice>`;
      if (quantity !== undefined) inventoryFields += `<Quantity>${quantity}</Quantity>`;

      const requestBody = `<InventoryStatus>${inventoryFields}</InventoryStatus>`;
      const response = await this.callTradingAPI('ReviseInventoryStatus', requestBody);

      const ackMatch = response.match(/<Ack>(.*?)<\/Ack>/);
      const ack = ackMatch ? ackMatch[1] : 'Unknown';

      if (ack === 'Success' || ack === 'Warning') {
        return { success: true };
      }

      // Multi-SKU 아이템인 경우 ReviseFixedPriceItem으로 재시도
      const errMatch = response.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      const errMsg = errMatch ? errMatch[1] : '';
      if (errMsg.includes('Multi-SKU') || errMsg.includes('multi-SKU')) {
        console.log(`Multi-SKU 감지 (${itemId}), ReviseFixedPriceItem으로 재시도...`);
        return this.updateItemPrice(itemId, price);
      }

      return { success: false, error: errMsg || 'Unknown error' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 가격 수정 (ReviseFixedPriceItem - Multi-SKU 호환)
   */
  async updateItemPrice(itemId, price) {
    try {
      const requestBody = `
  <Item>
    <ItemID>${itemId}</ItemID>
    <StartPrice>${price}</StartPrice>
  </Item>`;
      const response = await this.callTradingAPI('ReviseFixedPriceItem', requestBody);

      const ackMatch = response.match(/<Ack>(.*?)<\/Ack>/);
      const ack = ackMatch ? ackMatch[1] : 'Unknown';

      if (ack === 'Success' || ack === 'Warning') {
        return { success: true };
      } else {
        const errMatch = response.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
        return { success: false, error: errMatch ? errMatch[1] : 'Unknown error' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 카테고리 추천 검색 (GetSuggestedCategories)
   */
  async getSuggestedCategories(query) {
    try {
      const requestBody = `<Query>${this.escapeXml(query)}</Query>`;
      const response = await this.callTradingAPI('GetSuggestedCategories', requestBody);

      const categories = [];
      const catRegex = /<SuggestedCategory>([\s\S]*?)<\/SuggestedCategory>/g;
      let match;
      while ((match = catRegex.exec(response)) !== null) {
        const block = match[1];
        const catId = this.extractValue(block, 'CategoryID');
        const catName = this.extractValue(block, 'CategoryName');

        // 카테고리 경로 추출
        const parentNames = [];
        const parentRegex = /<CategoryName>(.*?)<\/CategoryName>/g;
        let pm;
        while ((pm = parentRegex.exec(block)) !== null) {
          parentNames.push(pm[1]);
        }
        const fullPath = parentNames.length > 0 ? parentNames.join(' > ') : catName;

        if (catId) {
          categories.push({ id: catId, name: fullPath || catName, percentFound: this.extractValue(block, 'PercentItemFound') });
        }
      }
      return categories;
    } catch (error) {
      console.error('eBay 카테고리 검색 실패:', error.message);
      return [];
    }
  }

  /**
   * XML 특수문자 이스케이프
   */
  escapeXml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /**
   * 상품 등록 (AddFixedPriceItem)
   */
  async createProduct({ title, description, price, quantity, sku, categoryId, conditionId, imageUrls, imageUrl, currency, itemSpecifics }) {
    try {
      // Build PictureDetails with multiple images
      const allImages = imageUrls || (imageUrl ? [imageUrl] : []);
      const pictureXml = allImages.length > 0
        ? `<PictureDetails>${allImages.map(u => `<PictureURL>${this.escapeXml(u)}</PictureURL>`).join('')}</PictureDetails>`
        : '';

      // Build ItemSpecifics XML
      const specs = itemSpecifics || {};
      const specsEntries = Object.entries(specs);
      const specsXml = specsEntries.length > 0
        ? `<ItemSpecifics>${specsEntries.map(([k, v]) => `<NameValueList><Name>${this.escapeXml(k)}</Name><Value>${this.escapeXml(String(v))}</Value></NameValueList>`).join('')}</ItemSpecifics>`
        : '';

      const requestBody = `
  <Item>
    <Title>${this.escapeXml(title)}</Title>
    <Description><![CDATA[${description || title}]]></Description>
    <PrimaryCategory>
      <CategoryID>${categoryId || '11450'}</CategoryID>
    </PrimaryCategory>
    <StartPrice currencyID="${currency || 'USD'}">${price}</StartPrice>
    <ConditionID>${conditionId || '1000'}</ConditionID>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <Country>KR</Country>
    <Location>Seoul, Korea</Location>
    <PostalCode>06164</PostalCode>
    <Currency>${currency || 'USD'}</Currency>
    <DispatchTimeMax>3</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Quantity>${quantity || 1}</Quantity>
    ${sku ? `<SKU>${this.escapeXml(sku)}</SKU>` : ''}
    <SellerProfiles>
      <SellerShippingProfile>
        <ShippingProfileID>${process.env.EBAY_SHIPPING_PROFILE_ID || '281980037014'}</ShippingProfileID>
      </SellerShippingProfile>
      <SellerReturnProfile>
        <ReturnProfileID>${process.env.EBAY_RETURN_PROFILE_ID || '266278678014'}</ReturnProfileID>
      </SellerReturnProfile>
      <SellerPaymentProfile>
        <PaymentProfileID>${process.env.EBAY_PAYMENT_PROFILE_ID || '266278202014'}</PaymentProfileID>
      </SellerPaymentProfile>
    </SellerProfiles>
    ${specsXml}
    ${pictureXml}
  </Item>`;

      const response = await this.callTradingAPI('AddFixedPriceItem', requestBody);
      console.log('[eBay createProduct] response:', response.substring(0, 3000));
      const ackMatch = response.match(/<Ack>(.*?)<\/Ack>/);
      const ack = ackMatch ? ackMatch[1] : 'Unknown';
      const itemIdMatch = response.match(/<ItemID>(.*?)<\/ItemID>/);

      if (ack === 'Success' || ack === 'Warning') {
        console.log('[eBay createProduct] SUCCESS itemId:', itemIdMatch ? itemIdMatch[1] : 'NONE');
        return { success: true, itemId: itemIdMatch ? itemIdMatch[1] : null };
      } else {
        const longMatch = response.match(/<LongMessage>(.*?)<\/LongMessage>/);
        const errMatch = response.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
        const errMsg = longMatch ? longMatch[1] : (errMatch ? errMatch[1] : 'Unknown error');
        console.log('[eBay createProduct] FAILED:', errMsg);
        return { success: false, error: errMsg };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
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
   * GetOrders with OrderStatus=Active — 배송 대기 주문 전체 (시간 제한 없음)
   * GetSellerTransactions은 최근 N일만 조회하지만, 이 API는 현재 미배송 주문을 전부 가져옴
   */
  async getAwaitingShipmentOrders() {
    const allOrders = [];
    let pageNumber = 1;

    // eBay GetOrders requires a date filter (max 30 days for ModTime).
    // AwaitingShipment orders are always recent — 30 days covers all practical cases.
    const modTimeFrom = new Date(Date.now() - 30 * 86400000).toISOString();
    const modTimeTo = new Date().toISOString();

    try {
      while (true) {
        const requestBody = `
<ModTimeFrom>${modTimeFrom}</ModTimeFrom>
<ModTimeTo>${modTimeTo}</ModTimeTo>
<OrderStatus>AwaitingShipment</OrderStatus>
<DetailLevel>ReturnAll</DetailLevel>
<Pagination>
  <EntriesPerPage>100</EntriesPerPage>
  <PageNumber>${pageNumber}</PageNumber>
</Pagination>`;

        const response = await this.callTradingAPI('GetOrders', requestBody);

        const ackMatch = response.match(/<Ack>(.*?)<\/Ack>/);
        if (!ackMatch || (ackMatch[1] !== 'Success' && ackMatch[1] !== 'Warning')) {
          const errMsg = this.extractValue(response, 'ShortMessage') || this.extractValue(response, 'LongMessage');
          if (errMsg) console.warn('GetOrders:', errMsg);
          break;
        }

        const orderRegex = /<Order>([\s\S]*?)<\/Order>/g;
        let match;
        while ((match = orderRegex.exec(response)) !== null) {
          const order = match[1];
          const addrMatch = order.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/);
          const addr = addrMatch ? addrMatch[1] : '';

          // TransactionArray에서 첫 번째 Transaction의 Item 정보 추출
          const txnMatch = order.match(/<Transaction>([\s\S]*?)<\/Transaction>/);
          const txn = txnMatch ? txnMatch[1] : '';
          const itemMatch = txn.match(/<Item>([\s\S]*?)<\/Item>/);
          const item = itemMatch ? itemMatch[1] : '';

          allOrders.push({
            ebayOrderId: this.extractValue(order, 'OrderID'),
            createdDate: this.extractValue(order, 'CreatedTime'),
            buyerUserId: this.extractValue(order, 'BuyerUserID') || '',
            buyerEmail: this.extractValue(order, 'BuyerEmail') || '',
            price: parseFloat(this.extractValue(order, 'Total') || '0'),
            quantity: parseInt(this.extractValue(txn, 'QuantityPurchased') || '1'),
            title: this.extractValue(item, 'Title') || '',
            sku: this.extractValue(txn, 'SKU') || this.extractValue(item, 'SKU') || '',
            itemId: this.extractValue(item, 'ItemID') || '',
            shippingName: this.extractValue(addr, 'Name'),
            shippingStreet: [this.extractValue(addr, 'Street1'), this.extractValue(addr, 'Street2')].filter(Boolean).join(' '),
            shippingCity: this.extractValue(addr, 'CityName'),
            shippingState: this.extractValue(addr, 'StateOrProvince'),
            shippingZip: this.extractValue(addr, 'PostalCode'),
            shippingCountry: this.extractValue(addr, 'Country'),
            shippingPhone: this.extractValue(addr, 'Phone'),
          });
        }

        const totalPages = parseInt(response.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] || '1');
        if (pageNumber >= totalPages) break;
        pageNumber++;
      }
    } catch (err) {
      throw new Error(`getAwaitingShipmentOrders 실패: ${err.message}`);
    }

    return allOrders;
  }

  /**
   * 판매 트랜잭션 조회 (GetSellerTransactions)
   * 실제 판매된 주문/거래 데이터
   * @param {number} days - 최근 N일 (최대 30일)
   */
  async getSellerTransactions(days = 30) {
    try {
      const now = new Date();
      const from = new Date(now.getTime() - Math.min(days, 30) * 86400000);
      const allTransactions = [];
      let pageNumber = 1;
      let apiError = null;

      while (true) {
        const requestBody = `
  <ModTimeFrom>${from.toISOString()}</ModTimeFrom>
  <ModTimeTo>${now.toISOString()}</ModTimeTo>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${pageNumber}</PageNumber>
  </Pagination>
  <IncludeContainingOrder>true</IncludeContainingOrder>`;

        const response = await this.callTradingAPI('GetSellerTransactions', requestBody);

        const ackMatch = response.match(/<Ack>(.*?)<\/Ack>/);
        if (!ackMatch || (ackMatch[1] !== 'Success' && ackMatch[1] !== 'Warning')) {
          const errMsg = this.extractValue(response, 'ShortMessage') || this.extractValue(response, 'LongMessage');
          if (errMsg) {
            console.error('eBay GetSellerTransactions:', errMsg);
            apiError = errMsg;
          }
          break;
        }

        // 트랜잭션 파싱
        const txnRegex = /<Transaction>([\s\S]*?)<\/Transaction>/g;
        let match;
        while ((match = txnRegex.exec(response)) !== null) {
          const txn = match[1];

          // ContainingOrder에서 실제 eBay 주문번호 + 배송주소 추출
          const orderMatch = txn.match(/<ContainingOrder>([\s\S]*?)<\/ContainingOrder>/);
          const orderBlock = orderMatch ? orderMatch[1] : '';

          // 배송 주소: ContainingOrder > ShippingAddress 우선, 없으면 Transaction 내 첫 ShippingAddress
          const orderAddrMatch = orderBlock ? orderBlock.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/) : null;
          const txnAddrMatch = txn.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/);
          const addr = (orderAddrMatch ? orderAddrMatch[1] : '') || (txnAddrMatch ? txnAddrMatch[1] : '');

          allTransactions.push({
            transactionId: this.extractValue(txn, 'TransactionID'),
            itemId: this.extractValue(txn, 'ItemID'),
            ebayOrderId: this.extractValue(orderBlock, 'OrderID'), // 실제 eBay 주문번호 (19-XXXXX-XXXXX)
            title: this.extractValue(txn, 'Title'),
            sku: this.extractValue(txn, 'SKU'),
            price: parseFloat(this.extractValue(txn, 'TransactionPrice')) || 0,
            quantity: parseInt(this.extractValue(txn, 'QuantityPurchased')) || 1,
            createdDate: this.extractValue(txn, 'CreatedDate'),
            buyerUserId: this.extractValue(txn, 'UserID'),
            orderStatus: this.extractValue(txn, 'OrderStatus') || this.extractValue(txn, 'CompleteStatus'),
            shippingName: this.extractValue(addr, 'Name'),
            shippingStreet: [this.extractValue(addr, 'Street1'), this.extractValue(addr, 'Street2')].filter(Boolean).join(' '),
            shippingCity: this.extractValue(addr, 'CityName'),
            shippingState: this.extractValue(addr, 'StateOrProvince'),
            shippingZip: this.extractValue(addr, 'PostalCode'),
            shippingCountry: this.extractValue(addr, 'Country'),
            shippingPhone: this.extractValue(addr, 'Phone'),
            buyerEmail: this.extractValue(txn, 'Email'),
          });
        }

        const totalPagesMatch = response.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
        const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1;
        if (pageNumber >= totalPages) break;
        pageNumber++;
        await this.sleep(500);
      }

      if (apiError) allTransactions._apiError = apiError;
      return allTransactions;
    } catch (error) {
      console.error('eBay 트랜잭션 조회 실패:', error.message);
      const arr = [];
      arr._apiError = error.message;
      return arr;
    }
  }

  /**
   * 매출 요약 (트랜잭션 기반)
   * @param {number} days - 최근 N일
   */
  async getRevenueSummary(days = 30) {
    const transactions = await this.getSellerTransactions(days);

    // API 에러 체크 (토큰 만료 등)
    if (transactions._apiError) {
      const err = transactions._apiError;
      return {
        error: err.includes('expired') ? 'eBay 토큰 만료 - Developer Portal에서 재발급 필요' : err,
        totalRevenue: 0, orderCount: 0, currency: 'USD', period: `${days}days`,
        dailySales: {}, topItems: [], transactions: [],
      };
    }

    let totalRevenue = 0;
    let orderCount = 0;
    let skippedCancelled = 0;
    const dailySales = {};
    const itemSales = {};

    // Exclude cancelled/void orders so a buyer-initiated cancel no longer
    // inflates the total. CompleteStatus=Incomplete also covers unpaid/void.
    const isCancelled = (s) => {
      const v = String(s || '').toLowerCase();
      return v === 'cancelled' || v === 'canceled' || v === 'incomplete' || v === 'invalid';
    };

    transactions.forEach(txn => {
      if (isCancelled(txn.orderStatus)) { skippedCancelled++; return; }

      const amount = txn.price * txn.quantity;
      totalRevenue += amount;
      orderCount++;

      // 일별 집계
      const date = txn.createdDate ? txn.createdDate.split('T')[0] : 'unknown';
      if (!dailySales[date]) dailySales[date] = { revenue: 0, orders: 0, items: 0 };
      dailySales[date].revenue += amount;
      dailySales[date].orders++;
      dailySales[date].items += txn.quantity;

      // 상품별 집계
      const key = txn.itemId || txn.title;
      if (!itemSales[key]) {
        itemSales[key] = { itemId: txn.itemId, title: txn.title, sku: txn.sku, totalSold: 0, totalRevenue: 0 };
      }
      itemSales[key].totalSold += txn.quantity;
      itemSales[key].totalRevenue += amount;
    });

    // 상품별 판매량순 정렬
    const topItems = Object.values(itemSales).sort((a, b) => b.totalSold - a.totalSold);

    return {
      totalRevenue,
      orderCount,
      skippedCancelled,
      currency: 'USD',
      period: `${days}days`,
      dailySales,
      topItems,
      transactions,
    };
  }

  /**
   * 대기 함수
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shopping API 공통 호출 (OAuth 토큰 + 자동 갱신)
   * @param {string} callName - API 호출명 (GetSingleItem, GetMultipleItems)
   * @param {Object} params - 추가 쿼리 파라미터
   * @param {number} timeout - 타임아웃 (ms)
   * @returns {Object} API 응답 JSON
   */
  async callShoppingAPI(callName, params = {}, timeout = 15000) {
    let url = 'https://open.api.ebay.com/shopping'
      + `?callname=${callName}`
      + '&responseencoding=JSON'
      + `&appid=${this.appId}`
      + '&siteid=0'
      + '&version=967';

    // 추가 파라미터 URL에 붙이기
    for (const [key, value] of Object.entries(params)) {
      url += `&${key}=${encodeURIComponent(value)}`;
    }

    // Application Token 발급/캐시 후 헤더에 추가
    const headers = {};
    try {
      const appToken = await this.getApplicationToken();
      headers['X-EBAY-API-IAF-TOKEN'] = appToken;
    } catch (e) {
      console.warn('Application token 발급 실패, appid만으로 호출:', e.message);
    }

    try {
      const response = await axios.get(url, { headers, timeout });
      const data = response.data;

      // Failure 에러 처리
      if (data.Ack === 'Failure') {
        const errors = Array.isArray(data.Errors) ? data.Errors : (data.Errors ? [data.Errors] : []);
        const errMsgs = errors.map(e => e.LongMessage || e.ShortMessage || '').join(' ');
        const errCodes = errors.map(e => String(e.ErrorCode || '')).join(',');

        // 토큰 에러 시 캐시 무효화 후 재시도 (1회)
        const isTokenError = errMsgs.includes('token') || errMsgs.includes('Token') || errMsgs.includes('IAF');
        const isRateLimit = errCodes.includes('18') || errMsgs.includes('limited');

        if (isTokenError && !isRateLimit && !this._tokenRefreshed) {
          console.log('Shopping API 토큰 에러, Application Token 재발급...');
          this._appToken = null;
          this._appTokenExpiry = 0;
          this._tokenRefreshed = true;
          return this.callShoppingAPI(callName, params, timeout);
        }

        throw new Error(`Shopping API Error: ${errMsgs || 'Unknown'}`);
      }

      this._tokenRefreshed = false;
      return data;
    } catch (error) {
      if (error.message.startsWith('Shopping API Error:')) throw error;
      throw new Error(`Shopping API ${callName} 실패: ${error.message}`);
    }
  }

  /**
   * 경쟁사 상품 정보 조회 (eBay Shopping API - GetMultipleItems)
   * @param {string[]} itemIds - eBay Item ID 배열 (최대 20개씩 배치)
   * @returns {Array} 상품 정보 배열
   */
  async getCompetitorItems(itemIds) {
    if (!itemIds || itemIds.length === 0) return [];

    const results = [];
    const chunks = [];
    for (let i = 0; i < itemIds.length; i += 20) {
      chunks.push(itemIds.slice(i, i + 20));
    }

    for (const chunk of chunks) {
      try {
        const data = await this.callShoppingAPI('GetMultipleItems', {
          ItemID: chunk.join(','),
          IncludeSelector: 'Details,ShippingCosts'
        });

        if (data.Ack === 'Success' || data.Ack === 'Warning') {
          const items = Array.isArray(data.Item) ? data.Item : (data.Item ? [data.Item] : []);
          items.forEach(item => {
            results.push({
              itemId: item.ItemID,
              title: item.Title || '',
              price: parseFloat(item.ConvertedCurrentPrice?.Value) || parseFloat(item.CurrentPrice?.Value) || 0,
              currency: item.ConvertedCurrentPrice?.CurrencyID || item.CurrentPrice?.CurrencyID || 'USD',
              shippingCost: parseFloat(item.ShippingCostSummary?.ShippingServiceCost?.Value) || 0,
              quantitySold: parseInt(item.QuantitySold) || 0,
              seller: item.Seller?.UserID || '',
              sellerFeedbackScore: parseInt(item.Seller?.FeedbackScore) || 0,
              listingStatus: item.ListingStatus || '',
              viewItemURL: item.ViewItemURLForNaturalSearch || '',
              galleryURL: item.GalleryURL || '',
              quantityAvailable: (parseInt(item.Quantity) || 0) - (parseInt(item.QuantitySold) || 0),
            });
          });
        }

        if (chunks.indexOf(chunk) < chunks.length - 1) {
          await this.sleep(300);
        }
      } catch (error) {
        console.error('Shopping API GetMultipleItems 실패:', error.message);
      }
    }

    return results;
  }

  /**
   * 단일 경쟁사 상품 상세 조회 (eBay Shopping API - GetSingleItem)
   * @param {string} itemId - eBay Item ID
   * @returns {Object|null} 상품 정보
   */
  async getCompetitorItemDetail(itemId) {
    try {
      const data = await this.callShoppingAPI('GetSingleItem', {
        ItemID: itemId,
        IncludeSelector: 'Details,ShippingCosts,ItemSpecifics'
      }, 10000);

      if (data.Ack === 'Success' || data.Ack === 'Warning') {
        const item = data.Item;
        return {
          itemId: item.ItemID,
          title: item.Title || '',
          price: parseFloat(item.ConvertedCurrentPrice?.Value) || 0,
          currency: item.ConvertedCurrentPrice?.CurrencyID || 'USD',
          shippingCost: parseFloat(item.ShippingCostSummary?.ShippingServiceCost?.Value) || 0,
          quantitySold: parseInt(item.QuantitySold) || 0,
          seller: item.Seller?.UserID || '',
          sellerFeedbackScore: parseInt(item.Seller?.FeedbackScore) || 0,
          listingStatus: item.ListingStatus || '',
          viewItemURL: item.ViewItemURLForNaturalSearch || '',
          galleryURL: item.GalleryURL || '',
          quantityAvailable: (parseInt(item.Quantity) || 0) - (parseInt(item.QuantitySold) || 0),
        };
      }
      return null;
    } catch (error) {
      console.error('Shopping API GetSingleItem 실패:', error.message);
      return null;
    }
  }

  /**
   * 경쟁사 상품 전체 정보 조회 (Description + Images + ItemSpecifics 포함)
   * AI 리메이커용 - Shopping API 우선, 실패 시 Browse API fallback
   */
  async getCompetitorItemFull(itemId) {
    // 1차: Shopping API 시도
    try {
      const data = await this.callShoppingAPI('GetSingleItem', {
        ItemID: itemId,
        IncludeSelector: 'Details,Description,ShippingCosts,ItemSpecifics'
      });

      if (data.Ack === 'Success' || data.Ack === 'Warning') {
        return this._parseShoppingItem(data.Item);
      }
    } catch (shoppingErr) {
      console.warn('Shopping API 실패, Browse API fallback 시도:', shoppingErr.message);
    }

    // 2차: Browse API fallback
    try {
      return await this._fetchViaBrowseAPI(itemId);
    } catch (browseErr) {
      console.error('Browse API도 실패:', browseErr.message);
      throw browseErr;
    }
  }

  /**
   * Shopping API 응답 파싱 (공통)
   */
  _parseShoppingItem(item) {
    const specifics = {};
    const nvList = item.ItemSpecifics?.NameValueList;
    if (Array.isArray(nvList)) {
      nvList.forEach(nv => {
        specifics[nv.Name] = Array.isArray(nv.Value) ? nv.Value.join(', ') : nv.Value;
      });
    }

    return {
      itemId: item.ItemID,
      title: item.Title || '',
      description: item.Description || '',
      price: parseFloat(item.ConvertedCurrentPrice?.Value) || 0,
      currency: item.ConvertedCurrentPrice?.CurrencyID || 'USD',
      shippingCost: parseFloat(item.ShippingCostSummary?.ShippingServiceCost?.Value) || 0,
      quantitySold: parseInt(item.QuantitySold) || 0,
      quantityAvailable: (parseInt(item.Quantity) || 0) - (parseInt(item.QuantitySold) || 0),
      seller: item.Seller?.UserID || '',
      sellerFeedbackScore: parseInt(item.Seller?.FeedbackScore) || 0,
      listingStatus: item.ListingStatus || '',
      viewItemURL: item.ViewItemURLForNaturalSearch || '',
      galleryURL: item.GalleryURL || '',
      pictureURLs: Array.isArray(item.PictureURL) ? item.PictureURL
        : (item.PictureURL ? [item.PictureURL] : []),
      categoryId: item.PrimaryCategoryID || '',
      categoryName: item.PrimaryCategoryName || '',
      conditionDisplayName: item.ConditionDisplayName || '',
      conditionId: item.ConditionID || '',
      itemSpecifics: specifics,
    };
  }

  /**
   * Browse API로 경쟁사 상품 조회 (Shopping API 실패 시 fallback)
   * GET https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id
   */
  async _fetchViaBrowseAPI(itemId) {
    const appToken = await this.getApplicationToken();
    const url = `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`;

    const headers = {
      'Authorization': `Bearer ${appToken}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    };

    let item;          // 대표 변형 (single 이거나 item group 의 첫 번째)
    let variants = []; // 모든 변형 (multi-variant 인 경우 채워짐)

    try {
      const response = await axios.get(url, { headers, timeout: 15000 });
      item = response.data;
      variants = [item];
    } catch (err) {
      const errData = err.response?.data;
      const errMsg = errData?.errors?.[0]?.longMessage || errData?.errors?.[0]?.message || '';

      // Item Group (멀티 변형) → 그룹 전체 가져와 min/max 계산
      if (errMsg.includes('item_group') || errMsg.includes('item group')) {
        try {
          const groupUrl = `https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${itemId}`;
          const groupResp = await axios.get(groupUrl, { headers, timeout: 15000 });
          const items = groupResp.data?.items;
          if (items && items.length > 0) {
            variants = items;
            item = items[0]; // 대표값 = 첫 번째 (일반적으로 최저가)
            console.log(`Browse API: Item Group ${itemId} → ${items.length}개 변형`);
          } else {
            throw new Error('Item Group에서 상품을 찾을 수 없음');
          }
        } catch (groupErr) {
          const gErrData = groupErr.response?.data;
          console.error('Browse API Group 에러:', JSON.stringify(gErrData || groupErr.message));
          throw new Error(gErrData?.errors?.[0]?.longMessage || groupErr.message);
        }
      } else {
        console.error('Browse API 상세 에러:', JSON.stringify(errData || err.message));
        throw new Error(errMsg || err.message);
      }
    }

    // Browse API 응답 → 공통 포맷 변환
    const specifics = {};
    if (Array.isArray(item.localizedAspects)) {
      item.localizedAspects.forEach(a => { specifics[a.name] = a.value; });
    }

    const images = [];
    if (item.image?.imageUrl) images.push(item.image.imageUrl);
    if (Array.isArray(item.additionalImages)) {
      item.additionalImages.forEach(img => { if (img.imageUrl) images.push(img.imageUrl); });
    }

    // ── 변형 통계: min/max price + 총 재고 ─────────────────
    const variantPrices = variants
      .map(v => parseFloat(v.price?.value))
      .filter(n => Number.isFinite(n) && n > 0);
    const priceMin = variantPrices.length ? Math.min(...variantPrices) : (parseFloat(item.price?.value) || 0);
    const priceMax = variantPrices.length ? Math.max(...variantPrices) : priceMin;
    const variantCount = variants.length;

    // 재고: 모든 변형의 estimatedAvailableQuantity 합산
    const totalAvailable = variants.reduce((sum, v) => {
      const q = parseInt(v.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity);
      return sum + (Number.isFinite(q) ? q : 0);
    }, 0);
    // estimatedAvailableQuantity 가 모두 누락된 경우 null (unknown), 0 이면 품절
    const anyHasAvailability = variants.some(v => v.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity !== undefined);
    const quantityAvailable = anyHasAvailability ? totalAvailable : null;

    let status = 'active';
    if (quantityAvailable === 0) status = 'out_of_stock';
    // ended 상태는 Browse API 가 404 로 반환하므로 catch 단계에서 처리됨 (여기 도달 안 함)

    return {
      itemId: item.legacyItemId || itemId,
      title: item.title || '',
      description: item.description || item.shortDescription || '',
      price: parseFloat(item.price?.value) || priceMin,
      currency: item.price?.currency || 'USD',
      shippingCost: parseFloat(item.shippingOptions?.[0]?.shippingCost?.value) || 0,
      quantitySold: parseInt(item.estimatedAvailabilities?.[0]?.soldQuantity) || 0,
      quantityAvailable,
      // 신규: 변형 정보
      priceMin,
      priceMax,
      variantCount,
      status,
      // 기존
      seller: item.seller?.username || '',
      sellerFeedbackScore: parseInt(item.seller?.feedbackScore) || 0,
      listingStatus: item.buyingOptions?.includes('FIXED_PRICE') ? 'Active' : 'Unknown',
      viewItemURL: item.itemWebUrl || '',
      galleryURL: item.image?.imageUrl || '',
      pictureURLs: images,
      categoryId: item.categoryId || '',
      categoryName: item.categoryPath || '',
      conditionDisplayName: item.condition || '',
      conditionId: item.conditionId || '',
      itemSpecifics: specifics,
    };
  }

  /**
   * Clear Custom Label (SKU) from a listing to break Lister connection
   */
  async clearCustomLabel(itemId) {
    try {
      const resp = await this.callTradingAPI('ReviseFixedPriceItem',
        `<Item><ItemID>${itemId}</ItemID><SKU></SKU></Item>`);
      const ack = resp.match(/<Ack>(.*?)<\/Ack>/)?.[1];
      if (ack === 'Success' || ack === 'Warning') return { success: true };
      const err = resp.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] || 'Unknown';
      return { success: false, error: err };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Find all listings by a specific seller using Browse API
   */
  async findSellerListings(sellerName, maxPages = 3) {
    const allItems = [];
    const seenIds = new Set();
    const token = await this.getApplicationToken();
    const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };

    // Browse API requires a search query — use multiple keywords to cover more items
    const queries = ['korean', 'pokemon', 'starbucks', 'card', 'toy', 'figure', 'plush', 'k-pop', 'game', 'set'];

    for (const q of queries) {
      let offset = 0;
      for (let page = 1; page <= maxPages; page++) {
        try {
          const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=200&offset=${offset}&filter=sellers:%7B${encodeURIComponent(sellerName)}%7D`;
          const resp = await axios.get(url, { headers, timeout: 20000 });
          const items = resp.data?.itemSummaries || [];
          if (items.length === 0) break;

          for (const item of items) {
            const id = item.legacyItemId || item.itemId || '';
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              allItems.push({
                itemId: id,
                title: item.title || '',
                price: parseFloat(item.price?.value) || 0,
                shipping: parseFloat(item.shippingOptions?.[0]?.shippingCost?.value) || 0,
                seller: sellerName,
              });
            }
          }

          const total = resp.data?.total || 0;
          offset += 200;
          if (offset >= total) break;
        } catch (err) {
          // Skip this query on error, try next
          break;
        }
      }
    }

    console.log(`[findSellerListings] ${sellerName}: ${allItems.length} unique items found`);
    return allItems;
  }

  /**
   * End (remove) an eBay listing
   * @param {string} itemId - eBay item ID
   * @param {string} reason - NotAvailable, Incorrect, LostOrBroken, OtherListingError, SellToHighBidder
   */
  async endListing(itemId, reason = 'NotAvailable') {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${this.userToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <EndingReason>${reason}</EndingReason>
</EndFixedPriceItemRequest>`;

    try {
      const resp = await axios.post(this.apiUrl, xml, {
        headers: {
          'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
          'X-EBAY-API-CALL-NAME': 'EndFixedPriceItem',
          'X-EBAY-API-SITEID': '0',
          'Content-Type': 'text/xml',
        },
        timeout: 15000,
      });

      const ack = resp.data.match(/<Ack>(.*?)<\/Ack>/)?.[1];
      if (ack === 'Success' || ack === 'Warning') {
        return { success: true, itemId };
      }
      const errMsg = resp.data.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1] || 'Unknown error';
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ===== Buyer Message APIs =====

  async getMyMessages({ startTime, endTime, folder = 'Inbox', pageNumber = 1 } = {}) {
    const now = new Date();
    const start = startTime || new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const end = endTime || now.toISOString();
    const data = await this.callTradingAPI('GetMyMessages', {
      DetailLevel: 'ReturnHeaders',
      FolderID: folder === 'Inbox' ? 0 : 1,
      StartTime: start, EndTime: end,
      Pagination: { EntriesPerPage: 25, PageNumber: pageNumber },
    });
    const messages = data?.Messages?.Message;
    if (!messages) return [];
    const arr = Array.isArray(messages) ? messages : [messages];
    return arr.map(m => ({
      messageId: m.MessageID, sender: m.Sender, subject: m.Subject || '',
      messageType: m.MessageType, questionType: m.QuestionType || '',
      receiveDate: m.ReceiveDate, read: m.Read === 'true', flagged: m.Flagged === 'true',
      itemId: m.ItemID || '', externalMessageId: m.ExternalMessageID || '',
    }));
  }

  async getMessageContent(messageId) {
    const data = await this.callTradingAPI('GetMyMessages', {
      DetailLevel: 'ReturnMessages', MessageIDs: { MessageID: messageId },
    });
    const msg = data?.Messages?.Message;
    if (!msg) return null;
    const m = Array.isArray(msg) ? msg[0] : msg;
    return {
      messageId: m.MessageID, sender: m.Sender, recipientUserId: m.RecipientUserID || m.SendToName || '',
      subject: m.Subject || '', body: m.Text || m.Body || '', messageType: m.MessageType,
      questionType: m.QuestionType || '', receiveDate: m.ReceiveDate, itemId: m.ItemID || '', itemTitle: m.ItemTitle || '',
    };
  }

  async replyToMessage(itemId, recipientId, body, subject) {
    const data = await this.callTradingAPI('AddMemberMessageRTQ', {
      ItemID: itemId,
      MemberMessage: { Body: body, Subject: subject || '', RecipientID: recipientId, MessageType: 'CustomizedSubject', QuestionType: 'General' },
    });
    return { success: data?.Ack === 'Success' || data?.Ack === 'Warning', data };
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
