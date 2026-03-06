require('../config');
const ShopifyAPI = require('../api/shopifyAPI');
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * Shopify 상품 데이터를 Google Sheets에 동기화
 * - SKU, Title, Price를 A, B, D 열에 업데이트
 * - 기존 SKU는 업데이트, 새로운 SKU는 추가
 */
async function syncShopifyToSheets() {
  console.log('\n=== Shopify → Google Sheets 동기화 시작 ===\n');

  try {
    // 1. Shopify API 초기화 및 연결 테스트
    const shopify = new ShopifyAPI();
    const isConnected = await shopify.testConnection();

    if (!isConnected) {
      console.error('❌ Shopify 연결 실패. .env 파일을 확인하세요.');
      return;
    }

    // 2. Google Sheets API 초기화
    const sheets = new GoogleSheetsAPI();
    await sheets.authenticate();

    // 3. Shopify에서 모든 상품 가져오기
    console.log('\n📥 Step 1: Shopify 상품 데이터 가져오기');
    const products = await shopify.getAllProducts();
    const shopifyData = shopify.formatProductsForSheet(products);

    console.log(`   총 ${shopifyData.length}개의 상품 변형(Variant) 발견`);

    // 4. 기존 시트 데이터 읽기
    console.log('\n📖 Step 2: 기존 Google Sheets 데이터 읽기');
    const existingData = await sheets.readData(SPREADSHEET_ID, '시트1!A2:I');

    // SKU를 키로 하는 Map 생성 (기존 데이터)
    const existingMap = new Map();
    existingData.forEach((row, index) => {
      const sku = row[0];
      if (sku) {
        existingMap.set(sku, {
          rowIndex: index + 2, // A2부터 시작이므로 +2
          data: row
        });
      }
    });

    console.log(`   기존 데이터: ${existingMap.size}개 SKU`);

    // 5. 데이터 병합 및 업데이트
    console.log('\n🔄 Step 3: 데이터 병합 및 업데이트');

    let updatedCount = 0;
    let addedCount = 0;
    const updates = [];

    for (const [sku, title, price] of shopifyData) {
      if (existingMap.has(sku)) {
        // 기존 SKU 업데이트
        const existing = existingMap.get(sku);
        const rowIndex = existing.rowIndex;

        // B열(상품명), D열(판매가) 업데이트
        updates.push({
          range: `시트1!B${rowIndex}`,
          values: [[title]]
        });
        updates.push({
          range: `시트1!D${rowIndex}`,
          values: [[price.toString()]]
        });

        updatedCount++;
      } else {
        // 새로운 SKU 추가
        // 나중에 일괄 추가할 배열에 저장
        addedCount++;
      }
    }

    // 6. 기존 데이터 업데이트
    if (updates.length > 0) {
      console.log(`   📝 ${updatedCount}개 상품 업데이트 중...`);
      for (const update of updates) {
        await sheets.writeData(SPREADSHEET_ID, update.range, update.values);
      }
    }

    // 7. 새로운 상품 추가
    if (addedCount > 0) {
      console.log(`   ➕ ${addedCount}개 신규 상품 추가 중...`);

      const newProducts = [];
      for (const [sku, title, price] of shopifyData) {
        if (!existingMap.has(sku)) {
          // A(SKU), B(Title), C(매입가-빈값), D(Price), E~K(설정값)
          newProducts.push([
            sku,              // A: SKU
            title,            // B: 상품명
            '',               // C: 매입가(KRW) - 수동 입력 필요
            price.toString(), // D: 쇼피파이 판매가($)
            '1350',           // E: 환율 (기본값)
            '5',              // F: 수수료(%) (Shopify 5%)
            '',               // G: 배송비(KRW) - 수동 입력 필요
            '',               // H: 순이익 (수식)
            '',               // I: 마진율 (수식)
            '검수대기',       // J: 검수 상태
            'Shopify'         // K: 플랫폼
          ]);
        }
      }

      if (newProducts.length > 0) {
        // 마지막 행 다음에 추가
        const nextRow = existingData.length + 2;
        await sheets.writeData(SPREADSHEET_ID, `시트1!A${nextRow}`, newProducts);

        // 수식 추가
        console.log('   📐 수식 추가 중...');
        for (let i = 0; i < newProducts.length; i++) {
          const rowNum = nextRow + i;
          const formulas = [
            [
              `=(D${rowNum}*E${rowNum})*(1-(F${rowNum}/100))-(C${rowNum}+G${rowNum})`,  // H: 순이익
              `=H${rowNum}/(D${rowNum}*E${rowNum})*100`                                   // I: 마진율
            ]
          ];
          await sheets.writeData(SPREADSHEET_ID, `시트1!H${rowNum}`, formulas);
        }
      }
    }

    // 8. 결과 요약
    console.log('\n✅ 동기화 완료!');
    console.log(`\n📊 결과 요약:`);
    console.log(`   - Shopify 상품: ${shopifyData.length}개`);
    console.log(`   - 업데이트됨: ${updatedCount}개`);
    console.log(`   - 신규 추가됨: ${addedCount}개`);

    if (addedCount > 0) {
      console.log(`\n⚠️  주의: 새로 추가된 ${addedCount}개 상품의 매입가와 배송비를 수동으로 입력해주세요!`);
    }

    console.log(`\n🔗 스프레드시트 확인:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

  } catch (error) {
    console.error('\n❌ 동기화 실패:', error.message);
    console.error(error);
  }
}

// 스크립트 실행
syncShopifyToSheets();
