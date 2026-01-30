require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * Dashboard 안전 업데이트
 * - 기존 매입가, 무게(kg) 데이터 보존
 * - 칼럼명 변경
 * - Shopify 데이터 통합
 * - 수수료 로직 차별화
 * - 배송비 재계산
 */

async function updateDashboardSafe() {
  console.log('=== Dashboard 안전 업데이트 시작 ===\n');
  console.log('⚠️  주의: 기존 매입가와 무게(kg) 데이터는 보존됩니다.\n');

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
    if (!dashboard) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    console.log(`📊 시트: ${dashboard.title}\n`);

    // 1. 현재 헤더 확인
    console.log('📋 1단계: 현재 헤더 확인 중...\n');
    await dashboard.loadCells('A3:Y3');

    const headers = {};
    for (let col = 0; col < 25; col++) {  // 25 columns (A-Y)
      const cell = dashboard.getCell(2, col);
      const value = cell.value;
      if (value) {
        headers[value] = col;
        console.log(`   ${String.fromCharCode(65 + col)}: ${value}`);
      }
    }

    // 2. 칼럼명 변경
    console.log('\n📝 2단계: 칼럼명 변경 중...\n');

    const renames = {
      'eBay가격(USD)': '판매가(USD)',
      'eBay배송비(USD)': '국제 배송비(USD)',
      'eBay수수료(USD)': '플랫폼 수수료(USD)'
    };

    for (const [oldName, newName] of Object.entries(renames)) {
      if (headers[oldName] !== undefined) {
        const col = headers[oldName];
        dashboard.getCell(2, col).value = newName;
        console.log(`   ✅ ${oldName} → ${newName} (${String.fromCharCode(65 + col)}열)`);
      } else {
        console.log(`   ⚠️  ${oldName} 열을 찾을 수 없습니다`);
      }
    }

    await dashboard.saveUpdatedCells();

    // 3. 헤더 리로드
    await dashboard.loadCells('A3:Y3');
    const newHeaders = {};
    for (let col = 0; col < 25; col++) {  // 25 columns (A-Y)
      const cell = dashboard.getCell(2, col);
      const value = cell.value;
      if (value) {
        newHeaders[value] = col;
      }
    }

    console.log('\n📊 3단계: Shopify 데이터 통합 준비 중...\n');

    // Shopify 시트 로드
    const shopifySheet = doc.sheetsByTitle['Shopify'];
    if (!shopifySheet) {
      console.error('❌ "Shopify" 시트를 찾을 수 없습니다!');
      return;
    }

    const shopifyRows = await shopifySheet.getRows();
    console.log(`   Shopify 상품: ${shopifyRows.length}개\n`);

    // Shopify 데이터를 SKU 맵으로 변환
    const shopifyMap = new Map();
    shopifyRows.forEach(row => {
      const sku = row.get('SKU');
      if (sku) {
        shopifyMap.set(sku, {
          price: parseFloat(row.get('Price')) || 0,
          weight: parseFloat(row.get('Weight (kg)')) || 0
        });
      }
    });

    console.log(`   Shopify 맵: ${shopifyMap.size}개 SKU\n`);

    // 4. 배송비 요율표 로드
    console.log('📦 4단계: 배송비 요율표 로드 중...\n');

    const ratesSheet = doc.sheetsByTitle['Shipping Rates'];
    if (!ratesSheet) {
      console.error('❌ "Shipping Rates" 시트를 찾을 수 없습니다!');
      return;
    }

    const ratesRows = await ratesSheet.getRows();
    console.log(`   배송비 요율: ${ratesRows.length}개\n`);

    // 배송사별 요율 맵 생성
    const shippingRates = {
      'YunExpress': [],
      'K-Packet': [],
      'SHIPTER': [],
      'FedEx-West': [],
      'FedEx-Other': []
    };

    ratesRows.forEach(row => {
      const carrier = row.get('Carrier');
      const country = row.get('Country');
      const weightG = parseFloat(row.get('Weight(g)'));
      const rate = parseFloat(row.get('Rate(KRW)'));

      if (carrier === 'YunExpress' && country === 'US') {
        shippingRates['YunExpress'].push({ weight: weightG, rate });
      } else if (carrier === 'K-Packet' && country === 'US') {
        shippingRates['K-Packet'].push({ weight: weightG, rate });
      } else if (carrier === 'SHIPTER' && country === 'US') {
        shippingRates['SHIPTER'].push({ weight: weightG, rate });
      } else if (carrier === 'FedEx' && country === 'US-West') {
        shippingRates['FedEx-West'].push({ weight: weightG, rate });
      } else if (carrier === 'FedEx' && country === 'US-Other') {
        shippingRates['FedEx-Other'].push({ weight: weightG, rate });
      }
    });

    console.log('✅ 준비 완료!\n');
    console.log('='.repeat(60));
    console.log('📊 업데이트 요약');
    console.log('='.repeat(60));
    console.log(`\n✅ 칼럼명 변경: 3개`);
    console.log(`   - eBay가격(USD) → 판매가(USD)`);
    console.log(`   - eBay배송비(USD) → 국제 배송비(USD)`);
    console.log(`   - eBay수수료(USD) → 플랫폼 수수료(USD)`);
    console.log(`\n✅ Shopify 데이터: ${shopifyMap.size}개 SKU 준비됨`);
    console.log(`✅ 배송비 요율표: ${ratesRows.length}개 로드됨`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n💡 다음 단계:');
    console.log('   1. apply-shopify-data.js - Shopify 데이터 통합');
    console.log('   2. update-fee-formulas.js - 수수료 로직 업데이트');
    console.log('   3. recalculate-shipping.js - 배송비 재계산');
    console.log('\n🎉 1단계 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

updateDashboardSafe();
