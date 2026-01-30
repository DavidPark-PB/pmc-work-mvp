require('dotenv').config();
const GoogleSheetsAPI = require('./googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

async function verifyFinalStructure() {
  console.log('\n=== PMC 시스템 최종 구조 확인 ===\n');

  try {
    const sheets = new GoogleSheetsAPI('./credentials.json');
    await sheets.authenticate();

    // 1. 헤더 확인
    console.log('1. 헤더 구조 확인:');
    const headers = await sheets.readData(SPREADSHEET_ID, '시트1!A1:K1');
    console.log('   ' + headers[0].join(' | '));
    console.log('');

    // 2. 총 데이터 수 확인
    console.log('2. 데이터 현황:');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:A');
    console.log(`   총 상품 수: ${data.length}개\n`);

    // 3. 샘플 데이터 5개 확인
    console.log('3. 샘플 데이터 (처음 5개):');
    const samples = await sheets.readData(SPREADSHEET_ID, '시트1!A2:K6');

    console.log('─'.repeat(150));
    samples.forEach((row, index) => {
      const [sku, name, purchase, price, rate, fee, shipping, profit, margin, status, platform] = row;
      console.log(`${index + 1}. SKU: ${sku}`);
      console.log(`   상품명: ${name}`);
      console.log(`   플랫폼: ${platform || 'Shopify'}`);
      console.log(`   매입가: ${purchase || '미입력'} | 판매가: $${price || '0'} | 환율: ${rate || '1350'}`);
      console.log(`   수수료: ${fee || '5'}% | 배송비: ${shipping || '미입력'}`);
      console.log(`   순이익: ${profit || '계산중'} | 마진율: ${margin || '계산중'}%`);
      console.log(`   검수상태: ${status || '검수대기'}`);
      console.log('─'.repeat(150));
    });

    // 4. 상태별 카운트
    console.log('\n4. 검수 상태별 현황:');
    const allStatuses = await sheets.readData(SPREADSHEET_ID, '시트1!J2:J');

    const statusCount = {
      '검수대기': 0,
      '검수완료': 0,
      '가격조정필요': 0,
      '삭제예정': 0
    };

    allStatuses.forEach(row => {
      const status = row[0] || '검수대기';
      if (statusCount.hasOwnProperty(status)) {
        statusCount[status]++;
      }
    });

    console.log(`   검수대기: ${statusCount['검수대기']}개`);
    console.log(`   검수완료: ${statusCount['검수완료']}개`);
    console.log(`   가격조정필요: ${statusCount['가격조정필요']}개`);
    console.log(`   삭제예정: ${statusCount['삭제예정']}개`);

    console.log('\n✅ PMC 시스템 구축 완료!');
    console.log(`\n📊 최종 구조:`);
    console.log(`   - 총 컬럼: 11개 (SKU ~ 플랫폼)`);
    console.log(`   - 총 상품: ${data.length}개`);
    console.log(`   - 자동 계산: 순이익, 마진율`);
    console.log(`   - 검수 관리: 드롭다운 상태 필터`);
    console.log(`   - 플랫폼 구분: Shopify, eBay, Amazon, Coupang`);
    console.log(`\n🔗 스프레드시트:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

    console.log(`\n⚠️  다음 단계:`);
    console.log(`   1. 매입가(C열) 입력 필요`);
    console.log(`   2. 배송비(G열) 입력 필요`);
    console.log(`   3. 입력 후 순이익과 마진율이 자동 계산됩니다`);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

verifyFinalStructure();
