'use strict';

/**
 * src/services/shipping/autoListingPricingAdapter.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Owner directive §5 (correction): this adapter is SHADOW-ONLY. It computes
 * the canonical shipping-aware listing price for review; it never rewrites
 * the eBay payload or replaces the legacy listing price.
 *
 * Feature flag (owner directive §5):
 *   AUTO_LISTING_SHIPPING_SHADOW_ENABLED
 *     · false (default): callers should NOT invoke the shadow path at all.
 *     · true            : callers may invoke — result is recorded for owner
 *                         review; the eBay payload still uses the legacy
 *                         value. There is deliberately NO authoritative
 *                         flag in this phase.
 *
 * The old AUTO_LISTING_USE_QUOTE_ENGINE flag is retired here. A separate
 * future commit will introduce an authoritative flag AFTER the owner has
 * validated shadow results.
 *
 * Never calls a marketplace. Never writes to any listings table. Never
 * fabricates a fallback rate — if either the quote or the band lookup
 * fails, listingBlockedReason surfaces the blocker.
 */

const quoteService  = require('./shippingQuoteService');
const policyBands   = require('./shippingPolicyBands');

//   Owner directive §5: single shadow flag. Default false (do not invoke).
function isShadowEnabled() {
  return process.env.AUTO_LISTING_SHIPPING_SHADOW_ENABLED === 'true';
}

/**
 * Compose the auto-listing pricing preview for a single canonical product.
 *
 * @param input {
 *   destinationCountry:      'US',
 *   marketplace:             'ebay',
 *   productCostKrw:          12000,
 *   actualWeightKg:          0.5,
 *   lengthCm, widthCm, heightCm,
 *   uniqueHsCodeCount:       1,
 *   declaredValueKrw:        20000,
 *   platformFeeRate:         0.13,
 *   targetMarginRate:        0.20,
 *   eurKrwRate:              1500,
 *   sellingCurrencyKrwRate:  1300,   //   USD → KRW conservative rate from margin_settings
 *   saleType:                'B2C',
 *   provider:                'eGS'
 * }
 * @returns {
 *   ok, mode: 'shadow' | 'active',
 *   quote:            { ...shippingQuoteService output },
 *   policyBand:       { ebay_policy_id, buyer_shipping_fee_krw, policy_name },
 *   estimatedShippingCostKrw,
 *   buyerShippingFeeKrw,
 *   requiredGrossRevenueKrw,
 *   listingItemPriceKrw,
 *   listingItemPrice,             (in selling currency)
 *   expectedMarginRate,
 *   listingBlockedReason,         (if any)
 *   warnings: [ ... ]
 * }
 */
async function buildAutoListingPreview(input, opts = {}) {
  const supabase = opts.supabase || null;
  const warnings = [];
  const mode = 'shadow';   //   authoritative mode is not exposed in this phase (owner directive §5)

  const {
    destinationCountry     = 'US',
    marketplace            = 'ebay',
    productCostKrw         = 0,
    platformFeeRate        = 0,
    targetMarginRate       = 0,
    sellingCurrencyKrwRate = null,
  } = input || {};

  //   Step 1: shipping quote (LISTING purpose).
  const quote = await quoteService.calculateShippingQuote(
    { ...input, quotePurpose: 'LISTING' },
    { supabase },
  );
  if (!quote.ok) {
    return {
      ok: false, mode,
      quote,
      listingBlockedReason: quote.blockedReason,
      warnings,
    };
  }
  const estimatedShippingCostKrw = quote.totalShippingCostKrw;

  //   Step 2: policy band lookup by chargeableKg (spec §7).
  const band = await policyBands.findApplicableBand(supabase, {
    marketplace,
    destinationCountry,
    chargeableKg: quote.chargeableWeightKg,
  });
  if (!band) {
    return {
      ok: false, mode,
      quote,
      listingBlockedReason: 'NO_SHIPPING_POLICY',
      warnings,
    };
  }
  const buyerShippingFeeKrw = Number(band.buyer_shipping_fee_krw) || 0;

  //   Step 3: listing price formula (spec §6).
  //     requiredGrossRevenueKrw = (productCostKrw + estimatedShippingCostKrw)
  //                               / (1 - platformFeeRate - targetMarginRate)
  //     listingItemPriceKrw     = requiredGrossRevenueKrw - buyerShippingFeeKrw
  //     listingItemPrice        = listingItemPriceKrw / sellingCurrencyKrwRate
  const denom = 1 - Number(platformFeeRate || 0) - Number(targetMarginRate || 0);
  if (denom <= 0) {
    return {
      ok: false, mode,
      quote, policyBand: band,
      estimatedShippingCostKrw, buyerShippingFeeKrw,
      listingBlockedReason: 'MARGIN_DENOMINATOR_INVALID',
      warnings,
    };
  }
  const cost = Number(productCostKrw || 0);
  if (!(cost > 0)) {
    return {
      ok: false, mode,
      quote, policyBand: band,
      estimatedShippingCostKrw, buyerShippingFeeKrw,
      listingBlockedReason: 'PRODUCT_COST_MISSING',
      warnings,
    };
  }
  const requiredGrossRevenueKrw = Math.round((cost + estimatedShippingCostKrw) / denom);
  const listingItemPriceKrw     = requiredGrossRevenueKrw - buyerShippingFeeKrw;

  if (!(listingItemPriceKrw > 0)) {
    return {
      ok: false, mode,
      quote, policyBand: band,
      estimatedShippingCostKrw, buyerShippingFeeKrw,
      requiredGrossRevenueKrw, listingItemPriceKrw,
      listingBlockedReason: 'LISTING_PRICE_NON_POSITIVE',
      warnings,
    };
  }
  //   Owner directive §5: caller must supply FX (margin_settings SoT). We
  //   never fabricate one. Absent FX → block, don't guess.
  let listingItemPrice = null;
  if (sellingCurrencyKrwRate != null) {
    if (!(sellingCurrencyKrwRate > 0)) {
      return {
        ok: false, mode,
        quote, policyBand: band,
        estimatedShippingCostKrw, buyerShippingFeeKrw,
        requiredGrossRevenueKrw, listingItemPriceKrw,
        listingBlockedReason: 'FX_INVALID',
        warnings,
      };
    }
    listingItemPrice = Math.round((listingItemPriceKrw / sellingCurrencyKrwRate) * 100) / 100;
  } else {
    warnings.push('sellingCurrencyKrwRate not provided — listingItemPrice omitted');
  }

  //   Expected margin (verification): (grossRevenue - cost - shippingCost - platformFee)
  //   / grossRevenue where platformFee = platformFeeRate * grossRevenue.
  const grossRevenueForMargin = requiredGrossRevenueKrw;
  const platformFee = Math.round(grossRevenueForMargin * Number(platformFeeRate || 0));
  const expectedMarginKrw = grossRevenueForMargin - cost - estimatedShippingCostKrw - platformFee;
  const expectedMarginRate = grossRevenueForMargin > 0
    ? Math.round((expectedMarginKrw / grossRevenueForMargin) * 10000) / 10000
    : 0;

  return {
    ok: true, mode,
    quote,
    policyBand: {
      ebay_policy_id:         band.ebay_policy_id,
      buyer_shipping_fee_krw: buyerShippingFeeKrw,
      policy_name:            band.policy_name,
      band_min_kg:            Number(band.min_chargeable_weight_kg),
      band_max_kg:            Number(band.max_chargeable_weight_kg),
    },
    estimatedShippingCostKrw,
    buyerShippingFeeKrw,
    requiredGrossRevenueKrw,
    listingItemPriceKrw,
    listingItemPrice,
    expectedMarginRate,
    listingBlockedReason: null,
    warnings,
  };
}

module.exports = {
  buildAutoListingPreview,
  isShadowEnabled,
};
