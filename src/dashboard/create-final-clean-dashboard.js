require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const axios = require('axios');

/**
 * 최종 클린 Dashboard - CAD 완전 제거, 실시간 수식 업데이트
 */

async function createFinalCleanDashboard() {
  console.log('=== 최종 클린 Dashboard 생성 시작 ===\n');

  try {
    // 1. 실시간 환율 가져오기
    console.log('💱 Step 1: 실시간 환율 조회...');
    let usdToKrw = 1300;

    try {
      const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
      usdToKrw = response.data.rates.KRW;
      console.log(`   ✅ USD → KRW: ${usdToKrw.toFixed(2)}`);
    } catch (error) {
      console.log(`   ⚠️  환율 API 실패, 기본값 사용`);
    }

    // 2. Google Sheets 인증
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`\n📊 스프레드시트: ${doc.title}\n`);

    // 3. eBay Products 시트에서 데이터 읽기
    console.log('📖 Step 2: eBay Products 데이터 읽기...');
    const ebaySheet = doc.sheetsByTitle['eBay Products'];
    if (!ebaySheet) {
      console.error('❌ "eBay Products" 시트를 찾을 수 없습니다!');
      return;
    }

    const ebayRows = await ebaySheet.getRows({ limit: 10000 });
    console.log(`   ✅ ${ebayRows.length}개 eBay 상품 로드됨`);

    // 4. Shopify Products 시트에서 데이터 읽기
    console.log('\n📖 Step 3: Shopify Products 데이터 읽기...');
    const shopifySheet = doc.sheetsByTitle['시트1'];
    let shopifyRows = [];

    if (!shopifySheet) {
      console.warn('⚠️  "시트1" 시트 없음. eBay만 사용.');
    } else {
      shopifyRows = await shopifySheet.getRows({ limit: 10000 });
      console.log(`   ✅ ${shopifyRows.length}개 Shopify 상품 로드됨`);
    }

    // 5. 데이터 매칭
    console.log('\n🔄 Step 4: SKU 기준 데이터 매칭...');

    const ebayMap = new Map();
    ebayRows.forEach(row => {
      let sku = row.get('SKU');
      const itemId = row.get('Item ID') || '';

      // SKU가 N/A이거나 없으면 Item ID를 SKU로 사용
      if (!sku || sku === 'N/A') {
        sku = itemId;
      }

      if (sku) {
        ebayMap.set(sku, {
          title: row.get('Title') || '',
          itemId: itemId,
          price: parseFloat(row.get('Price')) || 0,
          shippingCost: parseFloat(row.get('Shipping Cost')) || 0,
          quantity: parseInt(row.get('Quantity')) || 0,
          sold: parseInt(row.get('Sold')) || 0,
          status: row.get('Status') || 'N/A',
          imageUrl: row.get('Image URL') || ''
        });
      }
    });

    const shopifyMap = new Map();

    shopifyRows.forEach(row => {
      const sku = row.get('SKU');
      if (sku && sku !== 'N/A') {
        // 시트1의 실제 컬럼명 사용
        const costPriceKRW = parseFloat(row.get('매입가(KRW)')) || 0;
        const shopifyPriceUSD = parseFloat(row.get('쇼피파이 판매가($)')) || 0;
        const weight = parseFloat(row.get('Weight')) || 0;
        const title = row.get('상품명') || '';
        const status = row.get('검수 상태') || '';
        const platform = row.get('플랫폼') || '';

        shopifyMap.set(sku, {
          title: title,
          costPriceKRW: costPriceKRW, // 이미 KRW로 저장되어 있음
          priceUSD: shopifyPriceUSD,
          status: status,
          platform: platform,
          weight: weight,
          imageUrl: row.get('Image') || row.get('이미지') || ''
        });
      }
    });

    const allSKUs = new Set([...ebayMap.keys(), ...shopifyMap.keys()]);
    console.log(`   ✅ 총 ${allSKUs.size}개 고유 SKU 발견`);

    // 6. Dashboard 데이터 생성
    console.log('\n🔨 Step 5: 최종 Dashboard 데이터 생성...');

    const dashboardData = [];
    const FIXED_SHIPPING_KRW = 15000;

    allSKUs.forEach(sku => {
      const ebay = ebayMap.get(sku);
      const shopify = shopifyMap.get(sku);

      // 매입가는 Shopify 시트에 이미 KRW로 저장되어 있음
      const costPriceKRW = shopify?.costPriceKRW || '';

      const row = {
        imageUrl: ebay?.imageUrl || shopify?.imageUrl || '',
        sku,
        title: ebay?.title || shopify?.title || 'N/A',
        vendor: 'N/A', // Shopify 시트에 Vendor 컬럼 없음
        ebayItemId: ebay?.itemId || '',

        // KRW 기준
        costPriceKRW: costPriceKRW,

        // USD 기준
        ebayPriceUSD: ebay?.price || '',
        ebayShippingUSD: ebay?.shippingCost || '',

        // KRW 기준
        shippingKRW: FIXED_SHIPPING_KRW,

        // Performance
        ebaySold: ebay?.sold || 0,
        ebayQuantity: ebay?.quantity || 0,
        shopifyInventory: 0, // Shopify 시트에 재고 정보 없음
        weight: shopify?.weight || 0,

        // Ops
        ebayStatus: ebay?.status || '미등록',
        shopifyStatus: shopify?.status || '미등록',
        platform: ebay && shopify ? '양쪽' : ebay ? 'eBay만' : 'Shopify만'
      };

      dashboardData.push(row);
    });

    // 7. Dashboard 시트 생성
    console.log('\n📝 Step 6: 최종 Dashboard 시트 생성...');

    let sheet = doc.sheetsByTitle['최종 Dashboard'];
    if (sheet) {
      await sheet.delete();
      console.log('   기존 시트 삭제됨');
    }

    sheet = await doc.addSheet({
      title: '최종 Dashboard',
      gridProperties: {
        rowCount: 10000,
        columnCount: 25,
        frozenRowCount: 3
      }
    });
    console.log('   새 시트 생성됨');

    // 8. 상단 변수칸
    console.log('\n📐 Step 7: 변수칸 작성...');

    await sheet.loadCells('A1:H2');

    sheet.getCell(0, 0).value = '🚚 배송비';
    sheet.getCell(0, 0).textFormat = { bold: true, fontSize: 14 };
    sheet.getCell(0, 0).backgroundColor = { red: 0.2, green: 0.6, blue: 1 };

    sheet.getCell(0, 3).value = '💱 환율';
    sheet.getCell(0, 3).textFormat = { bold: true, fontSize: 14 };
    sheet.getCell(0, 3).backgroundColor = { red: 0.2, green: 0.8, blue: 0.6 };

    sheet.getCell(1, 0).value = '배송비(KRW):';
    sheet.getCell(1, 0).textFormat = { bold: true };
    sheet.getCell(1, 1).value = FIXED_SHIPPING_KRW;
    sheet.getCell(1, 1).numberFormat = { type: 'NUMBER', pattern: '#,##0' };
    sheet.getCell(1, 1).backgroundColor = { red: 1, green: 1, blue: 0.6 };

    sheet.getCell(1, 3).value = 'USD→KRW:';
    sheet.getCell(1, 3).textFormat = { bold: true };
    sheet.getCell(1, 4).value = 1400;
    sheet.getCell(1, 4).numberFormat = { type: 'NUMBER', pattern: '#,##0' };
    sheet.getCell(1, 4).backgroundColor = { red: 0.9, green: 1, blue: 0.9 };
    sheet.getCell(1, 4).note = '환율 변경 시 이 값을 직접 수정하세요';

    await sheet.saveUpdatedCells();
    console.log('   ✅ 변수칸 추가됨 (배송비: B2, 환율: E2)');

    // 헤더 설정 - 3행에 직접 작성
    console.log('\n📋 헤더 행 작성 중...');
    const headers = [
      'Image', 'SKU', 'Product Title', 'Vendor', 'eBay Item ID',
      '매입가(KRW)', 'eBay가격(USD)', 'eBay배송비(USD)',
      'eBay수수료(USD)', '미국세금(KRW)', '정산액(KRW)',
      '배송비(KRW)', '최종순이익(KRW)', '마진율(%)',
      '무게(kg)', 'eBay판매량', 'eBay재고', 'Shopify재고',
      'eBay상태', 'Shopify상태', '플랫폼',
      'Last Updated'
    ];

    await sheet.loadCells('A3:V3');
    for (let col = 0; col < headers.length; col++) {
      const cell = sheet.getCell(2, col);
      cell.value = headers[col];
      cell.textFormat = { bold: true, fontSize: 11 };
      cell.backgroundColor = { red: 0.85, green: 0.85, blue: 0.85 };
    }
    await sheet.saveUpdatedCells();
    console.log('   ✅ 헤더 행 작성 완료');

    // 9. 데이터 삽입 - 직접 셀에 작성
    console.log(`\n📥 Step 8: ${dashboardData.length}개 행 데이터 작성 중...`);

    const lastRow = dashboardData.length + 3; // 3행이 헤더, 4행부터 데이터

    // 배치 처리를 위해 1000개씩 나눠서 작성
    const batchSize = 1000;
    for (let batchStart = 0; batchStart < dashboardData.length; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, dashboardData.length);
      const currentBatchLastRow = batchEnd + 3;

      console.log(`   진행 중: ${batchStart + 1}-${batchEnd} / ${dashboardData.length}...`);

      // A~H, L, O~V 열만 로드 (수식 열 제외, 이미지 컬럼 추가로 한 칸씩 이동)
      await sheet.loadCells(`A${batchStart + 4}:H${currentBatchLastRow}`);
      await sheet.loadCells(`L${batchStart + 4}:L${currentBatchLastRow}`);
      await sheet.loadCells(`O${batchStart + 4}:V${currentBatchLastRow}`);

      for (let i = batchStart; i < batchEnd; i++) {
        const d = dashboardData[i];
        const rowIdx = i + 3; // 0-based (4행 = index 3)

        // A열: 이미지 URL (나중에 IMAGE 함수로 변환)
        sheet.getCell(rowIdx, 0).value = d.imageUrl || '';

        // B-H, L, O-V 열: 데이터 값 (이미지 컬럼 추가로 인덱스 +1)
        sheet.getCell(rowIdx, 1).value = d.sku || '';
        sheet.getCell(rowIdx, 2).value = d.title || '';
        sheet.getCell(rowIdx, 3).value = d.vendor || '';
        sheet.getCell(rowIdx, 4).value = d.ebayItemId || '';
        sheet.getCell(rowIdx, 5).value = d.costPriceKRW || '';
        if (d.costPriceKRW) {
          sheet.getCell(rowIdx, 5).numberFormat = { type: 'NUMBER', pattern: '#,##0' };
        }
        sheet.getCell(rowIdx, 6).value = d.ebayPriceUSD || '';
        if (d.ebayPriceUSD) {
          sheet.getCell(rowIdx, 6).numberFormat = { type: 'NUMBER', pattern: '0.00' };
        }
        sheet.getCell(rowIdx, 7).value = d.ebayShippingUSD || '';
        if (d.ebayShippingUSD) {
          sheet.getCell(rowIdx, 7).numberFormat = { type: 'NUMBER', pattern: '0.00' };
        }
        sheet.getCell(rowIdx, 11).value = d.shippingKRW || '';
        if (d.shippingKRW) {
          sheet.getCell(rowIdx, 11).numberFormat = { type: 'NUMBER', pattern: '#,##0' };
        }
        sheet.getCell(rowIdx, 14).value = d.weight || '';
        sheet.getCell(rowIdx, 15).value = d.ebaySold || '';
        sheet.getCell(rowIdx, 16).value = d.ebayQuantity || '';
        sheet.getCell(rowIdx, 17).value = d.shopifyInventory || '';
        sheet.getCell(rowIdx, 18).value = d.ebayStatus || '';
        sheet.getCell(rowIdx, 19).value = d.shopifyStatus || '';
        sheet.getCell(rowIdx, 20).value = d.platform || '';
        sheet.getCell(rowIdx, 21).value = new Date().toISOString();
      }

      await sheet.saveUpdatedCells();
    }

    console.log('   ✅ 기본 데이터 작성 완료!');

    // 10. 전체 행에 수식 적용 - 배치 처리
    console.log('\n📐 Step 9: 전체 행 수식 적용 중...');

    const totalRows = dashboardData.length;
    const formulaBatchSize = 1000;

    for (let batchStart = 0; batchStart < totalRows; batchStart += formulaBatchSize) {
      const batchEnd = Math.min(batchStart + formulaBatchSize, totalRows);
      const currentBatchLastRow = batchEnd + 3;

      console.log(`   진행: ${batchStart + 1}-${batchEnd} / ${totalRows}...`);

      // I~K, M~N 열 로드 (수식 열, 이미지 컬럼 추가로 한 칸씩 이동)
      await sheet.loadCells(`I${batchStart + 4}:K${currentBatchLastRow}`);
      await sheet.loadCells(`M${batchStart + 4}:N${currentBatchLastRow}`);

      for (let i = batchStart; i < batchEnd; i++) {
        const rowNum = i + 4; // 실제 시트 행 번호 (1-based)
        const rowIdx = i + 3; // 0-based index

        // I열: eBay수수료(USD) = (eBay가격 + eBay배송비) * 0.18 (컬럼 G, H로 변경)
        const feeCell = sheet.getCell(rowIdx, 8);
        feeCell.formula = `=IFERROR(IF(OR(ISBLANK(G${rowNum}),VALUE(G${rowNum})=0),"",(VALUE(G${rowNum})+VALUE(H${rowNum}))*0.18),"")`;
        feeCell.numberFormat = { type: 'NUMBER', pattern: '0.00' };

        // J열: 미국세금(KRW) = 매입가(KRW) * 0.15 (컬럼 F로 변경)
        const taxCell = sheet.getCell(rowIdx, 9);
        taxCell.formula = `=IFERROR(IF(OR(ISBLANK(F${rowNum}),VALUE(F${rowNum})=0),"",VALUE(F${rowNum})*0.15),"")`;
        taxCell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };

        // K열: 정산액(KRW) = (eBay가격 + eBay배송비) * 0.82 * 1400 (컬럼 G, H로 변경)
        const settlementCell = sheet.getCell(rowIdx, 10);
        settlementCell.formula = `=IFERROR(IF(OR(ISBLANK(G${rowNum}),VALUE(G${rowNum})=0),"",(VALUE(G${rowNum})+VALUE(H${rowNum}))*0.82*1400),"")`;
        settlementCell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };

        // M열: 최종순이익(KRW) = 정산액(KRW) - 매입가(KRW) - 미국세금(KRW) - 배송비(KRW) (F, J, K, L로 변경)
        const profitCell = sheet.getCell(rowIdx, 12);
        profitCell.formula = `=IFERROR(IF(OR(ISBLANK(F${rowNum}),ISBLANK(K${rowNum}),VALUE(F${rowNum})=0,VALUE(K${rowNum})=0),"",VALUE(K${rowNum})-VALUE(F${rowNum})-VALUE(J${rowNum})-VALUE(L${rowNum})),"")`;
        profitCell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };

        // N열: 마진율(%) = 최종순이익(KRW) / 정산액(KRW) * 100 (K, M으로 변경)
        const marginCell = sheet.getCell(rowIdx, 13);
        marginCell.formula = `=IFERROR(IF(OR(ISBLANK(K${rowNum}),ISBLANK(M${rowNum}),VALUE(K${rowNum})=0),"",VALUE(M${rowNum})/VALUE(K${rowNum})*100),"")`;
        marginCell.numberFormat = { type: 'NUMBER', pattern: '0.00' };
      }

      await sheet.saveUpdatedCells();
    }
    console.log('   ✅ 수식 적용 완료!');

    // 11. 조건부 서식
    console.log('\n🎨 Step 10: 조건부 서식 적용...');

    const finalLastRow = dashboardData.length + 3;

    // 최종순이익 <= 0 → 진한 빨간색 (M열로 변경, 컬럼 범위 22로 확장)
    await sheet.addConditionalFormatRule({
      ranges: [{
        startRowIndex: 3,
        endRowIndex: finalLastRow,
        startColumnIndex: 0,
        endColumnIndex: 22
      }],
      booleanRule: {
        condition: {
          type: 'CUSTOM_FORMULA',
          values: [{ userEnteredValue: '=AND($M4<>"", $M4<=0)' }]
        },
        format: {
          backgroundColor: { red: 1, green: 0.4, blue: 0.4 }
        }
      }
    });

    // 최종순이익 > 0 & < 5000 → 빨간색 (M열로 변경, 컬럼 범위 22로 확장)
    await sheet.addConditionalFormatRule({
      ranges: [{
        startRowIndex: 3,
        endRowIndex: finalLastRow,
        startColumnIndex: 0,
        endColumnIndex: 22
      }],
      booleanRule: {
        condition: {
          type: 'CUSTOM_FORMULA',
          values: [{ userEnteredValue: '=AND($M4<>"", $M4>0, $M4<5000)' }]
        },
        format: {
          backgroundColor: { red: 1, green: 0.6, blue: 0.6 }
        }
      }
    });

    console.log('   ✅ 조건부 서식 적용 완료!');

    console.log('\n📊 최종 Dashboard 통계:\n');
    console.log(`   총 SKU: ${allSKUs.size}개`);
    console.log(`   양쪽 플랫폼: ${dashboardData.filter(d => d.platform === '양쪽').length}개`);

    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 최종 클린 Dashboard 생성 완료!\n');
    console.log('💡 핵심 개선:');
    console.log(`   ✅ 총 ${dashboardData.length}개 행 데이터 삽입`);
    console.log(`   ✅ eBay + Shopify 데이터 통합 (SKU 매칭)`);
    console.log('   ✅ 매입가 KRW 기준, 고정 환율 1400원');
    console.log('   ✅ eBay 수수료 18%, 미국세금 15% 적용');
    console.log('   ✅ 정산액 = (eBay가격 + 배송비) × 0.82 × 1400');
    console.log('   ✅ 최종순이익 = 정산액 - 매입가 - 미국세금 - 배송비(15000)');
    console.log('   ✅ 조건부 서식: 적자(빨간색), 5000원 미만(연한 빨간색)\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

createFinalCleanDashboard();
