const GoogleSheetsAPI = require('./googleSheetsAPI');

const SPREADSHEET_ID = '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

async function demo() {
  const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

  try {
    // 인증
    await sheetsAPI.authenticate();

    console.log('\n=== 1. 스프레드시트 정보 확인 ===');
    await sheetsAPI.getSpreadsheetInfo(SPREADSHEET_ID);

    console.log('\n=== 2. 샘플 데이터 작성 ===');
    const sampleData = [
      ['이름', '부서', '직급', '입사일', '급여'],
      ['홍길동', 'IT', '과장', '2020-01-15', '5000000'],
      ['김철수', 'Marketing', '대리', '2021-03-20', '4000000'],
      ['이영희', 'Sales', '부장', '2019-05-10', '6000000'],
      ['박민수', 'IT', '사원', '2023-07-01', '3500000'],
    ];

    await sheetsAPI.writeData(SPREADSHEET_ID, '시트1!A1', sampleData);

    console.log('\n=== 3. 데이터 읽기 확인 ===');
    const data = await sheetsAPI.readData(SPREADSHEET_ID, '시트1!A1:E5');
    console.log('읽은 데이터:');
    data.forEach((row, index) => {
      console.log(`  ${index + 1}: ${row.join(' | ')}`);
    });

    console.log('\n=== 4. 새 직원 추가 (데이터 추가) ===');
    const newEmployee = [
      ['최지영', 'HR', '대리', '2024-01-10', '4200000']
    ];
    await sheetsAPI.appendData(SPREADSHEET_ID, '시트1!A:E', newEmployee);

    console.log('\n=== 5. 최종 데이터 확인 ===');
    const finalData = await sheetsAPI.readData(SPREADSHEET_ID, '시트1!A1:E10');
    console.log('최종 데이터:');
    finalData.forEach((row, index) => {
      console.log(`  ${index + 1}: ${row.join(' | ')}`);
    });

    console.log('\n✅ 모든 데모 완료! 스프레드시트를 확인해보세요.');
    console.log(`🔗 https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

demo();
