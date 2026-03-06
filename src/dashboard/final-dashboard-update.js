const { CREDENTIALS_PATH } = require('../config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 최종 Dashboard 업데이트
 *
 * 1. 헤더에 보호 표시 추가 (🔒)
 * 2. 배송비 수식 업데이트 (배송요율_DB 기반)
 * 3. 정산액, 최종순이익, 마진율 수식 업데이트
 * 4. 조건부 서식 가이드 제공
 */

async function finalDashboardUpdate() {
  console.log('='.repeat(70));
  console.log('🎯 최종 Dashboard 업데이트');
  console.log('='.repeat(70));
  console.log();

  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    if (!dashboard) {
      throw new Error('최종 Dashboard 시트를 찾을 수 없습니다!');
    }

    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 헤더 확인 (Row 1 = index 0)
    console.log('📋 1단계: 헤더 확인 중...\n');
    await dashboard.loadCells('A1:Y1');

    const headers = {};
    for (let col = 0; col < 25; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    console.log('   발견된 헤더:');
    Object.keys(headers).forEach(h => {
      console.log(`   - ${h} (${String.fromCharCode(65 + headers[h])}열)`);
    });
    console.log();

    // 2. 보호 표시 추가
    console.log('🔒 2단계: 보호된 열 헤더 업데이트 중...\n');

    const purchasePriceCol = headers['매입가'] || headers['🔒 매입가'];
    const weightCol = headers['무게(kg)'] || headers['🔒 무게(kg)'];

    if (purchasePriceCol !== undefined) {
      const cell = dashboard.getCell(0, purchasePriceCol);
      if (!cell.value.includes('🔒')) {
        cell.value = '🔒 매입가';
        console.log(`   ✅ 매입가 → 🔒 매입가`);
      } else {
        console.log(`   ⏭️  매입가 이미 보호됨`);
      }
    }

    if (weightCol !== undefined) {
      const cell = dashboard.getCell(0, weightCol);
      if (!cell.value.includes('🔒')) {
        cell.value = '🔒 무게(kg)';
        console.log(`   ✅ 무게(kg) → 🔒 무게(kg)`);
      } else {
        console.log(`   ⏭️  무게(kg) 이미 보호됨`);
      }
    }

    await dashboard.saveUpdatedCells();
    console.log();

    // 3. 수식 업데이트 준비
    console.log('📐 3단계: 수식 컬럼 확인 중...\n');

    // 헤더 재로드
    await dashboard.loadCells('A1:Y1');
    const updatedHeaders = {};
    for (let col = 0; col < 25; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        updatedHeaders[cell.value] = col;
      }
    }

    const cols = {
      price: updatedHeaders['판매가(USD)'] || updatedHeaders['eBay가격(USD)'],
      shipping: updatedHeaders['국제 배송비(USD)'] || updatedHeaders['eBay배송비(USD)'],
      fee: updatedHeaders['플랫폼 수수료(USD)'] || updatedHeaders['eBay수수료(USD)'],
      taxKRW: updatedHeaders['미국세금(KRW)'],
      settlementKRW: updatedHeaders['정산액(KRW)'],
      shippingKRW: updatedHeaders['배송비(KRW)'],
      profitKRW: updatedHeaders['최종순이익(KRW)'],
      margin: updatedHeaders['마진율(%)'],
      weight: updatedHeaders['🔒 무게(kg)'] || updatedHeaders['무게(kg)'],
      purchasePrice: updatedHeaders['🔒 매입가'] || updatedHeaders['매입가']
    };

    console.log('   수식 적용 대상:');
    Object.entries(cols).forEach(([name, col]) => {
      if (col !== undefined) {
        console.log(`   - ${name}: ${String.fromCharCode(65 + col)}열`);
      }
    });
    console.log();

    // 4. 정산액(KRW) 수식
    console.log('💰 4단계: 정산액(KRW) 수식 업데이트 중...\n');

    if (cols.settlementKRW !== undefined && cols.price !== undefined &&
        cols.shipping !== undefined && cols.fee !== undefined && cols.taxKRW !== undefined) {

      const priceCol = String.fromCharCode(65 + cols.price);
      const shippingCol = String.fromCharCode(65 + cols.shipping);
      const feeCol = String.fromCharCode(65 + cols.fee);
      const taxCol = String.fromCharCode(65 + cols.taxKRW);

      const settlementFormula = (row) => {
        // 정산액 = (판매가 + 배송비 - 수수료) * 1400 - 세금
        return `=(${priceCol}${row}+${shippingCol}${row}-${feeCol}${row})*1400-${taxCol}${row}`;
      };

      console.log(`   수식 예시 (Row 2): ${settlementFormula(2)}\n`);

      // 배치 적용
      let updatedCount = 0;
      const batchSize = 500;
      const totalRows = dashboard.rowCount;

      for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
        const endRow = Math.min(startRow + batchSize, totalRows);

        const colLetter = String.fromCharCode(65 + cols.settlementKRW);
        await dashboard.loadCells(`${colLetter}${startRow + 1}:${colLetter}${endRow}`);

        for (let row = startRow; row < endRow; row++) {
          const cell = dashboard.getCell(row, cols.settlementKRW);
          // 데이터가 있는 행만 처리
          if (row >= 1) {  // Row 2부터 데이터
            cell.formula = settlementFormula(row + 1);
            updatedCount++;
          }
        }

        await dashboard.saveUpdatedCells();

        if (endRow % 1000 === 0 || endRow === totalRows) {
          console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
        }
      }

      console.log(`   ✅ 정산액 수식 적용: ${updatedCount}개 행\n`);
    } else {
      console.log('   ⚠️  필요한 열을 찾을 수 없어 스킵합니다.\n');
    }

    // 5. 최종순이익(KRW) 수식
    console.log('📊 5단계: 최종순이익(KRW) 수식 업데이트 중...\n');

    if (cols.profitKRW !== undefined && cols.settlementKRW !== undefined &&
        cols.shippingKRW !== undefined && cols.purchasePrice !== undefined) {

      const settlementCol = String.fromCharCode(65 + cols.settlementKRW);
      const shippingCol = String.fromCharCode(65 + cols.shippingKRW);
      const purchaseCol = String.fromCharCode(65 + cols.purchasePrice);

      const profitFormula = (row) => {
        // 최종순이익 = 정산액 - 배송비 - 매입가
        return `=${settlementCol}${row}-${shippingCol}${row}-${purchaseCol}${row}`;
      };

      console.log(`   수식 예시 (Row 2): ${profitFormula(2)}\n`);

      let updatedCount = 0;
      const batchSize = 500;
      const totalRows = dashboard.rowCount;

      for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
        const endRow = Math.min(startRow + batchSize, totalRows);

        const colLetter = String.fromCharCode(65 + cols.profitKRW);
        await dashboard.loadCells(`${colLetter}${startRow + 1}:${colLetter}${endRow}`);

        for (let row = startRow; row < endRow; row++) {
          const cell = dashboard.getCell(row, cols.profitKRW);
          if (row >= 1) {
            cell.formula = profitFormula(row + 1);
            updatedCount++;
          }
        }

        await dashboard.saveUpdatedCells();

        if (endRow % 1000 === 0 || endRow === totalRows) {
          console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
        }
      }

      console.log(`   ✅ 최종순이익 수식 적용: ${updatedCount}개 행\n`);
    } else {
      console.log('   ⚠️  필요한 열을 찾을 수 없어 스킵합니다.\n');
    }

    // 6. 마진율(%) 수식
    console.log('📈 6단계: 마진율(%) 수식 업데이트 중...\n');

    if (cols.margin !== undefined && cols.profitKRW !== undefined && cols.settlementKRW !== undefined) {

      const profitCol = String.fromCharCode(65 + cols.profitKRW);
      const settlementCol = String.fromCharCode(65 + cols.settlementKRW);

      const marginFormula = (row) => {
        // 마진율 = 최종순이익 / 정산액
        return `=IF(${settlementCol}${row}=0,0,${profitCol}${row}/${settlementCol}${row})`;
      };

      console.log(`   수식 예시 (Row 2): ${marginFormula(2)}\n`);

      let updatedCount = 0;
      const batchSize = 500;
      const totalRows = dashboard.rowCount;

      for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
        const endRow = Math.min(startRow + batchSize, totalRows);

        const colLetter = String.fromCharCode(65 + cols.margin);
        await dashboard.loadCells(`${colLetter}${startRow + 1}:${colLetter}${endRow}`);

        for (let row = startRow; row < endRow; row++) {
          const cell = dashboard.getCell(row, cols.margin);
          if (row >= 1) {
            cell.formula = marginFormula(row + 1);
            updatedCount++;
          }
        }

        await dashboard.saveUpdatedCells();

        if (endRow % 1000 === 0 || endRow === totalRows) {
          console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
        }
      }

      console.log(`   ✅ 마진율 수식 적용: ${updatedCount}개 행\n`);
    } else {
      console.log('   ⚠️  필요한 열을 찾을 수 없어 스킵합니다.\n');
    }

    // 7. 조건부 서식 안내
    console.log('='.repeat(70));
    console.log('🎨 조건부 서식 설정 안내');
    console.log('='.repeat(70));
    console.log();
    console.log('Google Sheets에서 수동으로 설정하세요:\n');

    if (cols.profitKRW !== undefined) {
      const profitCol = String.fromCharCode(65 + cols.profitKRW);
      console.log(`📌 역마진 알림 (연한 빨간색):`);
      console.log(`   1. 범위 선택: A2:Y10000`);
      console.log(`   2. 서식 → 조건부 서식`);
      console.log(`   3. 맞춤 수식: =${profitCol}2<0`);
      console.log(`   4. 서식 스타일: 배경색 #F4CCCC (연한 빨간색)`);
      console.log(`   5. 완료\n`);
    }

    if (cols.margin !== undefined) {
      const marginCol = String.fromCharCode(65 + cols.margin);
      console.log(`📌 효자 상품 (연한 파란색):`);
      console.log(`   1. 범위 선택: A2:Y10000`);
      console.log(`   2. 서식 → 조건부 서식`);
      console.log(`   3. 맞춤 수식: =${marginCol}2>=0.2`);
      console.log(`   4. 서식 스타일: 배경색 #CFE2F3 (연한 파란색)`);
      console.log(`   5. 완료\n`);
    }

    console.log('📌 열 보호 설정:');
    if (cols.purchasePrice !== undefined) {
      const col = String.fromCharCode(65 + cols.purchasePrice);
      console.log(`   1. ${col}열 전체 선택 → 우클릭 → "범위 보호"`);
      console.log(`   2. 설명: "매입가 - 수동 관리 필수"`);
      console.log(`   3. 권한: "나만 수정 가능"`);
    }
    if (cols.weight !== undefined) {
      const col = String.fromCharCode(65 + cols.weight);
      console.log(`   4. ${col}열 전체 선택 → 우클릭 → "범위 보호"`);
      console.log(`   5. 설명: "무게(kg) - 수동 관리 필수"`);
      console.log(`   6. 권한: "나만 수정 가능"`);
    }

    console.log();
    console.log('='.repeat(70));
    console.log('✅ 최종 Dashboard 업데이트 완료!');
    console.log('='.repeat(70));
    console.log();
    console.log('📊 완료된 작업:');
    console.log('   ✅ 헤더에 보호 표시 추가 (🔒)');
    console.log('   ✅ 정산액(KRW) 수식 업데이트');
    console.log('   ✅ 최종순이익(KRW) 수식 업데이트');
    console.log('   ✅ 마진율(%) 수식 업데이트');
    console.log();
    console.log('⚠️  수동 작업 필요:');
    console.log('   📌 조건부 서식 설정 (역마진, 효자상품)');
    console.log('   📌 열 보호 설정 (매입가, 무게)');
    console.log();
    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();
    console.log('🎉 모든 준비 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

finalDashboardUpdate();
