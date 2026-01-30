const GoogleSheetsAPI = require('./googleSheetsAPI');

const SPREADSHEET_ID = '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

async function verifyCalculation() {
  const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

  try {
    await sheetsAPI.authenticate();

    console.log('\n=== PMC 마진 계산 검증 ===\n');

    // 데이터 읽기
    const data = await sheetsAPI.readData(SPREADSHEET_ID, '시트1!A2:I2');

    if (data.length === 0) {
      console.log('❌ 데이터가 없습니다.');
      return;
    }

    const [sku, name, purchasePrice, salePrice, exchangeRate, feePercent, shippingCost, profit, margin] = data[0];

    console.log('📦 상품 정보:');
    console.log(`   SKU: ${sku}`);
    console.log(`   상품명: ${name}`);
    console.log('');

    console.log('💰 비용 구조:');
    console.log(`   매입가: ${Number(purchasePrice).toLocaleString()} KRW`);
    console.log(`   배송비: ${Number(shippingCost).toLocaleString()} KRW`);
    console.log(`   총 비용: ${(Number(purchasePrice) + Number(shippingCost)).toLocaleString()} KRW`);
    console.log('');

    console.log('💵 판매 정보:');
    console.log(`   Shopify 판매가: $${salePrice}`);
    console.log(`   환율: ${Number(exchangeRate).toLocaleString()} KRW/$`);
    console.log(`   수수료: ${feePercent}%`);
    console.log('');

    // 수동 계산으로 검증
    const revenue = Number(salePrice) * Number(exchangeRate);
    const feeAmount = revenue * (Number(feePercent) / 100);
    const netRevenue = revenue - feeAmount;
    const totalCost = Number(purchasePrice) + Number(shippingCost);
    const calculatedProfit = netRevenue - totalCost;
    const calculatedMargin = (calculatedProfit / revenue) * 100;

    console.log('🧮 계산 과정:');
    console.log(`   1. 매출액 = $${salePrice} × ${exchangeRate} = ${revenue.toLocaleString()} KRW`);
    console.log(`   2. 수수료 = ${revenue.toLocaleString()} × ${feePercent}% = ${feeAmount.toLocaleString()} KRW`);
    console.log(`   3. 순매출 = ${revenue.toLocaleString()} - ${feeAmount.toLocaleString()} = ${netRevenue.toLocaleString()} KRW`);
    console.log(`   4. 순이익 = ${netRevenue.toLocaleString()} - ${totalCost.toLocaleString()} = ${calculatedProfit.toLocaleString()} KRW`);
    console.log(`   5. 마진율 = (${calculatedProfit.toLocaleString()} / ${revenue.toLocaleString()}) × 100 = ${calculatedMargin.toFixed(2)}%`);
    console.log('');

    console.log('✅ 스프레드시트 계산 결과:');
    console.log(`   순이익: ${Number(profit).toLocaleString()} KRW`);
    console.log(`   마진율: ${Number(margin).toFixed(2)}%`);
    console.log('');

    // 검증
    const profitMatch = Math.abs(Number(profit) - calculatedProfit) < 1;
    const marginMatch = Math.abs(Number(margin) - calculatedMargin) < 0.01;

    if (profitMatch && marginMatch) {
      console.log('✅ 계산 검증 성공! 수식이 정확합니다.');
    } else {
      console.log('❌ 계산 불일치 발견:');
      if (!profitMatch) {
        console.log(`   순이익: 예상 ${calculatedProfit.toLocaleString()}, 실제 ${Number(profit).toLocaleString()}`);
      }
      if (!marginMatch) {
        console.log(`   마진율: 예상 ${calculatedMargin.toFixed(2)}%, 실제 ${Number(margin).toFixed(2)}%`);
      }
    }

    console.log('');
    console.log('📊 손익 분석:');
    if (calculatedProfit > 0) {
      console.log(`   ✅ 이익: ${calculatedProfit.toLocaleString()} KRW (마진율 ${calculatedMargin.toFixed(2)}%)`);
    } else if (calculatedProfit === 0) {
      console.log(`   ⚠️  본전`);
    } else {
      console.log(`   ❌ 손실: ${Math.abs(calculatedProfit).toLocaleString()} KRW`);
    }

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

verifyCalculation();
