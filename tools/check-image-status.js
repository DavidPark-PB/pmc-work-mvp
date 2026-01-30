require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

async function checkImageStatus() {
  console.log('=== 이미지 상태 확인 ===\n');

  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['최종 Dashboard'];

  console.log('📋 A열 상태 확인 (4행~13행):\n');

  await sheet.loadCells('A4:A13');

  for (let i = 3; i < 13; i++) {
    const cell = sheet.getCell(i, 0);
    const rowNum = i + 1;

    console.log(`${rowNum}행:`);

    if (cell.formula) {
      console.log(`  수식: ${cell.formula.substring(0, 100)}`);
      // 수식에서 URL 추출
      const urlMatch = cell.formula.match(/IMAGE\("([^"]+)"/);
      if (urlMatch) {
        console.log(`  URL: ${urlMatch[1]}`);
      }
    } else if (cell.value) {
      console.log(`  값(텍스트): ${String(cell.value).substring(0, 100)}`);
    } else {
      console.log(`  ⚠️  빈칸`);
    }
    console.log('');
  }

  // 4행의 전체 URL을 별도로 출력
  console.log('='.repeat(80));
  console.log('📸 4행 이미지 URL (전체):');
  console.log('='.repeat(80));

  const row4Cell = sheet.getCell(3, 0);
  if (row4Cell.formula) {
    const urlMatch = row4Cell.formula.match(/IMAGE\("([^"]+)"/);
    if (urlMatch) {
      console.log(urlMatch[1]);
      console.log('\n💡 위 URL을 브라우저에 복사해서 열어보세요!\n');
    }
  } else if (row4Cell.value) {
    console.log(row4Cell.value);
    console.log('\n⚠️  수식이 아닌 텍스트로 저장되어 있습니다!\n');
  } else {
    console.log('빈칸입니다!\n');
  }
}

checkImageStatus();
