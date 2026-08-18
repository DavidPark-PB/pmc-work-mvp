/**
 * src/services/oms/replacementObservationIngestor.js — Phase 7C · extended in 7C-4.
 *
 * Owner Part O (7C) + Owner §4/§8/§9/§11 (7C-4):
 *   - persist ONLY to physical_market_observations (observation_kind='replacement_price')
 *   - dry-run default; write only when confirm=true
 *   - manual staff observations require identityConfirmed=true before apply
 *   - append-only: never update prior observations
 *   - app-level idempotency via deterministic fingerprint stored in evidence.fingerprint
 *
 * ZERO writes to any other table. Never calls marketplace / eBay / Shopify.
 */
'use strict';

const crypto = require('crypto');
const { getClient } = require('../../db/supabaseClient');
const { normalizeOffer } = require('./replacementOfferNormalizer');
const { matchOfferToPhysical, IDENTITY_STATUS } = require('./physicalOfferMatcher');
const { computeReplacementLandedCost } = require('./replacementLandedCost');
const {
  EVIDENCE_TYPES,
  REQUIRES_CURRENT_QUOTE_CONFIRMATION,
  FORBIDS_CURRENT_QUOTE_CONFIRMATION,
  deriveEvidenceOrigin,
  deriveReferenceTimeSemantics,
} = require('./replacementEvidenceTypes');

/**
 * @param {Object} args
 * @param {Object} args.physical           physical_products row
 * @param {Array}  args.rawOffers          source-agnostic raw offers
 * @param {Object} [args.landedCostOpts]   input to computeReplacementLandedCost
 * @param {boolean} [args.confirm=false]   MUST be true to actually write
 * @param {boolean} [args.identityConfirmed=false]  required for manual quotes when confirm=true
 * @param {number}  [args.actorId=null]
 * @param {Object[]} [args.availabilityByOffer]     optional per-offer availability_status
 * @param {number[]} [args.leadTimeByOffer]         optional per-offer lead_time_days
 */
async function ingestReplacementObservations({
  physical, rawOffers, landedCostOpts, confirm = false,
  identityConfirmed = false,
  currentQuoteConfirmed = false,   // 7C-5 hotfix (Owner §2)
  actorId = null,
  availabilityByOffer = null, leadTimeByOffer = null,
  supplyMetaByOffer = null,   // 7C-5: [{ evidenceType, sourceClass, availableQuantityMin, ... }, ...]
} = {}) {
  if (!physical || !physical.id) throw new Error('ingestReplacementObservations: physical required');
  if (!Array.isArray(rawOffers)) throw new Error('rawOffers must be array');
  const dryRun = confirm !== true;
  const db = getClient();

  const analysed = [];
  for (let i = 0; i < rawOffers.length; i++) {
    const raw = rawOffers[i];
    const normalized = normalizeOffer(raw, physical);
    const rawMatch = matchOfferToPhysical(normalized, physical);
    // Owner §4: manual staff quote may promote identity match with explicit human confirmation.
    // We still keep the raw automated match as evidence.
    const effectiveMatch = identityConfirmed && rawMatch.status !== IDENTITY_STATUS.NOT_SAME_PHYSICAL
      ? { status: IDENTITY_STATUS.EXACT_OR_STRONG_MATCH, confidence: 'high',
          reason_codes: [...rawMatch.reason_codes, 'manual_owner_or_staff_confirmed'],
          evidence: { ...rawMatch.evidence, identity_confirmation: 'manual_owner_or_staff' } }
      : rawMatch;
    const cost = computeReplacementLandedCost(normalized, landedCostOpts || {});
    analysed.push({
      raw, normalized, match: effectiveMatch, raw_match: rawMatch, cost,
      availability_status: availabilityByOffer && availabilityByOffer[i] ? availabilityByOffer[i] : null,
      lead_time_days: leadTimeByOffer && Number.isFinite(leadTimeByOffer[i]) ? leadTimeByOffer[i] : null,
      supply_meta: (supplyMetaByOffer && supplyMetaByOffer[i]) || null,
    });
  }

  // Persistable = matches that pass identity gate
  const persistable = analysed.filter(a =>
    a.match.status === IDENTITY_STATUS.EXACT_OR_STRONG_MATCH ||
    a.match.status === IDENTITY_STATUS.PROBABLE_MATCH
  );

  // 7C-5 hotfix: current-quote gating diagnostics — always computed so dry-run
  // can WARN even when apply is not attempted (Owner §8 CLI UX).
  const currentQuoteWarnings = [];
  for (const a of persistable) {
    const et = a.supply_meta?.evidenceType;
    if (!et) continue;
    if (REQUIRES_CURRENT_QUOTE_CONFIRMATION.has(et) && !currentQuoteConfirmed) {
      currentQuoteWarnings.push({
        source_listing_id: a.raw.source_listing_id, evidence_type: et,
        code: 'current_quote_not_confirmed',
        message: `${et} requires --current-quote-confirmed (or currentQuoteConfirmed:true) before apply.`,
      });
    }
    if (FORBIDS_CURRENT_QUOTE_CONFIRMATION.has(et) && currentQuoteConfirmed) {
      currentQuoteWarnings.push({
        source_listing_id: a.raw.source_listing_id, evidence_type: et,
        code: 'current_quote_flag_forbidden_for_this_evidence_type',
        message: `${et} MUST NOT be marked as current quote (semantic mismatch). Do not pass --current-quote-confirmed for typical/historical types.`,
      });
    }
  }

  const plan = {
    dryRun,
    physical_product_id: physical.id,
    identity_confirmed: identityConfirmed,
    current_quote_confirmed: currentQuoteConfirmed,
    current_quote_warnings: currentQuoteWarnings,
    counts: {
      raw: rawOffers.length,
      normalized: analysed.length,
      persistable: persistable.length,
      by_identity_status: _tallyByStatus(analysed),
    },
    would_persist: persistable.map(a => _toObservationRow(a, physical, actorId, currentQuoteConfirmed)),
    rejected: analysed.filter(a =>
      a.match.status === IDENTITY_STATUS.NOT_SAME_PHYSICAL ||
      a.match.status === IDENTITY_STATUS.INSUFFICIENT_EVIDENCE ||
      a.match.status === IDENTITY_STATUS.AMBIGUOUS
    ).map(a => ({
      supplier_listing_id: a.raw.source_listing_id,
      title: a.raw.title,
      identity_status: a.match.status,
      reason_codes: a.match.reason_codes,
    })),
  };

  if (dryRun) {
    plan.status = 'dry_run';
    return plan;
  }

  // Refuse to write manual quotes that were promoted without confirmation
  // (Owner §4: identity_match_status must be explicitly confirmed).
  const anyManualUnconfirmed = persistable.some(a =>
    /manual/i.test(a.raw.source || '') && !identityConfirmed
  );
  if (anyManualUnconfirmed) {
    plan.status = 'aborted_identity_not_confirmed';
    plan.error = 'apply refused: manual staff quote requires identityConfirmed=true';
    return plan;
  }

  // 7C-5 hotfix (Owner §2/§8): current-quote types must be explicitly confirmed.
  const anyCurrentUnconfirmed = persistable.some(a => {
    const et = a.supply_meta?.evidenceType;
    return et && REQUIRES_CURRENT_QUOTE_CONFIRMATION.has(et) && !currentQuoteConfirmed;
  });
  if (anyCurrentUnconfirmed) {
    plan.status = 'aborted_current_quote_not_confirmed';
    plan.error = 'apply refused: SUPPLIER_QUOTE / EXECUTABLE_QUOTE require currentQuoteConfirmed=true';
    return plan;
  }
  const anyForbiddenFlag = persistable.some(a => {
    const et = a.supply_meta?.evidenceType;
    return et && FORBIDS_CURRENT_QUOTE_CONFIRMATION.has(et) && currentQuoteConfirmed;
  });
  if (anyForbiddenFlag) {
    plan.status = 'aborted_typical_reference_cannot_be_current_quote';
    plan.error = 'apply refused: TYPICAL_SUPPLIER_REFERENCE / ACTUAL_PURCHASE cannot carry currentQuoteConfirmed=true (semantic mismatch)';
    return plan;
  }

  // Idempotency: skip rows whose fingerprint already exists in PMO.
  const inserted = []; const skipped = []; const failed = [];
  for (let idx = 0; idx < plan.would_persist.length; idx++) {
    const row = plan.would_persist[idx];
    const fp = row.evidence.fingerprint;
    try {
      const exists = await _findExistingFingerprint(db, physical.id, fp);
      if (exists) {
        skipped.push({ existing_id: exists.id, fingerprint: fp, reason: 'idempotent_no_op' });
        continue;
      }
      const { data, error } = await db.from('physical_market_observations').insert(row).select('id').single();
      if (error) throw error;
      inserted.push(data);
    } catch (e) {
      // 7C-5 hotfix — surface the full PostgREST/Supabase error so CLI can print
      // code / constraint / details / hint. Never include secrets (row payload
      // itself may include supplier names but no credentials).
      failed.push({
        index: idx,
        row_source_listing_id: row.evidence.source_listing_id,
        fingerprint_prefix: fp ? fp.slice(0, 16) : null,
        code: e && e.code != null ? String(e.code) : null,
        message: e && e.message ? String(e.message) : String(e),
        details: e && e.details != null ? String(e.details) : null,
        hint: e && e.hint != null ? String(e.hint) : null,
        constraint: e && e.constraint != null ? String(e.constraint) : (e && e.details ? _extractConstraint(e.details) : null),
      });
    }
  }
  // 7C-5 hotfix (Owner §6): 1-row batch with 0 inserted MUST be 'failed', not 'partial'.
  if (failed.length === 0) plan.status = 'ingested';
  else if (inserted.length === 0) plan.status = 'failed';
  else plan.status = 'partial';
  plan.inserted = inserted;
  plan.skipped_idempotent = skipped;
  plan.failed = failed;
  return plan;
}

// Best-effort extraction of a Postgres constraint name from an error `details`
// string like `Key (foo)=... violates check constraint "chk_pmo_confidence"`.
function _extractConstraint(details) {
  if (!details) return null;
  const m = String(details).match(/constraint "([^"]+)"/);
  return m ? m[1] : null;
}

// ─── helpers ─────────────────────────────────────────────

function _tallyByStatus(analysed) {
  const out = {};
  for (const a of analysed) { const k = a.match.status; out[k] = (out[k] || 0) + 1; }
  return out;
}

function _toObservationRow(a, physical, actorId, currentQuoteConfirmed = false) {
  const { normalized, match, cost, availability_status, lead_time_days, supply_meta } = a;
  const sm = supply_meta || {};
  const et = sm.evidenceType || null;
  const evidenceOrigin = deriveEvidenceOrigin(et, !!currentQuoteConfirmed);
  const refTimeSemantics = deriveReferenceTimeSemantics(et);
  const supplierConfirmedCurrent = et && REQUIRES_CURRENT_QUOTE_CONFIRMATION.has(et)
    ? !!currentQuoteConfirmed
    : (et === EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE ? false : null);
  const fingerprint = _fingerprint({
    physicalProductId: physical.id,
    source: normalized.source,
    supplierId: normalized.supplier_id,
    supplierName: normalized.supplier_name,
    sourceListingId: normalized.source_listing_id,
    currency: normalized.currency,
    quotedPriceOffer: normalized.quoted_price_per_offer,
    physicalUnitsPerOffer: normalized.physical_units_per_offer,
    observedAt: normalized.observed_at,
    evidenceType: sm.evidenceType || null,
  });
  return {
    physical_product_id: physical.id,
    observed_at: normalized.observed_at,
    observation_kind: 'replacement_price',
    source: normalized.source || 'unknown',
    confidence: match.confidence === 'high' ? 'high'
              : match.confidence === 'medium' ? 'medium'
              : match.confidence === 'low' ? 'low' : 'unknown',   // schema CHECK: high|medium|low|unknown
    numeric_value: cost.product_cost.amount_krw_per_physical,     // null when FX unavailable — do not fabricate
    // 7C-5 hotfix: physical_market_observations.numeric_unit is varchar(20).
    // 'KRW_per_physical_unit' is 21 chars → violates schema (Postgres 22001).
    // Use short canonical label; full semantic is preserved in evidence JSON.
    numeric_unit: cost.product_cost.amount_krw_per_physical != null ? 'krw_per_phys' : null,
    evidence: {
      identity_match_status: match.status,
      identity_confidence: match.confidence,
      identity_confirmation: match.evidence?.identity_confirmation ?? null,
      identity_reason_codes: match.reason_codes,
      identity_evidence: match.evidence,
      raw_matcher_status: a.raw_match ? a.raw_match.status : null,
      raw_matcher_confidence: a.raw_match ? a.raw_match.confidence : null,
      title: normalized.title,
      packaging: normalized.packaging,
      physical_units_per_offer: normalized.physical_units_per_offer,
      minimum_order_quantity: normalized.minimum_order_quantity,
      minimum_order_quantity_physical_units: normalized.minimum_order_quantity != null
        ? normalized.minimum_order_quantity * (normalized.physical_units_per_offer || 0) : null,
      supplier_id: normalized.supplier_id,
      supplier_name: normalized.supplier_name,
      source_listing_id: normalized.source_listing_id,
      source_url: normalized.source_url,
      currency: normalized.currency,
      quoted_price_per_offer: normalized.quoted_price_per_offer,
      quoted_price_per_physical: normalized.quoted_price_per_physical_unit,
      price_basis: normalized.price_basis,
      product_cost_krw_per_physical: cost.product_cost.amount_krw_per_physical,
      product_cost_missing: cost.product_cost.missing,
      product_cost_fx: cost.product_cost.fx,
      landed_cost_status: cost.landed_cost.status,
      landed_cost_krw_per_physical: cost.landed_cost.amount_krw_per_physical,
      landed_cost_components: cost.landed_cost.components,
      landed_cost_missing: cost.landed_cost.missing,
      availability_status: availability_status,
      lead_time_days: lead_time_days,
      // 7C-5: evidence type + quantity semantics (kept in evidence JSON · schema unchanged)
      evidence_type: sm.evidenceType || null,
      source_class: sm.sourceClass || null,
      available_quantity_min: sm.availableQuantityMin ?? null,
      available_quantity_max: sm.availableQuantityMax ?? null,
      available_quantity_exact: sm.availableQuantityExact ?? null,
      max_replenishable_quantity: sm.maxReplenishableQuantity ?? null,
      availability_confidence: sm.availabilityConfidence ?? null,
      units_per_carton: sm.unitsPerCarton ?? null,
      carton_count: sm.cartonCount ?? null,
      original_unit: sm.originalUnit ?? null,
      // 7C-5 hotfix provenance (Owner §5)
      evidence_origin: evidenceOrigin,
      supplier_confirmed_current: supplierConfirmedCurrent,
      reference_time_semantics: refTimeSemantics,
      fingerprint,
    },
    captured_by: actorId,
    notes: `phase_7c_ingest source=${normalized.source ?? 'unknown'}`,
  };
}

/**
 * Deterministic fingerprint over the tuple that Owner §9 said identifies
 * "same quote". Rows differing in ANY of these components create a NEW row.
 */
function _fingerprint(parts) {
  const canonical = JSON.stringify([
    parts.physicalProductId,
    String(parts.source || ''),
    String(parts.supplierId || ''),
    String(parts.supplierName || ''),
    String(parts.sourceListingId || ''),
    String(parts.currency || ''),
    parts.quotedPriceOffer != null ? Number(parts.quotedPriceOffer) : null,
    parts.physicalUnitsPerOffer != null ? Number(parts.physicalUnitsPerOffer) : null,
    String(parts.observedAt || ''),
    String(parts.evidenceType || ''),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function _findExistingFingerprint(db, physicalId, fingerprint) {
  const { data } = await db.from('physical_market_observations')
    .select('id, evidence, observed_at')
    .eq('physical_product_id', physicalId)
    .eq('observation_kind', 'replacement_price');
  const rows = data || [];
  return rows.find(r => r.evidence && r.evidence.fingerprint === fingerprint) || null;
}

module.exports = {
  ingestReplacementObservations,
  _internals: { _fingerprint },
};
