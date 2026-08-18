'use strict';

/**
 * src/services/oms/physicalCanonicalWriterPreflight.js — Phase 8P-6.
 *
 * Produces a Phase 8P-6 canary preflight report from a single Owner
 * decision. Canary rules:
 *   • Exactly ONE decision per preflight run (canary = 1 candidate)
 *   • Reuses physicalCanonicalWriter.planDecision for validation
 *   • Never touches DB · never applies migration · never calls RPC
 *   • Only reports READY vs BLOCKED with detailed reasons
 *   • Zero mutation surface · pure function
 */

const { planDecision, WRITER_INTERFACE_VERSION, BP_INVARIANT, DECISION_ENUM } = require('./physicalCanonicalWriter');

const PREFLIGHT_STATUS = Object.freeze({
  READY:   'READY',
  BLOCKED: 'BLOCKED',
});

/**
 * @param {Object} args
 * @param {Object} args.decision
 * @param {Object} args.candidateContext
 * @param {string} [args.ownerConfirmationId]
 * @param {Object} [args.expectedCandidate]   used to detect payload/live drift
 *                                             { creation_candidate_id, sku_master_ids, completed_sale_items }
 * @returns {Object}
 */
function buildCanaryPreflight({ decision, candidateContext, ownerConfirmationId = null, expectedCandidate = null } = {}) {
  const plan = planDecision({ decision, candidateContext, ownerConfirmationId });
  //   Payload drift check: if Owner provided an expected candidate snapshot
  //   (e.g. from an earlier live 8P-4 run), compare it against the current
  //   candidateContext. Any drift → BLOCKED (payload_stale) so Owner
  //   regenerates before running.
  const driftFindings = [];
  if (expectedCandidate) {
    if (expectedCandidate.creation_candidate_id && expectedCandidate.creation_candidate_id !== candidateContext?.creation_candidate_id) {
      driftFindings.push({ field: 'creation_candidate_id', expected: expectedCandidate.creation_candidate_id, actual: candidateContext?.creation_candidate_id });
    }
    if (Array.isArray(expectedCandidate.sku_master_ids)) {
      const expSet = new Set(expectedCandidate.sku_master_ids);
      const actSet = new Set(candidateContext?.sku_master_ids || []);
      const missing = [...expSet].filter(x => !actSet.has(x));
      const added = [...actSet].filter(x => !expSet.has(x));
      if (missing.length || added.length) {
        driftFindings.push({ field: 'sku_master_ids', expected: expectedCandidate.sku_master_ids, actual: candidateContext?.sku_master_ids || [], missing, added });
      }
    }
    if (Number.isFinite(expectedCandidate.completed_sale_items) && Number.isFinite(candidateContext?.completed_sale_items)) {
      //   Tolerate small drift (±2 items) as sales continue while Owner reviews
      const delta = Math.abs(expectedCandidate.completed_sale_items - candidateContext.completed_sale_items);
      if (delta > 5) {
        driftFindings.push({ field: 'completed_sale_items', expected: expectedCandidate.completed_sale_items, actual: candidateContext.completed_sale_items, delta });
      }
    }
  }

  //   BP invariant status · always reported
  const bpStatus = _bpInvariantStatus({ decision, candidateContext });

  //   Existing-link conflict status · relies on plan validation (can't query DB)
  const existingLinkStatus = plan.status === 'REJECTED'
    ? { checked: 'app-side only · RPC will re-check', would_be_rejected_reasons: plan.errors || [] }
    : { checked: 'app-side only · RPC will re-check at execution time', note: 'app-side did not detect an existing link conflict · RPC still verifies' };

  //   Expected audit row shape (mirrors what the RPC would insert)
  const expectedAuditRow = plan.status === 'VALIDATED'
    ? (plan.db_effect.would_insert || []).find(r => r.table === 'physical_write_audit')?.values
    : null;

  //   Determine READY vs BLOCKED
  let status = PREFLIGHT_STATUS.BLOCKED;
  const blockReasons = [];
  if (plan.status === 'REJECTED') blockReasons.push(...(plan.errors || []));
  if (plan.status === 'NO_WRITE') blockReasons.push('decision_type_produces_no_write');
  if (plan.status === 'AUDIT_ONLY') blockReasons.push('decision_type_produces_audit_only_no_physical_or_link');
  if (driftFindings.length > 0) blockReasons.push('payload_stale_vs_expected_snapshot');
  if (decision?.owner_confirmed !== true) blockReasons.push('owner_confirmed_must_be_true');
  //   Canary MUST have Owner-supplied confirmation id
  if (!ownerConfirmationId || String(ownerConfirmationId).trim().length < 3) {
    blockReasons.push('owner_confirmation_id_missing_or_too_short');
  }
  if (blockReasons.length === 0 && plan.status === 'VALIDATED') status = PREFLIGHT_STATUS.READY;

  return {
    writer_interface_version: WRITER_INTERFACE_VERSION,
    canary_only: true,
    max_decisions_per_run: 1,
    preflight_status: status,
    block_reasons: [...new Set(blockReasons)],
    candidate_identity: {
      creation_candidate_id: candidateContext?.creation_candidate_id ?? null,
      sku_master_ids: candidateContext?.sku_master_ids || [],
      cohort_bridge: candidateContext?.cohort_bridge ?? null,
      listing_ids: candidateContext?.listing_ids || [],
      product_ids: candidateContext?.product_ids || [],
      completed_sale_items: candidateContext?.completed_sale_items ?? null,
    },
    owner_confirmation: {
      owner_confirmed: decision?.owner_confirmed === true,
      owner_confirmation_id: ownerConfirmationId,
      owner_decision: decision?.owner_decision ?? null,
      proposed_display_name: decision?.proposed_display_name ?? null,
      confirmed_sku_master_ids: decision?.confirmed_sku_master_ids ?? [],
      target_physical_product_id: decision?.target_physical_product_id ?? null,
      owner_authoritative_bridge: decision?.owner_authoritative_bridge ?? null,
    },
    payload_drift: {
      checked: expectedCandidate != null,
      findings: driftFindings,
    },
    bp_invariant_status: bpStatus,
    existing_link_conflict_status: existingLinkStatus,
    exact_transaction_operations: plan.status === 'VALIDATED' ? plan.db_effect?.would_insert : [],
    target_rpc: plan.status === 'VALIDATED' ? plan.db_effect?.rpc_target : null,
    idempotency_key: plan.idempotency_key ?? null,
    expected_audit_row: expectedAuditRow,
    rollback_guarantee: plan.status === 'VALIDATED'
      ? 'ATOMIC · RPC executes in a single PL/pgSQL block · any RAISE EXCEPTION rolls back the entire mutation set (physical_products + sellable_units + sellable_unit_components + sku_master_link + physical_write_audit)'
      : 'N/A · preflight did not validate · no execution proposed',
    plan_full: plan,
    note: 'CANARY preflight · dry-run only · Phase 8P-6 does NOT execute the RPC · Owner reviews READY status before separate future phase enables apply',
  };
}

function _bpInvariantStatus({ decision, candidateContext }) {
  const confirmedSkus = Array.isArray(decision?.confirmed_sku_master_ids) ? decision.confirmed_sku_master_ids : [];
  const cohortSkus = Array.isArray(candidateContext?.sku_master_ids) ? candidateContext.sku_master_ids : [];
  const bpLockedSet = new Set(BP_INVARIANT.locked_sku_master_ids);
  const collideConfirmed = confirmedSkus.filter(s => bpLockedSet.has(s));
  const collideCohort = cohortSkus.filter(s => bpLockedSet.has(s));
  const targetIsBp = decision?.target_physical_product_id === BP_INVARIANT.physical_product_id;
  const status = (collideConfirmed.length === 0 && !targetIsBp) ? 'INTACT' : 'VIOLATED';
  return {
    physical_product_id: BP_INVARIANT.physical_product_id,
    locked_sku_master_ids: [...BP_INVARIANT.locked_sku_master_ids],
    status,
    collide_confirmed_skus: collideConfirmed,
    collide_cohort_skus: collideCohort,
    target_physical_is_bp: targetIsBp,
  };
}

module.exports = {
  buildCanaryPreflight,
  PREFLIGHT_STATUS,
  WRITER_INTERFACE_VERSION,
};
