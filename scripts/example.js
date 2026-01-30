const GoogleSheetsAPI = require('./googleSheetsAPI');

// 스프레드시트 ID - 구글 시트 URL에서 확인 가능
// https://docs.google.com/spreadsheets/d/[여기가_스프레드시트_ID]/edit
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

async function main() {
  // Google Sheets API 인스턴스 생성
  const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

  try {
    // 1. 인증
    console.log('\n=== 1. Google Sheets API 인증 ===');
    await sheetsAPI.authenticate();

    // 2. 스프레드시트 정보 가져오기
    console.log('\n=== 2. 스프레드시트 정보 조회 ===');
    await sheetsAPI.getSpreadsheetInfo(SPREADSHEET_ID);

    // 3. 데이터 읽기
    console.log('\n=== 3. 데이터 읽기 ===');
    const data = await sheetsAPI.readData(SPREADSHEET_ID, 'Sheet1!A1:D10');
    console.log('읽은 데이터:', data);

    // 4. 데이터 쓰기 (덮어쓰기)
    console.log('\n=== 4. 데이터 쓰기 ===');
    const writeData = [
      ['이름', '나이', '직책', '부서'],
      ['홍길동', 30, '개발자', 'IT'],
      ['김철수', 25, '디자이너', 'Design'],
    ];
    await sheetsAPI.writeData(SPREADSHEET_ID, 'Sheet1!A1', writeData);

    // 5. 데이터 추가 (기존 데이터 뒤에 추가)
    console.log('\n=== 5. 데이터 추가 ===');
    const appendData = [
      ['이영희', 28, '마케터', 'Marketing'],
      ['박민수', 32, '매니저', 'Sales'],
    ];
    await sheetsAPI.appendData(SPREADSHEET_ID, 'Sheet1!A:D', appendData);

    // 6. 새 시트 생성
    console.log('\n=== 6. 새 시트 생성 ===');
    const newSheetId = await sheetsAPI.createSheet(SPREADSHEET_ID, '데이터_백업');

    // 7. 특정 범위 데이터 삭제
    console.log('\n=== 7. 데이터 삭제 ===');
    // await sheetsAPI.clearData(SPREADSHEET_ID, 'Sheet1!A1:D10');

    // 8. 시트 삭제 (주의: 되돌릴 수 없음!)
    console.log('\n=== 8. 시트 삭제 ===');
    // await sheetsAPI.deleteSheet(SPREADSHEET_ID, newSheetId);

    console.log('\n✅ 모든 작업 완료!');
  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

// 스크립트 실행
main();
