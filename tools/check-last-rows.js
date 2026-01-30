require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkLastRows() {
  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['최종 Dashboard'];

  console.log('마지막 10개 행 확인:\n');

  await sheet.loadCells('A3987:M3996');

  for(let i = 3986; i < 3996; i++) {
    const rowNum = i + 1;
    const sku = sheet.getCell(i, 0).value || '';
    const ebayPrice = sheet.getCell(i, 5).value || '';
    const hasFormula = sheet.getCell(i, 7).formula ? 'O' : 'X';
    const feeValue = sheet.getCell(i, 7).value || '';

    console.log(`${rowNum}행: SKU=${String(sku).substring(0,20)}, eBay가격=${ebayPrice}, 수식=${hasFormula}, 수수료=${feeValue}`);
  }
}

checkLastRows();
