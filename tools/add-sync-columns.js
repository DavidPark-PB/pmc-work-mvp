require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 최종 Dashboard에 동기화 상태 열 추가
 */

async function addSyncColumns() {
  console.log('=== 동기화 상태 열 추가 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['최종 Dashboard'];
    if (!sheet) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log(`📊 시트: ${sheet.title}`);
    console.log(`   현재 열 수: ${sheet.columnCount}개\n`);

    // 헤더 행 로드
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;

    console.log('📋 현재 헤더:');
    console.log(`   ${headers.join(', ')}\n`);

    // Sync Status와 Last Updated 열이 없으면 추가
    const needsSyncStatus = !headers.includes('Sync Status');
    const needsLastUpdated = !headers.includes('Last Updated');

    if (!needsSyncStatus && !needsLastUpdated) {
      console.log('✅ 동기화 열이 이미 존재합니다!');
      return;
    }

    console.log('🔧 새로운 열 추가 중...\n');

    // 헤더 행 로드
    await sheet.loadCells(`A3:Z3`);

    let currentCol = headers.length;

    if (needsSyncStatus) {
      console.log(`   - Sync Status 열 추가 (${String.fromCharCode(65 + currentCol)}열)`);
      sheet.getCell(2, currentCol).value = 'Sync Status';
      currentCol++;
    }

    if (needsLastUpdated) {
      console.log(`   - Last Updated 열 추가 (${String.fromCharCode(65 + currentCol)}열)`);
      sheet.getCell(2, currentCol).value = 'Last Updated';
      currentCol++;
    }

    await sheet.saveUpdatedCells();

    // 헤더 리로드
    await sheet.loadHeaderRow();

    console.log('\n='.repeat(60));
    console.log('✅ 동기화 상태 열 추가 완료!');
    console.log('='.repeat(60));
    console.log(`\n📋 새로운 헤더 (총 ${sheet.headerValues.length}개):`);
    console.log(`   ...${sheet.headerValues.slice(-5).join(', ')}`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n💡 다음 단계:');
    console.log('   1. Google Apps Script 트리거 설정');
    console.log('   2. 역전송 스크립트 실행');
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

addSyncColumns();
