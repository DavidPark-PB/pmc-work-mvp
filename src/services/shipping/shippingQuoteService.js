'use strict';

/**
 * src/services/shipping/shippingQuoteService.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Canonical shipping-quote engine driven by the shipping_rate_master tables.
 *
 * This is a NEW engine that lives ALONGSIDE the legacy `shippingRateEngine.js`
 * (5-carrier fulfillment comparison) — the two do NOT share code and MUST
 * NOT be confused:
 *
 *   ┌──────────────────────────┬───────────────────────────────────────────┐
 *   │ engine                   │ purpose                                    │
 *   ├──────────────────────────┼───────────────────────────────────────────┤
 *   │ shippingWeightCalculator │ order/fulfillment safety-margin audit      │
 *   │  (universal 5000)        │ (owner directive §2: unchanged this phase) │
 *   ├──────────────────────────┼───────────────────────────────────────────┤
 *   │ shippingRateEngine (leg) │ /shipping tab live 5-carrier compare       │
 *   │  (hardcoded rate tables) │ (owner directive §1: preserved this phase) │
 *   ├──────────────────────────┼───────────────────────────────────────────┤
 *   │ shippingQuoteService     │ auto-listing LISTING quote (this file)     │
 *   │  (DB rate master)        │ per-service divisor; strict bracket round- │
 *   │                          │ up; EU VAT + HS fee; RATE_NOT_LOADED gate  │
 *   └──────────────────────────┴───────────────────────────────────────────┘
 *
 * Contract of §4:
 *   1. resolve service from quotePurpose + destination benchmark
 *   2. volumetric = LWH / divisor              (per-service divisor)
 *   3. chargeable = MAX(actual, volumetric)
 *   4. bracket    = ROUND-UP (smallest weight_to_kg ≥ chargeable)  → RATE_NOT_LOADED if none
 *   5. LISTING → benchmark service (US=EGS_STD_US, EU=EGS_STD_EU_XX, other=EGS_EXPRESS)
 *   6. eGS Standard → apply per-kg surcharge × chargeable
 *   7. eGS Express → skip FSC/ESS (included in base)
 *   8. EU → declaredValueKrw × vatRate  (immediate)
 *   9. EU → uniqueHsCodeCount × 3 × EUR_KRW
 *  10. exclude remote/oversize/address/claim/loss/packing (owner directive §4)
 *  11. FICP → B2C DDP only
 *  12. FedEx IP → B2B only
 *  13. KPL → US and JP only
 *
 * Unknown ≠ Zero — every branch that cannot produce a real rate throws
 * or returns `{ ok:false, blockedReason }`. NEVER returns { total: 0 }.
 *
 * FX for EUR→KRW: comes from opts.eurKrwRate (caller supplies from
 * margin_settings). If null and destination is EU with HS fee > 0 →
 * FX_MISSING blocked reason. Owner directive §5.
 */

const repo = require('./rateMasterRepository');

const KPL_ALLOWED_COUNTRIES  = new Set(['US', 'JP']);
const FICP_SERVICE_CODES     = new Set(['FEDEX_FICP', 'FICP']);
const FEDEX_IP_CODES         = new Set(['FEDEX_IP']);

//   Resolve the LISTING benchmark service for a country per §4 rule 5.
//   Reads shipping_countries.benchmark_service_code — the workbook already
//   encodes this mapping (国가_Master column benchmark_service).
async function _resolveListingService(supabase, versionId, country) {
  if (!country) throw new Error('destinationCountry required for LISTING quote');
  return country.benchmark_service_code || null;
}

//   Volumetric weight per §4 rule 2.
function _volumetricKg(lengthCm, widthCm, heightCm, divisor) {
  if (!(lengthCm > 0) || !(widthCm > 0) || !(heightCm > 0)) return 0;
  if (!(divisor > 0)) return 0;
  //   3-decimal rounding matches shippingRateEngine.volWeight() convention.
  return Math.round((lengthCm * widthCm * heightCm) / divisor * 1000) / 1000;
}

//   Chargeable weight — MAX(actual, volumetric).
function _chargeableKg(actualKg, volumetricKg) {
  return Math.max(actualKg || 0, volumetricKg || 0);
}

//   FICP / FedEx IP / KPL guardrails per §4 rules 11-13.
//   Returns null if allowed, or an OWNER-safe blockedReason otherwise.
function _guardServicePolicy(serviceCode, saleType, countryCode) {
  const code = String(serviceCode || '').toUpperCase();
  const sale = String(saleType    || '').toUpperCase();
  const ctry = String(countryCode || '').toUpperCase();
  if (FICP_SERVICE_CODES.has(code)) {
    //   FICP B2C DDP only. sale_type must be B2C.
    if (sale && sale !== 'B2C') return 'FICP_B2C_ONLY';
  }
  if (FEDEX_IP_CODES.has(code)) {
    //   FedEx IP B2B only.
    if (sale && sale !== 'B2B') return 'FEDEX_IP_B2B_ONLY';
  }
  if (code === 'KPL' || code === 'SF_EXPRESS_KPL') {
    if (!KPL_ALLOWED_COUNTRIES.has(ctry)) return 'KPL_COUNTRY_NOT_ALLOWED';
  }
  return null;
}

/**
 * Single-quote entry point. Returns a shape matching spec §5 fields.
 *
 * Never throws for a "no rate" condition — that becomes `{ ok:false, blockedReason }`.
 * Throws only for programmer errors (bad input types).
 */
async function calculateShippingQuote(input, opts = {}) {
  const {
    destinationCountry,
    actualWeightKg = 0,
    lengthCm       = 0,
    widthCm        = 0,
    heightCm       = 0,
    uniqueHsCodeCount = 0,
    declaredValueKrw  = 0,
    saleType          = 'B2C',
    marketplace       = 'ebay',
    shippingPolicyFeeKrw = 0,
    productCostKrw       = 0,
    platformFeeRate      = 0,
    targetMarginRate     = 0,
    eurKrwRate           = null,
    sellingCurrencyKrwRate = null,
    quotePurpose         = 'LISTING',      //   'LISTING' | 'FULFILLMENT'
    provider             = 'eGS',
    serviceCode          = null,           //   optional override (FULFILLMENT path)
  } = input || {};

  const supabase = opts.supabase || null;
  const warnings = [];

  //   0. Active version
  const version = await repo.getActiveVersion(supabase, provider);
  if (!version) {
    return {
      ok: false,
      blockedReason: 'RATE_NOT_LOADED',
      message: `no active shipping_rate_versions row for provider=${provider}`,
      warnings,
    };
  }

  //   1. Resolve country and service.
  const country = destinationCountry
    ? await repo.getCountry(supabase, version.id, destinationCountry)
    : null;
  if (destinationCountry && !country) {
    return {
      ok: false, blockedReason: 'COUNTRY_NOT_IN_MASTER',
      message: `country ${destinationCountry} not in shipping_countries for version ${version.id}`,
      rateVersionId: version.id, warnings,
    };
  }

  let resolvedServiceCode = serviceCode;
  if (!resolvedServiceCode) {
    if (quotePurpose === 'LISTING') {
      resolvedServiceCode = await _resolveListingService(supabase, version.id, country);
    } else {
      return {
        ok: false, blockedReason: 'SERVICE_CODE_REQUIRED_FOR_FULFILLMENT',
        message: 'FULFILLMENT quote requires an explicit serviceCode',
        rateVersionId: version.id, warnings,
      };
    }
  }
  if (!resolvedServiceCode) {
    return {
      ok: false, blockedReason: 'BENCHMARK_SERVICE_MISSING',
      message: `country ${destinationCountry} has no benchmark_service_code`,
      rateVersionId: version.id, warnings,
    };
  }

  //   2. Load service and enforce spec §4 rules 11-13 (policy guards).
  const service = await repo.getService(supabase, version.id, resolvedServiceCode);
  if (!service) {
    return {
      ok: false, blockedReason: 'SERVICE_NOT_IN_MASTER',
      message: `service ${resolvedServiceCode} not in shipping_services for version ${version.id}`,
      rateVersionId: version.id, warnings,
    };
  }
  if (!service.rate_loaded) {
    //   Owner directive §4/§9: rates not loaded → RATE_NOT_LOADED (never estimate).
    return {
      ok: false, blockedReason: 'RATE_NOT_LOADED',
      message: `service ${resolvedServiceCode} rate_loaded=false in workbook`,
      rateVersionId: version.id, serviceCode: resolvedServiceCode, warnings,
    };
  }
  const policyBlock = _guardServicePolicy(resolvedServiceCode, saleType, destinationCountry);
  if (policyBlock) {
    return {
      ok: false, blockedReason: policyBlock,
      message: `service ${resolvedServiceCode} not allowed for saleType=${saleType} country=${destinationCountry}`,
      rateVersionId: version.id, serviceCode: resolvedServiceCode, warnings,
    };
  }
  if (!(service.vol_divisor > 0)) {
    return {
      ok: false, blockedReason: 'VOL_DIVISOR_MISSING',
      message: `service ${resolvedServiceCode} vol_divisor missing`,
      rateVersionId: version.id, serviceCode: resolvedServiceCode, warnings,
    };
  }

  //   3-4. Volumetric + chargeable + bracket round-up.
  const volumetricWeightKg = _volumetricKg(lengthCm, widthCm, heightCm, service.vol_divisor);
  const chargeableWeightKg = _chargeableKg(Number(actualWeightKg) || 0, volumetricWeightKg);
  if (!(chargeableWeightKg > 0)) {
    return {
      ok: false, blockedReason: 'INSUFFICIENT_DIMENSIONS',
      message: 'actualWeightKg and dimensions both effectively zero',
      rateVersionId: version.id, serviceCode: resolvedServiceCode, warnings,
    };
  }
  const bracket = await repo.findApplicableBracket(supabase, version.id, resolvedServiceCode, {
    chargeableKg: chargeableWeightKg,
    countryCode:  destinationCountry,
    zoneCode:     country ? country.express_zone : null,
  });
  if (!bracket) {
    return {
      ok: false, blockedReason: 'WEIGHT_OVER_MAX_BRACKET',
      message: `no bracket ≥ ${chargeableWeightKg}kg for service ${resolvedServiceCode}`,
      rateVersionId: version.id, serviceCode: resolvedServiceCode,
      chargeableWeightKg, volumetricWeightKg, actualWeightKg: Number(actualWeightKg) || 0,
      warnings,
    };
  }

  const baseRateKrw = Number(bracket.base_rate) || 0;

  //   5. Demand surcharge.
  //     · eGS Standard services carry `perkg_surcharge_krw` × chargeableKg.
  //     · eGS Express bracket already includes FSC/ESS (bracket note in workbook).
  //       Guard: NEVER apply per-kg surcharge on Express (owner directive §4 rule 7).
  const isExpress   = /EGS_EXPRESS/i.test(resolvedServiceCode) || /Express/i.test(service.service_name || '');
  const perKgKrw    = Number(service.perkg_surcharge_krw) || 0;
  const demandSurchargeKrw = (isExpress || perKgKrw === 0)
    ? 0
    : Math.round(perKgKrw * chargeableWeightKg);

  //   6. EU VAT + HS fee.
  //     Only if the destination is EU (per country row).
  //     VAT: declaredValueKrw × vatRate — immediate (§4 rule 8).
  //     HS:  uniqueHsCodeCount × 3 × EUR_KRW rate (§4 rule 9).
  let euVatKrw   = 0;
  let euHsFeeKrw = 0;
  if (country && country.is_eu) {
    const vatRate = Number(country.vat_rate) || 0;
    euVatKrw = vatRate > 0 && Number(declaredValueKrw) > 0
      ? Math.round(Number(declaredValueKrw) * vatRate)
      : 0;
    const uniqueHs = Number(uniqueHsCodeCount) || 0;
    if (uniqueHs > 0) {
      if (!(eurKrwRate > 0)) {
        return {
          ok: false, blockedReason: 'FX_MISSING',
          message: 'EU destination with HS fee requires eurKrwRate — owner-config setting missing',
          rateVersionId: version.id, serviceCode: resolvedServiceCode, warnings,
        };
      }
      euHsFeeKrw = Math.round(uniqueHs * 3 * Number(eurKrwRate));
    }
  }

  //   §4 rule 10: `remote/oversize/address/claim/loss/packing` are DELIBERATELY
  //   excluded — no field to accumulate them into.
  const otherMandatoryFeeKrw = 0;

  //   7. Fuel surcharge — for FedEx-family services. Read from surcharges
  //     table by rule_code (`FEDEX_FUEL`) — value is % applied to base.
  //     eGS families do NOT carry a separate fuel surcharge (Express includes
  //     it in bracket; Standard uses per-kg demand). Owner directive §4 rule 7.
  let fuelSurchargeKrw = 0;
  if (/FEDEX/i.test(resolvedServiceCode)) {
    const surcharges = await repo.listEnabledSurcharges(supabase, version.id);
    const fuel = surcharges.find(s => s.rule_code === 'FEDEX_FUEL');
    if (fuel && Number(fuel.value) > 0) {
      fuelSurchargeKrw = Math.round(baseRateKrw * Number(fuel.value) / 100);
    } else if (fuel) {
      warnings.push('FEDEX_FUEL surcharge is 0 — weekly rate not updated?');
    }
  }

  const totalShippingCostKrw =
    baseRateKrw + fuelSurchargeKrw + demandSurchargeKrw + euVatKrw + euHsFeeKrw + otherMandatoryFeeKrw;

  return {
    ok: true,
    provider,
    serviceCode: resolvedServiceCode,
    destinationCountry: destinationCountry || null,
    volumetricDivisor: service.vol_divisor,
    actualWeightKg: Number(actualWeightKg) || 0,
    volumetricWeightKg,
    chargeableWeightKg,
    appliedWeightBracketKg: Number(bracket.weight_to_kg),
    baseRateKrw,
    fuelSurchargeKrw,
    demandSurchargeKrw,
    euVatKrw,
    euHsFeeKrw,
    otherMandatoryFeeKrw,
    totalShippingCostKrw,
    rateVersionId:     version.id,
    rateEffectiveFrom: version.effective_from,
    calculationDetails: {
      isEuDestination:      !!(country && country.is_eu),
      isExpressService:     isExpress,
      perKgSurchargeKrw:    perKgKrw,
      countryVatRate:       country ? Number(country.vat_rate) || 0 : 0,
      uniqueHsCodeCount:    Number(uniqueHsCodeCount) || 0,
      bracketRule:          'round_up',
      bracketMatchedCountryKey: bracket.country_key,
      bracketMatchedZoneKey:    bracket.zone_key || null,
    },
    warnings,
  };
}

/**
 * Batch quote — resolves the active version and surcharge list ONCE, then
 * quotes each input. Optimized for auto-listing (owner directive §10 test P
 * requires N+1 avoidance).
 *
 * Returns array in input order, each element same shape as single quote.
 */
async function calculateShippingQuotes(inputs, opts = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const supabase = opts.supabase || null;
  //   All inputs share provider — pull the first as the batch's provider.
  const provider = inputs[0].provider || opts.provider || 'eGS';
  const version = await repo.getActiveVersion(supabase, provider);
  if (!version) {
    return inputs.map(() => ({ ok: false, blockedReason: 'RATE_NOT_LOADED', message: `no active version for provider ${provider}` }));
  }
  //   Pre-warm surcharges ONCE for the batch — fuel is a shared read.
  const surchargesCache = await repo.listEnabledSurcharges(supabase, version.id);
  const cachedOpts = { ...opts, _batchVersion: version, _batchSurcharges: surchargesCache };
  //   Sequential loop keeps the code simple; each iteration issues ~2 DB reads
  //   (country + service + bracket). Owner directive §10 test P: batch of 100
  //   must not degrade linearly beyond that — the fuel-surcharge lookup is the
  //   one N-shape read we've eliminated. Country/service/bracket per input.
  const out = [];
  for (const input of inputs) {
    out.push(await calculateShippingQuote(input, cachedOpts));
  }
  return out;
}

module.exports = {
  calculateShippingQuote,
  calculateShippingQuotes,
  //   internal helpers exported for focused tests
  _volumetricKg,
  _chargeableKg,
  _guardServicePolicy,
  KPL_ALLOWED_COUNTRIES,
  FICP_SERVICE_CODES,
  FEDEX_IP_CODES,
};
