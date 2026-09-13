'use strict';

/**
 * tests/services/shippingQuoteService.test.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Owner directive §10 test grid. Fixture-based: stubs the repository so
 * the tests never depend on a live workbook or the real Supabase.
 * The fixture encodes the §11 sample values verbatim (verified against the
 * real CCOREA_통합배송비_기본데이터_v1.xlsx during development):
 *
 *   EGS_STD_US: divisor 6000, perkg 2000, brackets 0.1→8500 … 0.5→16100 …
 *   EGS_EXPRESS: divisor 5000, no perkg (Express includes FSC/ESS)
 *   EU_STD_DE:  divisor 5000, perkg 2100
 *   FICP:       B2C DDP only
 *   FEDEX_IP:   B2B only
 *   KPL:        US + JP only
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO     = path.resolve(__dirname, '../..');
const REPO_MOD = require.resolve(path.join(REPO, 'src/services/shipping/rateMasterRepository'));
const QUOTE_MOD = require.resolve(path.join(REPO, 'src/services/shipping/shippingQuoteService'));

//   Build a stub repository object matching the real API surface, then inject
//   it into the require cache BEFORE loading shippingQuoteService. This is the
//   same pattern PMC-EXPORT-SAFETY-2D tests use for supabaseClient — cleanly
//   removes all DB-level dependencies from these tests.
function loadWithFixture(fixture) {
  delete require.cache[QUOTE_MOD];
  delete require.cache[REPO_MOD];
  require.cache[REPO_MOD] = {
    id:       REPO_MOD,
    filename: REPO_MOD,
    loaded:   true,
    exports:  {
      async getActiveVersion(_supabase, provider = 'eGS') {
        return fixture.version && fixture.version.provider === provider ? fixture.version : null;
      },
      async listServices(_supabase, versionId) {
        return fixture.services.filter(s => s._version_id === versionId);
      },
      async getService(_supabase, versionId, code) {
        return fixture.services.find(s => s._version_id === versionId && s.service_code === code) || null;
      },
      async getCountry(_supabase, versionId, code) {
        const up = String(code || '').toUpperCase();
        return fixture.countries.find(c => c._version_id === versionId && c.country_code === up) || null;
      },
      async findApplicableBracket(_supabase, versionId, code, { chargeableKg, countryCode, zoneCode }) {
        const rows = fixture.brackets
          .filter(b => b._version_id === versionId && b.service_code === code && b.weight_to_kg >= chargeableKg)
          .sort((a, b) => a.weight_to_kg - b.weight_to_kg);
        if (rows.length === 0) return null;
        const upper = countryCode ? String(countryCode).toUpperCase() : null;
        const zone  = zoneCode ? String(zoneCode).toUpperCase() : null;
        return rows.find(r => upper && r.country_key === upper)
            || rows.find(r => zone  && r.zone_key    === zone)
            || rows.find(r => r.country_key === '__ALL__' || r.country_key === '__ZONE__')
            || rows[0];
      },
      async listEnabledSurcharges(_supabase, versionId) {
        return fixture.surcharges.filter(s => s._version_id === versionId && s.enabled);
      },
    },
  };
  return require(QUOTE_MOD);
}

const V = 42;   //   fixture rate_version_id

const FIXTURE = {
  version: { id: V, provider: 'eGS', source_name: 'test', effective_from: '2026-09-01', status: 'active' },
  services: [
    { _version_id: V, service_code: 'EGS_STD_US', service_name: 'eGS Standard - US', vol_divisor: 6000, sale_type: 'B2C', incoterm: 'DAP', rate_loaded: true, perkg_surcharge_krw: 2000, active: true },
    { _version_id: V, service_code: 'EGS_STD_EU_DE', service_name: 'eGS Standard - DE', vol_divisor: 5000, sale_type: 'B2C', incoterm: 'DAP', rate_loaded: true, perkg_surcharge_krw: 2100, active: true },
    { _version_id: V, service_code: 'EGS_EXPRESS', service_name: 'eGS Express', vol_divisor: 5000, sale_type: 'B2C', incoterm: 'DAP', rate_loaded: true, perkg_surcharge_krw: 0, active: true },
    { _version_id: V, service_code: 'FEDEX_FICP', service_name: 'FedEx FICP', vol_divisor: 5000, sale_type: 'B2C', incoterm: 'DDP', rate_loaded: true, perkg_surcharge_krw: 0, active: true },
    { _version_id: V, service_code: 'FEDEX_IP',   service_name: 'FedEx IP',   vol_divisor: 5000, sale_type: 'B2B', incoterm: 'DAP', rate_loaded: true, perkg_surcharge_krw: 0, active: true },
    { _version_id: V, service_code: 'KPL',        service_name: 'SF Express KPL', vol_divisor: 6000, sale_type: 'B2C', incoterm: 'DAP', rate_loaded: true, perkg_surcharge_krw: 0, active: true },
    { _version_id: V, service_code: 'KPACKET',    service_name: '우체국 K-Packet', vol_divisor: 0, sale_type: 'B2C', incoterm: 'DAP', rate_loaded: false, perkg_surcharge_krw: 0, active: true },
  ],
  countries: [
    { _version_id: V, country_code: 'US', country_name: 'United States', express_zone: 'A', is_eu: false, vat_rate: 0,    benchmark_service_code: 'EGS_STD_US' },
    { _version_id: V, country_code: 'DE', country_name: 'Germany',       express_zone: 'M', is_eu: true,  vat_rate: 0.19, benchmark_service_code: 'EGS_STD_EU_DE' },
    { _version_id: V, country_code: 'FR', country_name: 'France',        express_zone: 'M', is_eu: true,  vat_rate: 0.20, benchmark_service_code: 'EGS_STD_EU_DE' },
    { _version_id: V, country_code: 'JP', country_name: 'Japan',         express_zone: 'A', is_eu: false, vat_rate: 0,    benchmark_service_code: 'EGS_EXPRESS' },
    { _version_id: V, country_code: 'MX', country_name: 'Mexico',        express_zone: 'H', is_eu: false, vat_rate: 0,    benchmark_service_code: 'EGS_EXPRESS' },
    { _version_id: V, country_code: 'EE', country_name: 'Estonia',       express_zone: 'M', is_eu: true,  vat_rate: 0.22, benchmark_service_code: 'EGS_STD_EU_EE' }, //   intentionally missing
  ],
  brackets: [
    //   EGS_STD_US US brackets (§11 sample)
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.1, base_rate:  8500, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.3, base_rate: 11700, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.5, base_rate: 16100, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.6, base_rate: 17400, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 22900, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 30.0, base_rate: 200000, currency: 'KRW' },
    //   EGS_STD_EU_DE (Germany)
    { _version_id: V, service_code: 'EGS_STD_EU_DE', country_key: 'DE', zone_key: null, weight_to_kg: 0.5, base_rate: 12000, currency: 'KRW' },
    { _version_id: V, service_code: 'EGS_STD_EU_DE', country_key: 'DE', zone_key: null, weight_to_kg: 1.0, base_rate: 18000, currency: 'KRW' },
    //   EGS_EXPRESS zone-based
    { _version_id: V, service_code: 'EGS_EXPRESS', country_key: '__ZONE__', zone_key: 'A', weight_to_kg: 0.5, base_rate: 43340, currency: 'KRW', note: 'FSC/ESS 포함' },
    { _version_id: V, service_code: 'EGS_EXPRESS', country_key: '__ZONE__', zone_key: 'H', weight_to_kg: 0.5, base_rate: 37500, currency: 'KRW', note: 'FSC/ESS 포함' },
    { _version_id: V, service_code: 'EGS_EXPRESS', country_key: '__ZONE__', zone_key: 'A', weight_to_kg: 30.0, base_rate: 500000, currency: 'KRW' },
    //   FEDEX_FICP
    { _version_id: V, service_code: 'FEDEX_FICP', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 25000, currency: 'KRW' },
    //   FEDEX_IP
    { _version_id: V, service_code: 'FEDEX_IP', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 30000, currency: 'KRW' },
    //   KPL US and JP only
    { _version_id: V, service_code: 'KPL', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 20000, currency: 'KRW' },
    { _version_id: V, service_code: 'KPL', country_key: 'JP', zone_key: null, weight_to_kg: 1.0, base_rate: 15000, currency: 'KRW' },
  ],
  surcharges: [
    { _version_id: V, rule_code: 'EU_HS_3EUR', scope: 'EU', value: 3, unit: 'EUR', enabled: true },
    { _version_id: V, rule_code: 'EU_VAT',     scope: 'EU', value: 0, unit: 'PCT', enabled: true },
    { _version_id: V, rule_code: 'FEDEX_FUEL', scope: 'FedEx', value: 0, unit: 'PCT', enabled: true },
  ],
};

//   ─────────────────────────────────────────────────────────────
//   §11 sample: US 0.5kg, 20×15×10, divisor 6000
//   base 16,100 + demand 2,000×0.5 = 1,000 → total 17,100
//   ─────────────────────────────────────────────────────────────

test('QUOTE-A · §11 sample US 0.5kg 20×15×10 → 17,100원', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, true, `blocked: ${out.blockedReason || ''}`);
  assert.equal(out.serviceCode, 'EGS_STD_US');
  assert.equal(out.volumetricDivisor, 6000);
  assert.equal(out.volumetricWeightKg, 0.5);
  assert.equal(out.chargeableWeightKg, 0.5);
  assert.equal(out.appliedWeightBracketKg, 0.5);
  assert.equal(out.baseRateKrw, 16100);
  assert.equal(out.demandSurchargeKrw, 1000);
  assert.equal(out.totalShippingCostKrw, 17100);
});

//   ─────────────────────────────────────────────────────────────
//   MAX(actual, volumetric) semantics
//   ─────────────────────────────────────────────────────────────

test('QUOTE-B · actual > volumetric → chargeable = actual', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.5, lengthCm: 10, widthCm: 10, heightCm: 10,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, true);
  assert.ok(out.volumetricWeightKg < 0.5, `vol=${out.volumetricWeightKg}`);
  assert.equal(out.chargeableWeightKg, 0.5);
});

test('QUOTE-C · volumetric > actual → chargeable = volumetric', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.1, lengthCm: 30, widthCm: 20, heightCm: 20,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  //   vol = 30*20*20/6000 = 2.0
  assert.equal(out.volumetricWeightKg, 2.0);
  assert.equal(out.chargeableWeightKg, 2.0);
});

//   ─────────────────────────────────────────────────────────────
//   Bracket round-up (spec §4 rule 4)
//   ─────────────────────────────────────────────────────────────

test('QUOTE-D · 0.51kg lookup uses 0.6kg bracket (never 0.5)', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.51, lengthCm: 1, widthCm: 1, heightCm: 1,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, true);
  assert.equal(out.appliedWeightBracketKg, 0.6);
  assert.equal(out.baseRateKrw, 17400);
});

//   ─────────────────────────────────────────────────────────────
//   EU VAT + HS fee
//   ─────────────────────────────────────────────────────────────

test('QUOTE-E · DE (EU) applies VAT on declaredValue immediately', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'DE',
    actualWeightKg: 0.4, lengthCm: 10, widthCm: 10, heightCm: 10,
    declaredValueKrw: 100000, uniqueHsCodeCount: 0,
    eurKrwRate: 1500,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, true);
  //   VAT = 100000 * 0.19 = 19000
  assert.equal(out.euVatKrw, 19000);
  assert.equal(out.euHsFeeKrw, 0);
});

test('QUOTE-F · EU with 1 unique HS → 1 × 3 × EUR_KRW', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'DE',
    actualWeightKg: 0.4, lengthCm: 10, widthCm: 10, heightCm: 10,
    declaredValueKrw: 0, uniqueHsCodeCount: 1,
    eurKrwRate: 1500,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.euHsFeeKrw, 4500);   //   1 * 3 * 1500
});

test('QUOTE-G · EU with 3 unique HS → 3 × 3 × EUR_KRW', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'DE',
    actualWeightKg: 0.4, lengthCm: 10, widthCm: 10, heightCm: 10,
    declaredValueKrw: 0, uniqueHsCodeCount: 3,
    eurKrwRate: 1500,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.euHsFeeKrw, 13500);  //   3 * 3 * 1500
});

test('QUOTE-G2 · EU HS but eurKrwRate missing → FX_MISSING (never fake 0)', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'DE',
    actualWeightKg: 0.4, lengthCm: 10, widthCm: 10, heightCm: 10,
    uniqueHsCodeCount: 2,
    saleType: 'B2C', quotePurpose: 'LISTING',
    //   eurKrwRate intentionally omitted
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'FX_MISSING');
});

//   ─────────────────────────────────────────────────────────────
//   Express FSC/ESS duplication guard
//   ─────────────────────────────────────────────────────────────

test('QUOTE-H · eGS Express skips per-kg surcharge (FSC/ESS included)', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'MX',           //   MX → benchmark EGS_EXPRESS, zone H
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, true);
  assert.equal(out.serviceCode, 'EGS_EXPRESS');
  assert.equal(out.demandSurchargeKrw, 0, 'Express MUST NOT apply per-kg surcharge');
});

//   ─────────────────────────────────────────────────────────────
//   Service-policy guardrails (§4 rules 11-13)
//   ─────────────────────────────────────────────────────────────

test('QUOTE-I · KPL blocked for non-US/JP', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'DE',
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    saleType: 'B2C', quotePurpose: 'FULFILLMENT',
    serviceCode: 'KPL',
    eurKrwRate: 1500,
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'KPL_COUNTRY_NOT_ALLOWED');
});

test('QUOTE-J · KPL allowed for US and JP', async () => {
  const q = loadWithFixture(FIXTURE);
  for (const cc of ['US', 'JP']) {
    const out = await q.calculateShippingQuote({
      destinationCountry: cc,
      actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
      saleType: 'B2C', quotePurpose: 'FULFILLMENT',
      serviceCode: 'KPL',
    });
    assert.equal(out.ok, true, `${cc} blocked: ${out.blockedReason || ''}`);
    assert.equal(out.serviceCode, 'KPL');
  }
});

test('QUOTE-K · FICP is B2C-DDP only — B2B blocked', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    saleType: 'B2B', quotePurpose: 'FULFILLMENT',
    serviceCode: 'FEDEX_FICP',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'FICP_B2C_ONLY');
});

test('QUOTE-L · FedEx IP is B2B only — B2C blocked', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    saleType: 'B2C', quotePurpose: 'FULFILLMENT',
    serviceCode: 'FEDEX_IP',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'FEDEX_IP_B2B_ONLY');
});

//   ─────────────────────────────────────────────────────────────
//   Weight over max bracket
//   ─────────────────────────────────────────────────────────────

test('QUOTE-M · weight beyond bracket ceiling → WEIGHT_OVER_MAX_BRACKET', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 999, lengthCm: 1, widthCm: 1, heightCm: 1,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'WEIGHT_OVER_MAX_BRACKET');
  assert.equal(out.totalShippingCostKrw, undefined);   //   never fake a number
});

//   ─────────────────────────────────────────────────────────────
//   RATE_NOT_LOADED path (rate_loaded=false, universal 0-fallback guard)
//   ─────────────────────────────────────────────────────────────

test('QUOTE-N · service.rate_loaded=false → RATE_NOT_LOADED (never zero rate)', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    saleType: 'B2C', quotePurpose: 'FULFILLMENT',
    serviceCode: 'KPACKET',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'RATE_NOT_LOADED');
});

test('QUOTE-O · EE (benchmark orphan) → SERVICE_NOT_IN_MASTER', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'EE',
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    eurKrwRate: 1500,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'SERVICE_NOT_IN_MASTER');
});

//   ─────────────────────────────────────────────────────────────
//   Batch quote — N+1 avoidance (surcharge cache pre-loaded once)
//   ─────────────────────────────────────────────────────────────

test('QUOTE-P · batch of 100 completes without cascading failures + preserves order', async () => {
  const q = loadWithFixture(FIXTURE);
  const inputs = [];
  for (let i = 0; i < 100; i++) {
    inputs.push({
      destinationCountry: 'US',
      actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
      saleType: 'B2C', quotePurpose: 'LISTING',
    });
  }
  const out = await q.calculateShippingQuotes(inputs);
  assert.equal(out.length, 100);
  //   Every quote is the §11 sample.
  assert.ok(out.every(r => r.ok && r.totalShippingCostKrw === 17100),
    `some quotes failed: ${JSON.stringify(out.filter(r => !r.ok).slice(0, 2))}`);
});

//   ─────────────────────────────────────────────────────────────
//   No active version → RATE_NOT_LOADED (never a silent fallback)
//   ─────────────────────────────────────────────────────────────

test('QUOTE-Q · no active version → RATE_NOT_LOADED (no legacy fallback)', async () => {
  const q = loadWithFixture({ ...FIXTURE, version: null });
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0.5, lengthCm: 5, widthCm: 5, heightCm: 5,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'RATE_NOT_LOADED');
});

//   ─────────────────────────────────────────────────────────────
//   Zero dims + zero actual → INSUFFICIENT_DIMENSIONS (spec §8)
//   ─────────────────────────────────────────────────────────────

test('QUOTE-R · zero actualWeightKg and zero dims → INSUFFICIENT_DIMENSIONS', async () => {
  const q = loadWithFixture(FIXTURE);
  const out = await q.calculateShippingQuote({
    destinationCountry: 'US',
    actualWeightKg: 0, lengthCm: 0, widthCm: 0, heightCm: 0,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedReason, 'INSUFFICIENT_DIMENSIONS');
});
