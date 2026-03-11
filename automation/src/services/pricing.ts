/**
 * 가격 계산 엔진
 *
 * KRW 매입가 → USD 판매가 변환
 * 마진율, 플랫폼 수수료, 배송비를 반영한 최종 가격 산출
 */
import { db } from '../db/index.js';
import { shippingRates, pricingSettings } from '../db/schema.js';
import { and, eq, lte, gte } from 'drizzle-orm';

// 플랫폼별 수수료율 (DB에 설정이 없을 때 폴백)
const PLATFORM_FEES: Record<string, number> = {
  ebay: 0.13,     // 13%
  shopify: 0.05,  // 5% (Shopify Payments)
  alibaba: 0.05,  // 5% (ICBU)
  shopee: 0.06,   // 6%
};

// 기본 환율 (DB에 설정이 없을 때 폴백)
const DEFAULT_KRW_TO_USD = 1400;

// 기본 배송비 (DB에 설정이 없을 때 폴백)
const DEFAULT_SHIPPING_KRW = 5500;

export interface PricingSettingsData {
  marginRate: number;
  exchangeRate: number;
  platformFeeRate: number;
  defaultShippingKrw: number;
}

export interface PricingResult {
  salePrice: number;      // USD 판매가
  shippingCost: number;   // USD 배송비
  costUsd: number;        // USD 환산 매입가
  marginRate: number;     // 실제 마진율
  platformFee: number;    // 플랫폼 수수료 (USD)
  shippingKrw: number;    // 배송비 (KRW)
}

export interface PricingOptions {
  marginRate?: number;       // 목표 마진율 (기본 0.30 = 30%)
  exchangeRate?: number;     // KRW→USD 환율 (기본 1400)
  platform?: string;         // 'ebay' | 'shopify'
  shippingCarrier?: string;  // 'YunExpress' | 'K-Packet'
}

/**
 * DB에서 플랫폼별 가격 설정 조회 (없으면 하드코딩 폴백)
 */
export async function getPricingSettings(platform: string): Promise<PricingSettingsData> {
  const row = await db.query.pricingSettings.findFirst({
    where: eq(pricingSettings.platform, platform),
  });

  if (row) {
    return {
      marginRate: parseFloat(String(row.marginRate)),
      exchangeRate: parseFloat(String(row.exchangeRate)),
      platformFeeRate: parseFloat(String(row.platformFeeRate)),
      defaultShippingKrw: parseFloat(String(row.defaultShippingKrw)),
    };
  }

  return {
    marginRate: 0.30,
    exchangeRate: DEFAULT_KRW_TO_USD,
    platformFeeRate: PLATFORM_FEES[platform] || 0.13,
    defaultShippingKrw: DEFAULT_SHIPPING_KRW,
  };
}

/**
 * 모든 플랫폼의 가격 설정 조회
 */
export async function getAllPricingSettings(): Promise<Record<string, PricingSettingsData>> {
  const rows = await db.query.pricingSettings.findMany();
  const result: Record<string, PricingSettingsData> = {};

  for (const row of rows) {
    result[row.platform] = {
      marginRate: parseFloat(String(row.marginRate)),
      exchangeRate: parseFloat(String(row.exchangeRate)),
      platformFeeRate: parseFloat(String(row.platformFeeRate)),
      defaultShippingKrw: parseFloat(String(row.defaultShippingKrw)),
    };
  }

  // 없는 플랫폼은 폴백 추가
  for (const platform of ['ebay', 'shopify', 'alibaba', 'shopee']) {
    if (!result[platform]) {
      result[platform] = {
        marginRate: 0.30,
        exchangeRate: DEFAULT_KRW_TO_USD,
        platformFeeRate: PLATFORM_FEES[platform] || 0.13,
        defaultShippingKrw: DEFAULT_SHIPPING_KRW,
      };
    }
  }

  return result;
}

/**
 * DB에서 배송비 조회
 */
async function getShippingRate(weightG: number, carrier = 'YunExpress'): Promise<number> {
  const rate = await db.query.shippingRates.findFirst({
    where: and(
      eq(shippingRates.carrier, carrier),
      lte(shippingRates.minWeight, weightG),
      gte(shippingRates.maxWeight, weightG),
      eq(shippingRates.isActive, true),
    ),
  });

  return rate ? parseFloat(String(rate.rate)) : DEFAULT_SHIPPING_KRW;
}

/**
 * 가격 계산 메인 함수
 *
 * 공식: salePrice = (costKRW + shippingKRW) / exchangeRate / (1 - marginRate - platformFee)
 */
export async function calculateListingPrice(
  costKRW: number,
  weightG: number,
  options: PricingOptions = {},
): Promise<PricingResult> {
  const platform = options.platform || 'ebay';
  const settings = await getPricingSettings(platform);

  const marginRate = options.marginRate ?? settings.marginRate;
  const exchangeRate = options.exchangeRate ?? settings.exchangeRate;
  const platformFeeRate = settings.platformFeeRate;
  const shippingCarrier = options.shippingCarrier || 'YunExpress';

  // 1. 배송비 (KRW)
  const shippingKrw = await getShippingRate(weightG, shippingCarrier);

  // 2. USD 환산
  const costUsd = costKRW / exchangeRate;
  const shippingUsd = shippingKrw / exchangeRate;

  // 3. 역산: 마진 + 수수료를 보장하는 판매가
  const targetRevenue = (costUsd + shippingUsd) * (1 + marginRate);
  const totalPrice = targetRevenue / (1 - platformFeeRate);
  const salePrice = Math.ceil((totalPrice - shippingUsd) * 100) / 100;
  const platformFee = (salePrice + shippingUsd) * platformFeeRate;

  return {
    salePrice: Math.max(salePrice, 0.99),
    shippingCost: Math.ceil(shippingUsd * 100) / 100,
    costUsd: Math.round(costUsd * 100) / 100,
    marginRate,
    platformFee: Math.round(platformFee * 100) / 100,
    shippingKrw,
  };
}

/**
 * 동기 가격 계산 (settings를 미리 로드한 경우 사용)
 * N+1 방지: getAllPricingSettings()로 1회 조회 후 이 함수로 반복 계산
 */
export function calculatePriceSync(
  costKRW: number,
  settings: PricingSettingsData,
): { salePrice: number; shippingCost: number } {
  const costUsd = costKRW / settings.exchangeRate;
  const shippingUsd = settings.defaultShippingKrw / settings.exchangeRate;

  const targetRevenue = (costUsd + shippingUsd) * (1 + settings.marginRate);
  const totalPrice = targetRevenue / (1 - settings.platformFeeRate);
  const salePrice = Math.ceil((totalPrice - shippingUsd) * 100) / 100;

  return {
    salePrice: Math.max(salePrice, 0.99),
    shippingCost: Math.ceil(shippingUsd * 100) / 100,
  };
}

/**
 * 간단 가격 계산 (DB 설정 기반, 배송비는 설정값 사용)
 */
export async function calculatePriceSimple(
  costKRW: number,
  options: { platform?: string } = {},
): Promise<{ salePrice: number; shippingCost: number }> {
  const platform = options.platform || 'ebay';
  const settings = await getPricingSettings(platform);
  return calculatePriceSync(costKRW, settings);
}
