require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * Google Sheets 백업 (새 스프레드시트 생성 + 데이터 복사)
 */

async function backupSpreadsheet() {
  console.log('=== Google Sheets 백업 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    // 1. 원본 스프레드시트 열기
    const originalDoc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await originalDoc.loadInfo();

    console.log(`📊 원본 스프레드시트: ${originalDoc.title}`);
    console.log(`   시트 수: ${originalDoc.sheetCount}개\n`);

    // 2. 백업 이름 생성
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupTitle = `${originalDoc.title} [백업 ${timestamp}]`;

    // 3. 새 백업 스프레드시트 생성
    console.log(`📋 새 백업 스프레드시트 생성 중: ${backupTitle}\n`);

    const backupDoc = await GoogleSpreadsheet.createNewSpreadsheetDocument(serviceAccountAuth, {
      title: backupTitle
    });

    console.log(`✅ 백업 스프레드시트 생성 완료: ${backupDoc.spreadsheetId}\n`);

    // 4. 기본 시트 삭제
    await backupDoc.loadInfo();
    const defaultSheet = backupDoc.sheetsByIndex[0];
    await defaultSheet.delete();

    // 5. 모든 시트 복사
    console.log('📄 시트 복사 중...\n');

    for (let i = 0; i < originalDoc.sheetCount; i++) {
      const originalSheet = originalDoc.sheetsByIndex[i];
      console.log(`   ${i + 1}/${originalDoc.sheetCount} 복사 중: ${originalSheet.title}`);

      // 시트 생성
      const newSheet = await backupDoc.addSheet({
        title: originalSheet.title,
        headerValues: [],
        gridProperties: {
          rowCount: originalSheet.rowCount,
          columnCount: originalSheet.columnCount
        }
      });

      // 데이터 복사 (모든 행 가져오기)
      const rows = await originalSheet.getRows();

      if (rows.length > 0) {
        // 헤더 설정
        await newSheet.setHeaderRow(originalSheet.headerValues);

        // 행 데이터 복사
        const rowsData = rows.map(row => {
          const rowData = {};
          originalSheet.headerValues.forEach(header => {
            rowData[header] = row.get(header);
          });
          return rowData;
        });

        await newSheet.addRows(rowsData);
        console.log(`      ✅ ${rows.length}개 행 복사 완료`);
      } else {
        console.log(`      ⚠️  빈 시트 (데이터 없음)`);
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ 백업 완료!');
    console.log('='.repeat(70));
    console.log(`\n📊 원본 스프레드시트:`);
    console.log(`   제목: ${originalDoc.title}`);
    console.log(`   시트 수: ${originalDoc.sheetCount}개`);
    console.log(`   URL: https://docs.google.com/spreadsheets/d/${originalDoc.spreadsheetId}`);

    console.log(`\n💾 백업 스프레드시트:`);
    console.log(`   제목: ${backupTitle}`);
    console.log(`   시트 수: ${backupDoc.sheetCount - 1}개`);
    console.log(`   URL: https://docs.google.com/spreadsheets/d/${backupDoc.spreadsheetId}`);

    console.log(`\n📅 백업 일시: ${now.toLocaleString('ko-KR')}`);

    // 백업 정보를 파일로도 저장
    const backupInfo = {
      timestamp: now.toISOString(),
      original: {
        title: originalDoc.title,
        id: originalDoc.spreadsheetId,
        sheetCount: originalDoc.sheetCount,
        url: `https://docs.google.com/spreadsheets/d/${originalDoc.spreadsheetId}`
      },
      backup: {
        title: backupTitle,
        id: backupDoc.spreadsheetId,
        sheetCount: backupDoc.sheetCount - 1,
        url: `https://docs.google.com/spreadsheets/d/${backupDoc.spreadsheetId}`
      }
    };

    const backupInfoFile = `backup-info-${timestamp}.json`;
    fs.writeFileSync(backupInfoFile, JSON.stringify(backupInfo, null, 2));

    console.log(`\n💾 백업 정보 저장: ${backupInfoFile}`);
    console.log('\n🎉 백업이 완료되었습니다!\n');

  } catch (error) {
    console.error('\n❌ 백업 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

backupSpreadsheet();
