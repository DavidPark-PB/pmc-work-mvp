'use strict';

/**
 * tests/services/shippingAutoListingShadow.test.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Owner directive §7-§9 test coverage:
 *   · policy band exact-country match / region fallback / no match → NO_SHIPPING_POLICY
 *   · listing formula: (cost + shippingCost) / (1 - fee - margin) - buyerShippingFee
 *   · FX_INVALID / PRODUCT_COST_MISSING / MARGIN_DENOMINATOR_INVALID / LISTING_PRICE_NON_POSITIVE
 *   · shadow-mode default (FLAG=false) — mode='shadow'
 *   · active mode when flag=true — mode='active'
 *   · quote failure short-circuits (never fake a listing price)
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO       = path.resolve(__dirname, '../..');
const QUOTE_MOD  = require.resolve(path.join(REPO, 'src/services/shipping/shippingQuoteService'));
const REPO_MOD   = require.resolve(path.join(REPO, 'src/services/shipping/rateMasterRepository'));
const BANDS_MOD  = require.resolve(path.join(REPO, 'src/services/shipping/shippingPolicyBands'));
const ADAPTER    = require.resolve(path.join(REPO, 'src/services/shipping/autoListingPricingAdapter'));

const V = 42;
const FIXTURE = {
  version: { id: V, provider: 'eGS', source_name: 'test', effective_from: '2026-09-01', status: 'active' },
  services: [
    { _version_id: V, service_code: 'EGS_STD_US', vol_divisor: 6000, rate_loaded: true, perkg_surcharge_krw: 2000, sale_type: 'B2C' },
    { _version_id: V, service_code: 'EGS_EXPRESS', vol_divisor: 5000, rate_loaded: true, perkg_surcharge_krw: 0, sale_type: 'B2C' },
  ],
  countries: [
    { _version_id: V, country_code: 'US', country_name: 'US', express_zone: 'A', is_eu: false, vat_rate: 0, benchmark_service_code: 'EGS_STD_US' },
    { _version_id: V, country_code: 'JP', country_name: 'Japan', express_zone: 'A', is_eu: false, vat_rate: 0, benchmark_service_code: 'EGS_EXPRESS' },
  ],
  brackets: [
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.5, base_rate: 16100, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 22900, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_EXPRESS', country_key: '__ZONE__', zone_key: 'A', weight_to_kg: 0.5, base_rate: 43340, currency: 'KRW' },
  ],
  surcharges: [],
};

function loadStackWithFixture(fixture, bandsRows) {
  //   Purge caches so each test gets a fresh module tree.
  for (const p of [ADAPTER, QUOTE_MOD, REPO_MOD, BANDS_MOD]) delete require.cache[p];

  //   Stub repository (rate master reads)
  require.cache[REPO_MOD] = {
    id: REPO_MOD, filename: REPO_MOD, loaded: true,
    exports: {
      async getActiveVersion(_s, provider = 'eGS') { return fixture.version && fixture.version.provider === provider ? fixture.version : null; },
      async listServices(_s, v) { return fixture.services.filter(x => x._version_id === v); },
      async getService(_s, v, code) { return fixture.services.find(x => x._version_id === v && x.service_code === code) || null; },
      async getCountry(_s, v, code) {
        const up = String(code || '').toUpperCase();
        return fixture.countries.find(x => x._version_id === v && x.country_code === up) || null;
      },
      async findApplicableBracket(_s, v, code, { chargeableKg, countryCode, zoneCode }) {
        const rows = fixture.brackets
          .filter(b => b._version_id === v && b.service_code === code && b.weight_to_kg >= chargeableKg)
          .sort((a, b) => a.weight_to_kg - b.weight_to_kg);
        if (rows.length === 0) return null;
        const upper = countryCode ? String(countryCode).toUpperCase() : null;
        const zone  = zoneCode ? String(zoneCode).toUpperCase() : null;
        return rows.find(r => upper && r.country_key === upper)
            || rows.find(r => zone  && r.zone_key    === zone)
            || rows.find(r => r.country_key === '__ALL__' || r.country_key === '__ZONE__')
            || rows[0];
      },
      async listEnabledSurcharges(_s, v) { return fixture.surcharges.filter(x => x._version_id === v); },
    },
  };
  //   Stub bands module.
  require.cache[BANDS_MOD] = {
    id: BANDS_MOD, filename: BANDS_MOD, loaded: true,
    exports: {
      async findApplicableBand(_s, { marketplace, destinationCountry, chargeableKg }) {
        const up = destinationCountry ? String(destinationCountry).toUpperCase() : null;
        const rows = (bandsRows || []).filter(b =>
          b.marketplace === marketplace &&
          (b.active !== false) &&
          Number(b.min_chargeable_weight_kg) <= chargeableKg &&
          Number(b.max_chargeable_weight_kg) >= chargeableKg
        );
        //   1. country exact
        const exact = rows.find(b => b.destination_country === up);
        if (exact) return exact;
        //   2. region 'ALL'
        return rows.find(b => !b.destination_country && (b.destination_region === 'ALL' || b.destination_region === 'AMERICAS')) || null;
      },
      countryRegion: () => 'AMERICAS',
      COUNTRY_TO_REGION: { US: 'AMERICAS' },
    },
  };
  return require(ADAPTER);
}

const BAND_US = {
  marketplace: 'ebay', destination_country: 'US', destination_region: null,
  min_chargeable_weight_kg: 0, max_chargeable_weight_kg: 2,
  ebay_policy_id: 'POLICY-US-STD', policy_name: 'Standard US', buyer_shipping_fee_krw: 5000,
  active: true,
};
const BAND_REGION = {
  marketplace: 'ebay', destination_country: null, destination_region: 'ALL',
  min_chargeable_weight_kg: 0, max_chargeable_weight_kg: 2,
  ebay_policy_id: 'POLICY-ALL', policy_name: 'Any region', buyer_shipping_fee_krw: 3000,
  active: true,
};

const OWNER_INPUT = {
  destinationCountry: 'US',
  marketplace: 'ebay',
  productCostKrw: 12000,
  actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
  platformFeeRate: 0.13,
  targetMarginRate: 0.20,
  sellingCurrencyKrwRate: 1300,
  saleType: 'B2C',
};

test('SHADOW-A · exact-country policy band applied · listing price formula correct', async () => {
  delete process.env.AUTO_LISTING_USE_QUOTE_ENGINE;   //   default false
  const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
  const out = await adapter.buildAutoListingPreview(OWNER_INPUT);
  assert.equal(out.ok, true, `blocked: ${out.listingBlockedReason || ''}`);
  assert.equal(out.mode, 'shadow');
  assert.equal(out.estimatedShippingCostKrw, 17100, `§11 sample: 17,100원`);
  assert.equal(out.buyerShippingFeeKrw, 5000);
  //   (12000 + 17100) / (1 - 0.13 - 0.20) = 29100 / 0.67 = 43432.83… → round 43433
  //   listingItemPriceKrw = 43433 - 5000 = 38433
  assert.equal(out.requiredGrossRevenueKrw, 43433);
  assert.equal(out.listingItemPriceKrw, 38433);
  assert.ok(out.listingItemPrice > 0, `USD price=${out.listingItemPrice}`);
  assert.equal(out.policyBand.ebay_policy_id, 'POLICY-US-STD');
});

test('SHADOW-B · country match beats region match (priority order)', async () => {
  const adapter = loadStackWithFixture(FIXTURE, [BAND_REGION, BAND_US]);
  const out = await adapter.buildAutoListingPreview(OWNER_INPUT);
  assert.equal(out.ok, true);
  assert.equal(out.policyBand.ebay_policy_id, 'POLICY-US-STD', 'country match must win');
});

test('SHADOW-C · region fallback when no country match', async () => {
  const adapter = loadStackWithFixture(FIXTURE, [BAND_REGION]);
  const out = await adapter.buildAutoListingPreview(OWNER_INPUT);
  assert.equal(out.ok, true);
  assert.equal(out.policyBand.ebay_policy_id, 'POLICY-ALL');
});

test('SHADOW-D · no matching band → NO_SHIPPING_POLICY (never a default)', async () => {
  const adapter = loadStackWithFixture(FIXTURE, []);
  const out = await adapter.buildAutoListingPreview(OWNER_INPUT);
  assert.equal(out.ok, false);
  assert.equal(out.listingBlockedReason, 'NO_SHIPPING_POLICY');
});

test('SHADOW-E · mode is ALWAYS "shadow" — authoritative flag is not exposed in this phase', async () => {
  //   Correction: AUTO_LISTING_USE_QUOTE_ENGINE was retired. The adapter
  //   never returns mode='active' in this phase; a future commit will
  //   introduce an authoritative flag. Setting the OLD flag must have
  //   no effect on the mode value returned.
  process.env.AUTO_LISTING_USE_QUOTE_ENGINE = 'true';
  try {
    const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
    const out = await adapter.buildAutoListingPreview(OWNER_INPUT);
    assert.equal(out.mode, 'shadow');
    //   Values still computed correctly.
    assert.equal(out.listingItemPriceKrw, 38433);
  } finally {
    delete process.env.AUTO_LISTING_USE_QUOTE_ENGINE;
  }
});

test('SHADOW-E2 · retired flag AUTO_LISTING_USE_QUOTE_ENGINE is no longer READ (comments OK)', async () => {
  const src = fs.readFileSync(path.join(REPO, 'src/services/shipping/autoListingPricingAdapter.js'), 'utf8');
  //   Comments may reference the retired flag for auditability. Executable
  //   reads through `process.env.AUTO_LISTING_USE_QUOTE_ENGINE` MUST be gone.
  assert.ok(!/process\.env\.AUTO_LISTING_USE_QUOTE_ENGINE/.test(src),
    'adapter must not READ process.env.AUTO_LISTING_USE_QUOTE_ENGINE anymore');
  //   New flag is documented (comment) but is a caller-side switch (checked in
  //   the automation subproject), so the adapter itself does not read it.
  assert.ok(/AUTO_LISTING_SHIPPING_SHADOW_ENABLED/.test(src),
    'adapter must document the new caller-side flag');
});

test('SHADOW-F · productCostKrw=0 → PRODUCT_COST_MISSING', async () => {
  const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
  const out = await adapter.buildAutoListingPreview({ ...OWNER_INPUT, productCostKrw: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.listingBlockedReason, 'PRODUCT_COST_MISSING');
});

test('SHADOW-G · fee + margin sum > 1 → MARGIN_DENOMINATOR_INVALID', async () => {
  const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
  const out = await adapter.buildAutoListingPreview({ ...OWNER_INPUT, platformFeeRate: 0.6, targetMarginRate: 0.5 });
  assert.equal(out.ok, false);
  assert.equal(out.listingBlockedReason, 'MARGIN_DENOMINATOR_INVALID');
});

test('SHADOW-H · quote failure short-circuits without fabricating a price', async () => {
  //   Country not in master → quote returns COUNTRY_NOT_IN_MASTER.
  const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
  const out = await adapter.buildAutoListingPreview({ ...OWNER_INPUT, destinationCountry: 'ZZ' });
  assert.equal(out.ok, false);
  assert.equal(out.listingBlockedReason, 'COUNTRY_NOT_IN_MASTER');
  assert.equal(out.listingItemPriceKrw, undefined);
  assert.equal(out.listingItemPrice, undefined);
});

test('SHADOW-I · sellingCurrencyKrwRate omitted → listingItemPrice=null + warning', async () => {
  const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
  const out = await adapter.buildAutoListingPreview({ ...OWNER_INPUT, sellingCurrencyKrwRate: null });
  assert.equal(out.ok, true);
  assert.equal(out.listingItemPrice, null);
  assert.ok(out.warnings.some(w => /sellingCurrencyKrwRate/.test(w)));
});

test('SHADOW-J · sellingCurrencyKrwRate=0 → FX_INVALID (never divide-by-zero)', async () => {
  const adapter = loadStackWithFixture(FIXTURE, [BAND_US]);
  const out = await adapter.buildAutoListingPreview({ ...OWNER_INPUT, sellingCurrencyKrwRate: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.listingBlockedReason, 'FX_INVALID');
});
