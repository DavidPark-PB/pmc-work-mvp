require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkDashboardRows() {
  console.log('=== Dashboard 행 수 확인 (직접 셀 읽기) ===\n');

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
    console.log(`📏 Grid 크기: ${sheet.rowCount} 행 x ${sheet.columnCount} 컬럼`);

    // 직접 셀에서 데이터 읽기
    console.log('\n📖 헤더 및 데이터 직접 읽기 중...\n');

    // 헤더 읽기 (3행)
    await sheet.loadCells('A3:U3');
    const headers = [];
    for (let col = 0; col < 21; col++) {
      headers.push(sheet.getCell(2, col).value);
    }
    console.log('📋 헤더:\n   ' + headers.join(' | '));

    // 처음 5개 데이터 행 읽기 (4-8행)
    console.log('\n📋 처음 5개 행 샘플:\n');
    await sheet.loadCells('A4:U8');
    for (let row = 0; row < 5; row++) {
      const sku = sheet.getCell(row + 3, 0).value;
      const title = sheet.getCell(row + 3, 1).value;
      const costKRW = sheet.getCell(row + 3, 4).value;
      const ebayPrice = sheet.getCell(row + 3, 5).value;
      const platform = sheet.getCell(row + 3, 19).value;

      console.log(`${row + 1}. SKU: ${sku}`);
      console.log(`   Title: ${title}`);
      console.log(`   매입가(KRW): ${costKRW}`);
      console.log(`   eBay가격(USD): ${ebayPrice}`);
      console.log(`   플랫폼: ${platform}\n`);
    }

    // 중간 5개 데이터 행 읽기 (2000행 근처)
    console.log('📋 중간 5개 행 샘플 (2000행 근처):\n');
    await sheet.loadCells('A2000:U2004');
    for (let row = 0; row < 5; row++) {
      const rowIdx = 1999 + row; // 0-based
      const sku = sheet.getCell(rowIdx, 0).value;
      const title = sheet.getCell(rowIdx, 1).value;
      const platform = sheet.getCell(rowIdx, 19).value;

      console.log(`${1997 + row}. SKU: ${sku}`);
      console.log(`   Title: ${title}`);
      console.log(`   플랫폼: ${platform}\n`);
    }

    // 마지막 5개 데이터 행 읽기
    console.log('📋 마지막 5개 행 샘플:\n');
    const lastRowStart = 3992; // 3989-3993번째 데이터 (엑셀 행 3992-3996)
    await sheet.loadCells(`A${lastRowStart}:U${lastRowStart + 4}`);
    for (let row = 0; row < 5; row++) {
      const rowIdx = lastRowStart - 1 + row; // 0-based
      const sku = sheet.getCell(rowIdx, 0).value;
      const title = sheet.getCell(rowIdx, 1).value;
      const platform = sheet.getCell(rowIdx, 19).value;

      console.log(`${3989 + row}. SKU: ${sku}`);
      console.log(`   Title: ${title}`);
      console.log(`   플랫폼: ${platform}\n`);
    }

    // 플랫폼별 통계 - 샘플링 (1000개 행)
    console.log('📊 플랫폼별 통계 (샘플링 1000행):');
    await sheet.loadCells('T4:T1003'); // 플랫폼 열 (T열 = col 19)

    const platforms = {
      'eBay만': 0,
      'Shopify만': 0,
      '양쪽': 0
    };

    for (let row = 0; row < 1000; row++) {
      const platform = sheet.getCell(row + 3, 19).value;
      if (platform && platforms.hasOwnProperty(platform)) {
        platforms[platform]++;
      }
    }

    console.log(`   eBay만: ${platforms['eBay만']}개`);
    console.log(`   Shopify만: ${platforms['Shopify만']}개`);
    console.log(`   양쪽: ${platforms['양쪽']}개`);
    console.log(`   총합: ${platforms['eBay만'] + platforms['Shopify만'] + platforms['양쪽']}개 (샘플 1000행 기준)`);

  } catch (error) {
    console.error('\n❌ 오류:', error.message);
    console.error(error.stack);
  }
}

checkDashboardRows();
