require('../config');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * 우체국 Open API 클라이언트.
 * biz.epost.go.kr 에서 발급받은 인증키 사용.
 *
 * 신청된 3개 API:
 *   1. EMS/K-Packet 요금 조회  → getRate()  (TODO: 매뉴얼 받으면 endpoint 확정)
 *   2. 종추적 조회                → track()    (✅ 매뉴얼 확인 — biz.epost.go.kr/KpostPortal/openapi)
 *   3. 소포신청 (라벨 발급)       → createParcel() (TODO: 매뉴얼)
 *
 * 환경변수:
 *   KOREAPOST_API_KEY              발급받은 인증키 (필수, 30자리 'regkey' 로 전송)
 *   KOREAPOST_CUSTNO               고객번호 (epost ID 연결, 예: 0005077976)
 *   KOREAPOST_APPRNO_KPACKET       K-Packet 계약승인번호 (예: 40139J1076)
 *   KOREAPOST_APPRNO_EMS           EMS 계약국제특급 계약승인번호 (예: 40139H1226)
 *   KOREAPOST_APPRNO               (Legacy) 둘 다 같은 값 사용 시 fallback
 *   KOREAPOST_PREMIUMCD            서비스 프리미엄 코드 (예: 14 — 매뉴얼 확인)
 *   KOREAPOST_RATE_URL             EMS/K-Packet 요금 URL (기본: eship.epost.go.kr/api/EmsTotProcCmd.ems)
 *   KOREAPOST_TRACK_URL            종추적 URL (기본: biz.epost.go.kr/KpostPortal/openapi)
 *   KOREAPOST_LABEL_URL            접수신청 URL (기본: eship.epost.go.kr/api/EmsApplyInsertReceiveTempCmdNew.ems)
 *   KOREAPOST_SHIPPER_*            발송인 정보 (라벨 발급용)
 */
const DEFAULT_TRACK_URL = 'http://biz.epost.go.kr/KpostPortal/openapi';
const DEFAULT_RATE_URL = 'http://eship.epost.go.kr/api/EmsTotProcCmd.ems';
// 소포신청 — base 가 또 다름 (eship 아니라 ship). 인증 파라미터도 key (regkey 아님).
const DEFAULT_LABEL_URL = 'http://ship.epost.go.kr/api/InsertOrder.jparcel';
// 국제 EMS/K-Packet 접수신청 (다른 base 사용)
const DEFAULT_INTL_LABEL_URL = 'http://eship.epost.go.kr/api/EmsApplyInsertReceiveTempCmdNew.ems';

class KoreaPostAPI {
  constructor() {
    this.apiKey = process.env.KOREAPOST_API_KEY;
    this.custno = process.env.KOREAPOST_CUSTNO;          // 고객번호 (epost ID 연결)
    // 서비스별 계약승인번호 (K-Packet 과 EMS 가 다른 계약 → 다른 apprno)
    this.apprnoKpacket = process.env.KOREAPOST_APPRNO_KPACKET || process.env.KOREAPOST_APPRNO || '';
    this.apprnoEms     = process.env.KOREAPOST_APPRNO_EMS     || process.env.KOREAPOST_APPRNO || '';
    // 국내 계약소포 (ship.epost.go.kr) — 사장님 PMC 계약 2026-06-24 확인 4013980899 (즉납, 동수원).
    this.apprnoDomestic = process.env.KOREAPOST_APPRNO_DOMESTIC || '';
    // 국내 공급지(발송지/회수도착지) 코드. InsertOffice.jparcel 로 사전 등록 후 받은 값.
    this.domesticOfficeSer = process.env.KOREAPOST_OFFICE_SER || '';
    this.premiumcd = process.env.KOREAPOST_PREMIUMCD;     // 서비스 프리미엄 코드
    this.rateUrl = process.env.KOREAPOST_RATE_URL || DEFAULT_RATE_URL;
    this.trackUrl = process.env.KOREAPOST_TRACK_URL || DEFAULT_TRACK_URL;
    // 라벨 endpoint — 두 종류:
    //   1. 국내 소포: ship.epost.go.kr/api/InsertOrder.jparcel  (key 인증)
    //   2. 국제 EMS/K-Packet: eship.epost.go.kr/api/EmsApplyInsertReceiveTempCmdNew.ems  (key 인증)
    // PMC 는 국제 발송 위주이므로 기본은 국제용. 환경변수로 override 가능.
    this.labelUrl = process.env.KOREAPOST_LABEL_URL || DEFAULT_INTL_LABEL_URL;
    this.domesticLabelUrl = process.env.KOREAPOST_DOMESTIC_LABEL_URL || DEFAULT_LABEL_URL;
    this._xmlParser = new xml2js.Parser({ explicitArray: false, trim: true, ignoreAttrs: false });
  }

  // 서비스 타입 → 해당 apprno 반환
  _apprnoFor(serviceType) {
    if (serviceType === 'EMS') return this.apprnoEms;
    if (serviceType === 'DOMESTIC' || serviceType === 'PARCEL') return this.apprnoDomestic;
    return this.apprnoKpacket;
  }

  // 우체국 API 공통 호출 helper (사장님 검증 2026-06-24).
  //   - Host header 명시 X (매뉴얼은 'Host: biz.epost.go.kr' 라고 했지만 실제로 그 헤더 있으면
  //     307 redirect → 에러 페이지. 그 헤더 빼고 HTTPS 사용 시 정상)
  //   - User-Agent 는 매뉴얼 권장값
  //   - 응답 = XML (text)
  async _callXml(url, params, opts = {}) {
    const axios = require('axios');
    const res = await axios.get(url, {
      params,
      timeout: opts.timeout || 20000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Apache-HttpClient/4.5.1 (Java/1.8.0_91)',
        'Connection': 'keep-alive',
        'Accept': 'application/xml,text/xml,*/*',
      },
      // 우체국 https 인증서 이슈 회피 — 일단 verify 유지
      validateStatus: () => true,
    });
    const xml = res.data;
    const parsed = await this._xmlParser.parseStringPromise(xml);
    const root = parsed && Object.values(parsed)[0];
    return { root, xml, parsed, status: res.status };
  }

  // ════════════════════════════════════════════════════════════════════════
  // 국내 계약소포 API (ship.epost.go.kr) — 사장님 매뉴얼 기준
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 국내 계약승인번호 조회 (COMAPI-R01-02) — 사장님 PMC 계약 list 확인.
   * 평문: 'custNo=고객번호'
   * @returns {Promise<{contractInfo: Array<{apprNo,payTypeCd,payTypeNm,postNm}>, raw}>}
   */
  async listDomesticContracts() {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!this.custno) throw new Error('KOREAPOST_CUSTNO 미설정');
    const url = 'https://ship.epost.go.kr/api.GetApprNo.jparcel';
    const regData = this._buildRegData({ custNo: this.custno });
    const { root, status } = await this._callXml(url, { key: this.apiKey, regData });
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (root?.error) throw new Error(`우체국 ${root.error.error_code}: ${root.error.message}`);
    const list = root?.contractInfo
      ? (Array.isArray(root.contractInfo) ? root.contractInfo : [root.contractInfo])
      : [];
    return { contractInfo: list, raw: root };
  }

  /**
   * 국내 공급지 정보 조회 (SHPAPI-R01-01) — 사전 등록된 공급지 list.
   * 평문: 'custNo=고객번호&officeDivReqCd=(선택, 7=전체)'
   */
  async listDomesticOffices(officeDivReqCd = null) {
    if (!this.custno) throw new Error('KOREAPOST_CUSTNO 미설정');
    const url = 'https://ship.epost.go.kr/api.GetOfficeInfo.jparcel';
    const plain = { custNo: this.custno };
    if (officeDivReqCd) plain.officeDivReqCd = officeDivReqCd;
    const regData = this._buildRegData(plain);
    const { root } = await this._callXml(url, { key: this.apiKey, regData });
    if (root?.error) throw new Error(`우체국 ${root.error.error_code}: ${root.error.message}`);
    const list = root?.officeInfo
      ? (Array.isArray(root.officeInfo) ? root.officeInfo : [root.officeInfo])
      : [];
    return { offices: list, raw: root };
  }

  /**
   * 국내 공급지 등록 (SHPAPI-C01-01) — 발송지 정보 사전 등록.
   * @param {Object} office  { officeSer, officeNm, officeZip, officeAddr1, officeAddr2, officeTelno, contactNm, ... }
   */
  async createDomesticOffice(office) {
    if (!this.custno) throw new Error('KOREAPOST_CUSTNO 미설정');
    const url = 'https://ship.epost.go.kr/api.InsertOffice.jparcel';
    const regData = this._buildRegData({ custNo: this.custno, ...office });
    const { root } = await this._callXml(url, { key: this.apiKey, regData });
    if (root?.error) throw new Error(`우체국 ${root.error.error_code}: ${root.error.message}`);
    return root;
  }

  /**
   * 국내 소포신청 = 라벨 발급 (SHPAPI-C02-01).
   * 매뉴얼: api.InsertOrder.jparcel + SEED128 + UTF-8.
   *
   * 필수 필드 (매뉴얼 기준):
   *   custNo, apprNo, payType, reqType, officeSer, microYn, orderNo, ordCompNm,
   *   recNm, recZip, recAddr1, recAddr2, recTel 또는 recMob, contCd, goodsNm
   *
   * @param {Object} order
   *   - orderNo: 업체측 주문번호 (unique key)
   *   - recipient: { name, zip, addr1, addr2, tel, mob }
   *   - parcel: { weight(kg), volume(cm), contCd, goodsNm, qty }
   *   - payType: '1' (즉납/후납) 기본 / '2' (수취인 부담)
   *   - reqType: '1' (일반소포) 기본 / '2' (반품소포)
   *   - testYn: 'Y' 면 테스트 모드 (실제 접수 X) — 검증 시 권장
   * @returns {Promise<{regiNo, reqNo, resNo, price, ...}>}
   */
  async createDomesticOrder({ order, payType = '1', reqType = '1', testYn = 'N' }) {
    if (!this.custno) throw new Error('KOREAPOST_CUSTNO 미설정');
    if (!this.apprnoDomestic) throw new Error('KOREAPOST_APPRNO_DOMESTIC 미설정');
    if (!this.domesticOfficeSer) {
      throw new Error('KOREAPOST_OFFICE_SER 미설정 — 사전에 createDomesticOffice() 호출하여 공급지 등록 후 받은 officeSer 환경변수 입력 필요');
    }
    if (!order?.orderNo) throw new Error('order.orderNo 필수');
    if (!order?.recipient?.name) throw new Error('recipient.name 필수');
    if (!order?.recipient?.zip) throw new Error('recipient.zip 필수');
    if (!order?.recipient?.addr1) throw new Error('recipient.addr1 필수');

    const r = order.recipient;
    const p = order.parcel || {};
    const plain = {
      custNo: this.custno,
      apprNo: this.apprnoDomestic,
      payType,
      reqType,
      officeSer: this.domesticOfficeSer,
      weight: p.weight || 1,                  // kg (정수)
      volume: p.volume || 60,                 // cm (가로+세로+높이)
      microYn: p.microYn || 'N',              // 초소형 여부
      orderNo: String(order.orderNo).slice(0, 50),
      ordCompNm: order.ordCompNm || 'PMC Corporation',
      // 수취인 정보
      recNm:    r.name,
      recZip:   r.zip,
      recAddr1: r.addr1,
      recAddr2: r.addr2 || '',
      recTel:   r.tel || '',
      recMob:   r.mob || '',
      // 상품
      contCd:   p.contCd || '021',            // 매뉴얼 코드 (일반 의류 등)
      goodsNm:  (p.goodsNm || 'General Merchandise').slice(0, 400),
      qty:      p.qty || 1,
      // 옵션
      testYn,
      printYn: 'N',
    };

    const url = 'https://ship.epost.go.kr/api.InsertOrder.jparcel';
    const regData = this._buildRegData(plain);
    const { root, status, xml } = await this._callXml(url, { key: this.apiKey, regData });
    if (status !== 200) throw new Error(`HTTP ${status}: ${xml.slice(0, 200)}`);
    if (root?.error) throw new Error(`우체국 ${root.error.error_code}: ${root.error.message}`);
    return {
      regiNo: root?.regiNo,            // 운송장번호 (등기번호)
      reqNo: root?.reqNo,              // 소포 주문번호
      resNo: root?.resNo,              // 예약번호
      price: root?.price,              // 예상 요금
      regipoNm: root?.regipoNm,        // 접수 우체국명
      vTelNo: root?.vTelNo,            // 가상 전화번호
      refineAddr: root?.refineAddr,    // 정제 도로명주소
      raw: root,
    };
  }

  /**
   * 계약승인번호 조회 — 고객번호로 발급받은 apprno 목록 조회.
   * 매뉴얼: eship.epost.go.kr/api/EmsPrcPayMethodList.ems
   * apprno 모를 때 호출 → 결과로 env 채울 값 확인 가능.
   */
  async listAppreNoByCustno() {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!this.custno) throw new Error('KOREAPOST_CUSTNO 미설정');
    // 매뉴얼: regData 가 고객번호의 보안 hash 형태일 가능성 — 일단 raw custno 시도, 응답 보고 조정.
    const url = 'http://eship.epost.go.kr/api/EmsPrcPayMethodList.ems';
    const params = { regkey: this.apiKey, regData: this.custno };
    try {
      const res = await axios.get(url, { params, timeout: 15000, responseType: 'text' });
      return await this._xmlParser.parseStringPromise(res.data);
    } catch (e) {
      console.error('[KoreaPost] listAppreNoByCustno 실패:', e.response?.data || e.message);
      throw e;
    }
  }

  isConfigured() { return !!this.apiKey; }

  shipper() {
    return {
      name: process.env.KOREAPOST_SHIPPER_NAME || 'PMC Corporation',
      tel: process.env.KOREAPOST_SHIPPER_TEL || '',
      zip: process.env.KOREAPOST_SHIPPER_ZIP || '',
      addr: process.env.KOREAPOST_SHIPPER_ADDR || '',
    };
  }

  /**
   * EMS / K-Packet 배송예상비용 조회.
   * 매뉴얼: eship.epost.go.kr/api/EmsTotProcCmd.ems
   *
   * @param {object} params
   *   - countryCode: ISO 2자리 (예: 'US', 'CA', 'GB')
   *   - weightG: 중량 (그램)
   *   - serviceType: 'EMS' | 'KPACKET' (em_ee 코드 결정용 — 매뉴얼 확인 필요)
   *   - boxDims: { width, height, length } (cm) — 부피 무게 계산용
   * @returns {Promise<{cost, currency:'KRW', etaDays, serviceType, raw} | null>}
   */
  async getRate({ countryCode, weightG, serviceType = 'KPACKET', boxDims = null }) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    const apprno = this._apprnoFor(serviceType);
    if (!apprno) throw new Error(`${serviceType} 계약승인번호 미설정 — KOREAPOST_APPRNO_${serviceType === 'EMS' ? 'EMS' : 'KPACKET'} env 필요`);
    if (!countryCode || !weightG) throw new Error('countryCode 와 weightG 필수');

    // em_ee 코드: 매뉴얼 확인 후 정확히. 일단 K-Packet=ka, EMS=el 로 추정.
    const emEe = serviceType === 'EMS' ? 'el' : 'ka';
    const premiumcd = this.premiumcd || '14';

    const params = {
      regkey: this.apiKey,
      premiumcd,
      countrycd: countryCode,
      totweight: Math.round(weightG),
      boyn: 'N',                     // 배송보험 미사용
      boprc: 0,
      em_ee: emEe,
      apprno,
      boxwidth: boxDims?.width ? Math.round(boxDims.width) : 10,
      boxheight: boxDims?.height ? Math.round(boxDims.height) : 10,
      boxlength: boxDims?.length ? Math.round(boxDims.length) : 10,
    };

    try {
      const res = await axios.get(this.rateUrl, { params, timeout: 15000, responseType: 'text' });
      const xml = res.data;
      const parsed = await this._xmlParser.parseStringPromise(xml);
      // 응답 루트는 매뉴얼대로. 보통 ERR-* 가 있으면 에러. 정상이면 cost/charge 필드.
      const root = parsed && Object.values(parsed)[0];
      if (root?.error_code || /^ERR-/i.test(String(root?.error_code || ''))) {
        throw new Error(`우체국 API 에러 ${root.error_code}: ${root.message || ''}`);
      }
      // 매뉴얼 응답 키 이름 (totCharge / cost / charge 등) 확인 후 정리.
      // 일단 가능성 높은 키들 시도.
      const tryKey = (obj, keys) => keys.map(k => obj?.[k]).find(v => v != null && v !== '');
      const cost = Number(tryKey(root, ['totCharge', 'totcharge', 'TOTAL_CHARGE', 'cost', 'charge', 'amount', 'price'])) || 0;
      const etaDays = Number(tryKey(root, ['delivday', 'deliveryDays', 'etaDays'])) || null;
      return cost > 0 ? { cost, currency: 'KRW', etaDays, serviceType, raw: root } : null;
    } catch (e) {
      console.error('[KoreaPost] getRate 실패:', e.response?.data || e.message);
      throw new Error('우체국 요금 조회 실패: ' + (e.response?.data?.error || e.message));
    }
  }

  /**
   * 종추적 (운송장 번호로 현재 위치/상태 조회).
   * 매뉴얼 (biz.epost.go.kr/KpostPortal/openapi) 정확히 반영.
   *
   * @param {string} trackingNumber - 등기번호 (국내 13자리, 국제 EM*KR 등)
   * @param {object} opts
   *   - target: 'auto' (기본) | 'trace'(국내) | 'emsTrace'(국제 한글) | 'emsEngTrace'(국제 영문)
   *   - showRec: 'Y' | 'N' (기본 N — 종추적 '접수' 정보 포함 여부)
   * @returns {Promise<{events, sender, receiver, status, raw}>}
   */
  async track(trackingNumber, opts = {}) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!trackingNumber) throw new Error('trackingNumber 필수');

    // target 자동 판별: EM 또는 RR 시작 + KR 끝 = 국제, 13자리 숫자 = 국내
    let target = opts.target || 'auto';
    if (target === 'auto') {
      const t = String(trackingNumber).trim().toUpperCase();
      target = /^[A-Z]{2}\d+KR$/.test(t) ? 'emsEngTrace' : 'trace';
    }

    const params = {
      regkey: this.apiKey,
      target,
      query: trackingNumber,
      showRec: opts.showRec || 'N',
    };

    try {
      const res = await axios.get(this.trackUrl, { params, timeout: 15000, responseType: 'text' });
      const xml = res.data;
      const parsed = await this._xmlParser.parseStringPromise(xml);
      // 응답 루트는 매뉴얼 응답 형식에 따라 다름. 보통 <package> 또는 <openapi> 등.
      // 응답 키 (sendnm, recevnm, regino, eventnm, eventymd 등) 정규화.
      const root = parsed && Object.values(parsed)[0]; // 최상위 루트 element
      const items = this._extractTrackItems(root);
      const first = items[0] || {};
      return {
        sender: first.sendnm || '',
        receiver: first.recevnm || '',
        regino: first.regino || trackingNumber,
        mailType: first.mailtypenm || '',
        country: first.destcountrynm || '',
        events: items.map(it => ({
          at: `${it.eventymd || ''} ${it.eventhms || ''}`.trim(),
          location: it.eventregiponm || '',
          description: it.eventnm || '',
          deliveryResult: it.delivrsltnm || it.eventnm || '',
        })),
        raw: parsed,
      };
    } catch (e) {
      console.error('[KoreaPost] track 실패:', e.response?.data || e.message);
      throw new Error('우체국 종추적 실패: ' + (e.response?.data?.error || e.message));
    }
  }

  // 응답 루트에서 종추적 이벤트 항목 배열 추출.
  // 매뉴얼: <package><progress>...</progress>... </package> 또는 array 형태.
  _extractTrackItems(root) {
    if (!root) return [];
    // 가능한 경로: root.progress, root.item, root.items, 또는 평면 객체
    const candidates = [root.progress, root.item, root.items, root.events, root];
    for (const c of candidates) {
      if (!c) continue;
      if (Array.isArray(c)) return c;
      if (typeof c === 'object' && (c.eventnm || c.regino || c.sendnm)) return [c];
    }
    return [];
  }

  /**
   * 소포신청 → 운송장 번호 발급 + 라벨.
   * 매뉴얼 endpoint:
   *   - 국제 (EMS/K-Packet): eship.epost.go.kr/api/EmsApplyInsertReceiveTempCmdNew.ems
   *   - 국내 (소포): ship.epost.go.kr/api/InsertOrder.jparcel
   * 인증 파라미터: 'key' (regkey 아님 — 주의)
   *
   * ⚠️ regData 파라미터는 인증키+요청데이터의 hash/암호화 값.
   *    매뉴얼의 "암호화 샘플코드 (JAVA, PHP)" 다운로드 후 정확한 알고리즘 구현 필요.
   *    현재는 stub — 실제 호출 전에 _buildRegData() 채워야 함.
   *
   * @param {object} params
   *   - recipient: { name, phone, country, zip, addr1, addr2 }
   *   - parcel:    { weightG, dims:{l,w,h}, valueKrw, contents }
   *   - serviceType: 'EMS' | 'KPACKET' (기본 KPACKET)
   *   - domestic: false (기본) | true — 국내 소포면 true
   * @returns {Promise<{trackingNumber, labelBase64?, labelUrl?, cost}>}
   */
  async createParcel({ recipient, parcel, serviceType = 'KPACKET', domestic = false }) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!recipient?.country || !recipient?.zip) throw new Error('recipient 주소 정보 필수');

    const url = domestic ? this.domesticLabelUrl : this.labelUrl;
    if (!url) throw new Error('우체국 라벨 endpoint 미설정');

    const sender = this.shipper();
    const apprno = this._apprnoFor(serviceType);

    // regData 빌드 — 매뉴얼 샘플 코드 받으면 정확한 hash 구현 필요.
    const regData = this._buildRegData({ recipient, parcel, sender, serviceType, apprno });

    try {
      // 매뉴얼: GET 방식 query string. 인증 파라미터는 'key'.
      const params = { key: this.apiKey, regData };
      const res = await axios.get(url, { params, timeout: 30000, responseType: 'text' });
      const xml = res.data;
      const parsed = await this._xmlParser.parseStringPromise(xml);
      const root = parsed && Object.values(parsed)[0];
      // 에러 체크
      if (root?.error?.error_code || /^ERR-/i.test(String(root?.error?.error_code || ''))) {
        throw new Error(`우체국 API 에러 ${root.error.error_code}: ${root.error.message || ''}`);
      }
      // 응답 구조는 매뉴얼 확인 후 정확히 (TODO: regino, labelImage 등 키 이름 확정)
      const tryKey = (obj, keys) => keys.map(k => obj?.[k]).find(v => v != null && v !== '');
      const trackingNumber = tryKey(root, ['regino', 'rgistNo', 'trackingNumber', 'orderNo']);
      const labelBase64 = tryKey(root, ['labelImage', 'labelBase64', 'labelPdf']);
      const labelUrl = tryKey(root, ['labelUrl', 'imageUrl', 'pdfUrl']);
      const cost = Number(tryKey(root, ['totCharge', 'cost', 'charge', 'amount'])) || 0;
      if (!trackingNumber) throw new Error('운송장 번호 없음 (응답 구조 확인 필요 — 매뉴얼 PDF 참조)');
      return { trackingNumber, labelBase64, labelUrl, cost, raw: parsed };
    } catch (e) {
      console.error('[KoreaPost] createParcel 실패:', e.response?.data || e.message);
      throw new Error('우체국 라벨 발급 실패: ' + (e.response?.data?.error || e.message));
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // EMS / K-Packet 접수신청 (eship.epost.go.kr) — 사장님 매뉴얼 line 100~200 기준
  // ════════════════════════════════════════════════════════════════════════

  /**
   * 우체국 발송인 전화번호 → 4부분 분리 (sendertelno1~4 / sendermobile1~4).
   * 매뉴얼: 국가코드 / 지역번호 / 국번 / 번호. 한국 휴대폰은 82 / 10 / 4105 / 4826 형식.
   */
  _splitKoreanTel(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return ['', '', '', ''];
    // 01041054826 또는 821041054826 처리
    const noLeadingZero = digits.startsWith('0') ? digits.slice(1) : (digits.startsWith('82') ? digits.slice(2) : digits);
    // 10/4105/4826 또는 10/4105/4826
    if (noLeadingZero.length >= 9) {
      const region = noLeadingZero.slice(0, 2);                    // 10
      const mid = noLeadingZero.slice(2, noLeadingZero.length - 4);// 4105
      const last = noLeadingZero.slice(-4);                         // 4826
      return ['82', region, mid, last];
    }
    return ['82', '', '', noLeadingZero];
  }

  /**
   * EMS / K-Packet 접수신청 = 라벨 발급 (EMSAPI-R01-01).
   * 매뉴얼 endpoint: eship.epost.go.kr/api.EmsApplyInsertReceiveTempCmdNew.ems
   *
   * @param {Object} input
   *   - order: { orderNo, paymentAmount, currency, sku }
   *   - recipient: { name, zip, addr1, addr2, addr3, tel, countryCode }
   *   - parcel: { weightG, dims:{l,w,h}, contents, qty, valueUSD, hsCode? }
   *   - serviceType: 'KPACKET' (기본) | 'EMS' (em_ee 'em' 비서류)
   *   - vatdscrnno: EU IOSS / GB EORI 등 (선택)
   * @returns {Promise<{regino, reqno, cost, raw}>}
   */
  async createKPacketParcel({ order, recipient, parcel, serviceType = 'KPACKET', vatdscrnno = null }) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    const apprno = this._apprnoFor(serviceType);
    if (!apprno) throw new Error(`${serviceType} 계약승인번호 미설정 (KOREAPOST_APPRNO_${serviceType === 'EMS' ? 'EMS' : 'KPACKET'})`);
    if (!this.custno) throw new Error('KOREAPOST_CUSTNO 미설정');

    const s = this.shipper();
    const sTel = this._splitKoreanTel(s.tel);

    // 발송인 주소 — 한 줄을 3 줄로 분리 (매뉴얼 line 200 spec).
    //   1: 상세 (호수, 도로명+번호)
    //   2: 시/군/구
    //   3: 도/시
    const sAddrParts = String(s.addr || '').split(',').map(x => x.trim()).filter(Boolean);
    const senderaddr1 = (sAddrParts.slice(0, sAddrParts.length - 2).join(', ') || s.addr || '').slice(0, 200);
    const senderaddr2 = (sAddrParts[sAddrParts.length - 2] || '').slice(0, 50);
    const senderaddr3 = (sAddrParts[sAddrParts.length - 1] || '').slice(0, 50);

    // 우편물 구분 코드 (매뉴얼 line 230):
    //   K-Packet → premiumcd=14, em_ee=rl
    //   EMS 비서류 → premiumcd=31, em_ee=em
    //   EMS 서류 → premiumcd=31, em_ee=ee
    const premiumcd = serviceType === 'EMS' ? '31' : '14';
    const em_ee = serviceType === 'EMS' ? 'em' : 'rl';

    const valueUSD = Number(parcel.valueUSD || parcel.value || 1);
    const currunitcd = (parcel.currency === 'EUR' ? 'EUR' : 'USD');
    const hsCode = parcel.hsCode || '950430';   // 게임/장난감 default

    const plain = {
      custno: this.custno,
      apprno,
      premiumcd,
      em_ee,
      countrycd: String(recipient.countryCode || '').toUpperCase(),
      totweight: Math.max(1, Math.round(Number(parcel.weightG) || 0)),
      boyn: 'N',                              // 보험 미사용
      nextdayreserveyn: 'N',                  // 익일 예약 X
      orderno: String(order?.orderNo || '').slice(0, 50),

      // 발송인
      sender: s.name || 'PMC Corporation',
      senderzipcode: String(s.zip || '').replace(/\D/g, '').slice(0, 6),
      senderaddr1,
      senderaddr2,
      senderaddr3,
      sendertelno1: sTel[0], sendertelno2: sTel[1], sendertelno3: sTel[2], sendertelno4: sTel[3],
      sendermobile1: sTel[0], sendermobile2: sTel[1], sendermobile3: sTel[2], sendermobile4: sTel[3],

      // 수취인
      receivename:    String(recipient.name || '').slice(0, 35),
      receivezipcode: String(recipient.zip || '').slice(0, 20),
      receiveaddr1:   String(recipient.addr1 || '').slice(0, 50),
      receiveaddr2:   String(recipient.addr2 || '').slice(0, 50),
      receiveaddr3:   String(recipient.addr3 || '').slice(0, 200),
      receivetelno:   String(recipient.tel || '').slice(0, 40),

      // 세관/내용품
      EM_gubun: 'Merchandise',
      contents: String(parcel.contents || 'Toys').slice(0, 70),
      number:   String(parcel.qty || 1).slice(0, 7),
      weight:   String(Math.round(Number(parcel.weightG) || 1)).slice(0, 10),  // g
      value:    String(Math.round(valueUSD)).slice(0, 15),
      hs_code:  String(hsCode).slice(0, 10),
      origin:   'KR',
      currunitcd,

      // 박스
      boxlength: String(Math.round(Number(parcel.dims?.l) || 20)),
      boxwidth:  String(Math.round(Number(parcel.dims?.w) || 20)),
      boxheight: String(Math.round(Number(parcel.dims?.h) || 10)),
    };
    if (vatdscrnno) plain.vatdscrnno = vatdscrnno;

    const regData = this._buildRegData(plain);
    const url = process.env.KOREAPOST_LABEL_URL
      || 'https://eship.epost.go.kr/api.EmsApplyInsertReceiveTempCmdNew.ems';

    const { root, status, xml } = await this._callXml(url, {
      key: this.apiKey, option: '001', regData,
    });
    if (status !== 200) throw new Error(`HTTP ${status}: ${xml.slice(0, 200)}`);
    if (root?.error?.error_code) throw new Error(`우체국 ${root.error.error_code}: ${root.error.message}`);
    if (root?.error_code) throw new Error(`우체국 ${root.error_code}: ${root.message}`);

    return {
      regino: root?.regino,         // 운송장 번호 (예: LI...KR)
      reqno: root?.reqno,
      cost: Number(root?.prerecevprc || root?.totCharge || root?.cost) || 0,
      exchgPoCd: root?.exchgPoCd,
      raw: root,
    };
  }

  /**
   * regData 빌드 (사장님이 우체국 매뉴얼 + SEED128 샘플코드 제공 2026-06-24):
   *   1. 평문 = key=value&key=value... (URL-encode 없이, 매뉴얼 예시와 일치)
   *   2. SEED-128 ECB + zero padding + 보안키 (KOREAPOST_SEED_KEY, 16자) 로 암호화
   *   3. 결과 bytes → hex string (lowercase)
   *
   * 보안키 우체국 매뉴얼 정책: 30일 미사용 시 자동 만료 → 재발급 필요.
   *
   * @param {Object} params  평문 파라미터 객체 (예: { custno: '...', apprno: '...', ... })
   * @returns {string} hex string
   */
  _buildRegData(params) {
    const seedKey = process.env.KOREAPOST_SEED_KEY;
    if (!seedKey) {
      throw new Error('KOREAPOST_SEED_KEY 환경변수 미설정 (우체국 보안키 16 ASCII 문자)');
    }
    if (seedKey.length !== 16) {
      throw new Error(`KOREAPOST_SEED_KEY 길이 ${seedKey.length} — SEED-128 은 정확히 16 ASCII 문자 필요`);
    }
    // 매뉴얼 평문 예시: 'custNo=0001234567&reqType=1&officeSer=01&weight=5'
    const plain = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const seed = require('../lib/seed128');
    return seed.encrypt(seedKey, plain);
  }

  /**
   * SEED128 self-test — 호환성 확인용. 사장님이 PHP/JAVA 샘플코드의 결과와 우리 JS
   * 결과가 같은지 비교 가능. 진단 endpoint 에서 호출.
   * @returns {{ ok: boolean, rfcVector3_passed: boolean, roundTripPassed: boolean, sample: object }}
   */
  testSeed() {
    const seed = require('../lib/seed128');
    const { seedRoundKey, seedEncrypt, bytesToHex } = seed._internal;

    // KISA SEED-128 표준 vector 3 (RFC 4269 Appendix B.3 와 동일)
    const v3 = {
      key:    [0x47,0x06,0x48,0x08,0x51,0xE6,0x1B,0xE8,0x5D,0x74,0xBF,0xB3,0xFD,0x95,0x61,0x85],
      plain:  [0x83,0xA2,0xF8,0xA2,0x88,0x64,0x1F,0xB9,0xA4,0xE9,0xA5,0xCC,0x2F,0x13,0x1C,0x7D],
      cipher: 'ee54d13ebcae706d226bc3142cd40d4a',
    };
    const rk = seedRoundKey(new Uint8Array(v3.key));
    const enc = seedEncrypt(new Uint8Array(v3.plain), rk);
    const v3Pass = bytesToHex(enc) === v3.cipher;

    // 사장님 보안키 round-trip (있을 때만)
    let rtPass = null;
    let sample = null;
    const sk = process.env.KOREAPOST_SEED_KEY;
    if (sk && sk.length === 16) {
      const plain = 'custno=0001234567&apprno=40139J1076';
      const encHex = seed.encrypt(sk, plain);
      const dec = seed.decrypt(sk, encHex);
      rtPass = dec === plain;
      sample = { plain, encHex, dec };
    }

    return {
      ok: v3Pass && rtPass !== false,
      kisaVector3Passed: v3Pass,
      roundTripPassed: rtPass,
      sample,
    };
  }
}

let _instance = null;
function getKoreaPostAPI() {
  if (!_instance) _instance = new KoreaPostAPI();
  return _instance;
}

module.exports = { KoreaPostAPI, getKoreaPostAPI };
