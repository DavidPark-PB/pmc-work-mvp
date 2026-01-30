require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 품절 상품 마킹 및 배송비 재계산
 *
 * 1. F열에 "품절"인 상품 → 상태 표시
 * 2. R열(무게) 기반 → O열(배송비) 재계산
 */

// 배송비 요율표 (YunExpress & K-Packet US)
const YUNEXPRESS_US = [
  { weight: 100, rate: 6200 },
  { weight: 200, rate: 8900 },
  { weight: 300, rate: 9650 },
  { weight: 400, rate: 11200 },
  { weight: 500, rate: 12150 },
  { weight: 600, rate: 13300 },
  { weight: 700, rate: 14800 },
  { weight: 800, rate: 16100 },
  { weight: 900, rate: 17300 },
  { weight: 1000, rate: 18550 },
  { weight: 1500, rate: 24800 },
  { weight: 2000, rate: 31000 }
];

const KPACKET_US = [
  { weight: 100, rate: 8090 },
  { weight: 200, rate: 8980 },
  { weight: 300, rate: 9870 },
  { weight: 400, rate: 10760 },
  { weight: 500, rate: 11650 },
  { weight: 600, rate: 12540 },
  { weight: 700, rate: 13430 },
  { weight: 800, rate: 14320 },
  { weight: 900, rate: 15210 },
  { weight: 1000, rate: 16100 },
  { weight: 1100, rate: 16990 },
  { weight: 1200, rate: 17880 },
  { weight: 1300, rate: 18770 },
  { weight: 1400, rate: 19660 },
  { weight: 1500, rate: 20550 },
  { weight: 1600, rate: 21440 },
  { weight: 1700, rate: 22330 },
  { weight: 1800, rate: 23220 },
  { weight: 1900, rate: 24110 },
  { weight: 2000, rate: 25000 }
];

function findRate(rates, weightG) {
  const sorted = rates.sort((a, b) => a.weight - b.weight);

  // 정확히 일치
  const exact = sorted.find(r => r.weight === weightG);
  if (exact) return exact.rate;

  // 범위 밖
  if (weightG < sorted[0].weight) return sorted[0].rate;
  if (weightG > sorted[sorted.length - 1].weight) return null;

  // 선형 보간
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

function calculateBestShipping(weightKg) {
  if (!weightKg || weightKg <= 0) return null;

  const weightG = Math.round(weightKg * 1000);

  // K-Packet (2kg 이하만)
  let kpacketRate = null;
  if (weightKg <= 2) {
    kpacketRate = findRate(KPACKET_US, weightG);
  }

  // YunExpress
  const yunexpressRate = findRate(YUNEXPRESS_US, weightG);

  // 둘 다 있으면 저렴한 것
  if (kpacketRate && yunexpressRate) {
    return Math.min(kpacketRate, yunexpressRate);
  }

  return kpacketRate || yunexpressRate;
}

async function updateSoldoutAndShipping() {
  console.log('='.repeat(70));
  console.log('🔄 품절 상품 마킹 및 배송비 재계산');
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
    console.log(`📊 시트: ${dashboard.title}\n`);

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

    const purchasePriceCol = headers['🔒 매입가'];  // F열 - 품절 표시
    const weightCol = headers['🔒 무게(kg)'];  // R열
    const shippingKRWCol = headers['배송비(KRW)'];  // O열

    console.log(`   🔒 매입가 (품절 표시): ${purchasePriceCol !== undefined ? String.fromCharCode(65 + purchasePriceCol) + '열' : '없음'}`);
    console.log(`   🔒 무게(kg): ${weightCol !== undefined ? String.fromCharCode(65 + weightCol) + '열' : '없음'}`);
    console.log(`   배송비(KRW): ${shippingKRWCol !== undefined ? String.fromCharCode(65 + shippingKRWCol) + '열' : '없음'}`);
    console.log();

    // 2. 데이터 처리
    console.log('⚡ 2단계: 품절 확인 및 배송비 계산 중...\n');

    let soldoutCount = 0;
    let shippingUpdated = 0;
    let noWeightCount = 0;
    const soldoutSkus = [];

    const batchSize = 500;
    const totalRows = dashboard.rowCount;

    for (let startRow = 1; startRow < totalRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);

      // 배치 로드 (SKU, 매입가, 무게, 배송비)
      const minCol = Math.min(1, purchasePriceCol, weightCol, shippingKRWCol);  // B열(SKU) 포함
      const maxCol = Math.max(1, purchasePriceCol, weightCol, shippingKRWCol);
      await dashboard.loadCells(`${String.fromCharCode(65 + minCol)}${startRow + 1}:${String.fromCharCode(65 + maxCol)}${endRow}`);

      for (let row = startRow; row < endRow; row++) {
        const skuCell = dashboard.getCell(row, 1);  // B열 SKU
        const purchaseCell = dashboard.getCell(row, purchasePriceCol);
        const weightCell = dashboard.getCell(row, weightCol);
        const shippingCell = dashboard.getCell(row, shippingKRWCol);

        const sku = skuCell.value;
        const purchaseValue = purchaseCell.value;
        const weight = weightCell.value;

        // 품절 확인
        if (String(purchaseValue).toLowerCase() === '품절') {
          soldoutCount++;
          if (sku) {
            soldoutSkus.push({
              row: row + 1,
              sku: sku
            });
          }
        }

        // 배송비 계산 (무게가 있는 경우만)
        if (weight && parseFloat(weight) > 0) {
          const bestRate = calculateBestShipping(parseFloat(weight));
          if (bestRate) {
            shippingCell.value = bestRate;
            shippingUpdated++;
          }
        } else if (!weight || parseFloat(weight) === 0) {
          noWeightCount++;
        }
      }

      await dashboard.saveUpdatedCells();

      if (endRow % 1000 === 0 || endRow === totalRows) {
        console.log(`   처리 중... ${endRow}/${totalRows} (${Math.round(endRow/totalRows*100)}%)`);
      }
    }

    console.log();

    // 3. 결과 출력
    console.log('='.repeat(70));
    console.log('📊 처리 결과');
    console.log('='.repeat(70));
    console.log();
    console.log(`   📦 품절 상품: ${soldoutCount}개`);
    console.log(`   💰 배송비 업데이트: ${shippingUpdated}개`);
    console.log(`   ⚠️  무게 없음 (배송비 계산 불가): ${noWeightCount}개`);
    console.log();

    // 4. 품절 상품 목록 (처음 20개)
    if (soldoutSkus.length > 0) {
      console.log('📋 품절 상품 목록 (처음 20개):\n');
      soldoutSkus.slice(0, 20).forEach((item, i) => {
        console.log(`   ${i + 1}. Row ${item.row}: ${item.sku}`);
      });
      if (soldoutSkus.length > 20) {
        console.log(`   ... 외 ${soldoutSkus.length - 20}개`);
      }
      console.log();
    }

    // 5. 품절 상품 SKU를 파일로 저장 (API 업데이트용)
    if (soldoutSkus.length > 0) {
      const soldoutFile = `C:\\Users\\tooni\\PMC work MVP\\soldout-skus-${new Date().toISOString().slice(0,10)}.json`;
      fs.writeFileSync(soldoutFile, JSON.stringify(soldoutSkus, null, 2));
      console.log(`   📁 품절 SKU 목록 저장: ${soldoutFile}`);
      console.log();
    }

    console.log('='.repeat(70));
    console.log('✅ 완료!');
    console.log('='.repeat(70));
    console.log();
    console.log('💡 다음 단계:');
    console.log('   1. 품절 상품 API 업데이트: node update-soldout-api.js');
    console.log('   2. 시트에서 품절 상품 확인: F열에 "품절" 표시');
    console.log();
    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

updateSoldoutAndShipping();
