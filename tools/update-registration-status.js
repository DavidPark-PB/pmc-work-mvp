require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 플랫폼 등록 상태 수식 업데이트
 * - H열 (판매처) 기반으로 등록 여부 판단
 */

async function updateRegistrationStatus() {
  console.log('=== 플랫폼 등록 상태 수식 업데이트 ===\n');

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

    const platformCol = headers['판매처'];  // H열
    const ebayStatusCol = headers['eBay 등록'];  // W열
    const shopifyStatusCol = headers['Shopify 등록'];  // X열

    console.log('   판매처 열:', platformCol !== undefined ? String.fromCharCode(65 + platformCol) + '열' : '없음');
    console.log('   eBay 등록 열:', ebayStatusCol !== undefined ? String.fromCharCode(65 + ebayStatusCol) + '열' : '없음');
    console.log('   Shopify 등록 열:', shopifyStatusCol !== undefined ? String.fromCharCode(65 + shopifyStatusCol) + '열' : '없음');
    console.log();

    if (platformCol === undefined || ebayStatusCol === undefined || shopifyStatusCol === undefined) {
      console.error('❌ 필요한 열을 찾을 수 없습니다!');
      return;
    }

    // 2. 수식 생성
    console.log('📝 2단계: 등록 상태 수식 생성 중...\n');

    const platformColLetter = String.fromCharCode(65 + platformCol);  // H

    // eBay 등록 수식: 판매처에 "eBay"가 포함되어 있거나 "양쪽"인 경우
    const ebayFormula = (row) => {
      return `=IF(OR(${platformColLetter}${row}="eBay만",${platformColLetter}${row}="양쪽",ISNUMBER(SEARCH("ebay",LOWER(${platformColLetter}${row})))),"✅ 등록","❌ 미등록")`;
    };

    // Shopify 등록 수식: 판매처에 "Shopify"가 포함되어 있거나 "양쪽"인 경우
    const shopifyFormula = (row) => {
      return `=IF(OR(${platformColLetter}${row}="Shopify만",${platformColLetter}${row}="양쪽",ISNUMBER(SEARCH("shopify",LOWER(${platformColLetter}${row})))),"✅ 등록","❌ 미등록")`;
    };

    console.log(`   eBay 수식 예시 (Row 2):`);
    console.log(`   ${ebayFormula(2)}\n`);
    console.log(`   Shopify 수식 예시 (Row 2):`);
    console.log(`   ${shopifyFormula(2)}\n`);

    // 3. 배치로 수식 적용
    console.log('⚡ 3단계: 수식 적용 중...\n');

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
        ebayCell.formula = ebayFormula(row + 1);
        ebayUpdated++;

        // Shopify 등록 상태
        const shopifyCell = dashboard.getCell(row, shopifyStatusCol);
        shopifyCell.formula = shopifyFormula(row + 1);
        shopifyUpdated++;
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

    // 4. 샘플 데이터 확인
    console.log('🔍 4단계: 샘플 데이터 확인 중...\n');

    await dashboard.loadCells('H2:X6');

    console.log('   샘플 5개 상품:\n');
    for (let row = 1; row < 6; row++) {
      const platform = dashboard.getCell(row, platformCol).value || '(비어있음)';
      const ebayStatus = dashboard.getCell(row, ebayStatusCol).value || '(계산중)';
      const shopifyStatus = dashboard.getCell(row, shopifyStatusCol).value || '(계산중)';

      console.log(`   Row ${row + 1}:`);
      console.log(`      판매처: ${platform}`);
      console.log(`      eBay: ${ebayStatus}`);
      console.log(`      Shopify: ${shopifyStatus}`);
      console.log();
    }

    console.log('='.repeat(70));
    console.log('✅ 플랫폼 등록 상태 업데이트 완료!');
    console.log('='.repeat(70));
    console.log();
    console.log('📊 업데이트된 칼럼:');
    console.log(`   - W열 (eBay 등록): ${ebayUpdated}개 행`);
    console.log(`   - X열 (Shopify 등록): ${shopifyUpdated}개 행`);
    console.log();
    console.log('💡 판단 기준:');
    console.log('   - 판매처가 "eBay만" 또는 "양쪽" → eBay "✅ 등록"');
    console.log('   - 판매처가 "Shopify만" 또는 "양쪽" → Shopify "✅ 등록"');
    console.log('   - 그 외 → "❌ 미등록"');
    console.log();
    console.log('🔍 필터 사용법:');
    console.log('   1. W열 또는 X열 클릭');
    console.log('   2. 필터 아이콘 클릭');
    console.log('   3. "✅ 등록" 또는 "❌ 미등록" 선택');
    console.log();
    console.log('📌 조건부 서식 설정:');
    console.log('   - W2:W10000 범위, "✅ 등록" 포함 → #D9EAD3 (초록색)');
    console.log('   - W2:W10000 범위, "❌ 미등록" 포함 → #F3F3F3 (회색)');
    console.log('   - X2:X10000 범위, "✅ 등록" 포함 → #D9EAD3 (초록색)');
    console.log('   - X2:X10000 범위, "❌ 미등록" 포함 → #F3F3F3 (회색)');
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

updateRegistrationStatus();
