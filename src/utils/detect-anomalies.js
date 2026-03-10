require('../config');
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * 이상 징후 감지 로직
 * 1. 판매 급감 (최근 7일 판매량 < 직전 3주 평균의 30%)
 * 2. 재고 부족 (현재고 < 최근 30일 평균 판매량 × 14일)
 * 3. 마진 위험 (마진율 < 5%)
 */
async function detectAnomalies() {
  console.log('\n=== 이상 징후 감지 시스템 ===\n');

  try {
    const sheets = new GoogleSheetsAPI();
    await sheets.authenticate();

    // 전체 데이터 읽기 (L, M, N열 추가: 재고, 최근7일판매, 직전3주평균)
    console.log('1. 상품 데이터 읽기 중...');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:N');
    console.log(`   총 ${data.length}개 상품 로드됨\n`);

    // 이상 징후 분류
    const anomalies = {
      salesDrop: [],      // 판매 급감
      lowStock: [],       // 재고 부족
      lowMargin: [],      // 마진 위험
      multipleIssues: []  // 복합 문제
    };

    console.log('2. 이상 징후 분석 중...\n');

    data.forEach((row, index) => {
      const rowNum = index + 2;
      const [sku, name, purchase, price, rate, fee, shipping, profit, margin, status, platform, stock, recent7days, prev3weeks] = row;

      const issues = [];

      // 마진율 체크 (가장 중요)
      const marginValue = parseFloat(margin);
      if (!isNaN(marginValue) && marginValue < 5 && marginValue > 0) {
        issues.push('마진위험');
        anomalies.lowMargin.push({
          rowNum,
          sku,
          name,
          margin: marginValue,
          platform,
          issue: `마진율 ${marginValue.toFixed(2)}%`
        });
      }

      // 재고 부족 체크 (재고 데이터가 있는 경우)
      const stockValue = parseFloat(stock);
      const recent7daysValue = parseFloat(recent7days);
      if (!isNaN(stockValue) && !isNaN(recent7daysValue) && recent7daysValue > 0) {
        const dailyAvg = recent7daysValue / 7;
        const safeStock = dailyAvg * 14; // 14일치 재고

        if (stockValue < safeStock && stockValue >= 0) {
          issues.push('재고부족');
          anomalies.lowStock.push({
            rowNum,
            sku,
            name,
            stock: stockValue,
            safeStock: safeStock.toFixed(1),
            platform,
            issue: `재고 ${stockValue}개 (안전재고 ${safeStock.toFixed(1)}개)`
          });
        }
      }

      // 판매 급감 체크
      const recent7daysVal = parseFloat(recent7days);
      const prev3weeksVal = parseFloat(prev3weeks);
      if (!isNaN(recent7daysVal) && !isNaN(prev3weeksVal) && prev3weeksVal > 0) {
        const threshold = prev3weeksVal * 0.3;

        if (recent7daysVal < threshold) {
          issues.push('판매급감');
          anomalies.salesDrop.push({
            rowNum,
            sku,
            name,
            recent7days: recent7daysVal,
            prev3weeks: prev3weeksVal,
            platform,
            issue: `7일: ${recent7daysVal}개 vs 3주평균: ${prev3weeksVal}개`
          });
        }
      }

      // 복합 문제 (2개 이상 이슈)
      if (issues.length >= 2) {
        anomalies.multipleIssues.push({
          rowNum,
          sku,
          name,
          platform,
          issues: issues.join(', ')
        });
      }
    });

    // 결과 출력
    console.log('3. 이상 징후 감지 결과:\n');
    console.log('═'.repeat(100));

    // 마진 위험
    console.log(`\n🔴 마진 위험 (마진율 < 5%): ${anomalies.lowMargin.length}개`);
    if (anomalies.lowMargin.length > 0) {
      console.log('─'.repeat(100));
      anomalies.lowMargin.slice(0, 10).forEach((item, i) => {
        console.log(`${i + 1}. [행 ${item.rowNum}] ${item.sku} - ${item.platform}`);
        console.log(`   ${item.name}`);
        console.log(`   ${item.issue}`);
      });
      if (anomalies.lowMargin.length > 10) {
        console.log(`   ... 외 ${anomalies.lowMargin.length - 10}개 더`);
      }
    }

    // 재고 부족
    console.log(`\n⚠️  재고 부족 (안전재고 미달): ${anomalies.lowStock.length}개`);
    if (anomalies.lowStock.length > 0) {
      console.log('─'.repeat(100));
      anomalies.lowStock.slice(0, 10).forEach((item, i) => {
        console.log(`${i + 1}. [행 ${item.rowNum}] ${item.sku} - ${item.platform}`);
        console.log(`   ${item.name}`);
        console.log(`   ${item.issue}`);
      });
      if (anomalies.lowStock.length > 10) {
        console.log(`   ... 외 ${anomalies.lowStock.length - 10}개 더`);
      }
    }

    // 판매 급감
    console.log(`\n📉 판매 급감 (3주 대비 70% 감소): ${anomalies.salesDrop.length}개`);
    if (anomalies.salesDrop.length > 0) {
      console.log('─'.repeat(100));
      anomalies.salesDrop.slice(0, 10).forEach((item, i) => {
        console.log(`${i + 1}. [행 ${item.rowNum}] ${item.sku} - ${item.platform}`);
        console.log(`   ${item.name}`);
        console.log(`   ${item.issue}`);
      });
      if (anomalies.salesDrop.length > 10) {
        console.log(`   ... 외 ${anomalies.salesDrop.length - 10}개 더`);
      }
    }

    // 복합 문제
    console.log(`\n🚨 복합 문제 (2개 이상): ${anomalies.multipleIssues.length}개`);
    if (anomalies.multipleIssues.length > 0) {
      console.log('─'.repeat(100));
      anomalies.multipleIssues.slice(0, 10).forEach((item, i) => {
        console.log(`${i + 1}. [행 ${item.rowNum}] ${item.sku} - ${item.platform}`);
        console.log(`   ${item.name}`);
        console.log(`   문제: ${item.issues}`);
      });
      if (anomalies.multipleIssues.length > 10) {
        console.log(`   ... 외 ${anomalies.multipleIssues.length - 10}개 더`);
      }
    }

    console.log('\n═'.repeat(100));
    console.log('\n📊 요약:');
    console.log(`   - 마진 위험: ${anomalies.lowMargin.length}개`);
    console.log(`   - 재고 부족: ${anomalies.lowStock.length}개`);
    console.log(`   - 판매 급감: ${anomalies.salesDrop.length}개`);
    console.log(`   - 복합 문제: ${anomalies.multipleIssues.length}개`);
    console.log(`   - 총 이상 징후: ${anomalies.lowMargin.length + anomalies.lowStock.length + anomalies.salesDrop.length}개`);

    // JSON 파일로 저장 (대시보드에서 사용)
    const fs = require('fs');
    fs.writeFileSync(
      'anomalies-report.json',
      JSON.stringify(anomalies, null, 2)
    );

    console.log('\n✅ 이상 징후 리포트 저장됨: anomalies-report.json');
    console.log(`\n🔗 스프레드시트:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

    console.log('\n💡 다음 단계:');
    console.log('   1. 재고, 판매량 데이터를 L, M, N열에 입력하세요');
    console.log('   2. 이 스크립트를 정기적으로 실행하여 모니터링');
    console.log('   3. 대시보드에서 이상 징후 상품만 필터링');

    return anomalies;

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

// 실행
if (require.main === module) {
  detectAnomalies();
}

module.exports = detectAnomalies;
