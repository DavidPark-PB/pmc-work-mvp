require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkShippingDB() {
  console.log('=== 배송요율_DB 및 Dashboard 구조 확인 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log('📊 전체 시트 목록:\n');
    for (let i = 0; i < doc.sheetCount; i++) {
      const sheet = doc.sheetsByIndex[i];
      console.log(`   ${i + 1}. ${sheet.title}`);
    }
    console.log();

    // 1. 배송요율_DB 또는 Shipping Rates 시트 확인
    const shippingSheet = doc.sheetsByTitle['배송요율_DB'] || doc.sheetsByTitle['Shipping Rates'];

    if (shippingSheet) {
      console.log(`📦 배송 요율 시트: ${shippingSheet.title}\n`);

      await shippingSheet.loadCells('A1:F10');

      console.log('   헤더:');
      for (let col = 0; col < 6; col++) {
        const cell = shippingSheet.getCell(0, col);
        if (cell.value) {
          console.log(`   ${String.fromCharCode(65 + col)}: ${cell.value}`);
        }
      }

      console.log('\n   샘플 데이터 (5행):');
      for (let row = 1; row <= 5; row++) {
        let rowData = [];
        for (let col = 0; col < 5; col++) {
          const cell = shippingSheet.getCell(row, col);
          if (cell.value !== null) {
            rowData.push(cell.value);
          }
        }
        if (rowData.length > 0) {
          console.log(`   Row ${row + 1}: ${rowData.join(' | ')}`);
        }
      }
    } else {
      console.log('❌ 배송요율_DB 또는 Shipping Rates 시트를 찾을 수 없습니다.');
    }

    // 2. Dashboard 헤더 확인
    console.log('\n\n📋 Dashboard 헤더 확인:\n');
    const dashboard = doc.sheetsByTitle['최종 Dashboard'];

    await dashboard.loadCells('A1:Z1');

    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        console.log(`   ${String.fromCharCode(65 + col)}: ${cell.value}`);
      }
    }

    // 3. 현재 배송비 값 확인
    console.log('\n\n📊 현재 배송비 값 샘플 (O열):\n');
    await dashboard.loadCells('O2:R10');

    for (let row = 1; row < 10; row++) {
      const shipping = dashboard.getCell(row, 14);  // O열 = index 14
      const weight = dashboard.getCell(row, 17);    // R열 = index 17
      console.log(`   Row ${row + 1}: 배송비=${shipping.value || '-'}, 무게=${weight.value || '-'}`);
    }

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
  }
}

checkShippingDB();
