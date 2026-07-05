/**
 * PMC 배송 요율 엔진 — pmc_shipping_engine_v2.py 의 JavaScript 포팅 (2026-06-23).
 *
 * 5개 배송사 (KPL / 쉽터 / 윤익스프레스 / EMS프리미엄 / K-Packet) 실제 요율 동시 계산 →
 * 부피중량 + 유류할증 반영 후 최저가 정렬 + 추천.
 *
 * 입력: country (한국어 또는 ISO 2-letter), actualKg, lengthCm, widthCm, heightCm
 * 출력: [{ carrier, service, chargeKg, volKg, base, fuel, total, note, isCheapest? }, ...]
 *
 * ⚠️ 요율 변경 시: src/services/rateTables/<carrier>.js 만 수정.
 * ⚠️ 유류할증 변경 시: 본 파일 FUEL_SURCHARGE 만 수정.
 * ⚠️ 국가명 매핑 변경 시: 본 파일 ISO_TO_KR 만 수정.
 */
'use strict';

const {
  SHIPTER_RATES,
  KPL_RATES,
  YUN_RATES,
  KPACKET_RATES,
  EMS_PREMIUM_COUNTRY_ZONE,
  EMS_PREMIUM_RATES,
} = require('./rateTables');

// ── 유류할증료 (변경 시 여기만 수정) ──────────────────────
const FUEL_SURCHARGE = {
  KPL:           0,      // SF Express: 면제
  shipter:       0,      // ALL IN 포함
  yun:           2000,   // 현재 kg당 +2,000원
  ems_premium:   0,      // 우체국: 별도 없음
  kpacket:       0,      // 우체국: 별도 없음
};

// ── ISO 2-letter ↔ 한국어 국가명 매핑 ─────────────────────
// orders.country_code 는 ISO. 요율표는 한국어 키. 매핑 필요.
const ISO_TO_KR = {
  JP: '일본', US: '미국', GB: '영국', DE: '독일', FR: '프랑스',
  IT: '이탈리아', BE: '벨기에', NL: '네덜란드', ES: '스페인',
  CA: '캐나다', AU: '호주', NZ: '뉴질랜드',
  HK: '홍콩', SG: '싱가포르', CN: '중국', TW: '대만',
  MY: '말레이시아', TH: '태국', PH: '필리핀', ID: '인도네시아',
  VN: '베트남', IN: '인도', MO: '마카오',
  BN: '브루나이', KH: '캄보디아',
  MX: '멕시코', BR: '브라질', AR: '아르헨티나', CL: '칠레', PE: '페루',
  SA: '사우디아라비아', AE: '아랍에미리트', EG: '이집트', ZA: '남아프리카공화국',
  AT: '오스트리아', BY: '벨라루스', FI: '핀란드', HN: '온두라스',
  IE: '아일랜드', IL: '이스라엘', KZ: '카자흐스탄', KG: '키르기스스탄',
  MN: '몽골', NP: '네팔', NO: '노르웨이', PK: '파키스탄',
  PL: '폴란드', SE: '스웨덴', CH: '스위스', TR: '튀르키예',
  UA: '우크라이나', UZ: '우즈베키스탄',
};

// ══════════════════════════════════════════════════════════════
// 계산 엔진
// ══════════════════════════════════════════════════════════════

/** 부피중량 (kg) = L × W × H / divisor. 치수 누락 시 0. */
function volWeight(l, w, h, divisor) {
  if (!l || !w || !h || !divisor) return 0;
  return Math.round((l * w * h) / divisor * 1000) / 1000;
}

/** 요율표 lookup. unit='g' 면 weight(kg) → g 환산 후 비교. */
function lookupRates(rates, weight, unit) {
  const w = unit === 'g' ? weight * 1000 : weight;
  for (const [threshold, price] of rates) {
    if (w <= threshold) return price;
  }
  return rates[rates.length - 1][1];
}

/** K-Packet 견적 (최대 2kg). 부피중량 포함해도 2kg 초과면 미지원. */
function getKpacketQuote(countryKr, actualKg, l, w, h) {
  if (!KPACKET_RATES[countryKr]) return null;
  if (actualKg > 2.0) return null;
  const volKg = volWeight(l, w, h, 6000);
  const chargeKg = Math.max(actualKg, volKg);
  if (chargeKg > 2.0) return null;
  const base = lookupRates(KPACKET_RATES[countryKr], chargeKg, 'kg');
  return {
    carrier: 'kpacket',
    carrierLabel: 'K-Packet',
    service: '우체국 K-Packet(등기)',
    chargeKg, volKg,
    base, fuel: 0, total: base,
    note: '최대 2kg / D+4~7일 / 종추적 / 서명없이 배달',
  };
}

/** EMS프리미엄 고중량특송 견적 (71kg 이상). */
function getEmsPremiumQuote(countryKr, actualKg, l, w, h) {
  const zone = EMS_PREMIUM_COUNTRY_ZONE[countryKr];
  if (!zone) return null;
  if (actualKg < 71) return null;
  const rates = EMS_PREMIUM_RATES[zone];
  if (!rates) return null;
  const volKg = volWeight(l, w, h, 6000);
  const chargeKg = Math.max(actualKg, volKg);
  const base = lookupRates(rates, chargeKg, 'kg');
  return {
    carrier: 'ems_premium',
    carrierLabel: 'EMS프리미엄',
    service: `우체국 EMS프리미엄(Zone ${zone})`,
    chargeKg, volKg,
    base, fuel: 0, total: base,
    note: `고중량특송 / Zone ${zone} / 최소 71kg`,
  };
}

/** KPL/쉽터/윤 공통 견적 계산. */
function _carrierQuote(carrierKey, label, rateTable, countryKr, actualKg, l, w, h) {
  const cfg = rateTable[countryKr];
  if (!cfg) return null;
  const volKg = volWeight(l, w, h, cfg.divisor);
  const chargeKg = Math.max(actualKg, volKg);
  const base = lookupRates(cfg.rates, chargeKg, cfg.unit);
  const fuelPerKg = FUEL_SURCHARGE[carrierKey] || 0;
  const fuel = Math.round(fuelPerKg * chargeKg);
  return {
    carrier: carrierKey,
    carrierLabel: label,
    service: cfg.service || '-',
    chargeKg, volKg,
    base, fuel, total: base + fuel,
    note: cfg.note || '',
  };
}

/**
 * 한국어 국가명 정규화. ISO 2-letter 면 매핑 + 한국어면 그대로.
 * @param {string} input — 'JP' / 'us' / '일본' / '미국' 등
 * @returns {string|null}
 */
function normalizeCountry(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  // ISO 2-letter
  if (/^[A-Za-z]{2}$/.test(s)) {
    return ISO_TO_KR[s.toUpperCase()] || null;
  }
  return s; // 한국어로 가정
}

/**
 * 전배송사 견적 → 최저가 정렬 + isCheapest 표시.
 *
 * @param {Object} opts
 * @param {string} opts.country — 한국어 또는 ISO 2-letter
 * @param {number} opts.actualKg — 실제 무게 (kg)
 * @param {number} [opts.lengthCm]
 * @param {number} [opts.widthCm]
 * @param {number} [opts.heightCm]
 * @returns {Array} quotes — 최저가 순. 첫 번째에 isCheapest=true.
 */
function getQuotes({ country, actualKg, lengthCm = 0, widthCm = 0, heightCm = 0 } = {}) {
  const countryKr = normalizeCountry(country);
  if (!countryKr) return [];
  const kg = Number(actualKg);
  if (!Number.isFinite(kg) || kg <= 0) return [];

  const l = Number(lengthCm) || 0;
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;

  const results = [];
  const kp = getKpacketQuote(countryKr, kg, l, w, h);
  if (kp) results.push(kp);

  const kpl = _carrierQuote('KPL', 'KPL', KPL_RATES, countryKr, kg, l, w, h);
  if (kpl) results.push(kpl);

  const sh = _carrierQuote('shipter', '쉽터', SHIPTER_RATES, countryKr, kg, l, w, h);
  if (sh) results.push(sh);

  const yun = _carrierQuote('yun', '윤익스프레스', YUN_RATES, countryKr, kg, l, w, h);
  if (yun) results.push(yun);

  const ep = getEmsPremiumQuote(countryKr, kg, l, w, h);
  if (ep) results.push(ep);

  results.sort((a, b) => a.total - b.total);
  if (results.length > 0) results[0].isCheapest = true;
  return results;
}

module.exports = {
  getQuotes,
  normalizeCountry,
  volWeight,
  ISO_TO_KR,
  FUEL_SURCHARGE,
  // 외부 점검용 — 테이블 직접 노출 (수정 X, 읽기 전용 가정)
  _tables: { KPL_RATES, SHIPTER_RATES, YUN_RATES, KPACKET_RATES, EMS_PREMIUM_RATES, EMS_PREMIUM_COUNTRY_ZONE },
};
