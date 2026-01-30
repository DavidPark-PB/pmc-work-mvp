require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkEbayImages() {
  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['eBay Products'];
  const rows = await sheet.getRows({ limit: 10 });

  console.log('eBay Products 첫 10개 행의 Image URL:\n');

  rows.forEach((row, i) => {
    const url = row.get('Image URL');
    console.log(`${i+1}. ${url ? url.substring(0, 80) : '빈칸'}`);
  });
}

checkEbayImages();
