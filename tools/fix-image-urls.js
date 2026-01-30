require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 이미지 URL에서 불필요한 파라미터 제거하고 깨끗한 URL로 재적용
 */

async function fixImageUrls() {
  console.log('=== 이미지 URL 수정 시작 ===\n');

  const creds = JSON.parse(fs.readFileSync('./credentials.json'));
  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['최종 Dashboard'];

  console.log('🔧 4행~13행 이미지 URL 파라미터 제거 중...\n');

  await sheet.loadCells('A4:A13');

  let fixed = 0;

  for (let i = 3; i < 13; i++) {
    const cell = sheet.getCell(i, 0);
    const rowNum = i + 1;

    if (cell.formula) {
      // 수식에서 URL 추출
      const urlMatch = cell.formula.match(/IMAGE\("([^"]+)"/);
      if (urlMatch) {
        let url = urlMatch[1];

        // ?set_id=... 파라미터 제거
        const cleanUrl = url.split('?')[0];

        // 수식 재적용
        cell.formula = `=IMAGE("${cleanUrl}", 1)`;
        console.log(`${rowNum}행: 파라미터 제거`);
        console.log(`  수정 전: ${url}`);
        console.log(`  수정 후: ${cleanUrl}`);
        console.log('');
        fixed++;
      }
    }
  }

  await sheet.saveUpdatedCells();
  console.log(`✅ ${fixed}개 행 URL 수정 완료!\n`);

  // 수정된 4행 URL 출력
  console.log('='.repeat(80));
  console.log('📸 수정된 4행 이미지 URL:');
  console.log('='.repeat(80));

  const row4Cell = sheet.getCell(3, 0);
  if (row4Cell.formula) {
    const urlMatch = row4Cell.formula.match(/IMAGE\("([^"]+)"/);
    if (urlMatch) {
      console.log(urlMatch[1]);
      console.log('\n💡 위 URL을 브라우저에 복사해서 다시 열어보세요!\n');
      console.log('🔗 시트 URL: https://docs.google.com/spreadsheets/d/' + process.env.GOOGLE_SPREADSHEET_ID);
      console.log('\n✨ 이제 이미지가 정상적으로 표시되어야 합니다!\n');
    }
  }
}

fixImageUrls();
