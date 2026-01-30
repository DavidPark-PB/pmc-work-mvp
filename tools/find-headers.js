require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function findHeaders() {
  const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
  const serviceAccountAuth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
  await doc.loadInfo();

  const dashboard = doc.sheetsByTitle['최종 Dashboard'];
  await dashboard.loadCells('A1:Y5');

  console.log('=== Row 1 ===');
  for (let col = 0; col < 25; col++) {
    const cell = dashboard.getCell(0, col);
    if (cell.value) {
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }
  }

  console.log('\n=== Row 2 ===');
  for (let col = 0; col < 25; col++) {
    const cell = dashboard.getCell(1, col);
    if (cell.value) {
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }
  }

  console.log('\n=== Row 3 ===');
  for (let col = 0; col < 25; col++) {
    const cell = dashboard.getCell(2, col);
    if (cell.value) {
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }
  }

  console.log('\n=== Row 4 ===');
  for (let col = 0; col < 25; col++) {
    const cell = dashboard.getCell(3, col);
    if (cell.value) {
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }
  }

  console.log('\n=== Row 5 ===');
  for (let col = 0; col < 25; col++) {
    const cell = dashboard.getCell(4, col);
    if (cell.value) {
      console.log(`${String.fromCharCode(65 + col)}: ${cell.value}`);
    }
  }
}

findHeaders();
