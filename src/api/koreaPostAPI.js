require('../config');
const axios = require('axios');

/**
 * 우체국 Open API 클라이언트.
 * biz.epost.go.kr 에서 발급받은 인증키 사용.
 *
 * 신청된 3개 API:
 *   1. EMS/K-Packet 요금 조회  → getRate()
 *   2. 종추적 조회                → track()
 *   3. 소포신청 (라벨 발급)       → createParcel()
 *
 * ⚠️ 환경변수에 endpoint URL 셋팅 필요 — 우체국 Open API 매뉴얼에서 확인:
 *   KOREAPOST_API_KEY              발급받은 인증키 (필수)
 *   KOREAPOST_RATE_URL             EMS/K-Packet 요금 조회 URL
 *   KOREAPOST_TRACK_URL            종추적 조회 URL
 *   KOREAPOST_LABEL_URL            소포신청 (라벨 발급) URL
 *   KOREAPOST_SHIPPER_NAME         발송인 정보 (라벨 발급용)
 *   KOREAPOST_SHIPPER_TEL
 *   KOREAPOST_SHIPPER_ZIP
 *   KOREAPOST_SHIPPER_ADDR
 */
class KoreaPostAPI {
  constructor() {
    this.apiKey = process.env.KOREAPOST_API_KEY;
    this.rateUrl = process.env.KOREAPOST_RATE_URL;
    this.trackUrl = process.env.KOREAPOST_TRACK_URL;
    this.labelUrl = process.env.KOREAPOST_LABEL_URL;
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
   * EMS / K-Packet 요금 조회.
   * @param {object} params
   *   - countryCode: ISO 2자리 (예: 'US', 'CA', 'GB')
   *   - weightG: 중량 (그램)
   *   - serviceType: 'EMS' | 'KPACKET' (기본 'KPACKET')
   * @returns {Promise<{cost: number, currency: 'KRW', etaDays: number, serviceType: string} | null>}
   */
  async getRate({ countryCode, weightG, serviceType = 'KPACKET' }) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!this.rateUrl) throw new Error('KOREAPOST_RATE_URL 미설정 — 우체국 Open API 매뉴얼에서 확인 후 env 설정 필요');
    if (!countryCode || !weightG) throw new Error('countryCode 와 weightG 필수');

    try {
      // 우체국 API 매뉴얼대로 query/body 구성 — 사장님이 docs 받으신 후 정확한 키 이름 채울 것.
      const params = {
        authKey: this.apiKey,         // 매뉴얼: 'serviceKey' 또는 'authKey' 또는 'regKey' 인지 확인
        countryCode,
        weight: weightG,
        serviceType,
      };
      const res = await axios.get(this.rateUrl, { params, timeout: 15000 });
      // 응답 파싱은 매뉴얼대로 — 보통 XML 또는 JSON. 여기선 JSON 가정.
      const d = res.data;
      // TODO: 매뉴얼 응답 구조에 맞춰 추출 (예: d.response.body.items.item.cost)
      const cost = Number(d?.cost ?? d?.totalCharge ?? d?.amount ?? 0);
      const etaDays = Number(d?.etaDays ?? d?.deliveryDays ?? null) || null;
      return cost > 0 ? { cost, currency: 'KRW', etaDays, serviceType } : null;
    } catch (e) {
      console.error('[KoreaPost] getRate 실패:', e.response?.data || e.message);
      throw new Error('우체국 요금 조회 실패: ' + (e.response?.data?.error || e.message));
    }
  }

  /**
   * 종추적 (운송장 번호로 현재 위치/상태 조회).
   * @param {string} trackingNumber - 등기번호
   * @returns {Promise<{status, events: Array<{at, location, description}>}>}
   */
  async track(trackingNumber) {
    if (!this.isConfigured()) throw new Error('KOREAPOST_API_KEY 미설정');
    if (!this.trackUrl) throw new Error('KOREAPOST_TRACK_URL 미설정 — 우체국 Open API 매뉴얼에서 확인 후 env 설정 필요');
    if (!trackingNumber) throw new Error('trackingNumber 필수');

    try {
      const params = {
        authKey: this.apiKey,
        trcKey: trackingNumber,        // 매뉴얼: 'trcKey' 또는 'rgistNo' 또는 'trackingNo' 확인
      };
      const res = await axios.get(this.trackUrl, { params, timeout: 15000 });
      const d = res.data;
      // TODO: 응답 구조에 맞춰 events 배열 파싱
      return {
        status: d?.status ?? 'unknown',
        events: Array.isArray(d?.events) ? d.events : [],
        raw: d,
      };
    } catch (e) {
      console.error('[KoreaPost] track 실패:', e.response?.data || e.message);
      throw new Error('우체국 종추적 실패: ' + (e.response?.data?.error || e.message));
    }
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
