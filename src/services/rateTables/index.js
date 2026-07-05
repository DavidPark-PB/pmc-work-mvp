/**
 * 배송사별 요율표 통합 export.
 *
 * ⚠️ 개별 요율 수정: shippingRates/<carrier>.js 파일만 수정.
 * ⚠️ 계산 로직 수정: shippingRateEngine.js.
 * ⚠️ 유류할증 수정: shippingRateEngine.js 상단 FUEL_SURCHARGE.
 */
'use strict';

const shipter = require('./shipter');
const kpl = require('./kpl');
const yun = require('./yun');
const kpacket = require('./kpacket');
const emsPremium = require('./emsPremium');

module.exports = {
  SHIPTER_RATES: shipter,
  KPL_RATES: kpl,
  YUN_RATES: yun,
  KPACKET_RATES: kpacket,
  EMS_PREMIUM_COUNTRY_ZONE: emsPremium.countryZone,
  EMS_PREMIUM_RATES: emsPremium.rates,
};
