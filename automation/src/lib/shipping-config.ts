/**
 * 배송비 반영 리스팅 가격 설정 (서버 전용)
 *
 * 토큰/URL은 이 모듈 밖(뷰, 브라우저 JS, 로그)으로 내보내지 않는다.
 * 서비스 코드는 main service shipping_services의 실제 활성 코드를 env로 받는다 (하드코딩 금지).
 */
import { env } from './config.js';

export const SHIPPING_PROVIDERS = ['KPL', 'eGS'] as const;
export type ShippingProvider = (typeof SHIPPING_PROVIDERS)[number];

export const SHIPPING_DESTINATION_COUNTRY = 'US';

export interface ShippingPricingConfig {
  enabled: boolean;
  mainServiceUrl: string | null;
  internalToken: string | null;
  /** KRW per USD — 없거나 0 이하이면 null (계산·등록 차단) */
  exchangeRate: number | null;
  serviceCodes: Record<ShippingProvider, string | null>;
}

function positiveNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonEmpty(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return v ? v : null;
}

export function getShippingPricingConfig(source: Partial<Record<string, string | undefined>> = env as any): ShippingPricingConfig {
  return {
    enabled: (source.AUTO_LISTING_SHIPPING_PRICING_ENABLED ?? 'false').trim().toLowerCase() === 'true',
    mainServiceUrl: nonEmpty(source.MAIN_SERVICE_URL),
    internalToken: nonEmpty(source.SHIPPING_QUOTE_INTERNAL_TOKEN),
    exchangeRate: positiveNumber(source.AUTO_LISTING_SHIPPING_EXCHANGE_RATE),
    serviceCodes: {
      KPL: nonEmpty(source.AUTO_LISTING_KPL_US_SERVICE_CODE),
      eGS: nonEmpty(source.AUTO_LISTING_EGS_SERVICE_CODE),
    },
  };
}

export function isShippingProvider(value: unknown): value is ShippingProvider {
  return typeof value === 'string' && (SHIPPING_PROVIDERS as readonly string[]).includes(value);
}

/** 뷰에 넘겨도 되는 값만 (토큰/URL 제외) */
export function publicShippingPricingConfig(config: ShippingPricingConfig) {
  return {
    enabled: config.enabled,
    exchangeRateConfigured: config.exchangeRate !== null,
    quoteConfigured: !!(config.mainServiceUrl && config.internalToken),
  };
}
