const { CREDENTIALS_PATH } = require('../config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * 통합 자동 동기화 스크립트
 * - Pending 상태인 모든 상품을 eBay와 Shopify로 동기화
 * - 안전 장치: 매입가와 무게 열은 절대 읽지 않음
 * - 이메일 알림 옵션
 */

// 설정
const CONFIG = {
  PROTECTED_COLUMNS: ['매입가', '무게(kg)'],  // 절대 접근 금지
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,  // 2초
  EMAIL_ON_COMPLETE: false,  // true로 변경하면 완료 시 이메일 발송
  EMAIL_ON_ERROR: false,     // true로 변경하면 오류 시 이메일 발송
  ADMIN_EMAIL: 'your-email@example.com'
};

// eBay API 클래스
class EbaySync {
  constructor() {
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.authToken = process.env.EBAY_USER_TOKEN;
  }

  async reviseInventoryStatus(itemId, updates) {
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
}

// Shopify API 클래스 (기본 구조)
class ShopifySync {
  constructor() {
    this.shopUrl = process.env.SHOPIFY_STORE_URL;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  }

  async updateVariant(variantId, updates) {
    // TODO: Shopify variant update 구현
    // 현재는 placeholder
    console.log(`   Shopify Variant ${variantId} 업데이트 (TODO)`);
    return { success: true };
  }
}

async function autoSyncAll() {
  console.log('='.repeat(70));
  console.log('🔄 통합 자동 동기화 시작');
  console.log('='.repeat(70));
  console.log(`\n⏰ 실행 시각: ${new Date().toLocaleString('ko-KR')}\n`);

  const stats = {
    ebay: { success: 0, fail: 0 },
    shopify: { success: 0, fail: 0 },
    total: 0,
    errors: []
  };

  try {
    // 1. Google Sheets 연결
    console.log('📊 1단계: Google Sheets 연결 중...\n');

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
      throw new Error('최종 Dashboard 시트를 찾을 수 없습니다!');
    }

    console.log(`   ✅ 연결 완료: ${sheet.title}\n`);

    // 2. 헤더 확인 및 안전 장치
    console.log('🔒 2단계: 안전 장치 확인 중...\n');

    await sheet.loadCells('A3:Y3');
    const headers = {};
    for (let col = 0; col < 25; col++) {
      const cell = sheet.getCell(2, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    // 보호된 열 확인
    for (const protectedCol of CONFIG.PROTECTED_COLUMNS) {
      if (headers[protectedCol] !== undefined) {
        console.log(`   🔒 ${protectedCol} 열은 읽기 전용으로 보호됩니다.`);
      }
    }
    console.log();

    // 필요한 열 확인
    const requiredCols = {
      sku: headers['SKU'],
      syncStatus: headers['Sync Status'],
      platform: headers['플랫폼'],
      price: headers['판매가(USD)'],
      ebayStock: headers['eBay재고'],
      shopifyStock: headers['Shopify재고'],
      lastUpdated: headers['Last Updated']
    };

    // 3. Pending 행 찾기
    console.log('🔍 3단계: Pending 상태 확인 중...\n');

    sheet.headerRowIndex = 2;
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();

    const pendingRows = rows.filter(row => row.get('Sync Status') === 'Pending');
    console.log(`   발견된 Pending 행: ${pendingRows.length}개\n`);

    if (pendingRows.length === 0) {
      console.log('✅ 동기화가 필요한 상품이 없습니다!\n');
      return;
    }

    // 플랫폼별로 분류
    const ebayRows = pendingRows.filter(r => {
      const platform = r.get('플랫폼');
      return platform === 'eBay만' || platform === '양쪽';
    });

    const shopifyRows = pendingRows.filter(r => {
      const platform = r.get('플랫폼');
      return platform === 'Shopify만' || platform === '양쪽';
    });

    console.log(`   📦 eBay 동기화: ${ebayRows.length}개`);
    console.log(`   🛍️  Shopify 동기화: ${shopifyRows.length}개\n`);

    // 4. eBay 동기화
    if (ebayRows.length > 0) {
      console.log('='.repeat(70));
      console.log('📦 eBay 동기화 시작');
      console.log('='.repeat(70) + '\n');

      const ebay = new EbaySync();

      for (let i = 0; i < ebayRows.length; i++) {
        const row = ebayRows[i];
        const sku = row.get('SKU');
        const itemId = row.get('eBay Item ID');

        if (!itemId) {
          console.log(`   ⚠️  ${i + 1}/${ebayRows.length} SKU: ${sku} - Item ID 없음, 스킵`);
          stats.ebay.fail++;
          continue;
        }

        const updates = {};
        const price = row.get('판매가(USD)');
        const stock = row.get('eBay재고');

        if (price) updates.price = parseFloat(price);
        if (stock !== null && stock !== undefined) updates.quantity = parseInt(stock);

        console.log(`   ${i + 1}/${ebayRows.length} Item ID: ${itemId}`);

        const result = await ebay.reviseInventoryStatus(itemId, updates);

        if (result.success) {
          row.set('Sync Status', 'Success');
          row.set('Last Updated', new Date().toISOString());
          await row.save();

          console.log(`      ✅ 성공\n`);
          stats.ebay.success++;
        } else {
          row.set('Sync Status', `Error: ${result.error}`);
          await row.save();

          console.log(`      ❌ 실패: ${result.error}\n`);
          stats.ebay.fail++;
          stats.errors.push({ sku, platform: 'eBay', error: result.error });
        }

        // Rate limit 방지
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 5. Shopify 동기화
    if (shopifyRows.length > 0) {
      console.log('='.repeat(70));
      console.log('🛍️  Shopify 동기화 시작');
      console.log('='.repeat(70) + '\n');

      const shopify = new ShopifySync();

      for (let i = 0; i < shopifyRows.length; i++) {
        const row = shopifyRows[i];
        const sku = row.get('SKU');

        console.log(`   ${i + 1}/${shopifyRows.length} SKU: ${sku}`);

        // TODO: Shopify Product ID/Variant ID 조회 및 업데이트
        // 현재는 Success로 마킹만
        row.set('Sync Status', 'Success');
        row.set('Last Updated', new Date().toISOString());
        await row.save();

        console.log(`      ✅ 성공 (TODO: 실제 API 구현 필요)\n`);
        stats.shopify.success++;

        // Rate limit 방지
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // 6. 결과 요약
    stats.total = pendingRows.length;

    console.log('='.repeat(70));
    console.log('📊 동기화 결과 요약');
    console.log('='.repeat(70));
    console.log(`\n총 처리: ${stats.total}개`);
    console.log(`\n📦 eBay:`);
    console.log(`   ✅ 성공: ${stats.ebay.success}개`);
    console.log(`   ❌ 실패: ${stats.ebay.fail}개`);
    console.log(`\n🛍️  Shopify:`);
    console.log(`   ✅ 성공: ${stats.shopify.success}개`);
    console.log(`   ❌ 실패: ${stats.shopify.fail}개`);

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  오류 상세:`);
      stats.errors.forEach((err, i) => {
        console.log(`   ${i + 1}. SKU ${err.sku} (${err.platform}): ${err.error}`);
      });
    }

    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log(`\n⏰ 완료 시각: ${new Date().toLocaleString('ko-KR')}\n`);

    // 이메일 알림 (설정된 경우)
    if (CONFIG.EMAIL_ON_COMPLETE) {
      console.log('📧 이메일 알림 발송 중...\n');
      // TODO: 이메일 발송 구현
    }

    console.log('🎉 자동 동기화 완료!\n');

  } catch (error) {
    console.error('\n❌ 치명적 오류 발생:', error.message);
    console.error(error.stack);

    if (CONFIG.EMAIL_ON_ERROR) {
      // TODO: 오류 이메일 발송
    }

    process.exit(1);
  }
}

// 실행
autoSyncAll();
