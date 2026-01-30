require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');

/**
 * eBay 배송비 개별 동기화
 *
 * 시트의 eBay 배송비(USD) 값을 eBay API를 통해 개별 상품에 적용
 * ReviseItem API의 ShippingDetails > ShippingServiceOptions > ShippingServiceCost 사용
 */

class EbayShippingSync {
  constructor() {
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.authToken = process.env.EBAY_USER_TOKEN;
  }

  /**
   * 개별 상품의 배송비 업데이트
   */
  async updateShippingCost(itemId, shippingCost) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${this.authToken}</eBayAuthToken>
        </RequesterCredentials>
        <Item>
          <ItemID>${itemId}</ItemID>
          <ShippingDetails>
            <ShippingType>Flat</ShippingType>
            <ShippingServiceOptions>
              <ShippingServicePriority>1</ShippingServicePriority>
              <ShippingService>USPSPriority</ShippingService>
              <ShippingServiceCost currencyID="USD">${shippingCost.toFixed(2)}</ShippingServiceCost>
              <ShippingServiceAdditionalCost currencyID="USD">0.00</ShippingServiceAdditionalCost>
            </ShippingServiceOptions>
            <InternationalShippingServiceOption>
              <ShippingServicePriority>1</ShippingServicePriority>
              <ShippingService>USPSPriorityMailInternational</ShippingService>
              <ShippingServiceCost currencyID="USD">${shippingCost.toFixed(2)}</ShippingServiceCost>
              <ShippingServiceAdditionalCost currencyID="USD">0.00</ShippingServiceAdditionalCost>
              <ShipToLocation>Worldwide</ShipToLocation>
            </InternationalShippingServiceOption>
          </ShippingDetails>
        </Item>
      </ReviseItemRequest>`;

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': 'ReviseItem',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml'
    };

    try {
      const response = await axios.post(this.apiUrl, xml, { headers, timeout: 30000 });
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(response.data);

      const ack = result.ReviseItemResponse?.Ack;

      if (ack === 'Success' || ack === 'Warning') {
        return { success: true };
      } else {
        const errors = result.ReviseItemResponse?.Errors;
        const errorMsg = Array.isArray(errors)
          ? errors.map(e => e.LongMessage || e.ShortMessage).join('; ')
          : errors?.LongMessage || errors?.ShortMessage || 'Unknown error';
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 현재 상품의 배송비 조회
   */
  async getItemShipping(itemId) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${this.authToken}</eBayAuthToken>
        </RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <DetailLevel>ReturnAll</DetailLevel>
      </GetItemRequest>`;

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml'
    };

    try {
      const response = await axios.post(this.apiUrl, xml, { headers, timeout: 30000 });
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(response.data);

      const item = result.GetItemResponse?.Item;
      if (item) {
        const shippingOptions = item.ShippingDetails?.ShippingServiceOptions;
        const currentCost = shippingOptions?.ShippingServiceCost?._ || shippingOptions?.ShippingServiceCost;
        return { success: true, currentCost: parseFloat(currentCost) || 0 };
      }
      return { success: false, error: 'Item not found' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

async function syncEbayShippingCost(options = {}) {
  const { dryRun = false, limit = 0 } = options;

  console.log('='.repeat(70));
  console.log('📦 eBay 배송비 개별 동기화');
  console.log('='.repeat(70));
  console.log();

  if (dryRun) {
    console.log('⚠️  DRY RUN 모드 - 실제 업데이트 없이 확인만 합니다.\n');
  }

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 배송비 데이터 수집
    console.log('📋 1단계: 배송비 데이터 수집 중...\n');

    const itemsToUpdate = [];
    const batchSize = 500;
    const totalRows = 8704;

    for (let startRow = 2; startRow <= totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize - 1, totalRows);

      // B열(SKU/Item ID), E열(매입가), K열(eBay 배송비)
      await dashboard.loadCells(`B${startRow}:K${endRow}`);

      for (let row = startRow; row <= endRow; row++) {
        const rowIndex = row - 1;

        const itemId = dashboard.getCell(rowIndex, 1).value;  // B열
        const purchasePrice = dashboard.getCell(rowIndex, 4).value;  // E열
        const ebayShipping = dashboard.getCell(rowIndex, 10).value;  // K열

        // 유효한 Item ID (12자리 숫자)와 배송비가 있는 경우만
        if (itemId && /^\d{12}$/.test(String(itemId)) &&
            ebayShipping !== null && ebayShipping !== '' && !isNaN(parseFloat(ebayShipping)) &&
            purchasePrice !== '품절') {

          itemsToUpdate.push({
            row: row,
            itemId: String(itemId),
            shippingCost: parseFloat(ebayShipping)
          });
        }
      }

      console.log(`   ${endRow}행까지 스캔 완료...`);
    }

    console.log(`\n   ✅ 업데이트 대상: ${itemsToUpdate.length}개 상품\n`);

    if (itemsToUpdate.length === 0) {
      console.log('⚠️  업데이트할 상품이 없습니다.');
      return;
    }

    // 2. eBay API 업데이트
    console.log('⚡ 2단계: eBay 배송비 업데이트 중...\n');

    const ebay = new EbayShippingSync();
    const results = { success: 0, fail: 0, skipped: 0 };
    const errors = [];

    const updateLimit = limit > 0 ? Math.min(limit, itemsToUpdate.length) : itemsToUpdate.length;

    for (let i = 0; i < updateLimit; i++) {
      const item = itemsToUpdate[i];

      process.stdout.write(`   ${i + 1}/${updateLimit} Item ${item.itemId}: $${item.shippingCost.toFixed(2)} `);

      if (dryRun) {
        console.log('→ [DRY RUN]');
        results.skipped++;
        continue;
      }

      const result = await ebay.updateShippingCost(item.itemId, item.shippingCost);

      if (result.success) {
        console.log('→ ✅');
        results.success++;
      } else {
        console.log(`→ ❌ ${result.error.substring(0, 50)}`);
        results.fail++;
        errors.push({ itemId: item.itemId, row: item.row, error: result.error });
      }

      // Rate limit 방지 (500ms 간격)
      await new Promise(resolve => setTimeout(resolve, 500));

      // 진행 상황 표시
      if ((i + 1) % 100 === 0) {
        console.log(`\n   --- ${i + 1}/${updateLimit} 완료 (${Math.round((i + 1) / updateLimit * 100)}%) ---\n`);
      }
    }

    // 3. 결과 출력
    console.log();
    console.log('='.repeat(70));
    console.log('📊 동기화 결과');
    console.log('='.repeat(70));
    console.log();
    console.log(`   ✅ 성공: ${results.success}개`);
    console.log(`   ❌ 실패: ${results.fail}개`);
    if (dryRun) {
      console.log(`   ⏭️  건너뜀 (DRY RUN): ${results.skipped}개`);
    }
    console.log();

    if (errors.length > 0) {
      console.log('⚠️  오류 목록 (상위 20개):');
      errors.slice(0, 20).forEach((err, i) => {
        console.log(`   ${i + 1}. Row ${err.row} (${err.itemId}): ${err.error.substring(0, 60)}`);
      });
      if (errors.length > 20) {
        console.log(`   ... 외 ${errors.length - 20}개`);
      }

      // 오류 목록 저장
      const errorFile = `C:\\Users\\tooni\\PMC work MVP\\shipping-sync-errors-${new Date().toISOString().slice(0, 10)}.json`;
      fs.writeFileSync(errorFile, JSON.stringify(errors, null, 2));
      console.log(`\n   📁 오류 목록 저장: ${errorFile}`);
    }

    console.log();
    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();

  } catch (error) {
    console.error('\n❌ 오류:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// CLI 실행
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run'),
  limit: parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0')
};

if (args.includes('--help')) {
  console.log(`
📦 eBay 배송비 동기화

사용법:
  node sync-ebay-shipping-cost.js [옵션]

옵션:
  --dry-run     실제 업데이트 없이 확인만
  --limit=N     최대 N개 상품만 업데이트
  --help        도움말 표시

예시:
  node sync-ebay-shipping-cost.js --dry-run
  node sync-ebay-shipping-cost.js --limit=10
  node sync-ebay-shipping-cost.js
`);
  process.exit(0);
}

syncEbayShippingCost(options);
