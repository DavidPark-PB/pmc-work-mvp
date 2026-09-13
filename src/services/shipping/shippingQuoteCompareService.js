'use strict';

/**
 * src/services/shipping/shippingQuoteCompareService.js
 * PMC-CCOREA-SHIPPING-1C MULTI-CARRIER QUOTE (2026-09-13 · SHADOW).
 *
 * Directive summary:
 *   · Every active shipping service is quoted for the input parcel.
 *   · Each candidate returns { status, quote?, unavailableReason? }.
 *   · Branded products (isBranded=true) exclude eGS by default via a
 *     row in `shipping_eligibility_rules`, but any operator-added row
 *     may narrow/widen this per brand/service/country/sale_type.
 *   · KPL is JP-only + US-only in this workbook — the service_code list
 *     for KPL enforces this via the country_key on the bracket.
 *   · No prices are fabricated. Services without a loaded rate return
 *     status RATE_NOT_LOADED with a NULL quote — never a 0-원 estimate.
 *   · authoritative pricing / eBay payload is UNCHANGED — this is a
 *     shadow surface only. The route that consumes it is admin-only.
 *
 * Shadow-safe: every read against a new-schema table (117) is guarded
 * so this file works on the current production schema too. If migration
 * 117 has not been applied, the eligibility check falls back to a
 * hard-coded "branded → exclude eGS" rule so the UX still behaves.
 */

const quoteService = require('./shippingQuoteService');
const repo         = require('./rateMasterRepository');
const { getClient } = require('../../db/supabaseClient');

//   Status enumeration — kept as strings so the SPA can render Korean
//   labels via a switch without importing constants across the boundary.
const STATUS = Object.freeze({
  ELIGIBLE:              'ELIGIBLE',
  INELIGIBLE:            'INELIGIBLE',
  RATE_NOT_LOADED:       'RATE_NOT_LOADED',
  COUNTRY_NOT_SUPPORTED: 'COUNTRY_NOT_SUPPORTED',
  WEIGHT_NOT_SUPPORTED:  'WEIGHT_NOT_SUPPORTED',
  SALE_TYPE_NOT_SUPPORTED: 'SALE_TYPE_NOT_SUPPORTED',
  BRAND_RESTRICTED:      'BRAND_RESTRICTED',
});

//   All providers this workbook knows about. Owner directive §5:
//   include unloaded providers so the operator sees they exist but the
//   row is disabled — never quote a fake price for them.
const KNOWN_PROVIDERS = ['eGS', 'KPL', 'SHIPTER', 'FedEx', 'KoreaPost'];

//   Owner directive §5: KPL only ships to US and JP in this workbook.
//   The rate rows themselves enforce this via country_key, but we filter
//   at the eligibility layer so operators see a clean "not applicable"
//   status instead of a WEIGHT_NOT_SUPPORTED for the wrong reason.
const PROVIDER_COUNTRY_SCOPE = { KPL: new Set(['US', 'JP']) };

/**
 * Load the operator-editable eligibility rules for a given restriction key.
 * Falls back to an in-code default when migration 117 has not been applied
 * (table absent) so this service works during the shadow rollout.
 */
async function _loadEligibilityRules(supabase) {
  try {
    const r = await supabase
      .from('shipping_eligibility_rules')
      .select('provider, service_code, restriction_type, brand_name, country_scope, sale_type, allowed, active')
      .eq('active', true);
    if (r.error) throw r.error;
    return { rules: r.data || [], source: 'db' };
  } catch (e) {
    //   Table absent (migration 117 not applied) OR another read error.
    //   Fall through to the hard-coded default so the UX still behaves.
    //   Never fabricate a rule that is more permissive than the default.
    if (/relation .* does not exist|schema cache/i.test(String(e.message || e))) {
      return {
        rules: [{
          provider: 'eGS', service_code: null, restriction_type: 'brand_all',
          brand_name: '*', country_scope: null, sale_type: null, allowed: false, active: true,
        }],
        source: 'fallback',
      };
    }
    throw e;
  }
}

/**
 * Given a service + input, decide whether an operator-editable rule
 * (or fallback) restricts it. Returns null when there is no matching
 * restriction; otherwise returns { code: 'BRAND_RESTRICTED', ruleNote }.
 *
 * Rule matching order (first match wins per (provider, service_code)):
 *   1. explicit allow (allowed=true) → returns null (permitted)
 *   2. explicit deny (allowed=false) → returns restriction
 *   3. no rule matches → returns null (permitted)
 */
function _evaluateEligibility(rules, svc, input) {
  const relevant = rules.filter(r => {
    if (r.provider !== svc.provider) return false;
    if (r.service_code && r.service_code !== svc.service_code) return false;
    //   brand_name: '*' wildcard, exact match, or NULL for "any brand"
    if (r.brand_name === '*') {
      if (!input.isBranded) return false;   //   wildcard means "when branded"
    } else if (r.brand_name != null) {
      if (String(input.brandName || '').toLowerCase() !== r.brand_name.toLowerCase()) return false;
    }
    if (r.country_scope) {
      const c = String(input.destinationCountry || '').toUpperCase();
      if (r.country_scope !== c && r.country_scope !== 'ALL') return false;
    }
    if (r.sale_type && r.sale_type !== input.saleType) return false;
    return true;
  });
  //   Precedence: an explicit allow anywhere in the relevant set overrides
  //   any deny at the same level. This lets an operator say "eGS is banned
  //   for all branded products EXCEPT this specific service".
  if (relevant.some(r => r.allowed === true)) return null;
  const deny = relevant.find(r => r.allowed === false);
  if (deny) {
    return {
      code: STATUS.BRAND_RESTRICTED,
      unavailableReason: deny.brand_name === '*'
        ? '브랜드 제품 이용 불가 정책 (운영자 설정)'
        : `브랜드 "${deny.brand_name}" 이용 불가 (운영자 설정)`,
    };
  }
  return null;
}

/**
 * Load all active services across all active rate_version_ids.
 * Structured so downstream code can group by provider for the compare UI.
 */
async function _loadAllActiveServices(supabase) {
  const versionsRes = await supabase
    .from('shipping_rate_versions')
    .select('id, provider, effective_from, status')
    .eq('status', 'active');
  if (versionsRes.error) throw versionsRes.error;
  const versions = versionsRes.data || [];
  const versionIds = versions.map(v => v.id);
  const versionByProvider = new Map(versions.map(v => [v.provider, v]));

  if (versionIds.length === 0) return { services: [], versionByProvider };

  //   pagination is not needed here — services table is small (< 200 rows)
  //   even at 5x growth, but we use fetchAllPaginated for consistency.
  const importer = require('./rateMasterImporter');
  const svcRows = await importer.fetchAllPaginated(() => supabase
    .from('shipping_services')
    .select('provider, service_code, service_name, vol_divisor, incoterm, rate_loaded, sale_type, active')
    .in('rate_version_id', versionIds)
    .eq('active', true));

  //   Attach version metadata to each service so we can pass it back.
  const decorated = svcRows.map(s => {
    const v = versionByProvider.get(s.provider);
    return {
      ...s,
      rateVersionId:     v ? v.id : null,
      rateEffectiveFrom: v ? v.effective_from : null,
    };
  });

  //   Also include known providers that are NOT loaded (SHIPTER etc.) so
  //   the compare table shows them as "운임 미등록" (§5).
  const loadedProviders = new Set(decorated.map(s => s.provider));
  const placeholders = [];
  for (const p of KNOWN_PROVIDERS) {
    if (loadedProviders.has(p)) continue;
    placeholders.push({
      provider: p, service_code: `${p}_NOT_LOADED`, service_name: `${p} (운임 미등록)`,
      vol_divisor: null, incoterm: null, rate_loaded: false, sale_type: null, active: true,
      rateVersionId: null, rateEffectiveFrom: null,
      __placeholder: true,
    });
  }
  return { services: [...decorated, ...placeholders], versionByProvider };
}

/**
 * Main entry — compare across every candidate service. Never throws for
 * per-service failures; each service surfaces its own status.
 *
 * @param {object} input   parcel + destination + brand context
 * @param {object} opts    { supabase }
 * @returns {Promise<object>} { ok, candidates: [...], recommendedServiceCode, warnings, brandStatusUnknown }
 */
async function calculateMultiCarrierQuotes(input, opts = {}) {
  const supabase = opts.supabase || getClient();
  const warnings = [];

  //   Owner directive §4: unknown brand status must NOT default to
  //   non-branded. Surface a warning + include the compare list but mark
  //   the recommendation as unsafe.
  const brandStatusUnknown = input.isBranded == null;
  if (brandStatusUnknown) {
    warnings.push('BRAND_STATUS_UNKNOWN — 상품의 브랜드 여부가 미입력입니다. 운영자가 확인하기 전에는 자동 리스팅을 진행하지 마세요.');
  }

  const [{ services }, { rules, source: rulesSource }] = await Promise.all([
    _loadAllActiveServices(supabase),
    _loadEligibilityRules(supabase),
  ]);
  if (rulesSource === 'fallback') {
    warnings.push('ELIGIBILITY_RULES_FALLBACK — shipping_eligibility_rules 테이블이 아직 없어 하드코딩 기본 규칙(브랜드→eGS 제외)을 적용했습니다. Migration 117 적용 후 사라집니다.');
  }

  const candidates = [];
  for (const svc of services) {
    //   Provider-country scope (KPL US/JP only, per workbook).
    const scope = PROVIDER_COUNTRY_SCOPE[svc.provider];
    if (scope && input.destinationCountry
        && !scope.has(String(input.destinationCountry).toUpperCase())) {
      candidates.push(_makeCandidate(svc, {
        status: STATUS.COUNTRY_NOT_SUPPORTED,
        unavailableReason: `${svc.provider}는 ${[...scope].join('/')}만 지원합니다`,
      }));
      continue;
    }

    //   Placeholder services (not loaded yet — SHIPTER/FedEx/KoreaPost).
    if (svc.__placeholder || !svc.rate_loaded) {
      candidates.push(_makeCandidate(svc, {
        status: STATUS.RATE_NOT_LOADED,
        unavailableReason: `${svc.provider} 운임이 아직 등록되지 않았습니다`,
      }));
      continue;
    }

    //   Sale-type restriction from the service row itself (workbook column).
    if (svc.sale_type && input.saleType && String(svc.sale_type).toUpperCase() !== 'ANY'
        && String(svc.sale_type).toUpperCase() !== String(input.saleType).toUpperCase()) {
      candidates.push(_makeCandidate(svc, {
        status: STATUS.SALE_TYPE_NOT_SUPPORTED,
        unavailableReason: `이 서비스는 ${svc.sale_type}만 지원합니다 (요청: ${input.saleType})`,
      }));
      continue;
    }

    //   Brand eligibility (operator-editable rules).
    const denial = _evaluateEligibility(rules, svc, input);
    if (denial) {
      candidates.push(_makeCandidate(svc, {
        status: denial.code,
        unavailableReason: denial.unavailableReason,
      }));
      continue;
    }

    //   Actually calculate. calculateShippingQuote returns { ok:false, blockedReason }
    //   for per-service failures (weight-over-max, country-not-in-master).
    //   Map those to the candidate status enum without inventing a price.
    let quote;
    try {
      quote = await quoteService.calculateShippingQuote({
        ...input,
        provider:    svc.provider,
        serviceCode: svc.service_code,
        quotePurpose: 'FULFILLMENT',   //   force explicit service, no benchmark auto-pick
      }, { supabase });
    } catch (e) {
      candidates.push(_makeCandidate(svc, {
        status: STATUS.INELIGIBLE,
        unavailableReason: `계산 오류: ${e.message}`,
      }));
      continue;
    }

    if (!quote || quote.ok === false) {
      const reason = quote && quote.blockedReason;
      const status =
        reason === 'RATE_NOT_LOADED'        ? STATUS.RATE_NOT_LOADED :
        reason === 'COUNTRY_NOT_IN_MASTER'  ? STATUS.COUNTRY_NOT_SUPPORTED :
        reason === 'WEIGHT_OVER_MAX_BRACKET' ? STATUS.WEIGHT_NOT_SUPPORTED :
        STATUS.INELIGIBLE;
      candidates.push(_makeCandidate(svc, {
        status, unavailableReason: (quote && quote.message) || '견적 실패',
      }));
      continue;
    }

    //   ELIGIBLE — include the full quote payload so the UI can render
    //   the line-item breakdown without a second call.
    candidates.push(_makeCandidate(svc, {
      status: STATUS.ELIGIBLE,
      quote,
    }));
  }

  //   Recommendation: cheapest ELIGIBLE only. Never recommend a
  //   restricted service even if it is cheaper (§7).
  const eligible = candidates.filter(c => c.status === STATUS.ELIGIBLE);
  eligible.sort((a, b) => (a.totalShippingCostKrw || 0) - (b.totalShippingCostKrw || 0));
  const recommendedServiceCode = eligible.length ? eligible[0].serviceCode : null;

  return {
    ok: true,
    candidates,
    recommendedServiceCode,
    warnings,
    brandStatusUnknown,
  };
}

function _makeCandidate(svc, extra) {
  const q = extra.quote || {};
  return {
    provider:              svc.provider,
    serviceCode:           svc.service_code,
    serviceName:           svc.service_name,
    incoterm:              svc.incoterm || null,
    rateLoaded:            !!svc.rate_loaded,
    status:                extra.status,
    eligible:              extra.status === STATUS.ELIGIBLE,
    unavailableReason:     extra.unavailableReason || null,
    //   Quote fields — null on non-ELIGIBLE (owner directive §3:
    //   "금액이 없는 서비스를 0원으로 표시하면 안 된다").
    actualWeightKg:        q.actualWeightKg        ?? null,
    volumetricWeightKg:    q.volumetricWeightKg    ?? null,
    chargeableWeightKg:    q.chargeableWeightKg    ?? null,
    appliedWeightBracketKg: q.appliedWeightBracketKg ?? null,
    baseRateKrw:           q.baseRateKrw           ?? null,
    surchargeKrw:          extra.status === STATUS.ELIGIBLE
                             ? (Number(q.fuelSurchargeKrw || 0) + Number(q.demandSurchargeKrw || 0))
                             : null,
    dutyVatKrw:            q.euVatKrw              ?? null,
    euHsFeeKrw:            q.euHsFeeKrw            ?? null,
    totalShippingCostKrw:  q.totalShippingCostKrw  ?? null,
    rateVersionId:         q.rateVersionId ?? svc.rateVersionId ?? null,
    rateEffectiveFrom:     q.rateEffectiveFrom ?? svc.rateEffectiveFrom ?? null,
    warnings:              Array.isArray(q.warnings) ? q.warnings : [],
  };
}

module.exports = {
  calculateMultiCarrierQuotes,
  STATUS,
  KNOWN_PROVIDERS,
  PROVIDER_COUNTRY_SCOPE,
  //   test-only exports
  _evaluateEligibility,
  _makeCandidate,
  _loadEligibilityRules,
  _loadAllActiveServices,
};
