require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 배송비 계산 시트 생성
 */

async function createShippingCalculator() {
  console.log('=== 배송비 계산 시트 생성 시작 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    console.log(`📊 스프레드시트: ${doc.title}\n`);

    // Shipping Calculator 시트 생성 또는 가져오기
    let calcSheet = doc.sheetsByTitle['Shipping Calculator'];
    if (!calcSheet) {
      console.log('📄 "Shipping Calculator" 시트 생성 중...');
      calcSheet = await doc.addSheet({ title: 'Shipping Calculator' });
    } else {
      console.log('📄 "Shipping Calculator" 시트 발견. 초기화 중...');
      await calcSheet.clear();
    }

    // 헤더 설정
    await calcSheet.loadCells('A1:D20');

    // 타이틀
    calcSheet.getCell(0, 0).value = '배송비 자동 계산기';
    calcSheet.getCell(0, 0).textFormat = { bold: true, fontSize: 14 };

    // 입력 섹션
    calcSheet.getCell(2, 0).value = '입력';
    calcSheet.getCell(2, 0).textFormat = { bold: true };
    calcSheet.getCell(2, 0).backgroundColor = { red: 0.85, green: 0.92, blue: 0.83 };

    calcSheet.getCell(3, 0).value = '상품 무게 (g)';
    calcSheet.getCell(3, 1).value = '';
    calcSheet.getCell(3, 1).note = '예: 500';

    calcSheet.getCell(4, 0).value = '목적지 국가';
    calcSheet.getCell(4, 1).value = 'US';
    calcSheet.getCell(4, 1).note = '현재는 US만 지원';

    // 결과 섹션
    calcSheet.getCell(6, 0).value = '배송비 비교 결과';
    calcSheet.getCell(6, 0).textFormat = { bold: true };
    calcSheet.getCell(6, 0).backgroundColor = { red: 0.85, green: 0.85, blue: 0.92 };

    // 결과 헤더
    const resultHeaders = ['배송사', '요금 (KRW)', '비고'];
    resultHeaders.forEach((header, idx) => {
      calcSheet.getCell(7, idx).value = header;
      calcSheet.getCell(7, idx).textFormat = { bold: true };
      calcSheet.getCell(7, idx).backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
    });

    // 배송사 이름 미리 채우기
    const carriers = ['YunExpress', 'K-Packet', 'SHIPTER', 'FedEx (West)', 'FedEx (Other)', '최저가'];
    carriers.forEach((carrier, idx) => {
      calcSheet.getCell(8 + idx, 0).value = carrier;
      if (carrier === '최저가') {
        calcSheet.getCell(8 + idx, 0).textFormat = { bold: true };
        calcSheet.getCell(8 + idx, 0).backgroundColor = { red: 1, green: 0.95, blue: 0.8 };
        calcSheet.getCell(8 + idx, 1).textFormat = { bold: true };
        calcSheet.getCell(8 + idx, 1).backgroundColor = { red: 1, green: 0.95, blue: 0.8 };
      }
    });

    // 안내 메시지
    calcSheet.getCell(15, 0).value = '💡 사용 방법:';
    calcSheet.getCell(15, 0).textFormat = { bold: true };
    calcSheet.getCell(16, 0).value = '1. B4 셀에 상품 무게(g)를 입력하세요';
    calcSheet.getCell(17, 0).value = '2. calculate-shipping.js 스크립트를 실행하세요';
    calcSheet.getCell(18, 0).value = '3. 각 배송사별 요금과 최저가가 자동으로 계산됩니다';

    await calcSheet.saveUpdatedCells();

    // 열 너비 조정
    await calcSheet.resize({ rowCount: 100, columnCount: 10 });

    console.log('='.repeat(60));
    console.log('✅ 배송비 계산 시트 생성 완료!');
    console.log('='.repeat(60));
    console.log('\n📋 시트 구조:');
    console.log('  - 입력 섹션: B4 (무게), B5 (국가)');
    console.log('  - 결과 섹션: A8~C13 (각 배송사별 요금)');
    console.log('  - 최저가: A13~C13');
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n다음 단계:');
    console.log('  1. Google Sheets에서 B4에 무게(g) 입력');
    console.log('  2. node calculate-shipping.js 실행');
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

createShippingCalculator();
