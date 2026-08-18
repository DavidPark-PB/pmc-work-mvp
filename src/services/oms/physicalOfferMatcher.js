/**
 * src/services/oms/physicalOfferMatcher.js — Phase 7C · pure.
 *
 * Match a normalized supplier offer to a physical_product using the SAME
 * structured evidence as Phase 7A-4c/e physicalIdentityDiagnostic:
 *   - multi-word set_name phrase
 *   - set_code word-boundary
 *   - unit_type / language decisive
 *
 * Title substring alone is never sufficient (Owner Part C).
 *
 * States:
 *   EXACT_OR_STRONG_MATCH        — phrase + set_code + unit + language all agree
 *   PROBABLE_MATCH               — 2 of 3 structural signals agree; unit ok
 *   AMBIGUOUS                    — signals partially agree; requires human review
 *   NOT_SAME_PHYSICAL            — language/unit hard mismatch
 *   INSUFFICIENT_EVIDENCE        — no structured hint fires at all
 */
'use strict';

const { _internals: shared } = require('./physicalIdentityDiagnostic');

const IDENTITY_STATUS = Object.freeze({
  EXACT_OR_STRONG_MATCH: 'EXACT_OR_STRONG_MATCH',
  PROBABLE_MATCH: 'PROBABLE_MATCH',
  AMBIGUOUS: 'AMBIGUOUS',
  NOT_SAME_PHYSICAL: 'NOT_SAME_PHYSICAL',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});

/**
 * @param {{title:string, supplier_sku?:string, unit_signals?:object, packaging?:string, physical_units_per_offer?:number}} normalizedOffer
 * @param {Object} physical  physical_products row
 */
function matchOfferToPhysical(normalizedOffer, physical) {
  if (!normalizedOffer || typeof normalizedOffer !== 'object') throw new Error('matchOfferToPhysical: offer required');
  if (!physical || typeof physical !== 'object') throw new Error('matchOfferToPhysical: physical required');

  const hints = shared.buildStructuredHints(physical);
  const item = { title: normalizedOffer.title, marketplace_sku: normalizedOffer.supplier_sku ?? '' };
  const passCheck = shared.passesStructuredHints(item, hints);

  const reasonCodes = [];
  const evidence = {
    phrase_hit: passCheck.phrase_hit,
    set_code_hit: passCheck.set_code_hit,
    hit_tokens: passCheck.hits,
    language_signal: null,
    unit_signal: null,
  };

  if (!passCheck.pass) {
    return {
      status: IDENTITY_STATUS.INSUFFICIENT_EVIDENCE,
      confidence: 'none',
      reason_codes: ['no_phrase_or_set_code_hit'],
      evidence,
    };
  }

  const signals = normalizedOffer.unit_signals || shared.detectUnitSignals(normalizedOffer.title, normalizedOffer.supplier_sku || '');
  const wantLanguage = String(physical.language || '').toLowerCase();
  const wantUnitType = String(physical.unit_type || '').toLowerCase();

  // Language decisive
  if (wantLanguage === 'ko' && signals.mentions_japanese && !signals.mentions_korean) {
    evidence.language_signal = 'listing_japanese_physical_korean';
    return { status: IDENTITY_STATUS.NOT_SAME_PHYSICAL, confidence: 'strong_reject',
      reason_codes: ['language_mismatch'], evidence };
  }
  if (wantLanguage === 'ja' && signals.mentions_korean && !signals.mentions_japanese) {
    evidence.language_signal = 'listing_korean_physical_japanese';
    return { status: IDENTITY_STATUS.NOT_SAME_PHYSICAL, confidence: 'strong_reject',
      reason_codes: ['language_mismatch'], evidence };
  }

  // Unit decisive (physical=booster_box)
  if (wantUnitType === 'booster_box') {
    if (signals.is_single_card) {
      evidence.unit_signal = 'single_card';
      return { status: IDENTITY_STATUS.NOT_SAME_PHYSICAL, confidence: 'strong_reject',
        reason_codes: ['unit_mismatch:single_card'], evidence };
    }
    if (signals.is_accessory) {
      evidence.unit_signal = 'accessory';
      return { status: IDENTITY_STATUS.NOT_SAME_PHYSICAL, confidence: 'strong_reject',
        reason_codes: ['unit_mismatch:accessory'], evidence };
    }
    if (signals.is_booster_pack && !signals.is_booster_box) {
      evidence.unit_signal = 'loose_booster_pack';
      return { status: IDENTITY_STATUS.NOT_SAME_PHYSICAL, confidence: 'strong_reject',
        reason_codes: ['unit_mismatch:loose_booster_pack'], evidence };
    }
    // Multi-box / bundle-promo are same physical but different unit — still MATCH (normalizer handled qty)
    evidence.unit_signal = signals.is_case ? 'multi_box_case' : signals.is_bundle_with_promo ? 'bundle_with_promo' : 'single_booster_box';
  }

  const languageAgrees = wantLanguage === 'ko'
    ? (signals.mentions_korean === true)
    : wantLanguage === 'ja'
      ? (signals.mentions_japanese === true)
      : null;

  // Confidence scoring (structured evidence only)
  let score = 0;
  if (evidence.phrase_hit) score += 2;
  if (evidence.set_code_hit) score += 2;
  if (languageAgrees === true) score += 1;
  if (wantUnitType === 'booster_box' && (signals.is_booster_box || signals.is_case || signals.is_bundle_with_promo)) score += 1;

  let status, confidence;
  if (score >= 5) { status = IDENTITY_STATUS.EXACT_OR_STRONG_MATCH; confidence = 'high'; }
  else if (score >= 4) { status = IDENTITY_STATUS.EXACT_OR_STRONG_MATCH; confidence = 'medium'; }
  else if (score >= 3) { status = IDENTITY_STATUS.PROBABLE_MATCH; confidence = 'medium'; }
  else if (score >= 2) { status = IDENTITY_STATUS.PROBABLE_MATCH; confidence = 'low'; }
  else { status = IDENTITY_STATUS.AMBIGUOUS; confidence = 'low'; }

  reasonCodes.push(`score_${score}`);
  if (evidence.phrase_hit) reasonCodes.push('phrase_match');
  if (evidence.set_code_hit) reasonCodes.push('set_code_match');
  if (languageAgrees === true) reasonCodes.push('language_match');
  if (languageAgrees === false) reasonCodes.push('language_not_stated');

  return { status, confidence, reason_codes: reasonCodes, evidence };
}

module.exports = { IDENTITY_STATUS, matchOfferToPhysical };
