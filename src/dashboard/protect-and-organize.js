require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 데이터 보호 및 레이아웃 정리
 *
 * 1. 매입가와 무게(kg) 열 보호 (범위 보호)
 * 2. 레이아웃 재구성:
 *    - 앞쪽 그룹: Image, SKU, Product Title, 매입가, 무게(kg)
 *    - 뒤쪽 그룹: 나머지 계산 열들
 * 3. 열 너비 자동 조정
 */

async function protectAndOrganize() {
  console.log('=== 데이터 보호 및 레이아웃 정리 시작 ===\n');
  console.log('⚠️  중요: 매입가와 무게(kg) 열을 보호합니다.\n');

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
    for (let col = 0; col < 25; col++) {
      const cell = dashboard.getCell(2, col);
      if (cell.value) {
        headers[cell.value] = col;
      }
    }

    const colPurchasePrice = headers['매입가'] || headers['🔒 매입가'];
    const colWeight = headers['무게(kg)'] || headers['🔒 무게(kg)'];

    if (colPurchasePrice === undefined || colWeight === undefined) {
      console.error('   ❌ 매입가 또는 무게(kg) 열을 찾을 수 없습니다!');
      console.log('   사용 가능한 헤더:', Object.keys(headers));
      return;
    }

    console.log(`   매입가: ${String.fromCharCode(65 + colPurchasePrice)}열`);
    console.log(`   무게(kg): ${String.fromCharCode(65 + colWeight)}열\n`);

    // 2. 열 재정렬 제안
    console.log('📐 2단계: 최적 레이아웃 제안\n');

    const optimalLayout = [
      { current: 'Image', name: '이미지', priority: 1 },
      { current: 'SKU', name: 'SKU', priority: 2 },
      { current: 'Product Title', name: '상품명', priority: 3 },
      { current: 'Vendor', name: '벤더', priority: 4 },
      { current: '매입가', name: '매입가 🔒', priority: 5 },
      { current: '무게(kg)', name: '무게(kg) 🔒', priority: 6 },
      { current: '플랫폼', name: '플랫폼', priority: 7 },
      { current: '판매가(USD)', name: '판매가', priority: 8 },
      { current: '국제 배송비(USD)', name: '국제배송비', priority: 9 },
      { current: '플랫폼 수수료(USD)', name: '수수료', priority: 10 }
    ];

    console.log('   💡 권장 열 순서 (입력 편의성):');
    optimalLayout.forEach((col, i) => {
      console.log(`   ${i + 1}. ${col.name}${col.name.includes('🔒') ? ' (보호됨)' : ''}`);
    });

    console.log('\n   ⚠️  주의: 열 순서 변경은 수동으로 진행하세요.');
    console.log('   (Google Sheets UI에서 열을 드래그하여 이동)\n');

    // 3. 보호 범위 설정 정보 제공
    console.log('🔒 3단계: 열 보호 설정 안내\n');

    console.log('   Google Sheets에서 수동 설정이 필요합니다:\n');
    console.log('   1. Google Sheets 열기');
    console.log(`   2. ${String.fromCharCode(65 + colPurchasePrice)}열 전체 선택 (매입가)`);
    console.log('   3. 마우스 우클릭 → "범위 보호" 선택');
    console.log('   4. 설명: "매입가 - 수동 관리 필수"');
    console.log('   5. "권한 설정" → "나만 수정 가능" 선택');
    console.log('   6. "완료"\n');

    console.log(`   7. ${String.fromCharCode(65 + colWeight)}열 전체 선택 (무게)`);
    console.log('   8. 마우스 우클릭 → "범위 보호" 선택');
    console.log('   9. 설명: "무게(kg) - 수동 관리 필수"');
    console.log('   10. "권한 설정" → "나만 수정 가능" 선택');
    console.log('   11. "완료"\n');

    // 4. 열 너비 조정 (메타데이터 업데이트)
    console.log('📏 4단계: 열 너비 최적화 중...\n');

    const columnWidths = {
      'Image': 100,
      'SKU': 150,
      'Product Title': 300,
      'Vendor': 120,
      '매입가': 100,
      '무게(kg)': 80,
      '플랫폼': 100,
      '판매가(USD)': 100,
      '국제 배송비(USD)': 120,
      '플랫폼 수수료(USD)': 120,
      '배송비(KRW)': 100,
      '최종순이익(KRW)': 120,
      '마진율(%)': 80
    };

    // Google Sheets API로 열 너비 업데이트
    const requests = [];
    for (const [headerName, width] of Object.entries(columnWidths)) {
      const colIndex = headers[headerName];
      if (colIndex !== undefined) {
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: dashboard.sheetId,
              dimension: 'COLUMNS',
              startIndex: colIndex,
              endIndex: colIndex + 1
            },
            properties: {
              pixelSize: width
            },
            fields: 'pixelSize'
          }
        });
      }
    }

    if (requests.length > 0) {
      await doc.batchUpdate(requests);
      console.log(`   ✅ ${requests.length}개 열 너비 조정 완료\n`);
    }

    // 5. 헤더에 보호 표시 추가
    console.log('🏷️  5단계: 보호된 열 헤더 업데이트 중...\n');

    // 셀 다시 로드
    await dashboard.loadCells('A3:Y3');

    const purchasePriceCell = dashboard.getCell(2, colPurchasePrice);
    const weightCell = dashboard.getCell(2, colWeight);

    if (!purchasePriceCell.value.includes('🔒')) {
      purchasePriceCell.value = '🔒 매입가';
    }

    if (!weightCell.value.includes('🔒')) {
      weightCell.value = '🔒 무게(kg)';
    }

    await dashboard.saveUpdatedCells();
    console.log('   ✅ 보호 표시 추가 완료\n');

    // 6. 조건부 서식 준비 (다음 단계에서 수동 설정)
    console.log('🎨 6단계: 조건부 서식 설정 안내\n');

    console.log('   Google Sheets에서 조건부 서식을 설정하세요:\n');
    console.log('   📌 역마진 알림 (빨간색):');
    console.log('      1. 데이터 범위 선택 (4행부터)');
    console.log('      2. 서식 → 조건부 서식');
    console.log('      3. 맞춤 수식: =INDIRECT("M"&ROW())<0');
    console.log('      4. 서식 스타일: 배경색 연한 빨간색 (#F4CCCC)');
    console.log('      5. 완료\n');

    console.log('   📌 효자 상품 (파란색):');
    console.log('      1. 데이터 범위 선택 (4행부터)');
    console.log('      2. 서식 → 조건부 서식');
    console.log('      3. 맞춤 수식: =INDIRECT("N"&ROW())>=0.2');
    console.log('      4. 서식 스타일: 배경색 연한 파란색 (#CFE2F3)');
    console.log('      5. 완료\n');

    console.log('='.repeat(60));
    console.log('✅ 데이터 보호 및 레이아웃 준비 완료!');
    console.log('='.repeat(60));
    console.log('\n📊 완료된 작업:');
    console.log('   ✅ 매입가 열 식별');
    console.log('   ✅ 무게(kg) 열 식별');
    console.log('   ✅ 열 너비 최적화');
    console.log('   ✅ 헤더에 보호 표시 (🔒) 추가');
    console.log('\n⚠️  수동 작업 필요:');
    console.log('   📌 열 보호 설정 (범위 보호)');
    console.log('   📌 조건부 서식 설정 (역마진, 효자상품)');
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n💡 다음 단계:');
    console.log('   - update-formulas-final.js: 배송비 및 마진 수식 최종 적용');
    console.log('\n🎉 1단계 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

protectAndOrganize();
