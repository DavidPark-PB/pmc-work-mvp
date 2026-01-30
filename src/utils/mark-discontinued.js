require('dotenv').config({ path: '../../config/.env' });
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * Discontinued 상품 찾아서 '삭제예정' 상태로 표시
 */
async function markDiscontinuedProducts() {
  console.log('\n=== Discontinued 상품 찾기 및 표시 ===\n');

  try {
    const sheets = new GoogleSheetsAPI('../../config/credentials.json');
    await sheets.authenticate();

    // 1. 모든 상품 데이터 읽기
    console.log('1. 모든 상품 데이터 읽기 중...');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:J');
    console.log(`   총 ${data.length}개 상품 로드됨\n`);

    // 2. Discontinued 상품 찾기
    console.log('2. Discontinued 상품 검색 중...');
    const discontinuedRows = [];

    data.forEach((row, index) => {
      const [sku, name] = row;
      const rowNum = index + 2; // A2부터 시작

      // 상품명에 'discontinued', 'discountinued', '단종', '품절' 등이 포함된 경우
      const discontinuedKeywords = [
        'discontinued',
        'discountinued', // 오타도 포함
        '단종',
        '품절',
        'out of stock',
        'unavailable'
      ];

      const nameToCheck = (name || '').toLowerCase();
      const isDiscontinued = discontinuedKeywords.some(keyword =>
        nameToCheck.includes(keyword.toLowerCase())
      );

      if (isDiscontinued) {
        discontinuedRows.push({
          rowNum,
          sku,
          name
        });
      }
    });

    console.log(`   발견된 Discontinued 상품: ${discontinuedRows.length}개\n`);

    if (discontinuedRows.length === 0) {
      console.log('✅ Discontinued 상품이 없습니다.');
      return;
    }

    // 3. 발견된 상품 목록 출력
    console.log('3. 발견된 Discontinued 상품 목록:\n');
    discontinuedRows.slice(0, 10).forEach((product, index) => {
      console.log(`   ${index + 1}. [행 ${product.rowNum}] ${product.sku}`);
      console.log(`      ${product.name}`);
    });

    if (discontinuedRows.length > 10) {
      console.log(`   ... 외 ${discontinuedRows.length - 10}개 더`);
    }

    console.log('\n4. 상태를 "삭제예정"으로 변경 중...\n');

    // 4. 상태 변경 (배치 처리)
    let updated = 0;
    const batchSize = 50;

    for (let i = 0; i < discontinuedRows.length; i += batchSize) {
      const batch = discontinuedRows.slice(i, Math.min(i + batchSize, discontinuedRows.length));

      for (const product of batch) {
        await sheets.writeData(SPREADSHEET_ID, `시트1!J${product.rowNum}`, [['삭제예정']]);
        updated++;

        if (updated % 10 === 0) {
          console.log(`   진행: ${updated} / ${discontinuedRows.length}`);
        }
      }

      // API 할당량 방지
      if (i + batchSize < discontinuedRows.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`\n✅ ${updated}개 상품을 "삭제예정" 상태로 변경했습니다.`);
    console.log(`\n📋 요약:`);
    console.log(`   - 전체 상품: ${data.length}개`);
    console.log(`   - Discontinued: ${discontinuedRows.length}개`);
    console.log(`   - 삭제예정 표시: ${updated}개`);
    console.log(`\n🔗 스프레드시트 확인:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
    console.log(`\n💡 다음 단계:`);
    console.log(`   1. 스프레드시트에서 "삭제예정" 필터로 확인`);
    console.log(`   2. 확인 후 delete-discontinued-from-shopify.js 실행`);

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

markDiscontinuedProducts();
