require('dotenv').config({ path: '../../config/.env' });
const { google } = require('googleapis');
const fs = require('fs');

/**
 * Google Sheets 백업 (복사본 생성)
 */

async function backupSpreadsheet() {
  console.log('=== Google Sheets 백업 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));

    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
    );

    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    console.log('📊 원본 스프레드시트 정보 가져오는 중...');

    // 원본 스프레드시트 정보 가져오기
    const originalSheet = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId
    });

    const originalTitle = originalSheet.data.properties.title;
    console.log(`   원본: ${originalTitle}\n`);

    // 백업 이름 생성 (날짜 + 시간)
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupTitle = `${originalTitle} [백업 ${timestamp}]`;

    console.log(`📋 복사본 생성 중: ${backupTitle}\n`);

    // 스프레드시트 복사
    const copyResponse = await drive.files.copy({
      fileId: spreadsheetId,
      requestBody: {
        name: backupTitle
      }
    });

    const backupId = copyResponse.data.id;

    console.log('='.repeat(70));
    console.log('✅ 백업 완료!');
    console.log('='.repeat(70));
    console.log(`\n📊 원본 스프레드시트:`);
    console.log(`   제목: ${originalTitle}`);
    console.log(`   ID: ${spreadsheetId}`);
    console.log(`   URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

    console.log(`\n💾 백업 스프레드시트:`);
    console.log(`   제목: ${backupTitle}`);
    console.log(`   ID: ${backupId}`);
    console.log(`   URL: https://docs.google.com/spreadsheets/d/${backupId}`);

    console.log(`\n📅 백업 일시: ${now.toLocaleString('ko-KR')}`);
    console.log('\n🎉 백업이 Google Drive에 저장되었습니다!\n');

    // 백업 정보를 파일로도 저장
    const backupInfo = {
      timestamp: now.toISOString(),
      original: {
        title: originalTitle,
        id: spreadsheetId,
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
      },
      backup: {
        title: backupTitle,
        id: backupId,
        url: `https://docs.google.com/spreadsheets/d/${backupId}`
      }
    };

    fs.writeFileSync(
      `./backup-info-${timestamp}.json`,
      JSON.stringify(backupInfo, null, 2)
    );

    console.log(`💾 백업 정보 저장: backup-info-${timestamp}.json\n`);

  } catch (error) {
    console.error('\n❌ 백업 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

backupSpreadsheet();
