require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 배송비 계산 테스트 - 샘플 무게 입력
 */

async function testShippingCalc() {
  console.log('=== 배송비 계산 테스트 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const calcSheet = doc.sheetsByTitle['Shipping Calculator'];
    if (!calcSheet) {
      console.error('❌ "Shipping Calculator" 시트를 찾을 수 없습니다!');
      return;
    }

    // 테스트 무게 입력: 500g
    console.log('📦 테스트 무게 입력: 500g\n');
    await calcSheet.loadCells('B4');
    calcSheet.getCell(3, 1).value = 500;
    await calcSheet.saveUpdatedCells();

    console.log('✅ 무게 입력 완료!');
    console.log('\n다음 명령 실행:');
    console.log('  node calculate-shipping.js\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testShippingCalc();
