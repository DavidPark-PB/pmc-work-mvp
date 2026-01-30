const GoogleSheetsAPI = require('./googleSheetsAPI');

/**
 * 빠른 시작 가이드
 * 이 파일을 수정하여 바로 사용할 수 있습니다.
 */

// 여기에 스프레드시트 ID를 입력하세요
const SPREADSHEET_ID = '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

async function quickStart() {
  const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

  try {
    // 인증
    await sheetsAPI.authenticate();

    // ===== 여기서부터 원하는 작업을 수행하세요 =====

    // 예제 1: 스프레드시트 정보 확인
    await sheetsAPI.getSpreadsheetInfo(SPREADSHEET_ID);

    // 예제 2: 데이터 읽기
    const data = await sheetsAPI.readData(SPREADSHEET_ID, '시트1!A1:E10');
    console.log('\n읽은 데이터:', data);

    // 예제 3: 데이터 쓰기
    // const newData = [
    //   ['항목1', '항목2', '항목3'],
    //   ['값1', '값2', '값3'],
    // ];
    // await sheetsAPI.writeData(SPREADSHEET_ID, '시트1!A1', newData);

    // 예제 4: 데이터 추가
    // const appendData = [
    //   ['새로운', '데이터', '추가'],
    // ];
    // await sheetsAPI.appendData(SPREADSHEET_ID, '시트1!A:C', appendData);

  } catch (error) {
    console.error('에러:', error.message);
  }
}

quickStart();
