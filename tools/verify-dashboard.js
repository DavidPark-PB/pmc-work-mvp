require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * Dashboard 검수 스크립트
 * - 변수칸 확인
 * - 헤더 확인
 * - 데이터 행 수 확인
 * - 수식 적용 여부 확인
 * - 샘플 데이터 계산 검증
 */

async function verifyDashboard() {
  console.log('=== Dashboard 검수 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
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

    // 1. 변수칸 확인 (A1~E2)
    console.log('1️⃣ 변수칸 확인');
    await sheet.loadCells('A1:E2');

    const progressCell = sheet.getCell(0, 0).value;
    const shippingLabel = sheet.getCell(1, 0).value;
    const shippingValue = sheet.getCell(1, 1).value;
    const exchangeLabel = sheet.getCell(1, 3).value;
    const exchangeValue = sheet.getCell(1, 4).value;

    console.log(`   진행 상태: ${progressCell}`);
    console.log(`   ${shippingLabel} ${shippingValue}`);
    console.log(`   ${exchangeLabel} ${exchangeValue}`);

    const isCompleted = progressCell === 'COMPLETED';
    const correctShipping = shippingValue === 15000;
    const correctExchange = exchangeValue === 1400;

    if (isCompleted && correctShipping && correctExchange) {
      console.log('   ✅ 변수칸 정상\n');
    } else {
      console.log('   ⚠️  변수칸 이상:');
      if (!isCompleted) console.log(`      - 진행상태: ${progressCell} (예상: COMPLETED)`);
      if (!correctShipping) console.log(`      - 배송비: ${shippingValue} (예상: 15000)`);
      if (!correctExchange) console.log(`      - 환율: ${exchangeValue} (예상: 1400)`);
      console.log('');
    }

    // 2. 헤더 확인 (3행)
    console.log('2️⃣ 헤더 확인');
    await sheet.loadCells('A3:U3');

    const expectedHeaders = [
      'SKU', 'Product Title', 'Vendor', 'eBay Item ID',
      '매입가(KRW)', 'eBay가격(USD)', 'eBay배송비(USD)',
      'eBay수수료(USD)', '미국세금(KRW)', '정산액(KRW)',
      '배송비(KRW)', '최종순이익(KRW)', '마진율(%)',
      '무게(kg)', 'eBay판매량', 'eBay재고', 'Shopify재고',
      'eBay상태', 'Shopify상태', '플랫폼',
      'Last Updated'
    ];

    let headerCorrect = true;
    for (let col = 0; col < expectedHeaders.length; col++) {
      const actualHeader = sheet.getCell(2, col).value;
      if (actualHeader !== expectedHeaders[col]) {
        console.log(`   ⚠️  ${String.fromCharCode(65 + col)}3: "${actualHeader}" (예상: "${expectedHeaders[col]}")`);
        headerCorrect = false;
      }
    }

    if (headerCorrect) {
      console.log('   ✅ 헤더 정상\n');
    } else {
      console.log('');
    }

    // 3. 데이터 행 수 확인
    console.log('3️⃣ 데이터 행 수 확인');
    await sheet.loadCells('A1:A5000');

    let lastDataRow = 3;
    for (let row = 3; row < 5000; row++) {
      const cell = sheet.getCell(row, 0);
      if (cell.value) {
        lastDataRow = row;
      }
    }

    const totalDataRows = lastDataRow - 2;
    console.log(`   마지막 데이터 행: ${lastDataRow + 1}행 (엑셀 기준)`);
    console.log(`   총 데이터 행 수: ${totalDataRows}개`);

    if (totalDataRows === 3993) {
      console.log('   ✅ 데이터 행 수 정상 (3,993개)\n');
    } else {
      console.log(`   ⚠️  예상과 다름 (예상: 3,993개, 실제: ${totalDataRows}개)\n`);
    }

    // 4. 수식 적용 확인 (샘플)
    console.log('4️⃣ 수식 적용 확인 (샘플 체크)');
    const sampleRows = [4, 100, 500, 1000, 2000, 3000, lastDataRow];

    for (const rowNum of sampleRows) {
      if (rowNum > lastDataRow + 1) continue;

      const rowIdx = rowNum - 1;
      await sheet.loadCells(`A${rowNum}:M${rowNum}`);

      const sku = sheet.getCell(rowIdx, 0).value;
      const feeFormula = sheet.getCell(rowIdx, 7).formula;
      const taxFormula = sheet.getCell(rowIdx, 8).formula;
      const settlementFormula = sheet.getCell(rowIdx, 9).formula;
      const profitFormula = sheet.getCell(rowIdx, 11).formula;
      const marginFormula = sheet.getCell(rowIdx, 12).formula;

      const hasAllFormulas = feeFormula && taxFormula && settlementFormula && profitFormula && marginFormula;

      if (hasAllFormulas) {
        console.log(`   ✅ ${rowNum}행 (${sku}): 수식 정상`);
      } else {
        console.log(`   ⚠️  ${rowNum}행 (${sku}): 수식 누락`);
        if (!feeFormula) console.log('      - H열 (수수료) 수식 없음');
        if (!taxFormula) console.log('      - I열 (세금) 수식 없음');
        if (!settlementFormula) console.log('      - J열 (정산액) 수식 없음');
        if (!profitFormula) console.log('      - L열 (순이익) 수식 없음');
        if (!marginFormula) console.log('      - M열 (마진율) 수식 없음');
      }
    }
    console.log('');

    // 5. 실제 계산 검증 (양쪽 플랫폼 데이터 3개)
    console.log('5️⃣ 실제 계산 검증 ("양쪽" 플랫폼 샘플 3개)');
    let verifiedCount = 0;

    for (let batchStart = 0; batchStart < 4000 && verifiedCount < 3; batchStart += 500) {
      const batchEnd = Math.min(batchStart + 500, lastDataRow - 2);
      const rowStart = batchStart + 4;
      const rowEnd = batchStart + batchEnd + 3;

      await sheet.loadCells(`A${rowStart}:U${rowEnd}`);

      for (let row = batchStart; row < batchEnd && verifiedCount < 3; row++) {
        const rowIdx = row + 3;
        const rowNum = rowIdx + 1;
        const platform = sheet.getCell(rowIdx, 19).value;

        if (platform === '양쪽') {
          const sku = sheet.getCell(rowIdx, 0).value;
          const title = sheet.getCell(rowIdx, 1).value;
          const costKRW = parseFloat(sheet.getCell(rowIdx, 4).value) || 0;
          const ebayPrice = parseFloat(sheet.getCell(rowIdx, 5).value) || 0;
          const ebayShipping = parseFloat(sheet.getCell(rowIdx, 6).value) || 0;
          const ebayFee = parseFloat(sheet.getCell(rowIdx, 7).value) || 0;
          const usTax = parseFloat(sheet.getCell(rowIdx, 8).value) || 0;
          const settlement = parseFloat(sheet.getCell(rowIdx, 9).value) || 0;
          const shipping = parseFloat(sheet.getCell(rowIdx, 10).value) || 0;
          const profit = parseFloat(sheet.getCell(rowIdx, 11).value) || 0;
          const margin = parseFloat(sheet.getCell(rowIdx, 12).value) || 0;

          verifiedCount++;
          console.log(`\n   샘플 ${verifiedCount}: ${rowNum}행 - ${sku}`);
          console.log(`   제목: ${title?.substring(0, 50)}...`);

          if (ebayPrice > 0 && costKRW > 0) {
            const expectedFee = (ebayPrice + ebayShipping) * 0.18;
            const expectedTax = costKRW * 0.15;
            const expectedSettlement = (ebayPrice + ebayShipping) * 0.82 * 1400;
            const expectedProfit = expectedSettlement - costKRW - expectedTax - 15000;
            const expectedMargin = expectedSettlement > 0 ? (expectedProfit / expectedSettlement * 100) : 0;

            console.log(`   입력값: 매입가=${costKRW.toFixed(0)} KRW, eBay가격=${ebayPrice.toFixed(2)} USD, 배송비=${ebayShipping.toFixed(2)} USD`);
            console.log(`   수수료: 실제=${ebayFee.toFixed(2)}, 예상=${expectedFee.toFixed(2)} → ${Math.abs(ebayFee - expectedFee) < 0.01 ? '✅' : '⚠️'}`);
            console.log(`   미국세금: 실제=${usTax.toFixed(0)}, 예상=${expectedTax.toFixed(0)} → ${Math.abs(usTax - expectedTax) < 1 ? '✅' : '⚠️'}`);
            console.log(`   정산액: 실제=${settlement.toFixed(0)}, 예상=${expectedSettlement.toFixed(0)} → ${Math.abs(settlement - expectedSettlement) < 1 ? '✅' : '⚠️'}`);
            console.log(`   순이익: 실제=${profit.toFixed(0)}, 예상=${expectedProfit.toFixed(0)} → ${Math.abs(profit - expectedProfit) < 1 ? '✅' : '⚠️'}`);
            console.log(`   마진율: 실제=${margin.toFixed(2)}%, 예상=${expectedMargin.toFixed(2)}% → ${Math.abs(margin - expectedMargin) < 0.01 ? '✅' : '⚠️'}`);
          } else {
            console.log(`   ⚠️  데이터 부족 (매입가 또는 eBay가격 없음)`);
          }
        }
      }
    }

    if (verifiedCount === 0) {
      console.log('   ⚠️  "양쪽" 플랫폼 데이터를 찾을 수 없습니다.');
    }

    console.log('\n');
    console.log('='.repeat(60));
    console.log('✅ Dashboard 검수 완료!');
    console.log('='.repeat(60));
    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}\n`);

  } catch (error) {
    console.error('\n❌ 검수 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

verifyDashboard();
