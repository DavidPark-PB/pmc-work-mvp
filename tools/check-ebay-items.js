require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * eBay 등록 상품 확인 및 품절 상품 찾기
 */

async function checkEbayItems() {
  console.log('=== eBay 등록 상품 및 품절 확인 ===\n');

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

    // 헤더 확인
    await dashboard.loadCells('A1:Z1');

    const headers = {};
    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    console.log('헤더:', Object.keys(headers).join(', '));
    console.log();

    // 샘플 데이터 확인 - 품절인 행
    console.log('📋 품절 상품 샘플 (처음 10개):\n');

    await dashboard.loadCells('A2:Z100');

    const purchasePriceCol = headers['🔒 매입가'];  // F열
    const ebayRegCol = headers['eBay 등록'];  // W열
    const shopifyRegCol = headers['Shopify 등록'];  // X열

    let found = 0;
    for (let row = 1; row < 100 && found < 10; row++) {
      const skuCell = dashboard.getCell(row, 1);  // B열
      const purchaseCell = dashboard.getCell(row, purchasePriceCol);
      const ebayRegCell = ebayRegCol !== undefined ? dashboard.getCell(row, ebayRegCol) : null;
      const shopifyRegCell = shopifyRegCol !== undefined ? dashboard.getCell(row, shopifyRegCol) : null;

      const sku = skuCell.value;
      const purchase = purchaseCell.value;
      const ebayReg = ebayRegCell?.value;
      const shopifyReg = shopifyRegCell?.value;

      if (String(purchase).toLowerCase() === '품절') {
        found++;
        console.log(`Row ${row + 1}:`);
        console.log(`   SKU: ${sku}`);
        console.log(`   매입가: ${purchase}`);
        console.log(`   eBay 등록: ${ebayReg}`);
        console.log(`   Shopify 등록: ${shopifyReg}`);
        console.log();
      }
    }

    // eBay Products 시트에서 Item ID 확인
    console.log('\n📦 eBay Products 시트 확인...\n');

    const ebaySheet = doc.sheetsByTitle['eBay Products'];
    if (ebaySheet) {
      await ebaySheet.loadCells('A1:E5');

      console.log('eBay Products 시트 헤더:');
      for (let col = 0; col < 5; col++) {
        const cell = ebaySheet.getCell(0, col);
        if (cell.value) {
          console.log(`   ${String.fromCharCode(65 + col)}: ${cell.value}`);
        }
      }

      console.log('\n첫 3개 상품:');
      for (let row = 1; row < 4; row++) {
        console.log(`   Row ${row + 1}:`);
        for (let col = 0; col < 5; col++) {
          const cell = ebaySheet.getCell(row, col);
          if (cell.value) {
            console.log(`      ${String.fromCharCode(65 + col)}: ${cell.value}`);
          }
        }
      }
    } else {
      console.log('   eBay Products 시트를 찾을 수 없습니다.');
    }

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
  }
}

checkEbayItems();
