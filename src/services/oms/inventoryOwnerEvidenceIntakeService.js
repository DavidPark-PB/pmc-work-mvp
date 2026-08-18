/**
 * src/services/oms/inventoryOwnerEvidenceIntakeService.js — Phase 8G · thin adapter.
 *
 * Owner Evidence Intake bridges the Owner Action Workflow (Phase 8F) and the
 * canonical replacement-evidence persistence path (Phase 7C-4/5).
 *
 * ZERO PARALLEL BUSINESS LOGIC. Delegates to:
 *   · manualReplacementObservationValidator.validateManualObservation
 *   · replacementObservationIngestor.ingestReplacementObservations
 *   · inventoryDecisionEngine.assessInventoryDecision (for real BEFORE/AFTER)
 *   · inventoryOwnerDecisionService.buildOwnerDecision
 *   · inventoryOwnerActionWorkflowService.buildOwnerActionWorkflow
 *
 * Owner directive (Phase 8G):
 *   · This phase is NOT autonomous purchasing / hold / marketplace mutation
 *   · SUPPLIER_QUOTE does not become EXECUTABLE_QUOTE automatically
 *   · SECONDARY_MARKET_ASK does not become EXECUTABLE_QUOTE automatically
 *   · Historical typical / accounting cost never satisfies current quote
 *   · UNKNOWN stays UNKNOWN — never invent quantity / landed cost / supplier
 *   · Evidence readiness ≠ permission to purchase
 *   · Reassessment MUST reuse assessInventoryDecision — no parallel logic
 */
'use strict';

const { validateManualObservation } = require('./manualReplacementObservationValidator');
const { ingestReplacementObservations } = require('./replacementObservationIngestor');
const { EVIDENCE_TYPES, REQUIRES_CURRENT_QUOTE_CONFIRMATION, FORBIDS_CURRENT_QUOTE_CONFIRMATION } = require('./replacementEvidenceTypes');
const { buildOwnerDecision, ACTION } = require('./inventoryOwnerDecisionService');
const { buildOwnerActionWorkflow, WORKFLOW_STATUS } = require('./inventoryOwnerActionWorkflowService');
const { assessInventoryDecision } = require('./inventoryDecisionEngine');

const DEFAULT_PRICE_BASIS = 'per_physical_unit';
const DEFAULT_PHYSICAL_UNITS_PER_OFFER = 1;
const DEFAULT_CURRENCY = 'KRW';

// ─── Public: pure validator + Owner-facing normalizer ────

/**
 * Validate Owner-supplied evidence input and produce the canonical row shape
 * that the ingestor expects. NO writes. NO fabrication.
 *
 * @param {Object} input     see contract below
 * @param {Object} [opts]
 * @param {number} [opts.nowMs]
 * @returns {{ok, errors[], warnings[], normalized, action_gap_projection}}
 */
function validateOwnerSupplyEvidence(input, opts = {}) {
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['input required object'], warnings: [], normalized: null, action_gap_projection: null };
  }
  const errors = [];
  const warnings = [];

  const evidenceType = input.evidenceType || null;
  if (!evidenceType || !Object.values(EVIDENCE_TYPES).includes(evidenceType)) {
    errors.push(`evidenceType must be one of ${Object.values(EVIDENCE_TYPES).join('/')}`);
  }

  // Semantic guardrails BEFORE we delegate to the base validator.
  // Owner rule: no automatic promotion between evidence types.
  if (input.currentQuoteConfirmed && evidenceType && FORBIDS_CURRENT_QUOTE_CONFIRMATION.has(evidenceType)) {
    errors.push(`currentQuoteConfirmed forbidden for evidenceType=${evidenceType} (historical/reference only)`);
  }
  if (evidenceType && REQUIRES_CURRENT_QUOTE_CONFIRMATION.has(evidenceType) && !input.currentQuoteConfirmed) {
    warnings.push(`${evidenceType} requires currentQuoteConfirmed=true before persistence — pass --current-quote-confirmed at record time.`);
  }

  const currency = input.currency || DEFAULT_CURRENCY;
  const priceBasis = input.priceBasis || DEFAULT_PRICE_BASIS;
  const physicalUnitsPerOffer = Number.isInteger(input.physicalUnitsPerOffer) && input.physicalUnitsPerOffer > 0
    ? input.physicalUnitsPerOffer
    : DEFAULT_PHYSICAL_UNITS_PER_OFFER;

  const normalized = {
    physicalProductId: input.physicalId,
    source: input.source,
    supplierName: input.supplierName ?? null,
    supplierId: input.supplierId ?? null,
    sourceListingId: input.sourceListingId ?? null,
    currency,
    quotedPrice: input.price,
    priceBasis,
    physicalUnitsPerOffer,
    minimumOrderQuantity: input.minimumOrderQuantity ?? null,
    availabilityStatus: input.availabilityStatus ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    observedAt: input.observedAt,
    evidenceType,
    sourceClass: input.sourceClass ?? null,
    availableQuantityMin: input.availableQuantityMin ?? null,
    availableQuantityMax: input.availableQuantityMax ?? null,
    availableQuantityExact: input.availableQuantityExact ?? null,
    maxReplenishableQuantity: input.maxReplenishableQuantity ?? null,
    unitsPerCarton: input.unitsPerCarton ?? null,
    cartonCount: input.cartonCount ?? null,
  };

  // Delegate to canonical validator (future-timestamp check, enum checks, positive numeric checks).
  const base = validateManualObservation(normalized, opts);
  if (!base.ok) errors.push(...base.errors);

  // UNKNOWN preservation surface — never invent
  if (normalized.availableQuantityMin == null && normalized.availableQuantityMax == null && normalized.availableQuantityExact == null) {
    warnings.push('quantity UNKNOWN — no availability_range supplied. Owner is NOT required to fabricate one.');
  }
  if (input.landedCostKrw == null) {
    warnings.push('landed_cost UNKNOWN — Owner did not supply landed cost. Never invented downstream.');
  }
  if (evidenceType === EVIDENCE_TYPES.SECONDARY_MARKET_ASK && normalized.supplierName == null) {
    warnings.push('SECONDARY_MARKET_ASK — supplierName intentionally optional (marketplace = source identity).');
  }

  const action_gap_projection = _projectActionGapClosure({ evidenceType, currentQuoteConfirmed: input.currentQuoteConfirmed === true });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized: errors.length === 0 ? normalized : null,
    action_gap_projection,
  };
}

/**
 * Owner-facing semantic classification.
 * Which Phase 8F workflow actions COULD this evidence potentially close?
 * NEVER a promise — the ingestor + decision engine make the final call.
 */
function _projectActionGapClosure({ evidenceType, currentQuoteConfirmed }) {
  const p = {
    would_close_CHECK_PRIMARY_SUPPLIER: false,
    would_close_CONFIRM_EXECUTABLE_QUOTE: false,
    would_close_CHECK_SECONDARY_MARKET: false,
    conditional_on_current_quote_confirmed: false,
    forbidden_promotion: [],
    reason_codes: [],
  };
  switch (evidenceType) {
    case EVIDENCE_TYPES.EXECUTABLE_QUOTE:
      p.would_close_CHECK_PRIMARY_SUPPLIER = !!currentQuoteConfirmed;
      p.would_close_CONFIRM_EXECUTABLE_QUOTE = !!currentQuoteConfirmed;
      p.conditional_on_current_quote_confirmed = !currentQuoteConfirmed;
      p.reason_codes.push('executable_quote_closes_both_when_current_quote_confirmed');
      break;
    case EVIDENCE_TYPES.SUPPLIER_QUOTE:
      p.would_close_CHECK_PRIMARY_SUPPLIER = !!currentQuoteConfirmed;
      p.would_close_CONFIRM_EXECUTABLE_QUOTE = false;    // Owner rule (F2): never
      p.conditional_on_current_quote_confirmed = !currentQuoteConfirmed;
      p.forbidden_promotion.push('SUPPLIER_QUOTE_MUST_NOT_MASQUERADE_AS_EXECUTABLE_QUOTE');
      p.reason_codes.push('supplier_quote_closes_check_primary_supplier_only');
      break;
    case EVIDENCE_TYPES.SECONDARY_MARKET_ASK:
      p.would_close_CHECK_PRIMARY_SUPPLIER = false;
      p.would_close_CONFIRM_EXECUTABLE_QUOTE = false;
      p.would_close_CHECK_SECONDARY_MARKET = true;    // may transition CHECK_SECONDARY_MARKET → EVIDENCE_PARTIAL
      p.forbidden_promotion.push('SECONDARY_MARKET_ASK_MUST_NOT_MASQUERADE_AS_EXECUTABLE_QUOTE');
      p.forbidden_promotion.push('SECONDARY_MARKET_ASK_IS_NOT_A_SUPPLIER_QUOTE');
      p.reason_codes.push('secondary_market_ask_never_satisfies_current_supplier_or_executable');
      break;
    case EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE:
      p.forbidden_promotion.push('TYPICAL_SUPPLIER_REFERENCE_IS_HISTORICAL_NEVER_CURRENT');
      p.reason_codes.push('typical_reference_never_satisfies_current_supplier_or_executable');
      break;
    case EVIDENCE_TYPES.ACTUAL_PURCHASE:
      p.forbidden_promotion.push('ACTUAL_PURCHASE_IS_HISTORICAL_NEVER_CURRENT');
      p.reason_codes.push('actual_purchase_records_past_transaction_only');
      break;
    default:
      p.reason_codes.push('unknown_evidence_type');
  }
  return p;
}

// ─── Preview + Record ────────────────────────────────────

/**
 * PREVIEW · returns the ingestor dry-run plan augmented with Owner-facing
 * classification. Never writes.
 *
 * @param {Object} input
 * @param {Object} [opts]
 * @param {Function} [opts.ingestFn]  injectable · defaults to ingestReplacementObservations
 * @param {Function} [opts.physicalFetcher]  injectable · fetches physical row
 * @param {number} [opts.nowMs]
 */
async function previewOwnerEvidence(input, opts = {}) {
  const validation = validateOwnerSupplyEvidence(input, opts);
  if (!validation.ok) {
    return {
      mode: 'preview',
      validation,
      plan: null,
      note: 'REJECTED at validation. No downstream call made.',
    };
  }
  const physical = await _loadPhysical(input.physicalId, opts);
  if (!physical) {
    return {
      mode: 'preview',
      validation,
      plan: null,
      error: 'physical_not_found',
      note: `physical#${input.physicalId} not found. No downstream call made.`,
    };
  }
  const _ingest = opts.ingestFn || ingestReplacementObservations;
  const plan = await _runIngestor(_ingest, physical, validation.normalized, { confirm: false, currentQuoteConfirmed: input.currentQuoteConfirmed === true, identityConfirmed: input.identityConfirmed === true });
  return {
    mode: 'preview',
    validation,
    physical: { id: physical.id, canonical_title: physical.canonical_title, set_code: physical.set_code, language: physical.language, unit_type: physical.unit_type },
    plan,
    would_execute: {
      purchase: false,
      strategic_hold: false,
      marketplace_price_change: false,
      inventory_adjustment: false,
      notification: false,
    },
    persistence: 'NOT_WRITTEN_PREVIEW_ONLY',
  };
}

/**
 * RECORD · explicit gate. Delegates to the canonical ingestor with
 * `confirm=true`. Requires `identityConfirmed=true` and, for SUPPLIER_QUOTE
 * / EXECUTABLE_QUOTE, `currentQuoteConfirmed=true`. Never mutates anything
 * outside physical_market_observations via the ingestor.
 *
 * @param {Object} input
 * @param {Object} opts
 * @param {boolean} opts.identityConfirmed   MUST be true
 * @param {boolean} opts.currentQuoteConfirmed  required for SUPPLIER_QUOTE / EXECUTABLE_QUOTE
 * @param {Function} [opts.ingestFn]         injectable · defaults to real ingestor
 * @param {Function} [opts.physicalFetcher]  injectable
 * @param {number} [opts.nowMs]
 * @param {number} [opts.actorId=null]
 */
async function recordOwnerEvidence(input, opts = {}) {
  const identityConfirmed = opts.identityConfirmed === true;
  const currentQuoteConfirmed = opts.currentQuoteConfirmed === true;
  const validation = validateOwnerSupplyEvidence(
    { ...input, currentQuoteConfirmed },
    { nowMs: opts.nowMs }
  );
  const gateErrors = [];
  if (!identityConfirmed) gateErrors.push('identityConfirmed MUST be true to record evidence');
  const et = input.evidenceType;
  if (REQUIRES_CURRENT_QUOTE_CONFIRMATION.has(et) && !currentQuoteConfirmed) {
    gateErrors.push(`${et} requires currentQuoteConfirmed=true to record`);
  }
  if (!validation.ok || gateErrors.length > 0) {
    return {
      mode: 'record',
      validation,
      gate_errors: gateErrors,
      plan: null,
      persistence: 'NOT_WRITTEN_GATE_REJECTED',
    };
  }
  const physical = await _loadPhysical(input.physicalId, opts);
  if (!physical) {
    return { mode: 'record', validation, gate_errors, plan: null, error: 'physical_not_found', persistence: 'NOT_WRITTEN_PHYSICAL_NOT_FOUND' };
  }
  const _ingest = opts.ingestFn || ingestReplacementObservations;
  const plan = await _runIngestor(_ingest, physical, validation.normalized, {
    confirm: true, currentQuoteConfirmed, identityConfirmed,
    actorId: opts.actorId ?? null,
  });
  return {
    mode: 'record',
    validation,
    gate_errors: [],
    physical: { id: physical.id, canonical_title: physical.canonical_title, set_code: physical.set_code, language: physical.language, unit_type: physical.unit_type },
    plan,
    persistence: plan?.status || 'unknown',
    idempotency_note: 'Duplicate protection: SHA-256 fingerprint stored in evidence.fingerprint · app-level scan. No DB UNIQUE. Concurrent identical writes MAY race — human-driven CLI is low risk.',
    would_execute: {
      purchase: false,
      strategic_hold: false,
      marketplace_price_change: false,
      inventory_adjustment: false,
      notification: false,
    },
  };
}

/**
 * Adapter around ingestReplacementObservations so we can drop it in tests.
 * Preserves the ingestor's full input contract.
 */
async function _runIngestor(ingestFn, physical, normalized, ingestOpts) {
  return ingestFn({
    physical,
    rawOffers: [ _toRawOffer(normalized) ],
    confirm: ingestOpts.confirm,
    identityConfirmed: ingestOpts.identityConfirmed,
    currentQuoteConfirmed: ingestOpts.currentQuoteConfirmed,
    actorId: ingestOpts.actorId ?? null,
    availabilityByOffer: normalized.availabilityStatus ? [normalized.availabilityStatus] : null,
    leadTimeByOffer: Number.isFinite(normalized.leadTimeDays) ? [normalized.leadTimeDays] : null,
    supplyMetaByOffer: [{
      evidenceType: normalized.evidenceType,
      sourceClass: normalized.sourceClass,
      availableQuantityMin: normalized.availableQuantityMin,
      availableQuantityMax: normalized.availableQuantityMax,
      availableQuantityExact: normalized.availableQuantityExact,
      maxReplenishableQuantity: normalized.maxReplenishableQuantity,
      unitsPerCarton: normalized.unitsPerCarton,
      cartonCount: normalized.cartonCount,
    }],
  });
}

function _toRawOffer(n) {
  return {
    source: n.source,
    supplier_id: n.supplierId,
    supplier_name: n.supplierName,
    source_listing_id: n.sourceListingId || `owner_evidence::${n.supplierName || n.source}::${n.observedAt}`,
    currency: n.currency,
    quoted_price: n.quotedPrice,
    price_basis: n.priceBasis,
    physical_units_per_offer: n.physicalUnitsPerOffer,
    minimum_order_quantity: n.minimumOrderQuantity,
    observed_at: n.observedAt,
    title: null,   // ingestor / matcher can operate without a title when supplier + identity are strong
  };
}

async function _loadPhysical(physicalId, opts) {
  if (typeof opts.physicalFetcher === 'function') return opts.physicalFetcher(physicalId);
  // Late require so tests never touch the DB unless they explicitly override.
  const { getClient } = require('../../db/supabaseClient');
  const { data } = await getClient()
    .from('physical_products')
    .select('id, canonical_title, set_code, language, region, unit_type, status')
    .eq('id', physicalId).maybeSingle();
  return data || null;
}

// ─── Reassessment preview ────────────────────────────────

/**
 * Answer "what would happen if this validated evidence became canonical?"
 *
 * Owner directive Part 6:
 *   - MUST reuse assessInventoryDecision — no parallel decision logic
 *   - If the engine cannot consume hypothetical evidence WITHOUT persistence,
 *     return REASSESSMENT_PREVIEW_UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE
 *     (never fabricate)
 *
 * TWO modes:
 *   (a) `mode='preview'` (default): captures the BEFORE decision and reports
 *       that the AFTER is unavailable without persistence.
 *   (b) `mode='around_record'`: caller has ALREADY recorded canonical
 *       evidence via `recordOwnerEvidence`. This function then captures the
 *       AFTER decision via the SAME assessInventoryDecision call. Meant to
 *       be invoked immediately after `recordOwnerEvidence`. Tests inject
 *       `assessFn` so DB is never touched.
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {Object} args.beforeSnapshot       ownerDecision + workflow captured BEFORE any change
 * @param {string} [args.mode='preview']     'preview' | 'around_record'
 * @param {Function} [args.assessFn]         injectable · defaults to assessInventoryDecision
 */
async function previewOwnerEvidenceReassessment({ physicalProductId, beforeSnapshot, mode = 'preview', assessFn = null } = {}) {
  if (!beforeSnapshot || typeof beforeSnapshot !== 'object') {
    throw new Error('beforeSnapshot required (Phase 8E/8F output captured BEFORE change)');
  }
  if (mode === 'preview') {
    return {
      mode,
      before: _summariseForCompare(beforeSnapshot),
      after: null,
      changed: null,
      unchanged: null,
      status: 'REASSESSMENT_PREVIEW_UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE',
      note: 'assessInventoryDecision consumes persisted physical_market_observations. Without record, no honest AFTER can be produced. Use --record-evidence (which delegates to the canonical ingestor) if you intend to see the real BEFORE/AFTER, or accept preview-only.',
    };
  }
  if (mode === 'around_record') {
    const _assess = assessFn || (id => assessInventoryDecision({ physicalProductId: id }));
    const afterDecisionResult = await _assess(physicalProductId);
    // Reuse Phase 8E projection over the AFTER decision — no parallel logic.
    const afterOwner = await buildOwnerDecision({
      physicalProductId,
      assessFn: async () => afterDecisionResult,
    });
    const afterWorkflow = buildOwnerActionWorkflow(afterOwner);
    const afterSummary = _summariseForCompare({ owner_decision: afterOwner, workflow: afterWorkflow });
    const beforeSummary = _summariseForCompare(beforeSnapshot);
    const changed = _diffSummaries(beforeSummary, afterSummary);
    const unchanged = _sameSummaries(beforeSummary, afterSummary);
    return {
      mode,
      before: beforeSummary,
      after: afterSummary,
      changed,
      unchanged,
      status: 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS',
      note: 'AFTER decision comes from assessInventoryDecision reading persisted evidence. No parallel logic.',
    };
  }
  throw new Error(`unknown mode: ${mode}`);
}

function _summariseForCompare(snap) {
  const owner = snap.owner_decision || snap.ownerDecision || snap;
  const wf = snap.workflow || null;
  return {
    decision_status: owner.headline?.decision_status ?? null,
    priority_score: owner.headline?.priority_score ?? null,
    confidence_level: owner.headline?.confidence_level ?? null,
    supply_current_quality: owner.supply?.current_supply_quality ?? null,
    supply_has_current_supplier_or_executable: owner.supply?.has_current_supplier_or_executable ?? null,
    supply_replacement_difficulty: owner.supply?.replacement_difficulty ?? null,
    supply_evidenced_replacement_depth: owner.supply?.evidenced_replacement_depth ?? null,
    supply_depth_gap: owner.supply?.depth_gap ?? null,
    inventory_available: owner.inventory?.available ?? null,
    owner_action_codes: wf ? wf.workflow_actions.map(a => a.action_code) : (owner.recommended_actions || []).map(a => a.code),
    owner_action_statuses: wf ? wf.workflow_actions.map(a => ({ code: a.action_code, status: a.status })) : null,
  };
}

function _diffSummaries(a, b) {
  const out = {};
  for (const k of Object.keys(a)) {
    const av = a[k]; const bv = b[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) out[k] = { before: av, after: bv };
  }
  return out;
}

function _sameSummaries(a, b) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

module.exports = {
  validateOwnerSupplyEvidence,
  previewOwnerEvidence,
  recordOwnerEvidence,
  previewOwnerEvidenceReassessment,
  _internals: { _projectActionGapClosure, _toRawOffer, _summariseForCompare, _diffSummaries },
};
