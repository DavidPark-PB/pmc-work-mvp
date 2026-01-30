const GoogleSheetsAPI = require('./googleSheetsAPI');

const SPREADSHEET_ID = '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

async function test() {
  const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

  try {
    await sheetsAPI.authenticate();

    // 스프레드시트 정보 확인
    console.log('\n스프레드시트 정보 확인 중...\n');
    await sheetsAPI.getSpreadsheetInfo(SPREADSHEET_ID);

  } catch (error) {
    console.error('에러:', error.message);
  }
}

test();
