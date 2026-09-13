'use strict';

/**
 * src/services/shipping/shippingPolicyBands.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Owner directive §8: the operator manually maps
 *   (marketplace, destination, chargeableKg) → ebay_policy_id + buyer_shipping_fee_krw
 * We NEVER auto-create or auto-modify a policy on eBay.
 *
 * Lookup priority (spec §7):
 *   1. Exact country + weight range match, active=true
 *   2. Region match ('EU', 'AMERICAS', 'ALL') + weight range match, active=true
 *   3. Otherwise → null (caller sets blockedReason='NO_SHIPPING_POLICY')
 *
 * The buyer_shipping_fee_krw returned is passed to the listing-price formula
 * as `shippingPolicyFeeKrw` — deducted from `requiredGrossRevenueKrw` per
 * owner directive §6 formula.
 */

const { getClient } = require('../../db/supabaseClient');

const COUNTRY_TO_REGION = {
  DE: 'EU', FR: 'EU', IT: 'EU', ES: 'EU', NL: 'EU', BE: 'EU', LU: 'EU', PT: 'EU',
  AT: 'EU', IE: 'EU', FI: 'EU', SE: 'EU', DK: 'EU', PL: 'EU', CZ: 'EU', HU: 'EU',
  GR: 'EU', RO: 'EU', BG: 'EU', HR: 'EU', SI: 'EU', SK: 'EU', LT: 'EU', LV: 'EU',
  EE: 'EU', CY: 'EU', MT: 'EU',
  US: 'AMERICAS', CA: 'AMERICAS', MX: 'AMERICAS', BR: 'AMERICAS',
};

function countryRegion(code) {
  if (!code) return null;
  return COUNTRY_TO_REGION[String(code).toUpperCase()] || null;
}

/**
 * Find the applicable band. Never falls back to a default policy — returns
 * null if no band matches and caller must surface NO_SHIPPING_POLICY.
 */
async function findApplicableBand(supabase, { marketplace, destinationCountry, chargeableKg }) {
  if (!marketplace) throw new Error('marketplace required');
  if (!(chargeableKg > 0)) return null;
  const db = supabase || getClient();

  //   1. Country-specific match first.
  if (destinationCountry) {
    const up = String(destinationCountry).toUpperCase();
    const r1 = await db
      .from('shipping_policy_bands')
      .select('*')
      .eq('marketplace', marketplace)
      .eq('destination_country', up)
      .eq('active', true)
      .lte('min_chargeable_weight_kg', chargeableKg)
      .gte('max_chargeable_weight_kg', chargeableKg)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r1.error) throw r1.error;
    if (r1.data) return r1.data;
  }

  //   2. Region match (destination_country IS NULL, region matches).
  const region = countryRegion(destinationCountry) || 'ALL';
  const r2 = await db
    .from('shipping_policy_bands')
    .select('*')
    .eq('marketplace', marketplace)
    .is('destination_country', null)
    .in('destination_region', [region, 'ALL'])
    .eq('active', true)
    .lte('min_chargeable_weight_kg', chargeableKg)
    .gte('max_chargeable_weight_kg', chargeableKg)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (r2.error) throw r2.error;
  return r2.data || null;
}

module.exports = {
  findApplicableBand,
  countryRegion,
  COUNTRY_TO_REGION,
};
