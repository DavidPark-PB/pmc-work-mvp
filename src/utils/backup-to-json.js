require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

/**
 * Google Sheets 데이터를 JSON 파일로 백업
 */

async function backupToJson() {
  console.log('=== Google Sheets JSON 백업 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    // 원본 스프레드시트 열기
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`📊 스프레드시트: ${doc.title}`);
    console.log(`   시트 수: ${doc.sheetCount}개\n`);

    // 백업 폴더 생성
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupDir = path.join(__dirname, 'backups', `backup-${timestamp}`);

    if (!fs.existsSync(path.join(__dirname, 'backups'))) {
      fs.mkdirSync(path.join(__dirname, 'backups'));
    }
    fs.mkdirSync(backupDir);

    console.log(`📁 백업 폴더: ${backupDir}\n`);

    const backupData = {
      timestamp: now.toISOString(),
      spreadsheetId: doc.spreadsheetId,
      title: doc.title,
      sheetCount: doc.sheetCount,
      sheets: []
    };

    // 각 시트 백업
    console.log('📄 시트 백업 중...\n');

    for (let i = 0; i < doc.sheetCount; i++) {
      const sheet = doc.sheetsByIndex[i];
      console.log(`   ${i + 1}/${doc.sheetCount} 백업 중: ${sheet.title}`);

      try {
        const rows = await sheet.getRows();

        const sheetData = {
          title: sheet.title,
          sheetId: sheet.sheetId,
          rowCount: sheet.rowCount,
          columnCount: sheet.columnCount,
          headerValues: sheet.headerValues,
          rows: rows.map(row => {
            const rowData = {};
            sheet.headerValues.forEach(header => {
              rowData[header] = row.get(header);
            });
            return rowData;
          })
        };

        backupData.sheets.push(sheetData);

        // 개별 시트 파일로도 저장
        const sheetFileName = `${sheet.title.replace(/[^\w\s가-힣]/g, '_')}.json`;
        fs.writeFileSync(
          path.join(backupDir, sheetFileName),
          JSON.stringify(sheetData, null, 2)
        );

        console.log(`      ✅ ${rows.length}개 행 백업 완료 → ${sheetFileName}`);
      } catch (error) {
        console.log(`      ⚠️  에러: ${error.message}`);
        backupData.sheets.push({
          title: sheet.title,
          sheetId: sheet.sheetId,
          error: error.message
        });
      }
    }

    // 전체 백업 파일 저장
    const fullBackupFile = path.join(backupDir, '_FULL_BACKUP.json');
    fs.writeFileSync(fullBackupFile, JSON.stringify(backupData, null, 2));

    // 백업 요약 정보
    const summaryFile = path.join(backupDir, '_BACKUP_INFO.txt');
    const summary = `
=== Google Sheets 백업 정보 ===

백업 일시: ${now.toLocaleString('ko-KR')}
타임스탬프: ${now.toISOString()}

원본 스프레드시트:
  - 제목: ${doc.title}
  - ID: ${doc.spreadsheetId}
  - URL: https://docs.google.com/spreadsheets/d/${doc.spreadsheetId}
  - 시트 수: ${doc.sheetCount}개

백업 파일:
${backupData.sheets.map((s, idx) => `  ${idx + 1}. ${s.title} (${s.rows ? s.rows.length : 0}개 행)`).join('\n')}

백업 폴더: ${backupDir}

복원 방법:
  1. _FULL_BACKUP.json 파일 확인
  2. 각 시트별 JSON 파일 확인
  3. 필요시 restore-from-json.js 스크립트로 복원

`;

    fs.writeFileSync(summaryFile, summary);

    console.log('\n' + '='.repeat(70));
    console.log('✅ 백업 완료!');
    console.log('='.repeat(70));
    console.log(`\n📁 백업 위치: ${backupDir}`);
    console.log(`\n📄 백업 파일:`);
    console.log(`   - _FULL_BACKUP.json (전체 백업)`);
    console.log(`   - _BACKUP_INFO.txt (백업 정보)`);
    backupData.sheets.forEach((s, idx) => {
      const fileName = `${s.title.replace(/[^\w\s가-힣]/g, '_')}.json`;
      console.log(`   - ${fileName} (${s.rows ? s.rows.length : 0}개 행)`);
    });

    console.log(`\n📅 백업 일시: ${now.toLocaleString('ko-KR')}`);
    console.log(`\n💾 총 ${backupData.sheets.length}개 시트 백업 완료`);
    console.log('\n🎉 백업이 완료되었습니다!\n');

  } catch (error) {
    console.error('\n❌ 백업 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

backupToJson();
