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
const {
  buildEbayListingQualityExecutionIntent,
  buildEbayListingQualityResultRecord,
  buildEbayListingQualityRevisePayload,
  callEbayListingQualityRevise,
  callEbayListingQualityLiveTransport,
  parseEbayReviseFixedPriceItemResponse,
  prepareEbayListingQualityRollbackSnapshot,
  mockCallEbayListingQualityRevise,
  executeEbayListingQualityRevision,
} = require('../adapters/ebayListingQualityExecutionAdapter');

const REQUEST_TABLE = 'hermes_execution_requests';
const EVENT_TABLE = 'hermes_execution_events';
const OPPORTUNITY_TABLE = 'opportunity_inbox';
const INTERNAL_EXECUTION_RECORD_TABLE = 'hermes_internal_execution_records';
const MARKETPLACE_PREFLIGHT_RECORD_TABLE = 'hermes_marketplace_preflight_records';
const EBAY_LISTING_QUALITY_PACKET_TABLE = 'hermes_ebay_listing_quality_packets';

const EBAY_LIVE_CREDENTIAL_ENV_NAMES = [
  'EBAY_APP_ID',
  'EBAY_CERT_ID',
  'EBAY_DEV_ID',
  'EBAY_USER_TOKEN',
  'EBAY_REFRESH_TOKEN',
];
const EBAY_LIVE_OPTIONAL_ENV_NAMES = ['EBAY_ENVIRONMENT'];
const EBAY_LIVE_ENABLE_ENV_NAME = 'HERMES_EBAY_LIVE_EXECUTION_ENABLED';

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

async function listInternalExecutionRecords({ requestId = null, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const db = getClient();
  let q = db.from(INTERNAL_EXECUTION_RECORD_TABLE).select('*').order('id', { ascending: false }).limit(safeLimit);
  const id = intOrNull(requestId);
  if (id != null) q = q.eq('request_id', id);
  const { data, error } = await q;
  if (error) {
    if (isMissingTableError(error)) {
      return {
        count: 0,
        data: [],
        migration_required: true,
        migration: 'supabase/migrations/063_hermes_internal_executor_records.sql',
        error: error.message,
      };
    }
    throw error;
  }
  return { count: (data || []).length, data: data || [], migration_required: false };
}

function executorSafetyFlags(request = {}) {
  return {
    marketplace_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_changes: false,
    external_action_executed: request?.metadata?.external_action_executed === true,
    marketplace_execution_approved: request?.metadata?.marketplace_execution_approved === true,
    execution_performed: false,
  };
}

async function buildExecutorPreflight({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  const records = await listInternalExecutionRecords({ requestId: request.id, limit: 50 });
  const blockers = [];
  const warnings = [
    'internal task record is not marketplace execution',
    'execution_available remains false for marketplace actions',
    'only manual_review_task can be internally recorded',
  ];
  const metadata = request.metadata || {};
  const dryRunHash = request.dry_run_result ? sha256Json(request.dry_run_result) : null;
  const existingInternalTaskRecorded = (records.data || []).some(r => r.status === 'internal_task_recorded');
  const expiresAt = request.final_approval_expires_at ? new Date(request.final_approval_expires_at) : null;
  const expiresInvalid = expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();

  if (records.migration_required) blockers.push('migration_063_required');
  if (request.status !== 'dry_run_ready') blockers.push('status_not_dry_run_ready');
  if (request.final_approval_status !== 'approved') blockers.push('final_approval_status_not_approved');
  if (!trimOrNull(request.final_approval_actor, 100)) blockers.push('final_approval_actor_missing');
  if (!request.dry_run_result) blockers.push('dry_run_result_missing');
  if (!request.final_approval_dry_run_hash) blockers.push('final_approval_dry_run_hash_missing');
  if (request.final_approval_dry_run_hash && dryRunHash && request.final_approval_dry_run_hash !== dryRunHash) blockers.push('final_approval_dry_run_hash_mismatch');
  if (request.executed_at != null) blockers.push('executed_at_present');
  if (request.execution_result != null) blockers.push('execution_result_present');
  if (metadata.external_action_executed === true) blockers.push('external_action_executed_true');
  if (metadata.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (request.execution_type !== 'manual_review_task') blockers.push('execution_type_not_manual_review_task');
  if (request.risk_level !== 'low') blockers.push('risk_level_not_low');
  if (expiresInvalid) blockers.push('final_approval_expired');
  if (existingInternalTaskRecorded) blockers.push('internal_task_already_recorded');

  const allowed = blockers.length === 0;
  return {
    request_id: request.id,
    sku: request.sku || null,
    status: request.status || null,
    execution_type: request.execution_type || null,
    risk_level: request.risk_level || null,
    allowed,
    execution_available: false,
    internal_record_available: allowed && request.execution_type === 'manual_review_task',
    blockers,
    warnings,
    hashes: {
      current_dry_run_hash: dryRunHash,
      final_approval_dry_run_hash: request.final_approval_dry_run_hash || null,
      match: !!dryRunHash && request.final_approval_dry_run_hash === dryRunHash,
    },
    final_approval: {
      status: request.final_approval_status || 'not_requested',
      actor: request.final_approval_actor || null,
      approved_at: request.final_approved_at || null,
      expires_at: request.final_approval_expires_at || null,
      expired: expiresInvalid === true,
    },
    existing_internal_task_recorded: existingInternalTaskRecorded,
    internal_execution_records: records,
    migration_required: records.migration_required === true,
    safety: executorSafetyFlags(request),
    source: 'rule_based',
  };
}

function buildInternalManualReviewTaskResult({ request, actor, reason, preflight, recordedAt }) {
  return {
    request_id: request.id,
    sku: request.sku || null,
    execution_type: request.execution_type || null,
    risk_level: request.risk_level || null,
    actor,
    reason,
    result_type: 'internal_task_recorded',
    recorded_at: recordedAt,
    dry_run_hash: preflight.hashes?.current_dry_run_hash || null,
    final_approval_dry_run_hash: preflight.hashes?.final_approval_dry_run_hash || null,
    execution_performed: false,
    marketplace_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_changes: false,
    external_action_executed: false,
    marketplace_execution_approved: false,
    note: 'Internal manual_review_task record only. This is not marketplace execution.',
  };
}

async function recordInternalManualReviewTask({ requestId, actor = null, reason = null, dryRun = true } = {}) {
  const request = await getExecutionRequest({ requestId });
  const taskActor = trimOrNull(actor, 100);
  const taskReason = trimOrNull(reason, 1000);
  const preflight = await buildExecutorPreflight({ requestId: request.id });
  const blockers = [...(preflight.blockers || [])];
  if (!taskActor) blockers.push('actor_required');
  if (!taskReason) blockers.push('reason_required');
  if (preflight.internal_record_available !== true) blockers.push('internal_record_not_available');
  const recordedAt = new Date().toISOString();
  const internalTaskResult = buildInternalManualReviewTaskResult({
    request,
    actor: taskActor,
    reason: taskReason,
    preflight,
    recordedAt,
  });
  const safetyFlags = executorSafetyFlags(request);
  const record = {
    request_id: request.id,
    execution_type: request.execution_type,
    status: blockers.length ? 'preflight_failed' : 'internal_task_recorded',
    actor: taskActor,
    reason: taskReason,
    preflight_result: preflight,
    internal_task_result: blockers.length ? {} : internalTaskResult,
    safety_flags: safetyFlags,
  };

  if (blockers.length) {
    if (dryRun === false) throw new Error(`internal task record blocked: ${blockers.join(', ')}`);
    return {
      dry_run: true,
      created: false,
      blocked: true,
      blockers,
      request_id: request.id,
      preflight,
      record_preview: record,
      event_preview: null,
      safety: safetyFlags,
    };
  }

  const eventPayload = {
    request_id: request.id,
    sku: request.sku || null,
    actor: taskActor,
    reason: taskReason,
    execution_type: request.execution_type,
    result_type: 'internal_task_recorded',
    preflight_passed: true,
    dry_run_hash: preflight.hashes?.current_dry_run_hash || null,
    final_approval_dry_run_hash: preflight.hashes?.final_approval_dry_run_hash || null,
    execution_performed: false,
    external_action_executed: false,
    marketplace_execution_approved: false,
    marketplace_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_changes: false,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      created: false,
      blocked: false,
      request_id: request.id,
      preflight,
      record_preview: record,
      event_preview: {
        request_id: request.id,
        event_type: 'internal_task_recorded',
        actor: taskActor,
        payload: eventPayload,
      },
      safety: safetyFlags,
    };
  }

  const db = getClient();
  const { data: inserted, error } = await db
    .from(INTERNAL_EXECUTION_RECORD_TABLE)
    .insert(record)
    .select('*')
    .single();
  if (error) {
    if (isMissingTableError(error)) {
      return {
        dry_run: false,
        created: false,
        blocked: true,
        migration_required: true,
        migration: 'supabase/migrations/063_hermes_internal_executor_records.sql',
        error: error.message,
        request_id: request.id,
        preflight,
        record_preview: record,
        safety: safetyFlags,
      };
    }
    throw error;
  }

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'internal_task_recorded',
    actor: taskActor,
    payload: eventPayload,
  });

  return {
    dry_run: false,
    created: true,
    blocked: false,
    request_id: request.id,
    preflight,
    record: inserted,
    event,
    safety: safetyFlags,
  };
}


async function listMarketplacePreflightRecords({ requestId = null, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const db = getClient();
  let q = db.from(MARKETPLACE_PREFLIGHT_RECORD_TABLE).select('*').order('id', { ascending: false }).limit(safeLimit);
  const id = intOrNull(requestId);
  if (id != null) q = q.eq('request_id', id);
  const { data, error } = await q;
  if (error) {
    if (isMissingTableError(error)) {
      return {
        count: 0,
        data: [],
        migration_required: true,
        migration: 'supabase/migrations/064_hermes_marketplace_preflight.sql',
        error: error.message,
      };
    }
    throw error;
  }
  return { count: (data || []).length, data: data || [], migration_required: false };
}

function marketplaceSafetyFlags(request = {}) {
  return {
    marketplace_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_revisions: false,
    external_action_executed: request?.metadata?.external_action_executed === true,
    marketplace_execution_approved: request?.metadata?.marketplace_execution_approved === true,
    execution_performed: false,
  };
}

function objectHasForbiddenMarketplaceMutationFields(value) {
  const forbidden = [
    /price/i,
    /quantity/i,
    /qty/i,
    /inventory/i,
    /stock/i,
    /end(ing)?_?listing/i,
    /listing_?end/i,
    /create_?listing/i,
    /listing_?create/i,
    /relist/i,
  ];
  const hits = [];
  function walk(v, path = '') {
    if (Array.isArray(v)) return v.forEach((item, idx) => walk(item, `${path}[${idx}]`));
    if (!v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      const next = path ? `${path}.${key}` : key;
      if (forbidden.some(rx => rx.test(key))) hits.push(next);
      walk(child, next);
    }
  }
  walk(value || {});
  return [...new Set(hits)];
}

function buildCachedListingSnapshot({ request, opportunity }) {
  const requestedAction = request?.requested_action || {};
  const dryRun = request?.dry_run_result || {};
  const metadata = opportunity?.metadata || {};
  return {
    source: 'cached_internal_data_only',
    marketplace: 'ebay',
    sku: request?.sku || opportunity?.sku || metadata.sku || null,
    listing_id: metadata.item_id || metadata.listing_id || metadata.ebay_item_id || request?.requested_action?.listing_id || null,
    opportunity_id: request?.opportunity_id || null,
    opportunity_type: opportunity?.type || request?.requested_action?.opportunity_type || null,
    opportunity_title: opportunity?.title || null,
    source_signals: opportunity?.source_signals || [],
    source_recommendations: opportunity?.source_recommendations || [],
    dry_run_generated_at: dryRun.generated_at || null,
    requested_action_type: requestedAction.action_plan?.type || null,
    cached_data_note: 'Phase 8 marketplace preflight uses only Hermes cached/internal data and does not call eBay or other marketplace APIs.',
  };
}

function buildPlannedMarketplaceMutationPreview({ request, marketplace, operation }) {
  const actionPlan = request?.requested_action?.action_plan || {};
  return {
    source: 'rule_based_cached_data',
    marketplace,
    operation,
    request_id: request?.id || null,
    sku: request?.sku || null,
    allowed_fields: ['title', 'description', 'item_specifics'],
    mutation_fields: [],
    proposed_changes: {},
    forbidden_fields_present: [],
    price_fields_present: false,
    quantity_fields_present: false,
    listing_end_create_relist_present: false,
    planned_steps: Array.isArray(actionPlan.steps) ? actionPlan.steps : [],
    note: 'Preflight preview only. No marketplace write payload is executed in Phase 8.',
  };
}

async function buildMarketplacePreflight({ requestId, marketplace = 'ebay', operation = 'listing_quality_update' } = {}) {
  const request = await getExecutionRequest({ requestId });
  const normalizedMarketplace = trimOrNull(marketplace, 50) || 'ebay';
  const normalizedOperation = trimOrNull(operation, 80) || 'listing_quality_update';
  const [internalRecords, marketplaceRecords, events, opportunity] = await Promise.all([
    listInternalExecutionRecords({ requestId: request.id, limit: 50 }),
    listMarketplacePreflightRecords({ requestId: request.id, limit: 50 }),
    listExecutionEvents({ requestId: request.id, limit: 200 }),
    getOpportunitySnapshot(request.opportunity_id),
  ]);

  const blockers = [];
  const warnings = [
    'marketplace preflight is not marketplace execution',
    'no marketplace API call is made in this phase',
    'listing changes remain disabled',
    'cached/internal data only',
  ];
  const metadata = request.metadata || {};
  const dryRunHash = request.dry_run_result ? sha256Json(request.dry_run_result) : null;
  const internalTaskRecorded = (internalRecords.data || []).some(r => r.status === 'internal_task_recorded');
  const marketplaceExecutionEvents = (events.data || []).filter(ev => [
    'request_executed',
    'execution_started',
    'execution_completed',
    'execution_failed',
    'marketplace_execution_started',
    'marketplace_execution_completed',
    'marketplace_execution_failed',
  ].includes(ev.event_type));
  const listingSnapshot = buildCachedListingSnapshot({ request, opportunity });
  const plannedMutation = buildPlannedMarketplaceMutationPreview({ request, marketplace: normalizedMarketplace, operation: normalizedOperation });
  const forbiddenFieldHits = objectHasForbiddenMarketplaceMutationFields({
    mutation_fields: plannedMutation.mutation_fields,
    proposed_changes: plannedMutation.proposed_changes,
  });
  const expiresAt = request.final_approval_expires_at ? new Date(request.final_approval_expires_at) : null;
  const expiresInvalid = expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();

  if (marketplaceRecords.migration_required) blockers.push('migration_064_required');
  if (normalizedMarketplace !== 'ebay') blockers.push('marketplace_not_allowlisted');
  if (normalizedOperation !== 'listing_quality_update') blockers.push('operation_not_allowlisted');
  if (request.status !== 'dry_run_ready') blockers.push('status_not_dry_run_ready');
  if (request.final_approval_status !== 'approved') blockers.push('final_approval_status_not_approved');
  if (!internalTaskRecorded) blockers.push('internal_task_recorded_missing');
  if (!request.dry_run_result) blockers.push('dry_run_result_missing');
  if (!request.final_approval_dry_run_hash) blockers.push('final_approval_dry_run_hash_missing');
  if (request.final_approval_dry_run_hash && dryRunHash && request.final_approval_dry_run_hash !== dryRunHash) blockers.push('final_approval_dry_run_hash_mismatch');
  if (marketplaceExecutionEvents.length) blockers.push('previous_marketplace_execution_lifecycle_event_exists');
  if (request.executed_at != null) blockers.push('executed_at_present');
  if (request.execution_result != null) blockers.push('execution_result_present');
  if (metadata.external_action_executed === true) blockers.push('external_action_executed_true');
  if (metadata.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (forbiddenFieldHits.length) blockers.push('forbidden_mutation_fields_present');
  if (expiresInvalid) blockers.push('final_approval_expired');

  const allowed = blockers.length === 0;
  return {
    request_id: request.id,
    sku: request.sku || null,
    marketplace: normalizedMarketplace,
    operation: normalizedOperation,
    allowed,
    marketplace_execution_available: false,
    preflight_record_available: allowed,
    blockers,
    warnings,
    hashes: {
      current_dry_run_hash: dryRunHash,
      final_approval_dry_run_hash: request.final_approval_dry_run_hash || null,
      dry_run_hash_match: !!dryRunHash && request.final_approval_dry_run_hash === dryRunHash,
      cached_listing_snapshot_hash: sha256Json(listingSnapshot),
      planned_mutation_hash: sha256Json(plannedMutation),
    },
    listing_snapshot: listingSnapshot,
    planned_mutation: plannedMutation,
    internal_task_recorded: internalTaskRecorded,
    marketplace_preflight_records: marketplaceRecords,
    previous_marketplace_execution_lifecycle_event_count: marketplaceExecutionEvents.length,
    migration_required: marketplaceRecords.migration_required === true,
    safety: marketplaceSafetyFlags(request),
    source: 'rule_based_cached_data',
  };
}

async function recordMarketplacePreflight({ requestId, marketplace = 'ebay', operation = 'listing_quality_update', actor = null, reason = null, dryRun = true } = {}) {
  const request = await getExecutionRequest({ requestId });
  const preflight = await buildMarketplacePreflight({ requestId: request.id, marketplace, operation });
  const preflightActor = trimOrNull(actor, 100);
  const preflightReason = trimOrNull(reason, 1000);
  const blockers = [...(preflight.blockers || [])];
  if (!preflightActor) blockers.push('actor_required');
  if (!preflightReason) blockers.push('reason_required');
  if (preflight.preflight_record_available !== true) blockers.push('preflight_record_not_available');
  const status = blockers.length ? 'preflight_failed' : 'preflight_passed';
  const safetyFlags = marketplaceSafetyFlags(request);
  const record = {
    request_id: request.id,
    marketplace: preflight.marketplace,
    operation: preflight.operation,
    status,
    actor: preflightActor,
    reason: preflightReason,
    preflight_result: { ...preflight, blockers },
    listing_snapshot: preflight.listing_snapshot || {},
    planned_mutation: preflight.planned_mutation || {},
    safety_flags: safetyFlags,
  };
  const eventType = status === 'preflight_passed' ? 'marketplace_preflight_passed' : 'marketplace_preflight_failed';
  const eventPayload = {
    request_id: request.id,
    sku: request.sku || null,
    marketplace: preflight.marketplace,
    operation: preflight.operation,
    status,
    blockers,
    actor: preflightActor,
    reason: preflightReason,
    source: 'rule_based_cached_data',
    marketplace_execution_available: false,
    marketplace_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_revisions: false,
    external_action_executed: false,
    marketplace_execution_approved: false,
    execution_performed: false,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      created: false,
      blocked: false,
      request_id: request.id,
      preflight: { ...preflight, blockers, allowed: blockers.length === 0, preflight_record_available: blockers.length === 0 },
      record_preview: record,
      event_preview: {
        request_id: request.id,
        event_type: eventType,
        actor: preflightActor,
        payload: eventPayload,
      },
      safety: safetyFlags,
    };
  }

  if (!preflightActor || !preflightReason) {
    return {
      dry_run: false,
      created: false,
      blocked: true,
      request_id: request.id,
      blockers,
      preflight: { ...preflight, blockers, allowed: false, preflight_record_available: false },
      record_preview: record,
      event_preview: null,
      safety: safetyFlags,
    };
  }

  const db = getClient();
  const { data: inserted, error } = await db
    .from(MARKETPLACE_PREFLIGHT_RECORD_TABLE)
    .insert(record)
    .select('*')
    .single();
  if (error) {
    if (isMissingTableError(error)) {
      return {
        dry_run: false,
        created: false,
        blocked: true,
        migration_required: true,
        migration: 'supabase/migrations/064_hermes_marketplace_preflight.sql',
        error: error.message,
        request_id: request.id,
        preflight,
        record_preview: record,
        safety: safetyFlags,
      };
    }
    throw error;
  }

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType,
    actor: preflightActor,
    payload: eventPayload,
  });

  return {
    dry_run: false,
    created: true,
    blocked: false,
    request_id: request.id,
    preflight,
    record: inserted,
    event,
    safety: safetyFlags,
  };
}


function buildListingQualityPlannedMutation() {
  return {
    title: null,
    description: null,
    item_specifics: {},
  };
}

function hasUnsafeListingQualityDryRunFields(plannedMutation) {
  return objectHasForbiddenMarketplaceMutationFields(plannedMutation);
}


async function safeSelectRows(table, select, buildQuery, fallback = []) {
  const db = getClient();
  try {
    let q = db.from(table).select(select);
    q = buildQuery ? buildQuery(q) : q;
    const { data, error } = await q;
    if (error) throw error;
    return data || fallback;
  } catch (e) {
    if (isMissingTableError(e) || /does not exist|column .* does not exist/i.test(e?.message || '')) return fallback;
    throw e;
  }
}

function normalizeItemSpecifics(rows = []) {
  const specifics = {};
  for (const row of rows || []) {
    const name = trimOrNull(row?.name, 200);
    if (!name) continue;
    specifics[name] = row?.value == null ? '' : String(row.value);
  }
  return specifics;
}

function rawDescription(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  return firstNonEmpty(
    raw.description,
    raw.Description,
    raw.item_description,
    raw.ItemDescription,
    raw?.item?.description,
    raw?.Item?.Description
  );
}

async function loadCachedEbayListingEvidence({ sku } = {}) {
  const targetSku = trimOrNull(sku, 100);
  if (!targetSku) {
    return {
      sku: null,
      item_id: null,
      title: null,
      description: null,
      item_specifics: {},
      images: [],
      policies: null,
      listing_detail: null,
      ebay_product: null,
      source_tables: [],
      limitations: ['sku_missing'],
      live_marketplace_state_fetched: false,
      ebay_api_call_made: false,
    };
  }

  const products = await safeSelectRows(
    'ebay_products',
    'sku,item_id,title,price_usd,shipping_usd,sales_count,stock,status,updated_at,image_url',
    q => q.eq('sku', targetSku).not('item_id', 'is', null).neq('item_id', '').order('updated_at', { ascending: false }).limit(5)
  );
  const product = products[0] || null;
  const productItemId = firstNonEmpty(product?.item_id);

  let detailRows = await safeSelectRows(
    'listing_details',
    'platform,listing_type,sku,item_id,title,category_id,category_name,condition,listing_status,raw_data,last_enriched_at',
    q => q.eq('platform', 'ebay').eq('listing_type', 'our').eq('sku', targetSku).limit(5)
  );
  if (!detailRows.length && productItemId) {
    detailRows = await safeSelectRows(
      'listing_details',
      'platform,listing_type,sku,item_id,title,category_id,category_name,condition,listing_status,raw_data,last_enriched_at',
      q => q.eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', productItemId).limit(5)
    );
  }
  const detail = detailRows[0] || null;
  const itemId = firstNonEmpty(detail?.item_id, productItemId);

  const [specificRows, imageRows, policyRows] = itemId ? await Promise.all([
    safeSelectRows('listing_item_specifics', 'platform,listing_type,item_id,name,value,source', q => q.eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', itemId).limit(200)),
    safeSelectRows('listing_images', 'platform,listing_type,item_id,image_url,position,width,height,source', q => q.eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', itemId).order('position', { ascending: true }).limit(50)),
    safeSelectRows('listing_policies', 'platform,listing_type,item_id,return_policy,shipping_policy,payment_policy,handling_time,estimated_delivery,source', q => q.eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', itemId).limit(5)),
  ]) : [[], [], []];

  const itemSpecifics = normalizeItemSpecifics(specificRows);
  const description = rawDescription(detail?.raw_data || {});
  const title = firstNonEmpty(detail?.title, product?.title);
  const sourceTables = [];
  if (product) sourceTables.push('ebay_products');
  if (detail) sourceTables.push('listing_details');
  if (specificRows.length) sourceTables.push('listing_item_specifics');
  if (imageRows.length) sourceTables.push('listing_images');
  if (policyRows.length) sourceTables.push('listing_policies');

  const limitations = [];
  if (!itemId) limitations.push('cached_item_id_missing');
  if (!title) limitations.push('cached_title_missing');
  if (!description) limitations.push('cached_description_missing');
  if (!Object.keys(itemSpecifics).length) limitations.push('cached_item_specifics_missing');
  if (!detail) limitations.push('listing_details_cache_missing_for_sku');

  return {
    sku: targetSku,
    item_id: itemId || null,
    title: title || null,
    description: description || null,
    item_specifics: itemSpecifics,
    images: imageRows || [],
    policies: policyRows[0] || null,
    listing_detail: detail,
    ebay_product: product,
    source_tables: sourceTables,
    limitations,
    live_marketplace_state_fetched: false,
    ebay_api_call_made: false,
  };
}

function mergeCachedListingEvidenceIntoSnapshot(snapshot = {}, evidence = {}) {
  return {
    ...(snapshot || {}),
    sku: firstNonEmpty(evidence.sku, snapshot?.sku),
    listing_id: firstNonEmpty(evidence.item_id, snapshot?.listing_id),
    item_id: firstNonEmpty(evidence.item_id, snapshot?.item_id),
    ebay_item_id: firstNonEmpty(evidence.item_id, snapshot?.ebay_item_id),
    title: Object.prototype.hasOwnProperty.call(evidence, 'title') ? evidence.title : snapshot?.title,
    description: Object.prototype.hasOwnProperty.call(evidence, 'description') ? evidence.description : snapshot?.description,
    item_specifics: evidence.item_specifics && typeof evidence.item_specifics === 'object' ? evidence.item_specifics : (snapshot?.item_specifics || {}),
    cached_listing_resolution: {
      source: 'cached_internal',
      source_tables: evidence.source_tables || [],
      item_id_resolved: !!evidence.item_id,
      title_available: !!evidence.title,
      description_available: !!evidence.description,
      item_specifics_available: Object.keys(evidence.item_specifics || {}).length > 0,
      limitations: evidence.limitations || [],
    },
    live_marketplace_state_fetched: false,
    ebay_api_call_made: false,
  };
}

async function buildEbayListingQualityDryRun({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  const [marketplacePreflight, preflightRecords, internalRecords, events, opportunity, cachedListingEvidence] = await Promise.all([
    buildMarketplacePreflight({ requestId: request.id, marketplace: 'ebay', operation: 'listing_quality_update' }),
    listMarketplacePreflightRecords({ requestId: request.id, limit: 50 }),
    listInternalExecutionRecords({ requestId: request.id, limit: 50 }),
    listExecutionEvents({ requestId: request.id, limit: 200 }),
    getOpportunitySnapshot(request.opportunity_id),
    loadCachedEbayListingEvidence({ sku: request.sku }),
  ]);

  const metadata = request.metadata || {};
  const blockers = [];
  const warnings = [
    'eBay listing quality dry-run is not listing revision',
    'No eBay API call is made',
    'Price and inventory fields are blocked',
    'cached/internal data only',
  ];
  const passedPreflightRecords = (preflightRecords.data || []).filter(row => (
    row.marketplace === 'ebay' &&
    row.operation === 'listing_quality_update' &&
    row.status === 'preflight_passed'
  ));
  const internalTaskRecorded = (internalRecords.data || []).some(r => r.status === 'internal_task_recorded');
  const marketplaceExecutionEvents = (events.data || []).filter(ev => [
    'request_executed',
    'execution_started',
    'execution_completed',
    'execution_failed',
    'marketplace_execution_started',
    'marketplace_execution_completed',
    'marketplace_execution_failed',
  ].includes(ev.event_type));

  if (!passedPreflightRecords.length) blockers.push('marketplace_preflight_passed_missing');
  if (marketplacePreflight.marketplace !== 'ebay') blockers.push('marketplace_not_ebay');
  if (marketplacePreflight.operation !== 'listing_quality_update') blockers.push('operation_not_listing_quality_update');
  if (request.execution_type !== 'manual_review_task' && request.execution_type !== 'listing_quality_update') blockers.push('execution_type_not_safe_for_listing_quality_dry_run');
  if (request.final_approval_status !== 'approved') blockers.push('final_approval_status_not_approved');
  if (!internalTaskRecorded) blockers.push('internal_task_recorded_missing');
  if (request.executed_at != null) blockers.push('executed_at_present');
  if (request.execution_result != null) blockers.push('execution_result_present');
  if (metadata.external_action_executed === true) blockers.push('external_action_executed_true');
  if (metadata.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (marketplaceExecutionEvents.length) blockers.push('previous_marketplace_execution_lifecycle_event_exists');
  if (marketplacePreflight.allowed !== true) blockers.push('marketplace_preflight_not_currently_allowed');

  const beforeSnapshot = mergeCachedListingEvidenceIntoSnapshot({
    ...(marketplacePreflight.listing_snapshot || {}),
    opportunity_snapshot: opportunity || null,
    source: 'cached_internal_data_only',
  }, cachedListingEvidence);
  const plannedMutation = buildListingQualityPlannedMutation({ request, marketplacePreflight });
  const blockedFields = hasUnsafeListingQualityDryRunFields(plannedMutation);
  if (blockedFields.length) blockers.push('blocked_fields_present_in_planned_mutation');

  const hashes = {
    dry_run_result_hash: request.dry_run_result ? sha256Json(request.dry_run_result) : null,
    final_approval_dry_run_hash: request.final_approval_dry_run_hash || null,
    preflight_record_hash: passedPreflightRecords[0] ? sha256Json(passedPreflightRecords[0]) : null,
    before_snapshot_hash: sha256Json(beforeSnapshot),
    planned_mutation_hash: sha256Json(plannedMutation),
    policy_version: 'phase-9-ebay-listing-quality-dry-run-v1',
  };

  return {
    request_id: request.id,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    dry_run: true,
    allowed: blockers.length === 0,
    marketplace_api_calls: false,
    execution_performed: false,
    target: {
      sku: request.sku || beforeSnapshot.sku || null,
      item_id: beforeSnapshot.item_id || beforeSnapshot.listing_id || beforeSnapshot.ebay_item_id || null,
    },
    before_snapshot: beforeSnapshot,
    planned_mutation: plannedMutation,
    blocked_fields: blockedFields,
    blockers,
    warnings,
    hashes,
    safety: {
      marketplace_api_calls: false,
      execution_performed: false,
      ebay_api_calls: false,
      external_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      listing_end_create_relist: false,
      external_action_executed: metadata.external_action_executed === true,
      marketplace_execution_approved: metadata.marketplace_execution_approved === true,
    },
    source: 'rule_based_cached_data',
  };
}


function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimOrNull(value, 200);
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveCachedEbayTarget({ dryRun, request, preflightRecords = [] } = {}) {
  const snapshots = [
    dryRun?.before_snapshot || {},
    ...preflightRecords.map(row => row?.listing_snapshot || {}),
    request?.requested_action || {},
    request?.metadata || {},
  ];
  const itemId = firstNonEmpty(...snapshots.flatMap(snapshot => [
    snapshot.item_id,
    snapshot.listing_id,
    snapshot.ebay_item_id,
    snapshot.ebay_listing_id,
    snapshot.target_item_id,
  ]));
  return {
    sku: firstNonEmpty(dryRun?.target?.sku, request?.sku, ...snapshots.map(snapshot => snapshot.sku)),
    item_id: itemId,
    source: 'cached_internal',
    evidence: itemId ? 'cached_internal_listing_identifier' : null,
  };
}

function snapshotHasListingPayload(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return ['title', 'description', 'item_specifics'].some(key => Object.prototype.hasOwnProperty.call(snapshot, key));
}

function buildRollbackSnapshot({ target, beforeSnapshot, plannedMutation, blockers }) {
  const hasBeforePayload = snapshotHasListingPayload(beforeSnapshot);
  const available = !!target?.item_id && hasBeforePayload && blockers.length === 0;
  const restorePayload = available ? {
    title: Object.prototype.hasOwnProperty.call(beforeSnapshot, 'title') ? beforeSnapshot.title : null,
    description: Object.prototype.hasOwnProperty.call(beforeSnapshot, 'description') ? beforeSnapshot.description : null,
    item_specifics: beforeSnapshot.item_specifics && typeof beforeSnapshot.item_specifics === 'object' ? beforeSnapshot.item_specifics : {},
  } : {};

  const limitations = [];
  if (!target?.item_id) limitations.push('target_item_id_missing_from_cached_internal_data');
  if (!hasBeforePayload) limitations.push('cached_before_listing_payload_missing');
  if (!beforeSnapshot?.title) limitations.push('cached_title_missing');
  if (!beforeSnapshot?.description) limitations.push('cached_description_missing');
  if (!beforeSnapshot?.item_specifics || Object.keys(beforeSnapshot.item_specifics || {}).length === 0) limitations.push('cached_item_specifics_missing');
  if (Array.isArray(beforeSnapshot?.cached_listing_resolution?.limitations)) {
    limitations.push(...beforeSnapshot.cached_listing_resolution.limitations);
  }
  if ((blockers || []).length) limitations.push('operator_review_blocked');
  const uniqueLimitations = [...new Set(limitations)];

  return {
    available,
    manual_rollback_required: true,
    restore_payload: restorePayload,
    before_payload_hash: hasBeforePayload ? sha256Json({
      title: beforeSnapshot.title ?? null,
      description: beforeSnapshot.description ?? null,
      item_specifics: beforeSnapshot.item_specifics || {},
    }) : null,
    planned_payload_hash: sha256Json(plannedMutation || {}),
    marketplace_response: null,
    rollback_feasibility: available ? 'manual_required' : 'not_available_without_cached_target_and_before_payload',
    manual_procedure: available ? [
      'Open the verified eBay listing manually using the cached item_id.',
      'Compare current listing quality fields with the stored before snapshot.',
      'Restore title, description, and item specifics from restore_payload if a future approved write changes them.',
      'Record operator rollback completion in a later explicitly approved phase.',
    ] : [],
    limitations: uniqueLimitations,
  };
}

async function buildEbayListingQualityTargetReview({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  const [dryRun, preflightRecords] = await Promise.all([
    buildEbayListingQualityDryRun({ requestId: request.id }),
    listMarketplacePreflightRecords({ requestId: request.id, limit: 50 }),
  ]);

  const passedPreflightRecords = (preflightRecords.data || []).filter(row => (
    row.marketplace === 'ebay' &&
    row.operation === 'listing_quality_update' &&
    row.status === 'preflight_passed'
  ));
  const target = resolveCachedEbayTarget({ dryRun, request, preflightRecords: passedPreflightRecords });
  const plannedMutation = dryRun.planned_mutation || {};
  const beforeSnapshot = dryRun.before_snapshot || {};
  const blockedFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  const blockers = [...(dryRun.blockers || [])];

  if (!target.item_id) blockers.push('target_item_id_missing_from_cached_internal_data');
  if (!Object.keys(beforeSnapshot).length) blockers.push('before_snapshot_missing');
  if (blockedFields.length) blockers.push('blocked_fields_present_in_planned_mutation');
  if (dryRun.dry_run !== true) blockers.push('phase_9_dry_run_not_true');
  if (dryRun.marketplace_api_calls !== false) blockers.push('marketplace_api_calls_not_false');
  if (dryRun.execution_performed !== false) blockers.push('execution_performed_not_false');

  const rollbackSnapshot = buildRollbackSnapshot({ target, beforeSnapshot, plannedMutation, blockers });
  if (rollbackSnapshot.available !== true) blockers.push('rollback_snapshot_not_available');
  const uniqueBlockers = [...new Set(blockers)];
  const warnings = [
    'Target review is not listing revision',
    'Rollback snapshot is internal-only',
    'No eBay API call is made',
    'cached/internal data only',
    ...((dryRun.warnings || []).filter(w => !/price|inventory|quantity/i.test(String(w)))),
  ];

  return {
    request_id: request.id,
    dry_run: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    target_resolved: !!target.item_id,
    target: {
      sku: target.sku || null,
      item_id: target.item_id || null,
      source: 'cached_internal',
    },
    before_snapshot: beforeSnapshot,
    planned_mutation: plannedMutation,
    rollback_snapshot: rollbackSnapshot,
    operator_review: {
      ready: uniqueBlockers.length === 0 && !!target.item_id && rollbackSnapshot.available === true,
      blockers: uniqueBlockers,
      warnings: [...new Set(warnings)],
      required_confirmations: [
        'confirm target item_id was resolved from cached/internal data only',
        'confirm target review is not listing revision',
        'confirm rollback snapshot is internal-only',
        'confirm no eBay API call is made',
        'confirm no price, inventory, quantity, end, create, or relist operation is present',
      ],
    },
    blocked_fields: blockedFields,
    hashes: {
      phase_9_planned_mutation_hash: dryRun.hashes?.planned_mutation_hash || sha256Json(plannedMutation),
      target_review_before_snapshot_hash: sha256Json(beforeSnapshot),
      target_review_rollback_snapshot_hash: sha256Json(rollbackSnapshot),
      policy_version: 'phase-10-ebay-listing-quality-target-review-v1',
    },
    safety: {
      marketplace_api_calls: false,
      execution_performed: false,
      ebay_api_calls: false,
      external_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      listing_end_create_relist: false,
      external_action_executed: request.metadata?.external_action_executed === true,
      marketplace_execution_approved: request.metadata?.marketplace_execution_approved === true,
    },
    source: 'rule_based_cached_data',
  };
}



function listingQualityMutationIsEmpty(plannedMutation = {}) {
  if (!plannedMutation || typeof plannedMutation !== 'object') return true;
  const titlePresent = Object.prototype.hasOwnProperty.call(plannedMutation, 'title') && plannedMutation.title != null && String(plannedMutation.title).trim() !== '';
  const descriptionPresent = Object.prototype.hasOwnProperty.call(plannedMutation, 'description') && plannedMutation.description != null && String(plannedMutation.description).trim() !== '';
  const itemSpecifics = plannedMutation.item_specifics && typeof plannedMutation.item_specifics === 'object' ? plannedMutation.item_specifics : {};
  return !titlePresent && !descriptionPresent && Object.keys(itemSpecifics).length === 0;
}

async function buildEbayListingQualityExecutionPacket({ requestId } = {}) {
  const request = await getExecutionRequest({ requestId });
  const targetReview = await buildEbayListingQualityTargetReview({ requestId: request.id });
  const plannedMutation = targetReview.planned_mutation || {};
  const beforeSnapshot = targetReview.before_snapshot || {};
  const rollbackSnapshot = targetReview.rollback_snapshot || {};
  const blockedFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  const mutationEmpty = listingQualityMutationIsEmpty(plannedMutation);
  const blockers = [...(targetReview.operator_review?.blockers || [])];
  const warnings = [
    'Execution packet is not eBay execution',
    'No eBay API call is made',
    'Operator packet must be non-empty before any future write phase',
    'cached/internal data only',
  ];

  if (targetReview.target_resolved !== true) blockers.push('target_not_resolved');
  if (rollbackSnapshot.available !== true) blockers.push('rollback_snapshot_not_available');
  if (mutationEmpty) blockers.push('planned_mutation_empty');
  if (blockedFields.length) blockers.push('blocked_fields_present_in_planned_mutation');
  if (targetReview.dry_run !== true) blockers.push('target_review_dry_run_not_true');
  if (targetReview.safety?.marketplace_api_calls !== false) blockers.push('marketplace_api_calls_not_false');
  if (targetReview.safety?.execution_performed !== false) blockers.push('execution_performed_not_false');
  if (!beforeSnapshot.description) warnings.push('cached_description_missing');
  if (!beforeSnapshot.item_specifics || Object.keys(beforeSnapshot.item_specifics || {}).length === 0) warnings.push('cached_item_specifics_missing');
  if (Array.isArray(beforeSnapshot.cached_listing_resolution?.limitations)) {
    warnings.push(...beforeSnapshot.cached_listing_resolution.limitations);
  }

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueWarnings = [...new Set(warnings)];
  const executionPacketReady = uniqueBlockers.length === 0 && mutationEmpty === false && targetReview.target_resolved === true && rollbackSnapshot.available === true;

  return {
    request_id: request.id,
    dry_run: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    execution_packet_ready: executionPacketReady,
    target: targetReview.target || {},
    before_snapshot: beforeSnapshot,
    planned_mutation: plannedMutation,
    rollback_snapshot: rollbackSnapshot,
    operator_packet: {
      ready: executionPacketReady,
      blockers: uniqueBlockers,
      warnings: uniqueWarnings,
      required_confirmations: [
        'confirm execution packet is not eBay execution',
        'confirm no eBay API call is made',
        'confirm operator packet is non-empty before any future write phase',
        'confirm rollback snapshot is available from cached/internal data',
        'confirm no price, inventory, quantity, end, create, or relist field is present',
      ],
    },
    blocked_fields: blockedFields,
    packet_preview: {
      packet_type: 'ebay_listing_quality_update_preview_only',
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      target: targetReview.target || {},
      mutation_payload: plannedMutation,
      rollback_payload: rollbackSnapshot.restore_payload || {},
      send_to_marketplace: false,
      write_to_database: false,
    },
    hashes: {
      planned_mutation_hash: sha256Json(plannedMutation),
      rollback_snapshot_hash: sha256Json(rollbackSnapshot),
      target_review_hash: sha256Json(targetReview),
      execution_packet_hash: sha256Json({
        target: targetReview.target || {},
        planned_mutation: plannedMutation,
        rollback_snapshot: rollbackSnapshot,
        packet_type: 'ebay_listing_quality_update_preview_only',
      }),
      policy_version: 'phase-11a-ebay-listing-quality-execution-packet-v1',
    },
    safety: {
      marketplace_api_calls: false,
      execution_performed: false,
      ebay_api_calls: false,
      external_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      listing_end_create_relist: false,
      database_writes: false,
      external_action_executed: request.metadata?.external_action_executed === true,
      marketplace_execution_approved: request.metadata?.marketplace_execution_approved === true,
    },
    source: 'rule_based_cached_data',
  };
}



function parseOperatorItemSpecifics(itemSpecifics = {}) {
  if (itemSpecifics == null || itemSpecifics === '') return {};
  if (typeof itemSpecifics === 'string') {
    const parsed = JSON.parse(itemSpecifics);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('itemSpecifics must be a JSON object');
    return parsed;
  }
  if (typeof itemSpecifics !== 'object' || Array.isArray(itemSpecifics)) throw new Error('itemSpecifics must be an object');
  return itemSpecifics;
}

function buildOperatorListingQualityMutation({ title = null, description = null, itemSpecifics = {} } = {}) {
  const parsedSpecifics = parseOperatorItemSpecifics(itemSpecifics);
  const cleanSpecifics = {};
  for (const [key, value] of Object.entries(parsedSpecifics)) {
    const name = trimOrNull(key, 200);
    if (!name) continue;
    const normalizedValue = value == null ? '' : String(value).trim();
    if (normalizedValue === '') continue;
    cleanSpecifics[name] = normalizedValue.slice(0, 1000);
  }
  return {
    title: trimOrNull(title, 80),
    description: trimOrNull(description, 10000),
    item_specifics: cleanSpecifics,
  };
}

async function buildOperatorEbayListingQualityPacket({ requestId, title = null, description = null, itemSpecifics = {} } = {}) {
  const request = await getExecutionRequest({ requestId });
  const targetReview = await buildEbayListingQualityTargetReview({ requestId: request.id });
  const plannedMutation = buildOperatorListingQualityMutation({ title, description, itemSpecifics });
  const beforeSnapshot = targetReview.before_snapshot || {};
  const rollbackSnapshot = targetReview.rollback_snapshot || {};
  const blockedFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  const mutationEmpty = listingQualityMutationIsEmpty(plannedMutation);
  const blockers = [...(targetReview.operator_review?.blockers || [])];
  const warnings = [
    'Operator mutation packet is internal-only',
    'No eBay API call is made',
    'No marketplace execution is performed',
    'No database write is performed',
    'Only title, description, and item_specifics are accepted',
    'Operator packet must be reviewed before any future write phase',
  ];

  if (targetReview.target_resolved !== true) blockers.push('target_not_resolved');
  if (rollbackSnapshot.available !== true) blockers.push('rollback_snapshot_not_available');
  if (mutationEmpty) blockers.push('operator_mutation_empty');
  if (blockedFields.length) blockers.push('blocked_fields_present_in_operator_mutation');
  if (targetReview.dry_run !== true) blockers.push('target_review_dry_run_not_true');
  if (targetReview.safety?.marketplace_api_calls !== false) blockers.push('marketplace_api_calls_not_false');
  if (targetReview.safety?.execution_performed !== false) blockers.push('execution_performed_not_false');
  if (!beforeSnapshot.description) warnings.push('cached_description_missing_for_rollback_context');
  if (!beforeSnapshot.item_specifics || Object.keys(beforeSnapshot.item_specifics || {}).length === 0) warnings.push('cached_item_specifics_missing_for_rollback_context');
  if (Array.isArray(beforeSnapshot.cached_listing_resolution?.limitations)) warnings.push(...beforeSnapshot.cached_listing_resolution.limitations);

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueWarnings = [...new Set(warnings)];
  const executionPacketReady = uniqueBlockers.length === 0 && !mutationEmpty && targetReview.target_resolved === true && rollbackSnapshot.available === true;
  const operatorPacket = {
    ready: executionPacketReady,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    allowed_fields: ['title', 'description', 'item_specifics'],
    required_confirmations: [
      'confirm operator mutation packet is internal-only',
      'confirm no eBay API call is made',
      'confirm no marketplace execution is performed',
      'confirm no database write is performed',
      'confirm mutation contains only title, description, and item_specifics',
      'confirm no price, inventory, quantity, end, create, or relist field is present',
    ],
  };

  return {
    request_id: request.id,
    dry_run: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    execution_packet_ready: executionPacketReady,
    target: targetReview.target || {},
    before_snapshot: beforeSnapshot,
    planned_mutation: plannedMutation,
    rollback_snapshot: rollbackSnapshot,
    operator_packet: operatorPacket,
    blocked_fields: blockedFields,
    allowed_fields: ['title', 'description', 'item_specifics'],
    packet_preview: {
      packet_type: 'operator_ebay_listing_quality_update_preview_only',
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      target: targetReview.target || {},
      mutation_payload: plannedMutation,
      rollback_payload: rollbackSnapshot.restore_payload || {},
      send_to_marketplace: false,
      write_to_database: false,
    },
    hashes: {
      operator_planned_mutation_hash: sha256Json(plannedMutation),
      rollback_snapshot_hash: sha256Json(rollbackSnapshot),
      target_review_hash: sha256Json(targetReview),
      operator_packet_hash: sha256Json({
        target: targetReview.target || {},
        planned_mutation: plannedMutation,
        rollback_snapshot: rollbackSnapshot,
        packet_type: 'operator_ebay_listing_quality_update_preview_only',
      }),
      policy_version: 'phase-11b-ebay-operator-mutation-packet-v1',
    },
    safety: {
      marketplace_api_calls: false,
      execution_performed: false,
      ebay_api_calls: false,
      external_api_calls: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      listing_end_create_relist: false,
      database_writes: false,
      external_action_executed: request.metadata?.external_action_executed === true,
      marketplace_execution_approved: request.metadata?.marketplace_execution_approved === true,
    },
    source: 'rule_based_cached_data',
  };
}



async function listEbayListingQualityPackets({ requestId = null, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const db = getClient();
  let q = db.from(EBAY_LISTING_QUALITY_PACKET_TABLE).select('*').order('id', { ascending: false }).limit(safeLimit);
  const id = intOrNull(requestId);
  if (id != null) q = q.eq('request_id', id);
  const { data, error } = await q;
  if (error) {
    if (isMissingTableError(error)) {
      return {
        count: 0,
        data: [],
        migration_required: true,
        migration: 'supabase/migrations/065_hermes_ebay_listing_quality_packets.sql',
        error: error.message,
      };
    }
    throw error;
  }
  return { count: (data || []).length, data: data || [], migration_required: false };
}

async function recordEbayListingQualityPacket({ requestId, title = null, description = null, itemSpecifics = {}, actor = null, reason = null, dryRun = true } = {}) {
  const request = await getExecutionRequest({ requestId });
  const packetActor = trimOrNull(actor, 100);
  const packetReason = trimOrNull(reason, 1000);
  const operatorPacket = await buildOperatorEbayListingQualityPacket({
    requestId: request.id,
    title,
    description,
    itemSpecifics,
  });
  const plannedMutation = operatorPacket.planned_mutation || {};
  const blockedFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  const mutationEmpty = listingQualityMutationIsEmpty(plannedMutation);
  const blockers = [...(operatorPacket.operator_packet?.blockers || [])];

  if (operatorPacket.operator_packet?.ready !== true) blockers.push('operator_packet_not_ready');
  if (operatorPacket.execution_packet_ready !== true) blockers.push('execution_packet_not_ready');
  if (mutationEmpty) blockers.push('planned_mutation_empty');
  if (blockedFields.length) blockers.push('blocked_fields_present_in_planned_mutation');
  if (dryRun === false && !packetActor) blockers.push('actor_required');
  if (dryRun === false && !packetReason) blockers.push('reason_required');

  const uniqueBlockers = [...new Set(blockers)];
  const packetHash = sha256Json({
    request_id: request.id,
    item_id: operatorPacket.target?.item_id || null,
    planned_mutation: plannedMutation,
    before_snapshot_hash: sha256Json(operatorPacket.before_snapshot || {}),
    rollback_snapshot_hash: sha256Json(operatorPacket.rollback_snapshot || {}),
    policy_version: 'phase-11c-ebay-listing-quality-packet-record-v1',
  });
  const safetyFlags = {
    ...(operatorPacket.safety || {}),
    marketplace_api_calls: false,
    execution_performed: false,
    ebay_api_calls: false,
    external_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_revisions: false,
    listing_end_create_relist: false,
    database_writes: dryRun === false,
  };
  const record = {
    request_id: request.id,
    item_id: operatorPacket.target?.item_id || null,
    actor: packetActor,
    reason: packetReason,
    packet_hash: packetHash,
    planned_mutation: plannedMutation,
    before_snapshot: operatorPacket.before_snapshot || {},
    rollback_snapshot: operatorPacket.rollback_snapshot || {},
    safety_flags: safetyFlags,
    status: uniqueBlockers.length ? 'packet_rejected' : 'packet_recorded',
  };
  const eventPayload = {
    request_id: request.id,
    sku: request.sku || null,
    item_id: record.item_id,
    actor: packetActor,
    reason: packetReason,
    packet_hash: packetHash,
    status: record.status,
    blockers: uniqueBlockers,
    planned_mutation: plannedMutation,
    execution_performed: false,
    external_action_executed: false,
    marketplace_execution_approved: false,
    marketplace_api_calls: false,
    ebay_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_revisions: false,
  };

  if (uniqueBlockers.length) {
    if (dryRun === false) throw new Error(`eBay listing quality packet blocked: ${uniqueBlockers.join(', ')}`);
    return {
      dry_run: true,
      created: false,
      blocked: true,
      blockers: uniqueBlockers,
      request_id: request.id,
      operator_packet: operatorPacket,
      packet_hash: packetHash,
      record_preview: record,
      event_preview: null,
      safety: safetyFlags,
    };
  }

  if (dryRun !== false) {
    return {
      dry_run: true,
      created: false,
      blocked: false,
      request_id: request.id,
      operator_packet: operatorPacket,
      packet_hash: packetHash,
      record_preview: record,
      event_preview: {
        request_id: request.id,
        event_type: 'ebay_listing_quality_packet_recorded',
        actor: packetActor,
        payload: eventPayload,
      },
      safety: safetyFlags,
    };
  }

  if (!packetActor || !packetReason) {
    return {
      dry_run: false,
      created: false,
      blocked: true,
      blockers: ['actor_required', 'reason_required'].filter(b => (b === 'actor_required' && !packetActor) || (b === 'reason_required' && !packetReason)),
      request_id: request.id,
      operator_packet: operatorPacket,
      packet_hash: packetHash,
      record_preview: record,
      event_preview: null,
      safety: safetyFlags,
    };
  }

  const db = getClient();
  const { data: inserted, error } = await db
    .from(EBAY_LISTING_QUALITY_PACKET_TABLE)
    .insert(record)
    .select('*')
    .single();
  if (error) {
    if (isMissingTableError(error)) {
      return {
        dry_run: false,
        created: false,
        blocked: true,
        migration_required: true,
        migration: 'supabase/migrations/065_hermes_ebay_listing_quality_packets.sql',
        error: error.message,
        request_id: request.id,
        operator_packet: operatorPacket,
        packet_hash: packetHash,
        record_preview: record,
        safety: safetyFlags,
      };
    }
    throw error;
  }

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'ebay_listing_quality_packet_recorded',
    actor: packetActor,
    payload: eventPayload,
  });

  return {
    dry_run: false,
    created: true,
    blocked: false,
    request_id: request.id,
    operator_packet: operatorPacket,
    packet_hash: packetHash,
    record: inserted,
    event,
    safety: safetyFlags,
  };
}



function isMissingSchemaError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return isMissingTableError(error) || /PGRST204|column .* does not exist|Could not find .*column|schema cache/i.test(text);
}

async function getEbayListingQualityPacket({ packetId } = {}) {
  const id = intOrNull(packetId);
  if (id == null) throw new Error('packetId is required');
  const db = getClient();
  const { data, error } = await db
    .from(EBAY_LISTING_QUALITY_PACKET_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`eBay listing quality packet id=${id} not found`);
  return data;
}

function packetConfirmationSnapshot({ packet, request, actor, reason, confirmedAt }) {
  return {
    packet_id: packet.id,
    request_id: packet.request_id,
    item_id: packet.item_id || null,
    packet_hash: packet.packet_hash || null,
    actor,
    reason,
    confirmed_at: confirmedAt,
    status_before: packet.status || null,
    confirmation_status_before: packet.confirmation_status || 'not_confirmed',
    planned_mutation: packet.planned_mutation || {},
    planned_mutation_hash: sha256Json(packet.planned_mutation || {}),
    before_snapshot_hash: sha256Json(packet.before_snapshot || {}),
    rollback_snapshot_hash: sha256Json(packet.rollback_snapshot || {}),
    request_safety: requestSafetySummary(request),
    safety: {
      marketplace_api_calls: false,
      ebay_api_calls: false,
      external_api_calls: false,
      execution_performed: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      listing_end_create_relist: false,
      external_action_executed: false,
      marketplace_execution_approved: false,
    },
    policy_version: 'phase-11e-ebay-packet-final-confirmation-v1',
  };
}

async function confirmEbayListingQualityPacket({ packetId, actor = null, reason = null, dryRun = true } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const confirmActor = trimOrNull(actor, 100);
  const confirmReason = trimOrNull(reason, 1000);
  const confirmationStatus = packet.confirmation_status || 'not_confirmed';
  const plannedMutation = packet.planned_mutation || {};
  const blockedFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  const blockers = [];
  const metadata = request.metadata || {};

  if (packet.status !== 'packet_recorded') blockers.push('packet_status_not_packet_recorded');
  if (confirmationStatus !== 'not_confirmed') blockers.push('confirmation_status_not_not_confirmed');
  if (request.executed_at != null) blockers.push('executed_at_present');
  if (request.execution_result != null) blockers.push('execution_result_present');
  if (metadata.external_action_executed === true) blockers.push('external_action_executed_true');
  if (metadata.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (listingQualityMutationIsEmpty(plannedMutation)) blockers.push('planned_mutation_empty');
  if (!Object.keys(plannedMutation).every(k => ['title', 'description', 'item_specifics'].includes(k))) blockers.push('planned_mutation_has_non_allowed_fields');
  if (blockedFields.length) blockers.push('blocked_fields_present_in_planned_mutation');
  if (dryRun === false && !confirmActor) blockers.push('actor_required');
  if (dryRun === false && !confirmReason) blockers.push('reason_required');

  const uniqueBlockers = [...new Set(blockers)];
  const confirmedAt = new Date().toISOString();
  const confirmationSnapshot = packetConfirmationSnapshot({
    packet,
    request,
    actor: confirmActor,
    reason: confirmReason,
    confirmedAt,
  });
  const updates = {
    confirmation_status: 'confirmed',
    confirmed_by_actor: confirmActor,
    confirmation_reason: confirmReason,
    confirmed_at: confirmedAt,
    confirmation_snapshot: confirmationSnapshot,
    rejected_by_actor: null,
    rejection_reason: null,
    rejected_at: null,
  };
  const eventPayload = {
    packet_id: packet.id,
    request_id: request.id,
    sku: request.sku || null,
    item_id: packet.item_id || null,
    packet_hash: packet.packet_hash || null,
    actor: confirmActor,
    reason: confirmReason,
    confirmation_status: 'confirmed',
    blockers: uniqueBlockers,
    planned_mutation: plannedMutation,
    execution_performed: false,
    external_action_executed: false,
    marketplace_execution_approved: false,
    marketplace_api_calls: false,
    ebay_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_revisions: false,
  };
  const safety = {
    marketplace_api_calls: false,
    execution_performed: false,
    ebay_api_calls: false,
    external_api_calls: false,
    price_changes: false,
    inventory_changes: false,
    listing_revisions: false,
    listing_end_create_relist: false,
    database_writes: dryRun === false,
    external_action_executed: metadata.external_action_executed === true,
    marketplace_execution_approved: metadata.marketplace_execution_approved === true,
  };

  if (uniqueBlockers.length) {
    if (dryRun === false) throw new Error(`eBay listing quality packet confirmation blocked: ${uniqueBlockers.join(', ')}`);
    return {
      dry_run: true,
      updated: false,
      blocked: true,
      blockers: uniqueBlockers,
      packet_id: packet.id,
      request_id: request.id,
      before: packet,
      after: { ...packet, ...updates },
      confirmation_snapshot: confirmationSnapshot,
      event_preview: null,
      safety,
    };
  }

  if (dryRun !== false) {
    return {
      dry_run: true,
      updated: false,
      blocked: false,
      packet_id: packet.id,
      request_id: request.id,
      before: packet,
      after: { ...packet, ...updates },
      confirmation_snapshot: confirmationSnapshot,
      event_preview: {
        request_id: request.id,
        event_type: 'ebay_listing_quality_packet_confirmed',
        actor: confirmActor,
        payload: eventPayload,
      },
      safety,
    };
  }

  if (!confirmActor || !confirmReason) {
    return {
      dry_run: false,
      updated: false,
      blocked: true,
      blockers: ['actor_required', 'reason_required'].filter(b => (b === 'actor_required' && !confirmActor) || (b === 'reason_required' && !confirmReason)),
      packet_id: packet.id,
      request_id: request.id,
      before: packet,
      after: { ...packet, ...updates },
      confirmation_snapshot: confirmationSnapshot,
      event_preview: null,
      safety,
    };
  }

  const db = getClient();
  const { data: updated, error } = await db
    .from(EBAY_LISTING_QUALITY_PACKET_TABLE)
    .update(updates)
    .eq('id', packet.id)
    .select('*')
    .single();
  if (error) {
    if (isMissingSchemaError(error)) {
      return {
        dry_run: false,
        updated: false,
        blocked: true,
        migration_required: true,
        migration: 'supabase/migrations/066_hermes_ebay_packet_confirmation.sql',
        error: error.message,
        packet_id: packet.id,
        request_id: request.id,
        before: packet,
        after: { ...packet, ...updates },
        confirmation_snapshot: confirmationSnapshot,
        safety,
      };
    }
    throw error;
  }

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'ebay_listing_quality_packet_confirmed',
    actor: confirmActor,
    payload: eventPayload,
  });

  return {
    dry_run: false,
    updated: true,
    blocked: false,
    packet_id: packet.id,
    request_id: request.id,
    before: packet,
    after: updated,
    confirmation_snapshot: confirmationSnapshot,
    event,
    safety,
  };
}





async function buildEbayListingQualityPayload({ packetId } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const payload = buildEbayListingQualityRevisePayload({ packet, request, intent });
  return {
    ...payload,
    build_only: true,
    actual_ebay_call: false,
    actual_database_write: false,
    execution_result_updated: false,
    executed_at_updated: false,
    safety: {
      marketplace_api_calls: false,
      ebay_api_calls: false,
      marketplace_write_performed: false,
      database_writes: false,
      executed_at_updated: false,
      execution_result_updated: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      live_execution_performed: false,
    },
  };
}







function resolveExistingEbayApiModulePath() {
  try {
    return require.resolve('../api/ebayAPI');
  } catch (e) {
    return null;
  }
}

async function countMarketplaceExecutionEvents(requestId) {
  const db = getClient();
  const executionEventTypes = [
    'request_executed',
    'execution_started',
    'execution_completed',
    'execution_failed',
    'marketplace_execution_started',
    'marketplace_execution_completed',
    'marketplace_execution_failed',
  ];
  const { count, error } = await db
    .from(EVENT_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('request_id', requestId)
    .in('event_type', executionEventTypes);
  if (error) throw error;
  return count || 0;
}

function buildPhase12ILiveExecutionBlockers({ packet, request, payload, rollbackSnapshot, previousMarketplaceExecutionEventCount } = {}) {
  const summary = payload?.payload_summary || {};
  const payloadFields = Array.isArray(summary.payload_fields) ? summary.payload_fields : [];
  const blockers = [];
  if (packet?.id !== 1) blockers.push('packet_id_not_1');
  if (String(packet?.item_id || '') !== '202551129453') blockers.push('target_item_id_not_202551129453');
  if (packet?.confirmation_status !== 'confirmed') blockers.push('packet_confirmation_status_not_confirmed');
  if (request?.final_approval_status !== 'approved') blockers.push('request_final_approval_not_approved');
  if (!rollbackSnapshot || rollbackSnapshot.available !== true) blockers.push('rollback_snapshot_missing');
  if (request?.executed_at != null) blockers.push('request_executed_at_present');
  if (request?.execution_result != null) blockers.push('request_execution_result_present');
  if ((previousMarketplaceExecutionEventCount || 0) > 0) blockers.push('previous_marketplace_execution_event_exists');
  if (summary.updates_title !== true) blockers.push('payload_does_not_update_title');
  if (summary.updates_description === true) blockers.push('payload_updates_description_not_allowed_phase_12i');
  if (summary.updates_item_specifics === true) blockers.push('payload_updates_item_specifics_not_allowed_phase_12i');
  if (payloadFields.length !== 1 || payloadFields[0] !== 'Title') blockers.push('payload_not_title_only');
  if (summary.forbidden_fields_present === true) blockers.push('payload_forbidden_fields_present');
  if (Array.isArray(summary.forbidden_fields) && summary.forbidden_fields.length) blockers.push('payload_forbidden_fields_present');
  if (Array.isArray(summary.non_allowed_fields) && summary.non_allowed_fields.length) blockers.push('payload_non_allowed_fields_present');
  return [...new Set(blockers)];
}

async function persistEbayListingQualityLiveExecutionResult({ packet, request, payload, transportResult } = {}) {
  const parsed = transportResult?.parsed_response || {};
  const success = parsed.success === true;
  const timestamp = parsed.timestamp || new Date().toISOString();
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });
  const executionResult = {
    packet_id: packet.id,
    request_id: request.id,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    api_operation: 'ReviseFixedPriceItem',
    target_item_id: packet.item_id,
    payload: payload.payload,
    payload_summary: payload.payload_summary,
    rollback_snapshot: rollbackSnapshot,
    raw_response: transportResult.raw_response || null,
    parsed_response: parsed,
    success,
    ack: parsed.ack || null,
    correlation_id: parsed.correlation_id || null,
    response_timestamp: parsed.timestamp || null,
    actual_ebay_call: transportResult.actual_ebay_call === true,
    actual_network_call: transportResult.actual_network_call === true,
    marketplace_write_performed: transportResult.marketplace_write_performed === true,
    price_changes: false,
    inventory_changes: false,
    title_only: true,
    recorded_at: new Date().toISOString(),
    source: 'phase_12i_ebay_live_single_sku_execution_v1',
  };
  const eventType = success ? 'marketplace_execution_completed' : 'marketplace_execution_failed';
  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType,
    actor: 'operator',
    payload: executionResult,
  });

  let updatedRequest = request;
  if (success) {
    const db = getClient();
    const metadata = {
      ...(request.metadata || {}),
      external_action_executed: true,
      marketplace_execution_approved: true,
      marketplace_execution_packet_id: packet.id,
      marketplace_execution_event_id: event.id,
      marketplace_execution_completed_at: timestamp,
      marketplace_execution_scope: 'phase_12i_single_sku_title_only',
      marketplace_execution_price_changes: false,
      marketplace_execution_inventory_changes: false,
    };
    const { data, error } = await db
      .from(REQUEST_TABLE)
      .update({
        status: 'executed',
        executed_at: timestamp,
        execution_result: executionResult,
        metadata,
      })
      .eq('id', request.id)
      .is('executed_at', null)
      .is('execution_result', null)
      .select('*')
      .single();
    if (error) throw error;
    updatedRequest = data;
  }

  return {
    execution_recorded: true,
    execution_success: success,
    event,
    updated_request: updatedRequest,
    execution_result: executionResult,
    executed_at: success ? updatedRequest.executed_at : null,
    execution_result_updated: success,
    executed_at_updated: success,
    note: success
      ? 'eBay response parsed as success/warning; executed_at and execution_result were recorded after the confirmed eBay response.'
      : 'eBay response was not success; marketplace failure event recorded, but executed_at was not set.',
  };
}



const MARKETPLACE_EXECUTION_EVENT_TYPES = [
  'request_executed',
  'execution_started',
  'execution_completed',
  'execution_failed',
  'marketplace_execution_started',
  'marketplace_execution_completed',
  'marketplace_execution_failed',
];

function normalizeSignalTypes(signals = []) {
  return [...new Set((Array.isArray(signals) ? signals : [])
    .map(signal => {
      if (typeof signal === 'string') return signal;
      if (signal && typeof signal === 'object') return signal.type || signal.signal_type || signal.name || null;
      return null;
    })
    .filter(Boolean)
    .map(value => String(value)))]
    .sort();
}

function collectCandidateSignalSummary({ opportunity, request } = {}) {
  const opportunityMetadata = opportunity?.metadata || {};
  const requestMetadata = request?.metadata || {};
  const requestedAction = request?.requested_action || {};
  const signals = normalizeSignalTypes([
    ...(opportunityMetadata.source_signals || []),
    ...(requestMetadata.source_signals || []),
    ...(requestedAction.source_signals || []),
    ...(requestedAction.action_plan?.source_signals || []),
  ]);
  const recommendations = normalizeSignalTypes([
    ...(opportunityMetadata.source_recommendations || []),
    ...(requestMetadata.source_recommendations || []),
    ...(requestedAction.source_recommendations || []),
    ...(requestedAction.action_plan?.source_recommendations || []),
  ]);
  return {
    signals,
    recommendations,
    has_listing_quality_low: signals.includes('listing_quality_low') || recommendations.includes('listing_quality_review'),
    has_price_pressure: signals.some(signal => /price|competitor_lower_price|price_attack/i.test(signal)),
    has_inventory_pressure: signals.some(signal => /inventory|stock|quantity/i.test(signal)),
  };
}

function deterministicTitleImprovement(title) {
  const original = typeof title === 'string' ? title : '';
  const cleaned = original.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    current_title: original || null,
    proposed_title: cleaned || null,
    title_improvement_only: Boolean(cleaned),
    title_changed_by_rule: Boolean(cleaned && cleaned !== original),
    rule: 'trim/collapse whitespace and enforce eBay title length cap; no AI call',
  };
}

function candidateEventItemIds(events = []) {
  const ids = new Set();
  for (const event of events || []) {
    const payload = event?.payload || {};
    for (const value of [
      payload.target_item_id,
      payload.item_id,
      payload?.payload?.Item?.ItemID,
      payload?.parsed_response?.item_id,
      payload?.raw_response?.ItemID,
    ]) {
      if (value != null && String(value).trim()) ids.add(String(value).trim());
    }
  }
  return ids;
}

function phase13CandidateBaseExclusions({ request, opportunity, evidence, marketplaceEventsByRequest, marketplaceExecutedItemIds } = {}) {
  const blockers = [];
  const requestId = intOrNull(request?.id);
  const opportunityId = intOrNull(opportunity?.id);
  const itemId = firstNonEmpty(evidence?.item_id, request?.metadata?.item_id, request?.metadata?.listing_id, opportunity?.metadata?.item_id, opportunity?.metadata?.listing_id, opportunity?.metadata?.ebay_item_id);
  if (requestId === 1) blockers.push('request_id_1_excluded');
  if (request?.executed_at != null) blockers.push('request_executed_at_present');
  if (request?.execution_result != null) blockers.push('request_execution_result_present');
  if (itemId === '202551129453') blockers.push('item_id_202551129453_excluded');
  if (marketplaceExecutedItemIds.has(String(itemId || ''))) blockers.push('item_previous_marketplace_execution_completed_event_exists');
  if (requestId != null && (marketplaceEventsByRequest.get(requestId) || []).some(ev => ev.event_type === 'marketplace_execution_completed')) {
    blockers.push('request_previous_marketplace_execution_completed_event_exists');
  }
  if (opportunityId === 4 && itemId === '202551129453') blockers.push('phase_12_source_opportunity_excluded');
  return [...new Set(blockers)];
}

function phase13CandidateQualityBlockers({ request, opportunity, evidence, signalSummary, titleProposal } = {}) {
  const blockers = [];
  const itemId = firstNonEmpty(evidence?.item_id, request?.metadata?.item_id, request?.metadata?.listing_id, opportunity?.metadata?.item_id, opportunity?.metadata?.listing_id, opportunity?.metadata?.ebay_item_id);
  if (!signalSummary.has_listing_quality_low) blockers.push('listing_quality_low_signal_missing');
  if (!itemId) blockers.push('valid_ebay_item_id_missing');
  if (!titleProposal.proposed_title) blockers.push('title_evidence_missing');
  if (signalSummary.has_price_pressure) blockers.push('price_pressure_signal_present');
  if (signalSummary.has_inventory_pressure) blockers.push('inventory_or_stock_signal_present');
  const opportunityStatus = opportunity?.status || null;
  if (opportunity && !['new', 'reviewing', 'approved'].includes(opportunityStatus)) blockers.push(`opportunity_status_${opportunityStatus || 'missing'}_not_active`);
  const requestStatus = request?.status || null;
  if (request && ['cancelled', 'rejected', 'failed', 'executed'].includes(requestStatus)) blockers.push(`request_status_${requestStatus}_not_selectable`);
  return [...new Set(blockers)];
}

function phase13RiskLevel({ evidence, titleProposal, qualityBlockers } = {}) {
  if ((qualityBlockers || []).length) return 'blocked';
  const limitations = evidence?.limitations || [];
  if (!evidence?.item_id || !titleProposal.proposed_title) return 'high';
  if (limitations.includes('cached_title_missing')) return 'high';
  if (limitations.includes('listing_details_cache_missing_for_sku')) return 'medium';
  if (limitations.includes('cached_description_missing') || limitations.includes('cached_item_specifics_missing')) return 'low';
  return 'low';
}

function phase13ScoreCandidate({ signalSummary, evidence, titleProposal, qualityBlockers, baseExclusions, sourceType } = {}) {
  let score = 0;
  if (sourceType === 'opportunity') score += 5;
  if (signalSummary.has_listing_quality_low) score += 40;
  if (evidence?.item_id) score += 25;
  if (titleProposal.proposed_title) score += 20;
  if (titleProposal.title_changed_by_rule) score += 10;
  if ((evidence?.source_tables || []).includes('listing_details')) score += 8;
  if ((evidence?.source_tables || []).includes('ebay_products')) score += 5;
  if (Array.isArray(evidence?.limitations) && evidence.limitations.length) score -= Math.min(20, evidence.limitations.length * 4);
  score -= (qualityBlockers || []).length * 20;
  score -= (baseExclusions || []).length * 100;
  return score;
}

async function buildPhase13CandidateFromSource({ sourceType, request = null, opportunity = null, marketplaceEventsByRequest, marketplaceExecutedItemIds } = {}) {
  const metadata = opportunity?.metadata || {};
  const sku = firstNonEmpty(request?.sku, metadata.sku, request?.metadata?.sku);
  const evidence = await loadCachedEbayListingEvidence({ sku });
  const signalSummary = collectCandidateSignalSummary({ opportunity, request });
  const titleProposal = deterministicTitleImprovement(evidence?.title);
  const baseExclusions = phase13CandidateBaseExclusions({ request, opportunity, evidence, marketplaceEventsByRequest, marketplaceExecutedItemIds });
  const qualityBlockers = phase13CandidateQualityBlockers({ request, opportunity, evidence, signalSummary, titleProposal });
  const riskLevel = phase13RiskLevel({ evidence, titleProposal, qualityBlockers });
  const score = phase13ScoreCandidate({ signalSummary, evidence, titleProposal, qualityBlockers, baseExclusions, sourceType });
  const itemId = firstNonEmpty(evidence?.item_id, request?.metadata?.item_id, request?.metadata?.listing_id, metadata.item_id, metadata.listing_id, metadata.ebay_item_id);
  const selectable = baseExclusions.length === 0 && qualityBlockers.length === 0 && riskLevel === 'low';

  return {
    source_type: sourceType,
    score,
    selectable,
    request_id: request?.id || null,
    opportunity_id: opportunity?.id || request?.opportunity_id || null,
    opportunity_status: opportunity?.status || null,
    request_status: request?.status || null,
    sku: sku || null,
    item_id: itemId || null,
    listing_id: itemId || null,
    signal_summary: signalSummary,
    proposed_mutation_fields: titleProposal.proposed_title ? ['title'] : [],
    proposed_mutation_preview: titleProposal.proposed_title ? {
      title: titleProposal.proposed_title,
      description: null,
      item_specifics: {},
      title_improvement_only: true,
      rule: titleProposal.rule,
    } : null,
    forbidden_field_check: {
      forbidden_fields_present: false,
      forbidden_fields: [],
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_end_create_relist: false,
      sku_remapping: false,
    },
    evidence_summary: {
      cached_internal_data_only: true,
      source_tables: evidence?.source_tables || [],
      title_present: Boolean(evidence?.title),
      description_present: Boolean(evidence?.description),
      item_specifics_count: Object.keys(evidence?.item_specifics || {}).length,
      rollback_snapshot_available: Boolean(itemId && titleProposal.current_title),
      limitations: evidence?.limitations || [],
      live_marketplace_state_fetched: false,
      ebay_api_call_made: false,
    },
    risk_level: riskLevel,
    exclusion_blockers: baseExclusions,
    candidate_blockers: qualityBlockers,
    reason_selected: selectable
      ? 'listing_quality_low candidate with cached eBay item id, title-only deterministic mutation preview, no forbidden fields, and low rollback risk'
      : null,
    reason_not_selected: selectable ? null : [...baseExclusions, ...qualityBlockers].join(', '),
    recommended_next_action: selectable
      ? `Run read-only target review/operator packet preview for SKU ${sku}; do not create packet or approval until operator reviews the title proposal.`
      : 'No action until blockers are resolved; do not create packet or execute marketplace write.',
  };
}

async function selectNextEbayListingQualityCandidate({ limit = 10 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, intOrNull(limit) || 10));
  const db = getClient();
  const [requestsResult, opportunitiesResult, eventsResult] = await Promise.all([
    db.from(REQUEST_TABLE).select('*').order('id', { ascending: false }).limit(200),
    db.from(OPPORTUNITY_TABLE).select('*').order('id', { ascending: false }).limit(200),
    db.from(EVENT_TABLE).select('id,request_id,event_type,payload,created_at').in('event_type', MARKETPLACE_EXECUTION_EVENT_TYPES).order('id', { ascending: false }).limit(500),
  ]);
  if (requestsResult.error) throw requestsResult.error;
  if (opportunitiesResult.error) throw opportunitiesResult.error;
  if (eventsResult.error) throw eventsResult.error;

  const requests = requestsResult.data || [];
  const opportunities = opportunitiesResult.data || [];
  const events = eventsResult.data || [];
  const marketplaceEventsByRequest = new Map();
  for (const event of events) {
    const id = intOrNull(event.request_id);
    if (id == null) continue;
    if (!marketplaceEventsByRequest.has(id)) marketplaceEventsByRequest.set(id, []);
    marketplaceEventsByRequest.get(id).push(event);
  }
  const completedEvents = events.filter(event => event.event_type === 'marketplace_execution_completed');
  const marketplaceExecutedItemIds = candidateEventItemIds(completedEvents);

  const opportunityById = new Map(opportunities.map(row => [row.id, row]));
  const sources = [];
  for (const request of requests) {
    if (request.id === 1) continue;
    const opportunity = opportunityById.get(request.opportunity_id) || null;
    sources.push({ sourceType: 'request', request, opportunity });
  }
  const requestOpportunityIds = new Set(requests.map(row => row.opportunity_id).filter(v => v != null));
  for (const opportunity of opportunities) {
    const metadata = opportunity.metadata || {};
    if (requestOpportunityIds.has(opportunity.id)) continue;
    if (metadata.hermes_generated !== true) continue;
    if (opportunity.opportunity_type !== 'listing_quality_review' && metadata.candidate_type !== 'listing_quality_review') continue;
    sources.push({ sourceType: 'opportunity', request: null, opportunity });
  }

  const allCandidates = [];
  for (const source of sources) {
    allCandidates.push(await buildPhase13CandidateFromSource({
      ...source,
      marketplaceEventsByRequest,
      marketplaceExecutedItemIds,
    }));
  }
  allCandidates.sort((a, b) => b.score - a.score || String(a.sku || '').localeCompare(String(b.sku || '')));
  const selectableCandidates = allCandidates.filter(candidate => candidate.selectable);
  const rankedCandidates = selectableCandidates.slice(0, safeLimit).map((candidate, index) => ({ rank: index + 1, ...candidate }));
  const blockedCandidates = allCandidates.filter(candidate => !candidate.selectable).slice(0, safeLimit).map((candidate, index) => ({ rank_if_unblocked: index + 1, ...candidate }));

  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    limit: safeLimit,
    scanned: {
      request_count: requests.length,
      opportunity_count: opportunities.length,
      source_count: sources.length,
      marketplace_execution_event_count: events.length,
      completed_marketplace_item_ids: [...marketplaceExecutedItemIds].sort(),
    },
    exclusions: {
      excluded_packet_ids: [1],
      excluded_request_ids: [1],
      excluded_item_ids: ['202551129453'],
      executed_requests_excluded: true,
      execution_result_requests_excluded: true,
      previous_marketplace_execution_completed_items_excluded: true,
    },
    ranked_candidates: rankedCandidates,
    blocked_or_excluded_candidates: blockedCandidates,
    selected_candidate: rankedCandidates[0] || null,
    recommended_next_action: rankedCandidates[0]
      ? 'Review the selected candidate, then create a new read-only operator packet preview in a later phase. Do not execute marketplace writes in Phase 13A.'
      : 'No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13a_controlled_expansion_candidate_selector_v1',
  };
}

async function callEbayListingQualityLiveTransportBoundary({ packetId, dryRun = true, writeRequested = false, liveEnabled = false } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const payload = buildEbayListingQualityRevisePayload({ packet, request, intent });
  const ebayApiModulePath = resolveExistingEbayApiModulePath();
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });
  const previousMarketplaceExecutionEventCount = await countMarketplaceExecutionEvents(request.id);
  const liveAttempt = dryRun === false && writeRequested === true && liveEnabled === true;

  if (liveAttempt) {
    const phase12IBlockers = buildPhase12ILiveExecutionBlockers({
      packet,
      request,
      payload,
      rollbackSnapshot,
      previousMarketplaceExecutionEventCount,
    });
    if (phase12IBlockers.length) {
      return {
        packet_id: packet.id,
        request_id: request.id,
        target_item_id: packet.item_id || null,
        blocked: true,
        blockers: phase12IBlockers,
        phase_12i_hard_abort: true,
        actual_ebay_call: false,
        actual_network_call: false,
        actual_database_write: false,
        marketplace_write_performed: false,
        payload_summary: payload.payload_summary,
        safety: {
          actual_ebay_call: false,
          actual_network_call: false,
          actual_database_write: false,
          marketplace_write_performed: false,
          price_changes: false,
          inventory_changes: false,
        },
        source: 'phase_12i_hard_safety_abort',
      };
    }
  }

  const result = await callEbayListingQualityLiveTransport({
    packet,
    request,
    payload,
    dryRun: dryRun !== false,
    writeRequested: writeRequested === true,
    liveEnabled: liveEnabled === true,
    ebayApiModulePath,
  });
  const base = {
    ...result,
    previous_marketplace_execution_event_count_before_call: previousMarketplaceExecutionEventCount,
    existing_ebay_api_module_path: ebayApiModulePath ? 'src/api/ebayAPI.js' : null,
    existing_ebay_api_module_export_detected: Boolean(ebayApiModulePath),
    existing_ebay_api_auth_logic_reused: Boolean(ebayApiModulePath),
    new_auth_logic_created: false,
  };

  if (!liveAttempt || result.blocked || result.actual_ebay_call !== true) return base;

  const persistence = await persistEbayListingQualityLiveExecutionResult({
    packet,
    request,
    payload,
    transportResult: result,
  });

  return {
    ...base,
    actual_database_write: true,
    execution_recorded: persistence.execution_recorded,
    execution_success: persistence.execution_success,
    event: persistence.event,
    executed_at: persistence.executed_at,
    execution_result_updated: persistence.execution_result_updated,
    executed_at_updated: persistence.executed_at_updated,
    execution_result: persistence.execution_result,
    persistence_note: persistence.note,
    safety: {
      ...(base.safety || {}),
      database_writes: true,
      execution_result_updated: persistence.execution_result_updated,
      executed_at_updated: persistence.executed_at_updated,
      price_changes: false,
      inventory_changes: false,
    },
  };
}

async function buildEbayListingQualityLiveReadiness({ packetId } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const payload = buildEbayListingQualityRevisePayload({ packet, request, intent });
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });
  const boundary = callEbayListingQualityRevise({
    packet,
    request,
    payload,
    dryRun: true,
    liveEnabled: false,
    writeRequested: false,
  });
  const db = getClient();
  const executionEventTypes = [
    'request_executed',
    'execution_started',
    'execution_completed',
    'execution_failed',
    'marketplace_execution_started',
    'marketplace_execution_completed',
    'marketplace_execution_failed',
  ];
  const { count: previousMarketplaceExecutionEventCount, error: executionEventsError } = await db
    .from(EVENT_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('request_id', request.id)
    .in('event_type', executionEventTypes);
  if (executionEventsError) throw executionEventsError;

  const envPresence = Object.fromEntries([
    EBAY_LIVE_ENABLE_ENV_NAME,
    ...EBAY_LIVE_CREDENTIAL_ENV_NAMES,
    ...EBAY_LIVE_OPTIONAL_ENV_NAMES,
  ].map(name => [name, Boolean(process.env[name])]));
  const missingCredentialEnvNames = EBAY_LIVE_CREDENTIAL_ENV_NAMES.filter(name => !envPresence[name]);
  const liveEnabled = String(process.env[EBAY_LIVE_ENABLE_ENV_NAME] || '').toLowerCase() === 'true';
  const credentialsPresent = missingCredentialEnvNames.length === 0;
  const responseParserExists = typeof parseEbayReviseFixedPriceItemResponse === 'function';
  const liveCallBoundaryExists = typeof callEbayListingQualityRevise === 'function';
  const payloadBuilds = Boolean(payload && payload.payload && payload.target_item_id && !payload.blockers?.includes('target_item_id_missing'));
  const payloadOnlyAllowedFields = payload?.payload_summary?.forbidden_fields_present === false
    && Array.isArray(payload?.payload_summary?.non_allowed_fields)
    && payload.payload_summary.non_allowed_fields.length === 0;
  const rollbackSnapshotExists = rollbackSnapshot?.available === true;
  const noPreviousMarketplaceExecutionEvent = (previousMarketplaceExecutionEventCount || 0) === 0;

  const missingRequirements = [];
  if (!packet) missingRequirements.push('packet_missing');
  if (packet?.status !== 'packet_recorded') missingRequirements.push('packet_status_not_packet_recorded');
  if (packet?.confirmation_status !== 'confirmed') missingRequirements.push('packet_confirmation_status_not_confirmed');
  if (request?.final_approval_status !== 'approved') missingRequirements.push('request_final_approval_not_approved');
  if (!packet?.item_id) missingRequirements.push('target_item_id_missing');
  if (!payloadBuilds) missingRequirements.push('payload_build_failed');
  if (!payloadOnlyAllowedFields) missingRequirements.push('payload_forbidden_or_non_allowed_fields_present');
  if (!rollbackSnapshotExists) missingRequirements.push('rollback_snapshot_missing');
  if (!responseParserExists) missingRequirements.push('response_parser_missing');
  if (!liveCallBoundaryExists) missingRequirements.push('live_call_boundary_missing');
  if (request?.executed_at != null) missingRequirements.push('request_executed_at_present');
  if (request?.execution_result != null) missingRequirements.push('request_execution_result_present');
  if (!noPreviousMarketplaceExecutionEvent) missingRequirements.push('previous_marketplace_execution_event_exists');
  if (!liveEnabled) missingRequirements.push('live_ebay_execution_disabled');
  if (!credentialsPresent) missingRequirements.push('ebay_credentials_missing');

  const dryRunRequirements = missingRequirements.filter(name => ![
    'live_ebay_execution_disabled',
    'ebay_credentials_missing',
  ].includes(name));

  return {
    packet_id: packet.id,
    request_id: request.id,
    ready_for_live_execution: missingRequirements.length === 0,
    ready_for_dry_run: dryRunRequirements.length === 0,
    live_enabled: liveEnabled,
    credentials_present: credentialsPresent,
    missing_requirements: missingRequirements,
    dry_run_missing_requirements: dryRunRequirements,
    checks: {
      packet_exists: Boolean(packet),
      packet_status: packet?.status || null,
      confirmation_status: packet?.confirmation_status || null,
      request_final_approval_status: request?.final_approval_status || 'not_requested',
      target_item_id_exists: Boolean(packet?.item_id),
      payload_builds: payloadBuilds,
      payload_only_allowed_fields: payloadOnlyAllowedFields,
      payload_forbidden_fields_present: payload?.payload_summary?.forbidden_fields_present === true,
      rollback_snapshot_exists: rollbackSnapshotExists,
      response_parser_exists: responseParserExists,
      live_call_boundary_exists: liveCallBoundaryExists,
      request_executed_at_is_null: request?.executed_at == null,
      request_execution_result_is_null: request?.execution_result == null,
      no_previous_marketplace_execution_event: noPreviousMarketplaceExecutionEvent,
      previous_marketplace_execution_event_count: previousMarketplaceExecutionEventCount || 0,
    },
    environment: {
      checked_names_only: true,
      live_enable_env_name: EBAY_LIVE_ENABLE_ENV_NAME,
      live_enable_env_present: envPresence[EBAY_LIVE_ENABLE_ENV_NAME],
      credential_env_presence: Object.fromEntries(EBAY_LIVE_CREDENTIAL_ENV_NAMES.map(name => [name, envPresence[name]])),
      optional_env_presence: Object.fromEntries(EBAY_LIVE_OPTIONAL_ENV_NAMES.map(name => [name, envPresence[name]])),
      missing_credential_env_names: missingCredentialEnvNames,
      values_printed: false,
    },
    target_item_id: packet?.item_id || null,
    payload_summary: payload?.payload_summary || null,
    boundary_summary: {
      ready_for_live_call: boundary.ready_for_live_call,
      would_call_ebay: boundary.would_call_ebay,
      actual_ebay_call: false,
      actual_network_call: false,
      actual_database_write: false,
      blockers: boundary.blockers || [],
    },
    safety: {
      actual_ebay_call: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      executed_at_updated: false,
      execution_result_updated: false,
      secrets_printed: false,
      read_only: true,
    },
    source: 'phase_12f_ebay_live_readiness_preflight_v1',
  };
}



async function buildEbayListingQualityLiveRunbook({ packetId } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const payload = buildEbayListingQualityRevisePayload({ packet, request, intent });
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });
  const readiness = await buildEbayListingQualityLiveReadiness({ packetId });
  const db = getClient();
  const marketplaceExecutionEventTypes = [
    'request_executed',
    'execution_started',
    'execution_completed',
    'execution_failed',
    'marketplace_execution_started',
    'marketplace_execution_completed',
    'marketplace_execution_failed',
  ];
  const { count: previousMarketplaceExecutionEventCount, error: eventCountError } = await db
    .from(EVENT_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('request_id', request.id)
    .in('event_type', marketplaceExecutionEventTypes);
  if (eventCountError) throw eventCountError;

  const credentialEnvPresence = readiness.environment?.credential_env_presence || Object.fromEntries(
    EBAY_LIVE_CREDENTIAL_ENV_NAMES.map(name => [name, Boolean(process.env[name])])
  );
  const optionalEnvPresence = readiness.environment?.optional_env_presence || Object.fromEntries(
    EBAY_LIVE_OPTIONAL_ENV_NAMES.map(name => [name, Boolean(process.env[name])])
  );

  return {
    packet_id: packet.id,
    request_id: request.id,
    target_item_id: packet.item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    current_approval_status: {
      request_status: request.status || null,
      final_approval_status: request.final_approval_status || 'not_requested',
      final_approval_actor: request.final_approval_actor || null,
      final_approved_at: request.final_approved_at || null,
    },
    confirmation_status: {
      packet_status: packet.status || null,
      confirmation_status: packet.confirmation_status || null,
      confirmed_by_actor: packet.confirmed_by_actor || null,
      confirmed_at: packet.confirmed_at || null,
      packet_hash: packet.packet_hash || null,
    },
    payload_summary: payload.payload_summary,
    rollback_snapshot_summary: {
      available: rollbackSnapshot?.available === true,
      title_present: Boolean(rollbackSnapshot?.title),
      description_present: Boolean(rollbackSnapshot?.description),
      item_specifics_present: Object.keys(rollbackSnapshot?.item_specifics || {}).length > 0,
      item_specifics_count: Object.keys(rollbackSnapshot?.item_specifics || {}).length,
      source: rollbackSnapshot?.source || null,
      source_fields: rollbackSnapshot?.source_fields || null,
      packet_hash: rollbackSnapshot?.packet_hash || packet.packet_hash || null,
      confirmation_snapshot_reference_present: Boolean(rollbackSnapshot?.confirmation_snapshot_reference),
      confirmation_snapshot_reference: rollbackSnapshot?.confirmation_snapshot_reference || null,
    },
    live_readiness_summary: {
      ready_for_live_execution: readiness.ready_for_live_execution,
      ready_for_dry_run: readiness.ready_for_dry_run,
      live_enabled: readiness.live_enabled,
      missing_requirements: readiness.missing_requirements || [],
      dry_run_missing_requirements: readiness.dry_run_missing_requirements || [],
      checks: readiness.checks || {},
    },
    credential_presence_summary: {
      checked_names_only: true,
      live_enable_env_name: EBAY_LIVE_ENABLE_ENV_NAME,
      live_enable_env_present: readiness.environment?.live_enable_env_present === true,
      credential_env_presence: credentialEnvPresence,
      optional_env_presence: optionalEnvPresence,
      missing_credential_env_names: readiness.environment?.missing_credential_env_names || [],
      values_printed: false,
    },
    previous_execution_status: {
      request_executed_at_is_null: request.executed_at == null,
      request_execution_result_is_null: request.execution_result == null,
      external_action_executed: request.metadata?.external_action_executed === true,
      marketplace_execution_approved: request.metadata?.marketplace_execution_approved === true,
      previous_marketplace_execution_event_count: previousMarketplaceExecutionEventCount || 0,
      no_previous_marketplace_execution_event: (previousMarketplaceExecutionEventCount || 0) === 0,
      marketplace_execution_complete: false,
    },
    operator_commands: {
      dry_run: `npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=${packet.id} --dry-run`,
      disabled_write_test: `npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=${packet.id} --write`,
      live_command_do_not_run_unless_operator_approves: `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=${packet.id} --write`,
      live_command_warning: 'DO NOT RUN UNLESS OPERATOR APPROVES. This command is intentionally documented only; Phase 12H does not execute live marketplace changes.',
      post_execution_verification: [
        `npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=${packet.id}`,
        `npm run hermes:agent -- execution-detail --id=${request.id}`,
      ],
    },
    safety: {
      read_only: true,
      actual_ebay_call: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      executed_at_updated: false,
      execution_result_updated: false,
      marketplace_execution_complete_marked: false,
      secrets_printed: false,
    },
    phase_warning: 'Phase 12H is a runbook/checklist only. It does not execute live marketplace changes.',
    source: 'phase_12h_ebay_live_execution_runbook_v1',
  };
}

async function callEbayListingQualityBoundary({ packetId, dryRun = true, liveEnabled = false, writeRequested = false } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const payload = buildEbayListingQualityRevisePayload({ packet, request, intent });
  return callEbayListingQualityRevise({
    packet,
    request,
    payload,
    dryRun: dryRun !== false,
    liveEnabled: liveEnabled === true,
    writeRequested: writeRequested === true,
  });
}



async function mockCallEbayListingQualityPacket({ packetId, scenario = 'success', dryRun = true } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const payload = buildEbayListingQualityRevisePayload({ packet, request, intent });
  const mockResult = mockCallEbayListingQualityRevise({ packet, request, payload, scenario });
  const eventPayload = {
    ...mockResult,
    internal_validation_only: true,
    actual_ebay_call: false,
    mock_transport: true,
    marketplace_write_performed: false,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      recorded: false,
      ...mockResult,
      event_preview: {
        request_id: request.id,
        event_type: 'ebay_listing_quality_mock_call_validated',
        actor: 'system',
        payload: eventPayload,
      },
    };
  }

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'ebay_listing_quality_mock_call_validated',
    actor: 'system',
    payload: eventPayload,
  });

  return {
    dry_run: false,
    recorded: true,
    ...mockResult,
    actual_database_write: true,
    safety: {
      ...(mockResult.safety || {}),
      database_writes: true,
      actual_ebay_call: false,
      mock_transport: true,
      marketplace_write_performed: false,
      execution_result_updated: false,
      executed_at_updated: false,
    },
    event,
  };
}

async function executeEbayListingQualityPacket({ packetId, dryRun = true } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({
    packet,
    request,
    dryRun: dryRun !== false,
  });
  const adapterResult = await executeEbayListingQualityRevision(intent, { dryRun: dryRun !== false });

  return {
    ...adapterResult,
    packet_id: packet.id,
    request_id: request.id,
    target_marketplace: 'ebay',
    target_item_id: intent.target.item_id,
    target_listing_id: intent.target.listing_id,
    confirmation_status: packet.confirmation_status || null,
    approval_status: request.final_approval_status || 'not_requested',
    request_safety: requestSafetySummary(request),
  };
}



async function recordEbayListingQualityExecutionResult({ packetId, dryRun = true } = {}) {
  const packet = await getEbayListingQualityPacket({ packetId });
  const request = await getExecutionRequest({ requestId: packet.request_id });
  const intent = buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const blockers = [...(intent.blockers || [])];
  const executionStatus = blockers.length ? 'blocked' : (dryRun === false ? 'dry_run_recorded' : 'ready_to_execute');
  const resultRecord = buildEbayListingQualityResultRecord({
    packet,
    request,
    intent,
    executionMode: dryRun === false ? 'internal_record_only' : 'dry_run',
    executionStatus,
    marketplaceResponse: dryRun === false ? { simulated_preview: true, actual_ebay_call: false } : null,
    error: blockers.length ? { blockers } : null,
  });
  const safety = {
    actual_ebay_call: false,
    marketplace_api_calls: false,
    ebay_api_calls: false,
    marketplace_write_performed: false,
    live_execution_performed: false,
    listing_changed: false,
    price_changes: false,
    inventory_changes: false,
    execution_result_updated: false,
    executed_at_updated: false,
    external_action_executed: false,
    marketplace_execution_approved: false,
    database_writes: dryRun === false,
  };

  if (blockers.length) {
    if (dryRun === false) throw new Error(`eBay listing quality result recording blocked: ${blockers.join(', ')}`);
    return {
      dry_run: true,
      recorded: false,
      blocked: true,
      blockers,
      result_record: resultRecord,
      event_preview: null,
      safety,
    };
  }

  const eventPayload = {
    ...resultRecord,
    safety,
  };

  if (dryRun !== false) {
    return {
      dry_run: true,
      recorded: false,
      blocked: false,
      result_record: resultRecord,
      event_preview: {
        request_id: request.id,
        event_type: 'ebay_listing_quality_execution_result_recorded',
        actor: 'system',
        payload: eventPayload,
      },
      safety,
    };
  }

  const event = await recordExecutionEvent({
    requestId: request.id,
    eventType: 'ebay_listing_quality_execution_result_recorded',
    actor: 'system',
    payload: eventPayload,
  });

  return {
    dry_run: false,
    recorded: true,
    blocked: false,
    result_record: resultRecord,
    event,
    safety,
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
  const [opportunity, events, executorPreflight, internalExecutionRecords, marketplacePreflight, marketplacePreflightRecords, ebayListingQualityDryRun, ebayListingQualityTargetReview, ebayListingQualityExecutionPacket, operatorEbayListingQualityPacket, ebayListingQualityPackets] = await Promise.all([
    getOpportunitySnapshot(request.opportunity_id),
    listExecutionEvents({ requestId: request.id, limit: 100 }),
    buildExecutorPreflight({ requestId: request.id }),
    listInternalExecutionRecords({ requestId: request.id, limit: 50 }),
    buildMarketplacePreflight({ requestId: request.id, marketplace: 'ebay', operation: 'listing_quality_update' }),
    listMarketplacePreflightRecords({ requestId: request.id, limit: 50 }),
    buildEbayListingQualityDryRun({ requestId: request.id }),
    buildEbayListingQualityTargetReview({ requestId: request.id }),
    buildEbayListingQualityExecutionPacket({ requestId: request.id }),
    buildOperatorEbayListingQualityPacket({ requestId: request.id }),
    listEbayListingQualityPackets({ requestId: request.id, limit: 50 }),
  ]);

  return {
    request,
    opportunity_snapshot: opportunity,
    events,
    safety_summary: requestSafetySummary(request),
    readiness_summary: readinessFromRequest(request),
    final_approval_checklist: finalApprovalChecklistFromRequest(request),
    final_approval_summary: finalApprovalSummary(request),
    executor_preflight: executorPreflight,
    internal_execution_records: internalExecutionRecords,
    marketplace_preflight: marketplacePreflight,
    marketplace_preflight_records: marketplacePreflightRecords,
    ebay_listing_quality_dry_run: ebayListingQualityDryRun,
    ebay_listing_quality_target_review: ebayListingQualityTargetReview,
    ebay_listing_quality_execution_packet: ebayListingQualityExecutionPacket,
    operator_ebay_listing_quality_packet: operatorEbayListingQualityPacket,
    ebay_listing_quality_packets: ebayListingQualityPackets,
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

  const { data: internalTaskRecords, count: internalTaskRecordedCount, error: internalTaskRecordsError } = await db
    .from(INTERNAL_EXECUTION_RECORD_TABLE)
    .select('*', { count: 'exact' })
    .eq('status', 'internal_task_recorded')
    .limit(Math.min(20, safeLimit));
  const internalTaskRecordsMissing = isMissingTableError(internalTaskRecordsError);
  if (internalTaskRecordsError && !internalTaskRecordsMissing) throw internalTaskRecordsError;

  const { data: marketplacePreflightRecords, error: marketplacePreflightRecordsError } = await db
    .from(MARKETPLACE_PREFLIGHT_RECORD_TABLE)
    .select('*')
    .order('id', { ascending: false })
    .limit(Math.min(20, safeLimit));
  const marketplacePreflightRecordsMissing = isMissingTableError(marketplacePreflightRecordsError);
  if (marketplacePreflightRecordsError && !marketplacePreflightRecordsMissing) throw marketplacePreflightRecordsError;
  const marketplacePreflightRows = marketplacePreflightRecordsMissing ? [] : (marketplacePreflightRecords || []);

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
    internal_task_recorded_count: internalTaskRecordsMissing ? 0 : (internalTaskRecordedCount || 0),
    internal_execution_records_migration_required: internalTaskRecordsMissing,
    recent_internal_task_records: internalTaskRecordsMissing ? [] : (internalTaskRecords || []),
    marketplace_preflight_passed_count: marketplacePreflightRows.filter(r => r.status === 'preflight_passed').length,
    marketplace_preflight_failed_count: marketplacePreflightRows.filter(r => r.status === 'preflight_failed').length,
    marketplace_preflight_migration_required: marketplacePreflightRecordsMissing,
    recent_marketplace_preflight_records: marketplacePreflightRows,
    latest_events_sample: latestEvents || [],
    safety_summary: {
      external_actions_detected: rows.filter(r => r.metadata?.external_action_executed === true).length,
      marketplace_execution_approved_count: rows.filter(r => r.metadata?.marketplace_execution_approved === true).length,
      final_approval_approved_count: rows.filter(r => r.final_approval_status === 'approved').length,
      internal_task_recorded_count: internalTaskRecordsMissing ? 0 : (internalTaskRecordedCount || 0),
      marketplace_preflight_passed_count: marketplacePreflightRows.filter(r => r.status === 'preflight_passed').length,
      marketplace_preflight_failed_count: marketplacePreflightRows.filter(r => r.status === 'preflight_failed').length,
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
  buildExecutorPreflight,
  listInternalExecutionRecords,
  recordInternalManualReviewTask,
  buildMarketplacePreflight,
  listMarketplacePreflightRecords,
  recordMarketplacePreflight,
  buildEbayListingQualityDryRun,
  buildEbayListingQualityTargetReview,
  buildEbayListingQualityExecutionPacket,
  buildOperatorEbayListingQualityPacket,
  listEbayListingQualityPackets,
  recordEbayListingQualityPacket,
  getEbayListingQualityPacket,
  confirmEbayListingQualityPacket,
  buildEbayListingQualityPayload,
  buildEbayListingQualityLiveReadiness,
  buildEbayListingQualityLiveRunbook,
  selectNextEbayListingQualityCandidate,
  callEbayListingQualityLiveTransportBoundary,
  callEbayListingQualityBoundary,
  mockCallEbayListingQualityPacket,
  executeEbayListingQualityPacket,
  recordEbayListingQualityExecutionResult,
  reviewExecutionRequest,
  listExecutionEvents,
  recordExecutionEvent,
};
