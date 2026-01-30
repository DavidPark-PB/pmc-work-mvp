require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkBothPlatforms() {
  console.log('=== "양쪽" 플랫폼 데이터 확인 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['최종 Dashboard'];

    console.log('🔍 "양쪽" 플랫폼 데이터 찾는 중...\n');

    // 1000행씩 검색하여 "양쪽" 찾기
    let foundCount = 0;
    const targetCount = 5;

    for (let batchStart = 0; batchStart < 4000 && foundCount < targetCount; batchStart += 1000) {
      const batchEnd = Math.min(batchStart + 1000, 4000);

      await sheet.loadCells(`A${batchStart + 4}:U${batchEnd + 3}`);

      for (let row = batchStart; row < batchEnd && foundCount < targetCount; row++) {
        const rowIdx = row + 3;
        const platform = sheet.getCell(rowIdx, 19).value;

        if (platform === '양쪽') {
          const sku = sheet.getCell(rowIdx, 0).value;
          const title = sheet.getCell(rowIdx, 1).value;
          const costKRW = sheet.getCell(rowIdx, 4).value || 0;
          const ebayPrice = sheet.getCell(rowIdx, 5).value || 0;
          const ebayShipping = sheet.getCell(rowIdx, 6).value || 0;
          const ebayFee = sheet.getCell(rowIdx, 7).value;
          const usTax = sheet.getCell(rowIdx, 8).value;
          const settlement = sheet.getCell(rowIdx, 9).value;
          const shipping = sheet.getCell(rowIdx, 10).value;
          const profit = sheet.getCell(rowIdx, 11).value;
          const margin = sheet.getCell(rowIdx, 12).value;

          foundCount++;
          console.log(`${foundCount}. SKU: ${sku}`);
          console.log(`   Title: ${title}`);
          console.log(`   입력값:`);
          console.log(`     - 매입가(KRW): ${costKRW}`);
          console.log(`     - eBay가격(USD): ${ebayPrice}`);
          console.log(`     - eBay배송비(USD): ${ebayShipping}`);
          console.log(`   계산값:`);
          console.log(`     - eBay수수료(USD): ${ebayFee}`);
          console.log(`     - 미국세금(KRW): ${usTax}`);
          console.log(`     - 정산액(KRW): ${settlement}`);
          console.log(`     - 배송비(KRW): ${shipping}`);
          console.log(`     - 최종순이익(KRW): ${profit}`);
          console.log(`     - 마진율(%): ${margin}`);

          // 수동 계산 검증
          if (ebayPrice > 0) {
            const expectedFee = (ebayPrice + ebayShipping) * 0.18;
            const expectedTax = costKRW * 0.15;
            const expectedSettlement = (ebayPrice + ebayShipping) * 0.82 * 1400;
            const expectedProfit = expectedSettlement - costKRW - expectedTax - 15000;
            const expectedMargin = expectedSettlement > 0 ? (expectedProfit / expectedSettlement * 100) : 0;

            console.log(`   검증 (수동 계산):`);
            console.log(`     - 예상 수수료: ${expectedFee.toFixed(2)}`);
            console.log(`     - 예상 미국세금: ${expectedTax.toFixed(0)}`);
            console.log(`     - 예상 정산액: ${expectedSettlement.toFixed(0)}`);
            console.log(`     - 예상 순이익: ${expectedProfit.toFixed(0)}`);
            console.log(`     - 예상 마진율: ${expectedMargin.toFixed(2)}%`);
          }
          console.log('');
        }
      }
    }

    if (foundCount === 0) {
      console.log('⚠️  "양쪽" 플랫폼 데이터를 찾을 수 없습니다.');
    } else {
      console.log(`\n✅ 총 ${foundCount}개 "양쪽" 플랫폼 데이터 확인 완료!`);
    }

    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);

  } catch (error) {
    console.error('\n❌ 오류:', error.message);
    console.error(error.stack);
  }
}

checkBothPlatforms();
