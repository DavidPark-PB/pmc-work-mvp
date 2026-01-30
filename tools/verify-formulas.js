require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function verifyFormulas() {
  console.log('=== 수식 동작 확인 ===\n');

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
    if (!sheet) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log('📐 첫 10개 행의 수식 결과 확인:\n');

    // A4:M13 (처음 10개 데이터 행) 로드
    await sheet.loadCells('A4:M13');

    for (let row = 0; row < 10; row++) {
      const rowNum = row + 4; // 실제 시트 행 번호
      const rowIdx = row + 3; // 0-based index

      const sku = sheet.getCell(rowIdx, 0).value;
      const costKRW = sheet.getCell(rowIdx, 4).value || 0; // E열: 매입가(KRW)
      const ebayPrice = sheet.getCell(rowIdx, 5).value || 0; // F열: eBay가격(USD)
      const ebayShipping = sheet.getCell(rowIdx, 6).value || 0; // G열: eBay배송비(USD)

      // 수식 결과들
      const ebayFee = sheet.getCell(rowIdx, 7).value; // H열: eBay수수료(USD)
      const usTax = sheet.getCell(rowIdx, 8).value; // I열: 미국세금(KRW)
      const settlement = sheet.getCell(rowIdx, 9).value; // J열: 정산액(KRW)
      const shipping = sheet.getCell(rowIdx, 10).value; // K열: 배송비(KRW)
      const profit = sheet.getCell(rowIdx, 11).value; // L열: 최종순이익(KRW)
      const margin = sheet.getCell(rowIdx, 12).value; // M열: 마진율(%)

      console.log(`${row + 1}. SKU: ${sku}`);
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
      console.log(`     - 마진율(%): ${margin}\n`);
    }

    console.log('\n✅ 수식 확인 완료!');
    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);

  } catch (error) {
    console.error('\n❌ 오류:', error.message);
    console.error(error.stack);
  }
}

verifyFormulas();
