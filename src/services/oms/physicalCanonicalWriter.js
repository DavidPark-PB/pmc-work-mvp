'use strict';

/**
 * src/services/oms/physicalCanonicalWriter.js — Phase 8P-5.
 *
 * Canonical physical writer · validation + dry-run only in this phase.
 *
 * SCOPE (Owner Part 1):
 *   Writer NEVER judges. Writer accepts Owner-confirmed decisions and
 *   turns them into a validated transaction plan. NO title/franchise
 *   matching. NO recommendation logic. NO identity inference.
 *
 * SAFETY (Owner Parts 8, 10, 15):
 *   • This Phase ships DRY-RUN ONLY · zero DB write, zero RPC call
 *   • No `--apply` / `--commit` / `--execute` flag exists anywhere
 *   • Migration 095 defines the atomic RPC functions but is NOT applied
 *   • BP invariant (physical_product_id=1 · locked to [2194, 3120]) is
 *     rejected at BOTH app-side validate AND DB-side RPC (defense-in-depth)
 *   • Idempotency key = SHA-256 over deterministic payload
 *   • Append-only audit via physical_write_audit (from migration 095)
 *
 * OWNER CONFIRMATION CONTRACT (Owner Part 2):
 *   Every decision that requires DB mutation MUST arrive with
 *   `owner_confirmed === true`. Anything else is rejected at the
 *   validation layer. DEFER / NEEDS_MORE_EVIDENCE never produce writes.
 */

const crypto = require('crypto');
const { DECISION_ENUM, CANONICAL_WRITER_INTERFACE } = require('./physicalProductReviewQueue');

const WRITER_INTERFACE_VERSION = 'v8p5.rpc1';

// Owner-locked BP invariant (Owner Part 6). These are hard-coded in the
// writer to prevent title-similarity / accidental mapping mutation.
const BP_INVARIANT = Object.freeze({
  physical_product_id: 1,
  locked_sku_master_ids: Object.freeze([2194, 3120]),
});

const VALIDATION_REJECT_REASONS = Object.freeze({
  OWNER_CONFIRMED_FALSE:               'owner_confirmed_must_be_true',
  UNKNOWN_DECISION_TYPE:               'unknown_decision_type',
  DEFERRED_OR_NO_WRITE:                'decision_type_does_not_produce_a_write',
  MISSING_CANDIDATE_LINK:              'decision must reference source review candidate',
  MISSING_DISPLAY_NAME:                'proposed_display_name required for CREATE_NEW_PHYSICAL',
  MISSING_CONFIRMED_SKUS:              'confirmed_sku_master_ids required (non-empty array)',
  COHORT_SUBSET_MISMATCH:              'confirmed_sku_master_ids must be a subset of approved cohort',
  MISSING_TARGET_PHYSICAL:             'target_physical_product_id required for LINK_TO_EXISTING_PHYSICAL',
  MISSING_AUTHORITATIVE_BRIDGE:        'owner_authoritative_bridge required for LINK_TO_EXISTING_PHYSICAL',
  BP_LINK_FORBIDDEN:                   'physical_product_id=1 (BP) mapping is locked · this writer path is forbidden',
  BP_SKU_COLLISION:                    'sku_master_id belongs to BP invariant · cannot be reassigned by this writer',
  MARK_NON_PHYSICAL_NO_MUTATION:       'MARK_NON_PHYSICAL is recorded as audit only · no CREATE/LINK produced',
  INVALID_IDEMPOTENCY_INPUT:           'idempotency-critical fields missing',
  TITLE_ONLY_BRIDGE_REJECTED:          'title/franchise similarity is NOT an authoritative bridge',
});

/**
 * Build a dry-run plan for a single Owner decision.
 * NEVER touches DB. NEVER calls any RPC. Returns the validated plan
 * (or a REJECT) as a plain object the CLI/caller can serialize.
 *
 * @param {Object} args
 * @param {Object} args.decision        The Owner decision (built from decision_template)
 * @param {Object} args.candidateContext The Phase 8P-4 creation candidate
 *                                       (from `creation_review_plan.plan[i]`)
 *                                       providing cohort + evidence + candidate_id.
 * @param {string} [args.ownerConfirmationId]  Owner-supplied audit id
 * @returns {Object}
 */
function planDecision({ decision, candidateContext, ownerConfirmationId = null } = {}) {
  //   No DB · pure validate + assemble.
  const errors = [];
  if (!decision || typeof decision !== 'object') {
    return _reject({ decision, candidateContext, errors: [VALIDATION_REJECT_REASONS.UNKNOWN_DECISION_TYPE] });
  }
  const dtype = decision.owner_decision;
  if (!Object.values(DECISION_ENUM).includes(dtype)) {
    errors.push(VALIDATION_REJECT_REASONS.UNKNOWN_DECISION_TYPE);
  }
  //   Decisions that never produce a write are handled up-front.
  if (dtype === DECISION_ENUM.DEFER || dtype === DECISION_ENUM.NEEDS_MORE_EVIDENCE) {
    return {
      operation: dtype, status: 'NO_WRITE', db_effect: null,
      decision, candidate_context: candidateContext,
      note: VALIDATION_REJECT_REASONS.DEFERRED_OR_NO_WRITE,
      writer_interface_version: WRITER_INTERFACE_VERSION,
      dry_run: true,
    };
  }
  if (dtype === DECISION_ENUM.MARK_NON_PHYSICAL) {
    //   Audit-only note. No mutation to physical_products / sku_master_link.
    return {
      operation: dtype, status: 'AUDIT_ONLY', db_effect: null,
      decision, candidate_context: candidateContext,
      note: VALIDATION_REJECT_REASONS.MARK_NON_PHYSICAL_NO_MUTATION,
      writer_interface_version: WRITER_INTERFACE_VERSION,
      dry_run: true,
    };
  }
  //   From here CREATE / LINK · both require Owner confirmation.
  if (decision.owner_confirmed !== true) errors.push(VALIDATION_REJECT_REASONS.OWNER_CONFIRMED_FALSE);
  if (!candidateContext || !candidateContext.creation_candidate_id) errors.push(VALIDATION_REJECT_REASONS.MISSING_CANDIDATE_LINK);

  const confirmedSkus = Array.isArray(decision.confirmed_sku_master_ids)
    ? decision.confirmed_sku_master_ids.filter(x => Number.isInteger(x) && x > 0)
    : [];
  if (confirmedSkus.length === 0) errors.push(VALIDATION_REJECT_REASONS.MISSING_CONFIRMED_SKUS);

  //   Cohort subset validation (Owner Part 4). candidateContext.sku_master_ids
  //   is the approved cohort from Phase 8P-4. confirmed_sku_master_ids must
  //   be a NON-EMPTY SUBSET · never any SKU outside the cohort.
  const cohort = new Set((candidateContext?.sku_master_ids) || []);
  const outsideCohort = confirmedSkus.filter(s => !cohort.has(s));
  if (outsideCohort.length > 0) errors.push(VALIDATION_REJECT_REASONS.COHORT_SUBSET_MISMATCH);

  //   BP invariant · reject any operation that would touch BP's locked SKUs
  //   or link to physical_product_id=1.
  const collidingBpSkus = confirmedSkus.filter(s => BP_INVARIANT.locked_sku_master_ids.includes(s));
  if (collidingBpSkus.length > 0) errors.push(VALIDATION_REJECT_REASONS.BP_SKU_COLLISION);

  if (dtype === DECISION_ENUM.CREATE_NEW_PHYSICAL) {
    if (typeof decision.proposed_display_name !== 'string' || !decision.proposed_display_name.trim()) {
      errors.push(VALIDATION_REJECT_REASONS.MISSING_DISPLAY_NAME);
    }
  }
  if (dtype === DECISION_ENUM.LINK_TO_EXISTING_PHYSICAL) {
    if (!Number.isInteger(decision.target_physical_product_id) || decision.target_physical_product_id <= 0) {
      errors.push(VALIDATION_REJECT_REASONS.MISSING_TARGET_PHYSICAL);
    }
    if (decision.target_physical_product_id === BP_INVARIANT.physical_product_id) {
      errors.push(VALIDATION_REJECT_REASONS.BP_LINK_FORBIDDEN);
    }
    const bridge = typeof decision.owner_authoritative_bridge === 'string' ? decision.owner_authoritative_bridge.trim() : '';
    if (bridge.length < 3) errors.push(VALIDATION_REJECT_REASONS.MISSING_AUTHORITATIVE_BRIDGE);
    if (bridge && _looksLikeTitleOnlyBridge(bridge)) errors.push(VALIDATION_REJECT_REASONS.TITLE_ONLY_BRIDGE_REJECTED);
  }

  if (errors.length > 0) {
    return _reject({ decision, candidateContext, errors });
  }

  //   Assemble deterministic idempotency key.
  const idempotency_key = _idempotencyKey({
    operation: dtype,
    candidate_id: candidateContext.creation_candidate_id,
    sku_master_ids: confirmedSkus.slice().sort((a, b) => a - b),
    target_physical_product_id: dtype === DECISION_ENUM.LINK_TO_EXISTING_PHYSICAL ? decision.target_physical_product_id : null,
    display_name: dtype === DECISION_ENUM.CREATE_NEW_PHYSICAL ? String(decision.proposed_display_name).trim() : null,
    writer_interface_version: WRITER_INTERFACE_VERSION,
    owner_confirmation_id: ownerConfirmationId,
  });

  //   Build the transaction plan · exactly what the RPC would do.
  const db_effect = dtype === DECISION_ENUM.CREATE_NEW_PHYSICAL
    ? _planCreatePhysical({ decision, candidateContext, confirmedSkus, idempotency_key, ownerConfirmationId })
    : _planLinkPhysical({ decision, candidateContext, confirmedSkus, idempotency_key, ownerConfirmationId });

  return {
    operation: dtype,
    status: 'VALIDATED',
    db_effect,
    decision, candidate_context: candidateContext,
    idempotency_key,
    owner_confirmation_id: ownerConfirmationId,
    writer_interface_version: WRITER_INTERFACE_VERSION,
    bp_invariant_check: 'PASSED · no BP SKU touched · no LINK to physical#1',
    dry_run: true,
    note: 'Dry-run plan only · Phase 8P-5 ships NO --apply / --commit / --execute path · Owner must trigger separate apply phase',
  };
}

/**
 * Plan a whole review batch. Never mutates. Returns per-item plans + a
 * summary telling Owner how many would validate, how many are rejected,
 * and how many are audit-only.
 *
 * @param {Object} args
 * @param {Array}  args.decisions            [{decision, candidateContext, ownerConfirmationId?}, ...]
 * @returns {Object}
 */
function planBatch({ decisions = [] } = {}) {
  const items = decisions.map(d => planDecision(d));
  const summary = {
    total: items.length,
    validated: items.filter(i => i.status === 'VALIDATED').length,
    rejected: items.filter(i => i.status === 'REJECTED').length,
    audit_only: items.filter(i => i.status === 'AUDIT_ONLY').length,
    no_write: items.filter(i => i.status === 'NO_WRITE').length,
  };
  const idempotency_keys = items.filter(i => i.idempotency_key).map(i => i.idempotency_key);
  const duplicate_keys = idempotency_keys.filter((k, i, arr) => arr.indexOf(k) !== i);
  return {
    writer_interface_version: WRITER_INTERFACE_VERSION,
    summary,
    duplicate_idempotency_keys_in_batch: duplicate_keys,
    plans: items,
    dry_run: true,
    note: 'planBatch NEVER writes · duplicate idempotency keys within one batch are surfaced but not deduplicated · Owner reviews before triggering apply phase',
  };
}

// ─── helpers ─────────────────────────────────

function _idempotencyKey(input) {
  const canonical = _deterministicStringify(input);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function _deterministicStringify(v) {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_deterministicStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _deterministicStringify(v[k])).join(',') + '}';
}

function _reject({ decision, candidateContext, errors }) {
  return {
    operation: decision?.owner_decision ?? null,
    status: 'REJECTED',
    db_effect: null,
    decision, candidate_context: candidateContext,
    errors: [...new Set(errors)],
    writer_interface_version: WRITER_INTERFACE_VERSION,
    dry_run: true,
    note: 'Rejected during validation · zero DB effect · fix decision payload and re-plan',
  };
}

function _looksLikeTitleOnlyBridge(bridge) {
  //   Reject bridges that are just prose · Owner must supply a
  //   deterministic identifier (listing:X, product:Y, sku:Z, ID:...).
  //   Detects the ABSENCE of any of the accepted prefixes.
  const t = String(bridge).trim().toLowerCase();
  const acceptedPrefix = /^(listing:|product:|sku:|ebay_listing:|shopify_product:|marketplace_sku:|internal_sku:|owner_note:)/;
  return !acceptedPrefix.test(t);
}

function _planCreatePhysical({ decision, candidateContext, confirmedSkus, idempotency_key, ownerConfirmationId }) {
  return {
    rpc_target: 'apply_canonical_create_physical(jsonb)',
    rpc_migration_file: '095_physical_write_audit_and_rpc.sql',
    applied_this_phase: false,
    would_insert: [
      { table: 'physical_products', values: { canonical_title: decision.proposed_display_name.trim() } },
      { table: 'sellable_units', values: { display_name: `${decision.proposed_display_name.trim()} (auto-created 1-unit sellable)`, variant_kind: 'base', status: 'active' } },
      { table: 'sellable_unit_components', values: { sellable_unit_id: '<new>', physical_product_id: '<new>', quantity_per_unit: 1, role: 'primary' } },
      ...confirmedSkus.map(sku => ({
        table: 'sku_master_link',
        values: { sku_master_id: sku, sellable_unit_id: '<new>', mapping_confidence: 'manual', notes: `phase_8p5_owner_confirmed_create · ${candidateContext.creation_candidate_id}` },
      })),
      { table: 'physical_write_audit', values: { operation: 'CREATE_NEW_PHYSICAL', idempotency_key, sku_master_ids: confirmedSkus, source_review_candidate_id: candidateContext.creation_candidate_id, owner_confirmation_id: ownerConfirmationId } },
    ],
    would_atomic: true,
    would_be_rolled_back_on_error: true,
    payload_for_rpc: {
      writer_interface_version: WRITER_INTERFACE_VERSION,
      idempotency_key,
      owner_confirmed: true,
      owner_confirmation_id: ownerConfirmationId,
      proposed_display_name: decision.proposed_display_name.trim(),
      confirmed_sku_master_ids: confirmedSkus,
      source_review_candidate_id: candidateContext.creation_candidate_id,
      source_review_generated_at: candidateContext.source_review_generated_at ?? null,
      evidence_reference: {
        cohort_bridge: candidateContext.cohort_bridge,
        listing_ids: candidateContext.listing_ids,
        product_ids: candidateContext.product_ids,
      },
      owner_note: decision.note || null,
    },
  };
}

function _planLinkPhysical({ decision, candidateContext, confirmedSkus, idempotency_key, ownerConfirmationId }) {
  return {
    rpc_target: 'apply_canonical_link_physical(jsonb)',
    rpc_migration_file: '095_physical_write_audit_and_rpc.sql',
    applied_this_phase: false,
    would_insert: [
      ...confirmedSkus.map(sku => ({
        table: 'sku_master_link',
        values: { sku_master_id: sku, sellable_unit_id: `<resolved qty=1 SU for physical#${decision.target_physical_product_id}>`, mapping_confidence: 'manual', notes: `phase_8p5_owner_confirmed_link · bridge=${String(decision.owner_authoritative_bridge).slice(0, 100)}` },
      })),
      { table: 'physical_write_audit', values: { operation: 'LINK_TO_EXISTING_PHYSICAL', idempotency_key, physical_product_id: decision.target_physical_product_id, sku_master_ids: confirmedSkus, owner_confirmation_id: ownerConfirmationId } },
    ],
    would_atomic: true,
    would_be_rolled_back_on_error: true,
    payload_for_rpc: {
      writer_interface_version: WRITER_INTERFACE_VERSION,
      idempotency_key,
      owner_confirmed: true,
      owner_confirmation_id: ownerConfirmationId,
      target_physical_product_id: decision.target_physical_product_id,
      confirmed_sku_master_ids: confirmedSkus,
      owner_authoritative_bridge: decision.owner_authoritative_bridge,
      source_review_candidate_id: candidateContext.creation_candidate_id,
      owner_note: decision.note || null,
    },
  };
}

module.exports = {
  planDecision,
  planBatch,
  WRITER_INTERFACE_VERSION,
  BP_INVARIANT,
  VALIDATION_REJECT_REASONS,
  CANONICAL_WRITER_INTERFACE,
  DECISION_ENUM,
};
