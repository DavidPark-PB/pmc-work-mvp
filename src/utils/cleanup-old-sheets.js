const { CREDENTIALS_PATH } = require('../config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 개발 중 생성된 불필요한 시트들 삭제
 * 유지할 시트: eBay Products, 시트1 (Shopify), 최종 Dashboard
 */

async function cleanupOldSheets() {
  console.log('=== 불필요한 시트 정리 시작 ===\n');

  try {
    // Google Sheets 인증
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`📊 스프레드시트: ${doc.title}\n`);

    // 유지할 시트 목록
    const keepSheets = [
      'eBay Products',
      '시트1',
      '최종 Dashboard'
    ];

    console.log('✅ 유지할 시트:');
    keepSheets.forEach(name => console.log(`   - ${name}`));

    // 삭제할 시트 찾기
    const sheetsToDelete = [];

    for (const sheet of Object.values(doc._rawSheets)) {
      const title = sheet.title;

      if (!keepSheets.includes(title)) {
        sheetsToDelete.push({ title, id: sheet.sheetId });
      }
    }

    if (sheetsToDelete.length === 0) {
      console.log('\n✅ 삭제할 시트가 없습니다. 모두 정리되어 있습니다!');
      return;
    }

    console.log('\n🗑️  삭제할 시트:');
    sheetsToDelete.forEach(s => console.log(`   - ${s.title}`));

    // 시트 삭제
    console.log('\n🔄 삭제 중...');
    for (const sheetInfo of sheetsToDelete) {
      const sheet = doc.sheetsById[sheetInfo.id];
      if (sheet) {
        await sheet.delete();
        console.log(`   ✅ 삭제됨: ${sheetInfo.title}`);
      }
    }

    console.log('\n🎉 정리 완료!\n');
    console.log('📋 남은 시트:');
    keepSheets.forEach(name => console.log(`   - ${name}`));

    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

cleanupOldSheets();
