require('dotenv').config({ path: '../../config/.env' });
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * 1. K열에 '플랫폼' 컬럼 추가
 * 2. 기존 Shopify 상품은 'Shopify' 표시
 * 3. Shopify 수수료를 5%로 변경
 */
async function updatePlatformAndFee() {
  console.log('\n=== 플랫폼 구분 & 수수료 업데이트 ===\n');

  try {
    const sheets = new GoogleSheetsAPI('../../config/credentials.json');
    await sheets.authenticate();

    // 1. K열에 '플랫폼' 헤더 추가
    console.log('1. K열에 "플랫폼" 헤더 추가 중...');
    await sheets.writeData(SPREADSHEET_ID, '시트1!K1', [['플랫폼']]);

    // 2. 현재 데이터 행 수 확인
    console.log('\n2. 현재 데이터 확인 중...');
    const data = await sheets.readData(SPREADSHEET_ID, '시트1!A2:K');
    console.log(`   총 ${data.length}개 상품 발견\n`);

    // 3. 모든 기존 상품을 'Shopify'로 표시
    console.log('3. 기존 상품을 "Shopify" 플랫폼으로 표시 중...');
    const platformValues = Array(data.length).fill(['Shopify']);
    await sheets.writeData(SPREADSHEET_ID, '시트1!K2', platformValues);

    // 4. Shopify 수수료를 5%로 변경
    console.log('\n4. Shopify 수수료를 5%로 변경 중...');
    const feeValues = Array(data.length).fill(['5']);
    await sheets.writeData(SPREADSHEET_ID, '시트1!F2', feeValues);

    // 5. K열에 드롭다운 유효성 검사 추가
    console.log('\n5. 플랫폼 드롭다운 설정 중...');
    const request = {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: 0,
              startRowIndex: 1,
              endRowIndex: data.length + 1,
              startColumnIndex: 10, // K열
              endColumnIndex: 11
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: [
                  { userEnteredValue: 'Shopify' },
                  { userEnteredValue: 'eBay' },
                  { userEnteredValue: 'Amazon' },
                  { userEnteredValue: 'Coupang' }
                ]
              },
              showCustomUi: true,
              strict: true
            }
          }
        }
      ]
    };

    await sheets.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: request
    });

    console.log('\n✅ 업데이트 완료!');
    console.log('\n📋 변경 사항:');
    console.log(`   - K열 "플랫폼" 컬럼 추가`);
    console.log(`   - 기존 ${data.length}개 상품 → "Shopify" 표시`);
    console.log(`   - Shopify 수수료: 10% → 5%`);
    console.log('\n🎯 플랫폼 옵션:');
    console.log('   - Shopify');
    console.log('   - eBay');
    console.log('   - Amazon');
    console.log('   - Coupang');
    console.log(`\n🔗 스프레드시트 확인:`);
    console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);

    console.log('\n💡 다음 단계:');
    console.log('   - eBay 상품 동기화 시 자동으로 "eBay" 표시됩니다');
    console.log('   - 플랫폼별 필터링이 가능합니다');

  } catch (error) {
    console.error('\n❌ 에러 발생:', error.message);
  }
}

updatePlatformAndFee();
