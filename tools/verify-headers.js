require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 헤더 검증 스크립트
 */

async function verifyHeaders() {
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

    // Load cells to check header row
    await dashboard.loadCells('A1:Y3');

    console.log('=== Row 1 ===');
    for (let col = 0; col < 10; col++) {
      const cell = dashboard.getCell(0, col);
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }

    console.log('\n=== Row 2 ===');
    for (let col = 0; col < 10; col++) {
      const cell = dashboard.getCell(1, col);
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }

    console.log('\n=== Row 3 (Expected Header Row) ===');
    for (let col = 0; col < 25; col++) {
      const cell = dashboard.getCell(2, col);
      if (cell.value) {
        console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
      }
    }

    console.log('\n=== Testing getRows with headerRowIndex ===');
    dashboard.headerRowIndex = 2;
    await dashboard.loadHeaderRow();
    console.log('HeaderValues:', dashboard.headerValues);

    const rows = await dashboard.getRows({ limit: 2 });
    console.log('\n첫 번째 데이터 행:');
    console.log('SKU:', rows[0].get('SKU'));
    console.log('판매가(USD):', rows[0].get('판매가(USD)'));
    console.log('국제 배송비(USD):', rows[0].get('국제 배송비(USD)'));
    console.log('플랫폼:', rows[0].get('플랫폼'));

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

verifyHeaders();
