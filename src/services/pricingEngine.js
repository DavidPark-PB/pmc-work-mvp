/**
 * 마진 기반 가격 자동 계산 엔진
 * 매입가 + 목표 마진율 → 플랫폼별 최적 판매가 역산
 */

const EXCHANGE_RATE = 1400;
const EXCHANGE_RATE_JPY = 1000;   // KRW → JPY
const EXCHANGE_RATE_SHOPEE = 1000; // KRW → 현지통화 (VND 등)
const TAX_RATE = 0.15;
const DEFAULT_SHIPPING_USD = 3.9;
const DEFAULT_DOMESTIC_SHIPPING_KRW = 3000;

const PLATFORM_FEES = {
  ebay: 0.18,
  shopify: 0.033,
  naver: 0.055,
  qoo10: 0.12,
  shopee: 0.15,
};

/**
 * 무게 기반 국제 배송비 추정 (KRW)
 * calculate-shipping.js의 간소화 버전 (YunExpress 기준)
 */
function estimateShippingKRW(weightKg) {
  if (!weightKg || weightKg <= 0) return DEFAULT_SHIPPING_USD * EXCHANGE_RATE;
  const weightG = weightKg * 1000;

  // YunExpress 경제 요율 (간소화)
  const rates = [
    { g: 100, krw: 3500 },
    { g: 200, krw: 4200 },
    { g: 500, krw: 5800 },
    { g: 1000, krw: 8500 },
    { g: 2000, krw: 14000 },
  ];

  if (weightG <= rates[0].g) return rates[0].krw;
  if (weightG >= rates[rates.length - 1].g) return rates[rates.length - 1].krw;

  for (let i = 0; i < rates.length - 1; i++) {
    if (weightG > rates[i].g && weightG <= rates[i + 1].g) {
      const ratio = (weightG - rates[i].g) / (rates[i + 1].g - rates[i].g);
      return Math.round(rates[i].krw + ratio * (rates[i + 1].krw - rates[i].krw));
    }
  }
  return DEFAULT_SHIPPING_USD * EXCHANGE_RATE;
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
function calculatePrices(product) {
  const purchasePrice = parseFloat(product.purchasePrice) || 0;
  const weight = parseFloat(product.weight) || 0;
  const targetMargin = product.targetMargin !== undefined && product.targetMargin !== '' ? parseFloat(product.targetMargin) : 30;
  const shippingUSD = parseFloat(product.shippingUSD) || DEFAULT_SHIPPING_USD;

  const shippingKRW = estimateShippingKRW(weight);
  const tax = Math.round(purchasePrice * TAX_RATE);
  const totalCostKRW = purchasePrice + shippingKRW + tax;

  const result = {};

  // eBay (USD, 수수료 18%)
  const ebayFee = PLATFORM_FEES.ebay;
  const ebayDivisor = 1 - ebayFee - targetMargin / 100;
  if (ebayDivisor > 0) {
    const ebayRevenueKRW = totalCostKRW / ebayDivisor;
    const ebayTotalUSD = ebayRevenueKRW / EXCHANGE_RATE;
    let ebayPrice = ebayTotalUSD - shippingUSD;
    ebayPrice = toPsychologicalPrice(ebayPrice, 'usd');
    const actualRevenue = (ebayPrice + shippingUSD) * EXCHANGE_RATE;
    const actualFee = actualRevenue * ebayFee;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;

    result.ebay = {
      price: ebayPrice,
      shipping: shippingUSD,
      currency: 'USD',
      estimatedProfit: Math.round(actualProfit),
      margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee),
      totalCost: totalCostKRW,
    };
  } else {
    result.ebay = { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - ebayFee) * 100) + '%)' };
  }

  // Shopify (USD, 수수료 3.3%)
  const shopifyFee = PLATFORM_FEES.shopify;
  const shopifyDivisor = 1 - shopifyFee - targetMargin / 100;
  if (shopifyDivisor > 0) {
    const shopifyRevenueKRW = totalCostKRW / shopifyDivisor;
    const shopifyTotalUSD = shopifyRevenueKRW / EXCHANGE_RATE;
    let shopifyPrice = shopifyTotalUSD - shippingUSD;
    shopifyPrice = toPsychologicalPrice(shopifyPrice, 'usd');
    const actualRevenue = (shopifyPrice + shippingUSD) * EXCHANGE_RATE;
    const actualFee = actualRevenue * shopifyFee;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;

    result.shopify = {
      price: shopifyPrice,
      shipping: shippingUSD,
      currency: 'USD',
      estimatedProfit: Math.round(actualProfit),
      margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee),
      totalCost: totalCostKRW,
    };
  } else {
    result.shopify = { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - shopifyFee) * 100) + '%)' };
  }

  // Naver (KRW, 수수료 5.5%)
  const naverFee = PLATFORM_FEES.naver;
  const naverCost = purchasePrice + DEFAULT_DOMESTIC_SHIPPING_KRW + tax;
  const naverDivisor = 1 - naverFee - targetMargin / 100;
  if (naverDivisor > 0) {
    let naverPrice = naverCost / naverDivisor;
    naverPrice = toPsychologicalPrice(naverPrice, 'krw');
    const actualFee = naverPrice * naverFee;
    const actualProfit = naverPrice - actualFee - naverCost;
    const actualMargin = naverPrice > 0 ? (actualProfit / naverPrice * 100) : 0;

    result.naver = {
      price: naverPrice,
      shipping: 0,
      currency: 'KRW',
      estimatedProfit: Math.round(actualProfit),
      margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee),
      totalCost: naverCost,
    };
  } else {
    result.naver = { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - naverFee) * 100) + '%)' };
  }

  // Qoo10 (JPY, 수수료 12%)
  const qoo10Fee = PLATFORM_FEES.qoo10;
  const qoo10Divisor = 1 - qoo10Fee - targetMargin / 100;
  if (qoo10Divisor > 0) {
    const qoo10RevenueKRW = totalCostKRW / qoo10Divisor;
    let qoo10Price = Math.round(qoo10RevenueKRW / EXCHANGE_RATE_JPY);
    qoo10Price = toPsychologicalPrice(qoo10Price, 'jpy');
    const actualRevenue = qoo10Price * EXCHANGE_RATE_JPY;
    const actualFee = actualRevenue * qoo10Fee;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;

    result.qoo10 = {
      price: qoo10Price,
      shipping: 0,
      currency: 'JPY',
      estimatedProfit: Math.round(actualProfit),
      margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee),
      totalCost: totalCostKRW,
    };
  } else {
    result.qoo10 = { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - qoo10Fee) * 100) + '%)' };
  }

  // Shopee (현지통화, 수수료 15%)
  const shopeeFee = PLATFORM_FEES.shopee;
  const shopeeDivisor = 1 - shopeeFee - targetMargin / 100;
  if (shopeeDivisor > 0) {
    const shopeeRevenueKRW = totalCostKRW / shopeeDivisor;
    let shopeePrice = Math.round(shopeeRevenueKRW / EXCHANGE_RATE_SHOPEE);
    shopeePrice = Math.ceil(shopeePrice); // 1단위 올림
    const actualRevenue = shopeePrice * EXCHANGE_RATE_SHOPEE;
    const actualFee = actualRevenue * shopeeFee;
    const actualProfit = actualRevenue - actualFee - totalCostKRW;
    const actualMargin = actualRevenue > 0 ? (actualProfit / actualRevenue * 100) : 0;

    result.shopee = {
      price: shopeePrice,
      shipping: 0,
      currency: 'LOCAL',
      estimatedProfit: Math.round(actualProfit),
      margin: +actualMargin.toFixed(1),
      fee: Math.round(actualFee),
      totalCost: totalCostKRW,
    };
  } else {
    result.shopee = { error: '목표 마진율이 너무 높습니다 (최대 ' + Math.floor((1 - shopeeFee) * 100) + '%)' };
  }

  return result;
}

/**
 * 마진 계산기 — 매입가 기반 전 플랫폼 가격 + 경쟁셀러 비교
 */
function calculateMargins(input) {
  const purchasePrice = parseFloat(input.purchasePrice) || 0;
  const weight = parseFloat(input.weight) || 0;
  const targetMargin = input.targetMargin !== undefined && input.targetMargin !== '' ? parseFloat(input.targetMargin) : 30;
  const competitorPrice = parseFloat(input.competitorPrice) || 0;
  const competitorShipping = parseFloat(input.competitorShipping) || 0;

  // 전 플랫폼 가격 계산
  const prices = calculatePrices({
    purchasePrice,
    weight,
    targetMargin,
    shippingUSD: DEFAULT_SHIPPING_USD,
  });

  // 경쟁셀러 마진 분석 (eBay 기준)
  let competitorAnalysis = null;
  if (competitorPrice > 0) {
    const shippingKRW = estimateShippingKRW(weight);
    const tax = Math.round(purchasePrice * TAX_RATE);
    const totalCostKRW = purchasePrice + shippingKRW + tax;

    const compTotalUSD = competitorPrice + competitorShipping;
    const compRevenueKRW = compTotalUSD * EXCHANGE_RATE;
    const compFee = compRevenueKRW * PLATFORM_FEES.ebay;
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
