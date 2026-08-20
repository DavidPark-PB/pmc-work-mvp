const path = require('path');
const { CREDENTIALS_PATH, DATA_DIR } = require('../config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');

/**
 * 품절 상품 eBay 재고 0 업데이트
 *
 * B열의 값이 eBay Item ID임!
 * F열이 "품절"인 상품 → eBay API로 재고 0 설정
 */

class EbayAPI {
  constructor() {
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.authToken = process.env.EBAY_USER_TOKEN;
  }

  async setQuantityZero(itemId) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${this.authToken}</eBayAuthToken>
        </RequesterCredentials>
        <InventoryStatus>
          <ItemID>${itemId}</ItemID>
          <Quantity>0</Quantity>
        </InventoryStatus>
      </ReviseInventoryStatusRequest>`;

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml'
    };

    try {
      const response = await axios.post(this.apiUrl, xml, { headers, timeout: 30000 });
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(response.data);

      const ack = result.ReviseInventoryStatusResponse?.Ack;

      if (ack === 'Success' || ack === 'Warning') {
        return { success: true };
      } else {
        const errors = result.ReviseInventoryStatusResponse?.Errors;
        return {
          success: false,
          error: errors?.LongMessage || errors?.ShortMessage || 'Unknown error'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

async function updateEbaySoldout() {
  console.log('='.repeat(70));
  console.log('📦 eBay 품절 상품 재고 0 업데이트');
  console.log('='.repeat(70));
  console.log();

  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 헤더 확인
    console.log('📋 1단계: 헤더 확인 중...\n');
    await dashboard.loadCells('A1:Z1');

    const headers = {};
    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    const purchasePriceCol = headers['🔒 매입가'];  // F열 - 품절 표시

    console.log(`   매입가 열 (품절 표시): ${purchasePriceCol !== undefined ? String.fromCharCode(65 + purchasePriceCol) + '열' : '없음'}`);
    console.log(`   Item ID 열: B열 (SKU)\n`);

    // 2. 품절 상품 찾기
    console.log('🔍 2단계: 품절 상품 찾기...\n');

    const soldoutItems = [];
    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      await dashboard.loadCells(`B${startRow + 1}:${String.fromCharCode(65 + purchasePriceCol)}${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        const itemIdCell = dashboard.getCell(row, 1);  // B열 = Item ID
        const purchaseCell = dashboard.getCell(row, purchasePriceCol);

        const itemId = itemIdCell.value;
        const purchase = purchaseCell.value;

        // 품절이고 Item ID가 숫자인 경우만 (eBay Item ID는 숫자)
        if (String(purchase).toLowerCase() === '품절' && itemId && /^\d{12}$/.test(String(itemId))) {
          soldoutItems.push({
            row: row + 1,
            itemId: String(itemId)
          });
        }
      }
    }

    console.log(`   품절 상품 (eBay Item ID 있음): ${soldoutItems.length}개\n`);

    if (soldoutItems.length === 0) {
      console.log('✅ 업데이트할 품절 상품이 없습니다.\n');
      return;
    }

    // 3. eBay API 업데이트
    console.log('⚡ 3단계: eBay API 업데이트 중...\n');

    const ebay = new EbayAPI();

    let success = 0;
    let fail = 0;
    const errors = [];

    for (let i = 0; i < soldoutItems.length; i++) {
      const item = soldoutItems[i];

      console.log(`   ${i + 1}/${soldoutItems.length} Item ID: ${item.itemId}`);

      const result = await ebay.setQuantityZero(item.itemId);

      if (result.success) {
        success++;
        console.log(`      ✅ 재고 0 설정 완료`);
      } else {
        fail++;
        console.log(`      ❌ 실패: ${result.error}`);
        errors.push({ itemId: item.itemId, row: item.row, error: result.error });
      }

      // Rate limit 방지 (1초 간격)
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 진행 상황 표시
      if ((i + 1) % 50 === 0) {
        console.log(`\n   --- ${i + 1}/${soldoutItems.length} 완료 (${Math.round((i + 1) / soldoutItems.length * 100)}%) ---\n`);
      }
    }

    // 4. 결과 출력
    console.log();
    console.log('='.repeat(70));
    console.log('📊 업데이트 결과');
    console.log('='.repeat(70));
    console.log();
    console.log(`   ✅ 성공: ${success}개`);
    console.log(`   ❌ 실패: ${fail}개`);
    console.log();

    if (errors.length > 0) {
      console.log('⚠️  오류 목록:');
      errors.slice(0, 20).forEach((err, i) => {
        console.log(`   ${i + 1}. Row ${err.row} (${err.itemId}): ${err.error}`);
      });
      if (errors.length > 20) {
        console.log(`   ... 외 ${errors.length - 20}개`);
      }

      // 오류 목록 파일로 저장
      const errorFile = path.join(DATA_DIR, `ebay-errors-${new Date().toISOString().slice(0,10)}.json`);
      fs.writeFileSync(errorFile, JSON.stringify(errors, null, 2));
      console.log(`\n   📁 오류 목록 저장: ${errorFile}`);
    }

    console.log();
    console.log('='.repeat(70));
    console.log('✅ 완료!');
    console.log('='.repeat(70));
    console.log();
    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

updateEbaySoldout();
