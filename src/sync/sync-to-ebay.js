const { CREDENTIALS_PATH } = require('../config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * Google Sheets → eBay 동기화 (bulkUpdate)
 * Pending 상태인 상품들을 eBay로 전송
 */

class EbaySync {
  constructor() {
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.authToken = process.env.EBAY_USER_TOKEN;
  }

  async reviseInventoryStatus(itemId, updates) {
    // ReviseInventoryStatus API 사용
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${this.authToken}</eBayAuthToken>
        </RequesterCredentials>
        <InventoryStatus>
          <ItemID>${itemId}</ItemID>
          ${updates.price ? `<StartPrice>${updates.price}</StartPrice>` : ''}
          ${updates.quantity !== undefined ? `<Quantity>${updates.quantity}</Quantity>` : ''}
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
      const response = await axios.post(this.apiUrl, xml, { headers });
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

  async bulkUpdateItems(items) {
    // 배치로 업데이트 (한 번에 최대 4개)
    const batchSize = 4;
    const results = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const promises = batch.map(item =>
        this.reviseInventoryStatus(item.itemId, item.updates)
      );

      const batchResults = await Promise.all(promises);
      results.push(...batchResults);

      // Rate limit 방지
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }
}

async function syncToEbay() {
  console.log('=== eBay 역전송 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['최종 Dashboard'];
    if (!sheet) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log(`📊 시트: ${sheet.title}\n`);

    // 전체 행 로드
    const rows = await sheet.getRows();
    console.log(`📄 총 ${rows.length}개 행 로드 완료\n`);

    // Pending 상태인 행 필터링
    const pendingRows = rows.filter(row => {
      const syncStatus = row.get('Sync Status');
      const platform = row.get('플랫폼');
      const ebayItemId = row.get('eBay Item ID');
      return syncStatus === 'Pending' && ebayItemId && (platform === 'eBay만' || platform === '양쪽');
    });

    console.log(`🔍 Pending 상태 eBay 상품: ${pendingRows.length}개\n`);

    if (pendingRows.length === 0) {
      console.log('✅ 동기화할 상품이 없습니다!');
      return;
    }

    const ebay = new EbaySync();

    // 업데이트할 아이템 준비
    const itemsToUpdate = pendingRows.map(row => {
      const updates = {};
      const ebayPrice = row.get('eBay가격(USD)');
      const ebayStock = row.get('eBay재고');

      if (ebayPrice) updates.price = parseFloat(ebayPrice);
      if (ebayStock !== null && ebayStock !== undefined) {
        updates.quantity = parseInt(ebayStock);
      }

      return {
        row: row,
        itemId: row.get('eBay Item ID'),
        updates: updates
      };
    });

    console.log('📤 eBay로 전송 중 (배치 처리)...\n');

    // Bulk Update 실행
    const results = await ebay.bulkUpdateItems(itemsToUpdate);

    let successCount = 0;
    let failCount = 0;

    // 결과 처리
    for (let i = 0; i < itemsToUpdate.length; i++) {
      const item = itemsToUpdate[i];
      const result = results[i];

      console.log(`   ${i + 1}/${itemsToUpdate.length} Item ID: ${item.itemId}`);

      if (result.success) {
        item.row.set('Sync Status', 'Success');
        item.row.set('Last Updated', new Date().toISOString());
        console.log(`      ✅ 성공`);
        successCount++;
      } else {
        item.row.set('Sync Status', `Error: ${result.error}`);
        console.log(`      ❌ 실패: ${result.error}`);
        failCount++;
      }

      await item.row.save();
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ eBay 동기화 완료!');
    console.log('='.repeat(60));
    console.log(`\n📊 결과:`);
    console.log(`   성공: ${successCount}개`);
    console.log(`   실패: ${failCount}개`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

syncToEbay();
