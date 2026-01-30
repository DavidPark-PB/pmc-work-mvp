require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function debugEbaySKUs() {
  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();

  const ebaySheet = doc.sheetsByTitle['eBay Products'];
  const ebayRows = await ebaySheet.getRows({ limit: 10000 });

  console.log(`총 ${ebayRows.length}개 eBay 행`);

  let validSKU = 0;
  let naSKU = 0;
  let emptySKU = 0;

  console.log('\n처음 10개 행 샘플:');
  for (let i = 0; i < Math.min(10, ebayRows.length); i++) {
    const sku = ebayRows[i].get('SKU');
    const title = ebayRows[i].get('Title');
    console.log(`  ${i + 1}. SKU="${sku}" Title="${String(title).substring(0, 40)}"`);
  }

  console.log('\n마지막 10개 행 샘플:');
  for (let i = Math.max(0, ebayRows.length - 10); i < ebayRows.length; i++) {
    const sku = ebayRows[i].get('SKU');
    const title = ebayRows[i].get('Title');
    console.log(`  ${i + 1}. SKU="${sku}" Title="${String(title).substring(0, 40)}"`);
  }

  for (const row of ebayRows) {
    const sku = row.get('SKU');
    if (sku && sku !== 'N/A') {
      validSKU++;
    } else if (sku === 'N/A') {
      naSKU++;
    } else {
      emptySKU++;
    }
  }

  console.log(`\nSKU 통계:`);
  console.log(`  유효 SKU: ${validSKU}개`);
  console.log(`  N/A SKU: ${naSKU}개`);
  console.log(`  빈 SKU: ${emptySKU}개`);
}

debugEbaySKUs();
