require('dotenv').config({ path: '../../config/.env' });
const ShopifyAPI = require('../api/shopifyAPI');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

/**
 * 컬럼 인덱스를 A, B, C... 형식 문자로 변환
 */
function getColumnLetter(index) {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode((index % 26) + 65) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

/**
 * Shopify API에서 SKU별 Weight 정보를 가져와서 시트1에 추가
 */
async function updateShopifyWeight() {
  console.log('\n=== Shopify Weight 정보 업데이트 시작 ===\n');

  try {
    // 1. Shopify API 초기화
    console.log('📡 Step 1: Shopify API 연결 중...');
    const shopify = new ShopifyAPI();
    const isConnected = await shopify.testConnection();

    if (!isConnected) {
      console.error('❌ Shopify 연결 실패. .env 파일을 확인하세요.');
      return;
    }
    console.log('   ✅ Shopify 연결 성공');

    // 2. Shopify에서 모든 상품 가져오기
    console.log('\n📥 Step 2: Shopify 상품 데이터 가져오기...');
    const products = await shopify.getAllProducts();

    // SKU를 키로 하는 Map 생성 (Weight 정보 포함)
    const weightMap = new Map();
    let totalVariants = 0;

    products.forEach(product => {
      if (product.variants && Array.isArray(product.variants)) {
        product.variants.forEach(variant => {
          totalVariants++;
          const sku = variant.sku;
          if (sku) {
            weightMap.set(sku, {
              weight: variant.weight || 0,
              weightUnit: variant.weight_unit || 'kg',
              title: product.title,
              variantTitle: variant.title
            });
          }
        });
      }
    });

    console.log(`   ✅ ${products.length}개 상품, ${totalVariants}개 변형 발견`);
    console.log(`   ✅ ${weightMap.size}개 SKU의 Weight 정보 수집됨`);

    // 3. Google Sheets 인증
    console.log('\n📊 Step 3: Google Sheets 연결 중...');
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`   ✅ 스프레드시트: ${doc.title}`);

    // 4. 시트1 읽기
    console.log('\n📖 Step 4: 시트1 데이터 읽기...');
    const sheet = doc.sheetsByTitle['시트1'];
    if (!sheet) {
      console.error('❌ "시트1" 시트를 찾을 수 없습니다!');
      return;
    }

    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;
    console.log(`   현재 헤더: ${headers.join(', ')}`);

    // Weight, Weight Unit 컬럼이 있는지 확인
    const hasWeight = headers.includes('Weight');
    const hasWeightUnit = headers.includes('Weight Unit');

    if (!hasWeight || !hasWeightUnit) {
      console.log('\n🔨 Step 5: Weight 컬럼 추가 중...');

      // 새 헤더에 Weight, Weight Unit 추가
      const newHeaders = [...headers];
      if (!hasWeight) {
        newHeaders.push('Weight');
        console.log('   추가: Weight');
      }
      if (!hasWeightUnit) {
        newHeaders.push('Weight Unit');
        console.log('   추가: Weight Unit');
      }

      await sheet.setHeaderRow(newHeaders);
      console.log('   ✅ 헤더 업데이트 완료');
    }

    // 5. 기존 데이터 읽기
    console.log('\n🔄 Step 6: SKU 기준으로 Weight 정보 업데이트 중...');
    const rows = await sheet.getRows();

    let updatedCount = 0;
    let notFoundCount = 0;

    // Weight, Weight Unit 컬럼 인덱스 찾기
    const weightIndex = headers.indexOf('Weight');
    const weightUnitIndex = headers.indexOf('Weight Unit');
    const skuIndex = headers.indexOf('SKU');

    // 배치 업데이트 배열 준비
    const batchUpdates = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sku = row.get('SKU');

      if (sku && sku !== 'N/A' && weightMap.has(sku)) {
        const weightInfo = weightMap.get(sku);
        const rowNumber = i + 2; // 헤더가 1행이므로 +2

        // Weight 컬럼 업데이트
        batchUpdates.push({
          range: `시트1!${getColumnLetter(weightIndex)}${rowNumber}`,
          values: [[weightInfo.weight]]
        });

        // Weight Unit 컬럼 업데이트
        batchUpdates.push({
          range: `시트1!${getColumnLetter(weightUnitIndex)}${rowNumber}`,
          values: [[weightInfo.weightUnit]]
        });

        updatedCount++;
      } else if (sku && sku !== 'N/A') {
        notFoundCount++;
      }
    }

    // 배치 업데이트 실행
    if (batchUpdates.length > 0) {
      console.log(`\n📝 ${batchUpdates.length}개 셀 배치 업데이트 중...`);

      await sheet.loadCells();

      for (const update of batchUpdates) {
        const cell = sheet.getCellByA1(update.range.replace('시트1!', ''));
        cell.value = update.values[0][0];
      }

      await sheet.saveUpdatedCells();
      console.log('   ✅ 배치 업데이트 완료!');
    }

    console.log(`\n✅ 업데이트 완료!`);
    console.log(`   총 행: ${rows.length}개`);
    console.log(`   업데이트됨: ${updatedCount}개`);
    console.log(`   Shopify에서 못 찾음: ${notFoundCount}개`);

    // 6. 통계 출력
    console.log('\n📊 Weight 통계:\n');

    const weights = Array.from(weightMap.values()).map(v => v.weight);
    const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
    const maxWeight = Math.max(...weights);
    const minWeight = Math.min(...weights.filter(w => w > 0));

    console.log(`   평균 무게: ${avgWeight.toFixed(2)} kg`);
    console.log(`   최대 무게: ${maxWeight.toFixed(2)} kg`);
    console.log(`   최소 무게: ${minWeight.toFixed(2)} kg`);

    const light = weights.filter(w => w < 0.5).length;
    const medium = weights.filter(w => w >= 0.5 && w < 1.0).length;
    const heavy = weights.filter(w => w >= 1.0).length;

    console.log(`\n   경량 (< 0.5kg): ${light}개`);
    console.log(`   중량 (0.5-1kg): ${medium}개`);
    console.log(`   중량 (≥ 1kg): ${heavy}개`);

    console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
    console.log('\n🎉 Weight 정보 업데이트 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

updateShopifyWeight();
