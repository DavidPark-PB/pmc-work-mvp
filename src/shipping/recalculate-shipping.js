require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 배송비 재계산
 * - 기존 무게(kg) 값 사용
 * - YunExpress와 K-Packet 중 저렴한 것 선택
 * - K-Packet은 2kg 제한
 * - Linear interpolation 사용
 */

// 배송비 계산 함수
function findRate(rates, weightG) {
  const sorted = rates.sort((a, b) => a.weight - b.weight);

  // Exact match
  const exact = sorted.find(r => r.weight === weightG);
  if (exact) return exact.rate;

  // Out of range
  if (weightG < sorted[0].weight || weightG > sorted[sorted.length - 1].weight) {
    return null;
  }

  // Linear interpolation
  for (let i = 0; i < sorted.length - 1; i++) {
    const lower = sorted[i];
    const upper = sorted[i + 1];
    if (weightG > lower.weight && weightG <= upper.weight) {
      const ratio = (weightG - lower.weight) / (upper.weight - lower.weight);
      return Math.round(lower.rate + ratio * (upper.rate - lower.rate));
    }
  }

  return null;
}

function calculateBestShipping(weightKg, rates) {
  if (!weightKg || weightKg <= 0) return null;

  const weightG = weightKg * 1000;

  // K-Packet 체크 (2kg 제한)
  let kpacketRate = null;
  if (weightKg <= 2) {
    kpacketRate = findRate(rates.kpacket, weightG);
  }

  // YunExpress 체크
  const yunexpressRate = findRate(rates.yunexpress, weightG);

  // 둘 다 있으면 저렴한 것 선택
  if (kpacketRate && yunexpressRate) {
    return Math.min(kpacketRate, yunexpressRate);
  }

  // 하나만 있으면 그것 사용
  return kpacketRate || yunexpressRate;
}

async function recalculateShipping() {
  console.log('=== 배송비 재계산 시작 ===\n');
  console.log('⚠️  기존 무게(kg) 데이터를 사용하여 최적 배송비를 계산합니다.\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    // 1. 배송비 요율 로드
    console.log('📦 1단계: 배송비 요율 로드 중...\n');
    const ratesSheet = doc.sheetsByTitle['Shipping Rates'];
    if (!ratesSheet) {
      console.error('❌ "Shipping Rates" 시트를 찾을 수 없습니다!');
      return;
    }

    ratesSheet.headerRowIndex = 0;
    await ratesSheet.loadHeaderRow();
    const ratesRows = await ratesSheet.getRows();

    // 요율 맵 생성
    const rates = {
      yunexpress: [],
      kpacket: []
    };

    ratesRows.forEach(row => {
      const carrier = row.get('Carrier');
      const country = row.get('Country');
      const weightG = parseFloat(row.get('Weight(g)'));
      const rate = parseFloat(row.get('Rate(KRW)'));

      if (carrier === 'YunExpress' && country === 'US') {
        rates.yunexpress.push({ weight: weightG, rate });
      } else if (carrier === 'K-Packet' && country === 'US') {
        rates.kpacket.push({ weight: weightG, rate });
      }
    });

    console.log(`   YunExpress 요율: ${rates.yunexpress.length}개`);
    console.log(`   K-Packet 요율: ${rates.kpacket.length}개\n`);

    // 2. Dashboard 헤더 확인
    console.log('📋 2단계: Dashboard 헤더 확인 중...\n');
    const dashboard = doc.sheetsByTitle['최종 Dashboard'];
    if (!dashboard) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    await dashboard.loadCells('A3:Y3');

    const headers = {};
    for (let col = 0; col < 25; col++) {
      const cell = dashboard.getCell(2, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    const colWeight = headers['무게(kg)'];
    const colShipping = headers['배송비(KRW)'];

    if (colWeight === undefined || colShipping === undefined) {
      console.error('❌ 필요한 열을 찾을 수 없습니다!');
      console.log(`   무게(kg): ${colWeight}, 배송비(KRW): ${colShipping}`);
      return;
    }

    console.log(`   열 위치:`);
    console.log(`   - 무게(kg): ${String.fromCharCode(65 + colWeight)}열`);
    console.log(`   - 배송비(KRW): ${String.fromCharCode(65 + colShipping)}열\n`);

    // 3. 배송비 재계산
    console.log('💰 3단계: 배송비 재계산 중...\n');

    let updatedCount = 0;
    let skippedCount = 0;
    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 3; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      // 배치 로드
      const minCol = Math.min(colWeight, colShipping);
      const maxCol = Math.max(colWeight, colShipping);
      const startColLetter = String.fromCharCode(65 + minCol);
      const endColLetter = String.fromCharCode(65 + maxCol);
      await dashboard.loadCells(`${startColLetter}${startRow + 1}:${endColLetter}${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        const weightCell = dashboard.getCell(row, colWeight);
        const shippingCell = dashboard.getCell(row, colShipping);

        const weight = weightCell.value;

        if (!weight || weight <= 0) {
          skippedCount++;
          continue;
        }

        // 최적 배송비 계산
        const bestRate = calculateBestShipping(weight, rates);

        if (bestRate) {
          shippingCell.value = bestRate;
          updatedCount++;
        } else {
          skippedCount++;
        }
      }

      // 배치 저장
      await dashboard.saveUpdatedCells();

      if (endRow % 1000 === 0 || endRow === totalRows) {
        console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ 배송비 재계산 완료!');
    console.log('='.repeat(60));
    console.log(`\n📊 결과:`);
    console.log(`   재계산 완료: ${updatedCount}개`);
    console.log(`   스킵 (무게 없음): ${skippedCount}개`);
    console.log(`\n💡 배송비 선택 로직:`);
    console.log(`   - 2kg 이하: YunExpress vs K-Packet 중 저렴한 것`);
    console.log(`   - 2kg 초과: YunExpress만 사용`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 모든 단계 완료!\n');

    // 최종 요약
    console.log('='.repeat(60));
    console.log('📊 최종 요약');
    console.log('='.repeat(60));
    console.log('\n✅ 완료된 작업:');
    console.log('   1. ✅ 칼럼명 변경 (eBay → 판매가, 국제 배송비, 플랫폼 수수료)');
    console.log('   2. ✅ Shopify 데이터 통합 (3,742개 가격, 1개 배송비)');
    console.log('   3. ✅ 수수료 공식 업데이트 (eBay 18%, Shopify 3.3%)');
    console.log('   4. ✅ 배송비 재계산 (무게 기반, 최적 요율)');
    console.log('\n🔒 보존된 데이터:');
    console.log('   - 매입가: 수정되지 않음 ✓');
    console.log('   - 무게(kg): 수정되지 않음 ✓');
    console.log('\n🎊 대시보드가 성공적으로 업데이트되었습니다!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

recalculateShipping();
