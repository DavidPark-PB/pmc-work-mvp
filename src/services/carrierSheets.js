/**
 * 캐리어(배송사)별 시트 자동 기록 서비스
 * 주문 데이터를 각 배송사 양식에 맞게 변환 → 해당 배송사 Google Sheet에 추가
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const path = require('path');
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

// 배송사별 Google Sheets ID
const CARRIER_SHEETS = {
  '윤익스프레스': {
    spreadsheetId: '1UZD25uxEUREhhwdw8fpg3w1e9q1LHJF8zw1xNhyPQfI',
    routingCode: 'KRTHZXR', // 일반상품 (화장품: KRMUZXR)
  },
  '쉽터': {
    spreadsheetId: '1h4PWPSwezTRB-jc73ro_llJbVaBealqV8NwQhvT2SXI',
  },
  '다보내': {
    spreadsheetId: '10hkNQNTiaMNYHXIVecUb1LMICMANy4V1I2Xv3uVjGG8',
  },
  'KPL': {
    spreadsheetId: '15X7f7lCp--Aozgiu27qIh7hDq3F98RMOPyITu997RMU',
  },
};

// 발송인 고정 정보 (PMC Corporation)
const SENDER = {
  name: 'PMC Corporation',
  phone: '1041054828',
  address: 'Suwon, Korea',
};

/**
 * 윤익스프레스 헤더 (52열)
 */
const YUNEXPRESS_HEADERS = [
  'CustomerOrderNo.', 'RoutingCode', 'Trackingnumber',
  'AdditionalServices', 'ShipmentProtectionPlusService', 'CustomDeclaredValue',
  'SignatureService', 'VatNumber', 'EoriNumber', 'IossCode',
  'ManufactureSalesName', 'UnifiedSocialCreditCode',
  'CountryCode', 'Name', 'CertificateCode', 'Company',
  'Street', 'City', 'Province/State', 'ZipCode', 'phone', 'HouseNumber',
  'Email', 'PackageNumber', 'PackageWeight',
  'SenderFiastName', 'SenderCompany', 'SenderStreet', 'SenderCity',
  'SenderProvince', 'SenderPostalCode', 'SenderCountry', 'SenderTelephone',
  'SenderEmail', 'SenderUSCI',
  'PlatformName', 'PlatformProvince', 'PlatformAddress',
  'PlatformPostalCode', 'PlatformPhoneNumber', 'PlatformEmail',
  'EcommercePlatformCode', 'SalesPlatformLink', 'CurrencyCode',
  'SKU1', 'ItemDescription1', 'ForeignItemDescription1',
  'DeclaredQuantity1', 'FOBPrice1', 'SellingPrice1', 'UnitWeight1', 'HsCode1',
];

// 쉽터 배송타입 매핑 (국가코드 → 배송타입) — 스크린샷 기준
const SHIPTER_DELIVERY_TYPES = {
  'CA': 'SHIPTER_CA',       // 캐나다
  'FR': 'SHIPTER_FR',       // 프랑스
  'CH': 'SHIPTER_CH3',      // 스위스
  'AU': 'SHIPTER_AU',       // 호주
  'NO': 'SHIPTER_NO',       // 노르웨이
  'SG': 'SG_PRIO',          // 싱가포르
  'MX': 'SHIPTER_MX2',      // 멕시코
  'NL': 'SHIPTER_NL',       // 네덜란드
  'AT': 'SHIPTER_AT',       // 오스트리아
  'BE': 'SHIPTER_BE',       // 벨기에
  'DK': 'SHIPTER_DK',       // 덴마크 (SHIPTER_IOSS)
  'PL': 'SHIPTER_PL',       // 폴란드
  'ES': 'SHIPTER_ES',       // 스페인
  'SE': 'SHIPTER_SE',       // 스웨덴
  'FI': 'SHIPTER_FI',       // 핀란드
  'US': 'US_HYB',           // 미국
  'IT': 'SHIPTER_IT2',      // 이탈리아
  'GB': 'SHIPTER_GB',       // 영국
  'DE': 'SHIPTER_DE',       // 독일
  'LU': 'SHIPTER_IOSS',     // 룩셈부르크
  'JP': 'SHIPTER_JP',       // 일본
  'HK': 'SHIPTER_HK',       // 홍콩
  'TW': 'SHIPTER_TW',       // 대만
  'NZ': 'SHIPTER_NZ',       // 뉴질랜드
  'BR': 'SHIPTER_BR',       // 브라질
  'IE': 'SHIPTER_IE',       // 아일랜드
  'PT': 'SHIPTER_PT',       // 포르투갈
  'CZ': 'SHIPTER_CZ',       // 체코
  'HU': 'SHIPTER_HU',       // 헝가리
};

// EU 국가 목록 (IOSS 필요)
const EU_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR',
  'DE','GR','HU','IE','IT','LV','LT','MT','NL','PL',
  'PT','RO','SK','SI','ES','SE',
]);

// 호주 ABN (VatNumber 필수)
const AU_ABN = '64652016681';

// KPL 발송인 상세 정보
const KPL_SENDER = {
  name: 'PMC Corporation',
  phone: '821041054826',
  address: 'Room304 30, Bandal-ro 7beon-gil, Yeongtong-gu, Suwon-si, Gyeonggi-do, Republic of Korea',
  city: 'Suwon-si',
  state: 'Gyeonggi-do',
  country: 'Korea',
  zip: '16704',
  email: 'info@ccorea.com',
  company: 'PMC Corporation',
};

// 국가코드 → 풀네임 (KPL용)
const COUNTRY_NAMES = {
  'US': 'United States', 'GB': 'United Kingdom', 'AU': 'Australia',
  'CA': 'Canada', 'DE': 'Germany', 'FR': 'France', 'IT': 'Italy',
  'ES': 'Spain', 'NL': 'Netherlands', 'BE': 'Belgium', 'AT': 'Austria',
  'JP': 'Japan', 'SG': 'Singapore', 'HK': 'Hong Kong', 'TW': 'Taiwan',
  'NZ': 'New Zealand', 'SE': 'Sweden', 'DK': 'Denmark', 'FI': 'Finland',
  'IE': 'Ireland', 'PT': 'Portugal', 'PL': 'Poland', 'CZ': 'Czech Republic',
  'HU': 'Hungary', 'SK': 'Slovakia', 'RO': 'Romania', 'BG': 'Bulgaria',
  'HR': 'Croatia', 'SI': 'Slovenia', 'LT': 'Lithuania', 'LV': 'Latvia',
  'EE': 'Estonia', 'GR': 'Greece', 'MT': 'Malta', 'CY': 'Cyprus',
  'BR': 'Brazil', 'MX': 'Mexico', 'NO': 'Norway', 'CH': 'Switzerland',
};
// 윤익스프레스 IOSS
const YUNEXPRESS_IOSS = 'IOSS253041218231480559781';

class CarrierSheets {
  constructor() {
    this.sheets = new GoogleSheetsAPI(
      path.join(__dirname, '../../config/credentials.json')
    );
  }

  /**
   * 주문 데이터를 배송사 시트에 추가
   */
  async addToCarrierSheet(carrier, order, opts = {}) {
    const config = CARRIER_SHEETS[carrier];
    if (!config) {
      throw new Error(`배송사 '${carrier}' 시트 설정이 없습니다`);
    }

    console.log(`🚚 addToCarrierSheet('${carrier}') 시작`);
    console.log(`   주문: ${order.orderId} | 구매자: ${order.buyerName} | 국가: ${order.countryCode}`);
    console.log(`   주소: ${order.street}, ${order.city}, ${order.province} ${order.zipCode}`);

    switch (carrier) {
      case '윤익스프레스':
        return this.addToYunExpress(config, order, opts);
      case '쉽터':
        return this.addToShipter(config, order, opts);
      case '다보내':
        return this.addToDabonae(config, order, opts);
      case 'KPL':
        return this.addToKPL(config, order, opts);
      default:
        throw new Error(`배송사 '${carrier}' 매핑 미구현`);
    }
  }

  // ─── 윤익스프레스 ──────────────────────────────────────────

  async addToYunExpress(config, order, opts = {}) {
    const { spreadsheetId, routingCode } = config;

    const sheetTab = opts.sheetTab || await this.getOrCreateYunikTab(spreadsheetId);
    const countryCode = (order.countryCode || order.country || '').toUpperCase();
    const orderNo = order.orderId || '';

    let vatNumber = '';
    let iossCode = '';
    if (countryCode === 'AU') vatNumber = AU_ABN;
    if (EU_COUNTRIES.has(countryCode)) iossCode = YUNEXPRESS_IOSS;

    // 시스템 자동: 주문번호, 라우팅, 통관, 수취인 주소
    // 직원 수동: 무게, 상품정보, 발송인, 플랫폼
    const row = [
      orderNo, routingCode, '',                    // A-C: OrderNo, RoutingCode, Tracking
      '', '', '', '',                              // D-G: AdditionalServices~SignatureService
      vatNumber, '', iossCode, '', '',            // H-L: VatNumber~UnifiedSocialCreditCode
      countryCode,                                 // M: CountryCode
      order.buyerName || '',                       // N: Name
      '', '',                                      // O-P: CertificateCode, Company
      order.street || '',                          // Q: Street
      order.city || '',                            // R: City
      order.province || '',                        // S: Province/State
      order.zipCode || '',                         // T: ZipCode
      (order.phone || '').replace(/^\+/, ''),      // U: phone
      '',                                          // V: HouseNumber
      order.email || '',                           // W: Email
      '', order.weightKg ? String(order.weightKg) : '', // X-Y: PackageNumber, PackageWeight
      '', '', '', '', '', '', '', '', '', '',      // Z-AI: Sender fields (직원)
      '', '', '', '', '', '',                      // AJ-AO: Platform fields (직원)
      '', '', '',                                  // AP-AR: EcommercePlatform~CurrencyCode (직원)
      '', '', '', '', '', '', '', '',              // AS-AZ: SKU~HsCode (직원)
    ];

    const nextRow = await this.findNextEmptyRow(spreadsheetId, sheetTab, 'A');
    await this.sheets.writeData(spreadsheetId, `'${sheetTab}'!A${nextRow}`, [row]);
    console.log(`✅ 윤익스프레스 시트 '${sheetTab}' 행 ${nextRow}에 주문 ${orderNo} 추가`);

    return { success: true, sheetTab, customerOrderNo: orderNo, spreadsheetId };
  }

  // ─── 쉽터 ──────────────────────────────────────────────────
  // 템플릿 구조 (발송인 G-M은 템플릿에 이미 채워져 있음):
  // A:배송국가 B:배송타입 C:주문번호 D-F:빈칸
  // G-M:발송인(템플릿 자동)
  // N:수취인이름 O:전화번호 P:이메일 Q:우편번호 R:State S:도시 T:주소1 U:주소2
  // V:수출신고여부 W:수출신고번호
  // X:무게(직원) Y:가로 Z:세로 AA:높이
  // AB:통관번호종류 AC:통관번호
  // AD:화폐(직원) AE:상품코드 AF:상품명 AG:수량 AH:단가 AI:브랜드 AJ:URL AK:HS CODE

  async addToShipter(config, order, opts = {}) {
    const { spreadsheetId } = config;

    const sheetTab = opts.sheetTab || await this.getOrCreateShipterTab(spreadsheetId);
    const countryCode = (order.countryCode || order.country || '').toUpperCase();
    const deliveryType = SHIPTER_DELIVERY_TYPES[countryCode] || `SHIPTER_${countryCode}`;
    const orderNo = order.orderId || '';

    // 통관번호 처리
    let customsType = '';
    let customsNumber = '';
    if (EU_COUNTRIES.has(countryCode)) {
      customsType = 'IOSS';
      customsNumber = YUNEXPRESS_IOSS;
    } else if (countryCode === 'AU') {
      customsNumber = AU_ABN;
    } else if (countryCode === 'BR') {
      customsType = 'CPF';
    } else if (countryCode === 'NO') {
      customsType = 'VOEC';
    }

    // 포맷 규칙 적용
    const email = order.email || 'info@ccorea.com';
    const phone = order.phone || '';
    const zipCode = (order.zipCode || '').replace(/^(\d{5}).*$/, '$1'); // 5자리만
    const state = (order.province || '').replace(/^([A-Z]{2}).*$/i, '$1').toUpperCase(); // 2자리

    // A~C만 쓰기 (G-M 발송인은 템플릿에 이미 있음)
    const rowAC = [
      countryCode,                                 // A: 배송국가
      deliveryType,                                // B: 배송타입
      orderNo,                                     // C: 주문번호
    ];

    // N~AC: 수취인 + 통관
    const rowNAC = [
      order.buyerName || '',                       // N: 수취인 이름
      phone,                                       // O: 수취인 전화번호
      email,                                       // P: 수취인 이메일
      zipCode,                                     // Q: 수취인 우편번호 (5자리)
      state,                                       // R: 수취인 State (2자리)
      order.city || '',                            // S: 수취인 도시
      order.street || '',                          // T: 수취인 주소1
      '',                                          // U: 수취인 주소2
      '', '',                                      // V-W: 수출신고 (빈칸)
      order.weightKg ? String(order.weightKg) : '',   // X: 무게(kg)
      order.dimL ? String(order.dimL) : '',            // Y: 가로(cm)
      order.dimW ? String(order.dimW) : '',            // Z: 세로(cm)
      order.dimH ? String(order.dimH) : '',            // AA: 높이(cm)
      customsType,                                 // AB: 통관번호종류
      customsNumber,                               // AC: 통관번호
    ];

    // C열(주문번호)에서 첫 빈 행 찾기 (템플릿 발송인 데이터는 A열에 있으므로 C열로 판단)
    const nextRow = await this.findNextEmptyRow(spreadsheetId, sheetTab, 'C');

    // A~C 쓰기, N~AC 쓰기 (G-M 발송인은 템플릿에 이미 있음)
    await Promise.all([
      this.sheets.writeData(spreadsheetId, `'${sheetTab}'!A${nextRow}:C${nextRow}`, [rowAC]),
      this.sheets.writeData(spreadsheetId, `'${sheetTab}'!N${nextRow}:AC${nextRow}`, [rowNAC]),
    ]);
    console.log(`✅ 쉽터 시트 '${sheetTab}' 행 ${nextRow}에 주문 ${orderNo} 추가`);

    return { success: true, sheetTab, customerOrderNo: orderNo, spreadsheetId };
  }

  // ─── 다보내 ─────────────────────────────────────────────────

  async addToDabonae(config, order, opts = {}) {
    const { spreadsheetId } = config;

    const sheetTab = opts.sheetTab || await this.getOrCreateDateTab(spreadsheetId, null);
    const countryCode = (order.countryCode || order.country || '').toUpperCase();
    const orderNo = order.orderId || '';

    // IOSS (EU 국가)
    let iossNumber = '';
    if (EU_COUNTRIES.has(countryCode)) {
      iossNumber = YUNEXPRESS_IOSS;
    }

    // 시스템 자동: 판매자정보, 수취인 주소
    // 직원 수동: 배송방식, 상품명, 수량, 금액, 중량
    const row = [
      'pmccopr',                                   // A(0): 판매자ID
      'OTHER',                                     // B(1): 판매자 쇼핑몰
      '', '', '',                                  // C-E(2-4): 빈칸
      '',                                          // F(5): 배송방식 (직원)
      '',                                          // G(6): 빈칸
      '',                                          // H(7): 상품명 (직원)
      '', '', '', '',                              // I-L(8-11): 빈칸
      '',                                          // M(12): 수량 (직원)
      '', '', '', '', '', '', '',                  // N-T(13-19): 빈칸
      orderNo,                                     // U(20): 주문번호
      order.buyerName || '',                       // V(21): 수취인명
      '', '',                                      // W-X(22-23): 빈칸
      (order.phone || '').replace(/^\+/, ''),      // Y(24): 수취인전화번호
      '',                                          // Z(25): 빈칸
      order.street || '',                          // AA(26): 수취인주소
      '',                                          // AB(27): 수취인주소2
      order.city || '',                            // AC(28): 수취인 도시
      order.province || '',                        // AD(29): 수취인 주
      '',                                          // AE(30): 빈칸
      order.zipCode || '',                         // AF(31): 우편번호
      countryCode,                                 // AG(32): 수취인 국가
      '',                                          // AH(33): 통화 (직원)
      '',                                          // AI(34): 결제금액 (직원)
      '',                                          // AJ(35): 메모
      '',                                          // AK(36): 보험가입
      '',                                          // AL(37): 중량 (직원)
      '', '',                                      // AM-AN(38-39): 결제방식, 사업자등록번호
      iossNumber,                                  // AO(40): IOSS 번호
    ];

    const nextRow = await this.findNextRow(spreadsheetId, sheetTab);
    await this.sheets.writeData(spreadsheetId, `'${sheetTab}'!A${nextRow}`, [row]);
    console.log(`✅ 다보내 시트 '${sheetTab}' 행 ${nextRow}에 주문 ${orderNo} 추가`);

    return { success: true, sheetTab, customerOrderNo: orderNo, spreadsheetId };
  }

  // ─── KPL ────────────────────────────────────────────────────

  async addToKPL(config, order, opts = {}) {
    const { spreadsheetId } = config;

    const sheetTab = opts.sheetTab || await this.getOrCreateDateTab(spreadsheetId, null);
    const countryCode = (order.countryCode || order.country || '').toUpperCase();
    const countryName = COUNTRY_NAMES[countryCode] || countryCode;
    const orderNo = order.orderId || '';
    const S = KPL_SENDER;

    // KPL 양식 (104열)
    // 시스템 자동: 주문번호, 발송인(고정), 수취인 주소
    // 직원 수동: 상품정보, 무게, 박스, 화폐, 화물타입
    const row = new Array(104).fill('');

    // 발송인 (고정)
    row[0]  = orderNo;                              // *고객 오더번호 (원본)
    row[4]  = S.name;                               // *발송자 이름
    row[5]  = S.phone;                              // 발송자 휴대폰
    row[7]  = S.address;                            // *발송자 주소
    row[9]  = S.city;                               // *발송자 도시
    row[10] = S.state;                              // *발송자 주
    row[11] = S.country;                            // *발송자 국가
    row[12] = S.zip;                                // *발송자 우편번호
    row[13] = S.email;                              // 발송자 이메일
    row[14] = 'Company';                            // 발송인 타입
    row[15] = S.company;                            // 발송자 회사명

    // 수취인
    row[22] = order.buyerName || '';                 // *수취인 이름
    row[24] = (order.phone || '').replace(/^\+/, ''); // 수취인 휴대폰
    row[26] = order.street || '';                    // *수취인 주소
    row[31] = order.city || '';                      // *수취인 도시
    row[32] = order.province || '';                  // *수취인 주
    row[33] = countryName;                           // *수취인 국가 (풀네임)
    row[34] = order.zipCode || '';                   // *수취인 우편번호
    row[35] = S.email;                              // 수취인 이메일
    row[36] = 'Personal';                           // 수취인 타입

    // 상품 정보 → 직원 수동 입력 (row[44]~row[69] 비워둠)

    const nextRow = await this.findNextRow(spreadsheetId, sheetTab);
    await this.sheets.writeData(spreadsheetId, `'${sheetTab}'!A${nextRow}`, [row]);
    console.log(`✅ KPL 시트 '${sheetTab}' 행 ${nextRow}에 주문 ${orderNo} 추가`);

    return { success: true, sheetTab, customerOrderNo: orderNo, spreadsheetId };
  }

  // ─── 공통 ──────────────────────────────────────────────────

  /**
   * 시트 탭에서 마지막 데이터 행 + 1 반환
   */
  async findNextRow(spreadsheetId, sheetTab) {
    try {
      const rows = await this.sheets.readData(spreadsheetId, `'${sheetTab}'!A:AZ`);
      const nextRow = (rows ? rows.length : 0) + 1;
      console.log(`   findNextRow('${sheetTab}'): ${nextRow}행`);
      return nextRow;
    } catch (err) {
      console.warn(`   findNextRow 에러 (기본 2행 사용): ${err.message}`);
      return 2;
    }
  }

  /**
   * 특정 열에서 첫 번째 빈 행 찾기 (템플릿처럼 일부 열이 미리 채워진 경우)
   * @param {string} col - 확인할 열 문자 (예: 'C')
   */
  async findNextEmptyRow(spreadsheetId, sheetTab, col = 'C') {
    try {
      const rows = await this.sheets.readData(spreadsheetId, `'${sheetTab}'!${col}:${col}`);
      if (!rows) return 2;
      // 행 1은 헤더, 행 2부터 빈 행 찾기
      for (let i = 1; i < rows.length; i++) {
        if (!rows[i][0] || rows[i][0].trim() === '') {
          console.log(`   findNextEmptyRow('${sheetTab}', ${col}): ${i + 1}행`);
          return i + 1;
        }
      }
      // 모두 채워져 있으면 마지막 행 다음
      const nextRow = rows.length + 1;
      console.log(`   findNextEmptyRow('${sheetTab}', ${col}): ${nextRow}행`);
      return nextRow;
    } catch (err) {
      console.warn(`   findNextEmptyRow 에러 (기본 2행 사용): ${err.message}`);
      return 2;
    }
  }

  /**
   * 오늘 날짜 탭 찾기 or 생성 (항상 오늘 날짜 사용)
   */
  async getOrCreateDateTab(spreadsheetId, headers) {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayTab = `${mm}/${dd}`;

    console.log(`📅 getOrCreateDateTab: 탭 '${todayTab}' 확인 중 (시트: ${spreadsheetId})`);

    const info = await this.sheets.getSpreadsheetInfo(spreadsheetId);
    const sheetList = info.sheets.map(s => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      index: s.properties.index,
    }));
    const sheetNames = sheetList.map(s => s.title);

    if (sheetNames.includes(todayTab)) {
      // 같은 이름의 탭이 존재 → 최근 탭인지 확인 (상위 30개 이내)
      const tabIndex = sheetNames.indexOf(todayTab);
      if (tabIndex < 30) {
        console.log(`   ✅ 탭 '${todayTab}' 이미 존재 (위치 ${tabIndex})`);
        return todayTab;
      }

      // 오래된 탭 (작년 데이터일 가능성) → 이름 변경 후 새로 생성
      const oldTab = sheetList[tabIndex];
      const oldName = `${todayTab}(old)`;
      console.log(`   ⚠️ '${todayTab}' 탭이 위치 ${tabIndex}에 있음 (오래된 탭) → '${oldName}'으로 이름 변경`);
      await this.sheets.renameSheet(spreadsheetId, oldTab.sheetId, oldName);
    }

    // 새 탭을 맨 앞에 생성
    await this.sheets.createSheet(spreadsheetId, todayTab, 0);
    if (headers) {
      await this.sheets.writeData(spreadsheetId, `'${todayTab}'!A1`, [headers]);
    }
    console.log(`   ✅ 새 탭 '${todayTab}' 생성 완료 (맨 앞 위치)`);
    return todayTab;
  }

  /**
   * 쉽터 전용: 템플릿 탭 복사 → 오늘 날짜 탭 생성
   * 하단의 "월/일 자동입력(...)" 탭을 복제하여 MM/DD 이름으로 맨 앞에 배치
   */
  async getOrCreateShipterTab(spreadsheetId) {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayTab = `${mm}/${dd}`;

    console.log(`📅 getOrCreateShipterTab: 탭 '${todayTab}' 확인 중`);

    const info = await this.sheets.getSpreadsheetInfo(spreadsheetId);
    const sheetList = info.sheets.map(s => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      index: s.properties.index,
    }));
    const sheetNames = sheetList.map(s => s.title);

    // 이미 오늘 탭이 있으면 재사용 (상위 30개 이내)
    if (sheetNames.includes(todayTab)) {
      const tabIndex = sheetNames.indexOf(todayTab);
      if (tabIndex < 30) {
        console.log(`   ✅ 탭 '${todayTab}' 이미 존재 (위치 ${tabIndex})`);
        return todayTab;
      }
      // 오래된 탭 → 이름 변경
      const oldTab = sheetList[tabIndex];
      await this.sheets.renameSheet(spreadsheetId, oldTab.sheetId, `${todayTab}(old)`);
    }

    // 템플릿 탭 찾기: "월/일 자동입력" 으로 시작하는 탭
    const template = sheetList.find(s => s.title.startsWith('월/일 자동입력'));
    if (!template) {
      console.warn(`   ⚠️ 템플릿 탭 '월/일 자동입력...' 없음 → 빈 탭 생성 fallback`);
      await this.sheets.createSheet(spreadsheetId, todayTab, 0);
      return todayTab;
    }

    // 템플릿 복사 → 맨 앞에 배치
    console.log(`   📋 템플릿 '${template.title}' (ID: ${template.sheetId}) 복사 → '${todayTab}'`);
    await this.sheets.duplicateSheet(spreadsheetId, template.sheetId, todayTab, 0);

    console.log(`   ✅ 탭 '${todayTab}' 템플릿 복사 완료 (맨 앞 위치, 발송인 자동 포함)`);
    return todayTab;
  }

  /**
   * 윤익스프레스 전용: 템플릿 탭 복사 → 오늘 날짜 탭 생성
   * '원본복사의 사본' 탭을 복제하여 MM/DD 이름으로 맨 앞에 배치
   */
  async getOrCreateYunikTab(spreadsheetId) {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayTab = `${mm}/${dd}`;

    console.log(`📅 getOrCreateYunikTab: 탭 '${todayTab}' 확인 중`);

    const info = await this.sheets.getSpreadsheetInfo(spreadsheetId);
    const sheetList = info.sheets.map(s => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      index: s.properties.index,
    }));
    const sheetNames = sheetList.map(s => s.title);

    // 이미 오늘 탭이 있으면 재사용 (상위 30개 이내)
    if (sheetNames.includes(todayTab)) {
      const tabIndex = sheetNames.indexOf(todayTab);
      if (tabIndex < 30) {
        console.log(`   ✅ 탭 '${todayTab}' 이미 존재 (위치 ${tabIndex})`);
        return todayTab;
      }
      // 오래된 탭 → 이름 변경
      const oldTab = sheetList[tabIndex];
      await this.sheets.renameSheet(spreadsheetId, oldTab.sheetId, `${todayTab}(old)`);
    }

    // 템플릿 탭 찾기: '원본복사의 사본'
    const template = sheetList.find(s => s.title === '원본복사의 사본');

    if (template) {
      // 템플릿 복사 시도 → 셀 한도 초과 시 오래된 시트 삭제 후 재시도
      try {
        console.log(`   📋 템플릿 '${template.title}' (ID: ${template.sheetId}) 복사 → '${todayTab}'`);
        await this.sheets.duplicateSheet(spreadsheetId, template.sheetId, todayTab, 0);
        console.log(`   ✅ 탭 '${todayTab}' 템플릿 복사 완료 (맨 앞 위치)`);
        return todayTab;
      } catch (dupErr) {
        if (dupErr.message && dupErr.message.includes('10000000')) {
          // 셀 한도 초과: 오래된 시트(맨 뒤부터) 삭제 후 재시도
          console.warn(`   ⚠️ 셀 한도 초과 — 오래된 시트 삭제 중...`);
          const protectedNames = new Set(['원본복사의 사본', todayTab]);
          const deletable = sheetList.filter(s => !protectedNames.has(s.title)).reverse();
          for (let i = 0; i < Math.min(3, deletable.length); i++) {
            try {
              console.log(`   🗑️ 오래된 시트 삭제: '${deletable[i].title}'`);
              await this.sheets.deleteSheet(spreadsheetId, deletable[i].sheetId);
            } catch (delErr) {
              console.warn(`   ⚠️ 시트 삭제 실패: ${delErr.message}`);
            }
          }
          // 재시도
          try {
            await this.sheets.duplicateSheet(spreadsheetId, template.sheetId, todayTab, 0);
            console.log(`   ✅ 오래된 시트 삭제 후 탭 '${todayTab}' 생성 성공`);
            return todayTab;
          } catch (retryErr) {
            console.warn(`   ⚠️ 재시도 실패 (${retryErr.message}) → fallback`);
          }
        } else {
          console.warn(`   ⚠️ 템플릿 복사 실패 (${dupErr.message}) → 빈 탭 + 헤더 복사 fallback`);
        }
      }
    }

    // fallback: 빈 탭 생성 후 템플릿 헤더(1행) 복사
    try {
      await this.sheets.createSheet(spreadsheetId, todayTab, 0);
    } catch (createErr) {
      if (createErr.message && createErr.message.includes('10000000')) {
        console.warn(`   ⚠️ 빈 탭 생성도 셀 한도 초과 — 오래된 시트 추가 삭제`);
        const protectedNames = new Set(['원본복사의 사본', todayTab]);
        const deletable = sheetList.filter(s => !protectedNames.has(s.title)).reverse();
        for (let i = 0; i < Math.min(5, deletable.length); i++) {
          try {
            await this.sheets.deleteSheet(spreadsheetId, deletable[i].sheetId);
          } catch {}
        }
        await this.sheets.createSheet(spreadsheetId, todayTab, 0);
      } else {
        throw createErr;
      }
    }
    if (template) {
      try {
        const headerRows = await this.sheets.readData(spreadsheetId, `'원본복사의 사본'!1:2`);
        if (headerRows && headerRows.length > 0) {
          await this.sheets.writeData(spreadsheetId, `'${todayTab}'!A1`, headerRows);
          console.log(`   ✅ 새 탭 '${todayTab}' 생성 + 템플릿 헤더 복사 완료`);
          return todayTab;
        }
      } catch (hdrErr) {
        console.warn(`   ⚠️ 헤더 복사 실패: ${hdrErr.message}`);
      }
    }

    // 최종 fallback: 하드코딩된 헤더
    await this.sheets.writeData(spreadsheetId, `'${todayTab}'!A1`, [YUNEXPRESS_HEADERS]);
    console.log(`   ✅ 새 탭 '${todayTab}' 생성 + 기본 헤더 기록 완료`);
    return todayTab;
  }

  /**
   * 배송사 시트의 날짜탭 목록 반환
   * @param {string} carrier - 배송사명
   * @returns {{ tabs: string[], today: string }}
   */
  async getDateTabs(carrier) {
    const config = CARRIER_SHEETS[carrier];
    if (!config) throw new Error(`배송사 '${carrier}' 시트 설정이 없습니다`);

    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayTab = `${mm}/${dd}`;

    const info = await this.sheets.getSpreadsheetInfo(config.spreadsheetId);
    const sheetNames = info.sheets.map(s => s.properties.title);
    const dateTabs = sheetNames.filter(n => /^\d{2}\//.test(n));

    return { tabs: dateTabs, today: todayTab };
  }

  /**
   * 주문번호 정규화 (6~50자, 영문/숫자/하이픈)
   */
  sanitizeOrderNo(orderId) {
    let no = (orderId || '').replace(/[^a-zA-Z0-9\-]/g, '');
    if (no.length < 6) no = no.padEnd(6, '0');
    if (no.length > 50) no = no.substring(0, 50);
    return no;
  }

  /**
   * 지원하는 배송사 목록
   */
  static getSupportedCarriers() {
    return Object.keys(CARRIER_SHEETS);
  }
}

CarrierSheets.EU_COUNTRIES = EU_COUNTRIES;
module.exports = CarrierSheets;
