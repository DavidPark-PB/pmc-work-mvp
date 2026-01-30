require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * Dashboard 헤더 확인
 */

async function checkHeaders() {
  console.log('=== Dashboard 헤더 확인 ===\n');

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

    console.log(`📊 시트: ${sheet.title}`);
    console.log(`   행 수: ${sheet.rowCount}`);
    console.log(`   열 수: ${sheet.columnCount}\n`);

    // 3행 (헤더 행) 로드
    await sheet.loadCells('A3:Z3');

    console.log('📋 헤더 (3행):');
    for (let col = 0; col < Math.min(sheet.columnCount, 26); col++) {
      const cell = sheet.getCell(2, col);
      const letter = String.fromCharCode(65 + col);
      console.log(`   ${letter}: ${cell.value || '(빈칸)'}`);
    }

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
  }
}

checkHeaders();
