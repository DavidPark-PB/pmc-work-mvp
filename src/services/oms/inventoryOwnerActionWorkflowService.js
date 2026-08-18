/**
 * src/services/oms/inventoryOwnerActionWorkflowService.js — Phase 8F · READ-ONLY.
 *
 * Turns Phase 8E `buildOwnerDecision` output into an Owner Action Workflow —
 * a per-action projection that answers:
 *   1) what exactly does Owner need to do?
 *   2) what evidence would close that action?
 *   3) has that evidence already arrived?
 *   4) which decision should be re-evaluated after evidence arrives?
 *
 * PURE PROJECTION. Never mutates anything. Never issues purchases / holds /
 * marketplace calls. Uses ONLY:
 *   · ownerDecision (from Phase 8E buildOwnerDecision)
 *   · replacementEvidenceTypes (evidence enum, trust rank, freshness policy)
 *
 * No parallel supplier/replacement truth model — evidence-presence is inferred
 * from the strategic-hold source snapshot already produced by Phase 8A.
 *
 * Owner directive (Phase 8F):
 *   · This phase is NOT autonomous purchasing / hold / marketplace mutation
 *   · Evidence arrival MUST NOT execute any operational change
 *   · Historical typical supplier cost MUST NOT satisfy CURRENT supplier quote
 *   · SECONDARY_MARKET_ASK MUST NOT satisfy CONFIRM_EXECUTABLE_QUOTE
 *   · UNKNOWN stays UNKNOWN
 */
'use strict';

const { EVIDENCE_TYPES } = require('./replacementEvidenceTypes');
const { ACTION, FORBIDDEN_AUTOMATIC_ACTIONS } = require('./inventoryOwnerDecisionService');

// Workflow status enum (Owner §Part 1)
const WORKFLOW_STATUS = Object.freeze({
  OPEN: 'OPEN',
  EVIDENCE_PARTIAL: 'EVIDENCE_PARTIAL',
  EVIDENCE_READY: 'EVIDENCE_READY',
  OWNER_REVIEW_REQUIRED: 'OWNER_REVIEW_REQUIRED',
  CLOSED_NO_ACTION: 'CLOSED_NO_ACTION',
});

// Explicit note used across CLI and audit views. Owner rule: NEVER interpret
// TYPICAL_SUPPLIER_REFERENCE as CURRENT quote. NEVER interpret
// SECONDARY_MARKET_ASK as EXECUTABLE_QUOTE. NEVER treat historical accounting
// cost as either.
const EVIDENCE_NOT_ACCEPTED_AS_CLOSURE = Object.freeze({
  CONFIRM_EXECUTABLE_QUOTE: [
    EVIDENCE_TYPES.SECONDARY_MARKET_ASK,
    EVIDENCE_TYPES.SUPPLIER_QUOTE,      // still requires seller-confirmed executability
    EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
    EVIDENCE_TYPES.ACTUAL_PURCHASE,
    'historical_accounting_cost',
  ],
  CHECK_PRIMARY_SUPPLIER: [
    EVIDENCE_TYPES.SECONDARY_MARKET_ASK,
    EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
    EVIDENCE_TYPES.ACTUAL_PURCHASE,
    'historical_accounting_cost',
  ],
});

/**
 * @param {Object} ownerDecision  Phase 8E buildOwnerDecision result
 */
function buildOwnerActionWorkflow(ownerDecision) {
  if (!ownerDecision || typeof ownerDecision !== 'object') {
    throw new Error('ownerDecision required');
  }
  const physicalId = ownerDecision.physical_product_id;
  const decisionStatus = ownerDecision.headline?.decision_status;
  const priorityScore = ownerDecision.headline?.priority_score ?? 0;
  const supply = ownerDecision.supply || {};
  const recommended = ownerDecision.recommended_actions || [];

  const workflowActions = recommended.map(action =>
    _projectAction({ action, supply, ownerDecision, physicalId, decisionStatus, priorityScore })
  );

  const openCount = workflowActions.filter(w =>
    w.status === WORKFLOW_STATUS.OPEN || w.status === WORKFLOW_STATUS.EVIDENCE_PARTIAL
  ).length;
  const evidenceReadyCount = workflowActions.filter(w => w.status === WORKFLOW_STATUS.EVIDENCE_READY).length;
  const reviewRequiredCount = workflowActions.filter(w => w.status === WORKFLOW_STATUS.OWNER_REVIEW_REQUIRED).length;

  return {
    physical_product_id: physicalId,
    generated_at: ownerDecision.generated_at,
    decision_status_at_creation: decisionStatus,
    priority_score_at_creation: priorityScore,
    workflow_actions: workflowActions,
    summary: {
      total_actions: workflowActions.length,
      open_count: openCount,
      evidence_ready_count: evidenceReadyCount,
      review_required_count: reviewRequiredCount,
    },
    forbidden_automatic_actions: [...FORBIDDEN_AUTOMATIC_ACTIONS],
    reevaluation_hint: (evidenceReadyCount + reviewRequiredCount) > 0
      ? 're_run_assessInventoryDecision_then_buildOwnerDecision_for_updated_recommendations'
      : 'no_re_evaluation_needed_yet',
    note: 'READ-ONLY workflow projection. Evidence arrival never triggers purchase / hold / marketplace mutation.',
  };
}

// ─── per-action projection ──────────────────────────────

function _projectAction({ action, supply, ownerDecision, physicalId, decisionStatus, priorityScore }) {
  const code = action.code;
  const base = {
    action_code: code,
    title: action.label || code,
    why_now: action.description || null,
    physical_product_id: physicalId,
    decision_status_at_creation: decisionStatus,
    priority_score_at_creation: priorityScore,
    requires_owner_approval: true,
    executable_by_system: false,
  };

  if (code === ACTION.WATCH_ONLY) {
    return {
      ...base,
      status: WORKFLOW_STATUS.OPEN,                     // observational · never satisfied by "evidence"
      observational: true,
      required_evidence: [],
      completion_criteria: [
        'Owner explicitly acknowledges no action needed at this time.',
        'Or: decision status changes (WATCH → SELL_NORMALLY / REPLENISH / PROTECT_STOCK).',
      ],
      current_evidence: [],
      missing_evidence: [],
      not_accepted_as_closure: [],
    };
  }

  if (code === ACTION.CONFIRM_EXECUTABLE_QUOTE) {
    const hasExecutable = supply.current_supply_quality === 'executable';
    const hasAskOnly = supply.current_supply_quality === 'ask_only';
    const currentEvidence = [];
    if (hasExecutable) currentEvidence.push(EVIDENCE_TYPES.EXECUTABLE_QUOTE);
    if (hasAskOnly) currentEvidence.push(EVIDENCE_TYPES.SECONDARY_MARKET_ASK);
    return {
      ...base,
      status: hasExecutable ? WORKFLOW_STATUS.EVIDENCE_READY : WORKFLOW_STATUS.OPEN,
      required_evidence: [EVIDENCE_TYPES.EXECUTABLE_QUOTE],
      completion_criteria: [
        `A CURRENT ${EVIDENCE_TYPES.EXECUTABLE_QUOTE} on record for this physical, with seller-confirmed price + quantity + availability.`,
      ],
      current_evidence: currentEvidence,
      missing_evidence: hasExecutable ? [] : [EVIDENCE_TYPES.EXECUTABLE_QUOTE],
      not_accepted_as_closure: [...EVIDENCE_NOT_ACCEPTED_AS_CLOSURE.CONFIRM_EXECUTABLE_QUOTE],
      semantic_notes: [
        'SECONDARY_MARKET_ASK is NOT an executable quote. Ask-only supply MUST NOT close this action.',
        'SUPPLIER_QUOTE alone is not enough — the seller must confirm executability (EXECUTABLE_QUOTE).',
      ],
    };
  }

  if (code === ACTION.CHECK_PRIMARY_SUPPLIER) {
    // Owner rule: current SUPPLIER_QUOTE OR EXECUTABLE_QUOTE satisfies the ask
    // to "have a current primary supplier position." Historical typical
    // reference and accounting cost DO NOT satisfy.
    const hasCurrent = supply.has_current_supplier_or_executable === true;
    const currentEvidence = [];
    if (supply.current_supply_quality === 'executable') currentEvidence.push(EVIDENCE_TYPES.EXECUTABLE_QUOTE);
    if (supply.current_supply_quality === 'supplier_quote') currentEvidence.push(EVIDENCE_TYPES.SUPPLIER_QUOTE);
    return {
      ...base,
      status: hasCurrent ? WORKFLOW_STATUS.EVIDENCE_READY : WORKFLOW_STATUS.OPEN,
      required_evidence: [EVIDENCE_TYPES.SUPPLIER_QUOTE, EVIDENCE_TYPES.EXECUTABLE_QUOTE],
      required_evidence_relation: 'ANY_OF',
      completion_criteria: [
        `At least ONE CURRENT (fresh) ${EVIDENCE_TYPES.SUPPLIER_QUOTE} or ${EVIDENCE_TYPES.EXECUTABLE_QUOTE} on record for this physical.`,
      ],
      current_evidence: currentEvidence,
      missing_evidence: hasCurrent ? [] : [EVIDENCE_TYPES.SUPPLIER_QUOTE, EVIDENCE_TYPES.EXECUTABLE_QUOTE],
      not_accepted_as_closure: [...EVIDENCE_NOT_ACCEPTED_AS_CLOSURE.CHECK_PRIMARY_SUPPLIER],
      semantic_notes: [
        'Historical typical supplier reference is NOT a current supplier quote.',
        'Historical accounting cost is NOT a current supplier quote.',
        'Secondary market ask is NOT a supplier quote.',
      ],
    };
  }

  if (code === ACTION.CHECK_SECONDARY_MARKET) {
    // Secondary-market broadening is an observation task, not evidence-gated
    // in the same way. Consider it EVIDENCE_PARTIAL when at least one secondary
    // observation already exists.
    const askObserved = Number.isFinite(ownerDecision.cost_context?.observed_secondary_market_ask_min_krw);
    return {
      ...base,
      status: askObserved ? WORKFLOW_STATUS.EVIDENCE_PARTIAL : WORKFLOW_STATUS.OPEN,
      required_evidence: [EVIDENCE_TYPES.SECONDARY_MARKET_ASK],
      completion_criteria: [
        'A representative survey of secondary-market asks (junggonara / bunjang / karrot / KREAM) captured for this physical.',
      ],
      current_evidence: askObserved ? [EVIDENCE_TYPES.SECONDARY_MARKET_ASK] : [],
      missing_evidence: askObserved ? [] : [EVIDENCE_TYPES.SECONDARY_MARKET_ASK],
      not_accepted_as_closure: [
        EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE,
        EVIDENCE_TYPES.ACTUAL_PURCHASE,
      ],
    };
  }

  if (code === ACTION.REVIEW_REPLENISHMENT) {
    return {
      ...base,
      status: WORKFLOW_STATUS.OWNER_REVIEW_REQUIRED,
      required_evidence: [EVIDENCE_TYPES.EXECUTABLE_QUOTE, EVIDENCE_TYPES.SUPPLIER_QUOTE],
      required_evidence_relation: 'ANY_OF',
      completion_criteria: [
        'Owner reviews procurement options. NO auto-purchase.',
      ],
      current_evidence: [],
      missing_evidence: [],
      not_accepted_as_closure: [EVIDENCE_TYPES.SECONDARY_MARKET_ASK, EVIDENCE_TYPES.TYPICAL_SUPPLIER_REFERENCE, EVIDENCE_TYPES.ACTUAL_PURCHASE, 'historical_accounting_cost'],
    };
  }

  if (code === ACTION.REVIEW_STOCK_PROTECTION) {
    return {
      ...base,
      status: WORKFLOW_STATUS.OWNER_REVIEW_REQUIRED,
      required_evidence: [],
      completion_criteria: [
        'Owner reviews sellable exposure. NO auto-price / listing change.',
      ],
      current_evidence: [],
      missing_evidence: [],
      not_accepted_as_closure: [],
    };
  }

  if (code === ACTION.REVIEW_DATA_QUALITY) {
    return {
      ...base,
      status: WORKFLOW_STATUS.OWNER_REVIEW_REQUIRED,
      required_evidence: [],
      completion_criteria: [
        'Owner / staff supplies the missing evidence category noted in reasons.missing_evidence.',
      ],
      current_evidence: [],
      missing_evidence: [...(ownerDecision.reasons?.missing_evidence || [])],
      not_accepted_as_closure: [],
    };
  }

  if (code === ACTION.NO_ACTION) {
    return {
      ...base,
      status: WORKFLOW_STATUS.CLOSED_NO_ACTION,
      required_evidence: [],
      completion_criteria: [],
      current_evidence: [],
      missing_evidence: [],
      not_accepted_as_closure: [],
    };
  }

  // Unknown / new action code — default to OPEN, do not auto-close.
  return {
    ...base,
    status: WORKFLOW_STATUS.OPEN,
    required_evidence: [],
    completion_criteria: ['Unknown action code — Owner review required.'],
    current_evidence: [],
    missing_evidence: [],
    not_accepted_as_closure: [],
    unknown_action_code: true,
  };
}

module.exports = {
  buildOwnerActionWorkflow,
  WORKFLOW_STATUS,
  EVIDENCE_NOT_ACCEPTED_AS_CLOSURE,
};
