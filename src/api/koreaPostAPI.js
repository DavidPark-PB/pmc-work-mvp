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

class KoreaPostAPI {
  constructor() {
    this.apiKey = process.env.KOREAPOST_API_KEY;
    this.custno = process.env.KOREAPOST_CUSTNO;          // 고객번호 (epost ID 연결)
    // 서비스별 계약승인번호 (K-Packet 과 EMS 가 다른 계약 → 다른 apprno)
    this.apprnoKpacket = process.env.KOREAPOST_APPRNO_KPACKET || process.env.KOREAPOST_APPRNO || '';
    this.apprnoEms     = process.env.KOREAPOST_APPRNO_EMS     || process.env.KOREAPOST_APPRNO || '';
    this.premiumcd = process.env.KOREAPOST_PREMIUMCD;     // 서비스 프리미엄 코드
    this.rateUrl = process.env.KOREAPOST_RATE_URL || DEFAULT_RATE_URL;
    this.trackUrl = process.env.KOREAPOST_TRACK_URL || DEFAULT_TRACK_URL;
    this.labelUrl = process.env.KOREAPOST_LABEL_URL;
    this._xmlParser = new xml2js.Parser({ explicitArray: false, trim: true, ignoreAttrs: false });
  }

  // 서비스 타입 → 해당 apprno 반환
  _apprnoFor(serviceType) {
    return serviceType === 'EMS' ? this.apprnoEms : this.apprnoKpacket;
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
   * 소포신청 → 운송장 번호 발급 + 라벨 PDF/ZPL.
   * @param {object} params
   *   - recipient: { name, phone, country, zip, addr1, addr2 }
   *   - parcel:    { weightG, dims:{l,w,h}, valueKrw, contents }
   *   - serviceType: 'EMS' | 'KPACKET'
   * @returns {Promise<{trackingNumber, labelBase64?, labelUrl?, cost}>}
   */
  async createParcel({ recipient, parcel, serviceType = 'KPACKET' }) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!this.labelUrl) throw new Error('KOREAPOST_LABEL_URL 미설정 — 우체국 Open API 매뉴얼에서 확인 후 env 설정 필요');
    if (!recipient?.country || !recipient?.zip) throw new Error('recipient 주소 정보 필수');

    const sender = this.shipper();
    try {
      // 매뉴얼 따라 body 구성 — POST 가 일반적이지만 일부 API 는 GET. 매뉴얼 확인 필요.
      const body = {
        authKey: this.apiKey,
        serviceType,
        sender,
        recipient,
        parcel,
      };
      const res = await axios.post(this.labelUrl, body, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });
      const d = res.data;
      // TODO: 매뉴얼 응답 구조에 맞춰 추출
      const trackingNumber = d?.trackingNumber || d?.rgistNo || null;
      const labelBase64 = d?.labelBase64 || d?.labelPdf || null;
      const labelUrl = d?.labelUrl || null;
      const cost = Number(d?.cost ?? d?.totalCharge ?? 0);
      if (!trackingNumber) throw new Error('운송장 번호 없음 (응답 구조 확인 필요)');
      return { trackingNumber, labelBase64, labelUrl, cost, raw: d };
    } catch (e) {
      console.error('[KoreaPost] createParcel 실패:', e.response?.data || e.message);
      throw new Error('우체국 라벨 발급 실패: ' + (e.response?.data?.error || e.message));
    }
  }
}

let _instance = null;
function getKoreaPostAPI() {
  if (!_instance) _instance = new KoreaPostAPI();
  return _instance;
}

module.exports = { KoreaPostAPI, getKoreaPostAPI };
