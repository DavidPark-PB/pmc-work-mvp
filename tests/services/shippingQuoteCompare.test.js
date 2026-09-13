'use strict';

/**
 * tests/services/shippingQuoteCompare.test.js
 * PMC-CCOREA-SHIPPING-1C MULTI-CARRIER (2026-09-13 · SHADOW).
 *
 * Locks in the compare-service contract for §14 required scenarios:
 *   · non-branded US → eGS AND KPL both surface as ELIGIBLE
 *   · branded US → eGS marked BRAND_RESTRICTED, KPL still ELIGIBLE
 *   · non-JP-non-US country → KPL marked COUNTRY_NOT_SUPPORTED
 *   · unloaded providers (SHIPTER/FedEx/KoreaPost) surface as RATE_NOT_LOADED
 *   · recommendation picks cheapest ELIGIBLE, never a restricted one
 *   · brand_status_unknown (isBranded=null) surfaces a warning
 *   · fallback rules when migration 117 not applied (relation-missing)
 *   · restricted service cheaper than eligible ones is not recommended
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const compareService = require(path.join(REPO, 'src/services/shipping/shippingQuoteCompareService'));

//   ─────────────────────────────────────────────────────────────
//   Fake supabase client shared across tests. Behaviour:
//     · from('shipping_rate_versions').select().eq('status','active') → provided versions
//     · from('shipping_services').select().in().eq('active',true).range(from,to) → slice of provided svcs
//     · from('shipping_eligibility_rules').select() → either provided rules or throw missing-table
//     · everything else → routed to a stub that lets calculateShippingQuote
//       resolve deterministically per (provider, service_code).
//   ─────────────────────────────────────────────────────────────
function makeFake({
  versions = [{ id: 3, provider: 'eGS', status: 'active', effective_from: '2026-09-01' },
              { id: 4, provider: 'KPL', status: 'active', effective_from: '2026-09-13' }],
  services = [
    { provider: 'eGS', service_code: 'EGS_STD_US', service_name: 'eGS Standard US', vol_divisor: 6000, incoterm: 'DDP', rate_loaded: true, sale_type: null, active: true },
    { provider: 'KPL', service_code: 'KPL_STD_US', service_name: 'KPL SF US',       vol_divisor: 6000, incoterm: 'DAP', rate_loaded: true, sale_type: null, active: true },
  ],
  rules = [{ provider: 'eGS', service_code: null, restriction_type: 'brand_all', brand_name: '*', country_scope: null, sale_type: null, allowed: false, active: true }],
  rulesTableMissing = false,
  quoteResults = null,   //   optional map { 'PROVIDER|CODE' → quote-shape }
} = {}) {
  const eachTableRowsFilter = (rows, filters) => {
    let src = rows;
    for (const [col, val] of filters) {
      if (col === 'status') src = src.filter(r => r.status === val);
      if (col === 'active') src = src.filter(r => r.active === val);
    }
    return src;
  };
  return {
    from(table) {
      const state = { filters: [] };
      const chain = {
        select() { return chain; },
        eq(c, v) { state.filters.push([c, v]); return chain; },
        in(c, v) { state.filters.push([c, v]); return chain; },
        order() { return chain; }, limit() { return chain; },
        gte() { return chain; }, lte() { return chain; },
        maybeSingle() { return chain._resolve(true); },
        single() { return chain._resolve(true); },
        range(from, to) {
          let rows = [];
          if (table === 'shipping_services') {
            //   filter by rate_version_id via .in and active via .eq — but our
            //   fixture services are already the active set for the loaded versions.
            rows = eachTableRowsFilter(services, state.filters);
          } else if (table === 'shipping_rate_brackets') {
            //   Called by activation guard OR quote service. We short-circuit
            //   the quote service via quoteResults below.
            rows = [];
          } else if (table === 'shipping_countries') {
            rows = [];
          }
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        then(res, rej) {
          if (table === 'shipping_rate_versions') {
            return Promise.resolve({ data: eachTableRowsFilter(versions, state.filters), error: null }).then(res, rej);
          }
          if (table === 'shipping_eligibility_rules') {
            if (rulesTableMissing) {
              return Promise.resolve({ data: null, error: { message: 'relation "public.shipping_eligibility_rules" does not exist' } }).then(res, rej);
            }
            return Promise.resolve({ data: eachTableRowsFilter(rules, state.filters), error: null }).then(res, rej);
          }
          if (table === 'shipping_services') {
            return Promise.resolve({ data: eachTableRowsFilter(services, state.filters), error: null }).then(res, rej);
          }
          return Promise.resolve({ data: [], error: null }).then(res, rej);
        },
      };
      return chain;
    },
    //   Convenient hook: monkey-patch calculateShippingQuote inside the
    //   compareService by replacing require cache before this test loads —
    //   but here we monkey-patch via the exported quoteService module ref.
    _quoteResults: quoteResults,
  };
}

//   Replace quoteService.calculateShippingQuote per-test so we get
//   deterministic per-service prices without hitting a real DB.
const quoteService = require(path.join(REPO, 'src/services/shipping/shippingQuoteService'));
const _origCalculate = quoteService.calculateShippingQuote;

function stubQuote(map) {
  quoteService.calculateShippingQuote = async (input) => {
    const key = `${input.provider}|${input.serviceCode}`;
    if (map[key]) return map[key];
    //   Default: RATE_NOT_LOADED so unmocked services don't accidentally look eligible.
    return { ok: false, blockedReason: 'RATE_NOT_LOADED', message: `no stub for ${key}` };
  };
}
test.afterEach(() => { quoteService.calculateShippingQuote = _origCalculate; });

const EGS_US_QUOTE = {
  ok: true, provider: 'eGS', serviceCode: 'EGS_STD_US', destinationCountry: 'US',
  actualWeightKg: 0.5, volumetricWeightKg: 0.5, chargeableWeightKg: 0.5, appliedWeightBracketKg: 0.5,
  baseRateKrw: 16100, fuelSurchargeKrw: 0, demandSurchargeKrw: 1000,
  euVatKrw: 0, euHsFeeKrw: 0, otherMandatoryFeeKrw: 0,
  totalShippingCostKrw: 17100, rateVersionId: 3, rateEffectiveFrom: '2026-09-01',
  warnings: [],
};
const KPL_US_QUOTE = {
  ok: true, provider: 'KPL', serviceCode: 'KPL_STD_US', destinationCountry: 'US',
  actualWeightKg: 0.5, volumetricWeightKg: 0.5, chargeableWeightKg: 0.5, appliedWeightBracketKg: 0.5,
  baseRateKrw: 13900, fuelSurchargeKrw: 0, demandSurchargeKrw: 0,
  euVatKrw: 0, euHsFeeKrw: 0, otherMandatoryFeeKrw: 0,
  totalShippingCostKrw: 13900, rateVersionId: 4, rateEffectiveFrom: '2026-09-13',
  warnings: [],
};

//   ═════════════════════════════════════════════════════════════
//   §14 · required scenarios
//   ═════════════════════════════════════════════════════════════

test('COMPARE-1 · Non-branded US shows eGS AND KPL both ELIGIBLE', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 1, declaredValueKrw: 0, saleType: 'B2C', quotePurpose: 'LISTING',
    isBranded: false, brandName: null,
  }, { supabase });
  assert.equal(out.ok, true);
  const eGS = out.candidates.find(c => c.provider === 'eGS');
  const KPL = out.candidates.find(c => c.provider === 'KPL');
  assert.equal(eGS.status, 'ELIGIBLE', `eGS should be ELIGIBLE for non-branded — got ${eGS.status} · ${eGS.unavailableReason}`);
  assert.equal(KPL.status, 'ELIGIBLE');
});

test('COMPARE-2 · Branded US → eGS BRAND_RESTRICTED, KPL stays ELIGIBLE', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', quotePurpose: 'LISTING',
    isBranded: true, brandName: 'Pokemon',
  }, { supabase });
  const eGS = out.candidates.find(c => c.provider === 'eGS');
  const KPL = out.candidates.find(c => c.provider === 'KPL');
  assert.equal(eGS.status, 'BRAND_RESTRICTED', `eGS should be BRAND_RESTRICTED — got ${eGS.status}`);
  assert.equal(eGS.eligible, false);
  assert.equal(eGS.totalShippingCostKrw, null, 'restricted candidate must NOT carry a price');
  assert.equal(KPL.status, 'ELIGIBLE');
});

test('COMPARE-3 · KPL for DE (non-JP/US) → COUNTRY_NOT_SUPPORTED', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'DE', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', quotePurpose: 'LISTING',
    isBranded: false, brandName: null,
  }, { supabase });
  const KPL = out.candidates.find(c => c.provider === 'KPL');
  assert.equal(KPL.status, 'COUNTRY_NOT_SUPPORTED');
  assert.match(KPL.unavailableReason, /US\/JP|US|JP/);
});

test('COMPARE-4 · unloaded providers (SHIPTER/FedEx/KoreaPost) surface as RATE_NOT_LOADED', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: false,
  }, { supabase });
  const missing = ['SHIPTER', 'FedEx', 'KoreaPost'];
  for (const p of missing) {
    const c = out.candidates.find(x => x.provider === p);
    assert.ok(c, `${p} MUST appear in candidates (owner directive §5)`);
    assert.equal(c.status, 'RATE_NOT_LOADED');
    assert.equal(c.eligible, false);
    assert.equal(c.totalShippingCostKrw, null, `unloaded ${p} MUST NOT carry a fake price`);
  }
});

test('COMPARE-5 · recommendation picks cheapest ELIGIBLE (KPL 13,900 wins over eGS 17,100)', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: false,
  }, { supabase });
  assert.equal(out.recommendedServiceCode, 'KPL_STD_US');
});

test('COMPARE-6 · restricted service is NOT recommended even when cheaper (branded case)', async () => {
  //   Simulate branded, but eGS is cheaper — recommend must still avoid eGS.
  const cheapEGS = { ...EGS_US_QUOTE, totalShippingCostKrw: 5000, baseRateKrw: 4000 };
  stubQuote({ 'eGS|EGS_STD_US': cheapEGS, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: true, brandName: 'Pokemon',
  }, { supabase });
  assert.notEqual(out.recommendedServiceCode, 'EGS_STD_US',
    'restricted eGS must NEVER be recommended, even at half the price');
  assert.equal(out.recommendedServiceCode, 'KPL_STD_US');
});

test('COMPARE-7 · isBranded=null (unknown) → BRAND_STATUS_UNKNOWN warning, wildcard rule does NOT deny', async () => {
  //   Owner directive §4: unknown brand status must NOT default to non-branded.
  //   The wildcard rule (brand_name '*') only kicks in when isBranded=true.
  //   With null, the wildcard rule does NOT match — so eGS stays ELIGIBLE —
  //   but a warning surfaces so operators verify before shipping.
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake();
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: null,
  }, { supabase });
  assert.equal(out.brandStatusUnknown, true);
  assert.ok(out.warnings.some(w => /BRAND_STATUS_UNKNOWN/.test(w)),
    `warnings must include BRAND_STATUS_UNKNOWN — got ${JSON.stringify(out.warnings)}`);
});

test('COMPARE-8 · rules table absent (migration 117 not applied) → fallback rule + warning', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake({ rulesTableMissing: true });
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: true, brandName: 'Pokemon',
  }, { supabase });
  //   Fallback rule denies eGS for branded → same outcome as when the DB row exists.
  const eGS = out.candidates.find(c => c.provider === 'eGS');
  assert.equal(eGS.status, 'BRAND_RESTRICTED');
  assert.ok(out.warnings.some(w => /ELIGIBILITY_RULES_FALLBACK/.test(w)),
    'warning must surface the fallback source');
});

test('COMPARE-9 · specific-brand rule overrides wildcard (operator whitelists Pokemon for eGS)', async () => {
  stubQuote({ 'eGS|EGS_STD_US': EGS_US_QUOTE, 'KPL|KPL_STD_US': KPL_US_QUOTE });
  const supabase = makeFake({
    rules: [
      //   Global deny for all branded products
      { provider: 'eGS', service_code: null, restriction_type: 'brand_all', brand_name: '*', country_scope: null, sale_type: null, allowed: false, active: true },
      //   Explicit allow for Pokemon specifically
      { provider: 'eGS', service_code: null, restriction_type: 'brand_specific', brand_name: 'Pokemon', country_scope: null, sale_type: null, allowed: true, active: true },
    ],
  });
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: true, brandName: 'Pokemon',
  }, { supabase });
  const eGS = out.candidates.find(c => c.provider === 'eGS');
  assert.equal(eGS.status, 'ELIGIBLE',
    'explicit allow=true for Pokemon MUST override the wildcard deny');
});

test('COMPARE-10 · JP KPL matches (country in provider scope)', async () => {
  const KPL_JP_QUOTE = { ...KPL_US_QUOTE, destinationCountry: 'JP', serviceCode: 'KPL_STD_JP' };
  stubQuote({ 'eGS|EGS_STD_US': { ok:false, blockedReason:'COUNTRY_NOT_IN_MASTER' }, 'KPL|KPL_STD_JP': KPL_JP_QUOTE });
  const supabase = makeFake({
    services: [
      { provider: 'eGS', service_code: 'EGS_STD_US', service_name: 'eGS US', vol_divisor: 6000, incoterm: 'DDP', rate_loaded: true, sale_type: null, active: true },
      { provider: 'KPL', service_code: 'KPL_STD_JP', service_name: 'KPL JP', vol_divisor: 6000, incoterm: 'DAP', rate_loaded: true, sale_type: null, active: true },
    ],
  });
  const out = await compareService.calculateMultiCarrierQuotes({
    destinationCountry: 'JP', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10,
    saleType: 'B2C', isBranded: false,
  }, { supabase });
  const KPL = out.candidates.find(c => c.provider === 'KPL');
  assert.equal(KPL.status, 'ELIGIBLE', `KPL should ship JP — got ${KPL.status}`);
});

//   ═════════════════════════════════════════════════════════════
//   Pure helper unit tests
//   ═════════════════════════════════════════════════════════════

test('EVAL-1 · _evaluateEligibility returns null when no rule matches', () => {
  const denial = compareService._evaluateEligibility(
    [{ provider: 'FedEx', service_code: null, restriction_type: 'brand_all', brand_name: '*', country_scope: null, sale_type: null, allowed: false, active: true }],
    { provider: 'eGS', service_code: 'EGS_STD_US' },
    { isBranded: true, brandName: 'Pokemon', destinationCountry: 'US', saleType: 'B2C' },
  );
  assert.equal(denial, null, 'FedEx rule must not deny eGS');
});

test('EVAL-2 · wildcard rule only matches when isBranded=true', () => {
  const rules = [{ provider: 'eGS', service_code: null, restriction_type: 'brand_all', brand_name: '*', country_scope: null, sale_type: null, allowed: false, active: true }];
  const svc = { provider: 'eGS', service_code: 'EGS_STD_US' };
  assert.equal(compareService._evaluateEligibility(rules, svc, { isBranded: true,  brandName: null, destinationCountry: 'US', saleType: 'B2C' })?.code, 'BRAND_RESTRICTED');
  assert.equal(compareService._evaluateEligibility(rules, svc, { isBranded: false, brandName: null, destinationCountry: 'US', saleType: 'B2C' }), null);
  assert.equal(compareService._evaluateEligibility(rules, svc, { isBranded: null,  brandName: null, destinationCountry: 'US', saleType: 'B2C' }), null,
    'unknown brand status must NOT trigger the wildcard (owner directive §4)');
});
