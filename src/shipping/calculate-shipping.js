require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 배송비 자동 계산
 */

// 무게 구간 찾기 (선형 보간)
function findRate(rates, weightG) {
  // 정렬된 요율표에서 해당 무게에 맞는 요금 찾기
  const sorted = rates.sort((a, b) => a['Weight(g)'] - b['Weight(g)']);

  // 정확히 일치하는 무게
  const exact = sorted.find(r => r['Weight(g)'] === weightG);
  if (exact) return exact['Rate(KRW)'];

  // 무게가 최소값보다 작으면 최소 요금
  if (weightG <= sorted[0]['Weight(g)']) {
    return sorted[0]['Rate(KRW)'];
  }

  // 무게가 최대값보다 크면 최대 요금
  if (weightG >= sorted[sorted.length - 1]['Weight(g)']) {
    return sorted[sorted.length - 1]['Rate(KRW)'];
  }

  // 구간 찾아서 선형 보간
  for (let i = 0; i < sorted.length - 1; i++) {
    const lower = sorted[i];
    const upper = sorted[i + 1];

    if (weightG > lower['Weight(g)'] && weightG <= upper['Weight(g)']) {
      // 선형 보간
      const ratio = (weightG - lower['Weight(g)']) / (upper['Weight(g)'] - lower['Weight(g)']);
      return Math.round(lower['Rate(KRW)'] + ratio * (upper['Rate(KRW)'] - lower['Rate(KRW)']));
    }
  }

  return null;
}

async function calculateShipping() {
  console.log('=== 배송비 자동 계산 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    // 1. Shipping Calculator 시트에서 입력값 읽기
    const calcSheet = doc.sheetsByTitle['Shipping Calculator'];
    if (!calcSheet) {
      console.error('❌ "Shipping Calculator" 시트를 찾을 수 없습니다!');
      return;
    }

    await calcSheet.loadCells('B4:B5');
    const weightG = calcSheet.getCell(3, 1).value;
    const country = calcSheet.getCell(4, 1).value || 'US';

    if (!weightG) {
      console.error('❌ B4 셀에 무게(g)를 입력해주세요!');
      return;
    }

    console.log(`📦 입력 정보:`);
    console.log(`   무게: ${weightG}g`);
    console.log(`   국가: ${country}\n`);

    // 2. Shipping Rates 시트에서 요율 데이터 읽기
    const ratesSheet = doc.sheetsByTitle['Shipping Rates'];
    if (!ratesSheet) {
      console.error('❌ "Shipping Rates" 시트를 찾을 수 없습니다!');
      return;
    }

    const rows = await ratesSheet.getRows();
    console.log(`📊 ${rows.length}개 요율 데이터 로드 완료\n`);

    // 3. 각 배송사별 요금 계산
    console.log('💰 배송비 계산 중...\n');

    const results = {};

    // YunExpress
    const yunexpressRates = rows.filter(r => r.get('Carrier') === 'YunExpress' && r.get('Country') === country);
    const yunexpressData = yunexpressRates.map(r => ({
      'Weight(g)': parseFloat(r.get('Weight(g)')),
      'Rate(KRW)': parseFloat(r.get('Rate(KRW)'))
    }));
    results.YunExpress = findRate(yunexpressData, parseFloat(weightG));

    // K-Packet (2kg 제한)
    const kpacketRates = rows.filter(r => r.get('Carrier') === 'K-Packet' && r.get('Country') === country);
    const kpacketData = kpacketRates.map(r => ({
      'Weight(g)': parseFloat(r.get('Weight(g)')),
      'Rate(KRW)': parseFloat(r.get('Rate(KRW)'))
    }));
    if (weightG <= 2000) {
      results['K-Packet'] = findRate(kpacketData, parseFloat(weightG));
    } else {
      results['K-Packet'] = null; // 2kg 초과
    }

    // SHIPTER
    const shipterRates = rows.filter(r => r.get('Carrier') === 'SHIPTER' && r.get('Country') === country);
    const shipterData = shipterRates.map(r => ({
      'Weight(g)': parseFloat(r.get('Weight(g)')),
      'Rate(KRW)': parseFloat(r.get('Rate(KRW)'))
    }));
    results.SHIPTER = findRate(shipterData, parseFloat(weightG));

    // FedEx West
    const fedexWestRates = rows.filter(r => r.get('Carrier') === 'FedEx' && r.get('Country') === 'US-West');
    const fedexWestData = fedexWestRates.map(r => ({
      'Weight(g)': parseFloat(r.get('Weight(g)')),
      'Rate(KRW)': parseFloat(r.get('Rate(KRW)'))
    }));
    results['FedEx (West)'] = findRate(fedexWestData, parseFloat(weightG));

    // FedEx Other
    const fedexOtherRates = rows.filter(r => r.get('Carrier') === 'FedEx' && r.get('Country') === 'US-Other');
    const fedexOtherData = fedexOtherRates.map(r => ({
      'Weight(g)': parseFloat(r.get('Weight(g)')),
      'Rate(KRW)': parseFloat(r.get('Rate(KRW)'))
    }));
    results['FedEx (Other)'] = findRate(fedexOtherData, parseFloat(weightG));

    // 4. 최저가 찾기
    const validResults = Object.entries(results).filter(([k, v]) => v !== null);
    const cheapest = validResults.reduce((min, [carrier, rate]) =>
      rate < min.rate ? { carrier, rate } : min
    , { carrier: '', rate: Infinity });

    console.log('📊 계산 결과:\n');
    Object.entries(results).forEach(([carrier, rate]) => {
      if (rate !== null) {
        const badge = carrier === cheapest.carrier ? '⭐' : '  ';
        console.log(`   ${badge} ${carrier.padEnd(20)} ${rate.toLocaleString()} KRW`);
      } else {
        console.log(`   ❌ ${carrier.padEnd(20)} 배송 불가 (2kg 초과)`);
      }
    });

    console.log(`\n   🏆 최저가: ${cheapest.carrier} - ${cheapest.rate.toLocaleString()} KRW\n`);

    // 5. 결과를 시트에 기록
    console.log('💾 결과 저장 중...\n');
    await calcSheet.loadCells('B8:C14');

    const carriers = ['YunExpress', 'K-Packet', 'SHIPTER', 'FedEx (West)', 'FedEx (Other)'];
    carriers.forEach((carrier, idx) => {
      const rate = results[carrier];
      calcSheet.getCell(8 + idx, 1).value = rate !== null ? rate : '배송 불가';
      calcSheet.getCell(8 + idx, 2).value = rate !== null && carrier === cheapest.carrier ? '⭐ 최저가' : '';
    });

    // 최저가 행
    calcSheet.getCell(13, 1).value = cheapest.rate;
    calcSheet.getCell(13, 2).value = cheapest.carrier;

    await calcSheet.saveUpdatedCells();

    console.log('='.repeat(60));
    console.log('✅ 배송비 계산 완료!');
    console.log('='.repeat(60));
    console.log(`🔗 결과 확인: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

calculateShipping();
