require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function countPlatforms() {
  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['최종 Dashboard'];

  await sheet.loadCells('T4:T9000');

  let ebayOnly = 0;
  let shopifyOnly = 0;
  let both = 0;
  let empty = 0;

  for (let i = 3; i < 9000; i++) {
    const platform = sheet.getCell(i, 19).value;
    if (platform === 'eBay만') ebayOnly++;
    else if (platform === 'Shopify만') shopifyOnly++;
    else if (platform === '양쪽') both++;
    else if (!platform) empty++;
  }

  console.log('Dashboard 플랫폼 통계:');
  console.log(`  eBay만: ${ebayOnly}개`);
  console.log(`  Shopify만: ${shopifyOnly}개`);
  console.log(`  양쪽: ${both}개`);
  console.log(`  빈칸: ${empty}개`);
  console.log(`  총합: ${ebayOnly + shopifyOnly + both}개`);
}

countPlatforms();
