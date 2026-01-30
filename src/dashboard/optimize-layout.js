require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 시트 레이아웃 최적화
 * - 행 높이: 100px
 * - 열 너비: Image(120), Title(300), Profit(100)
 * - 수직 정렬: 가운데
 */

async function optimizeLayout() {
  console.log('=== 시트 레이아웃 최적화 시작 ===\n');

  try {
    // 1. Google Sheets 인증
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
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

    console.log(`📊 스프레드시트: ${doc.title}\n`);

    // 2. 데이터 마지막 행 찾기
    console.log('🔍 데이터 마지막 행 확인 중...');
    await sheet.loadCells('B1:B10000');

    let lastDataRow = 3;
    for (let row = 3; row < 10000; row++) {
      const cell = sheet.getCell(row, 1); // B열 (SKU)
      if (cell.value) {
        lastDataRow = row;
      }
    }

    const totalDataRows = lastDataRow - 2;
    console.log(`   ✅ 마지막 데이터 행: ${lastDataRow + 1}행`);
    console.log(`   ✅ 총 데이터 행 수: ${totalDataRows}개\n`);

    // 3. Google Sheets API 직접 호출 (행/열 크기 및 정렬)
    const { google } = require('googleapis');
    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });

    console.log('📐 행 높이 및 열 너비 조정 중...\n');

    // 행 높이 100px 설정 (4행부터 마지막 행까지)
    const rowRequests = [];
    for (let row = 3; row <= lastDataRow; row++) {
      rowRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId: sheet.sheetId,
            dimension: 'ROWS',
            startIndex: row,
            endIndex: row + 1
          },
          properties: {
            pixelSize: 100
          },
          fields: 'pixelSize'
        }
      });
    }

    // 배치로 행 높이 조정 (100개씩)
    console.log('   행 높이 100px 설정 중...');
    for (let i = 0; i < rowRequests.length; i += 100) {
      const batch = rowRequests.slice(i, i + 100);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
        requestBody: {
          requests: batch
        }
      });
      console.log(`      진행: ${Math.min(i + 100, rowRequests.length)} / ${rowRequests.length} 행`);
    }
    console.log('   ✅ 행 높이 설정 완료\n');

    // 열 너비 설정
    console.log('   열 너비 설정 중...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: {
        requests: [
          // A열 (Image) - 120px
          {
            updateDimensionProperties: {
              range: {
                sheetId: sheet.sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: 1
              },
              properties: {
                pixelSize: 120
              },
              fields: 'pixelSize'
            }
          },
          // C열 (Product Title) - 300px
          {
            updateDimensionProperties: {
              range: {
                sheetId: sheet.sheetId,
                dimension: 'COLUMNS',
                startIndex: 2,
                endIndex: 3
              },
              properties: {
                pixelSize: 300
              },
              fields: 'pixelSize'
            }
          },
          // M열 (최종순이익) - 120px
          {
            updateDimensionProperties: {
              range: {
                sheetId: sheet.sheetId,
                dimension: 'COLUMNS',
                startIndex: 12,
                endIndex: 13
              },
              properties: {
                pixelSize: 120
              },
              fields: 'pixelSize'
            }
          }
        ]
      }
    });
    console.log('   ✅ 열 너비 설정 완료\n');

    // 4. 수직 정렬 가운데 설정
    console.log('🎯 수직 정렬 가운데 설정 중...\n');

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: sheet.sheetId,
                startRowIndex: 3,
                endRowIndex: lastDataRow + 1,
                startColumnIndex: 0,
                endColumnIndex: 30
              },
              cell: {
                userEnteredFormat: {
                  verticalAlignment: 'MIDDLE'
                }
              },
              fields: 'userEnteredFormat.verticalAlignment'
            }
          }
        ]
      }
    });
    console.log('   ✅ 수직 정렬 설정 완료\n');

    // 5. 최종 보고
    console.log('='.repeat(60));
    console.log('📋 레이아웃 최적화 완료');
    console.log('='.repeat(60));
    console.log(`✅ 행 높이: 100px (${totalDataRows}개 행)`);
    console.log(`✅ 열 너비:`);
    console.log(`   - A열 (Image): 120px`);
    console.log(`   - C열 (Product Title): 300px`);
    console.log(`   - M열 (최종순이익): 120px`);
    console.log(`✅ 수직 정렬: 가운데`);
    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

optimizeLayout();
