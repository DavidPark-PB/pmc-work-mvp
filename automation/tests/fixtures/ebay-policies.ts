/**
 * eBay Sell Account fulfillment_policy 응답 fixture — production 응답 구조와 같은 필드만 사용 (값은 테스트용)
 */
import type { ShippingPolicySnapshot } from '../../src/services/ebay-shipping-policies.js';

const service = (sortOrder: number, code: string, value: string, freeShipping = false) => ({
  sortOrder, shippingCarrierCode: 'Other', shippingServiceCode: code,
  shippingCost: { value, currency: 'USD' }, additionalShippingCost: { value: '0.0', currency: 'USD' },
  freeShipping, buyerResponsibleForShipping: false, buyerResponsibleForPickup: false,
});

const policy = (id: string, name: string, domestic: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name, marketplaceId: 'EBAY_US', categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
  handlingTime: { value: 5, unit: 'DAY' }, shipToLocations: { regionIncluded: [{ regionName: 'Worldwide' }] },
  shippingOptions: [
    { optionType: 'DOMESTIC', shippingDiscountProfileId: '0', shippingPromotionOffered: false, ...domestic },
    { optionType: 'INTERNATIONAL', costType: 'FLAT_RATE', shippingDiscountProfileId: '0', shippingPromotionOffered: false, shippingServices: [service(1, 'StandardInternational', '15.0')] },
  ],
  globalShipping: false, pickupDropOff: false, freightShipping: false, fulfillmentPolicyId: id,
  ...extra,
});

export const POLICY_IDS = {
  free: '111111110014',
  fixed790: '222222227014',
  expedited: '333333331014',
  calculated: '444444444014',
  rateTable: '555555555014',
  nonUs: '666666666014',
  primaryNotCheapest: '777777777014',
} as const;

export const FULFILLMENT_POLICIES = {
  total: 7,
  fulfillmentPolicies: [
    policy(POLICY_IDS.fixed790, 'Standard US $7.90', { costType: 'FLAT_RATE', shippingServices: [service(1, 'Other', '7.9'), service(2, 'StandardShippingFromOutsideUS', '8.9')] }),
    policy(POLICY_IDS.calculated, 'Calculated Shipping US', { costType: 'CALCULATED', shippingServices: [service(1, 'USPSPriority', '0.0')] }),
    policy(POLICY_IDS.rateTable, 'Rate Table US', { costType: 'FLAT_RATE', rateTableId: '5000000001', shippingServices: [service(1, 'EconomyShippingFromOutsideUS', '5.0')] }),
    policy(POLICY_IDS.expedited, 'Expedited US', { costType: 'FLAT_RATE', shippingServices: [service(1, 'ExpeditedShippingFromOutsideUS', '15.0')] }),
    policy(POLICY_IDS.free, 'Free Shipping US', { costType: 'FLAT_RATE', shippingServices: [service(1, 'EconomyShippingFromOutsideUS', '0.0', true), service(2, 'StandardShippingFromOutsideUS', '3.0')] }),
    policy(POLICY_IDS.nonUs, 'UK Standard', { costType: 'FLAT_RATE', shippingServices: [service(1, 'UK_RoyalMailFirstClassStandard', '3.0')] }, { marketplaceId: 'EBAY_GB' }),
    policy(POLICY_IDS.primaryNotCheapest, 'Express First US', { costType: 'FLAT_RATE', shippingServices: [service(1, 'ShippingMethodExpress', '20.0'), service(2, 'EconomyShippingFromOutsideUS', '5.0')] }),
  ],
};

export function policySnapshot(kind: 'free' | 'fixed790' = 'fixed790'): ShippingPolicySnapshot {
  return kind === 'free'
    ? { policyId: POLICY_IDS.free, policyName: 'Free Shipping US', marketplace: 'EBAY_US', shippingType: 'FREE', buyerShippingUsd: 0, primaryServiceCode: 'EconomyShippingFromOutsideUS', selectedAt: '2026-09-15T00:00:00.000Z', fetchedAt: '2026-09-15T00:00:00.000Z' }
    : { policyId: POLICY_IDS.fixed790, policyName: 'Standard US $7.90', marketplace: 'EBAY_US', shippingType: 'FIXED', buyerShippingUsd: 7.9, primaryServiceCode: 'Other', selectedAt: '2026-09-15T00:00:00.000Z', fetchedAt: '2026-09-15T00:00:00.000Z' };
}
