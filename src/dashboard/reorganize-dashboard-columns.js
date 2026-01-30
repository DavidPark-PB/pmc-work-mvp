require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 대시보드 칼럼 전면 개편
 *
 * 새로운 칼럼 순서:
 * A: Image (이미지)
 * B: SKU
 * C: Product Title (상품명)
 * D: 🔒 무게(kg) - 보호
 * E: 🔒 매입가(KRW) - 보호
 * F: 실제 배송비(KRW) - 자동계산 (무게 기반)
 * G: eBay 수수료(KRW) - 자동계산
 * H: 미국 세금 15%(KRW) - 자동계산
 * I: 총 원가(KRW) - 자동계산 (매입가 + 배송비 + 수수료 + 세금)
 * J: eBay 가격(USD) - 자동계산 (총 원가 / 1400)
 * K: eBay 배송비(USD) - 수동 입력 (마진용)
 * L: 최종 순이익(KRW) - 자동계산 (배송비 USD가 순이익에 가산)
 * M: 마진율(%)
 * N: eBay Item ID
 * O: eBay판매량
 * P: eBay재고
 * Q: eBay 등록
 * R: Shopify 등록
 * S: 플랫폼
 * T: Last Updated
 * U: 정렬순위
 *
 * 가격 계산 로직:
 * - 총 원가 = 매입가 + 실제 배송비 + eBay 수수료 + (총액의 15% 세금)
 * - eBay 가격(USD) = 총 원가 / 1400
 * - eBay 배송비(USD) = 마진용 (사용자 입력)
 * - 최종 순이익 = eBay 배송비(USD) × 1400 (배송비가 곧 순이익)
 */

// 환율 설정
const EXCHANGE_RATE = 1400;
const EBAY_FEE_RATE = 0.15;  // eBay 수수료 15%
const US_TAX_RATE = 0.15;    // 미국 세금 15%

async function reorganizeDashboard() {
  console.log('='.repeat(70));
  console.log('📊 대시보드 칼럼 전면 개편');
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

    console.log(`📁 스프레드시트: ${doc.title}\n`);

    // 기존 대시보드 또는 백업에서 데이터 로드
    let oldDashboard = doc.sheetsByTitle['Dashboard_Backup_20260125'];
    if (!oldDashboard) {
      oldDashboard = doc.sheetsByTitle['최종 Dashboard'];
    }
    if (!oldDashboard) {
      console.log('❌ 데이터 시트를 찾을 수 없습니다.');
      return;
    }
    console.log(`   데이터 소스: "${oldDashboard.title}"\n`);

    console.log('📋 1단계: 기존 데이터 백업 중...\n');

    // 기존 헤더 확인 (처음 5행 모두 체크)
    await oldDashboard.loadCells('A1:Z5');
    const oldHeaders = {};

    // 헤더 행 찾기 (Row 1부터 5까지 스캔)
    let headerRow = 0;
    for (let row = 0; row < 5; row++) {
      const cellA = oldDashboard.getCell(row, 0);
      const cellB = oldDashboard.getCell(row, 1);
      const cellC = oldDashboard.getCell(row, 2);

      // SKU, Title, 상품명 등의 헤더가 있으면 그 행이 헤더
      if (String(cellB.value).includes('SKU') ||
          String(cellC.value).includes('Title') ||
          String(cellC.value).includes('상품명')) {
        headerRow = row;
        break;
      }
    }

    console.log(`   헤더 행: Row ${headerRow + 1}\n`);

    for (let col = 0; col < 26; col++) {
      const cell = oldDashboard.getCell(headerRow, col);
      if (cell.value) {
        oldHeaders[cell.value] = col;
        console.log(`   ${String.fromCharCode(65 + col)}: ${cell.value}`);
      }
    }
    console.log();

    // 중요 데이터 컬럼 인덱스 찾기
    const findCol = (keywords) => {
      for (const [header, col] of Object.entries(oldHeaders)) {
        for (const keyword of keywords) {
          if (header.includes(keyword)) return col;
        }
      }
      return -1;
    };

    // 현재 시트 구조 기반 매핑:
    // B: eBay Item ID (SKU 역할)
    // C: 상품명
    // G: 매입가
    // H: 무게 (첫번째)
    // R: 무게 (두번째)
    // J: eBay가격(USD)
    // K: eBay배송비(USD)

    const oldCols = {
      image: -1,  // 이미지 컬럼 없음
      sku: 1,  // B열 - eBay Item ID를 SKU로 사용
      title: 2,  // C열 - 상품명
      weight: 7,  // H열 - 무게 (첫번째)
      purchasePrice: 6,  // G열 - 매입가
      ebayItemId: 4,  // E열 - eBay Item ID (중복)
      ebayPrice: 9,  // J열 - eBay가격(USD)
      ebayShipping: 10,  // K열 - eBay배송비(USD)
      sold: 19,  // T열 - Sold
      stock: -1,  // 재고 컬럼 없음
      ebayReg: 22,  // W열 - eBay 등록
      shopifyReg: 23,  // X열 - Shopify 등록
      platform: 5,  // F열 - 판매처
      lastUpdated: -1,
      sortPriority: 24  // Y열 - 정렬순위
    };

    console.log('📍 발견된 컬럼 위치:');
    for (const [key, col] of Object.entries(oldCols)) {
      if (col >= 0) {
        console.log(`   ${key}: ${String.fromCharCode(65 + col)}열`);
      }
    }
    console.log();

    // 전체 데이터 로드
    console.log('📥 2단계: 전체 데이터 로드 중...\n');

    const lastRow = oldDashboard.rowCount;
    console.log(`   시트 총 ${lastRow}행\n`);

    // 백업 데이터 저장
    const backupData = [];

    // 데이터 시작 행 (헤더 다음 행)
    const dataStartRow = headerRow + 1;

    // 배치로 데이터 읽기
    const batchSize = 500;
    for (let startRow = dataStartRow; startRow < Math.min(lastRow, 10000); startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, lastRow);

      await oldDashboard.loadCells(`A${startRow + 1}:Z${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        const rowData = {
          image: oldCols.image >= 0 ? oldDashboard.getCell(row, oldCols.image).value : '',
          sku: oldCols.sku >= 0 ? oldDashboard.getCell(row, oldCols.sku).value : '',
          title: oldCols.title >= 0 ? oldDashboard.getCell(row, oldCols.title).value : '',
          weight: oldCols.weight >= 0 ? oldDashboard.getCell(row, oldCols.weight).value : '',
          purchasePrice: oldCols.purchasePrice >= 0 ? oldDashboard.getCell(row, oldCols.purchasePrice).value : '',
          ebayItemId: oldCols.ebayItemId >= 0 ? oldDashboard.getCell(row, oldCols.ebayItemId).value : '',
          ebayPrice: oldCols.ebayPrice >= 0 ? oldDashboard.getCell(row, oldCols.ebayPrice).value : '',
          ebayShipping: oldCols.ebayShipping >= 0 ? oldDashboard.getCell(row, oldCols.ebayShipping).value : '',
          sold: oldCols.sold >= 0 ? oldDashboard.getCell(row, oldCols.sold).value : '',
          stock: oldCols.stock >= 0 ? oldDashboard.getCell(row, oldCols.stock).value : '',
          ebayReg: oldCols.ebayReg >= 0 ? oldDashboard.getCell(row, oldCols.ebayReg).value : '',
          shopifyReg: oldCols.shopifyReg >= 0 ? oldDashboard.getCell(row, oldCols.shopifyReg).value : '',
          platform: oldCols.platform >= 0 ? oldDashboard.getCell(row, oldCols.platform).value : '',
          lastUpdated: oldCols.lastUpdated >= 0 ? oldDashboard.getCell(row, oldCols.lastUpdated).value : '',
          sortPriority: oldCols.sortPriority >= 0 ? oldDashboard.getCell(row, oldCols.sortPriority).value : ''
        };

        // 실제 데이터가 있는 행만 저장 (SKU 또는 Title이 있는 경우)
        // B열(sku)에 12자리 숫자가 있거나 C열(title)에 값이 있으면 유효 데이터
        const hasData = (rowData.sku && String(rowData.sku).length > 5) ||
                        (rowData.title && String(rowData.title).length > 3);
        if (hasData) {
          backupData.push(rowData);
        }
      }

      console.log(`   ${Math.min(endRow, backupData.length + startRow)}행 처리 완료...`);
    }

    console.log(`\n   ✅ 총 ${backupData.length}개 상품 데이터 백업 완료\n`);

    // 새 시트 생성
    console.log('🆕 3단계: 새 대시보드 생성 중...\n');

    // 기존 "최종 Dashboard" 시트가 있으면 삭제
    const existingDashboard = doc.sheetsByTitle['최종 Dashboard'];
    if (existingDashboard) {
      await existingDashboard.delete();
      console.log('   기존 "최종 Dashboard" 시트 삭제\n');
    }

    // 새 대시보드 생성 (10000행으로 설정)
    const newDashboard = await doc.addSheet({
      title: '최종 Dashboard',
      gridProperties: {
        rowCount: 10000,
        columnCount: 26
      },
      headerValues: [
        'Image',           // A
        'SKU',             // B
        '상품명',           // C
        '🔒 무게(kg)',      // D - 보호
        '🔒 매입가(KRW)',   // E - 보호
        '실제 배송비(KRW)', // F - 자동계산
        'eBay 수수료(KRW)', // G - 자동계산
        '미국 세금 15%(KRW)', // H - 자동계산
        '총 원가(KRW)',     // I - 자동계산
        'eBay 가격(USD)',   // J - 자동계산
        'eBay 배송비(USD)', // K - 수동 입력 (마진)
        '최종 순이익(KRW)', // L - 자동계산
        '마진율(%)',       // M - 자동계산
        'eBay Item ID',    // N
        'eBay판매량',      // O
        'eBay재고',        // P
        'eBay 등록',       // Q
        'Shopify 등록',    // R
        '플랫폼',          // S
        'Last Updated',    // T
        '정렬순위'         // U
      ]
    });

    console.log('   ✅ 새 대시보드 생성 완료\n');

    // 데이터 및 수식 입력
    console.log('⚡ 4단계: 데이터 및 수식 적용 중...\n');

    /*
     * 수식 설명:
     *
     * F: 실제 배송비(KRW) = Shipping Rates에서 무게 기반 조회
     *    =IFERROR(INDEX('Shipping Rates'!$D:$D,MATCH(1,('Shipping Rates'!$A:$A="YunExpress")*('Shipping Rates'!$B:$B="US")*('Shipping Rates'!$C:$C>=D{row}*1000),0)),IF(D{row}>0,15000,0))
     *
     * G: eBay 수수료(KRW) = (매입가 + 배송비) × 15%
     *    =IFERROR(IF(E{row}="품절",0,(E{row}+F{row})*0.15),0)
     *
     * H: 미국 세금 15%(KRW) = (매입가 + 배송비 + 수수료) × 15%
     *    =IFERROR(IF(E{row}="품절",0,(E{row}+F{row}+G{row})*0.15),0)
     *
     * I: 총 원가(KRW) = 매입가 + 배송비 + 수수료 + 세금
     *    =IFERROR(IF(E{row}="품절",0,E{row}+F{row}+G{row}+H{row}),0)
     *
     * J: eBay 가격(USD) = 총 원가 / 1400
     *    =IFERROR(IF(I{row}=0,0,ROUND(I{row}/1400,2)),0)
     *
     * K: eBay 배송비(USD) = 수동 입력 (마진용)
     *    (빈 칸으로 두어 사용자가 입력)
     *
     * L: 최종 순이익(KRW) = eBay 배송비(USD) × 1400
     *    =IFERROR(IF(K{row}="",0,K{row}*1400),0)
     *
     * M: 마진율(%) = 순이익 / 총 원가 × 100
     *    =IFERROR(IF(OR(I{row}=0,L{row}=0),0,ROUND(L{row}/I{row}*100,1)),0)
     *
     * U: 정렬순위 = 품절이면 2, 아니면 1
     *    =IF(OR(E{row}="품절",E{row}="재고부족",E{row}="재고 부족",E{row}=0),2,1)
     */

    const formulas = {
      // F열: 실제 배송비 (무게 기반)
      shipping: (row) => `=IFERROR(INDEX('Shipping Rates'!$D:$D,MATCH(1,('Shipping Rates'!$A:$A="YunExpress")*('Shipping Rates'!$B:$B="US")*('Shipping Rates'!$C:$C>=D${row}*1000),0)),IF(D${row}>0,15000,0))`,

      // G열: eBay 수수료 (매입가+배송비의 15%)
      ebayFee: (row) => `=IFERROR(IF(E${row}="품절",0,(E${row}+F${row})*0.15),0)`,

      // H열: 미국 세금 15% (매입가+배송비+수수료의 15%)
      usTax: (row) => `=IFERROR(IF(E${row}="품절",0,(E${row}+F${row}+G${row})*0.15),0)`,

      // I열: 총 원가 (매입가 + 배송비 + 수수료 + 세금)
      totalCost: (row) => `=IFERROR(IF(E${row}="품절",0,E${row}+F${row}+G${row}+H${row}),0)`,

      // J열: eBay 가격 USD (총 원가 / 1400)
      ebayPrice: (row) => `=IFERROR(IF(I${row}=0,0,ROUND(I${row}/1400,2)),0)`,

      // L열: 최종 순이익 (eBay 배송비 USD × 1400)
      profit: (row) => `=IFERROR(IF(K${row}="",0,K${row}*1400),0)`,

      // M열: 마진율 (순이익 / 총원가 × 100)
      margin: (row) => `=IFERROR(IF(OR(I${row}=0,L${row}=0),0,ROUND(L${row}/I${row}*100,1)),0)`,

      // U열: 정렬순위 (품절=2, 판매가능=1)
      sortPriority: (row) => `=IF(OR(E${row}="품절",E${row}="재고부족",E${row}="재고 부족",E${row}=0),2,1)`
    };

    // 배치로 데이터 입력
    const insertBatchSize = 200;
    let processedRows = 0;

    for (let i = 0; i < backupData.length; i += insertBatchSize) {
      const batch = backupData.slice(i, i + insertBatchSize);
      const startRow = i + 2;  // 헤더가 1행이므로 데이터는 2행부터
      const endRow = startRow + batch.length - 1;

      // 셀 로드
      await newDashboard.loadCells(`A${startRow}:U${endRow}`);

      for (let j = 0; j < batch.length; j++) {
        const data = batch[j];
        const row = startRow + j;
        const rowIndex = row - 1;  // 0-indexed

        // A: Image
        const imageCell = newDashboard.getCell(rowIndex, 0);
        if (data.image && String(data.image).startsWith('=IMAGE')) {
          imageCell.formula = data.image;
        } else if (data.image) {
          imageCell.value = data.image;
        }

        // B: SKU
        newDashboard.getCell(rowIndex, 1).value = data.sku || '';

        // C: 상품명
        newDashboard.getCell(rowIndex, 2).value = data.title || '';

        // D: 🔒 무게(kg) - 보호 데이터 유지
        newDashboard.getCell(rowIndex, 3).value = data.weight || '';

        // E: 🔒 매입가(KRW) - 보호 데이터 유지
        newDashboard.getCell(rowIndex, 4).value = data.purchasePrice || '';

        // F: 실제 배송비(KRW) - 수식
        newDashboard.getCell(rowIndex, 5).formula = formulas.shipping(row);

        // G: eBay 수수료(KRW) - 수식
        newDashboard.getCell(rowIndex, 6).formula = formulas.ebayFee(row);

        // H: 미국 세금 15%(KRW) - 수식
        newDashboard.getCell(rowIndex, 7).formula = formulas.usTax(row);

        // I: 총 원가(KRW) - 수식
        newDashboard.getCell(rowIndex, 8).formula = formulas.totalCost(row);

        // J: eBay 가격(USD) - 수식
        newDashboard.getCell(rowIndex, 9).formula = formulas.ebayPrice(row);

        // K: eBay 배송비(USD) - 빈 칸 (수동 입력용, 기존 값 있으면 유지)
        const existingShipping = data.ebayShipping;
        if (existingShipping && !isNaN(parseFloat(existingShipping))) {
          newDashboard.getCell(rowIndex, 10).value = parseFloat(existingShipping);
        }

        // L: 최종 순이익(KRW) - 수식
        newDashboard.getCell(rowIndex, 11).formula = formulas.profit(row);

        // M: 마진율(%) - 수식
        newDashboard.getCell(rowIndex, 12).formula = formulas.margin(row);

        // N: eBay Item ID
        newDashboard.getCell(rowIndex, 13).value = data.ebayItemId || '';

        // O: eBay판매량
        newDashboard.getCell(rowIndex, 14).value = data.sold || '';

        // P: eBay재고
        newDashboard.getCell(rowIndex, 15).value = data.stock || '';

        // Q: eBay 등록
        newDashboard.getCell(rowIndex, 16).value = data.ebayReg || '';

        // R: Shopify 등록
        newDashboard.getCell(rowIndex, 17).value = data.shopifyReg || '';

        // S: 플랫폼
        newDashboard.getCell(rowIndex, 18).value = data.platform || '';

        // T: Last Updated
        newDashboard.getCell(rowIndex, 19).value = data.lastUpdated || '';

        // U: 정렬순위 - 수식
        newDashboard.getCell(rowIndex, 20).formula = formulas.sortPriority(row);
      }

      await newDashboard.saveUpdatedCells();
      processedRows += batch.length;

      console.log(`   ${processedRows}/${backupData.length} 행 처리 완료 (${Math.round(processedRows/backupData.length*100)}%)`);
    }

    console.log();
    console.log('='.repeat(70));
    console.log('✅ 대시보드 개편 완료!');
    console.log('='.repeat(70));
    console.log();

    console.log('📊 새로운 칼럼 구조:');
    console.log();
    console.log('   A: Image (이미지)');
    console.log('   B: SKU');
    console.log('   C: 상품명');
    console.log('   D: 🔒 무게(kg) - [보호됨, 수동 입력]');
    console.log('   E: 🔒 매입가(KRW) - [보호됨, 수동 입력]');
    console.log('   F: 실제 배송비(KRW) - [자동] 무게 기반');
    console.log('   G: eBay 수수료(KRW) - [자동] (매입가+배송비)×15%');
    console.log('   H: 미국 세금 15%(KRW) - [자동] (매입가+배송비+수수료)×15%');
    console.log('   I: 총 원가(KRW) - [자동] 매입가+배송비+수수료+세금');
    console.log('   J: eBay 가격(USD) - [자동] 총원가÷1400');
    console.log('   K: eBay 배송비(USD) - [수동 입력] ⭐ 이 값이 순이익!');
    console.log('   L: 최종 순이익(KRW) - [자동] K열×1400');
    console.log('   M: 마진율(%) - [자동] 순이익÷총원가×100');
    console.log('   N: eBay Item ID');
    console.log('   O: eBay판매량');
    console.log('   P: eBay재고');
    console.log('   Q: eBay 등록');
    console.log('   R: Shopify 등록');
    console.log('   S: 플랫폼');
    console.log('   T: Last Updated');
    console.log('   U: 정렬순위');
    console.log();

    console.log('💡 가격 계산 로직:');
    console.log();
    console.log('   1. 총 원가 = 매입가 + 실제 배송비 + eBay 수수료 + 미국 세금');
    console.log('   2. eBay 가격(USD) = 총 원가 ÷ 1400 (원가 기준 자동 산출)');
    console.log('   3. eBay 배송비(USD) = 직접 입력 (예: $3.90)');
    console.log('   4. 최종 순이익 = eBay 배송비 × 1400 (배송비가 곧 마진!)');
    console.log();

    console.log('📌 사용 예시:');
    console.log('   - K열에 3.90 입력 → L열에 ₩5,460 순이익 표시');
    console.log('   - K열에 5.00 입력 → L열에 ₩7,000 순이익 표시');
    console.log();

    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();
    console.log(`📁 백업: "Dashboard_Backup_${timestamp}" 시트에 기존 데이터 보관`);
    console.log();

  } catch (error) {
    console.error('\n❌ 오류 발생:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

reorganizeDashboard();
