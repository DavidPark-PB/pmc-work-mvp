require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 최종 Dashboard의 모든 행에 수식 강제 적용
 */

async function applyAllFormulas() {
  console.log('=== 전체 행 수식 강제 적용 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`📊 스프레드시트: ${doc.title}\n`);

    const sheet = doc.sheetsByTitle['최종 Dashboard'];
    if (!sheet) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log(`📏 시트 크기: ${sheet.rowCount} 행 x ${sheet.columnCount} 컬럼`);

    // 데이터가 있는 마지막 행 찾기
    console.log('\n🔍 데이터 마지막 행 확인 중...');
    await sheet.loadCells('A1:A5000');

    let lastDataRow = 3; // 최소 4행부터 시작
    for (let row = 3; row < 5000; row++) {
      const cell = sheet.getCell(row, 0); // A열 (SKU)
      if (cell.value) {
        lastDataRow = row;
      }
    }

    const totalDataRows = lastDataRow - 2; // 3행이 헤더이므로
    console.log(`   ✅ 마지막 데이터 행: ${lastDataRow + 1}행 (엑셀 기준)`);
    console.log(`   ✅ 총 데이터 행 수: ${totalDataRows}개\n`);

    // 전체 행에 수식 적용
    console.log('📐 전체 행 수식 적용 시작...\n');

    const batchSize = 500; // 500개씩 처리
    let processedRows = 0;

    for (let batchStart = 3; batchStart <= lastDataRow; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize - 1, lastDataRow);
      const rowStart = batchStart + 1; // 엑셀 행 번호 (1-based)
      const rowEnd = batchEnd + 1;

      console.log(`   진행 중: ${rowStart}행 ~ ${rowEnd}행 (${processedRows + 1} ~ ${processedRows + (batchEnd - batchStart + 1)} / ${totalDataRows})`);

      // H~J, L~M 열 로드 (수식 열)
      await sheet.loadCells(`H${rowStart}:J${rowEnd}`);
      await sheet.loadCells(`L${rowStart}:M${rowEnd}`);

      for (let rowIdx = batchStart; rowIdx <= batchEnd; rowIdx++) {
        const rowNum = rowIdx + 1; // 실제 시트 행 번호 (1-based)

        // H열: eBay수수료(USD) = (eBay가격 + eBay배송비) * 0.18
        const feeCell = sheet.getCell(rowIdx, 7);
        feeCell.formula = `=IFERROR(IF(OR(ISBLANK(F${rowNum}),VALUE(F${rowNum})=0),"",(VALUE(F${rowNum})+VALUE(G${rowNum}))*0.18),"")`;
        feeCell.numberFormat = { type: 'NUMBER', pattern: '0.00' };

        // I열: 미국세금(KRW) = 매입가(KRW) * 0.15
        const taxCell = sheet.getCell(rowIdx, 8);
        taxCell.formula = `=IFERROR(IF(OR(ISBLANK(E${rowNum}),VALUE(E${rowNum})=0),"",VALUE(E${rowNum})*0.15),"")`;
        taxCell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };

        // J열: 정산액(KRW) = (eBay가격 + eBay배송비) * 0.82 * 1400
        const settlementCell = sheet.getCell(rowIdx, 9);
        settlementCell.formula = `=IFERROR(IF(OR(ISBLANK(F${rowNum}),VALUE(F${rowNum})=0),"",(VALUE(F${rowNum})+VALUE(G${rowNum}))*0.82*1400),"")`;
        settlementCell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };

        // L열: 최종순이익(KRW) = 정산액(KRW) - 매입가(KRW) - 미국세금(KRW) - 배송비(KRW)
        const profitCell = sheet.getCell(rowIdx, 11);
        profitCell.formula = `=IFERROR(IF(OR(ISBLANK(E${rowNum}),ISBLANK(J${rowNum}),VALUE(E${rowNum})=0,VALUE(J${rowNum})=0),"",VALUE(J${rowNum})-VALUE(E${rowNum})-VALUE(I${rowNum})-VALUE(K${rowNum})),"")`;
        profitCell.numberFormat = { type: 'NUMBER', pattern: '#,##0' };

        // M열: 마진율(%) = 최종순이익(KRW) / 정산액(KRW) * 100
        const marginCell = sheet.getCell(rowIdx, 12);
        marginCell.formula = `=IFERROR(IF(OR(ISBLANK(J${rowNum}),ISBLANK(L${rowNum}),VALUE(J${rowNum})=0),"",VALUE(L${rowNum})/VALUE(J${rowNum})*100),"")`;
        marginCell.numberFormat = { type: 'NUMBER', pattern: '0.00' };

        processedRows++;
      }

      await sheet.saveUpdatedCells();
    }

    console.log('\n✅ 수식 적용 완료!\n');
    console.log('📊 최종 결과:');
    console.log(`   마지막 행 번호: ${lastDataRow + 1}행 (엑셀 기준)`);
    console.log(`   총 수식 적용 행 수: ${processedRows}개`);
    console.log(`   적용된 수식 컬럼: H, I, J, L, M (총 5개 컬럼)`);
    console.log(`   총 수식 셀 개수: ${processedRows * 5}개`);

    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

applyAllFormulas();
