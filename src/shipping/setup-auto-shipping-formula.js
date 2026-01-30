require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 배송비 자동 계산 수식 설정
 *
 * 1. O열(배송비)에 VLOOKUP/INDEX-MATCH 수식 적용
 * 2. 무게(R열) 기반으로 Shipping Rates 시트에서 요율 조회
 * 3. 정렬용 열 추가 (품절/재고부족 맨 아래로)
 */

async function setupAutoShippingFormula() {
  console.log('='.repeat(70));
  console.log('📦 배송비 자동 계산 수식 설정');
  console.log('='.repeat(70));
  console.log();

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    const shippingRates = doc.sheetsByTitle['Shipping Rates'];

    console.log(`📊 Dashboard: ${dashboard.title}`);
    console.log(`📦 Shipping Rates: ${shippingRates.title}\n`);

    // 1. 헤더 확인
    console.log('📋 1단계: 헤더 확인 중...\n');
    await dashboard.loadCells('A1:Z1');

    const headers = {};
    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(0, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    const weightCol = headers['🔒 무게(kg)'];  // R열 = 17
    const shippingCol = headers['배송비(KRW)'];  // O열 = 14
    const purchaseCol = headers['🔒 매입가'];  // F열 = 5

    console.log(`   무게(kg): ${weightCol !== undefined ? String.fromCharCode(65 + weightCol) + '열' : '없음'}`);
    console.log(`   배송비(KRW): ${shippingCol !== undefined ? String.fromCharCode(65 + shippingCol) + '열' : '없음'}`);
    console.log(`   매입가: ${purchaseCol !== undefined ? String.fromCharCode(65 + purchaseCol) + '열' : '없음'}`);
    console.log();

    // 2. 정렬 우선순위 열 추가 (Y열)
    console.log('📐 2단계: 정렬 우선순위 열 추가 (Y열)...\n');

    await dashboard.loadCells('Y1:Y1');
    const sortHeaderCell = dashboard.getCell(0, 24);  // Y열
    sortHeaderCell.value = '정렬순위';
    await dashboard.saveUpdatedCells();
    console.log('   ✅ Y열에 "정렬순위" 헤더 추가\n');

    // 3. 배송비 수식 및 정렬 수식 적용
    console.log('⚡ 3단계: 수식 적용 중...\n');

    // 수식 설명:
    // 배송비: 무게(kg)를 g으로 변환 → Shipping Rates에서 가장 가까운 요율 조회
    // YunExpress US 요율 사용 (가장 많이 사용)

    const weightColLetter = String.fromCharCode(65 + weightCol);  // R
    const purchaseColLetter = String.fromCharCode(65 + purchaseCol);  // F

    // 배송비 수식: INDEX-MATCH로 무게에 맞는 요율 조회
    // =IFERROR(INDEX('Shipping Rates'!$D:$D, MATCH(TRUE, ('Shipping Rates'!$A:$A="YunExpress")*('Shipping Rates'!$B:$B="US")*('Shipping Rates'!$C:$C>=R2*1000), 0)), 15000)
    const shippingFormula = (row) => {
      return `=IFERROR(INDEX('Shipping Rates'!$D:$D,MATCH(1,('Shipping Rates'!$A:$A="YunExpress")*('Shipping Rates'!$B:$B="US")*('Shipping Rates'!$C:$C>=${weightColLetter}${row}*1000),0)),IF(${weightColLetter}${row}>0,15000,0))`;
    };

    // 정렬 수식: 품절이면 2, 아니면 1 (1이 먼저 정렬됨)
    // =IF(OR(F열="품절", F열="재고부족", F열="재고 부족", F열=0), 2, 1)
    const sortFormula = (row) => {
      return `=IF(OR(${purchaseColLetter}${row}="품절",${purchaseColLetter}${row}="재고부족",${purchaseColLetter}${row}="재고 부족",${purchaseColLetter}${row}=0),2,1)`;
    };

    console.log(`   배송비 수식 예시 (Row 2):\n   ${shippingFormula(2)}\n`);
    console.log(`   정렬순위 수식 예시 (Row 2):\n   ${sortFormula(2)}\n`);

    // 배치로 수식 적용
    let shippingUpdated = 0;
    let sortUpdated = 0;
    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      // O열(배송비)과 Y열(정렬순위) 로드
      await dashboard.loadCells(`O${startRow + 1}:Y${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        // 배송비 수식 (O열 = index 14)
        const shippingCell = dashboard.getCell(row, 14);
        shippingCell.formula = shippingFormula(row + 1);
        shippingUpdated++;

        // 정렬순위 수식 (Y열 = index 24)
        const sortCell = dashboard.getCell(row, 24);
        sortCell.formula = sortFormula(row + 1);
        sortUpdated++;
      }

      await dashboard.saveUpdatedCells();

      if (endRow % 1000 === 0 || endRow === totalRows) {
        console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
      }
    }

    console.log();
    console.log(`   ✅ 배송비 수식: ${shippingUpdated}개 행`);
    console.log(`   ✅ 정렬순위 수식: ${sortUpdated}개 행`);
    console.log();

    // 4. 정렬 및 필터 안내
    console.log('='.repeat(70));
    console.log('🎯 설정 완료 및 사용 방법');
    console.log('='.repeat(70));
    console.log();

    console.log('📦 배송비 자동 계산:');
    console.log('   - O열(배송비)이 R열(무게)에 연동됨');
    console.log('   - Shipping Rates 시트에서 YunExpress US 요율 자동 조회');
    console.log('   - 무게가 없으면 0원, 매칭 실패 시 15,000원 기본값');
    console.log();

    console.log('🔢 정렬 방법 (품절 상품 맨 아래로):');
    console.log('   1. Google Sheets에서 데이터 → 정렬 범위');
    console.log('   2. 범위: A2:Y10000 (헤더 제외)');
    console.log('   3. 정렬 기준 1: Y열(정렬순위) 오름차순');
    console.log('   4. 정렬 기준 2: 원하는 열 선택 (예: SKU, 상품명 등)');
    console.log();

    console.log('🔍 필터 방법 (품절 상품 숨기기):');
    console.log('   1. 데이터 → 필터 만들기');
    console.log('   2. Y열(정렬순위) 필터 클릭');
    console.log('   3. "1"만 선택 → 품절 제외한 상품만 표시');
    console.log('   4. 또는 "2"만 선택 → 품절 상품만 표시');
    console.log();

    console.log('💡 자동 정렬 설정:');
    console.log('   Google Apps Script에서 onEdit 트리거로 자동 정렬 가능');
    console.log('   (아래 스크립트 추가 필요)');
    console.log();

    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();
    console.log('🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

setupAutoShippingFormula();
