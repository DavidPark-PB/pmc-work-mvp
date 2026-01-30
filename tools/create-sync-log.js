require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * Sync_Log 시트 생성
 *
 * AutoSync 실행 기록을 저장하는 로그 시트
 */

async function createSyncLog() {
  console.log('=== Sync_Log 시트 생성 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`📊 스프레드시트: ${doc.title}\n`);

    // 1. 기존 Sync_Log 시트 확인
    let syncLog = doc.sheetsByTitle['Sync_Log'];

    if (syncLog) {
      console.log('⚠️  Sync_Log 시트가 이미 존재합니다.');
      console.log('   기존 시트를 사용합니다.\n');
    } else {
      // 2. 새 시트 생성
      console.log('📝 1단계: Sync_Log 시트 생성 중...\n');

      syncLog = await doc.addSheet({
        title: 'Sync_Log',
        headerValues: [
          '실행 시각',
          '실행 유형',
          '총 처리',
          'eBay 성공',
          'eBay 실패',
          'Shopify 성공',
          'Shopify 실패',
          '오류 상세',
          '실행 시간(초)',
          '상태'
        ],
        gridProperties: {
          rowCount: 1000,
          columnCount: 10,
          frozenRowCount: 1
        }
      });

      console.log(`   ✅ Sync_Log 시트 생성 완료 (ID: ${syncLog.sheetId})\n`);
    }

    // 3. 헤더 서식 설정
    console.log('🎨 2단계: 헤더 서식 설정 중...\n');

    await syncLog.loadCells('A1:J1');

    for (let col = 0; col < 10; col++) {
      const cell = syncLog.getCell(0, col);
      cell.textFormat = { bold: true };
      cell.backgroundColor = { red: 0.85, green: 0.85, blue: 0.85 };
    }

    await syncLog.saveUpdatedCells();
    console.log('   ✅ 헤더 서식 적용 완료\n');

    // 4. 열 너비 설정 (수동 조정 필요)
    console.log('📏 3단계: 열 너비 안내\n');

    console.log('   Google Sheets에서 수동으로 열 너비 조정:\n');
    console.log('   - 실행 시각(A): 180px');
    console.log('   - 실행 유형(B): 100px');
    console.log('   - 총 처리(C): 80px');
    console.log('   - eBay 성공(D): 100px');
    console.log('   - eBay 실패(E): 100px');
    console.log('   - Shopify 성공(F): 120px');
    console.log('   - Shopify 실패(G): 120px');
    console.log('   - 오류 상세(H): 300px');
    console.log('   - 실행 시간(I): 120px');
    console.log('   - 상태(J): 100px\n');

    // 5. 샘플 로그 추가
    console.log('📝 4단계: 샘플 로그 추가 중...\n');

    const now = new Date();
    const sampleRow = await syncLog.addRow({
      '실행 시각': now.toISOString(),
      '실행 유형': '수동',
      '총 처리': 0,
      'eBay 성공': 0,
      'eBay 실패': 0,
      'Shopify 성공': 0,
      'Shopify 실패': 0,
      '오류 상세': '초기화 - 동기화 대기 중',
      '실행 시간(초)': 0,
      '상태': '대기'
    });

    console.log('   ✅ 샘플 로그 추가 완료\n');

    // 6. 조건부 서식 안내
    console.log('🎨 5단계: 조건부 서식 안내\n');

    console.log('   Google Sheets에서 조건부 서식 설정:\n');
    console.log('   📌 성공 상태 (초록색):');
    console.log('      1. 범위: J2:J1000 (상태 열)');
    console.log('      2. 서식 → 조건부 서식');
    console.log('      3. 텍스트에 "완료" 포함');
    console.log('      4. 배경색: #D9EAD3 (연한 초록색)\n');

    console.log('   📌 오류 상태 (빨간색):');
    console.log('      1. 범위: J2:J1000 (상태 열)');
    console.log('      2. 서식 → 조건부 서식');
    console.log('      3. 텍스트에 "오류" 포함');
    console.log('      4. 배경색: #F4CCCC (연한 빨간색)\n');

    console.log('='.repeat(60));
    console.log('✅ Sync_Log 시트 생성 완료!');
    console.log('='.repeat(60));
    console.log();
    console.log('📊 생성된 시트:');
    console.log(`   - 이름: Sync_Log`);
    console.log(`   - 열: 10개`);
    console.log(`   - 행: 1,000개`);
    console.log();
    console.log('📋 로그 컬럼:');
    console.log('   1. 실행 시각 - ISO 8601 형식');
    console.log('   2. 실행 유형 - 수동/자동');
    console.log('   3. 총 처리 - 처리한 상품 수');
    console.log('   4-7. 플랫폼별 성공/실패 수');
    console.log('   8. 오류 상세 - 에러 메시지');
    console.log('   9. 실행 시간 - 초 단위');
    console.log('   10. 상태 - 완료/오류/대기');
    console.log();
    console.log(`🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log();
    console.log('💡 다음 단계:');
    console.log('   - update-autosync-with-logging.js: AutoSync에 로깅 추가');
    console.log();
    console.log('🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

createSyncLog();
