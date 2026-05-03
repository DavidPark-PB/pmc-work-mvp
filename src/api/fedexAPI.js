require('../config');
const axios = require('axios');

/**
 * FedEx API 클라이언트.
 * - OAuth 2.0 client_credentials grant (1시간 토큰 캐시).
 * - getRates: 견적 (POST /rate/v1/rates/quotes).
 * - createShipment: 라벨 + tracking 발급 (POST /ship/v1/shipments).
 *
 * 출발지 = 한국 창고 (KR), 모든 발송 international export.
 *
 * 환경변수 (config/.env):
 *   FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT_NUMBER
 *   FEDEX_API_BASE (sandbox: https://apis-sandbox.fedex.com / prod: https://apis.fedex.com)
 *   FEDEX_ORIGIN_NAME, FEDEX_ORIGIN_PHONE
 *   FEDEX_ORIGIN_STREET, FEDEX_ORIGIN_CITY, FEDEX_ORIGIN_STATE, FEDEX_ORIGIN_ZIP, FEDEX_ORIGIN_COUNTRY
 */
class FedexAPI {
  constructor() {
    this.clientId = process.env.FEDEX_CLIENT_ID;
    this.clientSecret = process.env.FEDEX_CLIENT_SECRET;
    this.accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;
    this.apiBase = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
    this._token = null;
    this._tokenExpiry = 0;
  }

  isConfigured() {
    return !!(this.clientId && this.clientSecret && this.accountNumber);
  }

  origin() {
    return {
      name: process.env.FEDEX_ORIGIN_NAME || 'PMC Corporation',
      phone: process.env.FEDEX_ORIGIN_PHONE || '',
      street: process.env.FEDEX_ORIGIN_STREET || '',
      city: process.env.FEDEX_ORIGIN_CITY || '',
      state: process.env.FEDEX_ORIGIN_STATE || '',
      zip: process.env.FEDEX_ORIGIN_ZIP || '',
      country: process.env.FEDEX_ORIGIN_COUNTRY || 'KR',
    };
  }

  // ── OAuth 토큰 발급 + 캐시 ──
  async getAccessToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    if (!this.isConfigured()) throw new Error('FedEx 자격증명이 설정되지 않았습니다 (FEDEX_CLIENT_ID/SECRET/ACCOUNT_NUMBER 필요)');

    const url = `${this.apiBase}/oauth/token`;
    try {
      const r = await axios.post(url,
        `grant_type=client_credentials&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      this._token = r.data.access_token;
      // FedEx 는 보통 3600 초. 안전하게 60초 빼고 캐시.
      this._tokenExpiry = Date.now() + Math.max(60, (r.data.expires_in || 3600) - 60) * 1000;
      return this._token;
    } catch (e) {
      const err = e.response?.data || e.message;
      console.error('[FedEx] OAuth 실패:', err);
      throw new Error('FedEx OAuth 실패: ' + (e.response?.data?.errors?.[0]?.message || e.message));
    }
  }

  // 주소 객체 정규화 (구조화된 b2b_buyers 필드 → FedEx 페이로드).
  _addr({ street, city, state, zip, country }) {
    return {
      streetLines: [String(street || '').trim()].filter(Boolean),
      city: String(city || '').trim() || undefined,
      stateOrProvinceCode: String(state || '').trim() || undefined,
      postalCode: String(zip || '').trim() || undefined,
      countryCode: String(country || '').trim().toUpperCase(),
    };
  }

  _packages(packages) {
    // packages: [{ weightKg, dimensions: { length, width, height } }, ...]
    return packages.map((p, i) => ({
      sequenceNumber: i + 1,
      weight: { units: 'KG', value: Number(p.weightKg) || 0.5 },
      dimensions: p.dimensions ? {
        length: Number(p.dimensions.length) || 1,
        width: Number(p.dimensions.width) || 1,
        height: Number(p.dimensions.height) || 1,
        units: 'CM',
      } : undefined,
    }));
  }

  // ── Rate API: 견적 ──
  async getRates({ destination, packages, customsValue, currency = 'USD' }) {
    const token = await this.getAccessToken();
    const origin = this.origin();
    const totalWeight = packages.reduce((s, p) => s + Number(p.weightKg || 0), 0);

    const body = {
      accountNumber: { value: this.accountNumber },
      requestedShipment: {
        shipper: { address: this._addr(origin) },
        recipient: { address: this._addr(destination) },
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        rateRequestType: ['LIST', 'ACCOUNT'],
        preferredCurrency: currency,
        totalPackageCount: packages.length,
        totalWeight,
        requestedPackageLineItems: this._packages(packages),
        customsClearanceDetail: customsValue ? {
          dutiesPayment: { paymentType: 'RECIPIENT' },
          commodities: [{
            description: 'General Merchandise',
            quantity: 1,
            quantityUnits: 'PCS',
            weight: { units: 'KG', value: totalWeight || 0.5 },
            customsValue: { amount: Number(customsValue), currency },
          }],
        } : undefined,
      },
    };

    try {
      const r = await axios.post(`${this.apiBase}/rate/v1/rates/quotes`, body, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-locale': 'en_US',
        },
        timeout: 30000,
      });
      const details = r.data?.output?.rateReplyDetails || [];
      return details.map(d => {
        const shipment = d.ratedShipmentDetails?.[0] || {};
        return {
          serviceType: d.serviceType,
          serviceName: d.serviceName || d.serviceType,
          cost: Number(shipment.totalNetCharge) || 0,
          currency: shipment.currency || currency,
          etaDays: d.deliveryDay || d.commit?.derivedTransitTimeInDays || null,
          deliveryDate: d.deliveryStation || d.commit?.derivedDateAndTime || null,
        };
      }).filter(s => s.cost > 0);
    } catch (e) {
      const err = e.response?.data?.errors?.[0]?.message || e.message;
      console.error('[FedEx] Rate API 실패:', e.response?.data || e.message);
      throw new Error('FedEx 견적 실패: ' + err);
    }
  }

  // ── Ship API: 라벨 생성 ──
  async createShipment({ destination, packages, serviceType, customs, recipientContact }) {
    const token = await this.getAccessToken();
    const origin = this.origin();
    const totalWeight = packages.reduce((s, p) => s + Number(p.weightKg || 0), 0);

    const body = {
      labelResponseOptions: 'URL_ONLY',
      requestedShipment: {
        shipper: {
          contact: {
            personName: origin.name,
            phoneNumber: origin.phone,
            companyName: origin.name,
          },
          address: this._addr(origin),
        },
        recipients: [{
          contact: {
            personName: recipientContact?.name || 'Recipient',
            phoneNumber: recipientContact?.phone || '0000000000',
            companyName: recipientContact?.company || recipientContact?.name || '',
          },
          address: this._addr(destination),
        }],
        shipDatestamp: new Date().toISOString().slice(0, 10),
        serviceType: serviceType || 'INTERNATIONAL_PRIORITY',
        packagingType: 'YOUR_PACKAGING',
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        shippingChargesPayment: {
          paymentType: 'SENDER',
          payor: { responsibleParty: { accountNumber: { value: this.accountNumber } } },
        },
        customsClearanceDetail: customs ? {
          dutiesPayment: { paymentType: 'RECIPIENT' },
          commercialInvoice: { termsOfSale: 'FOB' },
          commodities: (customs.commodities || [{
            description: 'General Merchandise',
            quantity: 1,
            quantityUnits: 'PCS',
            weight: { units: 'KG', value: totalWeight || 0.5 },
            unitPrice: { amount: Number(customs.totalValue) || 1, currency: customs.currency || 'USD' },
            customsValue: { amount: Number(customs.totalValue) || 1, currency: customs.currency || 'USD' },
            countryOfManufacture: customs.countryOfManufacture || 'KR',
            harmonizedCode: customs.hsCode || '950430', // 게임/장난감 일반
          }]),
        } : undefined,
        labelSpecification: {
          labelFormatType: 'COMMON2D',
          imageType: 'PDF',
          labelStockType: 'PAPER_85X11_TOP_HALF_LABEL',
        },
        requestedPackageLineItems: this._packages(packages),
      },
      accountNumber: { value: this.accountNumber },
    };

    try {
      const r = await axios.post(`${this.apiBase}/ship/v1/shipments`, body, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-locale': 'en_US',
        },
        timeout: 60000,
      });
      const out = r.data?.output;
      const transactionShipments = out?.transactionShipments?.[0] || {};
      const masterTracking = transactionShipments.masterTrackingNumber;
      const pieceResponses = transactionShipments.pieceResponses || [];
      // 라벨 PDF 는 packageDocuments[].url 또는 encodedLabel.
      const firstPiece = pieceResponses[0] || {};
      const labelDoc = (firstPiece.packageDocuments || [])[0] || {};
      const totalNet = Number(transactionShipments.shipmentRating?.shipmentRateDetails?.[0]?.totalNetCharge) || null;
      const currency = transactionShipments.shipmentRating?.shipmentRateDetails?.[0]?.currency || null;

      return {
        trackingNumber: masterTracking,
        labelUrl: labelDoc.url || null,                 // FedEx 호스팅 PDF URL
        labelBase64: labelDoc.encodedLabel || null,     // 또는 encoded base64
        shipmentId: transactionShipments.shipmentDocuments?.[0]?.shipmentId || null,
        cost: totalNet,
        currency,
        raw: transactionShipments,
      };
    } catch (e) {
      const err = e.response?.data?.errors?.[0]?.message || e.message;
      console.error('[FedEx] Ship API 실패:', JSON.stringify(e.response?.data || e.message, null, 2));
      throw new Error('FedEx 라벨 생성 실패: ' + err);
    }
  }
}

let _instance = null;
function getFedexAPI() {
  if (!_instance) _instance = new FedexAPI();
  return _instance;
}

module.exports = { FedexAPI, getFedexAPI };
