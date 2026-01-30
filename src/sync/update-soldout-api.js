require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');

/**
 * 품절 상품 API 업데이트
 * - eBay: ReviseInventoryStatus (재고 0)
 * - Shopify: Variant Update (재고 0)
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
}

class ShopifyAPI {
  constructor() {
    this.shopUrl = process.env.SHOPIFY_STORE_URL;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  }

  async setInventoryZero(variantId, inventoryItemId) {
    // Shopify inventory update requires inventory_item_id
    const url = `https://${this.shopUrl}/admin/api/2024-01/inventory_levels/set.json`;

    try {
      const response = await axios.post(url, {
        location_id: process.env.SHOPIFY_LOCATION_ID,
        inventory_item_id: inventoryItemId,
        available: 0
      }, {
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json'
        }
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.errors || error.message
      };
    }
  }
}

async function updateSoldoutAPI() {
  console.log('='.repeat(70));
  console.log('🔄 품절 상품 API 업데이트 (재고 0)');
  console.log('='.repeat(70));
  console.log();

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
    const platformCol = headers['판매처'];  // H열
    const ebayRegisteredCol = headers['eBay 등록'];  // W열
    const shopifyRegisteredCol = headers['Shopify 등록'];  // X열

    console.log(`   품절 표시 열: ${purchasePriceCol !== undefined ? String.fromCharCode(65 + purchasePriceCol) + '열' : '없음'}`);
    console.log(`   eBay 등록: ${ebayRegisteredCol !== undefined ? String.fromCharCode(65 + ebayRegisteredCol) + '열' : '없음'}`);
    console.log(`   Shopify 등록: ${shopifyRegisteredCol !== undefined ? String.fromCharCode(65 + shopifyRegisteredCol) + '열' : '없음'}`);
    console.log();

    // 2. 품절 상품 중 eBay 등록 상품 찾기
    console.log('🔍 2단계: 품절 상품 중 등록된 상품 찾기...\n');

    const ebay = new EbayAPI();
    const shopify = new ShopifyAPI();

    let ebaySuccess = 0;
    let ebayFail = 0;
    let shopifySuccess = 0;
    let shopifyFail = 0;
    let skipped = 0;

    const errors = [];

    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      // 배치 로드
      const minCol = Math.min(1, purchasePriceCol, ebayRegisteredCol || 22, shopifyRegisteredCol || 23);
      const maxCol = Math.max(1, purchasePriceCol, ebayRegisteredCol || 22, shopifyRegisteredCol || 23);
      await dashboard.loadCells(`${String.fromCharCode(65 + minCol)}${startRow + 1}:${String.fromCharCode(65 + maxCol)}${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        const skuCell = dashboard.getCell(row, 1);  // B열 SKU (eBay Item ID로 사용)
        const purchaseCell = dashboard.getCell(row, purchasePriceCol);
        const ebayRegCell = ebayRegisteredCol !== undefined ? dashboard.getCell(row, ebayRegisteredCol) : null;
        const shopifyRegCell = shopifyRegisteredCol !== undefined ? dashboard.getCell(row, shopifyRegisteredCol) : null;

        const itemId = skuCell.value;
        const purchaseValue = purchaseCell.value;
        const isEbayRegistered = ebayRegCell?.value?.includes('✅');
        const isShopifyRegistered = shopifyRegCell?.value?.includes('✅');

        // 품절이 아니면 스킵
        if (String(purchaseValue).toLowerCase() !== '품절') {
          continue;
        }

        // eBay 업데이트
        if (isEbayRegistered && itemId) {
          console.log(`   📦 eBay Item ${itemId}: 재고 0 업데이트 중...`);

          const result = await ebay.setQuantityZero(itemId);

          if (result.success) {
            ebaySuccess++;
            console.log(`      ✅ 성공`);
          } else {
            ebayFail++;
            console.log(`      ❌ 실패: ${result.error}`);
            errors.push({ platform: 'eBay', itemId, error: result.error });
          }

          // Rate limit 방지
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Shopify 업데이트 (TODO: Shopify Variant ID 필요)
        if (isShopifyRegistered) {
          // Shopify는 Variant ID와 Inventory Item ID가 필요
          // 현재는 스킵
          skipped++;
        }
      }

      if (endRow % 1000 === 0 || endRow === totalRows) {
        console.log(`\n   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)\n`);
      }
    }

    // 3. 결과 출력
    console.log();
    console.log('='.repeat(70));
    console.log('📊 API 업데이트 결과');
    console.log('='.repeat(70));
    console.log();
    console.log('📦 eBay:');
    console.log(`   ✅ 성공: ${ebaySuccess}개`);
    console.log(`   ❌ 실패: ${ebayFail}개`);
    console.log();
    console.log('🛍️  Shopify:');
    console.log(`   ✅ 성공: ${shopifySuccess}개`);
    console.log(`   ❌ 실패: ${shopifyFail}개`);
    console.log(`   ⏭️  스킵 (Variant ID 필요): ${skipped}개`);
    console.log();

    if (errors.length > 0) {
      console.log('⚠️  오류 상세:');
      errors.slice(0, 10).forEach((err, i) => {
        console.log(`   ${i + 1}. ${err.platform} ${err.itemId}: ${err.error}`);
      });
      if (errors.length > 10) {
        console.log(`   ... 외 ${errors.length - 10}개`);
      }
      console.log();
    }

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

updateSoldoutAPI();
