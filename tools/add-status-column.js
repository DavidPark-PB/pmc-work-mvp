require('dotenv').config();
const GoogleSheetsAPI = require('./googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * J열에 '검수 상태' 컬럼 추가 및 드롭다운 설정
 */
async function addStatusColumn() {
  console.log('\n=== 검수 상태 컬럼 추가 ===\n');

  try {
    const sheets = new GoogleSheetsAPI('./credentials.json');
    await sheets.authenticate();

    // 1. 헤더에 '검수 상태' 추가
    console.log('1. J열에 "검수 상태" 헤더 추가 중...');
    await sheets.writeData(SPREADSHEET_ID, '시트1!J1', [['검수 상태']]);

    // 2. 현재 데이터 행 수 확인
    console.log('\n2. 현재 데이터 행 수 확인 중...');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:A');
    const rowCount = data.length + 1; // 헤더 제외
    console.log(`   총 ${rowCount}개 행 발견`);

    // 3. 모든 행에 기본값 '검수대기' 설정
    console.log('\n3. 기본값 "검수대기" 설정 중...');
    const defaultValues = Array(rowCount).fill(['검수대기']);
    await sheets.writeData(SPREADSHEET_ID, '시트1!J2', defaultValues);

    // 4. 드롭다운 유효성 검사 규칙 추가
    console.log('\n4. 드롭다운 유효성 검사 설정 중...');

    // Google Sheets API의 batchUpdate를 사용하여 드롭다운 설정
    const request = {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: 0, // 첫 번째 시트 (시트1)
              startRowIndex: 1, // 2행부터 (0-based)
              endRowIndex: rowCount + 1, // 마지막 행까지
              startColumnIndex: 9, // J열 (0-based, A=0)
              endColumnIndex: 10
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: [
                  { userEnteredValue: '검수대기' },
                  { userEnteredValue: '검수완료' },
                  { userEnteredValue: '가격조정필요' },
                  { userEnteredValue: '삭제예정' }
                ]
              },
              showCustomUi: true,
              strict: true
            }
          }
        }
      ]
    };

    await sheets.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: request
    });

    console.log('\n✅ 검수 상태 컬럼 추가 완료!');
    console.log('\n📋 상태 옵션:');
    console.log('   - 검수대기 (기본값)');
    console.log('   - 검수완료');
    console.log('   - 가격조정필요');
    console.log('   - 삭제예정');
    console.log(`\n🔗 스프레드시트 확인:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
    console.error(error);
  }
}

addStatusColumn();
