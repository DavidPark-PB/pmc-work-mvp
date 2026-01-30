require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 수수료 공식 업데이트
 * - eBay: 18% 수수료
 * - Shopify: 3.3% 수수료
 * - IF 공식 사용: =IF(플랫폼="eBay만", 판매가*0.18, IF(플랫폼="Shopify만", 판매가*0.033, 판매가*0.18))
 */

async function updateFeeFormulas() {
  console.log('=== 수수료 공식 업데이트 시작 ===\n');
  console.log('⚠️  eBay: 18%, Shopify: 3.3%\n');

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
    if (!dashboard) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 헤더 확인 (row 3 = index 2)
    console.log('📋 1단계: 헤더 확인 중...\n');
    await dashboard.loadCells('A3:Y3');

    const headers = {};
    for (let col = 0; col < 25; col++) {
      const cell = dashboard.getCell(2, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    const colPrice = headers['판매가(USD)'];
    const colFee = headers['플랫폼 수수료(USD)'];
    const colPlatform = headers['플랫폼'];

    if (colPrice === undefined || colFee === undefined || colPlatform === undefined) {
      console.error('❌ 필요한 열을 찾을 수 없습니다!');
      console.log(`   판매가: ${colPrice}, 수수료: ${colFee}, 플랫폼: ${colPlatform}`);
      return;
    }

    console.log(`   열 위치:`);
    console.log(`   - 판매가(USD): ${String.fromCharCode(65 + colPrice)}열`);
    console.log(`   - 플랫폼 수수료(USD): ${String.fromCharCode(65 + colFee)}열`);
    console.log(`   - 플랫폼: ${String.fromCharCode(65 + colPlatform)}열\n`);

    // 2. 공식 생성
    const priceCol = String.fromCharCode(65 + colPrice);
    const platformCol = String.fromCharCode(65 + colPlatform);

    // 수식: =IF(U4="eBay만", G4*0.18, IF(U4="Shopify만", G4*0.033, IF(U4="양쪽", G4*0.18, 0)))
    const formulaTemplate = (row) => {
      return `=IF(${platformCol}${row}="eBay만", ${priceCol}${row}*0.18, IF(${platformCol}${row}="Shopify만", ${priceCol}${row}*0.033, IF(${platformCol}${row}="양쪽", ${priceCol}${row}*0.18, 0)))`;
    };

    console.log('📝 2단계: 공식 적용 중...\n');
    console.log(`   공식 예시 (Row 4): ${formulaTemplate(4)}\n`);

    // 3. 배치로 공식 적용
    let updatedCount = 0;
    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 3; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      // 배치 로드 - 모든 필요한 열 포함 (G, I, U)
      const minCol = Math.min(colPrice, colFee, colPlatform);
      const maxCol = Math.max(colPrice, colFee, colPlatform);
      const startColLetter = String.fromCharCode(65 + minCol);
      const endColLetter = String.fromCharCode(65 + maxCol);
      await dashboard.loadCells(`${startColLetter}${startRow + 1}:${endColLetter}${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        const feeCell = dashboard.getCell(row, colFee);
        const platformCell = dashboard.getCell(row, colPlatform);
        const priceCell = dashboard.getCell(row, colPrice);

        // 플랫폼과 가격이 있는 행만 처리
        if (platformCell.value && priceCell.value) {
          feeCell.formula = formulaTemplate(row + 1);  // row+1 for 1-based indexing
          updatedCount++;
        }
      }

      // 배치 저장
      await dashboard.saveUpdatedCells();

      if (endRow % 1000 === 0 || endRow === totalRows) {
        console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ 수수료 공식 업데이트 완료!');
    console.log('='.repeat(60));
    console.log(`\n📊 결과:`);
    console.log(`   공식 적용: ${updatedCount}개 행`);
    console.log(`   - eBay만: 18% 수수료`);
    console.log(`   - Shopify만: 3.3% 수수료`);
    console.log(`   - 양쪽: 18% 수수료 (eBay 기준)`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n💡 다음 단계:');
    console.log('   recalculate-shipping.js - 배송비 재계산');
    console.log('\n🎉 3단계 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

updateFeeFormulas();
