/**
 * 마진 기반 가격 자동 계산 엔진
 * 매입가 + 목표 마진율 → 플랫폼별 최적 판매가 역산
 *
 * DB-driven: calculatePrices(product, fees?, rates?) 형태로
 * platformRegistry에서 로드한 값을 외부에서 전달 가능.
 * fees/rates 미전달 시 하드코딩 기본값 사용 (하위호환).
 */

const DEFAULT_EXCHANGE_RATE = 1400;
const DEFAULT_EXCHANGE_RATE_JPY = 1000;
const DEFAULT_EXCHANGE_RATE_SHOPEE = 1000;
const DEFAULT_TAX_RATE = 0.15;
const DEFAULT_SHIPPING_USD = 3.9;
const DEFAULT_DOMESTIC_SHIPPING_KRW = 3000;

const DEFAULT_PLATFORM_FEES = {
  ebay: 0.18,
  shopify: 0.033,
  naver: 0.055,
  qoo10: 0.12,
  shopee: 0.15,
  coupang: 0.108,
  alibaba: 0.08,
};

// Backward-compatible aliases
const EXCHANGE_RATE = DEFAULT_EXCHANGE_RATE;
const EXCHANGE_RATE_JPY = DEFAULT_EXCHANGE_RATE_JPY;
const EXCHANGE_RATE_SHOPEE = DEFAULT_EXCHANGE_RATE_SHOPEE;
const PLATFORM_FEES = DEFAULT_PLATFORM_FEES;

/**
 * 무게 기반 국제 배송비 추정 (KRW)
 * calculate-shipping.js의 간소화 버전 (YunExpress 기준)
 */
function estimateShippingKRW(weightKg, exchangeRate) {
  const exRate = exchangeRate || DEFAULT_EXCHANGE_RATE;
  if (!weightKg || weightKg <= 0) return DEFAULT_SHIPPING_USD * exRate;
  const weightG = weightKg * 1000;

  // YunExpress 경제 요율 (간소화)
  const shippingRates = [
    { g: 100, krw: 3500 },
    { g: 200, krw: 4200 },
    { g: 500, krw: 5800 },
    { g: 1000, krw: 8500 },
    { g: 2000, krw: 14000 },
  ];

  if (weightG <= shippingRates[0].g) return shippingRates[0].krw;
  if (weightG >= shippingRates[shippingRates.length - 1].g) return shippingRates[shippingRates.length - 1].krw;

  for (let i = 0; i < shippingRates.length - 1; i++) {
    if (weightG > shippingRates[i].g && weightG <= shippingRates[i + 1].g) {
      const ratio = (weightG - shippingRates[i].g) / (shippingRates[i + 1].g - shippingRates[i].g);
      return Math.round(shippingRates[i].krw + ratio * (shippingRates[i + 1].krw - shippingRates[i].krw));
    }
  }
  return DEFAULT_SHIPPING_USD * exRate;
}

/**
 * 플랫폼별 가격 계산
 *
 * 공식:
 *   cost = purchasePrice + shippingKRW + tax
 *   margin = (revenue - cost) / revenue
 *   targetMargin = 1 - feeRate - cost / revenue
 *   revenue = cost / (1 - feeRate - targetMargin/100)
 *
 * eBay/Shopify (USD):
 *   (price + shippingUSD) × exchangeRate = revenue
 *   price = revenue / exchangeRate - shippingUSD
 *
 * Naver (KRW):
 *   price = revenue (직접)
 */
/**
 * @param {object} product - { purchasePrice, weight, targetMargin, shippingUSD }
 * @param {object} [fees] - Platform fee rates from DB, e.g. { ebay: 0.18, shopify: 0.033 }
 * @param {object} [rates] - Exchange rates from DB, e.g. { usd: 1400, jpy: 1000 }
 */
function calculatePrices(product, fees, rates) {
  const purchasePrice = parseFloat(product.purchasePrice) || 0;
  const weight = parseFloat(product.weight) || 0;
  const targetMargin = product.targetMargin !== undefined && product.targetMargin !== '' ? parseFloat(product.targetMargin) : 30;
  const shippingUSD = parseFloat(product.shippingUSD) || DEFAULT_SHIPPING_USD;

  // Use DB values if provided, otherwise fall back to hardcoded defaults
  const f = fees || DEFAULT_PLATFORM_FEES;
  const exUSD = (rates && rates.usd) || DEFAULT_EXCHANGE_RATE;
  const exJPY = (rates && rates.jpy) || DEFAULT_EXCHANGE_RATE_JPY;
  const exLOCAL = (rates && rates.local) || DEFAULT_EXCHANGE_RATE_SHOPEE;
  const taxRate = (rates && rates.tax_rate) || DEFAULT_TAX_RATE;
  const domesticShipping = (rates && rates.domestic_shipping_krw) || DEFAULT_DOMESTIC_SHIPPING_KRW;

  const shippingKRW = estimateShippingKRW(weight, exUSD);
  const tax = Math.round(purchasePrice * taxRate);
  const totalCostKRW = purchasePrice + shippingKRW + tax;

  const result = {};

  // Helper: calculate price for a global (USD) platform
  function calcGlobalUSD(key, feeRate, currency) {
    const divisor = 1 - feeRate - targetMargin / 100;
    if (divisor <= 0) {
      return { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - feeRate) * 100) + '%)' };
    }
    const revenueKRW = totalCostKRW / divisor;
    const totalUSD = revenueKRW / exUSD;
    let price = totalUSD - shippingUSD;
    price = toPsychologicalPrice(price, 'usd');
    const actualRevenue = (price + shippingUSD) * exUSD;
    const actualFee = actualRevenue * feeRate;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;
    return {
      price, shipping: shippingUSD, currency: currency || 'USD',
      estimatedProfit: Math.round(actualProfit), margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee), totalCost: totalCostKRW,
    };
  }

  // Helper: calculate price for a domestic (KRW) platform
  function calcDomesticKRW(key, feeRate) {
    const domesticCost = purchasePrice + domesticShipping + tax;
    const divisor = 1 - feeRate - targetMargin / 100;
    if (divisor <= 0) {
      return { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - feeRate) * 100) + '%)' };
    }
    let price = domesticCost / divisor;
    price = toPsychologicalPrice(price, 'krw');
    const actualFee = price * feeRate;
    const actualProfit = price - actualFee - domesticCost;
    const actualMargin = price > 0 ? (actualProfit / price * 100) : 0;
    return {
      price, shipping: 0, currency: 'KRW',
      estimatedProfit: Math.round(actualProfit), margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee), totalCost: domesticCost,
    };
  }

  // Helper: calculate price for JPY platform
  function calcJPY(key, feeRate) {
    const divisor = 1 - feeRate - targetMargin / 100;
    if (divisor <= 0) {
      return { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - feeRate) * 100) + '%)' };
    }
    const revenueKRW = totalCostKRW / divisor;
    let price = Math.round(revenueKRW / exJPY);
    price = toPsychologicalPrice(price, 'jpy');
    const actualRevenue = price * exJPY;
    const actualFee = actualRevenue * feeRate;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;
    return {
      price, shipping: 0, currency: 'JPY',
      estimatedProfit: Math.round(actualProfit), margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee), totalCost: totalCostKRW,
    };
  }

  // Helper: calculate price for LOCAL currency platform
  function calcLocal(key, feeRate) {
    const divisor = 1 - feeRate - targetMargin / 100;
    if (divisor <= 0) {
      return { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - feeRate) * 100) + '%)' };
    }
    const revenueKRW = totalCostKRW / divisor;
    let price = Math.round(revenueKRW / exLOCAL);
    price = Math.ceil(price);
    const actualRevenue = price * exLOCAL;
    const actualFee = actualRevenue * feeRate;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;
    return {
      price, shipping: 0, currency: 'LOCAL',
      estimatedProfit: Math.round(actualProfit), margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee), totalCost: totalCostKRW,
    };
  }

  // Currency routing per platform
  const currencyMap = {
    ebay: 'USD', shopify: 'USD', alibaba: 'USD',
    naver: 'KRW', coupang: 'KRW',
    qoo10: 'JPY',
    shopee: 'LOCAL',
  };

  // Calculate for all platforms that have fee rates
  for (const [key, feeRate] of Object.entries(f)) {
    const currency = currencyMap[key] || 'USD';
    switch (currency) {
      case 'KRW':
        result[key] = calcDomesticKRW(key, feeRate);
        break;
      case 'JPY':
        result[key] = calcJPY(key, feeRate);
        break;
      case 'LOCAL':
        result[key] = calcLocal(key, feeRate);
        break;
      default: // USD
        result[key] = calcGlobalUSD(key, feeRate, currency);
    }
  }

  return result;
}

/**
 * 마진 계산기 — 매입가 기반 전 플랫폼 가격 + 경쟁셀러 비교
 */
/**
 * @param {object} input - { purchasePrice, weight, targetMargin, competitorPrice, competitorShipping }
 * @param {object} [fees] - Platform fee rates from DB
 * @param {object} [rates] - Exchange rates from DB
 */
function calculateMargins(input, fees, rates) {
  const purchasePrice = parseFloat(input.purchasePrice) || 0;
  const weight = parseFloat(input.weight) || 0;
  const targetMargin = input.targetMargin !== undefined && input.targetMargin !== '' ? parseFloat(input.targetMargin) : 30;
  const competitorPrice = parseFloat(input.competitorPrice) || 0;
  const competitorShipping = parseFloat(input.competitorShipping) || 0;

  const f = fees || DEFAULT_PLATFORM_FEES;
  const exUSD = (rates && rates.usd) || DEFAULT_EXCHANGE_RATE;
  const taxRate = (rates && rates.tax_rate) || DEFAULT_TAX_RATE;

  // 전 플랫폼 가격 계산
  const prices = calculatePrices({
    purchasePrice,
    weight,
    targetMargin,
    shippingUSD: DEFAULT_SHIPPING_USD,
  }, fees, rates);

  // 경쟁셀러 마진 분석 (eBay 기준)
  let competitorAnalysis = null;
  if (competitorPrice > 0) {
    const shippingKRW = estimateShippingKRW(weight, exUSD);
    const tax = Math.round(purchasePrice * taxRate);
    const totalCostKRW = purchasePrice + shippingKRW + tax;

    const compTotalUSD = competitorPrice + competitorShipping;
    const compRevenueKRW = compTotalUSD * exUSD;
    const ebayFee = f.ebay || DEFAULT_PLATFORM_FEES.ebay;
    const compFee = compRevenueKRW * ebayFee;
    const compProfit = compRevenueKRW - compFee - totalCostKRW;
    const compMargin = compRevenueKRW > 0 ? (compProfit / compRevenueKRW * 100) : 0;

    const myEbay = prices.ebay || {};
    const myTotalUSD = (myEbay.price || 0) + (myEbay.shipping || 0);
    const diff = myTotalUSD - compTotalUSD;

    competitorAnalysis = {
      totalUSD: +compTotalUSD.toFixed(2),
      price: competitorPrice,
      shipping: competitorShipping,
      revenueKRW: Math.round(compRevenueKRW),
      feeKRW: Math.round(compFee),
      profitKRW: Math.round(compProfit),
      margin: +compMargin.toFixed(1),
      myTotalUSD: +myTotalUSD.toFixed(2),
      priceDiff: +diff.toFixed(2),
      totalCostKRW,
    };
  }

  return { prices, competitorAnalysis, input: { purchasePrice, weight, targetMargin, competitorPrice, competitorShipping } };
}

/**
 * 심리적 가격 조정
 * USD: $x.99 형태, KRW: 100원 단위 올림
 */
function toPsychologicalPrice(price, currency) {
  if (currency === 'usd') {
    if (price <= 0) return 0.99;
    return Math.ceil(price) - 0.01; // 예: 7.3 → 7.99 (=8-0.01)
  }
  if (currency === 'krw') {
    if (price <= 0) return 100;
    return Math.ceil(price / 100) * 100; // 100원 단위 올림
  }
  if (currency === 'jpy') {
    if (price <= 0) return 10;
    return Math.ceil(price / 10) * 10; // 10엔 단위 올림
  }
  return Math.round(price * 100) / 100;
}

module.exports = { calculatePrices, calculateMargins, estimateShippingKRW, EXCHANGE_RATE, EXCHANGE_RATE_JPY, EXCHANGE_RATE_SHOPEE, PLATFORM_FEES };
