const GoogleSheetsAPI = require('./googleSheetsAPI');

const SPREADSHEET_ID = '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

async function setupDatabase() {
  const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

  try {
    await sheetsAPI.authenticate();

    console.log('\n=== PMC 시스템 데이터베이스 구축 시작 ===\n');

    // 1. 기존 데이터 삭제
    console.log('1. 기존 데이터 초기화 중...');
    await sheetsAPI.clearData(SPREADSHEET_ID, '시트1!A:Z');

    // 2. 헤더 작성 (컬럼명)
    console.log('2. 데이터베이스 구조 생성 중...');
    const headers = [
      [
        'SKU',
        '상품명',
        '매입가(KRW)',
        '쇼피파이 판매가($)',
        '환율',
        '수수료(%)',
        '배송비(KRW)',
        '순이익(KRW)',
        '마진율(%)'
      ]
    ];
    await sheetsAPI.writeData(SPREADSHEET_ID, '시트1!A1', headers);

    // 3. 샘플 데이터 추가
    console.log('3. 샘플 상품 데이터 추가 중...');

    // 데이터만 먼저 입력 (수식 제외)
    const sampleData = [
      [
        'PMC-001',           // A2: SKU
        '샘플상품',          // B2: 상품명
        '10000',             // C2: 매입가(KRW)
        '25.00',             // D2: 쇼피파이 판매가($)
        '1350',              // E2: 환율
        '10',                // F2: 수수료(%)
        '5000',              // G2: 배송비(KRW)
        '',                  // H2: 순이익 (수식으로 채움)
        ''                   // I2: 마진율 (수식으로 채움)
      ]
    ];

    await sheetsAPI.writeData(SPREADSHEET_ID, '시트1!A2', sampleData);

    // 4. 수식 추가
    console.log('4. 마진 계산 수식 추가 중...');
    const formulas = [
      [
        '=(D2*E2)*(1-(F2/100))-(C2+G2)',     // H2: 순이익(KRW) = [판매가×환율]×(1-수수료%) - (매입가+배송비)
        '=H2/(D2*E2)*100'                     // I2: 마진율(%) = 순이익 / 매출액 × 100
      ]
    ];

    await sheetsAPI.writeData(SPREADSHEET_ID, '시트1!H2', formulas);

    // 5. 결과 확인
    console.log('\n5. 결과 확인 중...\n');
    const result = await sheetsAPI.readData(SPREADSHEET_ID, '시트1!A1:I2');

    console.log('📊 생성된 데이터베이스 구조:');
    console.log('─'.repeat(120));
    result.forEach((row, index) => {
      if (index === 0) {
        console.log('헤더: ' + row.join(' | '));
        console.log('─'.repeat(120));
      } else {
        console.log('데이터: ' + row.join(' | '));
      }
    });
    console.log('─'.repeat(120));

    console.log('\n✅ PMC 데이터베이스 구조 생성 완료!');
    console.log('\n📌 계산 로직:');
    console.log('   - 순이익(KRW) = [판매가($) × 환율] × (1 - 수수료/100) - (매입가 + 배송비)');
    console.log('   - 마진율 = 순이익 / [판매가($) × 환율]');
    console.log('\n📝 수식:');
    console.log('   - H열 (순이익): =(D2*E2)*(1-(F2/100))-(C2+G2)');
    console.log('   - I열 (마진율): =H2/(D2*E2)*100');
    console.log('\n🔗 스프레드시트 확인:');
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

setupDatabase();
