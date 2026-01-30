require('dotenv').config({ path: '../../config/.env' });
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * 모든 상품에 수식 일괄 적용
 * H열: 순이익, I열: 마진율
 */
async function applyFormulasToAll() {
  console.log('\n=== 모든 상품에 수식 일괄 적용 ===\n');

  try {
    const sheets = new GoogleSheetsAPI('../../config/credentials.json');
    await sheets.authenticate();

    // 1. 데이터 행 수 확인
    console.log('1. 데이터 행 수 확인 중...');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:A');
    const totalRows = data.length;
    console.log(`   총 ${totalRows}개 상품 발견\n`);

    // 2. 수식을 배열로 생성
    console.log('2. 수식 생성 중...');
    const formulas = [];

    for (let i = 2; i <= totalRows + 1; i++) {
      formulas.push([
        `=(D${i}*E${i})*(1-(F${i}/100))-(C${i}+G${i})`,  // H열: 순이익
        `=H${i}/(D${i}*E${i})*100`                        // I열: 마진율
      ]);
    }

    console.log(`   ${formulas.length}개 행에 대한 수식 생성 완료\n`);

    // 3. 일괄 적용 (batchUpdate 사용)
    console.log('3. 수식 일괄 적용 중...');
    console.log('   (Google Sheets API 할당량 고려하여 배치 처리)\n');

    // 범위를 지정하여 한 번에 업데이트
    const range = `시트1!H2:I${totalRows + 1}`;

    try {
      await sheets.writeData(SPREADSHEET_ID, range, formulas);

      console.log('\n✅ 수식 적용 완료!');
      console.log(`\n📊 적용 내역:`);
      console.log(`   - 대상: ${totalRows}개 상품`);
      console.log(`   - H열: 순이익 수식`);
      console.log(`   - I열: 마진율 수식`);
      console.log(`\n🔗 스프레드시트 확인:`);
      console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

    } catch (error) {
      if (error.message.includes('Quota exceeded')) {
        console.log('\n⚠️  API 할당량 초과 - 배치 처리로 전환합니다...\n');

        // 할당량 초과 시 작은 배치로 나눠서 처리
        const batchSize = 100;
        let processed = 0;

        for (let i = 0; i < formulas.length; i += batchSize) {
          const batch = formulas.slice(i, Math.min(i + batchSize, formulas.length));
          const startRow = i + 2;
          const endRow = startRow + batch.length - 1;
          const batchRange = `시트1!H${startRow}:I${endRow}`;

          await sheets.writeData(SPREADSHEET_ID, batchRange, batch);
          processed += batch.length;

          console.log(`   진행: ${processed} / ${formulas.length} (${((processed / formulas.length) * 100).toFixed(1)}%)`);

          // 할당량 방지를 위해 잠시 대기
          if (i + batchSize < formulas.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        console.log('\n✅ 배치 처리 완료!');
      } else {
        throw error;
      }
    }

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

applyFormulasToAll();
