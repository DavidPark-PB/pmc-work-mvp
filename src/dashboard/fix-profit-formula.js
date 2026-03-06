const { CREDENTIALS_PATH } = require('../config');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 30% 고정 마진율 수식 교정 - $3.9 배송비 고정
 *
 * 현재 칼럼 구조 (최종 Dashboard):
 * A: Image
 * B: SKU
 * C: 상품명
 * D: 🔒 무게(kg) - 보호
 * E: 🔒 매입가(KRW) - 보호
 * F: 실제 배송비(KRW) - 자동 (무게 기반)
 * G: eBay 수수료(KRW) - 자동
 * H: 미국 세금 15%(KRW) - 자동
 * I: 총 원가(KRW) - 자동
 * J: eBay 가격(USD) - 자동 (30% 마진 보장)
 * K: eBay 배송비(USD) - $3.9 고정
 * L: 최종 순이익(KRW) - 자동
 * M: 마진율(%) - 자동 (항상 30%)
 *
 * === 30% 고정 마진 계산 로직 ===
 *
 * F: 실제 배송비(KRW)
 *    = Shipping Rates에서 무게 기반 조회
 *
 * G: eBay 수수료(KRW)
 *    = (J + K) × 0.15 × 1400
 *    = 최종 판매가 기준 15% 수수료
 *
 * H: 미국 세금 15%(KRW)
 *    = (E + F + G) × 0.15
 *
 * I: 총 원가(KRW)
 *    = E + F + G + H
 *
 * K: eBay 배송비(USD)
 *    = 3.9 (고정)
 *
 * J: eBay 가격(USD) - 30% 마진 보장 판매가
 *    = ((I / 0.7) / 1400) - 3.9
 *    → 총매출 = I / 0.7 (30% 마진 확보)
 *    → USD 변환 = 총매출 / 1400
 *    → 판매가 = USD - 3.9 (배송비 제외)
 *
 * L: 최종 순이익(KRW)
 *    = ((J + 3.9) × 1400) - I
 *    = 총매출 - 총원가
 *
 * M: 마진율(%)
 *    = L / ((J + 3.9) × 1400) × 100
 *    = 순이익 / 총매출 × 100 = 30%
 */

const EXCHANGE_RATE = 1400;

async function fixProfitFormula() {
  console.log('='.repeat(70));
  console.log('📊 30% 고정 마진율 수식 적용 - $3.9 배송비 고정');
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
      console.log('❌ "최종 Dashboard" 시트를 찾을 수 없습니다.');
      return;
    }

    console.log(`📁 시트: ${dashboard.title}\n`);

    // 30% 고정 마진 수식 (순환 참조 방지)
    //
    // 핵심 공식:
    // - K = 3.9 (고정)
    // - J = ((I / 0.7) / 1400) - 3.9  → 30% 마진 보장 판매가
    // - L = ((J + 3.9) × 1400) - I   → 순이익
    // - M = L / ((J + 3.9) × 1400) × 100 = 30%
    //
    // 순환 참조 해결:
    // G(수수료)가 J에 의존하고, I가 G에 의존하고, J가 I에 의존 → 순환!
    // 해결: 30% 마진 기준으로 수수료를 역산
    // 총매출 = I / 0.7, eBay 수수료 = 총매출 × 15% = I / 0.7 × 0.15

    const formulas = {
      // F열: 실제 배송비 (무게 기반)
      shipping: (row) => `=IFERROR(INDEX('Shipping Rates'!$D:$D,MATCH(1,('Shipping Rates'!$A:$A="YunExpress")*('Shipping Rates'!$B:$B="US")*('Shipping Rates'!$C:$C>=D${row}*1000),0)),IF(D${row}>0,15000,0))`,

      // G열: eBay 수수료(KRW) = 총매출 × 15% = (기초원가 / 0.7) × 0.15
      // 기초원가 = E + F (매입가 + 배송비)
      // 30% 마진 기준 총매출 = 기초원가 / 0.7
      ebayFee: (row) => `=IFERROR(IF(OR(E${row}="품절",E${row}=""),0,ROUND((E${row}+F${row})/0.7*0.15,0)),0)`,

      // H열: 미국 세금 15% = (매입가 + 배송비 + 수수료) × 15%
      usTax: (row) => `=IFERROR(IF(OR(E${row}="품절",E${row}=""),0,ROUND((E${row}+F${row}+G${row})*0.15,0)),0)`,

      // I열: 총 원가 = 매입가 + 배송비 + 수수료 + 세금
      totalCost: (row) => `=IFERROR(IF(OR(E${row}="품절",E${row}=""),0,E${row}+F${row}+G${row}+H${row}),0)`,

      // J열: eBay 가격 USD = ((I / 0.7) / 1400) - 3.9
      // 30% 마진 보장 판매가
      ebayPrice: (row) => `=IFERROR(IF(I${row}=0,0,ROUND((I${row}/0.7)/1400-3.9,2)),0)`,

      // K열: eBay 배송비 = $3.9 고정
      ebayShipping: (row) => `3.9`,

      // L열: 최종 순이익 = ((J + 3.9) × 1400) - I
      profit: (row) => `=IFERROR(IF(I${row}=0,0,(J${row}+3.9)*1400-I${row}),0)`,

      // M열: 마진율 = L / ((J + 3.9) × 1400) × 100 = 30%
      margin: (row) => `=IFERROR(IF(I${row}=0,0,ROUND(L${row}/((J${row}+3.9)*1400)*100,1)),0)`,

      // U열: 정렬순위 (품절=2, 판매가능=1)
      sortPriority: (row) => `=IF(OR(E${row}="품절",E${row}="재고부족",E${row}="재고 부족",E${row}=0),2,1)`
    };

    console.log('📐 30% 고정 마진 수식:\n');
    console.log('   F: 실제 배송비 = Shipping Rates에서 무게 기반 조회');
    console.log('   G: eBay 수수료 = (매입가+배송비)/0.7 × 15%');
    console.log('   H: 미국 세금 = (매입가 + 배송비 + 수수료) × 15%');
    console.log('   I: 총 원가 = 매입가 + 배송비 + 수수료 + 세금');
    console.log('   J: eBay 가격 = ((I/0.7)/1400) - 3.9 ← 30% 마진 보장!');
    console.log('   K: eBay 배송비 = $3.9 (고정)');
    console.log('   L: 최종순이익 = ((J+3.9)×1400) - I');
    console.log('   M: 마진율 = L / ((J+3.9)×1400) × 100 = 30%');
    console.log();

    // 수식 적용
    console.log('⚡ 수식 적용 중...\n');

    const batchSize = 300;
    const totalRows = 8704;  // 8703 데이터 + 1 헤더
    let processed = 0;

    for (let startRow = 2; startRow <= totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize - 1, totalRows);

      // F, G, H, I, J, K, L, M, U 열 로드
      await dashboard.loadCells(`F${startRow}:M${endRow}`);
      await dashboard.loadCells(`U${startRow}:U${endRow}`);

      for (let row = startRow; row <= endRow; row++) {
        const rowIndex = row - 1;  // 0-indexed

        // F열: 실제 배송비 (수식)
        dashboard.getCell(rowIndex, 5).formula = formulas.shipping(row);

        // G열: eBay 수수료 (수식)
        dashboard.getCell(rowIndex, 6).formula = formulas.ebayFee(row);

        // H열: 미국 세금 (수식)
        dashboard.getCell(rowIndex, 7).formula = formulas.usTax(row);

        // I열: 총 원가 (수식)
        dashboard.getCell(rowIndex, 8).formula = formulas.totalCost(row);

        // J열: eBay 가격 (수식) - 30% 마진 보장
        dashboard.getCell(rowIndex, 9).formula = formulas.ebayPrice(row);

        // K열: eBay 배송비 = $3.9 고정
        dashboard.getCell(rowIndex, 10).value = 3.9;

        // L열: 최종 순이익 (수식)
        dashboard.getCell(rowIndex, 11).formula = formulas.profit(row);

        // M열: 마진율 (수식) - 매출 기준 30%
        dashboard.getCell(rowIndex, 12).formula = formulas.margin(row);

        // U열: 정렬순위 (수식)
        dashboard.getCell(rowIndex, 20).formula = formulas.sortPriority(row);
      }

      await dashboard.saveUpdatedCells();
      processed = endRow;
      console.log(`   ${processed}/${totalRows} 행 완료 (${Math.round(processed/totalRows*100)}%)`);
    }

    console.log();
    console.log('='.repeat(70));
    console.log('✅ 수식 교정 완료!');
    console.log('='.repeat(70));
    console.log();

    // 결과 확인
    console.log('📊 결과 확인 (샘플 3행):\n');
    await dashboard.loadCells('D2:M4');

    for (let row = 1; row <= 3; row++) {
      const weight = dashboard.getCell(row, 3).value;      // D
      const purchase = dashboard.getCell(row, 4).value;    // E
      const shipping = dashboard.getCell(row, 5).value;    // F
      const fee = dashboard.getCell(row, 6).value;         // G
      const tax = dashboard.getCell(row, 7).value;         // H
      const totalCost = dashboard.getCell(row, 8).value;   // I
      const ebayPrice = dashboard.getCell(row, 9).value;   // J
      const ebayShipping = dashboard.getCell(row, 10).value; // K
      const profit = dashboard.getCell(row, 11).value;     // L
      const margin = dashboard.getCell(row, 12).value;     // M

      console.log(`Row ${row + 1}:`);
      console.log(`   무게: ${weight}kg, 매입가: ₩${purchase}`);
      console.log(`   배송비: ₩${shipping}, 수수료: ₩${Math.round(fee)}, 세금: ₩${Math.round(tax)}`);
      console.log(`   총원가: ₩${Math.round(totalCost)}`);
      console.log(`   eBay가격: $${ebayPrice}, eBay배송비: $${ebayShipping || '(미입력)'}`);
      console.log(`   순이익: ₩${Math.round(profit)}, 마진율: ${margin}%`);
      console.log();
    }

    console.log('💡 계산 원리:');
    console.log('   1. K열: $3.9 고정 배송비');
    console.log('   2. J열: 30% 마진 보장 판매가 = ((총원가/0.7)/1400) - 3.9');
    console.log('   3. L열: 순이익 = ((J+3.9)×1400) - 총원가');
    console.log('   4. M열: 마진율 = 순이익/총매출 = 30%');
    console.log();

    console.log('📌 예시:');
    console.log('   총원가 I = ₩30,000');
    console.log('   → 총매출 = ₩30,000 / 0.7 = ₩42,857');
    console.log('   → USD 변환 = ₩42,857 / 1400 = $30.61');
    console.log('   → J = $30.61 - $3.9 = $26.71');
    console.log('   → K = $3.9');
    console.log('   → 순이익 L = ($26.71+$3.9)×1400 - ₩30,000 = ₩12,854');
    console.log('   → 마진율 M = ₩12,854 / ₩42,854 = 30%');
    console.log();

    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);

  } catch (error) {
    console.error('\n❌ 오류:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

fixProfitFormula();
