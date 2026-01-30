require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 플랫폼 등록 상태 칼럼 추가
 *
 * - eBay 등록 여부
 * - Shopify 등록 여부
 * - 자동으로 Item ID / Product ID 존재 여부로 판단
 */

async function addRegistrationStatus() {
  console.log('=== 플랫폼 등록 상태 칼럼 추가 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    if (!dashboard) {
      throw new Error('최종 Dashboard 시트를 찾을 수 없습니다!');
    }

    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 현재 헤더 확인 (Row 1)
    console.log('📋 1단계: 현재 헤더 확인 중...\n');
    await dashboard.loadCells('A1:Z1');

    const headers = {};
    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    console.log('   현재 헤더:', Object.keys(headers).length, '개\n');

    // 2. 빈 열 찾기 또는 마지막 열 사용
    console.log('📍 2단계: 새 칼럼 위치 확인 중...\n');

    let ebayStatusCol = headers['eBay 등록'];
    let shopifyStatusCol = headers['Shopify 등록'];

    // 빈 열 찾기 (W, X, Y 열 사용)
    if (ebayStatusCol === undefined) {
      ebayStatusCol = 22;  // W열
      const cell = dashboard.getCell(0, ebayStatusCol);
      cell.value = 'eBay 등록';
      cell.textFormat = { bold: true };
      cell.backgroundColor = { red: 0.85, green: 0.85, blue: 0.85 };
      console.log('   ✅ "eBay 등록" 헤더 추가: W열');
    } else {
      console.log('   ⏭️  "eBay 등록" 헤더 이미 존재: ' + String.fromCharCode(65 + ebayStatusCol) + '열');
    }

    if (shopifyStatusCol === undefined) {
      shopifyStatusCol = 23;  // X열
      const cell = dashboard.getCell(0, shopifyStatusCol);
      cell.value = 'Shopify 등록';
      cell.textFormat = { bold: true };
      cell.backgroundColor = { red: 0.85, green: 0.85, blue: 0.85 };
      console.log('   ✅ "Shopify 등록" 헤더 추가: X열');
    } else {
      console.log('   ⏭️  "Shopify 등록" 헤더 이미 존재: ' + String.fromCharCode(65 + shopifyStatusCol) + '열');
    }

    await dashboard.saveUpdatedCells();
    console.log();

    // 3. 플랫폼 열 확인
    console.log('🔍 3단계: 기존 데이터 확인 중...\n');

    const platformCol = headers['플랫폼'];
    const ebayItemIdCol = headers['eBay Item ID'];
    const shopifyProductIdCol = headers['Shopify Product ID'];

    console.log('   플랫폼 열:', platformCol !== undefined ? String.fromCharCode(65 + platformCol) : '없음');
    console.log('   eBay Item ID:', ebayItemIdCol !== undefined ? String.fromCharCode(65 + ebayItemIdCol) : '없음');
    console.log('   Shopify Product ID:', shopifyProductIdCol !== undefined ? String.fromCharCode(65 + shopifyProductIdCol) : '없음');
    console.log();

    // 4. 등록 상태 수식 작성
    console.log('📝 4단계: 등록 상태 수식 적용 중...\n');

    // eBay 등록 수식
    const ebayFormula = (row) => {
      if (ebayItemIdCol !== undefined) {
        const idCol = String.fromCharCode(65 + ebayItemIdCol);
        // eBay Item ID가 있으면 "✅ 등록", 없으면 "❌ 미등록"
        return `=IF(ISBLANK(${idCol}${row}),"❌ 미등록","✅ 등록")`;
      } else if (platformCol !== undefined) {
        const pCol = String.fromCharCode(65 + platformCol);
        // 플랫폼에 "eBay"가 포함되어 있으면 "✅ 등록"
        return `=IF(OR(${pCol}${row}="eBay만",${pCol}${row}="양쪽"),"✅ 등록","❌ 미등록")`;
      }
      return null;
    };

    // Shopify 등록 수식
    const shopifyFormula = (row) => {
      if (shopifyProductIdCol !== undefined) {
        const idCol = String.fromCharCode(65 + shopifyProductIdCol);
        return `=IF(ISBLANK(${idCol}${row}),"❌ 미등록","✅ 등록")`;
      } else if (platformCol !== undefined) {
        const pCol = String.fromCharCode(65 + platformCol);
        return `=IF(OR(${pCol}${row}="Shopify만",${pCol}${row}="양쪽"),"✅ 등록","❌ 미등록")`;
      }
      return null;
    };

    console.log(`   eBay 수식 예시 (Row 2): ${ebayFormula(2)}`);
    console.log(`   Shopify 수식 예시 (Row 2): ${shopifyFormula(2)}`);
    console.log();

    // 5. 배치로 수식 적용
    console.log('⚡ 5단계: 수식 적용 중...\n');

    let ebayUpdated = 0;
    let shopifyUpdated = 0;
    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      // 배치 로드
      const ebayCol = String.fromCharCode(65 + ebayStatusCol);
      const shopifyCol = String.fromCharCode(65 + shopifyStatusCol);
      await dashboard.loadCells(`${ebayCol}${startRow + 1}:${shopifyCol}${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        // eBay 등록 상태
        const ebayCell = dashboard.getCell(row, ebayStatusCol);
        const ebayF = ebayFormula(row + 1);
        if (ebayF) {
          ebayCell.formula = ebayF;
          ebayUpdated++;
        }

        // Shopify 등록 상태
        const shopifyCell = dashboard.getCell(row, shopifyStatusCol);
        const shopifyF = shopifyFormula(row + 1);
        if (shopifyF) {
          shopifyCell.formula = shopifyF;
          shopifyUpdated++;
        }
      }

      await dashboard.saveUpdatedCells();

      if (endRow % 1000 === 0 || endRow === totalRows) {
        console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
      }
    }

    console.log();
    console.log(`   ✅ eBay 등록 상태: ${ebayUpdated}개 행`);
    console.log(`   ✅ Shopify 등록 상태: ${shopifyUpdated}개 행`);
    console.log();

    // 6. 조건부 서식 안내
    console.log('='.repeat(70));
    console.log('🎨 조건부 서식 설정 안내');
    console.log('='.repeat(70));
    console.log();
    console.log('Google Sheets에서 조건부 서식을 설정하세요:\n');

    const ebayColLetter = String.fromCharCode(65 + ebayStatusCol);
    const shopifyColLetter = String.fromCharCode(65 + shopifyStatusCol);

    console.log(`📌 eBay 등록 완료 (초록색):`);
    console.log(`   1. 범위: ${ebayColLetter}2:${ebayColLetter}10000`);
    console.log(`   2. 서식 → 조건부 서식`);
    console.log(`   3. 텍스트에 "✅ 등록" 포함`);
    console.log(`   4. 배경색: #D9EAD3 (연한 초록색)\n`);

    console.log(`📌 eBay 미등록 (연한 회색):`);
    console.log(`   1. 범위: ${ebayColLetter}2:${ebayColLetter}10000`);
    console.log(`   2. 서식 → 조건부 서식`);
    console.log(`   3. 텍스트에 "❌ 미등록" 포함`);
    console.log(`   4. 배경색: #F3F3F3 (연한 회색)\n`);

    console.log(`📌 Shopify 등록 완료 (초록색):`);
    console.log(`   1. 범위: ${shopifyColLetter}2:${shopifyColLetter}10000`);
    console.log(`   2. 서식 → 조건부 서식`);
    console.log(`   3. 텍스트에 "✅ 등록" 포함`);
    console.log(`   4. 배경색: #D9EAD3 (연한 초록색)\n`);

    console.log(`📌 Shopify 미등록 (연한 회색):`);
    console.log(`   1. 범위: ${shopifyColLetter}2:${shopifyColLetter}10000`);
    console.log(`   2. 서식 → 조건부 서식`);
    console.log(`   3. 텍스트에 "❌ 미등록" 포함`);
    console.log(`   4. 배경색: #F3F3F3 (연한 회색)\n`);

    console.log('='.repeat(70));
    console.log('✅ 플랫폼 등록 상태 칼럼 추가 완료!');
    console.log('='.repeat(70));
    console.log();
    console.log('📊 추가된 칼럼:');
    console.log(`   - eBay 등록 (${ebayColLetter}열): ✅ 등록 / ❌ 미등록`);
    console.log(`   - Shopify 등록 (${shopifyColLetter}열): ✅ 등록 / ❌ 미등록`);
    console.log();
    console.log('💡 사용 방법:');
    console.log('   - ✅ 등록: 해당 플랫폼에 상품이 등록되어 있음');
    console.log('   - ❌ 미등록: 해당 플랫폼에 상품이 등록되지 않음');
    console.log();
    console.log('🔍 필터링 예시:');
    console.log('   - eBay에만 등록된 상품: eBay 등록 = "✅", Shopify 등록 = "❌"');
    console.log('   - Shopify에만 등록된 상품: eBay 등록 = "❌", Shopify 등록 = "✅"');
    console.log('   - 양쪽 모두 등록: 둘 다 "✅"');
    console.log('   - 미등록 상품: 둘 다 "❌"');
    console.log();
    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();
    console.log('🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

addRegistrationStatus();
