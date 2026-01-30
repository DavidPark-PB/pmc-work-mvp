require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 배송사 요율표 데이터를 Google Sheets에 생성
 */

// FedEx Zone 매핑
const FEDEX_ZONES = {
  'US-West': 'E',
  'US-Other': 'F',
  'CA': 'F',
  'AU': 'U',
  'HK': 'V',
  'JP': 'P',
  'DE': 'M', 'FR': 'M', 'BE': 'M', 'NL': 'M', 'GB': 'M',
  'AT': 'G', 'SE': 'G', 'CH': 'G', 'DK': 'G', 'CZ': 'G', 'GR': 'G'
};

// YunExpress 미국 요율 (kg 기준)
const YUNEXPRESS_US = [
  { weight: 0.10, rate: 6200 },
  { weight: 0.20, rate: 8900 },
  { weight: 0.30, rate: 10400 },
  { weight: 0.40, rate: 14900 },
  { weight: 0.50, rate: 23500 },
  { weight: 0.60, rate: 33500 },
  { weight: 0.70, rate: 38000 },
  { weight: 0.80, rate: 45600 },
  { weight: 0.90, rate: 56800 },
  { weight: 1.00, rate: 60300 },
  { weight: 1.50, rate: 65200 },
  { weight: 2.00, rate: 70200 }
];

// K-Packet 미국 요율 (g 기준, 2kg 제한)
const KPACKET_US = [
  { weight: 100, rate: 8090 },
  { weight: 200, rate: 8980 },
  { weight: 300, rate: 11060 },
  { weight: 400, rate: 13170 },
  { weight: 500, rate: 15280 },
  { weight: 600, rate: 16910 },
  { weight: 700, rate: 18530 },
  { weight: 800, rate: 20160 },
  { weight: 900, rate: 21780 },
  { weight: 1000, rate: 23430 },
  { weight: 1100, rate: 25780 },
  { weight: 1200, rate: 28130 },
  { weight: 1300, rate: 30480 },
  { weight: 1400, rate: 32810 },
  { weight: 1500, rate: 35160 },
  { weight: 1600, rate: 37270 },
  { weight: 1700, rate: 39350 },
  { weight: 1800, rate: 41440 },
  { weight: 1900, rate: 43530 },
  { weight: 2000, rate: 45690 }
];

// SHIPTER 미국 요율 (kg 기준)
const SHIPTER_US = [
  { weight: 0.1, rate: 10200 },
  { weight: 0.2, rate: 11700 },
  { weight: 0.3, rate: 13700 },
  { weight: 0.4, rate: 16800 },
  { weight: 0.5, rate: 19000 },
  { weight: 0.6, rate: 20700 },
  { weight: 0.7, rate: 21700 },
  { weight: 0.8, rate: 23100 },
  { weight: 0.9, rate: 23900 },
  { weight: 1.0, rate: 25200 },
  { weight: 1.5, rate: 33000 },
  { weight: 2.0, rate: 34000 }
];

// FedEx Zone E (미국 서부) Package 요율 (kg 기준, 10% 할인 적용)
const FEDEX_ZONE_E = [
  { weight: 0.5, rate: 17600 },
  { weight: 1.0, rate: 21740 },
  { weight: 1.5, rate: 25750 },
  { weight: 2.0, rate: 33000 },
  { weight: 2.5, rate: 35960 },
  { weight: 3.0, rate: 39130 },
  { weight: 3.5, rate: 46620 },
  { weight: 4.0, rate: 49470 },
  { weight: 4.5, rate: 55170 },
  { weight: 5.0, rate: 60780 }
];

// FedEx Zone F (미국 기타) Package 요율 (kg 기준, 10% 할인 적용)
const FEDEX_ZONE_F = [
  { weight: 0.5, rate: 21280 },
  { weight: 1.0, rate: 23820 },
  { weight: 1.5, rate: 28930 },
  { weight: 2.0, rate: 40380 },
  { weight: 2.5, rate: 43720 },
  { weight: 3.0, rate: 46400 },
  { weight: 3.5, rate: 46620 },
  { weight: 4.0, rate: 49470 },
  { weight: 4.5, rate: 55170 },
  { weight: 5.0, rate: 60780 }
];

async function createShippingRates() {
  console.log('=== 배송비 요율 데이터 생성 시작 ===\n');

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

    // 1. Shipping Rates 시트 생성 또는 가져오기
    let ratesSheet = doc.sheetsByTitle['Shipping Rates'];
    if (!ratesSheet) {
      console.log('📄 "Shipping Rates" 시트 생성 중...');
      ratesSheet = await doc.addSheet({
        title: 'Shipping Rates',
        headerValues: ['Carrier', 'Country', 'Weight(g)', 'Rate(KRW)', 'Notes']
      });
    } else {
      console.log('📄 "Shipping Rates" 시트 발견. 데이터 추가 중...');
      await ratesSheet.clear();
      await ratesSheet.setHeaderRow(['Carrier', 'Country', 'Weight(g)', 'Rate(KRW)', 'Notes']);
    }

    console.log('✅ 시트 준비 완료\n');

    // 2. 데이터 준비
    const rows = [];

    // YunExpress US (kg → g 변환)
    console.log('📦 YunExpress US 데이터 추가...');
    YUNEXPRESS_US.forEach(item => {
      rows.push({
        Carrier: 'YunExpress',
        Country: 'US',
        'Weight(g)': item.weight * 1000,
        'Rate(KRW)': item.rate,
        Notes: 'KRBKZXR'
      });
    });

    // K-Packet US (2kg 제한)
    console.log('📦 K-Packet US 데이터 추가 (2kg 제한)...');
    KPACKET_US.forEach(item => {
      rows.push({
        Carrier: 'K-Packet',
        Country: 'US',
        'Weight(g)': item.weight,
        'Rate(KRW)': item.rate,
        Notes: '2kg max'
      });
    });

    // SHIPTER US (kg → g 변환)
    console.log('📦 SHIPTER US 데이터 추가...');
    SHIPTER_US.forEach(item => {
      rows.push({
        Carrier: 'SHIPTER',
        Country: 'US',
        'Weight(g)': item.weight * 1000,
        'Rate(KRW)': item.rate,
        Notes: 'PUDO'
      });
    });

    // FedEx Zone E (미국 서부, kg → g 변환)
    console.log('📦 FedEx Zone E (US West) 데이터 추가...');
    FEDEX_ZONE_E.forEach(item => {
      rows.push({
        Carrier: 'FedEx',
        Country: 'US-West',
        'Weight(g)': item.weight * 1000,
        'Rate(KRW)': item.rate,
        Notes: 'Zone E, 10% discount'
      });
    });

    // FedEx Zone F (미국 기타, kg → g 변환)
    console.log('📦 FedEx Zone F (US Other) 데이터 추가...');
    FEDEX_ZONE_F.forEach(item => {
      rows.push({
        Carrier: 'FedEx',
        Country: 'US-Other',
        'Weight(g)': item.weight * 1000,
        'Rate(KRW)': item.rate,
        Notes: 'Zone F, 10% discount'
      });
    });

    // 3. 시트에 데이터 추가
    console.log(`\n💾 ${rows.length}개 요율 데이터 저장 중...\n`);
    await ratesSheet.addRows(rows);

    console.log('='.repeat(60));
    console.log('✅ 배송비 요율 데이터 생성 완료!');
    console.log('='.repeat(60));
    console.log(`📊 총 ${rows.length}개 요율 데이터 저장됨`);
    console.log(`\n배송사별 데이터 수:`);
    console.log(`  - YunExpress US: ${YUNEXPRESS_US.length}개`);
    console.log(`  - K-Packet US: ${KPACKET_US.length}개 (2kg 제한)`);
    console.log(`  - SHIPTER US: ${SHIPTER_US.length}개`);
    console.log(`  - FedEx US-West: ${FEDEX_ZONE_E.length}개`);
    console.log(`  - FedEx US-Other: ${FEDEX_ZONE_F.length}개`);
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

createShippingRates();
