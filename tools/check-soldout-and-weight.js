require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 품절 상품과 무게 데이터 확인
 */

async function checkSoldoutAndWeight() {
  console.log('=== 품절 상품 및 무게 데이터 확인 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 전체 헤더 확인
    console.log('📋 1단계: 전체 헤더 확인\n');
    await dashboard.loadCells('A1:Z1');

    const headers = {};
    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        headers[cell.value] = col;
        console.log(`   ${String.fromCharCode(65 + col)}: ${cell.value}`);
      }
    }

    console.log();

    // 2. 품절/무게 관련 열 확인
    console.log('🔍 2단계: 품절/무게 관련 열 확인\n');

    const weightCol = headers['🔒 무게(kg)'] || headers['무게(kg)'] || headers['무게'];
    const soldCol = headers['Sold'] || headers['판매량'] || headers['품절'];
    const stockCol = headers['재고'] || headers['Stock'];
    const statusCol = headers['상태'] || headers['Status'];
    const shippingKRWCol = headers['배송비(KRW)'];

    console.log(`   무게 열: ${weightCol !== undefined ? String.fromCharCode(65 + weightCol) + '열' : '없음'}`);
    console.log(`   Sold 열: ${soldCol !== undefined ? String.fromCharCode(65 + soldCol) + '열' : '없음'}`);
    console.log(`   재고 열: ${stockCol !== undefined ? String.fromCharCode(65 + stockCol) + '열' : '없음'}`);
    console.log(`   상태 열: ${statusCol !== undefined ? String.fromCharCode(65 + statusCol) + '열' : '없음'}`);
    console.log(`   배송비(KRW) 열: ${shippingKRWCol !== undefined ? String.fromCharCode(65 + shippingKRWCol) + '열' : '없음'}`);
    console.log();

    // 3. 샘플 데이터 확인 (처음 20행)
    console.log('📊 3단계: 샘플 데이터 확인 (처음 20행)\n');

    const maxCol = Math.max(weightCol || 0, soldCol || 0, shippingKRWCol || 0, 20);
    await dashboard.loadCells(`A2:${String.fromCharCode(65 + maxCol)}21`);

    let withWeight = 0;
    let withoutWeight = 0;
    let soldoutCount = 0;

    console.log('   Row | 무게(kg) | Sold | 배송비(KRW)');
    console.log('   ----|----------|------|------------');

    for (let row = 1; row <= 20; row++) {
      const weight = weightCol !== undefined ? dashboard.getCell(row, weightCol).value : null;
      const sold = soldCol !== undefined ? dashboard.getCell(row, soldCol).value : null;
      const shipping = shippingKRWCol !== undefined ? dashboard.getCell(row, shippingKRWCol).value : null;

      console.log(`   ${String(row + 1).padStart(3)} | ${String(weight || '-').padStart(8)} | ${String(sold || '-').padStart(4)} | ${String(shipping || '-').padStart(10)}`);

      if (weight && weight > 0) withWeight++;
      else withoutWeight++;

      // 품절 판단 (Sold 열이 특정 값이거나 재고가 0인 경우)
      if (sold === '품절' || sold === 0 || sold === '0') soldoutCount++;
    }

    console.log();

    // 4. 전체 통계 (더 많은 행 확인)
    console.log('📈 4단계: 전체 통계 계산 중...\n');

    // 배치로 전체 데이터 로드
    const batchSize = 1000;
    let totalWithWeight = 0;
    let totalWithoutWeight = 0;
    let totalSoldout = 0;
    let totalRows = 0;

    for (let startRow = 1; startRow < 10000; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, 10000);

      if (weightCol !== undefined) {
        await dashboard.loadCells(`${String.fromCharCode(65 + weightCol)}${startRow + 1}:${String.fromCharCode(65 + Math.max(weightCol, soldCol || weightCol))}${endRow}`);

        for (let row = startRow; row < endRow; row++) {
          const weight = dashboard.getCell(row, weightCol).value;
          const sold = soldCol !== undefined ? dashboard.getCell(row, soldCol).value : null;

          if (weight !== null && weight !== '' && weight !== undefined) {
            totalRows++;
            if (parseFloat(weight) > 0) {
              totalWithWeight++;
            } else {
              totalWithoutWeight++;
            }
          }

          if (sold === '품절' || sold === 0 || sold === '0' || String(sold).toLowerCase() === 'sold out') {
            totalSoldout++;
          }
        }
      }
    }

    console.log(`   총 데이터 행: ${totalRows}개`);
    console.log(`   무게 입력됨: ${totalWithWeight}개`);
    console.log(`   무게 미입력: ${totalWithoutWeight}개`);
    console.log(`   품절 상품: ${totalSoldout}개`);
    console.log();

    console.log('='.repeat(60));
    console.log('📊 확인 결과');
    console.log('='.repeat(60));
    console.log();
    console.log('💡 다음 단계:');
    console.log('   1. 품절 상품 → eBay/Shopify API로 재고 0 업데이트');
    console.log('   2. 무게 있는 상품 → 배송비(KRW) 재계산');
    console.log();

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
  }
}

checkSoldoutAndWeight();
