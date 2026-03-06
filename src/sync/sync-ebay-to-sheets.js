const { CREDENTIALS_PATH } = require('../config');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const xml2js = require('xml2js');
const fs = require('fs');

/**
 * eBay Trading API GetSellerList로 모든 리스팅 가져와서 Google Sheets 동기화
 * OAuth User Token + X-EBAY-API-IAF-TOKEN 사용
 */

class eBayToSheetsSync {
  constructor() {
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.userToken = process.env.EBAY_USER_TOKEN;
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.version = '1271';
    this.siteId = '0'; // US
  }

  async callTradingAPI(callName, requestBody, pageNumber = 1) {
    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': this.version,
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': this.siteId,
      'Content-Type': 'text/xml'
    };

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.userToken}</eBayAuthToken>
  </RequesterCredentials>
  ${requestBody}
</${callName}Request>`;

    console.log(`\n📡 API 호출: ${callName} (Page ${pageNumber})...`);

    try {
      const response = await axios.post(this.apiUrl, xml, { headers });
      return response.data;
    } catch (error) {
      console.error(`❌ API 호출 실패:`, error.message);
      throw error;
    }
  }

  async getAllSellerListings() {
    console.log('=== eBay GetMyeBaySelling API 시작 ===\n');

    const allItems = [];
    let pageNumber = 1;
    let hasMoreItems = true;

    console.log('📦 페이지당 항목: 200개\n');

    while (hasMoreItems) {
      const requestBody = `
        <DetailLevel>ReturnAll</DetailLevel>
        <ActiveList>
          <Include>true</Include>
          <Pagination>
            <EntriesPerPage>200</EntriesPerPage>
            <PageNumber>${pageNumber}</PageNumber>
          </Pagination>
        </ActiveList>
      `;

      const xmlResponse = await this.callTradingAPI('GetMyeBaySelling', requestBody, pageNumber);

      // XML을 JSON으로 파싱
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(xmlResponse);

      const response = result.GetMyeBaySellingResponse;

      // 에러 체크
      if (response.Ack === 'Failure' || response.Ack === 'PartialFailure') {
        console.error('❌ API 에러:', response.Errors?.ShortMessage);
        console.error('상세:', response.Errors?.LongMessage);
        throw new Error(response.Errors?.ShortMessage || 'API Error');
      }

      // ActiveList에서 아이템 추출
      const activeList = response.ActiveList;
      const itemArray = activeList?.ItemArray;
      if (itemArray && itemArray.Item) {
        const items = Array.isArray(itemArray.Item) ? itemArray.Item : [itemArray.Item];

        items.forEach(item => {
          // 배송비 추출 - ShippingServiceCost 또는 ShippingDetails에서
          let shippingCost = '0';
          if (item.ShippingDetails?.ShippingServiceOptions) {
            const shippingOptions = Array.isArray(item.ShippingDetails.ShippingServiceOptions)
              ? item.ShippingDetails.ShippingServiceOptions[0]
              : item.ShippingDetails.ShippingServiceOptions;
            shippingCost = shippingOptions?.ShippingServiceCost?._ || '0';
          }

          // 이미지 URL 생성 (eBay Item ID 기반)
          const itemId = item.ItemID || '';
          const imageUrl = itemId ? `https://i.ebayimg.com/images/g/${itemId}/s-l500.jpg` : '';

          allItems.push({
            sku: item.SKU || 'N/A',
            title: item.Title || 'N/A',
            itemId: item.ItemID || 'N/A',
            price: item.SellingStatus?.CurrentPrice?._ || item.StartPrice?._ || '0',
            currency: item.SellingStatus?.CurrentPrice?.$?.currencyID || 'USD',
            shippingCost: shippingCost,
            quantity: item.Quantity || '0',
            quantitySold: item.SellingStatus?.QuantitySold || '0',
            listingType: item.ListingType || 'N/A',
            listingStatus: item.SellingStatus?.ListingStatus || 'N/A',
            imageUrl: imageUrl
          });
        });

        console.log(`✅ Page ${pageNumber}: ${items.length}개 아이템 추가 (누적: ${allItems.length}개)`);
      } else {
        console.log(`ℹ️  Page ${pageNumber}: 아이템 없음`);
      }

      // HasMoreItems 체크 (ActiveList의 PaginationResult 확인)
      const paginationResult = activeList?.PaginationResult;
      const totalPages = parseInt(paginationResult?.TotalNumberOfPages || '1');
      hasMoreItems = pageNumber < totalPages;

      if (hasMoreItems) {
        pageNumber++;
        // API Rate Limit 방지를 위한 짧은 대기
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`\n🎉 총 ${allItems.length}개 리스팅 수집 완료!\n`);
    return allItems;
  }

  async updateGoogleSheets(items) {
    console.log('=== Google Sheets 업데이트 시작 ===\n');

    // credentials.json 파일 읽기
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

    // Google Sheets 인증
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`📊 스프레드시트: ${doc.title}`);

    // "eBay Products" 시트 찾기 또는 생성
    let sheet = doc.sheetsByTitle['eBay Products'];
    if (!sheet) {
      console.log('📝 "eBay Products" 시트 생성 중...');
      sheet = await doc.addSheet({
        title: 'eBay Products',
        headerValues: ['SKU', 'Title', 'Item ID', 'Price', 'Shipping Cost', 'Currency', 'Quantity', 'Sold', 'Type', 'Status', 'Platform', 'Fee %', 'Last Updated', 'Image URL']
      });
    }

    // 기존 데이터 클리어
    await sheet.clear();

    // 헤더 다시 추가
    await sheet.setHeaderRow(['SKU', 'Title', 'Item ID', 'Price', 'Shipping Cost', 'Currency', 'Quantity', 'Sold', 'Type', 'Status', 'Platform', 'Fee %', 'Last Updated', 'Image URL']);

    // 데이터 준비 (Batch Update)
    const rows = items.map(item => ({
      SKU: item.sku,
      Title: item.title,
      'Item ID': item.itemId,
      Price: parseFloat(item.price) || 0,
      'Shipping Cost': parseFloat(item.shippingCost) || 0,
      Currency: item.currency,
      Quantity: parseInt(item.quantity) || 0,
      Sold: parseInt(item.quantitySold) || 0,
      Type: item.listingType,
      Status: item.listingStatus,
      Platform: 'eBay',
      'Fee %': 13, // eBay 수수료 13%
      'Last Updated': new Date().toISOString(),
      'Image URL': item.imageUrl || ''
    }));

    console.log(`\n📥 ${rows.length}개 행을 Google Sheets에 업로드 중...`);

    // Batch로 한번에 업데이트
    await sheet.addRows(rows);

    console.log(`✅ Google Sheets 업데이트 완료!\n`);
    console.log(`🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
  }

  async sync() {
    try {
      const startTime = Date.now();

      // 1. eBay에서 모든 리스팅 가져오기
      const items = await this.getAllSellerListings();

      if (items.length === 0) {
        console.log('⚠️  가져온 아이템이 없습니다. API 응답을 확인해주세요.');
        return;
      }

      // 샘플 데이터 출력
      console.log('📋 샘플 데이터 (처음 3개):\n');
      items.slice(0, 3).forEach((item, index) => {
        console.log(`${index + 1}. SKU: ${item.sku}`);
        console.log(`   Title: ${item.title}`);
        console.log(`   Price: ${item.price} ${item.currency}`);
        console.log(`   Quantity: ${item.quantity} (Sold: ${item.quantitySold})`);
        console.log(`   Image URL: ${item.imageUrl || '없음'}`);
        console.log('');
      });

      // 2. Google Sheets 업데이트
      await this.updateGoogleSheets(items);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\n🎉 전체 동기화 완료! (소요 시간: ${elapsed}초)\n`);

    } catch (error) {
      console.error('\n❌ 동기화 실패:', error.message);
      if (error.response) {
        console.log('응답 데이터:', error.response.data.substring(0, 1000));
      }
      process.exit(1);
    }
  }
}

// 실행
const syncer = new eBayToSheetsSync();
syncer.sync();
