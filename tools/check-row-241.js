require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkRow241() {
  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['최종 Dashboard'];

  console.log('241행 (PMC-001) 상세 확인:\n');

  await sheet.loadCells('A241:M241');

  const rowIdx = 240;
  const sku = sheet.getCell(rowIdx, 0).value;
  const title = sheet.getCell(rowIdx, 1).value;
  const costKRW = sheet.getCell(rowIdx, 4).value;
  const ebayPrice = sheet.getCell(rowIdx, 5).value;
  const ebayShipping = sheet.getCell(rowIdx, 6).value;

  const feeFormula = sheet.getCell(rowIdx, 7).formula;
  const feeValue = sheet.getCell(rowIdx, 7).value;

  const taxFormula = sheet.getCell(rowIdx, 8).formula;
  const taxValue = sheet.getCell(rowIdx, 8).value;

  const settlementFormula = sheet.getCell(rowIdx, 9).formula;
  const settlementValue = sheet.getCell(rowIdx, 9).value;

  const profitFormula = sheet.getCell(rowIdx, 11).formula;
  const profitValue = sheet.getCell(rowIdx, 11).value;

  console.log(`SKU: ${sku}`);
  console.log(`Title: ${title}`);
  console.log(`매입가(KRW): ${costKRW}`);
  console.log(`eBay가격(USD): ${ebayPrice}`);
  console.log(`eBay배송비(USD): ${ebayShipping}`);
  console.log(`\nH열 (수수료):`);
  console.log(`  수식: ${feeFormula ? 'O' : 'X'}`);
  console.log(`  값: ${feeValue}`);
  console.log(`\nI열 (미국세금):`);
  console.log(`  수식: ${taxFormula ? 'O' : 'X'}`);
  console.log(`  값: ${taxValue}`);
  console.log(`\nJ열 (정산액):`);
  console.log(`  수식: ${settlementFormula ? 'O' : 'X'}`);
  console.log(`  값: ${settlementValue}`);
  console.log(`\nL열 (순이익):`);
  console.log(`  수식: ${profitFormula ? 'O' : 'X'}`);
  console.log(`  값: ${profitValue}`);
}

checkRow241();
