require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkAllHeaders() {
  const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
  const serviceAccountAuth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
  await doc.loadInfo();

  const dashboard = doc.sheetsByTitle['최종 Dashboard'];
  await dashboard.loadCells('A1:Z1');

  console.log('=== 전체 헤더 (Row 1) ===\n');
  for (let col = 0; col < 26; col++) {
    const cell = dashboard.getCell(0, col);
    if (cell.value) {
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }
  }
}

checkAllHeaders();
