require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkImageColumn() {
  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['최종 Dashboard'];

  console.log('A열 샘플 확인 (처음 20개 행):\n');

  await sheet.loadCells('A4:A23');

  let hasUrl = 0;
  let hasFormula = 0;
  let isEmpty = 0;

  for (let i = 3; i < 23; i++) {
    const cell = sheet.getCell(i, 0);
    const rowNum = i + 1;

    if (cell.formula) {
      hasFormula++;
      console.log(`${rowNum}행: 수식 = ${cell.formula.substring(0, 80)}`);
    } else if (cell.value) {
      hasUrl++;
      console.log(`${rowNum}행: URL = ${String(cell.value).substring(0, 80)}`);
    } else {
      isEmpty++;
      console.log(`${rowNum}행: 빈칸`);
    }
  }

  console.log(`\n통계:`);
  console.log(`  수식 있음: ${hasFormula}개`);
  console.log(`  URL 텍스트: ${hasUrl}개`);
  console.log(`  빈칸: ${isEmpty}개`);
}

checkImageColumn();
