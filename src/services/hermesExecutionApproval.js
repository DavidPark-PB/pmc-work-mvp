'use strict';

/**
 * Hermes Phase 5A — Approval-gated execution foundation.
 *
 * Internal request/event records only. This module must not call marketplace APIs,
 * change price, change inventory, change listing content, execute actions, or call AI.
 */

const crypto = require('crypto');

const { getClient } = require('../db/supabaseClient');
const { buildHermesOpportunityActionPlan } = require('./opportunityInbox');

const REQUEST_TABLE = 'hermes_execution_requests';
const EVENT_TABLE = 'hermes_execution_events';
const OPPORTUNITY_TABLE = 'opportunity_inbox';

const STATUSES = new Set([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'dry_run_ready',
  'executed',
  'failed',
  'cancelled',
]);

const EXECUTION_TYPES = new Set([
  'price_change',
  'inventory_change',
  'listing_update',
  'listing_quality_update',
  'cost_data_update',
  'enrichment_run',
  'manual_review_task',
]);

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const REVIEW_ACTIONS = new Set(['approve', 'reject', 'cancel']);
const REVIEW_EVENT_TYPES = {
  approve: 'request_approved',
  reject: 'request_rejected',
  cancel: 'request_cancelled',
};
const REVIEW_STATUS_BY_ACTION = {
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancelled',
};
const FINAL_APPROVAL_POLICY_VERSION = 'phase-6-internal-final-approval-v1';
const FINAL_APPROVAL_STATUSES = new Set(['not_requested', 'approved', 'rejected', 'expired']);

const PHASE5_FORBIDDEN_ACTIONS = [
  'no_marketplace_api_calls',
  'no_price_changes',
  'no_inventory_changes',
  'no_listing_changes',
  'no_automatic_execution',
  'no_ai_calls',
  'no_external_side_effects',
];

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(v, max = null) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function isMissingTableError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /PGRST205|42P01|Could not find the table|relation .* does not exist/i.test(text);
}

function executionTypeFromActionPlan(planType) {
  const map = {
    collect_cost_data: 'cost_data_update',
    review_dead_stock_options: 'manual_review_task',
    prepare_price_review: 'price_change',
    prepare_listing_quality_review: 'listing_quality_update',
    verify_competitor_match: 'manual_review_task',
    urgent_competition_review: 'price_change',
    prepare_restock_review: 'inventory_change',
  };
  return map[planType] || 'manual_review_task';
}

function riskFromExecutionType(executionType) {
  const map = {
    price_change: 'high',
    inventory_change: 'high',
    listing_update: 'high',
    listing_quality_update: 'medium',
    cost_data_update: 'medium',
    enrichment_run: 'low',
    manual_review_task: 'low',
  };
  return map[executionType] || 'medium';
}

function mergedForbiddenActions(actionPlan) {
  return [...new Set([
    ...((Array.isArray(actionPlan?.forbidden_actions) ? actionPlan.forbidden_actions : [])),
    ...PHASE5_FORBIDDEN_ACTIONS,
  ])];
}

function requestPayloadFromPlan(plan) {
  const actionPlan = plan.action_plan || {};
  const executionType = executionTypeFromActionPlan(actionPlan.type);
  const forbiddenActions = mergedForbiddenActions(actionPlan);

  return {
    opportunity_id: plan.opportunity_id,
    sku: plan.sku || null,
    execution_type: executionType,
    status: 'pending_approval',
    requested_action: {
      source: 'hermes_opportunity_action_plan',
      opportunity_id: plan.opportunity_id,
      opportunity_type: plan.opportunity_type,
      action_plan: {
        ...actionPlan,
        forbidden_actions: forbiddenActions,
        requires_human_approval: true,
      },
      forbidden_actions: forbiddenActions,
      requires_human_approval: true,
      safety_boundary: {
        marketplace_api_calls: false,
        price_changes: false,
        inventory_changes: false,
        listing_changes: false,
        automatic_execution: false,
        ai_calls: false,
      },
    },
    risk_level: riskFromExecutionType(executionType),
    requires_approval: true,
    dry_run_result: {
      dry_run: true,
      execution_performed: false,
      message: 'Phase 5A request preview only. No external action was executed.',
      forbidden_actions: forbiddenActions,
      requires_human_approval: true,
    },
    execution_result: null,
    metadata: {
      hermes_generated: true,
      hermes_phase: '5A',
      source_opportunity_status: plan.status,
      source_action_plan_type: actionPlan.type || null,
      opportunity_approval_is_not_execution_approval: true,
      marketplace_execution_approved: false,
      external_action_executed: false,
    },
  };
}

async function buildExecutionRequestFromOpportunity({ opportunityId } = {}) {
  const id = intOrNull(opportunityId);
  if (id == null) throw new Error('opportunityId is required');
  const plan = await buildHermesOpportunityActionPlan({ id });
  const request = requestPayloadFromPlan(plan);
  validateExecutionRequest(request);
  return {
    dry_run: true,
    source_plan: plan,
    request,
    safety: {
      marketplace_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_changes: false,
      ai_calls: false,
      execution_performed: false,
    },
  };
}

function validateExecutionRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('request is required');
  const opportunityId = intOrNull(request.opportunity_id);
  if (opportunityId == null) throw new Error('request.opportunity_id is required');

  const executionType = trimOrNull(request.execution_type, 50);
  if (!executionType || !EXECUTION_TYPES.has(executionType)) {
    throw new Error(`invalid execution_type: ${executionType || '(missing)'}`);
  }

  const status = trimOrNull(request.status, 30) || 'pending_approval';
  if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);

  const riskLevel = trimOrNull(request.risk_level, 30) || 'medium';
  if (!RISK_LEVELS.has(riskLevel)) throw new Error(`invalid risk_level: ${riskLevel}`);

  if (request.requires_approval !== true) throw new Error('requires_approval must be true');
  if (request.requested_action?.requires_human_approval !== true) {
    throw new Error('requested_action.requires_human_approval must be true');
  }

  const forbidden = request.requested_action?.forbidden_actions || request.requested_action?.action_plan?.forbidden_actions || [];
  for (const required of PHASE5_FORBIDDEN_ACTIONS) {
    if (!forbidden.includes(required)) throw new Error(`missing forbidden action: ${required}`);
  }

  return true;
}

async function recordExecutionEvent({ requestId, eventType, actor = null, payload = {} } = {}) {
  const id = intOrNull(requestId);
  if (id == null) throw new Error('requestId is required');
  const type = trimOrNull(eventType, 50);
  if (!type) throw new Error('eventType is required');

  const row = {
    request_id: id,
    event_type: type,
    actor: trimOrNull(actor, 100),
    payload: payload && typeof payload === 'object' ? payload : { value: payload },
  };

  const db = getClient();
  const { data, error } = await db.from(EVENT_TABLE).insert(row).select('*').single();
  if (error) throw error;
  return data;
}

async function createExecutionRequest({ opportunityId, dryRun = true } = {}) {
  const preview = await buildExecutionRequestFromOpportunity({ opportunityId });
  const request = preview.request;

  if (dryRun !== false) {
    return {
      dry_run: true,
      created: false,
      request,
      source_plan: preview.source_plan,
      note: 'Dry-run only: no hermes_execution_requests row was created and no external action was executed.',
      safety: preview.safety,
    };
  }

  const db = getClient();
  const { data, error } = await db.from(REQUEST_TABLE).insert(request).select('*').single();
  if (error) {
    if (isMissingTableError(error)) {
      return {
        dry_run: false,
        created: false,
        blocked: true,
        migration_required: true,
        migration: 'supabase/migrations/060_hermes_execution_approval.sql',
        error: error.message,
        request,
        note: 'Migration 060 must be applied before write mode can create internal execution requests.',
      };
    }
    throw error;
  }

  let event = null;
  try {
    event = await recordExecutionEvent({
      requestId: data.id,
      eventType: 'request_created',
      actor: 'hermes-agent-cli',
      payload: {
        opportunity_id: request.opportunity_id,
        dry_run: false,
        external_action_executed: false,
      },
    });
  } catch (eventError) {
    event = { error: eventError.message || String(eventError) };
  }

  return {
    dry_run: false,
    created: true,
    request: data,
    event,
    source_plan: preview.source_plan,
    safety: preview.safety,
  };
}

async function listExecutionRequests({ status = null, sku = null, limit = 20 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 20));
  const db = getClient();
  let q = db.from(REQUEST_TABLE).select('*').order('id', { ascending: false }).limit(safeLimit);

  const targetStatus = trimOrNull(status, 30);
  if (targetStatus) {
    if (!STATUSES.has(targetStatus)) throw new Error(`invalid status: ${targetStatus}`);
    q = q.eq('status', targetStatus);
  }

  const targetSku = trimOrNull(sku, 100);
  if (targetSku) q = q.eq('sku', targetSku);

  const { data, error } = await q;
  if (error) {
    if (isMissingTableError(error)) {
      return {
        count: 0,
        data: [],
        blocked: true,
        migration_required: true,
        migration: 'supabase/migrations/060_hermes_execution_approval.sql',
        error: error.message,
        note: 'Migration 060 must be applied before execution requests can be listed.',
      };
    }
    throw error;
  }

  return { count: (data || []).length, data: data || [] };
}

function actorAuditValues(actor) {
  const trimmed = trimOrNull(actor, 100);
  if (!trimmed) return { actor: null, actorId: null, actorText: null };
  const n = parseInt(trimmed, 10);
  const isNumericActor = Number.isFinite(n) && String(n) === trimmed;
  return {
    actor: trimmed,
    actorId: isNumericActor ? n : null,
    actorText: isNumericActor ? null : trimmed,
  };
}

function reviewPreview({ request, action, actor, reason = null, reviewedAt }) {
  const nextStatus = REVIEW_STATUS_BY_ACTION[action];
  const actorAudit = actorAuditValues(actor);
  const nextMetadata = {
    ...(request.metadata || {}),
    hermes_execution_review: {
      action,
      status: nextStatus,
      actor: actorAudit.actor,
      actor_id: actorAudit.actorId,
      actor_text: actorAudit.actorText,
      reason: trimOrNull(reason, 1000),
      reviewed_at: reviewedAt,
      external_action_executed: false,
    },
    external_action_executed: false,
    marketplace_execution_approved: false,
  };

  const updates = {
    status: nextStatus,
    metadata: nextMetadata,
  };

  if (action === 'approve') {
    updates.approved_by = actorAudit.actorId;
    updates.approved_actor = actorAudit.actorText;
    updates.approved_at = reviewedAt;
    updates.rejected_by = null;
    updates.rejected_actor = null;
    updates.rejected_at = null;
    updates.rejection_reason = null;
    updates.cancelled_by = null;
    updates.cancelled_actor = null;
    updates.cancelled_at = null;
    updates.cancellation_reason = null;
  } else if (action === 'reject') {
    updates.rejected_by = actorAudit.actorId;
    updates.rejected_actor = actorAudit.actorText;
    updates.rejected_at = reviewedAt;
    updates.rejection_reason = trimOrNull(reason, 1000);
  } else if (action === 'cancel') {
    updates.cancelled_by = actorAudit.actorId;
    updates.cancelled_actor = actorAudit.actorText;
    updates.cancelled_at = reviewedAt;
    updates.cancellation_reason = trimOrNull(reason, 1000);
  }

  return {
    ...request,
    ...updates,
    executed_by: request.executed_by || null,
    executed_at: request.executed_at || null,
    execution_result: request.execution_result || null,
  };
}

async function getExecutionRequest({ requestId } = {}) {
  const id = intOrNull(requestId);
  if (id == null) throw new Error('requestId is required');
  const db = getClient();
  const { data, error } = await db.from(REQUEST_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`execution request id=${id} not found`);
  return data;
}

function validateReviewTransition({ request, action, actor, reason, dryRun }) {
  const reviewAction = trimOrNull(action, 30);
  if (!reviewAction || !REVIEW_ACTIONS.has(reviewAction)) {
    throw new Error(`invalid action: ${reviewAction || '(missing)'}`);
  }

  const reviewReason = trimOrNull(reason, 1000);
  if ((reviewAction === 'reject' || reviewAction === 'cancel') && !reviewReason) {
    throw new Error(`${reviewAction} requires reason`);
  }

  if (dryRun === false && !trimOrNull(actor, 100)) {
    throw new Error('actor is required for write mode');
  }

  if (reviewAction === 'approve' && request.status !== 'pending_approval') {
    throw new Error('approve allowed only from pending_approval');
  }
  if (reviewAction === 'reject' && request.status !== 'pending_approval') {
    throw new Error('reject allowed only from pending_approval');
  }
  if (reviewAction === 'cancel' && !['pending_approval', 'approved'].includes(request.status)) {
    throw new Error('cancel allowed only from pending_approval or approved');
  }

  return { action: reviewAction, reason: reviewReason };
}

async function reviewExecutionRequest({ requestId, action, actor = null, reason = null, dryRun = true } = {}) {
  const request = await getExecutionRequest({ requestId });
  const validated = validateReviewTransition({ request, action, actor, reason, dryRun });
  const reviewedAt = new Date().toISOString();
  const after = reviewPreview({
    request,
    action: validated.action,
    actor,
    reason: validated.reason,
    reviewedAt,
  });

  const eventType = REVIEW_EVENT_TYPES[validated.action];
  const eventPayload = {
    action: validated.action,
    from_status: request.status,
    to_status: REVIEW_STATUS_BY_ACTION[validated.action],
    actor: trimOrNull(actor, 100),
    reason: validated.reason,
    external_action_executed: false,
    execution_performed: false,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      updated: false,
      request_id: request.id,
      action: validated.action,
      before: request,
      after,
      event_preview: {
        request_id: request.id,
        event_type: eventType,
        actor: trimOrNull(actor, 100),
        payload: eventPayload,
      },
      safety: {
        marketplace_api_calls: false,
        price_changes: false,
        inventory_changes: false,
        listing_changes: false,
        ai_calls: false,
        execution_performed: false,
      },
    };
  }

  const updates = {
    status: after.status,
    approved_by: after.approved_by,
    approved_actor: after.approved_actor,
    approved_at: after.approved_at,
    rejected_by: after.rejected_by,
    rejected_actor: after.rejected_actor,
    rejected_at: after.rejected_at,
    rejection_reason: after.rejection_reason,
    cancelled_by: after.cancelled_by,
    cancelled_actor: after.cancelled_actor,
    cancelled_at: after.cancelled_at,
    cancellation_reason: after.cancellation_reason,
    metadata: after.metadata,
  };

  const db = getClient();
  const { data: updated, error } = await db
    .from(REQUEST_TABLE)
    .update(updates)
    .eq('id', request.id)
    .select('*')
    .single();
  if (error) throw error;

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType,
    actor: trimOrNull(actor, 100),
    payload: eventPayload,
  });

  return {
    dry_run: false,
    updated: true,
    request_id: request.id,
    action: validated.action,
    before: request,
    after: updated,
    event,
    safety: {
      marketplace_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_changes: false,
      ai_calls: false,
      execution_performed: false,
    },
  };
}

async function listExecutionEvents({ requestId, limit = 20 } = {}) {
  const id = intOrNull(requestId);
  if (id == null) throw new Error('requestId is required');
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 20));
  const db = getClient();
  const { data, error } = await db
    .from(EVENT_TABLE)
    .select('*')
    .eq('request_id', id)
    .order('id', { ascending: true })
    .limit(safeLimit);
  if (error) throw error;
  return { count: (data || []).length, data: data || [] };
}

function buildExecutionDryRunResult({ request, generatedAt }) {
  const actionPlan = request?.requested_action?.action_plan || {};
  const plannedSteps = Array.isArray(actionPlan.steps) ? actionPlan.steps : [];
  const blockedOperations = [
    ...new Set([
      ...PHASE5_FORBIDDEN_ACTIONS,
      ...(Array.isArray(request?.requested_action?.forbidden_actions) ? request.requested_action.forbidden_actions : []),
      ...(Array.isArray(actionPlan.forbidden_actions) ? actionPlan.forbidden_actions : []),
    ]),
  ];

  return {
    dry_run: true,
    execution_performed: false,
    external_action_executed: false,
    marketplace_api_calls: false,
    marketplace_execution_approved: false,
    request_id: request.id,
    sku: request.sku || null,
    execution_type: request.execution_type || null,
    risk_level: request.risk_level || null,
    planned_steps: plannedSteps,
    blocked_operations: blockedOperations,
    required_final_approval: true,
    generated_at: generatedAt,
  };
}

async function generateExecutionDryRun({ requestId, actor = null, dryRun = true } = {}) {
  const request = await getExecutionRequest({ requestId });
  const dryRunActor = trimOrNull(actor, 100);
  if (dryRun === false && !dryRunActor) throw new Error('actor is required for write mode');
  if (request.status !== 'approved') throw new Error('execution dry-run allowed only for approved requests');

  const generatedAt = new Date().toISOString();
  const dryRunResult = buildExecutionDryRunResult({ request, generatedAt });
  const nextMetadata = {
    ...(request.metadata || {}),
    hermes_execution_dry_run: {
      actor: dryRunActor,
      generated_at: generatedAt,
      external_action_executed: false,
      marketplace_execution_approved: false,
    },
    external_action_executed: false,
    marketplace_execution_approved: false,
  };
  const after = {
    ...request,
    status: 'dry_run_ready',
    dry_run_result: dryRunResult,
    metadata: nextMetadata,
    executed_at: request.executed_at || null,
    execution_result: request.execution_result || null,
  };
  const eventPayload = {
    request_id: request.id,
    sku: request.sku || null,
    execution_type: request.execution_type || null,
    risk_level: request.risk_level || null,
    from_status: request.status,
    to_status: 'dry_run_ready',
    external_action_executed: false,
    marketplace_execution_approved: false,
    execution_performed: false,
    dry_run_result: dryRunResult,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      updated: false,
      request_id: request.id,
      before: request,
      after,
      dry_run_result: dryRunResult,
      event_preview: {
        request_id: request.id,
        event_type: 'dry_run_generated',
        actor: dryRunActor,
        payload: eventPayload,
      },
      safety: {
        marketplace_api_calls: false,
        price_changes: false,
        inventory_changes: false,
        listing_changes: false,
        ai_calls: false,
        execution_performed: false,
        external_action_executed: false,
      },
    };
  }

  const updates = {
    status: 'dry_run_ready',
    dry_run_result: dryRunResult,
    metadata: nextMetadata,
  };
  const db = getClient();
  const { data: updated, error } = await db
    .from(REQUEST_TABLE)
    .update(updates)
    .eq('id', request.id)
    .select('*')
    .single();
  if (error) throw error;

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'dry_run_generated',
    actor: dryRunActor,
    payload: eventPayload,
  });

  return {
    dry_run: false,
    updated: true,
    request_id: request.id,
    before: request,
    after: updated,
    dry_run_result: dryRunResult,
    event,
    safety: {
      marketplace_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_changes: false,
      ai_calls: false,
      execution_performed: false,
      external_action_executed: false,
    },
  };
}

function countBy(rows, key) {
  return (rows || []).reduce((acc, row) => {
    const value = row?.[key] || '(missing)';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function requestSafetySummary(request) {
  const metadata = request?.metadata || {};
  return {
    external_action_executed: metadata.external_action_executed === true,
    marketplace_execution_approved: metadata.marketplace_execution_approved === true,
    executed_at: request?.executed_at || null,
    execution_result: request?.execution_result || null,
    requires_approval: request?.requires_approval === true,
    status: request?.status || null,
    risk_level: request?.risk_level || null,
    approved_actor: request?.approved_actor || null,
    rejected_actor: request?.rejected_actor || null,
    cancelled_actor: request?.cancelled_actor || null,
    final_approval_status: request?.final_approval_status || 'not_requested',
    final_approval_actor: request?.final_approval_actor || null,
    final_approved_at: request?.final_approved_at || null,
    final_approval_policy_version: request?.final_approval_policy_version || null,
  };
}

function readinessFromRequest(request) {
  const metadata = request?.metadata || {};
  const dryRun = request?.dry_run_result || null;
  const blockers = [];
  const warnings = [
    'ready_for_execution is always false in Phase 5I',
    'final approval flow is not implemented in this phase',
    'marketplace execution remains disabled',
  ];

  if (!request) blockers.push('request_missing');
  if (request?.status !== 'dry_run_ready') blockers.push('status_not_dry_run_ready');
  if (!dryRun) blockers.push('dry_run_result_missing');
  if (dryRun?.execution_performed !== false) blockers.push('dry_run_execution_performed_not_false');
  if (dryRun?.marketplace_api_calls !== false) blockers.push('dry_run_marketplace_api_calls_not_false');
  if (request?.executed_at != null) blockers.push('executed_at_present');
  if (request?.execution_result != null) blockers.push('execution_result_present');
  if (metadata.external_action_executed === true) blockers.push('external_action_executed_true');
  if (metadata.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (request?.requires_approval !== true) blockers.push('requires_approval_not_true');

  const readyForFinalApproval = blockers.length === 0;
  const plannedSteps = Array.isArray(dryRun?.planned_steps) ? dryRun.planned_steps : [];
  const blockedOperations = Array.isArray(dryRun?.blocked_operations) ? dryRun.blocked_operations : [];

  return {
    request_id: request?.id || null,
    sku: request?.sku || null,
    status: request?.status || null,
    execution_type: request?.execution_type || null,
    risk_level: request?.risk_level || null,
    ready_for_final_approval: readyForFinalApproval,
    ready_for_execution: false,
    blockers,
    warnings,
    required_confirmations: [
      'confirm dry-run result is current',
      'confirm requested action still matches operator intent',
      'confirm no external marketplace action has been executed',
      'confirm marketplace execution is still disabled in Phase 5I',
      'confirm a future separate final approval flow is required before any execution',
    ],
    dry_run_summary: {
      present: !!dryRun,
      generated_at: dryRun?.generated_at || null,
      execution_performed: dryRun?.execution_performed === true,
      marketplace_api_calls: dryRun?.marketplace_api_calls === true,
      external_action_executed: dryRun?.external_action_executed === true,
      marketplace_execution_approved: dryRun?.marketplace_execution_approved === true,
      planned_step_count: plannedSteps.length,
      blocked_operation_count: blockedOperations.length,
      required_final_approval: dryRun?.required_final_approval === true,
    },
    safety: {
      execution_performed: false,
      external_action_executed: metadata.external_action_executed === true,
      marketplace_execution_approved: metadata.marketplace_execution_approved === true,
      executed_at: request?.executed_at || null,
      execution_result: request?.execution_result || null,
    },
    source: 'rule_based',
  };
}

async function buildExecutionReadiness({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  return readinessFromRequest(request);
}

function finalApprovalChecklistFromRequest(request) {
  const metadata = request?.metadata || {};
  const dryRun = request?.dry_run_result || null;
  const readiness = readinessFromRequest(request);
  const requestedAction = request?.requested_action || {};
  const actionPlan = requestedAction.action_plan || {};
  const blockingConditions = [];
  const riskNotes = [];

  if (!dryRun) blockingConditions.push('missing dry_run_result');
  if (request?.status !== 'dry_run_ready') blockingConditions.push('status not dry_run_ready');
  if (request?.executed_at != null) blockingConditions.push('executed_at not null');
  if (request?.execution_result != null) blockingConditions.push('execution_result not null');
  if (metadata.external_action_executed === true) blockingConditions.push('external_action_executed true');
  if (metadata.marketplace_execution_approved === true) blockingConditions.push('marketplace_execution_approved true');
  if (request?.final_approval_status === 'approved') blockingConditions.push('final approval is already recorded');
  if (readiness.ready_for_final_approval !== true) blockingConditions.push('readiness not eligible for future final approval review');

  if (readiness.ready_for_final_approval === true) {
    riskNotes.push('request is eligible for internal final approval review; final approval is not marketplace execution');
  }
  riskNotes.push(`risk level is ${request?.risk_level || 'unknown'}`);
  riskNotes.push(`execution type is ${request?.execution_type || 'unknown'}`);
  riskNotes.push('final approval is internal-only and does not execute marketplace actions');
  riskNotes.push('marketplace execution remains disabled');

  const plannedSteps = Array.isArray(dryRun?.planned_steps) ? dryRun.planned_steps : [];
  const requiredChecks = Array.isArray(actionPlan.required_checks) ? actionPlan.required_checks : [];
  const forbiddenActions = [
    ...new Set([
      ...(Array.isArray(requestedAction.forbidden_actions) ? requestedAction.forbidden_actions : []),
      ...(Array.isArray(actionPlan.forbidden_actions) ? actionPlan.forbidden_actions : []),
      ...(Array.isArray(dryRun?.blocked_operations) ? dryRun.blocked_operations : []),
    ]),
  ];

  return {
    request_id: request?.id || null,
    sku: request?.sku || null,
    status: request?.status || null,
    execution_type: request?.execution_type || null,
    risk_level: request?.risk_level || null,
    final_approval_available: readiness.ready_for_final_approval === true && blockingConditions.length === 0,
    execution_available: false,
    policy_version: FINAL_APPROVAL_POLICY_VERSION,
    operator_checklist: [
      'review readiness summary and blockers',
      'review dry-run planned steps',
      'review requested action and source opportunity context',
      'confirm no marketplace/API action has already occurred',
      'confirm final approval write flow records internal approval only',
      'confirm execution remains disabled',
      ...plannedSteps.map(step => `review planned step: ${step}`),
    ],
    required_confirmations: [
      ...readiness.required_confirmations,
      'confirm final approval checklist is not final approval',
      'confirm final approval records an internal authorization checkpoint only',
      'confirm execution is unavailable until a later executor phase',
      ...requiredChecks,
    ],
    blocking_conditions: blockingConditions,
    risk_notes: riskNotes,
    requested_action_summary: {
      source: requestedAction.source || null,
      action_plan_type: actionPlan.type || null,
      title: actionPlan.title || null,
      planned_step_count: plannedSteps.length,
      required_check_count: requiredChecks.length,
      forbidden_actions: forbiddenActions,
    },
    readiness_summary: readiness,
    safety: {
      read_only: true,
      final_approval_write_implemented: true,
      execution_implemented: false,
      external_action_executed: metadata.external_action_executed === true,
      marketplace_execution_approved: metadata.marketplace_execution_approved === true,
    },
    source: 'rule_based',
  };
}

async function buildFinalApprovalChecklist({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  return finalApprovalChecklistFromRequest(request);
}

function finalApprovalSummary(request) {
  return {
    status: request?.final_approval_status || 'not_requested',
    actor: request?.final_approval_actor || null,
    reason: request?.final_approval_reason || null,
    approved_at: request?.final_approved_at || null,
    policy_version: request?.final_approval_policy_version || null,
    dry_run_hash: request?.final_approval_dry_run_hash || null,
    snapshot: request?.final_approval_snapshot || null,
    rejected_actor: request?.final_approval_rejected_actor || null,
    rejected_at: request?.final_approval_rejected_at || null,
    rejection_reason: request?.final_approval_rejection_reason || null,
    expires_at: request?.final_approval_expires_at || null,
    execution_available: false,
    marketplace_execution_approved: request?.metadata?.marketplace_execution_approved === true,
    external_action_executed: request?.metadata?.external_action_executed === true,
  };
}

function buildFinalApprovalSnapshot({ request, actor, reason, confirmations, confirmedAt, dryRunHash, readiness, checklist }) {
  const confirmationList = Array.isArray(confirmations)
    ? confirmations.map(v => trimOrNull(v, 500)).filter(Boolean)
    : trimOrNull(confirmations, 2000)
      ? [trimOrNull(confirmations, 2000)]
      : [];

  return {
    approved_by_actor: actor,
    approval_reason: reason,
    confirmed_dry_run_result_hash: dryRunHash,
    confirmed_policy_version: FINAL_APPROVAL_POLICY_VERSION,
    confirmed_at: confirmedAt,
    external_action_executed: false,
    marketplace_execution_approved: false,
    request_id: request.id,
    sku: request.sku || null,
    execution_type: request.execution_type || null,
    risk_level: request.risk_level || null,
    request_status: request.status,
    confirmations: confirmationList,
    readiness_summary: readiness,
    final_approval_checklist: checklist,
    safety: {
      final_approval_is_marketplace_execution: false,
      execution_performed: false,
      marketplace_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_changes: false,
    },
  };
}

function buildFinalApprovalPreview({ request, actor, reason, confirmations, approvedAt }) {
  const readiness = readinessFromRequest(request);
  const checklist = finalApprovalChecklistFromRequest(request);
  const blockers = [];
  const metadata = request?.metadata || {};

  if (request?.status !== 'dry_run_ready') blockers.push('status_not_dry_run_ready');
  if (!request?.dry_run_result) blockers.push('dry_run_result_missing');
  if (readiness.ready_for_final_approval !== true) blockers.push('readiness_not_ready_for_final_approval');
  if ((checklist.blocking_conditions || []).length > 0) blockers.push('final_approval_checklist_has_blocking_conditions');
  if (request?.executed_at != null) blockers.push('executed_at_present');
  if (request?.execution_result != null) blockers.push('execution_result_present');
  if (metadata.external_action_executed === true) blockers.push('external_action_executed_true');
  if (metadata.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (!actor) blockers.push('actor_required');
  if (!reason) blockers.push('reason_required');
  if (request?.final_approval_status === 'approved') blockers.push('final_approval_already_approved');

  const dryRunHash = request?.dry_run_result ? sha256Json(request.dry_run_result) : null;
  const snapshot = buildFinalApprovalSnapshot({
    request,
    actor,
    reason,
    confirmations,
    confirmedAt: approvedAt,
    dryRunHash,
    readiness,
    checklist,
  });
  const nextMetadata = {
    ...(metadata || {}),
    hermes_final_approval: {
      actor,
      reason,
      policy_version: FINAL_APPROVAL_POLICY_VERSION,
      dry_run_hash: dryRunHash,
      approved_at: approvedAt,
      external_action_executed: false,
      marketplace_execution_approved: false,
    },
    external_action_executed: false,
    marketplace_execution_approved: false,
  };

  const after = {
    ...request,
    final_approval_status: 'approved',
    final_approval_actor: actor,
    final_approval_reason: reason,
    final_approved_at: approvedAt,
    final_approval_policy_version: FINAL_APPROVAL_POLICY_VERSION,
    final_approval_dry_run_hash: dryRunHash,
    final_approval_snapshot: snapshot,
    metadata: nextMetadata,
    executed_at: null,
    execution_result: null,
  };

  return { readiness, checklist, blockers, dryRunHash, snapshot, nextMetadata, after };
}

async function recordFinalApproval({ requestId, actor = null, reason = null, confirmations = [], dryRun = true } = {}) {
  const request = await getExecutionRequest({ requestId });
  const approvalActor = trimOrNull(actor, 100);
  const approvalReason = trimOrNull(reason, 1000);
  const approvedAt = new Date().toISOString();
  const preview = buildFinalApprovalPreview({
    request,
    actor: approvalActor,
    reason: approvalReason,
    confirmations,
    approvedAt,
  });

  if (preview.blockers.length) {
    if (dryRun === false) throw new Error(`final approval blocked: ${preview.blockers.join(', ')}`);
    return {
      dry_run: true,
      updated: false,
      blocked: true,
      blockers: preview.blockers,
      request_id: request.id,
      before: request,
      after: preview.after,
      readiness_summary: preview.readiness,
      final_approval_checklist: preview.checklist,
      final_approval_snapshot: preview.snapshot,
      safety: {
        final_approval_is_marketplace_execution: false,
        execution_performed: false,
        external_action_executed: false,
        marketplace_execution_approved: false,
      },
    };
  }

  const eventPayload = {
    request_id: request.id,
    sku: request.sku || null,
    actor: approvalActor,
    reason: approvalReason,
    from_final_approval_status: request.final_approval_status || 'not_requested',
    to_final_approval_status: 'approved',
    policy_version: FINAL_APPROVAL_POLICY_VERSION,
    dry_run_hash: preview.dryRunHash,
    external_action_executed: false,
    marketplace_execution_approved: false,
    execution_performed: false,
    final_approval_snapshot: preview.snapshot,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      updated: false,
      blocked: false,
      request_id: request.id,
      before: request,
      after: preview.after,
      readiness_summary: preview.readiness,
      final_approval_checklist: preview.checklist,
      final_approval_snapshot: preview.snapshot,
      event_preview: {
        request_id: request.id,
        event_type: 'final_approval_recorded',
        actor: approvalActor,
        payload: eventPayload,
      },
      safety: {
        final_approval_is_marketplace_execution: false,
        marketplace_api_calls: false,
        price_changes: false,
        inventory_changes: false,
        listing_changes: false,
        ai_calls: false,
        execution_performed: false,
        external_action_executed: false,
      },
    };
  }

  const updates = {
    final_approval_status: 'approved',
    final_approval_actor: approvalActor,
    final_approval_reason: approvalReason,
    final_approved_at: approvedAt,
    final_approval_policy_version: FINAL_APPROVAL_POLICY_VERSION,
    final_approval_dry_run_hash: preview.dryRunHash,
    final_approval_snapshot: preview.snapshot,
    metadata: preview.nextMetadata,
    executed_at: null,
    execution_result: null,
  };

  const db = getClient();
  const { data: updated, error } = await db
    .from(REQUEST_TABLE)
    .update(updates)
    .eq('id', request.id)
    .select('*')
    .single();
  if (error) throw error;

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'final_approval_recorded',
    actor: approvalActor,
    payload: eventPayload,
  });

  return {
    dry_run: false,
    updated: true,
    blocked: false,
    request_id: request.id,
    before: request,
    after: updated,
    readiness_summary: preview.readiness,
    final_approval_checklist: preview.checklist,
    final_approval_snapshot: preview.snapshot,
    event,
    safety: {
      final_approval_is_marketplace_execution: false,
      marketplace_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_changes: false,
      ai_calls: false,
      execution_performed: false,
      external_action_executed: false,
    },
  };
}

async function getOpportunitySnapshot(opportunityId) {
  const id = intOrNull(opportunityId);
  if (id == null) return null;
  const db = getClient();
  const { data, error } = await db
    .from(OPPORTUNITY_TABLE)
    .select('id, opportunity_type, title, priority, status, metadata, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  if (!data) return null;
  const metadata = data.metadata || {};
  return {
    id: data.id,
    sku: metadata.sku || null,
    type: data.opportunity_type || metadata.candidate_type || null,
    title: data.title || null,
    priority: data.priority || null,
    status: data.status || null,
    source_signals: Array.isArray(metadata.source_signals) ? metadata.source_signals : [],
    source_recommendations: Array.isArray(metadata.source_recommendations) ? metadata.source_recommendations : [],
    market_analysis: metadata.market_analysis || {},
    metadata,
    created_at: data.created_at || null,
    updated_at: data.updated_at || null,
  };
}

async function getExecutionRequestDetail({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  const [opportunity, events] = await Promise.all([
    getOpportunitySnapshot(request.opportunity_id),
    listExecutionEvents({ requestId: request.id, limit: 100 }),
  ]);

  return {
    request,
    opportunity_snapshot: opportunity,
    events,
    safety_summary: requestSafetySummary(request),
    readiness_summary: readinessFromRequest(request),
    final_approval_checklist: finalApprovalChecklistFromRequest(request),
    final_approval_summary: finalApprovalSummary(request),
    read_only: true,
    execution_performed: false,
  };
}

function summarizeRecent(rows) {
  return (rows || []).map(row => ({
    id: row.id,
    opportunity_id: row.opportunity_id,
    sku: row.sku,
    execution_type: row.execution_type,
    status: row.status,
    risk_level: row.risk_level,
    requires_approval: row.requires_approval,
    approved_by: row.approved_by || null,
    approved_actor: row.approved_actor || null,
    approved_at: row.approved_at || null,
    rejected_by: row.rejected_by || null,
    rejected_actor: row.rejected_actor || null,
    rejected_at: row.rejected_at || null,
    cancelled_by: row.cancelled_by || null,
    cancelled_actor: row.cancelled_actor || null,
    cancelled_at: row.cancelled_at || null,
    final_approval_status: row.final_approval_status || 'not_requested',
    final_approval_actor: row.final_approval_actor || null,
    final_approval_reason: row.final_approval_reason || null,
    final_approved_at: row.final_approved_at || null,
    final_approval_policy_version: row.final_approval_policy_version || null,
    final_approval_dry_run_hash: row.final_approval_dry_run_hash || null,
    final_approval_expires_at: row.final_approval_expires_at || null,
    executed_at: row.executed_at || null,
    execution_result: row.execution_result || null,
    external_action_executed: row.metadata?.external_action_executed === true,
    marketplace_execution_approved: row.metadata?.marketplace_execution_approved === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

async function summarizeExecutionRequests({ limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const scanLimit = Math.max(safeLimit, 200);
  const db = getClient();

  const { data: requests, error } = await db
    .from(REQUEST_TABLE)
    .select('*')
    .order('id', { ascending: false })
    .limit(scanLimit);
  if (error) throw error;

  const rows = requests || [];
  const recentPending = rows.filter(r => r.status === 'pending_approval').slice(0, safeLimit);
  const recentApproved = rows.filter(r => r.status === 'approved').slice(0, safeLimit);
  const recentDryRunReady = rows.filter(r => r.status === 'dry_run_ready').slice(0, safeLimit);
  const recentRejectedCancelled = rows.filter(r => ['rejected', 'cancelled'].includes(r.status)).slice(0, safeLimit);

  const executionEventTypes = ['request_executed', 'execution_started', 'execution_completed', 'execution_failed'];
  const { data: executionEvents, count: executionEventsCount, error: executionEventsError } = await db
    .from(EVENT_TABLE)
    .select('*', { count: 'exact' })
    .in('event_type', executionEventTypes)
    .limit(1);
  if (executionEventsError) throw executionEventsError;

  const { data: latestEvents, error: latestEventsError } = await db
    .from(EVENT_TABLE)
    .select('*')
    .order('id', { ascending: false })
    .limit(Math.min(20, safeLimit));
  if (latestEventsError) throw latestEventsError;

  return {
    read_only: true,
    limit: safeLimit,
    scanned_request_count: rows.length,
    counts_by_status: countBy(rows, 'status'),
    counts_by_final_approval_status: countBy(rows.map(r => ({ ...r, final_approval_status: r.final_approval_status || 'not_requested' })), 'final_approval_status'),
    counts_by_execution_type: countBy(rows, 'execution_type'),
    counts_by_risk_level: countBy(rows, 'risk_level'),
    recent_pending_requests: summarizeRecent(recentPending),
    recent_approved_requests: summarizeRecent(recentApproved),
    recent_dry_run_ready_requests: summarizeRecent(recentDryRunReady),
    recent_rejected_cancelled_requests: summarizeRecent(recentRejectedCancelled),
    execution_events_count: executionEventsCount || 0,
    no_execution_events: (executionEventsCount || 0) === 0 && (executionEvents || []).length === 0,
    latest_events_sample: latestEvents || [],
    safety_summary: {
      external_actions_detected: rows.filter(r => r.metadata?.external_action_executed === true).length,
      marketplace_execution_approved_count: rows.filter(r => r.metadata?.marketplace_execution_approved === true).length,
      final_approval_approved_count: rows.filter(r => r.final_approval_status === 'approved').length,
      executed_request_count: rows.filter(r => r.executed_at || r.execution_result).length,
    },
  };
}

module.exports = {
  STATUSES,
  EXECUTION_TYPES,
  RISK_LEVELS,
  FINAL_APPROVAL_POLICY_VERSION,
  FINAL_APPROVAL_STATUSES,
  PHASE5_FORBIDDEN_ACTIONS,
  buildExecutionRequestFromOpportunity,
  validateExecutionRequest,
  createExecutionRequest,
  listExecutionRequests,
  getExecutionRequest,
  getExecutionRequestDetail,
  summarizeExecutionRequests,
  generateExecutionDryRun,
  buildExecutionReadiness,
  buildFinalApprovalChecklist,
  recordFinalApproval,
  reviewExecutionRequest,
  listExecutionEvents,
  recordExecutionEvent,
};
