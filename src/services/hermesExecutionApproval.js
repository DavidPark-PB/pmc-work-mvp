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

function collectDescriptionCandidates(raw = {}) {
  if (!raw || typeof raw !== 'object') return [];
  const candidates = [
    raw.description,
    raw.Description,
    raw.item_description,
    raw.ItemDescription,
    raw?.item?.description,
    raw?.Item?.Description,
  ]
    .filter(value => value != null)
    .map(value => String(value).trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

function stripHtmlDescription(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDescriptionAudit(raw = {}) {
  const candidates = collectDescriptionCandidates(raw);
  const rawDescriptionText = candidates.sort((a, b) => b.length - a.length)[0] || '';
  const normalizedDescription = String(rawDescriptionText || '').replace(/\s+/g, ' ').trim();
  const htmlStrippedDescription = stripHtmlDescription(rawDescriptionText);
  const visibleText = htmlStrippedDescription || normalizedDescription;
  return {
    raw_description_length: rawDescriptionText.length,
    normalized_description_length: normalizedDescription.length,
    html_stripped_description_length: htmlStrippedDescription.length,
    visible_text_length: visibleText.length,
    raw_description: rawDescriptionText || null,
    normalized_description: normalizedDescription || null,
    html_stripped_description: htmlStrippedDescription || null,
    visible_text: visibleText || null,
    candidate_count: candidates.length,
  };
}

function rawDescription(raw = {}) {
  const audit = buildDescriptionAudit(raw);
  return audit.visible_text || audit.normalized_description || audit.raw_description || null;
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
      already_cached_items_excluded_by_missing_evidence_plan: true,
      previous_marketplace_execution_completed_items_excluded: true,
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
      get_item_called: false,
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


function phase14AExecutedRequestItemIds(requests = []) {
  const ids = new Set();
  for (const request of requests || []) {
    if (request?.executed_at == null && request?.execution_result == null) continue;
    for (const value of [
      request?.sku,
      request?.metadata?.item_id,
      request?.metadata?.listing_id,
      request?.metadata?.target_item_id,
      request?.requested_action?.target_item_id,
      request?.execution_result?.target_item_id,
      request?.execution_result?.payload?.Item?.ItemID,
      request?.execution_result?.parsed_response?.item_id,
    ]) {
      if (value != null && String(value).trim()) ids.add(String(value).trim());
    }
  }
  return ids;
}

function classifyPhase14AControlledExpansionCandidate({ candidate, executedItemIds, executedRequestIds } = {}) {
  const blockers = [...(candidate.exclusion_blockers || []), ...(candidate.candidate_blockers || [])];
  const itemId = candidate.item_id ? String(candidate.item_id) : null;
  const requestId = intOrNull(candidate.request_id);
  const evidence = candidate.evidence_summary || {};
  const signalSummary = candidate.signal_summary || {};
  const missingEvidence = [];
  if (evidence.title_present !== true) missingEvidence.push('cached_title');
  if (evidence.description_present !== true) missingEvidence.push('cached_description');
  if (!Number.isFinite(evidence.item_specifics_count) || evidence.item_specifics_count <= 0) missingEvidence.push('cached_item_specifics');
  if (!Array.isArray(evidence.source_tables) || !evidence.source_tables.includes('listing_details')) missingEvidence.push('listing_details');
  const insufficientEvidence = missingEvidence.length > 0 || (evidence.limitations || []).length > 0;
  const alreadyExecuted = Boolean(
    (itemId && executedItemIds.has(itemId))
    || (requestId != null && executedRequestIds.has(requestId))
    || blockers.some(name => /executed|marketplace_execution_completed|202551129453|206315990948|request_id_1|phase_12_source/.test(String(name)))
  );
  const missingItemId = !itemId || blockers.includes('valid_ebay_item_id_missing');
  const noListingQualitySignal = signalSummary.has_listing_quality_low !== true || blockers.includes('listing_quality_low_signal_missing');
  const priceOrInventoryRelated = signalSummary.has_price_pressure === true
    || signalSummary.has_inventory_pressure === true
    || candidate.forbidden_field_check?.price_changes === true
    || candidate.forbidden_field_check?.inventory_changes === true
    || candidate.forbidden_field_check?.quantity_changes === true
    || blockers.some(name => /price|inventory|stock|quantity|dead_stock|no_recent_sales/.test(String(name)));

  let classification = 'ready_for_cached_evidence_review';
  if (alreadyExecuted) classification = 'blocked_already_executed';
  else if (missingItemId) classification = 'blocked_missing_item_id';
  else if (priceOrInventoryRelated) classification = 'blocked_price_or_inventory_related';
  else if (noListingQualitySignal) classification = 'blocked_no_listing_quality_signal';
  else if (insufficientEvidence && signalSummary.has_listing_quality_low === true) classification = 'needs_evidence_refresh';
  else if (insufficientEvidence) classification = 'blocked_insufficient_cached_evidence';

  const recommendedActionByClassification = {
    ready_for_cached_evidence_review: 'Review cached listing-quality evidence only; do not create packet, approval, execution request, or marketplace write in Phase 14A.',
    needs_evidence_refresh: 'Run a later explicit read-only cached evidence refresh/review phase before any packet preview work.',
    blocked_already_executed: 'Exclude from this expansion cycle; do not reuse prior request/packet/approval/live execution records.',
    blocked_missing_item_id: 'Resolve cached eBay item_id/listing_id in a future read-only discovery phase before reconsidering.',
    blocked_no_listing_quality_signal: 'Leave unselected until a listing_quality_low signal/recommendation appears from cached analysis.',
    blocked_price_or_inventory_related: 'Leave unselected for listing-quality expansion because price/inventory/stock signals are outside Phase 14A scope.',
    blocked_insufficient_cached_evidence: 'Refresh or complete cached evidence in a future read-only phase before reconsidering.',
  };

  return {
    ...candidate,
    classification,
    blockers,
    missing_evidence_fields: missingEvidence,
    excluded_from_actionable_plan: classification !== 'ready_for_cached_evidence_review' && classification !== 'needs_evidence_refresh',
    recommended_next_safe_action: recommendedActionByClassification[classification],
  };
}

async function buildEbayListingQualityControlledExpansionPlan({ limit = 50 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 50));
  const { requests, opportunities, events, sources, candidates, marketplaceExecutedItemIds } = await buildPhase13CandidateSources({ limit: Math.max(safeLimit, 50) });
  const hardExcludedItemIds = new Set(['202551129453', '206315990948']);
  const completedEvents = events.filter(event => event.event_type === 'marketplace_execution_completed');
  const completedItemIds = candidateEventItemIds(completedEvents);
  const executedRequestIds = new Set((requests || [])
    .filter(request => request.executed_at != null || request.execution_result != null)
    .map(request => request.id)
    .filter(id => id != null));
  const executedRequestItemIds = phase14AExecutedRequestItemIds(requests);
  const executedItemIds = new Set([
    ...hardExcludedItemIds,
    ...marketplaceExecutedItemIds,
    ...completedItemIds,
    ...executedRequestItemIds,
  ].map(value => String(value)));

  const classifiedCandidates = candidates
    .map(candidate => classifyPhase14AControlledExpansionCandidate({ candidate, executedItemIds, executedRequestIds }))
    .sort((a, b) => {
      const order = [
        'ready_for_cached_evidence_review',
        'needs_evidence_refresh',
        'blocked_already_executed',
        'blocked_missing_item_id',
        'blocked_no_listing_quality_signal',
        'blocked_price_or_inventory_related',
        'blocked_insufficient_cached_evidence',
      ];
      return order.indexOf(a.classification) - order.indexOf(b.classification) || b.score - a.score || String(a.sku || '').localeCompare(String(b.sku || ''));
    });
  const rows = classifiedCandidates.slice(0, safeLimit).map((candidate, index) => ({
    row: index + 1,
    classification: candidate.classification,
    source_type: candidate.source_type,
    request_id: candidate.request_id,
    opportunity_id: candidate.opportunity_id,
    sku: candidate.sku,
    item_id: candidate.item_id,
    listing_id: candidate.listing_id,
    opportunity_status: candidate.opportunity_status,
    request_status: candidate.request_status,
    score: candidate.score,
    signal_summary: candidate.signal_summary,
    proposed_mutation_fields: candidate.proposed_mutation_fields || [],
    evidence_summary: candidate.evidence_summary,
    missing_evidence_fields: candidate.missing_evidence_fields,
    blockers: candidate.blockers,
    recommended_next_safe_action: candidate.recommended_next_safe_action,
  }));
  const classificationCounts = rows.reduce((acc, row) => {
    acc[row.classification] = (acc[row.classification] || 0) + 1;
    return acc;
  }, {});

  return {
    read_only: true,
    phase: '14A',
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    limit: safeLimit,
    scanned_counts: {
      request_count: requests.length,
      opportunity_count: opportunities.length,
      source_count: sources.length,
      candidate_count: candidates.length,
      returned_candidate_count: rows.length,
      marketplace_execution_event_count: events.length,
      marketplace_execution_completed_event_count: completedEvents.length,
      executed_request_count: executedRequestIds.size,
      classification_counts: classificationCounts,
    },
    excluded_executed_item_ids: [...executedItemIds].sort(),
    exclusion_policy: {
      hard_excluded_item_ids: [...hardExcludedItemIds].sort(),
      any_marketplace_execution_completed_event_excluded: true,
      any_request_with_executed_at_excluded: true,
      any_request_with_execution_result_excluded: true,
      do_not_reuse_request_ids: [4],
      do_not_reuse_packet_ids: [3],
    },
    candidate_rows: rows,
    blockers: [...new Set(rows.flatMap(row => row.blockers || []))].sort(),
    recommended_next_safe_action: rows.some(row => row.classification === 'ready_for_cached_evidence_review')
      ? 'Review ready cached evidence candidates only. Phase 14A must not create packets, approvals, execution requests, or marketplace writes.'
      : rows.some(row => row.classification === 'needs_evidence_refresh')
        ? 'Run a later explicit read-only cached evidence refresh/review phase for needs_evidence_refresh rows; do not create packets or approvals yet.'
        : 'No actionable Phase 14A candidate is ready. Start the next expansion from a fresh candidate cycle and keep executed items excluded.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      database_write_performed: false,
      marketplace_write_performed: false,
      packet_created: false,
      approval_created: false,
      execution_request_created: false,
      execution_state_changed: false,
      ai_calls: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
    },
    source: 'phase_14a_controlled_expansion_plan_v1',
  };
}


function phase14BSignalsFromContext(context = {}) {
  return phase13SignalDominance(context?.signals || []);
}

function classifyPhase14BFreshCandidateSource({ source, executedItemIds, executedRequestIds } = {}) {
  const blockers = [];
  const itemId = source.item_id ? String(source.item_id) : null;
  const requestId = intOrNull(source.request_id);
  const signalSummary = source.signal_summary || {};
  const evidenceGaps = source.evidence_gaps || [];
  const sourceType = source.source_type;

  if (itemId && executedItemIds.has(itemId)) blockers.push('item_already_executed_or_hard_excluded');
  if (requestId != null && executedRequestIds.has(requestId)) blockers.push('request_already_executed_or_result_present');
  if (requestId === 4) blockers.push('request_id_4_excluded');
  if (source.packet_id === 3) blockers.push('packet_id_3_excluded');
  if (source.approval_id === 15) blockers.push('approval_id_15_excluded');
  if (!itemId) blockers.push('item_id_missing');
  if (signalSummary.price_inventory_signals_dominate === true || (signalSummary.price_signal_types || []).length || (signalSummary.inventory_signal_types || []).length) {
    blockers.push('price_or_inventory_signal_present');
  }
  if (signalSummary.listing_quality_low !== true) blockers.push('listing_quality_signal_missing');
  if (evidenceGaps.length) blockers.push('cached_evidence_incomplete');
  if (source.opportunity_status && !['new', 'reviewing', 'approved'].includes(source.opportunity_status)) blockers.push(`opportunity_status_${source.opportunity_status}_not_active`);
  if (source.request_status && ['cancelled', 'rejected', 'failed', 'executed'].includes(source.request_status)) blockers.push(`request_status_${source.request_status}_not_selectable`);

  let classification = 'candidate_source_ready_for_evidence_review';
  if (blockers.some(name => /already_executed|hard_excluded|request_id_4|packet_id_3|approval_id_15/.test(name))) {
    classification = 'candidate_source_already_executed';
  } else if (!itemId) {
    classification = 'candidate_source_missing_item_id';
  } else if (blockers.includes('price_or_inventory_signal_present')) {
    classification = 'candidate_source_price_or_inventory_related';
  } else if (signalSummary.listing_quality_low !== true) {
    classification = 'candidate_source_missing_listing_quality_signal';
  } else if (evidenceGaps.length) {
    classification = 'candidate_source_needs_evidence_refresh';
  } else if (!source.sku || !source.title_present) {
    classification = 'candidate_source_insufficient_data';
  }

  const recommended = {
    candidate_source_ready_for_evidence_review: 'Review cached listing-quality evidence only; do not create an opportunity, packet, approval, execution request, or marketplace write in Phase 14B.',
    candidate_source_needs_evidence_refresh: 'Consider a later explicit read-only evidence refresh phase; do not call GetItem in Phase 14B.',
    candidate_source_missing_item_id: 'Resolve item_id from internal/local data in a future read-only discovery phase before reconsidering.',
    candidate_source_missing_listing_quality_signal: 'Leave unselected until cached/context signals show listing_quality_low.',
    candidate_source_already_executed: 'Exclude from the fresh candidate cycle; do not reuse prior live execution records.',
    candidate_source_price_or_inventory_related: 'Leave unselected for listing-quality expansion because price/inventory/stock signals are outside Phase 14B scope.',
    candidate_source_insufficient_data: 'Collect/complete internal cached data in a future read-only phase before reconsidering.',
  };

  return {
    ...source,
    classification,
    blockers: [...new Set(blockers)].sort(),
    recommended_next_safe_action: recommended[classification],
  };
}

async function buildEbayListingQualityFreshCandidateSourcePlan({ limit = 100 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 100));
  const db = getClient();
  const [requestsResult, opportunitiesResult, eventsResult, activeRows] = await Promise.all([
    db.from(REQUEST_TABLE).select('*').order('id', { ascending: false }).limit(Math.max(safeLimit, 100)),
    db.from(OPPORTUNITY_TABLE).select('*').order('id', { ascending: false }).limit(Math.max(safeLimit, 100)),
    db.from(EVENT_TABLE).select('id,request_id,event_type,payload,created_at').in('event_type', MARKETPLACE_EXECUTION_EVENT_TYPES).order('id', { ascending: false }).limit(500),
    loadPhase13ActiveEbayListingRows({ limit: safeLimit }),
  ]);
  if (requestsResult.error) throw requestsResult.error;
  if (opportunitiesResult.error) throw opportunitiesResult.error;
  if (eventsResult.error) throw eventsResult.error;

  const requests = requestsResult.data || [];
  const opportunities = opportunitiesResult.data || [];
  const events = eventsResult.data || [];
  const completedEvents = events.filter(event => event.event_type === 'marketplace_execution_completed');
  const hardExcludedItemIds = new Set(['202551129453', '206315990948']);
  const executedRequestIds = new Set(requests
    .filter(request => request.executed_at != null || request.execution_result != null || request.id === 4)
    .map(request => request.id)
    .filter(id => id != null));
  const executedItemIds = new Set([
    ...hardExcludedItemIds,
    ...candidateEventItemIds(completedEvents),
    ...phase14AExecutedRequestItemIds(requests),
  ].map(value => String(value)));

  const sourceRows = [];
  const seenSourceKeys = new Set();
  const pushSource = source => {
    const key = `${source.source_type}:${source.request_id || ''}:${source.opportunity_id || ''}:${source.sku || ''}:${source.item_id || ''}`;
    if (seenSourceKeys.has(key)) return;
    seenSourceKeys.add(key);
    sourceRows.push(source);
  };

  for (const request of requests) {
    const evidence = await loadCachedEbayListingEvidence({ sku: request.sku });
    const itemId = firstNonEmpty(evidence.item_id, request?.metadata?.item_id, request?.metadata?.listing_id, request?.metadata?.target_item_id, request?.requested_action?.target_item_id, request?.execution_result?.target_item_id);
    const signalSummary = phase13SignalDominance([
      ...(request?.metadata?.source_signals || []),
      ...(request?.requested_action?.source_signals || []),
      ...(request?.requested_action?.action_plan?.source_signals || []),
    ]);
    pushSource({
      source_type: 'execution_request',
      request_id: request.id,
      opportunity_id: request.opportunity_id || null,
      sku: request.sku || null,
      item_id: itemId || null,
      listing_id: itemId || null,
      request_status: request.status || null,
      opportunity_status: null,
      title_present: Boolean(evidence.title),
      source_tables: evidence.source_tables || [],
      signal_summary: signalSummary,
      evidence_gaps: evidenceRefreshMissingFields(evidence),
      evidence_summary: {
        cached_internal_data_only: true,
        title_present: Boolean(evidence.title),
        description_present: Boolean(evidence.description),
        item_specifics_count: Object.keys(evidence.item_specifics || {}).length,
        image_count: (evidence.images || []).length,
        policies_present: Boolean(evidence.policies),
        limitations: evidence.limitations || [],
        live_marketplace_state_fetched: false,
        ebay_api_call_made: false,
      },
    });
  }

  for (const opportunity of opportunities) {
    const metadata = opportunity.metadata || {};
    const sku = firstNonEmpty(opportunity.sku, metadata.sku, metadata.item_id, metadata.listing_id, metadata.ebay_item_id);
    const evidence = await loadCachedEbayListingEvidence({ sku });
    const itemId = firstNonEmpty(evidence.item_id, metadata.item_id, metadata.listing_id, metadata.ebay_item_id);
    const signalSummary = phase13SignalDominance([
      ...(metadata.source_signals || []),
      ...(opportunity.source_signals || []),
    ]);
    const recommendationTypes = normalizeSignalTypes([...(metadata.source_recommendations || []), ...(opportunity.source_recommendations || [])]);
    if (recommendationTypes.includes('listing_quality_review')) signalSummary.listing_quality_low = true;
    pushSource({
      source_type: 'opportunity',
      request_id: null,
      opportunity_id: opportunity.id,
      sku: sku || null,
      item_id: itemId || null,
      listing_id: itemId || null,
      request_status: null,
      opportunity_status: opportunity.status || null,
      title_present: Boolean(evidence.title),
      source_tables: evidence.source_tables || [],
      signal_summary: signalSummary,
      evidence_gaps: evidenceRefreshMissingFields(evidence),
      evidence_summary: {
        cached_internal_data_only: true,
        title_present: Boolean(evidence.title),
        description_present: Boolean(evidence.description),
        item_specifics_count: Object.keys(evidence.item_specifics || {}).length,
        image_count: (evidence.images || []).length,
        policies_present: Boolean(evidence.policies),
        limitations: evidence.limitations || [],
        live_marketplace_state_fetched: false,
        ebay_api_call_made: false,
      },
    });
  }

  for (const row of activeRows) {
    const evidence = await loadCachedEbayListingEvidence({ sku: row.sku });
    let context = null;
    let contextError = null;
    try {
      const { buildSkuContext } = require('./skuContextBuilder');
      context = await buildSkuContext({ sku: row.sku, readOnly: true, skipConnector: true });
    } catch (e) {
      contextError = e.message;
    }
    const signalSummary = phase14BSignalsFromContext(context || {});
    const itemId = firstNonEmpty(evidence.item_id, row.item_id);
    pushSource({
      source_type: row.source_table === 'listing_details' ? 'cached_listing_detail' : 'cached_product_listing',
      request_id: null,
      opportunity_id: null,
      sku: row.sku || null,
      item_id: itemId || null,
      listing_id: itemId || null,
      request_status: null,
      opportunity_status: null,
      listing_status: row.status || null,
      title_present: Boolean(evidence.title || row.title),
      source_tables: evidence.source_tables || [row.source_table].filter(Boolean),
      signal_summary: signalSummary,
      evidence_gaps: evidenceRefreshMissingFields(evidence),
      evidence_summary: {
        cached_internal_data_only: true,
        title_present: Boolean(evidence.title || row.title),
        description_present: Boolean(evidence.description),
        item_specifics_count: Object.keys(evidence.item_specifics || {}).length,
        image_count: (evidence.images || []).length,
        policies_present: Boolean(evidence.policies),
        limitations: evidence.limitations || [],
        context_error: contextError,
        live_marketplace_state_fetched: false,
        ebay_api_call_made: false,
      },
    });
  }

  const classified = sourceRows
    .map(source => classifyPhase14BFreshCandidateSource({ source, executedItemIds, executedRequestIds }))
    .sort((a, b) => {
      const order = [
        'candidate_source_ready_for_evidence_review',
        'candidate_source_needs_evidence_refresh',
        'candidate_source_missing_item_id',
        'candidate_source_missing_listing_quality_signal',
        'candidate_source_price_or_inventory_related',
        'candidate_source_insufficient_data',
        'candidate_source_already_executed',
      ];
      return order.indexOf(a.classification) - order.indexOf(b.classification) || String(a.sku || '').localeCompare(String(b.sku || ''));
    });
  const candidateSourceRows = classified.slice(0, safeLimit).map((source, index) => ({
    row: index + 1,
    classification: source.classification,
    source_type: source.source_type,
    request_id: source.request_id,
    opportunity_id: source.opportunity_id,
    sku: source.sku,
    item_id: source.item_id,
    listing_id: source.listing_id,
    request_status: source.request_status,
    opportunity_status: source.opportunity_status,
    listing_status: source.listing_status || null,
    source_tables: source.source_tables || [],
    signal_summary: source.signal_summary,
    evidence_gaps: source.evidence_gaps,
    evidence_summary: source.evidence_summary,
    blockers: source.blockers,
    recommended_next_safe_action: source.recommended_next_safe_action,
  }));
  const countBy = (rows, field) => rows.reduce((acc, row) => {
    const key = row[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    read_only: true,
    phase: '14B',
    marketplace: 'ebay',
    operation: 'listing_quality_fresh_candidate_source_plan',
    limit: safeLimit,
    scanned_counts_by_source_type: countBy(sourceRows, 'source_type'),
    returned_counts_by_source_type: countBy(candidateSourceRows, 'source_type'),
    scanned_counts: {
      request_count: requests.length,
      opportunity_count: opportunities.length,
      cached_listing_row_count: activeRows.length,
      raw_source_count: sourceRows.length,
      returned_source_count: candidateSourceRows.length,
      marketplace_execution_event_count: events.length,
      marketplace_execution_completed_event_count: completedEvents.length,
      executed_request_count: executedRequestIds.size,
      classification_counts: countBy(classified, 'classification'),
      returned_classification_counts: countBy(candidateSourceRows, 'classification'),
    },
    excluded_executed_item_ids: [...executedItemIds].sort(),
    excluded_records: {
      request_ids: [4, ...[...executedRequestIds].filter(id => id !== 4)].sort((a, b) => a - b),
      packet_ids: [3],
      approval_ids: [15],
      any_marketplace_execution_completed_event_excluded: true,
      any_request_with_executed_at_excluded: true,
      any_request_with_execution_result_excluded: true,
    },
    candidate_source_rows: candidateSourceRows,
    evidence_gaps: [...new Set(candidateSourceRows.flatMap(row => row.evidence_gaps || []))].sort(),
    blockers: [...new Set(candidateSourceRows.flatMap(row => row.blockers || []))].sort(),
    recommended_next_safe_action: candidateSourceRows.some(row => row.classification === 'candidate_source_ready_for_evidence_review')
      ? 'Review ready candidate sources using cached evidence only; do not create opportunities, packets, approvals, execution requests, live candidates, or marketplace writes in Phase 14B.'
      : candidateSourceRows.some(row => row.classification === 'candidate_source_needs_evidence_refresh')
        ? 'Plan a later explicitly approved read-only evidence refresh phase. Do not call GetItem in Phase 14B.'
        : 'No fresh candidate source is actionable. Continue read-only internal discovery and keep executed items excluded.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      marketplace_api_call: false,
      ai_calls: false,
      actual_network_call: false,
      actual_database_write: false,
      database_write_performed: false,
      marketplace_write_performed: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_request_created: false,
      live_candidate_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
    },
    source: 'phase_14b_fresh_candidate_source_plan_v1',
  };
}


function phase14CSpecificValue(itemSpecifics = {}, names = []) {
  const normalized = {};
  for (const [key, value] of Object.entries(itemSpecifics || {})) {
    normalized[String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
  }
  for (const name of names) {
    const found = normalized[String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (Array.isArray(found) ? found.length : Boolean(String(found || '').trim())) return found;
  }
  return null;
}

function buildPhase14CListingQualityIssueSignals({ title, evidence } = {}) {
  const itemSpecifics = evidence?.item_specifics || {};
  const titleText = String(title || evidence?.title || '').trim();
  const imageCount = (evidence?.images || []).length;
  const signals = [];
  if (titleText && titleText.length < 40) signals.push({ type: 'title_too_short', value: { title_length: titleText.length, threshold: 40 } });
  if (titleText && titleText.length > 80) signals.push({ type: 'title_too_long', value: { title_length: titleText.length, threshold: 80 } });
  if (!phase14CSpecificValue(itemSpecifics, ['Brand'])) signals.push({ type: 'missing_brand_specific', value: { required_specific: 'Brand' } });
  if (!phase14CSpecificValue(itemSpecifics, ['Type', 'Product Type', 'Item Type'])) signals.push({ type: 'missing_type_specific', value: { required_specific: 'Type' } });
  if (!phase14CSpecificValue(itemSpecifics, ['Country/Region of Manufacture', 'Country of Origin', 'Country', 'CountryRegionOfManufacture'])) {
    signals.push({ type: 'missing_country_specific', value: { required_specific: 'Country/Region of Manufacture' } });
  }
  const itemSpecificsCount = Object.keys(itemSpecifics).length;
  if (itemSpecificsCount > 0 && itemSpecificsCount < 4) signals.push({ type: 'item_specifics_sparse', value: { item_specifics_count: itemSpecificsCount, threshold: 4 } });
  if (!evidence?.description) signals.push({ type: 'description_missing', value: { description_present: false } });
  if (imageCount < 2) signals.push({ type: 'image_count_low', value: { image_count: imageCount, threshold: 2 } });
  return signals;
}

function classifyPhase14CSeed({ seed, executedItemIds, executedRequestIds } = {}) {
  const blockers = [];
  const itemId = seed.item_id ? String(seed.item_id) : null;
  const signalSummary = seed.signal_summary || {};
  const evidenceGaps = seed.evidence_gaps || [];
  if (itemId && executedItemIds.has(itemId)) blockers.push('item_already_executed_or_hard_excluded');
  if (seed.request_id != null && executedRequestIds.has(seed.request_id)) blockers.push('request_already_executed_or_result_present');
  if (seed.request_id === 4) blockers.push('request_id_4_excluded');
  if (seed.packet_id === 3) blockers.push('packet_id_3_excluded');
  if (seed.approval_id === 15) blockers.push('approval_id_15_excluded');
  if (!itemId) blockers.push('item_id_missing');
  if (!seed.title_present) blockers.push('title_missing');
  if (signalSummary.price_inventory_signals_dominate === true || (signalSummary.price_signal_types || []).length || (signalSummary.inventory_signal_types || []).length) {
    blockers.push('price_or_inventory_signal_present');
  }

  let classification = 'seed_ready_for_listing_quality_scoring';
  if (blockers.some(name => /already_executed|hard_excluded|request_id_4|packet_id_3|approval_id_15/.test(name))) {
    classification = 'seed_blocked_already_executed';
  } else if (blockers.includes('price_or_inventory_signal_present')) {
    classification = 'seed_blocked_price_inventory_related';
  } else if (!itemId) {
    classification = 'seed_missing_item_id';
  } else if (!seed.title_present) {
    classification = 'seed_missing_title';
  } else if (!seed.issue_signals.length) {
    classification = 'seed_no_listing_quality_issue';
  } else if (evidenceGaps.includes('listing_details') || evidenceGaps.includes('cached_item_specifics')) {
    classification = 'seed_needs_cached_evidence';
  }

  const recommended = {
    seed_ready_for_listing_quality_scoring: 'Use this row only for a later read-only listing-quality scoring/review phase; do not create opportunities in Phase 14C.',
    seed_needs_cached_evidence: 'Complete cached evidence in a later explicitly authorized read-only evidence phase; do not call GetItem in Phase 14C.',
    seed_missing_item_id: 'Resolve item_id from internal/local data before scoring.',
    seed_missing_title: 'Resolve cached title from internal/local data before scoring.',
    seed_no_listing_quality_issue: 'Leave unselected; deterministic listing-quality issue signals are absent.',
    seed_blocked_already_executed: 'Exclude from Phase 14 fresh expansion; do not reuse executed items or live execution records.',
    seed_blocked_price_inventory_related: 'Leave unselected for listing-quality seed preview because price/inventory/stock signals dominate.',
  };

  return {
    ...seed,
    classification,
    blockers: [...new Set(blockers)].sort(),
    recommended_next_safe_action: recommended[classification],
  };
}

async function buildEbayListingQualityCandidateSeedPreview({ limit = 100 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 100));
  const db = getClient();
  const [requestsResult, eventsResult, activeRows] = await Promise.all([
    db.from(REQUEST_TABLE).select('*').order('id', { ascending: false }).limit(Math.max(safeLimit, 100)),
    db.from(EVENT_TABLE).select('id,request_id,event_type,payload,created_at').in('event_type', MARKETPLACE_EXECUTION_EVENT_TYPES).order('id', { ascending: false }).limit(500),
    loadPhase13ActiveEbayListingRows({ limit: safeLimit }),
  ]);
  if (requestsResult.error) throw requestsResult.error;
  if (eventsResult.error) throw eventsResult.error;

  const requests = requestsResult.data || [];
  const events = eventsResult.data || [];
  const completedEvents = events.filter(event => event.event_type === 'marketplace_execution_completed');
  const hardExcludedItemIds = new Set(['202551129453', '206315990948']);
  const executedRequestIds = new Set(requests
    .filter(request => request.executed_at != null || request.execution_result != null || request.id === 4)
    .map(request => request.id)
    .filter(id => id != null));
  const executedItemIds = new Set([
    ...hardExcludedItemIds,
    ...candidateEventItemIds(completedEvents),
    ...phase14AExecutedRequestItemIds(requests),
  ].map(value => String(value)));

  const seeds = [];
  const seen = new Set();
  for (const row of activeRows) {
    const evidence = await loadCachedEbayListingEvidence({ sku: row.sku });
    let context = null;
    let contextError = null;
    try {
      const { buildSkuContext } = require('./skuContextBuilder');
      context = await buildSkuContext({ sku: row.sku, readOnly: true, skipConnector: true });
    } catch (e) {
      contextError = e.message;
    }
    const itemId = firstNonEmpty(evidence.item_id, row.item_id);
    const title = firstNonEmpty(evidence.title, row.title);
    const signalSummary = phase14BSignalsFromContext(context || {});
    const issueSignals = buildPhase14CListingQualityIssueSignals({ title, evidence });
    const key = `${row.sku || ''}:${itemId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push(classifyPhase14CSeed({
      seed: {
        source_type: row.source_table === 'listing_details' ? 'cached_listing_detail' : 'cached_product_listing',
        sku: row.sku || null,
        item_id: itemId || null,
        listing_id: itemId || null,
        title: title || null,
        title_present: Boolean(title),
        title_length: String(title || '').trim().length,
        listing_status: row.status || null,
        source_tables: evidence.source_tables || [row.source_table].filter(Boolean),
        signal_summary: signalSummary,
        issue_signals: issueSignals,
        issue_signal_types: issueSignals.map(signal => signal.type),
        evidence_gaps: evidenceRefreshMissingFields(evidence),
        evidence_summary: {
          cached_internal_data_only: true,
          title_present: Boolean(title),
          description_present: Boolean(evidence.description),
          item_specifics_count: Object.keys(evidence.item_specifics || {}).length,
          image_count: (evidence.images || []).length,
          policies_present: Boolean(evidence.policies),
          limitations: evidence.limitations || [],
          context_error: contextError,
          live_marketplace_state_fetched: false,
          ebay_api_call_made: false,
        },
      },
      executedItemIds,
      executedRequestIds,
    }));
  }

  const order = [
    'seed_ready_for_listing_quality_scoring',
    'seed_needs_cached_evidence',
    'seed_missing_item_id',
    'seed_missing_title',
    'seed_no_listing_quality_issue',
    'seed_blocked_price_inventory_related',
    'seed_blocked_already_executed',
  ];
  const sorted = seeds.sort((a, b) => order.indexOf(a.classification) - order.indexOf(b.classification) || String(a.sku || '').localeCompare(String(b.sku || '')));
  const seedRows = sorted.slice(0, safeLimit).map((seed, index) => ({
    row: index + 1,
    classification: seed.classification,
    source_type: seed.source_type,
    sku: seed.sku,
    item_id: seed.item_id,
    listing_id: seed.listing_id,
    title: seed.title,
    title_length: seed.title_length,
    listing_status: seed.listing_status,
    source_tables: seed.source_tables,
    issue_signals: seed.issue_signals,
    issue_signal_types: seed.issue_signal_types,
    signal_summary: seed.signal_summary,
    evidence_gaps: seed.evidence_gaps,
    evidence_summary: seed.evidence_summary,
    blockers: seed.blockers,
    recommended_next_safe_action: seed.recommended_next_safe_action,
  }));
  const countBy = (rows, field) => rows.reduce((acc, row) => {
    const key = row[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    read_only: true,
    phase: '14C',
    marketplace: 'ebay',
    operation: 'listing_quality_candidate_seed_preview',
    limit: safeLimit,
    scanned_counts: {
      cached_listing_row_count: activeRows.length,
      seed_count: seeds.length,
      returned_seed_count: seedRows.length,
      marketplace_execution_event_count: events.length,
      marketplace_execution_completed_event_count: completedEvents.length,
      executed_request_count: executedRequestIds.size,
      classification_counts: countBy(seeds, 'classification'),
      returned_classification_counts: countBy(seedRows, 'classification'),
      source_type_counts: countBy(seeds, 'source_type'),
    },
    excluded_executed_item_ids: [...executedItemIds].sort(),
    excluded_records: {
      request_ids: [4, ...[...executedRequestIds].filter(id => id !== 4)].sort((a, b) => a - b),
      packet_ids: [3],
      approval_ids: [15],
      any_marketplace_execution_completed_event_excluded: true,
      any_request_with_executed_at_excluded: true,
      any_request_with_execution_result_excluded: true,
    },
    seed_rows: seedRows,
    issue_signals: [...new Set(seedRows.flatMap(row => row.issue_signal_types || []))].sort(),
    blockers: [...new Set(seedRows.flatMap(row => row.blockers || []))].sort(),
    recommended_next_safe_action: seedRows.some(row => row.classification === 'seed_ready_for_listing_quality_scoring')
      ? 'Use ready seed rows only for a later read-only listing-quality scoring phase. Do not create opportunities, packets, approvals, execution requests, live candidates, DB writes, or marketplace writes in Phase 14C.'
      : seedRows.some(row => row.classification === 'seed_needs_cached_evidence')
        ? 'Plan a later explicitly approved read-only cached-evidence completion phase. Do not call GetItem in Phase 14C.'
        : 'No seed row is ready for listing-quality scoring. Continue read-only internal discovery and keep executed items excluded.',
    safety: {
      read_only: true,
      preview_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      marketplace_api_call: false,
      ai_calls: false,
      actual_network_call: false,
      actual_database_write: false,
      database_write_performed: false,
      marketplace_write_performed: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_request_created: false,
      live_candidate_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
    },
    source: 'phase_14c_candidate_seed_preview_v1',
  };
}


function phase14DPriceInventoryStockSignalTypes(signalSummary = {}) {
  const types = normalizeSignalTypes([
    ...(signalSummary.signal_types || []),
    ...(signalSummary.price_signal_types || []),
    ...(signalSummary.inventory_signal_types || []),
  ]);
  return types.filter(type => [
    'competitor_lower_price',
    'price_attack',
    'stock_risk',
    'dead_stock',
    'no_recent_sales',
    'missing_cost',
  ].includes(type));
}

function phase14DProposedSafeListingMutationFields(issueSignalTypes = []) {
  const fields = new Set();
  if (issueSignalTypes.some(type => ['title_too_short', 'title_too_long'].includes(type))) fields.add('title');
  if (issueSignalTypes.includes('description_missing')) fields.add('description');
  if (issueSignalTypes.some(type => ['missing_brand_specific', 'missing_type_specific', 'missing_country_specific', 'item_specifics_sparse'].includes(type))) fields.add('item_specifics');
  return [...fields];
}

function classifyPhase14DSeedDominance(row = {}) {
  const issueSignalTypes = normalizeSignalTypes(row.issue_signal_types || []);
  const priceInventoryStockSignalTypes = phase14DPriceInventoryStockSignalTypes(row.signal_summary || {});
  const proposedSafeListingMutationFields = phase14DProposedSafeListingMutationFields(issueSignalTypes);
  const forbiddenMutationFields = [];
  const hardBlockerFields = ['price', 'quantity', 'inventory', 'stock', 'end_listing', 'create_listing', 'relist', 'shipping', 'payment', 'returns'];
  for (const field of proposedSafeListingMutationFields) {
    if (hardBlockerFields.includes(field)) forbiddenMutationFields.push(field);
  }

  const blockers = [];
  const warnings = [];
  if (row.classification === 'seed_blocked_already_executed' || (row.blockers || []).includes('item_already_executed_or_hard_excluded')) blockers.push('already_executed_or_hard_excluded');
  if ((row.evidence_gaps || []).some(gap => ['cached_item_id', 'cached_title', 'listing_details', 'cached_item_specifics'].includes(gap))) blockers.push('insufficient_listing_evidence');
  if (forbiddenMutationFields.length) blockers.push('forbidden_mutation_scope_would_touch_price_inventory_or_policy_fields');
  if (priceInventoryStockSignalTypes.length && issueSignalTypes.length && !forbiddenMutationFields.length) warnings.push('price_inventory_stock_context_present_but_listing_mutation_scope_is_safe');
  if (priceInventoryStockSignalTypes.length && !issueSignalTypes.length) blockers.push('price_inventory_stock_context_without_listing_quality_issue');
  if (!issueSignalTypes.length) warnings.push('deterministic_listing_quality_issue_absent');

  let classification = 'no_listing_quality_issue';
  if (blockers.includes('already_executed_or_hard_excluded')) {
    classification = 'already_executed_excluded';
  } else if (blockers.includes('insufficient_listing_evidence')) {
    classification = 'insufficient_listing_evidence';
  } else if (!issueSignalTypes.length && priceInventoryStockSignalTypes.length) {
    classification = 'price_inventory_dominant_no_listing_action';
  } else if (!issueSignalTypes.length) {
    classification = 'no_listing_quality_issue';
  } else if (priceInventoryStockSignalTypes.length) {
    classification = 'listing_quality_issue_with_price_inventory_context';
  } else {
    classification = 'listing_quality_only_possible';
  }

  const recommended = {
    listing_quality_only_possible: 'Eligible only for a later read-only listing-quality scoring preview; do not create opportunities in Phase 14D.',
    listing_quality_issue_with_price_inventory_context: 'Keep price/inventory/stock signals as context warnings because proposed scope is title/description/item_specifics only; proceed only to later read-only listing-quality scoring, not opportunity creation.',
    price_inventory_dominant_no_listing_action: 'Do not use for listing-quality action; price/inventory/stock context dominates and no deterministic listing-quality issue is present.',
    insufficient_listing_evidence: 'Complete internal cached listing evidence in a later explicit read-only phase; do not call GetItem in Phase 14D.',
    already_executed_excluded: 'Exclude from Phase 14 expansion; do not reuse executed items, request_id=4, packet_id=3, or approval_id=15.',
    no_listing_quality_issue: 'Leave unselected; no deterministic listing-quality issue signal was found.',
  };

  return {
    sku: row.sku,
    item_id: row.item_id,
    title: row.title,
    listing_quality_issue_signals: issueSignalTypes,
    price_inventory_stock_signal_types: priceInventoryStockSignalTypes,
    evidence_gaps: row.evidence_gaps || [],
    proposed_safe_listing_mutation_fields: proposedSafeListingMutationFields,
    mutation_scope: {
      safe_listing_fields_only: proposedSafeListingMutationFields.every(field => ['title', 'description', 'item_specifics'].includes(field)),
      forbidden_mutation_fields: forbiddenMutationFields,
      would_affect_price_quantity_inventory_stock: forbiddenMutationFields.some(field => ['price', 'quantity', 'inventory', 'stock'].includes(field)),
      would_affect_end_create_relist: forbiddenMutationFields.some(field => ['end_listing', 'create_listing', 'relist'].includes(field)),
      would_affect_shipping_payment_returns: forbiddenMutationFields.some(field => ['shipping', 'payment', 'returns'].includes(field)),
    },
    blockers: [...new Set(blockers)].sort(),
    warnings: [...new Set(warnings)].sort(),
    blocker_vs_warning: {
      hard_blockers: [...new Set(blockers)].sort(),
      context_warnings: [...new Set(warnings)].sort(),
      price_inventory_stock_signals_are_hard_blockers: forbiddenMutationFields.length > 0,
      price_inventory_stock_signals_are_context_warnings: priceInventoryStockSignalTypes.length > 0 && issueSignalTypes.length > 0 && forbiddenMutationFields.length === 0,
    },
    classification,
    recommended_next_safe_action: recommended[classification],
  };
}

async function buildEbayListingQualitySeedSignalDominanceAudit({ limit = 100 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 100));
  const seedPreview = await buildEbayListingQualityCandidateSeedPreview({ limit: safeLimit });
  const auditedRows = (seedPreview.seed_rows || []).slice(0, safeLimit).map((row, index) => ({
    row: index + 1,
    ...classifyPhase14DSeedDominance(row),
  }));
  const countBy = (rows, field) => rows.reduce((acc, row) => {
    const key = row[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    read_only: true,
    phase: '14D',
    marketplace: 'ebay',
    operation: 'listing_quality_seed_signal_dominance_audit',
    limit: safeLimit,
    source_seed_preview: {
      phase: seedPreview.phase,
      operation: seedPreview.operation,
      seed_count: seedPreview.scanned_counts?.seed_count || 0,
      returned_seed_count: seedPreview.scanned_counts?.returned_seed_count || 0,
      source: seedPreview.source,
    },
    scanned_counts: {
      audited_seed_count: auditedRows.length,
      classification_counts: countBy(auditedRows, 'classification'),
      rows_with_listing_quality_issues: auditedRows.filter(row => row.listing_quality_issue_signals.length > 0).length,
      rows_with_price_inventory_stock_context: auditedRows.filter(row => row.price_inventory_stock_signal_types.length > 0).length,
      rows_with_context_warnings: auditedRows.filter(row => row.warnings.length > 0).length,
      rows_with_hard_blockers: auditedRows.filter(row => row.blockers.length > 0).length,
    },
    excluded_executed_item_ids: seedPreview.excluded_executed_item_ids || [],
    excluded_records: seedPreview.excluded_records || {
      request_ids: [4],
      packet_ids: [3],
      approval_ids: [15],
    },
    audit_rows: auditedRows,
    blockers: [...new Set(auditedRows.flatMap(row => row.blockers || []))].sort(),
    warnings: [...new Set(auditedRows.flatMap(row => row.warnings || []))].sort(),
    recommended_next_safe_action: auditedRows.some(row => row.classification === 'listing_quality_issue_with_price_inventory_context' || row.classification === 'listing_quality_only_possible')
      ? 'Use audit rows only for a later read-only listing-quality scoring preview. Treat price/inventory/stock as warnings when proposed scope is title/description/item_specifics only; do not create opportunities in Phase 14D.'
      : 'No seed row is ready for listing-quality action. Continue read-only internal discovery and preserve executed-item exclusions.',
    safety: {
      read_only: true,
      audit_preview_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      marketplace_api_call: false,
      ai_calls: false,
      actual_network_call: false,
      actual_database_write: false,
      database_write_performed: false,
      marketplace_write_performed: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_request_created: false,
      live_candidate_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
    },
    source: 'phase_14d_seed_signal_dominance_audit_v1',
  };
}

const PHASE14E_ALLOWED_SCORE_CLASSIFICATIONS = [
  'listing_quality_only_possible',
  'listing_quality_issue_with_price_inventory_context',
];

const PHASE14E_EXCLUDED_SCORE_CLASSIFICATIONS = [
  'already_executed_excluded',
  'insufficient_listing_evidence',
  'price_inventory_dominant_no_listing_action',
  'no_listing_quality_issue',
];

const PHASE14E_ISSUE_SEVERITY_WEIGHTS = {
  title_too_short: 15,
  title_too_long: 15,
  missing_brand_specific: 13,
  missing_type_specific: 13,
  missing_country_specific: 11,
  item_specifics_sparse: 12,
  description_missing: 14,
  image_count_low: 8,
};

function scorePhase14EListingQualityAuditRow(row = {}) {
  const issueSignals = normalizeSignalTypes(row.listing_quality_issue_signals || []);
  const warnings = [...new Set(row.warnings || [])].sort();
  const proposedFields = [...new Set(row.proposed_safe_listing_mutation_fields || [])].sort();
  const evidenceGaps = [...new Set(row.evidence_gaps || [])].sort();
  const forbiddenFields = [...new Set(row.mutation_scope?.forbidden_mutation_fields || [])].sort();
  const hardBlockers = [...new Set([
    ...(row.blockers || []),
    ...forbiddenFields.map(field => `forbidden_mutation_field_${field}`),
  ])].sort();
  const safeFieldSet = ['description', 'item_specifics', 'title'];
  const hasUnsafeProposedField = proposedFields.some(field => !safeFieldSet.includes(field));
  if (hasUnsafeProposedField) hardBlockers.push('unsafe_proposed_mutation_field');

  const issueSeverityScore = issueSignals.reduce((sum, type) => sum + (PHASE14E_ISSUE_SEVERITY_WEIGHTS[type] || 5), 0);
  const issueCountScore = issueSignals.length * 3;
  const evidenceCompletenessScore = Math.max(0, 20 - (evidenceGaps.length * 4));
  const safeMutationScopeScore = proposedFields.length > 0 && !hasUnsafeProposedField && forbiddenFields.length === 0 ? 10 + (proposedFields.length * 2) : 0;
  const priceInventoryWarningPenalty = (row.price_inventory_stock_signal_types || []).length > 0 ? 5 : 0;
  const warningPenalty = warnings.length * 2;
  const hardBlockerPenalty = hardBlockers.length > 0 ? 100 : 0;
  const rawScore = issueSeverityScore + issueCountScore + evidenceCompletenessScore + safeMutationScopeScore - priceInventoryWarningPenalty - warningPenalty - hardBlockerPenalty;
  const score = Math.max(0, rawScore);

  return {
    sku: row.sku,
    item_id: row.item_id,
    title: row.title,
    classification: row.classification,
    score,
    score_breakdown: {
      issue_signal_count: issueSignals.length,
      issue_count_score: issueCountScore,
      issue_severity_score: issueSeverityScore,
      issue_severity_weights: issueSignals.reduce((acc, type) => {
        acc[type] = PHASE14E_ISSUE_SEVERITY_WEIGHTS[type] || 5;
        return acc;
      }, {}),
      evidence_completeness_score: evidenceCompletenessScore,
      evidence_gap_count: evidenceGaps.length,
      safe_mutation_scope_score: safeMutationScopeScore,
      price_inventory_stock_warning_penalty: priceInventoryWarningPenalty,
      warning_penalty: warningPenalty,
      hard_blocker_penalty: hardBlockerPenalty,
      formula: 'issue_severity + issue_count + evidence_completeness + safe_mutation_scope - price_inventory_warning_penalty - warning_penalty - hard_blocker_penalty',
    },
    issue_signals: issueSignals,
    evidence_gaps: evidenceGaps,
    warnings,
    blockers: [...new Set(hardBlockers)].sort(),
    price_inventory_stock_signal_types: normalizeSignalTypes(row.price_inventory_stock_signal_types || []),
    proposed_safe_listing_mutation_fields: proposedFields,
    mutation_scope: {
      ...(row.mutation_scope || {}),
      allowed_listing_fields_only: proposedFields.every(field => safeFieldSet.includes(field)),
      hard_blocked_for_forbidden_scope: hardBlockers.some(blocker => /^forbidden_mutation_field_|unsafe_proposed_mutation_field/.test(blocker)),
    },
    recommended_next_safe_action: hardBlockers.length > 0
      ? 'Keep out of shortlist; row has a hard blocker or unsafe proposed mutation scope.'
      : 'Eligible for a later explicit read-only shortlist review only; do not create opportunities or execution artifacts in Phase 14E.',
  };
}

async function buildEbayListingQualitySeedScoringPreview({ limit = 100, top = 20 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 100));
  const safeTop = Math.min(safeLimit, Math.min(50, Math.max(1, intOrNull(top) || 20)));
  const audit = await buildEbayListingQualitySeedSignalDominanceAudit({ limit: safeLimit });
  const auditRows = audit.audit_rows || [];
  const eligibleRows = auditRows.filter(row => PHASE14E_ALLOWED_SCORE_CLASSIFICATIONS.includes(row.classification));
  const excludedRows = auditRows.filter(row => PHASE14E_EXCLUDED_SCORE_CLASSIFICATIONS.includes(row.classification));
  const scoredRows = eligibleRows.map(scorePhase14EListingQualityAuditRow);
  const shortlistRows = scoredRows
    .filter(row => row.blockers.length === 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((b.issue_signals || []).length !== (a.issue_signals || []).length) return (b.issue_signals || []).length - (a.issue_signals || []).length;
      return String(a.item_id || '').localeCompare(String(b.item_id || ''));
    })
    .slice(0, safeTop)
    .map((row, index) => ({ rank: index + 1, ...row }));

  const countBy = (rows, field) => rows.reduce((acc, row) => {
    const key = row[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    read_only: true,
    phase: '14E',
    marketplace: 'ebay',
    operation: 'listing_quality_seed_scoring_preview',
    limit: safeLimit,
    top: safeTop,
    source_audit: {
      phase: audit.phase,
      operation: audit.operation,
      audited_seed_count: audit.scanned_counts?.audited_seed_count || 0,
      source: audit.source,
    },
    scanned_counts: {
      audit_row_count: auditRows.length,
      eligible_for_scoring_count: eligibleRows.length,
      excluded_from_scoring_count: excludedRows.length,
      scored_row_count: scoredRows.length,
      shortlist_row_count: shortlistRows.length,
      audit_classification_counts: countBy(auditRows, 'classification'),
      scored_classification_counts: countBy(scoredRows, 'classification'),
      excluded_classification_counts: countBy(excludedRows, 'classification'),
      rows_with_price_inventory_stock_warning_context: scoredRows.filter(row => row.price_inventory_stock_signal_types.length > 0).length,
      rows_hard_blocked_for_forbidden_scope: scoredRows.filter(row => row.mutation_scope?.hard_blocked_for_forbidden_scope === true).length,
    },
    excluded_executed_item_ids: audit.excluded_executed_item_ids || [],
    excluded_records: audit.excluded_records || {
      request_ids: [4],
      packet_ids: [3],
      approval_ids: [15],
    },
    scored_row_count: scoredRows.length,
    shortlist_rows: shortlistRows,
    excluded_rows_summary: excludedRows.map(row => ({
      sku: row.sku,
      item_id: row.item_id,
      title: row.title,
      classification: row.classification,
      blockers: row.blockers || [],
      recommended_next_safe_action: row.recommended_next_safe_action,
    })),
    issue_signals: [...new Set(scoredRows.flatMap(row => row.issue_signals || []))].sort(),
    warnings: [...new Set(scoredRows.flatMap(row => row.warnings || []))].sort(),
    blockers: [...new Set(scoredRows.flatMap(row => row.blockers || []))].sort(),
    proposed_safe_listing_mutation_fields: [...new Set(shortlistRows.flatMap(row => row.proposed_safe_listing_mutation_fields || []))].sort(),
    recommended_next_safe_action: shortlistRows.length > 0
      ? 'Review shortlist rows in a later explicit read-only packet/opportunity preview phase; Phase 14E creates no opportunities, packets, approvals, requests, live candidates, DB writes, or marketplace writes.'
      : 'No rows are shortlist-ready after deterministic scoring; continue read-only evidence refinement and preserve executed-item exclusions.',
    safety: {
      read_only: true,
      scoring_preview_only: true,
      deterministic_scoring_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      marketplace_api_call: false,
      ai_calls: false,
      actual_network_call: false,
      actual_database_write: false,
      database_write_performed: false,
      marketplace_write_performed: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_request_created: false,
      live_candidate_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
    },
    source: 'phase_14e_seed_scoring_preview_v1',
  };
}




function phase13AuditBucket(candidate) {
  const blockers = [...(candidate.exclusion_blockers || []), ...(candidate.candidate_blockers || [])];
  const proposedFields = candidate.proposed_mutation_fields || [];
  const titleOnly = proposedFields.length === 1 && proposedFields[0] === 'title';
  return {
    active_opportunity: ['new', 'reviewing', 'approved'].includes(candidate.opportunity_status),
    listing_quality_low: candidate.signal_summary?.has_listing_quality_low === true,
    archived: candidate.opportunity_status === 'archived',
    missing_item_id: !candidate.item_id || blockers.includes('valid_ebay_item_id_missing'),
    missing_title_evidence: candidate.evidence_summary?.title_present !== true || blockers.includes('title_evidence_missing'),
    excluded_already_executed: blockers.some(name => /executed|marketplace_execution_completed|202551129453|request_id_1|phase_12_source/.test(String(name))),
    mutation_not_title_only: proposedFields.length > 0 && !titleOnly,
    price_inventory_present: candidate.forbidden_field_check?.price_changes === true
      || candidate.forbidden_field_check?.inventory_changes === true
      || candidate.forbidden_field_check?.quantity_changes === true
      || blockers.some(name => /price_pressure|inventory_or_stock/.test(String(name))),
  };
}

async function buildPhase13CandidateSources({ limit = 200 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, intOrNull(limit) || 200));
  const db = getClient();
  const [requestsResult, opportunitiesResult, eventsResult] = await Promise.all([
    db.from(REQUEST_TABLE).select('*').order('id', { ascending: false }).limit(safeLimit),
    db.from(OPPORTUNITY_TABLE).select('*').order('id', { ascending: false }).limit(safeLimit),
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
  const marketplaceExecutedItemIds = candidateEventItemIds(events.filter(event => event.event_type === 'marketplace_execution_completed'));
  const opportunityById = new Map(opportunities.map(row => [row.id, row]));
  const requestOpportunityIds = new Set(requests.map(row => row.opportunity_id).filter(v => v != null));
  const sources = [];

  for (const request of requests) {
    sources.push({ sourceType: 'request', request, opportunity: opportunityById.get(request.opportunity_id) || null });
  }
  for (const opportunity of opportunities) {
    const metadata = opportunity.metadata || {};
    if (requestOpportunityIds.has(opportunity.id)) continue;
    if (metadata.hermes_generated !== true) continue;
    if (opportunity.opportunity_type !== 'listing_quality_review' && metadata.candidate_type !== 'listing_quality_review') continue;
    sources.push({ sourceType: 'opportunity', request: null, opportunity });
  }

  const candidates = [];
  for (const source of sources) {
    candidates.push(await buildPhase13CandidateFromSource({
      ...source,
      marketplaceEventsByRequest,
      marketplaceExecutedItemIds,
    }));
  }

  return { requests, opportunities, events, sources, candidates, marketplaceExecutedItemIds };
}

async function auditEbayListingQualityCandidateSources({ limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const { requests, opportunities, events, candidates, marketplaceExecutedItemIds } = await buildPhase13CandidateSources({ limit: safeLimit });
  const activeStatuses = new Set(['new', 'reviewing', 'approved']);
  const activeOpportunities = opportunities.filter(row => activeStatuses.has(row.status));
  const listingQualityOpportunities = opportunities.filter(row => {
    const metadata = row.metadata || {};
    const signals = normalizeSignalTypes(metadata.source_signals || []);
    const recommendations = normalizeSignalTypes(metadata.source_recommendations || []);
    return row.opportunity_type === 'listing_quality_review'
      || metadata.candidate_type === 'listing_quality_review'
      || signals.includes('listing_quality_low')
      || recommendations.includes('listing_quality_review');
  });

  const buckets = candidates.map(candidate => ({ candidate, bucket: phase13AuditBucket(candidate) }));
  const countWhere = fn => buckets.filter(({ bucket, candidate }) => fn(bucket, candidate)).length;
  const needsRefresh = buckets
    .filter(({ bucket, candidate }) => bucket.missing_item_id || bucket.missing_title_evidence || (candidate.evidence_summary?.limitations || []).length)
    .map(({ candidate }) => ({
      sku: candidate.sku,
      opportunity_id: candidate.opportunity_id,
      request_id: candidate.request_id,
      item_id: candidate.item_id,
      limitations: candidate.evidence_summary?.limitations || [],
      recommended_refresh: candidate.item_id
        ? 'refresh cached listing_details/item_specifics/images/policies for this item before packet work'
        : 'resolve cached eBay item_id/listing_id before packet work',
    }))
    .slice(0, safeLimit);

  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    limit: safeLimit,
    totals: {
      total_active_opportunities: activeOpportunities.length,
      listing_quality_low_opportunities: listingQualityOpportunities.length,
      archived_opportunities: opportunities.filter(row => row.status === 'archived').length,
      opportunities_missing_item_id: countWhere(bucket => bucket.missing_item_id),
      opportunities_missing_title_evidence: countWhere(bucket => bucket.missing_title_evidence),
      opportunities_excluded_already_executed: countWhere(bucket => bucket.excluded_already_executed),
      opportunities_excluded_mutation_not_title_only: countWhere(bucket => bucket.mutation_not_title_only),
      opportunities_excluded_price_inventory_present: countWhere(bucket => bucket.price_inventory_present),
    },
    scanned: {
      request_count: requests.length,
      opportunity_count: opportunities.length,
      candidate_source_count: candidates.length,
      marketplace_execution_event_count: events.length,
      completed_marketplace_item_ids: [...marketplaceExecutedItemIds].sort(),
    },
    candidate_source_rows: candidates.slice(0, safeLimit).map(candidate => ({
      source_type: candidate.source_type,
      request_id: candidate.request_id,
      opportunity_id: candidate.opportunity_id,
      sku: candidate.sku,
      item_id: candidate.item_id,
      opportunity_status: candidate.opportunity_status,
      request_status: candidate.request_status,
      signals: candidate.signal_summary?.signals || [],
      proposed_mutation_fields: candidate.proposed_mutation_fields || [],
      forbidden_field_check: candidate.forbidden_field_check,
      evidence_summary: candidate.evidence_summary,
      risk_level: candidate.risk_level,
      selectable: candidate.selectable,
      blockers: [...(candidate.exclusion_blockers || []), ...(candidate.candidate_blockers || [])],
    })),
    skus_listings_that_may_need_listing_evidence_refresh: needsRefresh,
    recommended_safe_replenishment_action: listingQualityOpportunities.some(row => ['new', 'reviewing', 'approved'].includes(row.status))
      ? 'Refresh or complete cached listing evidence for active listing_quality_low opportunities; keep packet/approval creation disabled until selector returns a low-risk candidate.'
      : 'Run read-only SKU/listing context rescan to identify listing_quality_low previews, then consider a later explicit internal-only opportunity replenishment phase; do not create packets or approvals in Phase 13B.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      packet_created: false,
      approval_created: false,
      opportunity_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13b_candidate_source_audit_v1',
  };
}

async function rescanEbayListingQualityCandidates({ limit = 20, dryRun = true } = {}) {
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 20));
  const db = getClient();
  const { runOpportunityAgent } = require('../agents/opportunityAgent');
  const productRows = await safeSelectRows(
    'ebay_products',
    'sku,item_id,title,price_usd,stock,status,updated_at',
    q => q.not('sku', 'is', null).neq('sku', '').order('updated_at', { ascending: false }).limit(safeLimit * 3)
  );
  const uniqueSkus = [];
  const seen = new Set();
  for (const row of productRows) {
    const sku = trimOrNull(row.sku, 100);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    uniqueSkus.push(sku);
    if (uniqueSkus.length >= safeLimit) break;
  }

  const previews = [];
  for (const sku of uniqueSkus) {
    let opportunityResult = null;
    let error = null;
    try {
      opportunityResult = await runOpportunityAgent({ sku }, { type: 'listing_quality_review' });
    } catch (e) {
      error = e.message;
    }
    const evidence = await loadCachedEbayListingEvidence({ sku });
    const listingQualityCandidates = opportunityResult?.candidates || [];
    previews.push({
      sku,
      item_id: evidence.item_id || null,
      listing_id: evidence.item_id || null,
      title_present: Boolean(evidence.title),
      source_tables: evidence.source_tables || [],
      limitations: evidence.limitations || [],
      signal_count: opportunityResult?.context_summary?.signal_count || 0,
      recommendation_count: opportunityResult?.context_summary?.recommendation_count || 0,
      listing_quality_preview_count: listingQualityCandidates.length,
      candidate_previews: listingQualityCandidates.map(candidate => ({
        type: candidate.type,
        priority: candidate.priority,
        title: candidate.title,
        source_signals: candidate.source_signals || [],
        source_recommendations: candidate.source_recommendations || [],
        proposed_mutation_fields: ['title'],
        forbidden_field_check: {
          forbidden_fields_present: false,
          forbidden_fields: [],
          price_changes: false,
          inventory_changes: false,
          quantity_changes: false,
          listing_end_create_relist: false,
          sku_remapping: false,
        },
      })),
      error,
      recommended_next_action: listingQualityCandidates.length
        ? 'Candidate preview only: operator should review evidence; do not create opportunity, packet, approval, or marketplace write in Phase 13B.'
        : 'No listing_quality_low preview from current cached context; consider cached listing evidence refresh or leave unselected.',
    });
  }

  return {
    read_only: true,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    limit: safeLimit,
    scanned_sku_count: uniqueSkus.length,
    preview_count: previews.reduce((sum, row) => sum + row.listing_quality_preview_count, 0),
    previews,
    recommended_safe_replenishment_action: 'Use these previews only to decide whether a later explicit internal-only opportunity write phase is warranted. Phase 13B does not write opportunities, packets, approvals, execution state, or marketplace listings.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13b_candidate_rescan_preview_v1',
  };
}



function evidenceRefreshMissingFields(evidence = {}) {
  const missing = [];
  if (!evidence.item_id) missing.push('cached_item_id');
  if (!evidence.title) missing.push('cached_title');
  if (!evidence.description) missing.push('cached_description');
  if (!Object.keys(evidence.item_specifics || {}).length) missing.push('cached_item_specifics');
  if (!evidence.images || !evidence.images.length) missing.push('cached_images');
  if (!evidence.policies) missing.push('cached_policies');
  if (!(evidence.source_tables || []).includes('listing_details')) missing.push('listing_details');
  return missing;
}

function phase13SignalDominance(signals = []) {
  const types = normalizeSignalTypes((signals || []).map(signal => signal?.type || signal));
  const priceTypes = types.filter(type => ['competitor_lower_price', 'price_attack'].includes(type));
  const inventoryTypes = types.filter(type => ['stock_risk', 'dead_stock', 'no_recent_sales'].includes(type));
  const listingQualityTypes = types.filter(type => type === 'listing_quality_low');
  return {
    signal_types: types,
    listing_quality_low: listingQualityTypes.length > 0,
    price_signal_types: priceTypes,
    inventory_signal_types: inventoryTypes,
    price_inventory_signals_dominate: listingQualityTypes.length === 0 && (priceTypes.length > 0 || inventoryTypes.length > 0),
  };
}

function titleQualityEvidenceFromCachedListing(evidence = {}) {
  const title = String(evidence.title || '').trim();
  const reasons = [];
  if (!evidence.item_id) reasons.push('missing_item_id');
  if (!title) reasons.push('missing_title');
  if (title && title.length < 40) reasons.push('short_title');
  if ((evidence.limitations || []).includes('listing_details_cache_missing_for_sku')) reasons.push('listing_details_cache_missing_for_sku');
  if ((evidence.limitations || []).includes('cached_description_missing')) reasons.push('cached_description_missing');
  if ((evidence.limitations || []).includes('cached_item_specifics_missing')) reasons.push('cached_item_specifics_missing');
  return {
    title_present: Boolean(title),
    title_length: title.length,
    listing_quality_evidence_missing: reasons.length > 0,
    missing_reasons: reasons,
  };
}

async function loadPhase13ActiveEbayListingRows({ limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const products = await safeSelectRows(
    'ebay_products',
    'sku,item_id,title,price_usd,stock,status,updated_at',
    q => q.not('sku', 'is', null).neq('sku', '').order('updated_at', { ascending: false }).limit(safeLimit * 4)
  );
  const details = await safeSelectRows(
    'listing_details',
    'platform,listing_type,sku,item_id,title,listing_status,last_enriched_at',
    q => q.eq('platform', 'ebay').eq('listing_type', 'our').order('last_enriched_at', { ascending: false, nullsFirst: false }).limit(safeLimit * 4)
  );

  const rows = [];
  const seen = new Set();
  for (const row of [...products, ...details]) {
    const sku = trimOrNull(row.sku, 100) || trimOrNull(row.item_id, 100);
    const itemId = trimOrNull(row.item_id, 100);
    const key = `${sku || ''}:${itemId || ''}`;
    if (!sku || seen.has(key)) continue;
    seen.add(key);
    const status = String(row.status || row.listing_status || 'active').toLowerCase();
    if (['ended', 'deleted', 'inactive', 'sold_out'].includes(status)) continue;
    rows.push({
      sku,
      item_id: itemId,
      listing_id: itemId,
      title: row.title || null,
      status: status || 'active',
      source_table: Object.prototype.hasOwnProperty.call(row, 'price_usd') ? 'ebay_products' : 'listing_details',
      updated_at: row.updated_at || row.last_enriched_at || null,
    });
    if (rows.length >= safeLimit) break;
  }
  return rows;
}

async function marketplaceCompletedItemIds() {
  const events = await safeSelectRows(
    EVENT_TABLE,
    'id,request_id,event_type,payload,created_at',
    q => q.in('event_type', MARKETPLACE_EXECUTION_EVENT_TYPES).order('id', { ascending: false }).limit(500)
  );
  return candidateEventItemIds(events.filter(event => event.event_type === 'marketplace_execution_completed'));
}

async function buildEbayListingQualityEvidenceRefreshPlan({ limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, intOrNull(limit) || 50));
  const rows = await loadPhase13ActiveEbayListingRows({ limit: safeLimit });
  const executedItemIds = await marketplaceCompletedItemIds();
  const planned = [];
  for (const row of rows) {
    const evidence = await loadCachedEbayListingEvidence({ sku: row.sku });
    let context = null;
    let contextError = null;
    try {
      const { buildSkuContext } = require('./skuContextBuilder');
      context = await buildSkuContext({ sku: row.sku, readOnly: true, skipConnector: true });
    } catch (e) {
      contextError = e.message;
    }
    const signalSummary = phase13SignalDominance(context?.signals || []);
    const missingEvidenceFields = evidenceRefreshMissingFields(evidence);
    const qualityEvidence = titleQualityEvidenceFromCachedListing(evidence);
    const itemId = firstNonEmpty(evidence.item_id, row.item_id);
    const excludedAlreadyExecuted = itemId && executedItemIds.has(String(itemId));
    const missingItemId = !itemId;
    const missingTitle = !evidence.title;
    const missingListingQualityEvidence = missingEvidenceFields.some(name => ['cached_description', 'cached_item_specifics', 'cached_images', 'cached_policies', 'listing_details'].includes(name))
      || qualityEvidence.listing_quality_evidence_missing;
    const inactiveOrNonEbayListing = !row.sku || ['ended', 'deleted', 'inactive', 'sold_out'].includes(String(row.status || '').toLowerCase());
    const enoughIdentityForReadOnlyFetch = Boolean(itemId && row.sku);
    const evidenceRefreshCandidate = enoughIdentityForReadOnlyFetch
      && !inactiveOrNonEbayListing
      && !excludedAlreadyExecuted
      && missingListingQualityEvidence;
    const executionCandidate = evidenceRefreshCandidate
      && signalSummary.listing_quality_low
      && !signalSummary.price_inventory_signals_dominate;
    const priorityScore = (evidenceRefreshCandidate ? 100 : 0)
      + (missingListingQualityEvidence ? 30 : 0)
      + (missingTitle ? 20 : 0)
      + (missingItemId ? 10 : 0)
      - (excludedAlreadyExecuted ? 200 : 0)
      - (inactiveOrNonEbayListing ? 100 : 0);

    planned.push({
      sku: row.sku,
      item_id: itemId || null,
      listing_id: itemId || null,
      status: row.status || null,
      source_table: row.source_table,
      active_ebay_capable: Boolean(row.sku && (itemId || row.source_table === 'ebay_products') && !inactiveOrNonEbayListing),
      enough_identity_for_read_only_fetch: enoughIdentityForReadOnlyFetch,
      inactive_or_non_ebay_listing: inactiveOrNonEbayListing,
      missing_cached_item_id: missingItemId,
      missing_cached_title_evidence: missingTitle,
      missing_listing_quality_evidence: missingListingQualityEvidence,
      missing_evidence_fields: missingEvidenceFields,
      excluded_already_executed: Boolean(excludedAlreadyExecuted),
      excluded_price_inventory_signals_dominate: false,
      price_inventory_signals_present: signalSummary.price_inventory_signals_dominate,
      signal_summary: signalSummary,
      cached_evidence_summary: {
        source_tables: evidence.source_tables || [],
        title: evidence.title || null,
        title_present: Boolean(evidence.title),
        title_length: String(evidence.title || '').trim().length,
        description_present: Boolean(evidence.description),
        item_specifics_count: Object.keys(evidence.item_specifics || {}).length,
        image_count: (evidence.images || []).length,
        policies_present: Boolean(evidence.policies),
        limitations: evidence.limitations || [],
        context_error: contextError,
      },
      evidence_refresh_candidate: evidenceRefreshCandidate,
      execution_candidate: executionCandidate,
      safe_candidate_for_read_only_evidence_refresh: evidenceRefreshCandidate,
      refresh_plan: evidenceRefreshCandidate ? {
        mode: 'read_only_preview_only',
        existing_auth_logic_reused: true,
        new_auth_logic_created: false,
        preferred_read_path: 'existing cached listing enrichment/read-only eBay GetItem path if operator authorizes a later fetch phase',
        would_fetch_live_marketplace_state: false,
        would_write_db: false,
        would_modify_listing: false,
      } : null,
      reason: evidenceRefreshCandidate
        ? 'active listing has cached item id and missing listing-quality evidence; inventory/dead-stock/no-recent-sales signals do not block read-only evidence refresh'
        : 'not safe for refresh planning until identity, active-listing, already-executed, or evidence-gap blockers are resolved',
      execution_candidate_reason: executionCandidate
        ? 'listing_quality_low signal exists and no price/inventory signal dominance blocks execution-candidate selection'
        : 'evidence refresh candidate is not an execution candidate; listing-quality opportunity selection remains separate',
    });
  }
  planned.sort((a, b) => (b.evidence_refresh_candidate - a.evidence_refresh_candidate)
    || ((b.missing_listing_quality_evidence ? 1 : 0) - (a.missing_listing_quality_evidence ? 1 : 0))
    || String(a.sku || '').localeCompare(String(b.sku || '')));
  const evidenceRefreshCandidates = planned.filter(row => row.evidence_refresh_candidate);
  const executionCandidates = planned.filter(row => row.execution_candidate);

  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_evidence_refresh_plan',
    limit: safeLimit,
    totals: {
      active_ebay_capable_listings_found: rows.length,
      listings_missing_cached_item_id: planned.filter(row => row.missing_cached_item_id).length,
      listings_missing_cached_title_evidence: planned.filter(row => row.missing_cached_title_evidence).length,
      listings_missing_listing_quality_evidence: planned.filter(row => row.missing_listing_quality_evidence).length,
      listings_excluded_already_executed: planned.filter(row => row.excluded_already_executed).length,
      listings_with_price_inventory_signals: planned.filter(row => row.price_inventory_signals_present).length,
      listings_excluded_price_inventory_signals_dominate: 0,
      evidence_refresh_candidates: evidenceRefreshCandidates.length,
      execution_candidates: executionCandidates.length,
      safe_candidates_for_read_only_evidence_refresh: evidenceRefreshCandidates.length,
    },
    completed_marketplace_item_ids: [...executedItemIds].sort(),
    listings: planned.slice(0, safeLimit),
    evidence_refresh_candidates: evidenceRefreshCandidates.slice(0, safeLimit),
    execution_candidates: executionCandidates.slice(0, safeLimit),
    safe_candidates_for_read_only_evidence_refresh: evidenceRefreshCandidates.slice(0, safeLimit),
    recommended_next_command: 'npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample --limit=5 --dry-run',
    recommended_next_action: 'Review evidence_refresh_candidates, then run the dry-run sample. Do not treat evidence refresh candidates as execution candidates; do not create opportunities, packets, approvals, DB writes, or marketplace writes in Phase 13D.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13d_listing_evidence_refresh_plan_v2',
  };
}


async function sampleEbayListingQualityEvidenceRefresh({ limit = 5, dryRun = true } = {}) {
  const safeLimit = Math.min(5, Math.max(1, intOrNull(limit) || 5));
  const plan = await buildEbayListingQualityEvidenceRefreshPlan({ limit: Math.max(50, safeLimit) });
  const samples = (plan.evidence_refresh_candidates || []).slice(0, safeLimit).map((candidate, index) => ({
    rank: index + 1,
    sku: candidate.sku,
    item_id: candidate.item_id,
    listing_id: candidate.listing_id,
    title: candidate.cached_evidence_summary?.title_present ? candidate.cached_evidence_summary.title : undefined,
    title_present: candidate.cached_evidence_summary?.title_present === true,
    title_length: candidate.cached_evidence_summary?.title_length || 0,
    current_evidence_gaps: candidate.missing_evidence_fields || [],
    signal_summary: candidate.signal_summary || {},
    inventory_signals_do_not_block_refresh: true,
    read_only_get_item_fetch_plan: {
      prepared: true,
      max_items_for_this_command: safeLimit,
      existing_api_module: 'src/api/ebayAPI.js',
      existing_auth_logic_reused: true,
      new_auth_logic_created: false,
      read_operation: 'Trading API GetItem or existing read-only listing enrichment path in a later explicitly authorized fetch/cache phase',
      would_include: ['ItemID', 'Title', 'Description', 'ItemSpecifics', 'PictureDetails', 'ListingDetails', 'ReturnPolicy', 'ShippingDetails', 'PaymentMethods'],
      would_call_ebay_now: false,
      would_write_db_now: false,
      would_create_opportunity: false,
      would_create_packet: false,
      would_create_approval: false,
      would_modify_listing: false,
    },
    sample_preview_only: true,
  }));

  return {
    read_only: true,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_evidence_refresh_sample',
    limit: safeLimit,
    source_plan_summary: plan.totals,
    sample_count: samples.length,
    samples,
    blocker: samples.length === 0 ? 'no_evidence_refresh_candidates' : null,
    recommended_next_action: samples.length
      ? 'Use this sample as an operator checklist for a later explicit read-only fetch/cache phase. Phase 13D performs no eBay fetch and no DB write.'
      : 'No evidence refresh candidates found. Do not fake evidence or create opportunities.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13d_listing_evidence_refresh_sample_v1',
  };
}

async function previewEbayListingQualityEvidenceRefresh({ limit = 20, dryRun = true } = {}) {
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 20));
  const plan = await buildEbayListingQualityEvidenceRefreshPlan({ limit: safeLimit });
  const fetchPreviews = (plan.safe_candidates_for_read_only_evidence_refresh || []).slice(0, safeLimit).map((candidate, index) => ({
    rank: index + 1,
    sku: candidate.sku,
    item_id: candidate.item_id,
    listing_id: candidate.listing_id,
    missing_evidence_fields: candidate.missing_evidence_fields,
    read_only_fetch_plan: {
      prepared: true,
      existing_api_module: 'src/api/ebayAPI.js',
      existing_auth_logic_reused: true,
      new_auth_logic_created: false,
      read_operation: 'Trading API GetItem or existing read-only listing enrichment path in a later explicitly authorized fetch phase',
      would_include: ['ItemID', 'Title', 'Description', 'ItemSpecifics', 'PictureDetails', 'ListingDetails', 'ReturnPolicy', 'ShippingDetails', 'PaymentMethods'],
      would_call_ebay_now: false,
      would_write_cache_now: false,
      would_modify_listing: false,
    },
    candidate_preview_only: true,
  }));

  return {
    read_only: true,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_evidence_refresh_preview',
    limit: safeLimit,
    source_plan_summary: plan.totals,
    fetch_preview_count: fetchPreviews.length,
    fetch_previews: fetchPreviews,
    blocker: fetchPreviews.length === 0 ? 'no_safe_read_only_evidence_refresh_candidates' : null,
    recommended_next_action: fetchPreviews.length
      ? 'Use this as an operator checklist for a later explicit read-only fetch/cache phase; Phase 13C performs no live fetch and no DB write.'
      : 'No safe read-only evidence refresh preview candidates found. Do not fake evidence or create opportunities.',
    safety: {
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13d_listing_evidence_refresh_preview_v2',
  };
}



function decodeXmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function xmlValue(xml, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(xml || '').match(pattern);
  return match ? decodeXmlText(match[1]) : '';
}

function xmlBlocks(xml, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const out = [];
  let match;
  while ((match = pattern.exec(String(xml || ''))) !== null) out.push(match[1]);
  return out;
}

function parseEbayGetItemEvidenceXml(xml, { sku = null, itemId = null, fetchedAt = null } = {}) {
  const itemBlock = xmlValue(xml, 'Item') ? xmlBlocks(xml, 'Item')[0] : String(xml || '');
  const ack = xmlValue(xml, 'Ack') || null;
  const errors = xmlBlocks(xml, 'Errors').map(block => ({
    severity: xmlValue(block, 'SeverityCode') || null,
    code: xmlValue(block, 'ErrorCode') || null,
    short_message: xmlValue(block, 'ShortMessage') || null,
    long_message: xmlValue(block, 'LongMessage') || null,
  }));
  const description = xmlValue(itemBlock, 'Description');
  const pictureUrls = xmlBlocks(itemBlock, 'PictureURL').map(decodeXmlText).filter(Boolean);
  const itemSpecifics = {};
  for (const block of xmlBlocks(itemBlock, 'NameValueList')) {
    const name = xmlValue(block, 'Name');
    if (!name) continue;
    const values = xmlBlocks(block, 'Value').map(decodeXmlText).filter(v => v !== '');
    itemSpecifics[name] = values.length > 1 ? values : (values[0] || '');
  }
  const categoryId = xmlValue(xmlBlocks(itemBlock, 'PrimaryCategory')[0] || '', 'CategoryID') || xmlValue(itemBlock, 'CategoryID');
  const categoryName = xmlValue(xmlBlocks(itemBlock, 'PrimaryCategory')[0] || '', 'CategoryName') || xmlValue(itemBlock, 'CategoryName');
  const listingStatus = xmlValue(itemBlock, 'ListingStatus') || xmlValue(xmlBlocks(itemBlock, 'SellingStatus')[0] || '', 'ListingStatus') || null;
  const title = xmlValue(itemBlock, 'Title');
  const resolvedItemId = xmlValue(itemBlock, 'ItemID') || itemId || null;
  const resolvedFetchedAt = fetchedAt || new Date().toISOString();
  const errorSeverityErrors = errors.filter(e => String(e.severity || '').toLowerCase() === 'error');

  return {
    item_id: resolvedItemId,
    sku: sku || resolvedItemId,
    title: title || null,
    description_present: Boolean(description),
    description_length: description.length,
    item_specifics_present: Object.keys(itemSpecifics).length > 0,
    item_specifics_count: Object.keys(itemSpecifics).length,
    picture_count: pictureUrls.length,
    category_id: categoryId || null,
    category_name: categoryName || null,
    listing_status: listingStatus,
    fetched_at: resolvedFetchedAt,
    source: 'ebay_get_item_read_only',
    ack,
    success: !errorSeverityErrors.length && ['Success', 'Warning'].includes(String(ack || '')),
    errors,
    raw_response_summary: {
      ack,
      error_count: errors.length,
      error_severity_count: errorSeverityErrors.length,
      has_item: Boolean(resolvedItemId || title),
      raw_response_preserved_without_secrets: true,
    },
    raw_data: {
      ItemID: resolvedItemId,
      Title: title || null,
      Description: description || null,
      ItemSpecifics: itemSpecifics,
      PictureURLs: pictureUrls,
      PrimaryCategory: {
        CategoryID: categoryId || null,
        CategoryName: categoryName || null,
      },
      ListingStatus: listingStatus,
      fetched_at: resolvedFetchedAt,
      source: 'ebay_get_item_read_only',
    },
  };
}

function classifyEbayReadOnlyFetchError(error) {
  const message = String(error?.message || error || 'unknown error');
  const lower = message.toLowerCase();
  let errorType = 'fetch_failed';
  if (/rate|quota|limit|throttl/.test(lower)) errorType = 'rate_limit';
  else if (/token|auth|unauthorized|credential|refresh/.test(lower)) errorType = 'invalid_token_or_auth';
  else if (/not found|invalid item|item.*invalid|missing item/.test(lower)) errorType = 'missing_or_invalid_item';
  return {
    error_type: errorType,
    message,
    retry_safe: errorType === 'rate_limit',
    evidence_faked: false,
  };
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildGetItemRequestBody(itemId) {
  return `
  <ItemID>${escapeXmlText(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <IncludeWatchCount>true</IncludeWatchCount>`;
}

async function writeInternalListingEvidenceCache({ candidate, evidence } = {}) {
  if (!candidate?.item_id || !evidence?.item_id) throw new Error('item_id is required for evidence cache write');
  const db = getClient();
  const now = evidence.fetched_at || new Date().toISOString();
  const detailRecord = {
    platform: 'ebay',
    listing_type: 'our',
    sku: candidate.sku || evidence.sku || evidence.item_id,
    item_id: String(evidence.item_id),
    title: evidence.title || '',
    category_id: evidence.category_id || '',
    category_name: evidence.category_name || '',
    listing_status: evidence.listing_status || '',
    image_count: evidence.picture_count || 0,
    source_api: 'ebay_get_item_read_only',
    last_enriched_at: now,
    raw_data: evidence.raw_data || {},
  };
  const { data: detail, error: detailError } = await db
    .from('listing_details')
    .upsert(detailRecord, { onConflict: 'platform,listing_type,item_id' })
    .select('id,item_id,sku,last_enriched_at')
    .single();
  if (detailError) throw detailError;

  const specifics = evidence.raw_data?.ItemSpecifics || {};
  const specificRows = Object.entries(specifics).map(([name, value]) => ({
    platform: 'ebay',
    listing_type: 'our',
    item_id: String(evidence.item_id),
    name: String(name),
    value: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
    source: 'ebay_get_item_read_only',
  }));
  let specificsWritten = 0;
  if (specificRows.length) {
    const { data, error } = await db
      .from('listing_item_specifics')
      .upsert(specificRows, { onConflict: 'platform,listing_type,item_id,name' })
      .select('id');
    if (error) throw error;
    specificsWritten = (data || []).length;
  }

  const imageRows = (evidence.raw_data?.PictureURLs || []).map((url, index) => ({
    platform: 'ebay',
    listing_type: 'our',
    item_id: String(evidence.item_id),
    image_url: String(url),
    position: index + 1,
    source: 'ebay_get_item_read_only',
  }));
  let imagesWritten = 0;
  if (imageRows.length) {
    const { data, error } = await db
      .from('listing_images')
      .upsert(imageRows, { onConflict: 'platform,listing_type,item_id,image_url' })
      .select('id');
    if (error) throw error;
    imagesWritten = (data || []).length;
  }

  return {
    detail_row: detail,
    listing_details_written: true,
    item_specifics_upserted: specificsWritten,
    images_upserted: imagesWritten,
    source: 'internal_listing_quality_evidence_cache',
  };
}

function normalizePhase13EvidenceFetchItemIds(itemIds = null) {
  if (!itemIds) return [];
  const raw = Array.isArray(itemIds) ? itemIds : String(itemIds).split(',');
  const normalized = [];
  const seen = new Set();
  for (const value of raw) {
    const itemId = trimOrNull(value, 100);
    if (!itemId || itemId === '202551129453' || seen.has(itemId)) continue;
    seen.add(itemId);
    normalized.push(itemId);
    if (normalized.length >= 10) break;
  }
  return normalized;
}

async function buildPhase13EvidenceFetchCandidates({ limit = 5, itemIds = null } = {}) {
  const safeLimit = Math.min(10, Math.max(1, intOrNull(limit) || 5));
  const scopedItemIds = normalizePhase13EvidenceFetchItemIds(itemIds);
  const plan = await buildEbayListingQualityEvidenceRefreshPlan({ limit: Math.max(50, safeLimit) });
  const unexecutedPlanRows = (plan.listings || [])
    .filter(row => row.item_id && String(row.item_id) !== '202551129453' && !row.excluded_already_executed);
  const byItemId = new Map(unexecutedPlanRows.map(row => [String(row.item_id), row]));
  const selectedRows = scopedItemIds.length
    ? scopedItemIds.map(itemId => byItemId.get(itemId)).filter(Boolean)
    : (plan.evidence_refresh_candidates || []).filter(row => row.item_id && String(row.item_id) !== '202551129453').slice(0, safeLimit);
  const candidates = selectedRows.slice(0, safeLimit).map((candidate, index) => ({
    rank: index + 1,
    sku: candidate.sku,
    item_id: candidate.item_id,
    listing_id: candidate.listing_id,
    title: candidate.cached_evidence_summary?.title_present ? candidate.cached_evidence_summary.title : undefined,
    title_present: candidate.cached_evidence_summary?.title_present === true,
    title_length: candidate.cached_evidence_summary?.title_length || 0,
    current_evidence_gaps: candidate.missing_evidence_fields || [],
    signal_summary: candidate.signal_summary || {},
    scoped_by_item_ids: scopedItemIds.length > 0,
  }));
  return {
    safeLimit,
    scopedItemIds,
    sourcePlanSummary: plan.totals,
    candidates,
    missing_requested_item_ids: scopedItemIds.filter(itemId => !byItemId.has(itemId)),
  };
}

async function fetchEbayListingQualityEvidence({ limit = 5, dryRun = true, write = false, itemIds = null } = {}) {
  const { safeLimit, scopedItemIds, sourcePlanSummary, candidates, missing_requested_item_ids: missingRequestedItemIds } = await buildPhase13EvidenceFetchCandidates({ limit, itemIds });
  const writeRequested = write === true || dryRun === false;

  const result = {
    read_only: true,
    dry_run: !writeRequested,
    marketplace: 'ebay',
    operation: 'listing_quality_evidence_fetch',
    limit: safeLimit,
    source_sample_summary: sourcePlanSummary,
    candidate_count: candidates.length,
    fetch_scope: {
      max_items: 10,
      selected_items: candidates.map(c => ({ sku: c.sku, item_id: c.item_id, title: c.title, evidence_gaps: c.current_evidence_gaps })),
      requested_item_ids: scopedItemIds,
      missing_requested_item_ids: missingRequestedItemIds,
      item_id_scoped: scopedItemIds.length > 0,
      excluded_item_ids: ['202551129453'],
      already_executed_listings_excluded: true,
      read_operation: 'Trading API GetItem',
    },
    fetch_results: [],
    write_results: [],
    partial_failure: false,
    blocker: candidates.length === 0 ? (scopedItemIds.length ? 'no_matching_item_id_scoped_evidence_refresh_candidates' : 'no_evidence_refresh_sample_candidates') : null,
    safety: {
      read_only: true,
      actual_read_only_ebay_call: false,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      ebay_write_api_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: scopedItemIds.length ? 'phase_13f_item_id_scoped_listing_evidence_fetch_v1' : 'phase_13i_batch_listing_evidence_fetch_v1',
  };

  if (!candidates.length) return result;

  const EbayAPI = require('../api/ebayAPI');
  const ebay = new EbayAPI();
  for (const candidate of candidates) {
    const fetchedAt = new Date().toISOString();
    try {
      const xml = await ebay.callTradingAPI('GetItem', buildGetItemRequestBody(candidate.item_id));
      result.safety.actual_read_only_ebay_call = true;
      result.safety.actual_ebay_call = true;
      result.safety.get_item_called = true;
      result.safety.actual_network_call = true;
      const evidence = parseEbayGetItemEvidenceXml(xml, { sku: candidate.sku, itemId: candidate.item_id, fetchedAt });
      const shaped = {
        sku: candidate.sku,
        item_id: evidence.item_id,
        title: evidence.title,
        description_present: evidence.description_present,
        description_length: evidence.description_length,
        item_specifics_present: evidence.item_specifics_present,
        item_specifics_count: evidence.item_specifics_count,
        picture_count: evidence.picture_count,
        category_id: evidence.category_id,
        category_name: evidence.category_name,
        listing_status: evidence.listing_status,
        fetched_at: evidence.fetched_at,
        source: evidence.source,
        success: evidence.success,
        ack: evidence.ack,
        errors: evidence.errors,
        raw_response_summary: evidence.raw_response_summary,
        evidence_faked: false,
      };
      result.fetch_results.push(shaped);
      if (writeRequested && evidence.success) {
        const writeResult = await writeInternalListingEvidenceCache({ candidate, evidence });
        result.write_results.push({ sku: candidate.sku, item_id: evidence.item_id, written: true, ...writeResult });
        result.safety.actual_database_write = true;
      }
    } catch (e) {
      result.partial_failure = true;
      result.fetch_results.push({
        sku: candidate.sku,
        item_id: candidate.item_id,
        success: false,
        ...classifyEbayReadOnlyFetchError(e),
      });
    }
  }

  result.fetched_count = result.fetch_results.filter(row => row.success).length;
  result.failed_count = result.fetch_results.filter(row => row.success === false).length;
  result.recommended_next_action = writeRequested
    ? 'Internal evidence cache write mode completed only for successful read-only GetItem results. Do not create opportunities, packets, approvals, execution-state changes, or marketplace writes in Phase 13I.'
    : 'Review fetched read-only evidence. If internal cache persistence is desired, run the same command with --write after confirming evidence-only scope.';
  return result;
}



function phase13GTitleClarity(title = '') {
  const value = String(title || '').trim();
  const reasons = [];
  let points = 20;
  if (!value) {
    return { points: 0, reasons: ['missing_title'], length: 0 };
  }
  if (value.length < 35) {
    points -= 8;
    reasons.push('short_title_under_35_chars');
  } else if (value.length > 80) {
    points -= 6;
    reasons.push('title_over_80_chars');
  }
  if (/\s{2,}/.test(value)) {
    points -= 3;
    reasons.push('title_extra_whitespace');
  }
  if (/^[A-Z0-9\s\-_/]+$/.test(value) && /[A-Z]/.test(value)) {
    points -= 3;
    reasons.push('title_all_caps_style');
  }
  if (!/[A-Za-z0-9]/.test(value)) {
    points -= 5;
    reasons.push('title_lacks_alphanumeric_text');
  }
  return { points: Math.max(0, points), reasons, length: value.length };
}

function phase13GDescriptionScore(description = '') {
  const length = String(description || '').replace(/\s+/g, ' ').trim().length;
  if (length <= 0) return { points: 0, reasons: ['missing_description'], length, why: ['no cached description text found after normalization'] };
  if (length < 300) return { points: 10, reasons: ['description_under_300_chars'], length, why: [`normalized visible description length ${length} is below 300`] };
  if (length < 800) return { points: 18, reasons: ['description_under_800_chars'], length, why: [`normalized visible description length ${length} is below 800`] };
  return { points: 25, reasons: [], length, why: [] };
}

function phase13GCountScore(count, thresholds, label) {
  const n = Number.isFinite(Number(count)) ? Number(count) : 0;
  if (n <= 0) return { points: 0, reasons: [`missing_${label}`], count: n };
  if (n < thresholds.good) return { points: thresholds.partial, reasons: [`${label}_below_${thresholds.good}`], count: n };
  return { points: thresholds.full, reasons: [], count: n };
}

function buildPhase13GProposedMutationFields(gaps = []) {
  const fields = new Set();
  for (const gap of gaps || []) {
    if (/title/i.test(gap)) fields.add('title');
    if (/description/i.test(gap)) fields.add('description');
    if (/specific/i.test(gap)) fields.add('item_specifics');
  }
  return [...fields];
}


function buildPhase13GGapReasons(gaps = [], context = {}) {
  const reasons = {};
  for (const gap of gaps || []) {
    if (gap === 'description_under_300_chars' || gap === 'description_under_800_chars' || gap === 'missing_description') {
      reasons[gap] = {
        reason: (context.descriptionScore?.why || [])[0] || 'description length threshold was not met',
        raw_description_length: context.descriptionAudit?.raw_description_length ?? 0,
        normalized_description_length: context.descriptionAudit?.normalized_description_length ?? 0,
        html_stripped_description_length: context.descriptionAudit?.html_stripped_description_length ?? 0,
        visible_text_length: context.descriptionAudit?.visible_text_length ?? 0,
      };
    } else if (/title/i.test(gap)) {
      reasons[gap] = { reason: `title audit detected ${gap}`, title_length: context.titleScore?.length ?? 0 };
    } else if (/specific/i.test(gap)) {
      reasons[gap] = { reason: `item specifics count ${context.specificsScore?.count ?? 0} is below scoring threshold` };
    } else if (/picture/i.test(gap)) {
      reasons[gap] = { reason: `picture count ${context.pictureScore?.count ?? 0} is below scoring threshold` };
    } else if (/category/i.test(gap)) {
      reasons[gap] = { reason: 'cached category id/name is missing' };
    } else if (/active|status/i.test(gap)) {
      reasons[gap] = { reason: 'cached listing status is not active' };
    } else {
      reasons[gap] = { reason: `deterministic scorer emitted ${gap}` };
    }
  }
  return reasons;
}

function scoreCachedListingQualityEvidence(evidence = {}) {
  const title = String(evidence.title || '').trim();
  const descriptionAudit = buildDescriptionAudit(evidence.listing_detail?.raw_data || {});
  const description = String(descriptionAudit.visible_text || evidence.description || '').trim();
  const itemSpecificsCount = Object.keys(evidence.item_specifics || {}).length;
  const pictureCount = (evidence.images || []).length || Number(evidence.listing_detail?.image_count || 0) || 0;
  const categoryPresent = Boolean(evidence.listing_detail?.category_id || evidence.listing_detail?.category_name || evidence.category_id || evidence.category_name);
  const status = String(evidence.listing_detail?.listing_status || evidence.ebay_product?.status || evidence.status || '').toLowerCase();
  const active = !status || ['active', 'available'].includes(status);
  const detectedGaps = [];

  const titleScore = phase13GTitleClarity(title);
  const descriptionScore = phase13GDescriptionScore(description);
  const specificsScore = phase13GCountScore(itemSpecificsCount, { good: 5, partial: 10, full: 15 }, 'item_specifics');
  const pictureScore = phase13GCountScore(pictureCount, { good: 2, partial: 5, full: 10 }, 'pictures');
  const categoryScore = categoryPresent ? { points: 10, reasons: [] } : { points: 0, reasons: ['missing_category'] };
  const statusScore = active ? { points: 10, reasons: [] } : { points: 0, reasons: ['listing_not_active'] };
  const proposedMutationFields = buildPhase13GProposedMutationFields([
    ...titleScore.reasons,
    ...descriptionScore.reasons,
    ...specificsScore.reasons,
  ]);
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields({ planned_mutation: Object.fromEntries(proposedMutationFields.map(f => [f, true])) });
  if (forbiddenFields.length) detectedGaps.push('forbidden_marketplace_mutation_fields_present');
  detectedGaps.push(...titleScore.reasons, ...descriptionScore.reasons, ...specificsScore.reasons, ...pictureScore.reasons, ...categoryScore.reasons, ...statusScore.reasons);

  const score = Math.max(0, Math.min(100,
    titleScore.points + descriptionScore.points + specificsScore.points + pictureScore.points + categoryScore.points + statusScore.points
  ));
  const lowQuality = score < 70 || detectedGaps.includes('missing_description') || detectedGaps.includes('missing_title');
  const riskLevel = forbiddenFields.length || !active ? 'blocked' : (lowQuality ? 'low' : 'info');
  return {
    item_id: evidence.item_id || null,
    sku: evidence.sku || evidence.item_id || null,
    title,
    listing_quality_score: score,
    score_breakdown: {
      title: titleScore.points,
      description: descriptionScore.points,
      item_specifics: specificsScore.points,
      pictures: pictureScore.points,
      category: categoryScore.points,
      listing_status: statusScore.points,
    },
    evidence_metrics: {
      title_length: titleScore.length,
      description_present: description.length > 0,
      description_length: descriptionScore.length,
      raw_description_length: descriptionAudit.raw_description_length,
      normalized_description_length: descriptionAudit.normalized_description_length,
      html_stripped_description_length: descriptionAudit.html_stripped_description_length,
      visible_text_length: descriptionAudit.visible_text_length,
      item_specifics_count: itemSpecificsCount,
      picture_count: pictureCount,
      category_present: categoryPresent,
      listing_status: status || null,
      listing_status_active: active,
      forbidden_marketplace_mutation_fields_absent: forbiddenFields.length === 0,
    },
    detected_gaps: [...new Set(detectedGaps)],
    gap_reasons: buildPhase13GGapReasons([...new Set(detectedGaps)], {
      titleScore,
      descriptionScore,
      specificsScore,
      pictureScore,
      categoryScore,
      statusScore,
      descriptionAudit,
    }),
    recommendation: lowQuality
      ? 'Preview listing_quality_low opportunity for human review only; do not create packets, approvals, or marketplace writes.'
      : 'No listing_quality_low opportunity recommended from cached evidence.',
    would_create_listing_quality_low_opportunity: lowQuality && forbiddenFields.length === 0 && active,
    proposed_mutation_fields: proposedMutationFields,
    forbidden_field_check: {
      forbidden_fields_present: forbiddenFields.length > 0,
      forbidden_fields: forbiddenFields,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_end_create_relist: false,
      sku_remapping: false,
    },
    risk_level: riskLevel,
    evidence_source: evidence.source_tables || [],
    source_api: evidence.listing_detail?.source_api || null,
  };
}

async function loadPhase13GScoringEvidenceByItemId(itemId) {
  const rows = await safeSelectRows(
    'listing_details',
    'platform,listing_type,sku,item_id,title,category_id,category_name,listing_status,source_api,last_enriched_at,raw_data,image_count',
    q => q.eq('platform', 'ebay').eq('listing_type', 'our').eq('item_id', itemId).limit(1)
  );
  const detail = rows[0] || null;
  const evidence = detail ? await loadCachedEbayListingEvidence({ sku: detail.sku || detail.item_id }) : await loadCachedEbayListingEvidence({ sku: itemId });
  if (detail && !evidence.listing_detail) evidence.listing_detail = detail;
  if (detail?.raw_data && !evidence.description) evidence.description = rawDescription(detail.raw_data);
  if (detail?.source_api && !(evidence.source_tables || []).includes('listing_details')) {
    evidence.source_tables = [...(evidence.source_tables || []), 'listing_details'];
  }
  return evidence;
}

async function scoreEbayListingQualityEvidence({ itemIds = null, limit = 5, dryRun = true } = {}) {
  const scopedItemIds = normalizePhase13EvidenceFetchItemIds(itemIds);
  if (!scopedItemIds.length) throw new Error('item-ids is required');
  const safeLimit = Math.min(50, Math.max(1, intOrNull(limit) || scopedItemIds.length || 5));
  const scores = [];
  for (const itemId of scopedItemIds.slice(0, safeLimit)) {
    const evidence = await loadPhase13GScoringEvidenceByItemId(itemId);
    scores.push(scoreCachedListingQualityEvidence(evidence));
  }
  return {
    read_only: true,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_evidence_score',
    item_ids: scopedItemIds.slice(0, safeLimit),
    count: scores.length,
    scores,
    low_quality_count: scores.filter(s => s.would_create_listing_quality_low_opportunity).length,
    eligible_opportunity_previews: scores.filter(s => s.would_create_listing_quality_low_opportunity),
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13g_listing_quality_evidence_scoring_v1',
  };
}


async function auditEbayListingQualityScore({ itemIds = null, limit = 5 } = {}) {
  const scopedItemIds = normalizePhase13EvidenceFetchItemIds(itemIds);
  if (!scopedItemIds.length) throw new Error('item-ids is required');
  const safeLimit = Math.min(50, Math.max(1, intOrNull(limit) || scopedItemIds.length || 5));
  const audits = [];
  for (const itemId of scopedItemIds.slice(0, safeLimit)) {
    const evidence = await loadPhase13GScoringEvidenceByItemId(itemId);
    const score = scoreCachedListingQualityEvidence(evidence);
    const descriptionAudit = buildDescriptionAudit(evidence.listing_detail?.raw_data || {});
    audits.push({
      item_id: score.item_id,
      sku: score.sku,
      title: score.title,
      raw_description_length: descriptionAudit.raw_description_length,
      normalized_description_length: descriptionAudit.normalized_description_length,
      html_stripped_description_length: descriptionAudit.html_stripped_description_length,
      visible_text_length: descriptionAudit.visible_text_length,
      item_specifics_count: score.evidence_metrics.item_specifics_count,
      picture_count: score.evidence_metrics.picture_count,
      listing_quality_score: score.listing_quality_score,
      score_component_breakdown: score.score_breakdown,
      detected_gaps: score.detected_gaps,
      gap_reasons: score.gap_reasons,
      recommendation: score.recommendation,
      would_create_listing_quality_low_opportunity: score.would_create_listing_quality_low_opportunity,
      proposed_mutation_fields: score.proposed_mutation_fields,
      risk_level: score.risk_level,
      evidence_source: score.evidence_source,
    });
  }
  return {
    read_only: true,
    dry_run: true,
    marketplace: 'ebay',
    operation: 'listing_quality_score_audit',
    item_ids: scopedItemIds.slice(0, safeLimit),
    count: audits.length,
    audits,
    calibration_summary: {
      raw_description_present_count: audits.filter(a => a.raw_description_length > 0).length,
      visible_text_present_count: audits.filter(a => a.visible_text_length > 0).length,
      description_under_300_count: audits.filter(a => a.detected_gaps.includes('description_under_300_chars')).length,
      low_quality_count: audits.filter(a => a.would_create_listing_quality_low_opportunity).length,
      calibration_fix_applied: 'description normalization now chooses the longest cached raw description candidate and scores stripped visible text',
    },
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13h_listing_quality_scoring_calibration_audit_v1',
  };
}

async function previewEbayListingQualityOpportunities({ limit = 10, dryRun = true } = {}) {
  const safeLimit = Math.min(50, Math.max(1, intOrNull(limit) || 10));
  const rows = await safeSelectRows(
    'listing_details',
    'platform,listing_type,sku,item_id,title,category_id,category_name,listing_status,source_api,last_enriched_at',
    q => q.eq('platform', 'ebay').eq('listing_type', 'our').order('last_enriched_at', { ascending: false, nullsFirst: false }).limit(safeLimit * 3)
  );
  const itemIds = rows.map(row => row.item_id).filter(Boolean).filter(id => String(id) !== '202551129453').slice(0, safeLimit);
  const scoreResult = itemIds.length
    ? await scoreEbayListingQualityEvidence({ itemIds, limit: safeLimit, dryRun: true })
    : { scores: [] };
  const opportunities = (scoreResult.scores || [])
    .filter(score => score.would_create_listing_quality_low_opportunity)
    .map(score => ({
      type: 'listing_quality_review',
      signal_type: 'listing_quality_low',
      sku: score.sku,
      item_id: score.item_id,
      title: score.title,
      priority: score.listing_quality_score < 50 ? 'high' : 'medium',
      listing_quality_score: score.listing_quality_score,
      detected_gaps: score.detected_gaps,
      proposed_mutation_fields: score.proposed_mutation_fields,
      risk_level: score.risk_level,
      evidence_source: score.evidence_source,
      preview_only: true,
    }));
  return {
    read_only: true,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_opportunity_preview',
    limit: safeLimit,
    scanned_count: (scoreResult.scores || []).length,
    low_quality_count: opportunities.length,
    opportunities,
    eligible_opportunity: opportunities[0] || null,
    recommendation: opportunities.length
      ? 'Preview only. Do not create opportunities until an explicit write phase is requested.'
      : 'No eligible listing_quality_low opportunity found from cached evidence. Do not force a candidate.',
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
    },
    source: 'phase_13g_listing_quality_opportunity_preview_v1',
  };
}


function isPhase13JBorderlineGap(gap = '') {
  return [
    'pictures_below_2',
    'item_specifics_below_5',
    'description_under_800_chars',
    'short_title_under_35_chars',
    'title_over_80_chars',
    'title_extra_whitespace',
    'title_all_caps_style',
    'title_lacks_alphanumeric_text',
  ].includes(String(gap || ''));
}

function phase13JAllowedProposedFields(fields = []) {
  const allowed = new Set(['title', 'description', 'item_specifics']);
  return (fields || []).filter(field => allowed.has(String(field || '')));
}

async function previewEbayListingQualityBorderlineImprovements({ limit = 20, dryRun = true } = {}) {
  const safeLimit = Math.min(50, Math.max(1, intOrNull(limit) || 20));
  const [rows, events] = await Promise.all([
    safeSelectRows(
      'listing_details',
      'platform,listing_type,sku,item_id,title,category_id,category_name,listing_status,source_api,last_enriched_at',
      q => q.eq('platform', 'ebay').eq('listing_type', 'our').order('last_enriched_at', { ascending: false, nullsFirst: false }).limit(safeLimit * 3)
    ),
    safeSelectRows(
      EVENT_TABLE,
      'id,request_id,event_type,payload,created_at',
      q => q.eq('event_type', 'marketplace_execution_completed').order('created_at', { ascending: false }).limit(200)
    ),
  ]);
  const marketplaceExecutedItemIds = candidateEventItemIds(events);
  const scored = [];
  const seen = new Set();
  for (const row of rows || []) {
    const itemId = String(row?.item_id || '').trim();
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    if (itemId === '202551129453') continue;
    if (marketplaceExecutedItemIds.has(itemId)) continue;
    const evidence = await loadPhase13GScoringEvidenceByItemId(itemId);
    const score = scoreCachedListingQualityEvidence(evidence);
    scored.push(score);
    if (scored.length >= safeLimit) break;
  }

  const ranked = scored
    .map(score => {
      const borderlineGaps = (score.detected_gaps || []).filter(isPhase13JBorderlineGap);
      const proposedFields = phase13JAllowedProposedFields(score.proposed_mutation_fields || []);
      const forbidden = score.forbidden_field_check || {};
      const active = score.evidence_metrics?.listing_status_active === true;
      const eligible = score.listing_quality_score >= 70
        && score.listing_quality_score < 90
        && borderlineGaps.length > 0
        && active
        && score.item_id !== '202551129453'
        && !marketplaceExecutedItemIds.has(String(score.item_id || ''))
        && forbidden.forbidden_fields_present !== true
        && forbidden.price_changes !== true
        && forbidden.inventory_changes !== true
        && forbidden.quantity_changes !== true
        && proposedFields.length === (score.proposed_mutation_fields || []).length;
      return {
        item_id: score.item_id,
        sku: score.sku,
        title: score.title,
        score: score.listing_quality_score,
        detected_gaps: score.detected_gaps,
        borderline_gaps: borderlineGaps,
        gap_reasons: score.gap_reasons,
        proposed_mutation_fields: proposedFields,
        risk_level: score.risk_level,
        eligible_for_human_review: eligible,
        why_not_listing_quality_low: score.would_create_listing_quality_low_opportunity
          ? null
          : `score ${score.listing_quality_score} is at or above listing_quality_low threshold and required low-quality triggers are absent`,
        recommended_next_action: eligible
          ? 'Preview only: human may review minor listing-quality improvements in a later explicit write/approval phase; do not create opportunities, packets, approvals, or marketplace writes now.'
          : 'No borderline human-review preview action for this listing under Phase 13J rules.',
        evidence_source: score.evidence_source,
        evidence_metrics: score.evidence_metrics,
      };
    })
    .filter(row => row.eligible_for_human_review)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (b.borderline_gaps.length !== a.borderline_gaps.length) return b.borderline_gaps.length - a.borderline_gaps.length;
      return String(a.item_id).localeCompare(String(b.item_id));
    })
    .map((row, index) => ({ rank: index + 1, ...row }));

  return {
    read_only: true,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_improvement_preview',
    limit: safeLimit,
    scanned_count: scored.length,
    borderline_candidate_count: ranked.length,
    ranked_borderline_candidates: ranked,
    recommended_next_action: ranked.length
      ? 'Borderline improvement candidates found for preview only. Do not create opportunities, packets, approvals, execution-state changes, or marketplace writes in Phase 13J.'
      : 'No borderline improvement candidates found. Do not force a candidate.',
    exclusions: {
      excluded_item_ids: ['202551129453'],
      previous_marketplace_execution_completed_items_excluded: true,
      completed_marketplace_item_ids: [...marketplaceExecutedItemIds].sort(),
    },
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13j_borderline_listing_quality_improvement_preview_v1',
  };
}


async function countRows(table, buildQuery = null) {
  const db = getClient();
  try {
    let q = db.from(table).select('*', { count: 'exact', head: true });
    q = buildQuery ? buildQuery(q) : q;
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  } catch (e) {
    if (isMissingTableError(e) || /does not exist|column .* does not exist/i.test(e?.message || '')) return 0;
    throw e;
  }
}

function buildPhase13KBorderlineReviewRecord(candidate = {}) {
  return {
    opportunity_type: 'listing_quality_borderline_review',
    source_type: 'phase_13j_borderline_preview',
    input_channel: 'api',
    source_name: 'phase_13k_borderline_human_review_inbox',
    title: trimOrNull(candidate.title, 255),
    category: 'ebay_listing_quality',
    priority: 'normal',
    status: 'reviewing',
    notes: candidate.recommended_next_action || 'Internal human review required before any opportunity, packet, approval, or marketplace flow.',
    metadata: {
      type: 'listing_quality_borderline_review',
      source: 'phase_13j_borderline_preview',
      not_listing_quality_low: true,
      not_execution_candidate: true,
      requires_human_review: true,
      item_id: candidate.item_id || null,
      sku: candidate.sku || null,
      title: candidate.title || null,
      score: candidate.score,
      detected_gaps: candidate.detected_gaps || [],
      borderline_gaps: candidate.borderline_gaps || [],
      proposed_mutation_fields: candidate.proposed_mutation_fields || [],
      evidence_source: candidate.evidence_source || [],
      risk_level: candidate.risk_level || null,
      why_not_listing_quality_low: candidate.why_not_listing_quality_low || null,
      recommended_next_action: candidate.recommended_next_action || null,
      rank: candidate.rank || null,
      phase: '13K',
    },
  };
}

async function listExistingPhase13KBorderlineReviewRows() {
  return safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,metadata,created_at',
    q => q.eq('opportunity_type', 'listing_quality_borderline_review').eq('source_type', 'phase_13j_borderline_preview').order('created_at', { ascending: false }).limit(200)
  );
}

async function writeEbayListingQualityBorderlineInbox({ limit = 20, dryRun = true, write = false } = {}) {
  const writeRequested = write === true && dryRun === false;
  const preview = await previewEbayListingQualityBorderlineImprovements({ limit, dryRun: true });
  const candidates = preview.ranked_borderline_candidates || [];
  const before = {
    review_records: await countRows(OPPORTUNITY_TABLE, q => q.eq('opportunity_type', 'listing_quality_borderline_review').eq('source_type', 'phase_13j_borderline_preview')),
    listing_quality_low_opportunities: await countRows(OPPORTUNITY_TABLE, q => q.eq('opportunity_type', 'listing_quality_low')),
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  const existingRows = await listExistingPhase13KBorderlineReviewRows();
  const existingItemIds = new Set((existingRows || []).map(row => String(row?.metadata?.item_id || '')).filter(Boolean));
  const records = candidates.map(buildPhase13KBorderlineReviewRecord);
  const recordsToInsert = records.filter(record => !existingItemIds.has(String(record.metadata.item_id || '')));
  let insertedRows = [];
  if (writeRequested && recordsToInsert.length) {
    const db = getClient();
    const { data, error } = await db.from(OPPORTUNITY_TABLE).insert(recordsToInsert).select('id,opportunity_type,source_type,title,status,metadata,created_at');
    if (error) throw error;
    insertedRows = data || [];
  }
  const afterRows = await listExistingPhase13KBorderlineReviewRows();
  const candidateItemIds = new Set(candidates.map(c => String(c.item_id || '')).filter(Boolean));
  const matchingRows = (afterRows || []).filter(row => candidateItemIds.has(String(row?.metadata?.item_id || '')));
  const after = {
    review_records: await countRows(OPPORTUNITY_TABLE, q => q.eq('opportunity_type', 'listing_quality_borderline_review').eq('source_type', 'phase_13j_borderline_preview')),
    listing_quality_low_opportunities: await countRows(OPPORTUNITY_TABLE, q => q.eq('opportunity_type', 'listing_quality_low')),
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  return {
    read_only: !writeRequested,
    dry_run: !writeRequested,
    write_requested: writeRequested,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_human_review_inbox',
    limit: preview.limit,
    preview_candidate_count: candidates.length,
    planned_review_records: records,
    existing_review_record_count_before: before.review_records,
    records_to_insert_count: recordsToInsert.length,
    inserted_count: insertedRows.length,
    inserted_records: insertedRows.map(row => ({
      id: row.id,
      item_id: row.metadata?.item_id || null,
      title: row.title || row.metadata?.title || null,
      type: row.opportunity_type,
      source: row.source_type,
      status: row.status,
      not_listing_quality_low: row.metadata?.not_listing_quality_low === true,
      not_execution_candidate: row.metadata?.not_execution_candidate === true,
      requires_human_review: row.metadata?.requires_human_review === true,
    })),
    verification: {
      internal_review_records_exist: matchingRows.length >= candidates.length && candidates.length > 0,
      matching_review_record_count: matchingRows.length,
      normal_listing_quality_low_opportunity_count_before: before.listing_quality_low_opportunities,
      normal_listing_quality_low_opportunity_count_after: after.listing_quality_low_opportunities,
      normal_opportunity_created: after.listing_quality_low_opportunities > before.listing_quality_low_opportunities,
      packet_count_before: before.listing_quality_packets,
      packet_count_after: after.listing_quality_packets,
      packet_created: after.listing_quality_packets > before.listing_quality_packets,
      approval_request_count_before: before.execution_requests,
      approval_request_count_after: after.execution_requests,
      approval_created: after.execution_requests > before.execution_requests,
      execution_state_updated: false,
    },
    recommended_next_action: writeRequested
      ? 'Internal human-review records created or already present. These are not listing_quality_low opportunities and are not execution candidates; do not create packets, approvals, or marketplace writes without a later explicit human-approved phase.'
      : 'Dry-run only. Re-run with --write to create internal human-review records; do not create opportunities, packets, approvals, or marketplace writes in dry-run.',
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: writeRequested && insertedRows.length > 0,
      database_write_scope: writeRequested ? 'opportunity_inbox internal review records only' : null,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      opportunity_created: false,
      normal_opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13k_borderline_human_review_inbox_v1',
  };
}


function normalizePhase13LReviewRow(row = {}) {
  const metadata = row.metadata || {};
  return {
    id: row.id,
    type: row.opportunity_type,
    source: row.source_type,
    status: row.status,
    title: row.title || metadata.title || null,
    item_id: metadata.item_id || null,
    sku: metadata.sku || null,
    score: metadata.score ?? null,
    detected_gaps: metadata.detected_gaps || [],
    proposed_mutation_fields: metadata.proposed_mutation_fields || [],
    evidence_source: metadata.evidence_source || [],
    risk_level: metadata.risk_level || null,
    why_not_listing_quality_low: metadata.why_not_listing_quality_low || null,
    recommended_next_action: metadata.recommended_next_action || null,
    not_listing_quality_low: metadata.not_listing_quality_low === true,
    not_execution_candidate: metadata.not_execution_candidate === true,
    requires_human_review: metadata.requires_human_review === true,
    review_status: metadata.review_status || null,
    reviewed_by: metadata.reviewed_by || null,
    reviewed_at: metadata.reviewed_at || null,
    review_reason: metadata.review_reason || null,
    still_not_execution_candidate: metadata.still_not_execution_candidate === true,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listEbayListingQualityBorderlineReviews({ limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 20));
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,metadata,created_at,updated_at',
    q => q.eq('opportunity_type', 'listing_quality_borderline_review').eq('source_type', 'phase_13j_borderline_preview').order('created_at', { ascending: false }).limit(safeLimit)
  );
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_review_list',
    limit: safeLimit,
    count: rows.length,
    reviews: rows.map(normalizePhase13LReviewRow),
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      normal_opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13l_borderline_review_reader_v1',
  };
}

async function getEbayListingQualityBorderlineReviewDetail({ id } = {}) {
  const reviewId = intOrNull(id);
  if (reviewId == null) throw new Error('id is required');
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('id', reviewId).eq('opportunity_type', 'listing_quality_borderline_review').eq('source_type', 'phase_13j_borderline_preview').limit(1)
  );
  const row = rows[0] || null;
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_review_detail',
    id: reviewId,
    found: Boolean(row),
    review: row ? { ...normalizePhase13LReviewRow(row), notes: row.notes || null, metadata: row.metadata || {} } : null,
    recommended_next_action: row
      ? 'Review detail only. Use borderline-review-action with --dry-run first; do not create opportunities, packets, approvals, or marketplace writes in Phase 13L.'
      : 'Review record not found.',
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      normal_opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13l_borderline_review_detail_v1',
  };
}

async function actOnEbayListingQualityBorderlineReview({ id, action, actor = null, reason = null, dryRun = true, write = false } = {}) {
  const reviewId = intOrNull(id);
  if (reviewId == null) throw new Error('id is required');
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['shortlist', 'reject'].includes(normalizedAction)) throw new Error('action must be shortlist or reject');
  const writeRequested = write === true && dryRun === false;
  const before = {
    listing_quality_low_opportunities: await countRows(OPPORTUNITY_TABLE, q => q.eq('opportunity_type', 'listing_quality_low')),
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  const detail = await getEbayListingQualityBorderlineReviewDetail({ id: reviewId });
  if (!detail.found) throw new Error(`borderline review ${reviewId} not found`);
  const current = detail.review;
  const reviewedAt = new Date().toISOString();
  const reviewStatus = normalizedAction === 'shortlist' ? 'shortlisted' : 'rejected';
  const nextStatus = normalizedAction === 'reject' ? 'rejected' : 'reviewing';
  const nextMetadata = {
    ...(current.metadata || {}),
    review_status: reviewStatus,
    reviewed_by: actor || null,
    reviewed_at: reviewedAt,
    review_reason: reason || null,
    review_action: normalizedAction,
    still_not_execution_candidate: true,
    not_listing_quality_low: true,
    not_execution_candidate: true,
    requires_human_review: true,
    phase_13l_decision_gate: true,
  };
  let updated = null;
  if (writeRequested) {
    const db = getClient();
    const { data, error } = await db
      .from(OPPORTUNITY_TABLE)
      .update({ status: nextStatus, metadata: nextMetadata, updated_at: reviewedAt })
      .eq('id', reviewId)
      .eq('opportunity_type', 'listing_quality_borderline_review')
      .eq('source_type', 'phase_13j_borderline_preview')
      .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
      .single();
    if (error) throw error;
    updated = data;
  }
  const after = {
    listing_quality_low_opportunities: await countRows(OPPORTUNITY_TABLE, q => q.eq('opportunity_type', 'listing_quality_low')),
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  return {
    read_only: !writeRequested,
    dry_run: !writeRequested,
    write_requested: writeRequested,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_review_action',
    id: reviewId,
    action: normalizedAction,
    planned_decision: {
      review_status: reviewStatus,
      status: nextStatus,
      reviewed_by: actor || null,
      reviewed_at: reviewedAt,
      review_reason: reason || null,
      still_not_execution_candidate: true,
    },
    before_review: current,
    updated_review: updated ? normalizePhase13LReviewRow(updated) : null,
    verification: {
      normal_listing_quality_low_opportunity_count_before: before.listing_quality_low_opportunities,
      normal_listing_quality_low_opportunity_count_after: after.listing_quality_low_opportunities,
      normal_opportunity_created: after.listing_quality_low_opportunities > before.listing_quality_low_opportunities,
      packet_count_before: before.listing_quality_packets,
      packet_count_after: after.listing_quality_packets,
      packet_created: after.listing_quality_packets > before.listing_quality_packets,
      approval_request_count_before: before.execution_requests,
      approval_request_count_after: after.execution_requests,
      approval_created: after.execution_requests > before.execution_requests,
      execution_state_updated: false,
    },
    recommended_next_action: writeRequested
      ? 'Internal review decision recorded only. This remains not_listing_quality_low and not_execution_candidate; do not create opportunities, packets, approvals, or marketplace writes without a later explicit phase.'
      : 'Dry-run only. Re-run with --write to update the internal review metadata/status only.',
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: writeRequested,
      database_write_scope: writeRequested ? 'opportunity_inbox internal review metadata/status only' : null,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      normal_opportunity_created: false,
      packet_created: false,
      approval_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13l_borderline_review_decision_gate_v1',
  };
}


function phase13MPromotionSafety() {
  return {
    cached_evidence_only: true,
    actual_ebay_call: false,
    get_item_called: false,
    actual_network_call: false,
    actual_database_write: false,
    marketplace_write_performed: false,
    revise_fixed_price_item_called: false,
    normal_opportunity_created: false,
    packet_created: false,
    approval_created: false,
    execution_state_changed: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    listing_changed: false,
  };
}

function phase13MReviewHasAllowedMutationFields(review = {}) {
  const fields = review.proposed_mutation_fields || [];
  const allowed = phase13JAllowedProposedFields(fields);
  return fields.length > 0 && fields.length === allowed.length;
}

function phase13MEnoughCachedEvidenceForReview({ review, score } = {}) {
  const evidenceSource = new Set([...(review?.evidence_source || []), ...(score?.evidence_source || [])]);
  const metrics = score?.evidence_metrics || {};
  if (!review?.title || !metrics.title_length) return false;
  if (!evidenceSource.has('listing_details')) return false;
  if ((review?.proposed_mutation_fields || []).includes('item_specifics') && !evidenceSource.has('listing_item_specifics')) return false;
  if ((review?.proposed_mutation_fields || []).includes('description') && metrics.description_present !== true) return false;
  return true;
}

async function buildPhase13MPromotionAssessment(review = {}) {
  const itemId = String(review.item_id || '').trim();
  const events = await safeSelectRows(
    EVENT_TABLE,
    'id,request_id,event_type,payload,created_at',
    q => q.eq('event_type', 'marketplace_execution_completed').order('created_at', { ascending: false }).limit(200)
  );
  const marketplaceExecutedItemIds = candidateEventItemIds(events);
  const evidence = itemId ? await loadPhase13GScoringEvidenceByItemId(itemId) : {};
  const score = scoreCachedListingQualityEvidence(evidence);
  const blockers = [];
  const proposedFields = review.proposed_mutation_fields || [];
  const allowedFields = phase13JAllowedProposedFields(proposedFields);
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields({ planned_mutation: Object.fromEntries(proposedFields.map(f => [f, true])) });

  if (review.review_status !== 'shortlisted') blockers.push('review_status_not_shortlisted');
  if (review.requires_human_review !== true) blockers.push('requires_human_review_not_true');
  if (review.not_execution_candidate !== true) blockers.push('not_execution_candidate_not_true');
  if (score.evidence_metrics?.listing_status_active !== true) blockers.push('listing_not_active');
  if (!itemId) blockers.push('item_id_missing');
  if (itemId === '202551129453') blockers.push('item_id_202551129453_excluded');
  if (marketplaceExecutedItemIds.has(itemId)) blockers.push('previous_marketplace_execution_completed_event_exists');
  if (!proposedFields.length) blockers.push('no_allowed_mutation_fields');
  if (proposedFields.length !== allowedFields.length) blockers.push('non_allowed_mutation_fields_present');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');
  if (score.forbidden_field_check?.price_changes === true || score.forbidden_field_check?.inventory_changes === true || score.forbidden_field_check?.quantity_changes === true) blockers.push('price_inventory_or_quantity_field_present');
  if (!phase13MEnoughCachedEvidenceForReview({ review, score })) blockers.push('insufficient_cached_evidence_for_rollback_review');

  const eligible = blockers.length === 0;
  return {
    review_id: review.id,
    item_id: itemId || null,
    title: review.title,
    score: score.listing_quality_score ?? review.score,
    review_status: review.review_status,
    requires_human_review: review.requires_human_review,
    not_execution_candidate: review.not_execution_candidate,
    still_not_execution_candidate: review.still_not_execution_candidate,
    listing_status_active: score.evidence_metrics?.listing_status_active === true,
    proposed_mutation_fields: proposedFields,
    allowed_mutation_fields: allowedFields,
    detected_gaps: review.detected_gaps || [],
    evidence_source: [...new Set([...(review.evidence_source || []), ...(score.evidence_source || [])])],
    evidence_metrics: score.evidence_metrics || {},
    previous_marketplace_execution_completed: marketplaceExecutedItemIds.has(itemId),
    forbidden_field_check: {
      forbidden_fields_present: forbiddenFields.length > 0,
      forbidden_fields: forbiddenFields,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_end_create_relist: false,
      sku_remapping: false,
    },
    enough_cached_evidence_for_rollback_review: phase13MEnoughCachedEvidenceForReview({ review, score }),
    eligible_for_promotion: eligible,
    blockers: [...new Set(blockers)],
    recommended_next_action: eligible
      ? 'Eligible for a later explicit safe internal opportunity promotion phase only. Do not create a normal opportunity, packet, approval, execution-state change, or marketplace write in Phase 13M.'
      : 'Not eligible for promotion. Keep as internal human-review record; do not create a normal opportunity, packet, approval, execution-state change, or marketplace write.',
  };
}

async function checkEbayListingQualityBorderlinePromotionEligibility({ id } = {}) {
  const detail = await getEbayListingQualityBorderlineReviewDetail({ id });
  if (!detail.found) throw new Error(`borderline review ${id} not found`);
  const assessment = await buildPhase13MPromotionAssessment(detail.review);
  const scan = await scanEbayListingQualityBorderlinePromotionCandidates({ limit: 20 });
  const recommended = scan.eligible_promotion_candidates.find(c => c.review_id !== assessment.review_id)
    || scan.review_records_with_allowed_mutation_fields.find(c => c.review_id !== assessment.review_id)
    || null;
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_promotion_check',
    id: intOrNull(id),
    review: detail.review,
    assessment,
    eligible_for_promotion: assessment.eligible_for_promotion,
    blockers: assessment.blockers,
    recommended_next_review_id: recommended?.review_id || null,
    recommended_next_review: recommended,
    opportunity_created: false,
    recommended_next_action: assessment.eligible_for_promotion
      ? 'Eligible for a future explicit promotion phase only; no normal opportunity is created in Phase 13M.'
      : (recommended
          ? `Review ${recommended.review_id} has allowed mutation fields and may be a better next human-review/promotion candidate; no normal opportunity is created in Phase 13M.`
          : 'No alternate review with allowed mutation fields found. No normal opportunity is created in Phase 13M.'),
    safety: phase13MPromotionSafety(),
    source: 'phase_13m_borderline_promotion_eligibility_v1',
  };
}

async function scanEbayListingQualityBorderlinePromotionCandidates({ limit = 20 } = {}) {
  const list = await listEbayListingQualityBorderlineReviews({ limit });
  const assessments = [];
  for (const review of list.reviews || []) {
    if (review.review_status === 'shortlisted' || review.status === 'reviewing') {
      assessments.push(await buildPhase13MPromotionAssessment(review));
    }
  }
  const eligible = assessments.filter(a => a.eligible_for_promotion);
  const ineligibleShortlisted = assessments.filter(a => a.review_status === 'shortlisted' && !a.eligible_for_promotion);
  const withAllowedMutationFields = assessments.filter(a => phase13MReviewHasAllowedMutationFields(a));
  const recommended = eligible[0] || withAllowedMutationFields.find(a => a.review_status !== 'shortlisted') || null;
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_borderline_promotion_candidates',
    limit: list.limit,
    scanned_count: assessments.length,
    eligible_promotion_count: eligible.length,
    eligible_promotion_candidates: eligible,
    ineligible_shortlisted_records: ineligibleShortlisted,
    review_records_with_allowed_mutation_fields: withAllowedMutationFields,
    recommended_next_review_id: recommended?.review_id || null,
    recommended_next_review: recommended,
    opportunity_created: false,
    recommended_next_action: eligible.length
      ? 'Eligible promotion candidates found for a later explicit phase only. Do not create a normal opportunity, packet, approval, execution-state change, or marketplace write in Phase 13M.'
      : (recommended
          ? `No shortlisted review is eligible yet; review ${recommended.review_id} has allowed mutation fields and may be the next review to shortlist.`
          : 'No eligible promotion candidates found and no alternate review with allowed mutation fields found.'),
    safety: phase13MPromotionSafety(),
    source: 'phase_13m_borderline_promotion_candidate_scan_v1',
  };
}


async function listPhase13OPromotedOpportunitiesForReview({ reviewId } = {}) {
  const id = intOrNull(reviewId);
  if (id == null) return [];
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('opportunity_type', 'listing_quality_improvement').eq('source_type', 'phase_13_borderline_review_promotion').order('created_at', { ascending: true }).limit(200)
  );
  return (rows || []).filter(row => intOrNull(row?.metadata?.source_review_id) === id);
}

function normalizePhase13OPromotedOpportunity(row = {}) {
  const metadata = row.metadata || {};
  return {
    id: row.id,
    opportunity_type: row.opportunity_type,
    source: row.source_type,
    status: row.status,
    title: row.title || metadata.title || null,
    item_id: metadata.item_id || metadata.target_item_id || null,
    sku: metadata.sku || null,
    source_review_id: metadata.source_review_id ?? null,
    not_listing_quality_low: metadata.not_listing_quality_low === true,
    requires_human_approval: metadata.requires_human_approval === true,
    not_execution_candidate: metadata.not_execution_candidate === true,
    proposed_mutation_fields: metadata.proposed_mutation_fields || [],
    allowed_mutation_fields: metadata.allowed_mutation_fields || [],
    human_review_status: metadata.human_review_status || null,
    reviewed_by: metadata.reviewed_by || null,
    reviewed_at: metadata.reviewed_at || null,
    review_reason: metadata.review_reason || null,
    still_not_execution_candidate: metadata.still_not_execution_candidate === true,
    packet_created: metadata.packet_created === true,
    approval_created: metadata.approval_created === true,
    execution_request_created: metadata.execution_request_created === true,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function buildPhase13OPromotedOpportunityRecord({ review, assessment } = {}) {
  const proposedFields = assessment?.proposed_mutation_fields || review?.proposed_mutation_fields || [];
  const allowedFields = assessment?.allowed_mutation_fields || phase13JAllowedProposedFields(proposedFields);
  return {
    opportunity_type: 'listing_quality_improvement',
    source_type: 'phase_13_borderline_review_promotion',
    input_channel: 'api',
    source_name: 'phase_13o_borderline_review_promotion',
    title: trimOrNull(review?.title || assessment?.title, 255),
    category: 'ebay_listing_quality',
    priority: 'normal',
    status: 'reviewing',
    notes: 'Promoted from an eligible shortlisted borderline review for human review only. No packet, approval, execution-state change, or marketplace write was created in Phase 13O.',
    metadata: {
      type: 'listing_quality_improvement',
      source: 'phase_13_borderline_review_promotion',
      phase: '13O',
      source_review_id: review?.id ?? assessment?.review_id ?? null,
      source_review_type: review?.type || 'listing_quality_borderline_review',
      source_review_source: review?.source || 'phase_13j_borderline_preview',
      item_id: assessment?.item_id || review?.item_id || null,
      target_item_id: assessment?.item_id || review?.item_id || null,
      sku: review?.sku || assessment?.item_id || null,
      title: review?.title || assessment?.title || null,
      score: assessment?.score ?? review?.score ?? null,
      review_status: review?.review_status || null,
      detected_gaps: assessment?.detected_gaps || review?.detected_gaps || [],
      proposed_mutation_fields: proposedFields,
      allowed_mutation_fields: allowedFields,
      proposed_mutation_preview: proposedFields.includes('item_specifics')
        ? { item_specifics: { required_human_review: true } }
        : {},
      not_listing_quality_low: true,
      requires_human_review: true,
      requires_human_approval: true,
      not_execution_candidate: true,
      promotion_eligible: assessment?.eligible_for_promotion === true,
      promotion_blockers: assessment?.blockers || [],
      evidence_source: assessment?.evidence_source || review?.evidence_source || [],
      evidence_metrics: assessment?.evidence_metrics || {},
      forbidden_field_check: {
        ...(assessment?.forbidden_field_check || {}),
        price_changes: false,
        inventory_changes: false,
        quantity_changes: false,
      },
      safety_boundary: {
        cached_evidence_only: true,
        no_ebay_call: true,
        no_get_item_call: true,
        no_marketplace_write: true,
        no_packet_created: true,
        no_approval_created: true,
        no_execution_state_change: true,
        price_changes: false,
        inventory_changes: false,
        quantity_changes: false,
        listing_changed: false,
      },
      recommended_next_action: 'Human review only. A later explicit phase may create packet/approval scaffolding; do not execute marketplace writes from this opportunity.',
    },
  };
}

async function promoteEbayListingQualityBorderlineReview({ id, dryRun = true, write = false } = {}) {
  const reviewId = intOrNull(id);
  if (reviewId == null) throw new Error('id is required');
  const writeRequested = write === true && dryRun === false;
  const before = {
    promoted_opportunities: (await listPhase13OPromotedOpportunitiesForReview({ reviewId })).length,
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };

  const check = await checkEbayListingQualityBorderlinePromotionEligibility({ id: reviewId });
  const review = check.review;
  const assessment = check.assessment;
  const existingRows = await listPhase13OPromotedOpportunitiesForReview({ reviewId });
  const plannedOpportunity = buildPhase13OPromotedOpportunityRecord({ review, assessment });
  const blockers = [...(assessment?.blockers || [])];
  if (!check.eligible_for_promotion) blockers.push('promotion_check_not_eligible');
  const uniqueBlockers = [...new Set(blockers)];

  let inserted = null;
  let existing = existingRows[0] || null;
  if (writeRequested && !existing && uniqueBlockers.length === 0) {
    const db = getClient();
    const { data, error } = await db
      .from(OPPORTUNITY_TABLE)
      .insert(plannedOpportunity)
      .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
      .single();
    if (error) throw error;
    inserted = data;
    existing = data;
  }

  const afterRows = await listPhase13OPromotedOpportunitiesForReview({ reviewId });
  const after = {
    promoted_opportunities: afterRows.length,
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  const existingOrCreated = existing || afterRows[0] || null;
  return {
    read_only: !writeRequested,
    dry_run: !writeRequested,
    write_requested: writeRequested,
    marketplace: 'ebay',
    operation: 'listing_quality_promote_borderline_review',
    id: reviewId,
    eligible_for_promotion: check.eligible_for_promotion,
    blockers: uniqueBlockers,
    source_review: review,
    assessment,
    planned_opportunity: plannedOpportunity,
    created: Boolean(inserted),
    idempotent_existing: Boolean(existingRows.length && !inserted),
    promoted_opportunity_id: existingOrCreated?.id || null,
    promoted_opportunity: existingOrCreated ? normalizePhase13OPromotedOpportunity(existingOrCreated) : null,
    existing_promoted_opportunity_count_before: before.promoted_opportunities,
    promoted_opportunity_count_after: after.promoted_opportunities,
    verification: {
      exactly_one_promoted_opportunity_for_review: after.promoted_opportunities === 1,
      promoted_opportunity_count_before: before.promoted_opportunities,
      promoted_opportunity_count_after: after.promoted_opportunities,
      duplicate_created: after.promoted_opportunities > Math.max(1, before.promoted_opportunities),
      normal_opportunity_created: Boolean(inserted),
      created_exactly_one_normal_internal_opportunity: Boolean(inserted) && after.promoted_opportunities === 1,
      packet_count_before: before.listing_quality_packets,
      packet_count_after: after.listing_quality_packets,
      packet_created: after.listing_quality_packets > before.listing_quality_packets,
      approval_request_count_before: before.execution_requests,
      approval_request_count_after: after.execution_requests,
      approval_created: after.execution_requests > before.execution_requests,
      execution_state_updated: false,
    },
    recommended_next_action: inserted
      ? 'Promoted to one normal internal human-review opportunity only. Do not create packet, approval, execution-state change, or marketplace write until a later explicit phase.'
      : (existingOrCreated
          ? 'Already promoted; returned the existing promoted opportunity. Do not create packet, approval, execution-state change, or marketplace write until a later explicit phase.'
          : (uniqueBlockers.length
              ? 'Promotion blocked by eligibility gates. No opportunity, packet, approval, execution-state change, or marketplace write was created.'
              : 'Dry-run only. Re-run with --write to create exactly one normal internal human-review opportunity.')),
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: Boolean(inserted),
      database_write_scope: inserted ? 'opportunity_inbox normal internal human-review opportunity only' : null,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      normal_opportunity_created: Boolean(inserted),
      packet_created: after.listing_quality_packets > before.listing_quality_packets,
      approval_created: after.execution_requests > before.execution_requests,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13o_borderline_review_promotion_v1',
  };
}


function phase13PPromotedOpportunitySafety({ databaseWrite = false } = {}) {
  return {
    cached_evidence_only: true,
    actual_ebay_call: false,
    get_item_called: false,
    actual_network_call: false,
    actual_database_write: databaseWrite === true,
    database_write_scope: databaseWrite === true ? 'opportunity_inbox promoted opportunity metadata/status only' : null,
    marketplace_write_performed: false,
    revise_fixed_price_item_called: false,
    normal_opportunity_created: false,
    packet_created: false,
    approval_created: false,
    execution_request_created: false,
    execution_state_changed: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    listing_changed: false,
  };
}

async function listEbayListingQualityPromotedOpportunities({ limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 20));
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('opportunity_type', 'listing_quality_improvement').eq('source_type', 'phase_13_borderline_review_promotion').order('created_at', { ascending: false }).limit(safeLimit)
  );
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_promoted_opportunity_list',
    limit: safeLimit,
    count: rows.length,
    promoted_opportunities: rows.map(normalizePhase13OPromotedOpportunity),
    recommended_next_action: rows.length
      ? 'Promoted opportunities are internal human-review records only. Use promoted-opportunity-action with --dry-run first; do not create packets, approvals, execution requests, or marketplace writes in Phase 13P.'
      : 'No promoted borderline opportunities found.',
    safety: phase13PPromotedOpportunitySafety(),
    source: 'phase_13p_promoted_opportunity_list_v1',
  };
}

async function getEbayListingQualityPromotedOpportunityDetail({ id } = {}) {
  const opportunityId = intOrNull(id);
  if (opportunityId == null) throw new Error('id is required');
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('id', opportunityId).eq('opportunity_type', 'listing_quality_improvement').eq('source_type', 'phase_13_borderline_review_promotion').limit(1)
  );
  const row = rows[0] || null;
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_promoted_opportunity_detail',
    id: opportunityId,
    found: Boolean(row),
    promoted_opportunity: row ? { ...normalizePhase13OPromotedOpportunity(row), notes: row.notes || null, metadata: row.metadata || {} } : null,
    recommended_next_action: row
      ? 'Promoted opportunity detail only. Use promoted-opportunity-action with --dry-run first; do not create packets, approvals, execution requests, or marketplace writes in Phase 13P.'
      : 'Promoted opportunity not found.',
    safety: phase13PPromotedOpportunitySafety(),
    source: 'phase_13p_promoted_opportunity_detail_v1',
  };
}

async function actOnEbayListingQualityPromotedOpportunity({ id, action, actor = null, reason = null, dryRun = true, write = false } = {}) {
  const opportunityId = intOrNull(id);
  if (opportunityId == null) throw new Error('id is required');
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['approve_for_packet', 'reject'].includes(normalizedAction)) throw new Error('action must be approve_for_packet or reject');
  const writeRequested = write === true && dryRun === false;
  const before = {
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  const detail = await getEbayListingQualityPromotedOpportunityDetail({ id: opportunityId });
  if (!detail.found) throw new Error(`promoted opportunity ${opportunityId} not found`);
  const current = detail.promoted_opportunity;
  const metadata = current.metadata || {};
  const reviewedAt = new Date().toISOString();
  const humanReviewStatus = normalizedAction === 'approve_for_packet' ? 'approved_for_packet' : 'rejected';
  const nextStatus = normalizedAction === 'reject' ? 'rejected' : 'reviewing';
  const nextMetadata = {
    ...metadata,
    human_review_status: humanReviewStatus,
    reviewed_by: actor || null,
    reviewed_at: reviewedAt,
    review_reason: reason || null,
    review_action: normalizedAction,
    still_not_execution_candidate: true,
    not_execution_candidate: true,
    requires_human_approval: true,
    not_listing_quality_low: true,
    packet_created: false,
    approval_created: false,
    execution_request_created: false,
    execution_state_changed: false,
    marketplace_write_performed: false,
    phase_13p_human_gate: true,
  };
  let updated = null;
  if (writeRequested) {
    const db = getClient();
    const { data, error } = await db
      .from(OPPORTUNITY_TABLE)
      .update({ status: nextStatus, metadata: nextMetadata, updated_at: reviewedAt })
      .eq('id', opportunityId)
      .eq('opportunity_type', 'listing_quality_improvement')
      .eq('source_type', 'phase_13_borderline_review_promotion')
      .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
      .single();
    if (error) throw error;
    updated = data;
  }
  const after = {
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  return {
    read_only: !writeRequested,
    dry_run: !writeRequested,
    write_requested: writeRequested,
    marketplace: 'ebay',
    operation: 'listing_quality_promoted_opportunity_action',
    id: opportunityId,
    action: normalizedAction,
    planned_decision: {
      human_review_status: humanReviewStatus,
      status: nextStatus,
      reviewed_by: actor || null,
      reviewed_at: reviewedAt,
      review_reason: reason || null,
      still_not_execution_candidate: true,
      packet_created: false,
    },
    before_promoted_opportunity: current,
    updated_promoted_opportunity: updated ? { ...normalizePhase13OPromotedOpportunity(updated), metadata: updated.metadata || {} } : null,
    verification: {
      human_review_status: updated?.metadata?.human_review_status || (writeRequested ? null : humanReviewStatus),
      approved_for_packet: (updated?.metadata?.human_review_status || humanReviewStatus) === 'approved_for_packet',
      still_not_execution_candidate: updated ? updated.metadata?.still_not_execution_candidate === true : true,
      packet_created_flag: updated ? updated.metadata?.packet_created === true : false,
      packet_count_before: before.listing_quality_packets,
      packet_count_after: after.listing_quality_packets,
      packet_created: after.listing_quality_packets > before.listing_quality_packets,
      approval_request_count_before: before.execution_requests,
      approval_request_count_after: after.execution_requests,
      approval_created: after.execution_requests > before.execution_requests,
      execution_request_count_before: before.execution_requests,
      execution_request_count_after: after.execution_requests,
      execution_request_created: after.execution_requests > before.execution_requests,
      execution_state_updated: false,
    },
    recommended_next_action: writeRequested
      ? 'Internal human decision recorded only. This remains not_execution_candidate; do not create packet, approval, execution request, execution-state change, or marketplace write without a later explicit phase.'
      : 'Dry-run only. Re-run with --write to update the internal promoted opportunity metadata/status only.',
    safety: phase13PPromotedOpportunitySafety({ databaseWrite: writeRequested }),
    source: 'phase_13p_promoted_opportunity_human_gate_v1',
  };
}


function pickAllowedPromotedPlannedMutation(metadata = {}) {
  const proposedFields = Array.isArray(metadata.proposed_mutation_fields) ? metadata.proposed_mutation_fields : [];
  const allowedFields = Array.isArray(metadata.allowed_mutation_fields) ? metadata.allowed_mutation_fields : phase13JAllowedProposedFields(proposedFields);
  const preview = metadata.proposed_mutation_preview && typeof metadata.proposed_mutation_preview === 'object'
    ? metadata.proposed_mutation_preview
    : {};
  const planned = {};
  if (allowedFields.includes('title') && typeof preview.title === 'string' && preview.title.trim()) planned.title = preview.title;
  if (allowedFields.includes('description') && typeof preview.description === 'string' && preview.description.trim()) planned.description = preview.description;
  if (allowedFields.includes('item_specifics')) {
    const itemSpecifics = preview.item_specifics && typeof preview.item_specifics === 'object' && !Array.isArray(preview.item_specifics)
      ? preview.item_specifics
      : {};
    planned.item_specifics = itemSpecifics;
  }
  return planned;
}

function buildPhase13QForbiddenFieldCheck(plannedMutation = {}, allowedFields = []) {
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  const payloadFields = Object.keys(plannedMutation || {});
  const nonAllowedFields = payloadFields.filter(field => !allowedFields.includes(field));
  return {
    forbidden_fields_present: forbiddenFields.length > 0 || nonAllowedFields.length > 0,
    forbidden_fields: forbiddenFields,
    non_allowed_fields: nonAllowedFields,
    allowed_mutation_fields: allowedFields,
    payload_fields: payloadFields,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    shipping_changes: false,
    payment_changes: false,
    returns_changes: false,
    listing_end_create_relist: false,
    sku_remapping: false,
  };
}

function buildPhase13QCachedEvidenceSnapshot(evidence = {}, score = {}) {
  return {
    source: 'cached_internal_data_only',
    source_tables: evidence.source_tables || score.evidence_source || [],
    item_id: evidence.item_id || score.item_id || null,
    sku: evidence.sku || score.sku || null,
    title: evidence.title || score.title || null,
    description_present: Boolean(evidence.description),
    description_length: evidence.description ? String(evidence.description).length : 0,
    item_specifics: evidence.item_specifics || {},
    item_specifics_count: Object.keys(evidence.item_specifics || {}).length,
    images_count: (evidence.images || []).length,
    policies_present: Boolean(evidence.policies),
    listing_status: evidence.listing_detail?.listing_status || score.evidence_metrics?.listing_status || null,
    listing_status_active: score.evidence_metrics?.listing_status_active === true,
    last_enriched_at: evidence.listing_detail?.last_enriched_at || null,
    limitations: evidence.limitations || [],
    live_marketplace_state_fetched: false,
    ebay_api_call_made: false,
  };
}

async function buildEbayListingQualityPromotedPacketPreview({ opportunityId } = {}) {
  const id = intOrNull(opportunityId);
  if (id == null) throw new Error('opportunity-id is required');
  const detail = await getEbayListingQualityPromotedOpportunityDetail({ id });
  if (!detail.found) throw new Error(`promoted opportunity ${id} not found`);
  const opportunity = detail.promoted_opportunity;
  const metadata = opportunity.metadata || {};
  const itemId = String(metadata.item_id || metadata.target_item_id || opportunity.item_id || '').trim();
  const allowedFields = phase13JAllowedProposedFields(metadata.allowed_mutation_fields || metadata.proposed_mutation_fields || []);
  const plannedMutation = pickAllowedPromotedPlannedMutation(metadata);
  const forbiddenFieldCheck = buildPhase13QForbiddenFieldCheck(plannedMutation, allowedFields);
  const evidence = itemId ? await loadPhase13GScoringEvidenceByItemId(itemId) : {};
  const score = scoreCachedListingQualityEvidence(evidence);
  const cachedEvidenceSnapshot = buildPhase13QCachedEvidenceSnapshot(evidence, score);
  const packetShape = {
    id: null,
    request_id: null,
    opportunity_id: id,
    source_review_id: metadata.source_review_id || opportunity.source_review_id || null,
    status: 'packet_preview_only',
    confirmation_status: 'not_created',
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    item_id: itemId || null,
    planned_mutation: plannedMutation,
    before_snapshot: {
      title: evidence.title || null,
      description: evidence.description || null,
      item_specifics: evidence.item_specifics || {},
      cached_evidence_snapshot: cachedEvidenceSnapshot,
    },
    rollback_snapshot: {
      title: evidence.title || null,
      description: evidence.description || null,
      item_specifics: evidence.item_specifics || {},
      available: Boolean(itemId && evidence.title && evidence.item_specifics && Object.keys(evidence.item_specifics || {}).length >= 0),
      source: 'phase_13q_cached_evidence_preview',
    },
    packet_hash: null,
  };
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet: packetShape });
  const blockers = [];
  if (opportunity.human_review_status !== 'approved_for_packet') blockers.push('human_review_status_not_approved_for_packet');
  if (opportunity.not_execution_candidate !== true) blockers.push('not_execution_candidate_not_true');
  if (metadata.not_listing_quality_low !== true) blockers.push('not_listing_quality_low_not_true');
  if (!itemId) blockers.push('item_id_missing');
  if (!allowedFields.length) blockers.push('allowed_mutation_fields_missing');
  if (!Object.prototype.hasOwnProperty.call(plannedMutation, 'item_specifics') && allowedFields.includes('item_specifics')) blockers.push('planned_item_specifics_missing');
  if (forbiddenFieldCheck.forbidden_fields_present) blockers.push('forbidden_or_non_allowed_fields_present');
  if (plannedMutation.title && !allowedFields.includes('title')) blockers.push('title_not_allowed');
  if (plannedMutation.description && !allowedFields.includes('description')) blockers.push('description_not_allowed');
  if (Object.keys(plannedMutation).some(field => ['price', 'quantity', 'qty', 'inventory', 'stock', 'shipping', 'payment', 'returns', 'end', 'create', 'relist'].includes(field))) blockers.push('forbidden_top_level_mutation_field_present');
  const before = {
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  const after = {
    execution_requests: await countRows(REQUEST_TABLE),
    listing_quality_packets: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  return {
    read_only: true,
    dry_run: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    preview_type: 'promoted_borderline_packet_preview',
    opportunity_id: id,
    source_review_id: metadata.source_review_id || opportunity.source_review_id || null,
    item_id: itemId || null,
    target_item_id: itemId || null,
    human_review_status: opportunity.human_review_status || null,
    packet_would_be_created: false,
    packet_created: false,
    approval_created: false,
    execution_request_created: false,
    packet_shape: packetShape,
    planned_mutation: plannedMutation,
    planned_mutation_fields: Object.keys(plannedMutation),
    allowed_mutation_fields: allowedFields,
    forbidden_field_check: forbiddenFieldCheck,
    cached_evidence_snapshot: cachedEvidenceSnapshot,
    rollback_snapshot: rollbackSnapshot,
    safety_gates: {
      human_review_approved_for_packet: opportunity.human_review_status === 'approved_for_packet',
      still_not_execution_candidate: opportunity.still_not_execution_candidate === true || metadata.still_not_execution_candidate === true,
      not_execution_candidate: opportunity.not_execution_candidate === true,
      packet_preview_only: true,
      packet_would_be_created: false,
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
      no_packet_created: true,
      no_approval_created: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      allowed_fields_only: forbiddenFieldCheck.non_allowed_fields.length === 0,
      forbidden_fields_absent: forbiddenFieldCheck.forbidden_fields.length === 0,
      no_price_inventory_quantity_fields: true,
      no_shipping_payment_returns_fields: true,
      no_end_create_relist_fields: true,
    },
    blockers: [...new Set(blockers)],
    verification: {
      packet_count_before: before.listing_quality_packets,
      packet_count_after: after.listing_quality_packets,
      packet_created: after.listing_quality_packets > before.listing_quality_packets,
      approval_request_count_before: before.execution_requests,
      approval_request_count_after: after.execution_requests,
      approval_created: after.execution_requests > before.execution_requests,
      execution_request_created: after.execution_requests > before.execution_requests,
      execution_state_updated: false,
    },
    recommended_next_action: 'Packet preview only. Do not create packet, approval request, execution request, execution-state change, or marketplace write until a later explicit phase.',
    safety: {
      cached_evidence_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      packet_created: false,
      approval_created: false,
      execution_request_created: false,
      execution_state_changed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    source: 'phase_13q_promoted_packet_preview_v1',
  };
}


function phase13RPromotedPacketSafety({ databaseWrite = false } = {}) {
  return {
    cached_evidence_only: true,
    actual_ebay_call: false,
    get_item_called: false,
    actual_network_call: false,
    actual_database_write: databaseWrite === true,
    database_write_scope: databaseWrite === true ? 'opportunity_inbox internal promoted packet artifact only' : null,
    marketplace_write_performed: false,
    revise_fixed_price_item_called: false,
    normal_opportunity_created: false,
    approval_created: false,
    execution_request_created: false,
    execution_state_changed: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    listing_changed: false,
  };
}

function normalizePhase13RPromotedPacketRow(row = {}) {
  const metadata = row.metadata || {};
  const packet = metadata.packet || {};
  return {
    id: row.id,
    opportunity_type: row.opportunity_type,
    source_type: row.source_type,
    status: row.status,
    title: row.title,
    source_promoted_opportunity_id: metadata.source_promoted_opportunity_id || packet.opportunity_id || null,
    opportunity_id: packet.opportunity_id || metadata.source_promoted_opportunity_id || null,
    source_review_id: packet.source_review_id || metadata.source_review_id || null,
    target_item_id: packet.target_item_id || packet.item_id || metadata.target_item_id || null,
    marketplace: packet.marketplace || metadata.marketplace || null,
    operation: packet.operation || metadata.operation || null,
    planned_mutation: packet.planned_mutation || {},
    planned_mutation_fields: packet.planned_mutation_fields || Object.keys(packet.planned_mutation || {}),
    cached_evidence_snapshot: packet.cached_evidence_snapshot || null,
    rollback_snapshot: packet.rollback_snapshot || null,
    packet_hash: packet.packet_hash || metadata.packet_hash || null,
    packet_status: packet.status || row.status || null,
    confirmation_status: packet.confirmation_status || metadata.confirmation_status || 'not_confirmed',
    confirmed_by_actor: packet.confirmed_by_actor || metadata.confirmed_by_actor || null,
    confirmation_reason: packet.confirmation_reason || metadata.confirmation_reason || null,
    confirmed_at: packet.confirmed_at || metadata.confirmed_at || null,
    confirmation_snapshot: packet.confirmation_snapshot || metadata.confirmation_snapshot || null,
    still_not_execution_candidate: packet.still_not_execution_candidate === true || metadata.still_not_execution_candidate === true || packet.not_execution_candidate === true || metadata.not_execution_candidate === true,
    not_execution_candidate: packet.not_execution_candidate === true || metadata.not_execution_candidate === true,
    request_id: packet.request_id || null,
    approval_request_id: packet.approval_request_id || null,
    execution_request_id: packet.execution_request_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata,
  };
}

async function listPhase13RPromotedPacketRows({ opportunityId, limit = 20 } = {}) {
  const id = intOrNull(opportunityId);
  if (id == null) throw new Error('opportunity-id is required');
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 20));
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q
      .eq('opportunity_type', 'listing_quality_update_packet')
      .eq('source_type', 'phase_13r_promoted_packet_creation')
      .contains('metadata', { source_promoted_opportunity_id: id })
      .order('created_at', { ascending: true })
      .limit(safeLimit)
  );
  return rows || [];
}

function buildPhase13RPacketRecordFromPreview(preview = {}) {
  const packetShape = preview.packet_shape || {};
  const packetHash = sha256Json({
    opportunity_id: preview.opportunity_id,
    source_review_id: preview.source_review_id,
    target_item_id: preview.target_item_id,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    planned_mutation: preview.planned_mutation || {},
    cached_evidence_snapshot_hash: sha256Json(preview.cached_evidence_snapshot || {}),
    rollback_snapshot_hash: sha256Json(preview.rollback_snapshot || {}),
    policy_version: 'phase-13r-promoted-packet-creation-v1',
  });
  const packet = {
    id: null,
    request_id: null,
    approval_request_id: null,
    execution_request_id: null,
    opportunity_id: preview.opportunity_id,
    source_review_id: preview.source_review_id,
    target_item_id: preview.target_item_id,
    item_id: preview.target_item_id,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    planned_mutation: preview.planned_mutation || {},
    planned_mutation_fields: Object.keys(preview.planned_mutation || {}),
    allowed_mutation_fields: preview.allowed_mutation_fields || [],
    cached_evidence_snapshot: preview.cached_evidence_snapshot || {},
    before_snapshot: packetShape.before_snapshot || {},
    rollback_snapshot: preview.rollback_snapshot || packetShape.rollback_snapshot || {},
    forbidden_field_check: preview.forbidden_field_check || {},
    safety_gates: {
      ...(preview.safety_gates || {}),
      packet_preview_only: false,
      packet_would_be_created: true,
      no_packet_created: false,
      no_approval_created: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
    },
    packet_hash: packetHash,
    status: 'packet_recorded',
    confirmation_status: 'not_confirmed',
    not_execution_candidate: true,
    created_by_phase: '13R',
    policy_version: 'phase-13r-promoted-packet-creation-v1',
  };
  return {
    opportunity_type: 'listing_quality_update_packet',
    source_type: 'phase_13r_promoted_packet_creation',
    input_channel: 'api',
    source_name: 'phase_13r_promoted_packet_creation',
    title: `eBay listing_quality_update packet for promoted opportunity ${preview.opportunity_id}`,
    category: 'ebay_listing_quality',
    priority: 'normal',
    status: 'packet_recorded',
    notes: 'Phase 13R internal packet artifact only. No approval request, execution request, execution-state mutation, eBay call, or marketplace write was created.',
    metadata: {
      type: 'listing_quality_update_packet',
      phase: '13R',
      source: 'phase_13r_promoted_packet_creation',
      source_promoted_opportunity_id: preview.opportunity_id,
      source_review_id: preview.source_review_id,
      target_item_id: preview.target_item_id,
      item_id: preview.target_item_id,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_hash: packetHash,
      packet,
      packet_created: true,
      approval_created: false,
      execution_request_created: false,
      execution_state_changed: false,
      marketplace_write_performed: false,
      not_execution_candidate: true,
      safety_boundary: {
        no_ebay_call: true,
        no_get_item_call: true,
        no_revise_fixed_price_item_call: true,
        no_marketplace_write: true,
        no_approval_created: true,
        no_execution_request_created: true,
        no_execution_state_change: true,
        price_changes: false,
        inventory_changes: false,
        quantity_changes: false,
        listing_changed: false,
      },
    },
  };
}

async function getEbayListingQualityPromotedPacketDetail({ opportunityId = null, packetId = null } = {}) {
  const id = intOrNull(opportunityId);
  const pId = intOrNull(packetId);
  const rows = pId != null
    ? await safeSelectRows(
      OPPORTUNITY_TABLE,
      'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
      q => q.eq('id', pId).eq('opportunity_type', 'listing_quality_update_packet').limit(1)
    )
    : await listPhase13RPromotedPacketRows({ opportunityId: id, limit: 20 });
  const packets = (rows || []).map(normalizePhase13RPromotedPacketRow);
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    opportunity_id: id || packets[0]?.opportunity_id || null,
    packet_id: pId || packets[0]?.id || null,
    found: packets.length > 0,
    count: packets.length,
    packets,
    promoted_packet: packets[0] || null,
    verification: {
      exactly_one_packet_for_opportunity: id != null ? packets.length === 1 : null,
      planned_mutation_fields: packets[0]?.planned_mutation_fields || [],
      planned_mutation_item_specifics_only: packets[0]
        ? JSON.stringify(packets[0].planned_mutation_fields || []) === JSON.stringify(['item_specifics'])
        : null,
      confirmation_status: packets[0]?.confirmation_status || null,
      not_execution_candidate: packets[0]?.not_execution_candidate === true,
      approval_request_id: packets[0]?.approval_request_id || null,
      execution_request_id: packets[0]?.execution_request_id || null,
    },
    safety: phase13RPromotedPacketSafety({ databaseWrite: false }),
    source: 'phase_13r_promoted_packet_detail_v1',
  };
}

async function createEbayListingQualityPromotedPacket({ opportunityId, dryRun = true, write = false } = {}) {
  const id = intOrNull(opportunityId);
  if (id == null) throw new Error('opportunity-id is required');
  const writeRequested = write === true || dryRun === false;
  const before = {
    promoted_packet_rows: await listPhase13RPromotedPacketRows({ opportunityId: id, limit: 50 }),
    execution_requests_for_opportunity: await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', id).limit(50)),
    execution_requests_total: await countRows(REQUEST_TABLE),
    legacy_packet_rows_total: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
  };
  const existingRows = before.promoted_packet_rows || [];
  const preview = await buildEbayListingQualityPromotedPacketPreview({ opportunityId: id });
  const record = buildPhase13RPacketRecordFromPreview(preview);
  const plannedFields = Object.keys(record.metadata.packet.planned_mutation || {});
  const blockers = [...(preview.blockers || [])];
  if (preview.human_review_status !== 'approved_for_packet') blockers.push('human_review_status_not_approved_for_packet');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (preview.forbidden_field_check?.forbidden_fields_present === true) blockers.push('forbidden_fields_present');
  if (existingRows.length > 1) blockers.push('duplicate_promoted_packet_rows_exist');
  const uniqueBlockers = [...new Set(blockers)];
  const existingPacket = existingRows.length === 1 ? normalizePhase13RPromotedPacketRow(existingRows[0]) : null;

  if (uniqueBlockers.length) {
    if (writeRequested) throw new Error(`promoted packet creation blocked: ${uniqueBlockers.join(', ')}`);
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      opportunity_id: id,
      created: false,
      idempotent_existing: Boolean(existingPacket),
      blocked: true,
      blockers: uniqueBlockers,
      existing_packet: existingPacket,
      packet_preview: record.metadata.packet,
      record_preview: record,
      verification: {
        packet_count_for_opportunity_before: existingRows.length,
        packet_count_for_opportunity_after: existingRows.length,
        exactly_one_packet_for_opportunity: existingRows.length === 1,
        planned_mutation_item_specifics_only: plannedFields.length === 1 && plannedFields[0] === 'item_specifics',
        approval_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
        approval_request_count_for_opportunity_after: before.execution_requests_for_opportunity.length,
        execution_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
        execution_request_count_for_opportunity_after: before.execution_requests_for_opportunity.length,
      },
      safety: phase13RPromotedPacketSafety({ databaseWrite: false }),
      source: 'phase_13r_promoted_packet_creation_v1',
    };
  }

  if (!writeRequested) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      opportunity_id: id,
      created: false,
      idempotent_existing: Boolean(existingPacket),
      blocked: false,
      blockers: [],
      existing_packet: existingPacket,
      packet_preview: record.metadata.packet,
      record_preview: record,
      verification: {
        packet_count_for_opportunity_before: existingRows.length,
        packet_count_for_opportunity_after: existingRows.length,
        exactly_one_packet_for_opportunity: existingRows.length === 1,
        planned_mutation_item_specifics_only: plannedFields.length === 1 && plannedFields[0] === 'item_specifics',
        approval_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
        approval_request_count_for_opportunity_after: before.execution_requests_for_opportunity.length,
        execution_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
        execution_request_count_for_opportunity_after: before.execution_requests_for_opportunity.length,
        legacy_packet_count_before: before.legacy_packet_rows_total,
        legacy_packet_count_after: before.legacy_packet_rows_total,
      },
      safety: phase13RPromotedPacketSafety({ databaseWrite: false }),
      recommended_next_action: 'Dry-run only. Re-run with --write to create exactly one internal promoted packet artifact; do not create approval/execution requests or marketplace writes.',
      source: 'phase_13r_promoted_packet_creation_v1',
    };
  }

  if (existingPacket) {
    const afterRequests = await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', id).limit(50));
    return {
      read_only: false,
      dry_run: false,
      write_requested: true,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      opportunity_id: id,
      created: false,
      idempotent_existing: true,
      blocked: false,
      blockers: [],
      packet: existingPacket,
      verification: {
        packet_count_for_opportunity_before: existingRows.length,
        packet_count_for_opportunity_after: existingRows.length,
        exactly_one_packet_for_opportunity: existingRows.length === 1,
        planned_mutation_fields: existingPacket.planned_mutation_fields,
        planned_mutation_item_specifics_only: JSON.stringify(existingPacket.planned_mutation_fields) === JSON.stringify(['item_specifics']),
        approval_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
        approval_request_count_for_opportunity_after: afterRequests.length,
        approval_request_created: afterRequests.length > before.execution_requests_for_opportunity.length,
        execution_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
        execution_request_count_for_opportunity_after: afterRequests.length,
        execution_request_created: afterRequests.length > before.execution_requests_for_opportunity.length,
        legacy_packet_count_before: before.legacy_packet_rows_total,
        legacy_packet_count_after: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
      },
      safety: phase13RPromotedPacketSafety({ databaseWrite: false }),
      recommended_next_action: 'Existing internal promoted packet returned idempotently. Do not create approval/execution requests or marketplace writes until a later explicit phase.',
      source: 'phase_13r_promoted_packet_creation_v1',
    };
  }

  const db = getClient();
  const { data: inserted, error } = await db
    .from(OPPORTUNITY_TABLE)
    .insert(record)
    .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
    .single();
  if (error) throw error;
  const afterRows = await listPhase13RPromotedPacketRows({ opportunityId: id, limit: 50 });
  const afterRequests = await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', id).limit(50));
  const normalized = normalizePhase13RPromotedPacketRow(inserted);
  return {
    read_only: false,
    dry_run: false,
    write_requested: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    opportunity_id: id,
    created: true,
    idempotent_existing: false,
    blocked: false,
    blockers: [],
    packet: normalized,
    verification: {
      packet_count_for_opportunity_before: existingRows.length,
      packet_count_for_opportunity_after: afterRows.length,
      exactly_one_packet_for_opportunity: afterRows.length === 1,
      planned_mutation_fields: normalized.planned_mutation_fields,
      planned_mutation_item_specifics_only: JSON.stringify(normalized.planned_mutation_fields) === JSON.stringify(['item_specifics']),
      packet_hash_present: Boolean(normalized.packet_hash),
      confirmation_status: normalized.confirmation_status,
      not_execution_candidate: normalized.not_execution_candidate === true,
      approval_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
      approval_request_count_for_opportunity_after: afterRequests.length,
      approval_request_created: afterRequests.length > before.execution_requests_for_opportunity.length,
      no_approval_request_for_new_packet: normalized.approval_request_id == null && afterRequests.length === before.execution_requests_for_opportunity.length,
      execution_request_count_for_opportunity_before: before.execution_requests_for_opportunity.length,
      execution_request_count_for_opportunity_after: afterRequests.length,
      execution_request_created: afterRequests.length > before.execution_requests_for_opportunity.length,
      no_execution_request_for_new_packet: normalized.execution_request_id == null && afterRequests.length === before.execution_requests_for_opportunity.length,
      legacy_packet_count_before: before.legacy_packet_rows_total,
      legacy_packet_count_after: await countRows(EBAY_LISTING_QUALITY_PACKET_TABLE),
    },
    safety: phase13RPromotedPacketSafety({ databaseWrite: true }),
    recommended_next_action: 'Internal promoted packet artifact created only. Do not create approval/execution requests or marketplace writes until a later explicit phase.',
    source: 'phase_13r_promoted_packet_creation_v1',
  };
}


function phase13SPromotedPacketSafety({ databaseWrite = false } = {}) {
  return {
    cached_evidence_only: true,
    actual_ebay_call: false,
    get_item_called: false,
    actual_network_call: false,
    actual_database_write: databaseWrite === true,
    database_write_scope: databaseWrite === true ? 'opportunity_inbox promoted packet confirmation metadata/status only' : null,
    marketplace_write_performed: false,
    revise_fixed_price_item_called: false,
    normal_opportunity_created: false,
    approval_created: false,
    execution_request_created: false,
    execution_state_changed: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    listing_changed: false,
  };
}

function buildPhase13SPromotedPacketConfirmationSnapshot({ row, packet, actor, reason, confirmedAt, executionRequestsForOpportunity = [] } = {}) {
  return {
    packet_artifact_id: row?.id || null,
    source_type: row?.source_type || null,
    status_before: row?.status || null,
    confirmation_status_before: packet?.confirmation_status || 'not_confirmed',
    source_promoted_opportunity_id: packet?.opportunity_id || null,
    source_review_id: packet?.source_review_id || null,
    target_item_id: packet?.target_item_id || packet?.item_id || null,
    marketplace: packet?.marketplace || 'ebay',
    operation: packet?.operation || 'listing_quality_update',
    actor,
    reason,
    confirmed_at: confirmedAt,
    packet_hash: packet?.packet_hash || null,
    planned_mutation: packet?.planned_mutation || {},
    planned_mutation_hash: sha256Json(packet?.planned_mutation || {}),
    rollback_snapshot_hash: sha256Json(packet?.rollback_snapshot || {}),
    approval_request_count_for_source_opportunity: executionRequestsForOpportunity.length,
    execution_request_count_for_source_opportunity: executionRequestsForOpportunity.length,
    still_not_execution_candidate: true,
    safety: {
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
      no_approval_created: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    policy_version: 'phase-13s-promoted-packet-confirmation-v1',
  };
}

function validatePhase13SPromotedPacketConfirmation({ row, packet, actor, reason, executionRequestsForOpportunity = [], dryRun = true } = {}) {
  const blockers = [];
  const plannedMutation = packet?.planned_mutation || {};
  const plannedFields = Object.keys(plannedMutation || {});
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  if (!row) blockers.push('packet_artifact_missing');
  if (row && row.opportunity_type !== 'listing_quality_update_packet') blockers.push('opportunity_type_not_listing_quality_update_packet');
  if (row && row.source_type !== 'phase_13r_promoted_packet_creation') blockers.push('source_type_not_phase_13r_promoted_packet_creation');
  if (row && row.status !== 'packet_recorded') blockers.push('packet_status_not_packet_recorded');
  if ((packet?.confirmation_status || 'not_confirmed') !== 'not_confirmed') blockers.push('confirmation_status_not_not_confirmed');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');
  if (packet?.target_item_id !== '206315990948' && packet?.item_id !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if (packet?.request_id != null) blockers.push('request_id_present');
  if (packet?.approval_request_id != null) blockers.push('approval_request_id_present');
  if (packet?.execution_request_id != null) blockers.push('execution_request_id_present');
  if (executionRequestsForOpportunity.length > 0) blockers.push('approval_or_execution_request_exists_for_source_opportunity');
  if (dryRun === false && !actor) blockers.push('actor_required');
  if (dryRun === false && !reason) blockers.push('reason_required');
  return {
    blockers: [...new Set(blockers)],
    planned_mutation_fields: plannedFields,
    forbidden_fields: forbiddenFields,
    planned_mutation_item_specifics_only: plannedFields.length === 1 && plannedFields[0] === 'item_specifics',
  };
}

async function confirmEbayListingQualityPromotedPacket({ packetId, actor = null, reason = null, dryRun = true, write = false } = {}) {
  const id = intOrNull(packetId);
  if (id == null) throw new Error('packet-id is required');
  const writeRequested = write === true || dryRun === false;
  const confirmActor = trimOrNull(actor, 100);
  const confirmReason = trimOrNull(reason, 1000);
  const detail = await getEbayListingQualityPromotedPacketDetail({ packetId: id });
  const row = detail.packets?.[0] ? (await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('id', id).limit(1)
  ))[0] : null;
  const current = row ? normalizePhase13RPromotedPacketRow(row) : null;
  const packet = row?.metadata?.packet || {};
  const sourceOpportunityId = current?.opportunity_id || packet.opportunity_id || row?.metadata?.source_promoted_opportunity_id || null;
  const beforeRequests = sourceOpportunityId != null
    ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
    : [];
  const validation = validatePhase13SPromotedPacketConfirmation({
    row,
    packet,
    actor: confirmActor,
    reason: confirmReason,
    executionRequestsForOpportunity: beforeRequests,
    dryRun: !writeRequested,
  });
  const confirmedAt = new Date().toISOString();
  const confirmationSnapshot = buildPhase13SPromotedPacketConfirmationSnapshot({
    row,
    packet,
    actor: confirmActor,
    reason: confirmReason,
    confirmedAt,
    executionRequestsForOpportunity: beforeRequests,
  });
  const nextPacket = {
    ...packet,
    confirmation_status: 'confirmed',
    confirmed_by_actor: confirmActor,
    confirmation_reason: confirmReason,
    confirmed_at: confirmedAt,
    confirmation_snapshot: confirmationSnapshot,
    still_not_execution_candidate: true,
    not_execution_candidate: true,
    approval_request_id: null,
    execution_request_id: null,
    request_id: null,
  };
  const nextMetadata = {
    ...(row?.metadata || {}),
    phase_13s_promoted_packet_confirmation: true,
    confirmation_status: 'confirmed',
    confirmed_by_actor: confirmActor,
    confirmation_reason: confirmReason,
    confirmed_at: confirmedAt,
    confirmation_snapshot: confirmationSnapshot,
    still_not_execution_candidate: true,
    not_execution_candidate: true,
    approval_created: false,
    execution_request_created: false,
    execution_state_changed: false,
    marketplace_write_performed: false,
    packet: nextPacket,
    safety_boundary: {
      ...((row?.metadata || {}).safety_boundary || {}),
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
      no_approval_created: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
  };

  if (validation.blockers.length) {
    if (writeRequested) throw new Error(`promoted packet confirmation blocked: ${validation.blockers.join(', ')}`);
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_id: id,
      updated: false,
      blocked: true,
      blockers: validation.blockers,
      before_packet: current,
      planned_update: {
        confirmation_status: 'confirmed',
        confirmed_by_actor: confirmActor,
        confirmation_reason: confirmReason,
        confirmed_at: confirmedAt,
        still_not_execution_candidate: true,
      },
      confirmation_snapshot: confirmationSnapshot,
      verification: {
        packet_exists: Boolean(row),
        source_type: row?.source_type || null,
        status: row?.status || null,
        confirmation_status: packet?.confirmation_status || 'not_confirmed',
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields: validation.forbidden_fields,
        target_item_id: packet?.target_item_id || packet?.item_id || null,
        approval_request_count_for_source_opportunity_before: beforeRequests.length,
        execution_request_count_for_source_opportunity_before: beforeRequests.length,
      },
      safety: phase13SPromotedPacketSafety({ databaseWrite: false }),
      source: 'phase_13s_promoted_packet_confirmation_v1',
    };
  }

  if (!writeRequested) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_id: id,
      updated: false,
      blocked: false,
      blockers: [],
      before_packet: current,
      planned_update: {
        confirmation_status: 'confirmed',
        confirmed_by_actor: confirmActor,
        confirmation_reason: confirmReason,
        confirmed_at: confirmedAt,
        still_not_execution_candidate: true,
      },
      confirmation_snapshot: confirmationSnapshot,
      verification: {
        packet_exists: true,
        source_type_valid: row.source_type === 'phase_13r_promoted_packet_creation',
        status_packet_recorded: row.status === 'packet_recorded',
        confirmation_status_not_confirmed: (packet.confirmation_status || 'not_confirmed') === 'not_confirmed',
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields_absent: validation.forbidden_fields.length === 0,
        target_item_id: packet?.target_item_id || packet?.item_id || null,
        target_item_id_valid: (packet?.target_item_id || packet?.item_id) === '206315990948',
        approval_request_count_for_source_opportunity_before: beforeRequests.length,
        approval_request_count_for_source_opportunity_after: beforeRequests.length,
        execution_request_count_for_source_opportunity_before: beforeRequests.length,
        execution_request_count_for_source_opportunity_after: beforeRequests.length,
      },
      safety: phase13SPromotedPacketSafety({ databaseWrite: false }),
      recommended_next_action: 'Dry-run only. Re-run with --write to confirm the internal promoted packet artifact; do not create approval/execution requests or marketplace writes.',
      source: 'phase_13s_promoted_packet_confirmation_v1',
    };
  }

  const db = getClient();
  const { data: updated, error } = await db
    .from(OPPORTUNITY_TABLE)
    .update({ status: 'packet_recorded', metadata: nextMetadata, updated_at: confirmedAt })
    .eq('id', id)
    .eq('opportunity_type', 'listing_quality_update_packet')
    .eq('source_type', 'phase_13r_promoted_packet_creation')
    .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
    .single();
  if (error) throw error;
  const after = normalizePhase13RPromotedPacketRow(updated);
  const afterRequests = sourceOpportunityId != null
    ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
    : [];
  return {
    read_only: false,
    dry_run: false,
    write_requested: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    packet_id: id,
    updated: true,
    blocked: false,
    blockers: [],
    before_packet: current,
    after_packet: after,
    confirmation_snapshot: confirmationSnapshot,
    verification: {
      packet_id: after.id,
      confirmation_status: after.confirmation_status,
      confirmed_by_actor: after.confirmed_by_actor,
      confirmation_reason: after.confirmation_reason,
      confirmed_at: after.confirmed_at,
      still_not_execution_candidate: after.still_not_execution_candidate === true,
      not_execution_candidate: after.not_execution_candidate === true,
      planned_mutation_fields: after.planned_mutation_fields,
      planned_mutation_item_specifics_only: JSON.stringify(after.planned_mutation_fields || []) === JSON.stringify(['item_specifics']),
      approval_request_count_for_source_opportunity_before: beforeRequests.length,
      approval_request_count_for_source_opportunity_after: afterRequests.length,
      approval_request_created: afterRequests.length > beforeRequests.length,
      execution_request_count_for_source_opportunity_before: beforeRequests.length,
      execution_request_count_for_source_opportunity_after: afterRequests.length,
      execution_request_created: afterRequests.length > beforeRequests.length,
      execution_state_updated: false,
    },
    safety: phase13SPromotedPacketSafety({ databaseWrite: true }),
    recommended_next_action: 'Internal promoted packet confirmation recorded only. Do not create approval/execution requests or marketplace writes until a later explicit phase.',
    source: 'phase_13s_promoted_packet_confirmation_v1',
  };
}


function phase13TPromotedApprovalSafety({ databaseWrite = false } = {}) {
  return {
    cached_evidence_only: true,
    actual_ebay_call: false,
    get_item_called: false,
    actual_network_call: false,
    actual_database_write: databaseWrite === true,
    database_write_scope: databaseWrite === true ? 'opportunity_inbox internal promoted approval request only' : null,
    marketplace_write_performed: false,
    revise_fixed_price_item_called: false,
    packet_created: false,
    approval_created: databaseWrite === true,
    execution_request_created: false,
    execution_state_changed: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    listing_changed: false,
  };
}

function normalizePhase13TPromotedApprovalRow(row = {}) {
  const metadata = row.metadata || {};
  const approval = metadata.approval_request || {};
  return {
    id: row.id,
    opportunity_type: row.opportunity_type,
    source_type: row.source_type,
    status: row.status,
    title: row.title,
    packet_artifact_id: approval.packet_artifact_id || metadata.packet_artifact_id || null,
    opportunity_id: approval.opportunity_id || metadata.source_promoted_opportunity_id || null,
    source_review_id: approval.source_review_id || metadata.source_review_id || null,
    target_item_id: approval.target_item_id || metadata.target_item_id || null,
    marketplace: approval.marketplace || metadata.marketplace || null,
    operation: approval.operation || metadata.operation || null,
    planned_mutation: approval.planned_mutation || {},
    planned_mutation_fields: approval.planned_mutation_fields || Object.keys(approval.planned_mutation || {}),
    approval_status: approval.approval_status || metadata.approval_status || row.status || null,
    approved_by_actor: approval.approved_by_actor || metadata.approved_by_actor || null,
    approval_reason: approval.approval_reason || metadata.approval_reason || null,
    approved_at: approval.approved_at || metadata.approved_at || null,
    rejected_by_actor: approval.rejected_by_actor || metadata.rejected_by_actor || null,
    rejection_reason: approval.rejection_reason || metadata.rejection_reason || null,
    rejected_at: approval.rejected_at || metadata.rejected_at || null,
    final_operator_approval: approval.final_operator_approval === true || metadata.final_operator_approval === true,
    still_not_execution_candidate: approval.still_not_execution_candidate === true || metadata.still_not_execution_candidate === true || approval.not_execution_candidate === true || metadata.not_execution_candidate === true,
    not_execution_candidate: approval.not_execution_candidate === true || metadata.not_execution_candidate === true,
    requires_final_operator_approval: approval.requires_final_operator_approval === true || metadata.requires_final_operator_approval === true,
    execution_request_id: approval.execution_request_id || null,
    request_id: approval.request_id || null,
    packet_hash: approval.packet_hash || metadata.packet_hash || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata,
  };
}

async function listPhase13TPromotedApprovalRows({ packetId, limit = 20 } = {}) {
  const id = intOrNull(packetId);
  if (id == null) throw new Error('packet-id is required');
  const safeLimit = Math.min(100, Math.max(1, intOrNull(limit) || 20));
  const rows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q
      .eq('opportunity_type', 'listing_quality_update_approval_request')
      .eq('source_type', 'phase_13t_promoted_approval_request')
      .contains('metadata', { packet_artifact_id: id })
      .order('created_at', { ascending: true })
      .limit(safeLimit)
  );
  return rows || [];
}

function buildPhase13TPromotedApprovalRecord({ packetRow, packet, normalizedPacket, createdAt } = {}) {
  const plannedMutation = packet?.planned_mutation || {};
  const approvalRequest = {
    id: null,
    request_id: null,
    execution_request_id: null,
    packet_artifact_id: normalizedPacket.id,
    opportunity_id: normalizedPacket.opportunity_id,
    source_review_id: normalizedPacket.source_review_id,
    target_item_id: normalizedPacket.target_item_id,
    item_id: normalizedPacket.target_item_id,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    planned_mutation: plannedMutation,
    planned_mutation_fields: Object.keys(plannedMutation),
    approval_status: 'pending',
    not_execution_candidate: true,
    requires_final_operator_approval: true,
    packet_confirmation_status: normalizedPacket.confirmation_status,
    packet_confirmed_at: normalizedPacket.confirmed_at || null,
    packet_confirmed_by_actor: normalizedPacket.confirmed_by_actor || null,
    packet_hash: normalizedPacket.packet_hash || null,
    created_at: createdAt,
    policy_version: 'phase-13t-promoted-approval-request-v1',
    safety: {
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
  };
  return {
    opportunity_type: 'listing_quality_update_approval_request',
    source_type: 'phase_13t_promoted_approval_request',
    input_channel: 'api',
    source_name: 'phase_13t_promoted_approval_request',
    title: `eBay listing_quality_update approval request for promoted packet ${normalizedPacket.id}`,
    category: 'ebay_listing_quality',
    priority: 'normal',
    status: 'approval_pending',
    notes: 'Phase 13T internal approval request only. No execution request, execution-state mutation, eBay call, or marketplace write was created.',
    metadata: {
      type: 'listing_quality_update_approval_request',
      phase: '13T',
      source: 'phase_13t_promoted_approval_request',
      packet_artifact_id: normalizedPacket.id,
      source_promoted_opportunity_id: normalizedPacket.opportunity_id,
      source_review_id: normalizedPacket.source_review_id,
      target_item_id: normalizedPacket.target_item_id,
      item_id: normalizedPacket.target_item_id,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_hash: normalizedPacket.packet_hash || null,
      approval_status: 'pending',
      not_execution_candidate: true,
      requires_final_operator_approval: true,
      execution_request_created: false,
      execution_state_changed: false,
      marketplace_write_performed: false,
      approval_request: approvalRequest,
      source_packet_snapshot: {
        id: normalizedPacket.id,
        source_type: packetRow?.source_type || null,
        status: normalizedPacket.status,
        confirmation_status: normalizedPacket.confirmation_status,
        confirmed_by_actor: normalizedPacket.confirmed_by_actor || null,
        confirmed_at: normalizedPacket.confirmed_at || null,
        planned_mutation_fields: normalizedPacket.planned_mutation_fields || [],
        not_execution_candidate: normalizedPacket.not_execution_candidate === true,
      },
      safety_boundary: {
        no_ebay_call: true,
        no_get_item_call: true,
        no_revise_fixed_price_item_call: true,
        no_marketplace_write: true,
        no_execution_request_created: true,
        no_execution_state_change: true,
        price_changes: false,
        inventory_changes: false,
        quantity_changes: false,
        listing_changed: false,
      },
    },
  };
}

function validatePhase13TPromotedApprovalCreation({ packetRow, packet, normalizedPacket, existingApprovals = [], executionRequestsForOpportunity = [] } = {}) {
  const blockers = [];
  const plannedMutation = packet?.planned_mutation || {};
  const plannedFields = Object.keys(plannedMutation || {});
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  if (!packetRow) blockers.push('packet_artifact_missing');
  if (packetRow && packetRow.opportunity_type !== 'listing_quality_update_packet') blockers.push('packet_opportunity_type_not_listing_quality_update_packet');
  if (packetRow && packetRow.source_type !== 'phase_13r_promoted_packet_creation') blockers.push('packet_source_type_not_phase_13r_promoted_packet_creation');
  if (packetRow && packetRow.status !== 'packet_recorded') blockers.push('packet_status_not_packet_recorded');
  if (normalizedPacket?.confirmation_status !== 'confirmed') blockers.push('packet_confirmation_status_not_confirmed');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');
  if (normalizedPacket?.target_item_id !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if (normalizedPacket?.not_execution_candidate !== true) blockers.push('packet_not_execution_candidate_not_true');
  if (normalizedPacket?.request_id != null) blockers.push('packet_request_id_present');
  if (normalizedPacket?.execution_request_id != null) blockers.push('packet_execution_request_id_present');
  if (executionRequestsForOpportunity.length > 0) blockers.push('execution_request_exists_for_source_opportunity');
  if (existingApprovals.length > 1) blockers.push('duplicate_promoted_approval_requests_exist');
  return {
    blockers: [...new Set(blockers)],
    planned_mutation_fields: plannedFields,
    forbidden_fields: forbiddenFields,
    planned_mutation_item_specifics_only: plannedFields.length === 1 && plannedFields[0] === 'item_specifics',
  };
}

async function getEbayListingQualityPromotedApprovalDetail({ packetId = null, approvalId = null } = {}) {
  const pId = intOrNull(packetId);
  const aId = intOrNull(approvalId);
  if (pId == null && aId == null) throw new Error('packet-id or approval-id is required');
  const rows = aId != null
    ? await safeSelectRows(
      OPPORTUNITY_TABLE,
      'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
      q => q.eq('id', aId).eq('opportunity_type', 'listing_quality_update_approval_request').limit(1)
    )
    : await listPhase13TPromotedApprovalRows({ packetId: pId, limit: 50 });
  const approvals = rows.map(normalizePhase13TPromotedApprovalRow);
  return {
    read_only: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    packet_id: pId || approvals[0]?.packet_artifact_id || null,
    approval_id: aId || approvals[0]?.id || null,
    found: approvals.length > 0,
    count: approvals.length,
    approvals,
    promoted_approval: approvals[0] || null,
    verification: {
      exactly_one_approval_for_packet: pId != null ? approvals.length === 1 : null,
      approval_status: approvals[0]?.approval_status || null,
      final_operator_approval: approvals[0]?.final_operator_approval === true,
      approved_by_actor: approvals[0]?.approved_by_actor || null,
      approval_reason: approvals[0]?.approval_reason || null,
      approved_at: approvals[0]?.approved_at || null,
      packet_artifact_id: approvals[0]?.packet_artifact_id || null,
      opportunity_id: approvals[0]?.opportunity_id || null,
      source_review_id: approvals[0]?.source_review_id || null,
      target_item_id: approvals[0]?.target_item_id || null,
      planned_mutation_fields: approvals[0]?.planned_mutation_fields || [],
      planned_mutation_item_specifics_only: approvals[0]
        ? JSON.stringify(approvals[0].planned_mutation_fields || []) === JSON.stringify(['item_specifics'])
        : null,
      not_execution_candidate: approvals[0]?.not_execution_candidate === true,
      still_not_execution_candidate: approvals[0]?.still_not_execution_candidate === true,
      requires_final_operator_approval: approvals[0]?.requires_final_operator_approval === true,
      execution_request_id: approvals[0]?.execution_request_id || null,
    },
    safety: phase13TPromotedApprovalSafety({ databaseWrite: false }),
    source: 'phase_13t_promoted_approval_detail_v1',
  };
}

async function createEbayListingQualityPromotedApproval({ packetId, dryRun = true, write = false } = {}) {
  const id = intOrNull(packetId);
  if (id == null) throw new Error('packet-id is required');
  const writeRequested = write === true || dryRun === false;
  const packetRows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('id', id).eq('opportunity_type', 'listing_quality_update_packet').limit(1)
  );
  const packetRow = packetRows[0] || null;
  const normalizedPacket = packetRow ? normalizePhase13RPromotedPacketRow(packetRow) : null;
  const packet = packetRow?.metadata?.packet || {};
  const sourceOpportunityId = normalizedPacket?.opportunity_id || packet?.opportunity_id || null;
  const before = {
    existing_approvals: await listPhase13TPromotedApprovalRows({ packetId: id, limit: 50 }),
    execution_requests_for_opportunity: sourceOpportunityId != null
      ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
      : [],
  };
  const existingApproval = before.existing_approvals.length === 1 ? normalizePhase13TPromotedApprovalRow(before.existing_approvals[0]) : null;
  const createdAt = new Date().toISOString();
  const record = packetRow ? buildPhase13TPromotedApprovalRecord({ packetRow, packet, normalizedPacket, createdAt }) : null;
  const validation = validatePhase13TPromotedApprovalCreation({
    packetRow,
    packet,
    normalizedPacket,
    existingApprovals: before.existing_approvals,
    executionRequestsForOpportunity: before.execution_requests_for_opportunity,
  });
  if (validation.blockers.length) {
    if (writeRequested && !existingApproval) throw new Error(`promoted approval creation blocked: ${validation.blockers.join(', ')}`);
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_id: id,
      created: false,
      idempotent_existing: Boolean(existingApproval),
      blocked: true,
      blockers: validation.blockers,
      existing_approval: existingApproval,
      record_preview: record,
      verification: {
        packet_exists: Boolean(packetRow),
        packet_confirmation_status: normalizedPacket?.confirmation_status || null,
        packet_remains_confirmed: normalizedPacket?.confirmation_status === 'confirmed',
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields: validation.forbidden_fields,
        approval_request_count_for_packet_before: before.existing_approvals.length,
        approval_request_count_for_packet_after: before.existing_approvals.length,
        execution_request_count_for_source_opportunity_before: before.execution_requests_for_opportunity.length,
        execution_request_count_for_source_opportunity_after: before.execution_requests_for_opportunity.length,
      },
      safety: phase13TPromotedApprovalSafety({ databaseWrite: false }),
      source: 'phase_13t_promoted_approval_request_v1',
    };
  }

  if (!writeRequested) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_id: id,
      created: false,
      idempotent_existing: Boolean(existingApproval),
      blocked: false,
      blockers: [],
      existing_approval: existingApproval,
      approval_preview: record.metadata.approval_request,
      record_preview: record,
      verification: {
        packet_exists: true,
        packet_confirmation_status: normalizedPacket.confirmation_status,
        packet_remains_confirmed: normalizedPacket.confirmation_status === 'confirmed',
        packet_not_execution_candidate: normalizedPacket.not_execution_candidate === true,
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields_absent: validation.forbidden_fields.length === 0,
        target_item_id: normalizedPacket.target_item_id,
        target_item_id_valid: normalizedPacket.target_item_id === '206315990948',
        approval_request_count_for_packet_before: before.existing_approvals.length,
        approval_request_count_for_packet_after: before.existing_approvals.length,
        execution_request_count_for_source_opportunity_before: before.execution_requests_for_opportunity.length,
        execution_request_count_for_source_opportunity_after: before.execution_requests_for_opportunity.length,
      },
      safety: phase13TPromotedApprovalSafety({ databaseWrite: false }),
      recommended_next_action: 'Dry-run only. Re-run with --write to create exactly one internal approval request; do not create execution requests or marketplace writes.',
      source: 'phase_13t_promoted_approval_request_v1',
    };
  }

  if (existingApproval) {
    const afterApprovals = await listPhase13TPromotedApprovalRows({ packetId: id, limit: 50 });
    const afterRequests = sourceOpportunityId != null
      ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
      : [];
    return {
      read_only: false,
      dry_run: false,
      write_requested: true,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      packet_id: id,
      created: false,
      idempotent_existing: true,
      blocked: false,
      blockers: [],
      approval: existingApproval,
      verification: {
        approval_request_count_for_packet_before: before.existing_approvals.length,
        approval_request_count_for_packet_after: afterApprovals.length,
        exactly_one_approval_for_packet: afterApprovals.length === 1,
        packet_remains_confirmed: normalizedPacket.confirmation_status === 'confirmed',
        execution_request_count_for_source_opportunity_before: before.execution_requests_for_opportunity.length,
        execution_request_count_for_source_opportunity_after: afterRequests.length,
        execution_request_created: afterRequests.length > before.execution_requests_for_opportunity.length,
        execution_state_updated: false,
      },
      safety: phase13TPromotedApprovalSafety({ databaseWrite: false }),
      recommended_next_action: 'Existing internal promoted approval request returned idempotently. Do not create execution requests or marketplace writes until a later explicit phase.',
      source: 'phase_13t_promoted_approval_request_v1',
    };
  }

  const db = getClient();
  const { data: inserted, error } = await db
    .from(OPPORTUNITY_TABLE)
    .insert(record)
    .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
    .single();
  if (error) throw error;
  const afterApprovals = await listPhase13TPromotedApprovalRows({ packetId: id, limit: 50 });
  const afterRequests = sourceOpportunityId != null
    ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
    : [];
  const normalizedApproval = normalizePhase13TPromotedApprovalRow(inserted);
  return {
    read_only: false,
    dry_run: false,
    write_requested: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    packet_id: id,
    created: true,
    idempotent_existing: false,
    blocked: false,
    blockers: [],
    approval: normalizedApproval,
    verification: {
      approval_request_count_for_packet_before: before.existing_approvals.length,
      approval_request_count_for_packet_after: afterApprovals.length,
      exactly_one_approval_for_packet: afterApprovals.length === 1,
      approval_status: normalizedApproval.approval_status,
      packet_artifact_id: normalizedApproval.packet_artifact_id,
      opportunity_id: normalizedApproval.opportunity_id,
      source_review_id: normalizedApproval.source_review_id,
      target_item_id: normalizedApproval.target_item_id,
      planned_mutation_fields: normalizedApproval.planned_mutation_fields,
      planned_mutation_item_specifics_only: JSON.stringify(normalizedApproval.planned_mutation_fields || []) === JSON.stringify(['item_specifics']),
      not_execution_candidate: normalizedApproval.not_execution_candidate === true,
      requires_final_operator_approval: normalizedApproval.requires_final_operator_approval === true,
      packet_remains_confirmed: normalizedPacket.confirmation_status === 'confirmed',
      execution_request_count_for_source_opportunity_before: before.execution_requests_for_opportunity.length,
      execution_request_count_for_source_opportunity_after: afterRequests.length,
      execution_request_created: afterRequests.length > before.execution_requests_for_opportunity.length,
      execution_state_updated: false,
    },
    safety: phase13TPromotedApprovalSafety({ databaseWrite: true }),
    recommended_next_action: 'Internal promoted approval request created only. Do not create execution requests or marketplace writes until a later explicit phase.',
    source: 'phase_13t_promoted_approval_request_v1',
  };
}


function validatePhase13UPromotedApprovalAction({ approvalRow, approval, packetRow, packet, normalizedPacket, action, actor, reason, executionRequestsForOpportunity = [], dryRun = true } = {}) {
  const blockers = [];
  const normalizedAction = trimOrNull(action, 30);
  const plannedMutation = approval?.planned_mutation || {};
  const plannedFields = Object.keys(plannedMutation || {});
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  if (!['approve', 'reject'].includes(normalizedAction)) blockers.push('action_not_approve_or_reject');
  if (!approvalRow) blockers.push('approval_artifact_missing');
  if (approvalRow && approvalRow.opportunity_type !== 'listing_quality_update_approval_request') blockers.push('approval_opportunity_type_not_listing_quality_update_approval_request');
  if (approvalRow && approvalRow.source_type !== 'phase_13t_promoted_approval_request') blockers.push('approval_source_type_not_phase_13t_promoted_approval_request');
  if ((approval?.approval_status || approvalRow?.metadata?.approval_status || approvalRow?.status) !== 'pending') blockers.push('approval_status_not_pending');
  if (!packetRow) blockers.push('packet_artifact_missing');
  if (packetRow && packetRow.id !== 14) blockers.push('packet_artifact_id_not_14');
  if (normalizedPacket?.confirmation_status !== 'confirmed') blockers.push('packet_confirmation_status_not_confirmed');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');
  if ((approval?.target_item_id || approval?.item_id) !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if (approval?.execution_request_id != null) blockers.push('approval_execution_request_id_present');
  if (normalizedPacket?.execution_request_id != null) blockers.push('packet_execution_request_id_present');
  if (executionRequestsForOpportunity.length > 0) blockers.push('execution_request_exists_for_source_opportunity');
  if (dryRun === false && !actor) blockers.push('actor_required');
  if (dryRun === false && !reason) blockers.push('reason_required');
  return {
    action: normalizedAction,
    blockers: [...new Set(blockers)],
    planned_mutation_fields: plannedFields,
    forbidden_fields: forbiddenFields,
    planned_mutation_item_specifics_only: plannedFields.length === 1 && plannedFields[0] === 'item_specifics',
  };
}

async function actOnEbayListingQualityPromotedApproval({ approvalId, action, actor = null, reason = null, dryRun = true, write = false } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const writeRequested = write === true || dryRun === false;
  const approvalActor = trimOrNull(actor, 100);
  const approvalReason = trimOrNull(reason, 1000);
  const approvalRows = await safeSelectRows(
    OPPORTUNITY_TABLE,
    'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
    q => q.eq('id', id).eq('opportunity_type', 'listing_quality_update_approval_request').limit(1)
  );
  const approvalRow = approvalRows[0] || null;
  const currentApproval = approvalRow ? normalizePhase13TPromotedApprovalRow(approvalRow) : null;
  const approval = approvalRow?.metadata?.approval_request || {};
  const packetArtifactId = intOrNull(approval?.packet_artifact_id || approvalRow?.metadata?.packet_artifact_id);
  const packetRows = packetArtifactId != null
    ? await safeSelectRows(
      OPPORTUNITY_TABLE,
      'id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at',
      q => q.eq('id', packetArtifactId).eq('opportunity_type', 'listing_quality_update_packet').limit(1)
    )
    : [];
  const packetRow = packetRows[0] || null;
  const normalizedPacket = packetRow ? normalizePhase13RPromotedPacketRow(packetRow) : null;
  const packet = packetRow?.metadata?.packet || {};
  const sourceOpportunityId = currentApproval?.opportunity_id || approval?.opportunity_id || normalizedPacket?.opportunity_id || null;
  const beforeRequests = sourceOpportunityId != null
    ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
    : [];
  const validation = validatePhase13UPromotedApprovalAction({
    approvalRow,
    approval,
    packetRow,
    packet,
    normalizedPacket,
    action,
    actor: approvalActor,
    reason: approvalReason,
    executionRequestsForOpportunity: beforeRequests,
    dryRun: !writeRequested,
  });
  const actedAt = new Date().toISOString();
  const isApprove = validation.action === 'approve';
  const nextApprovalStatus = isApprove ? 'approved' : 'rejected';
  const actionSnapshot = {
    approval_artifact_id: id,
    action: validation.action,
    actor: approvalActor,
    reason: approvalReason,
    acted_at: actedAt,
    packet_artifact_id: packetArtifactId,
    opportunity_id: sourceOpportunityId,
    source_review_id: currentApproval?.source_review_id || approval?.source_review_id || null,
    target_item_id: currentApproval?.target_item_id || approval?.target_item_id || null,
    planned_mutation: approval?.planned_mutation || {},
    planned_mutation_hash: sha256Json(approval?.planned_mutation || {}),
    packet_confirmation_status: normalizedPacket?.confirmation_status || null,
    execution_request_count_for_source_opportunity: beforeRequests.length,
    final_operator_approval: isApprove,
    still_not_execution_candidate: true,
    safety: {
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
    policy_version: 'phase-13u-promoted-final-approval-v1',
  };
  const nextApprovalRequest = {
    ...approval,
    approval_status: nextApprovalStatus,
    approved_by_actor: isApprove ? approvalActor : null,
    approval_reason: isApprove ? approvalReason : null,
    approved_at: isApprove ? actedAt : null,
    rejected_by_actor: isApprove ? null : approvalActor,
    rejection_reason: isApprove ? null : approvalReason,
    rejected_at: isApprove ? null : actedAt,
    final_operator_approval: isApprove,
    final_operator_approval_snapshot: actionSnapshot,
    still_not_execution_candidate: true,
    not_execution_candidate: true,
    execution_request_id: null,
    request_id: null,
  };
  const nextMetadata = {
    ...(approvalRow?.metadata || {}),
    phase_13u_promoted_final_approval: true,
    approval_status: nextApprovalStatus,
    approved_by_actor: isApprove ? approvalActor : null,
    approval_reason: isApprove ? approvalReason : null,
    approved_at: isApprove ? actedAt : null,
    rejected_by_actor: isApprove ? null : approvalActor,
    rejection_reason: isApprove ? null : approvalReason,
    rejected_at: isApprove ? null : actedAt,
    final_operator_approval: isApprove,
    final_operator_approval_snapshot: actionSnapshot,
    still_not_execution_candidate: true,
    not_execution_candidate: true,
    execution_request_created: false,
    execution_state_changed: false,
    marketplace_write_performed: false,
    approval_request: nextApprovalRequest,
    safety_boundary: {
      ...((approvalRow?.metadata || {}).safety_boundary || {}),
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_marketplace_write: true,
      no_execution_request_created: true,
      no_execution_state_change: true,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      listing_changed: false,
    },
  };

  if (validation.blockers.length) {
    if (writeRequested) throw new Error(`promoted approval action blocked: ${validation.blockers.join(', ')}`);
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      approval_id: id,
      action: validation.action,
      updated: false,
      blocked: true,
      blockers: validation.blockers,
      before_approval: currentApproval,
      action_preview: actionSnapshot,
      verification: {
        approval_exists: Boolean(approvalRow),
        source_type: approvalRow?.source_type || null,
        approval_status: currentApproval?.approval_status || null,
        packet_artifact_id: packetArtifactId,
        packet_exists: Boolean(packetRow),
        packet_confirmation_status: normalizedPacket?.confirmation_status || null,
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields: validation.forbidden_fields,
        target_item_id: currentApproval?.target_item_id || approval?.target_item_id || null,
        execution_request_count_for_source_opportunity_before: beforeRequests.length,
      },
      safety: phase13TPromotedApprovalSafety({ databaseWrite: false }),
      source: 'phase_13u_promoted_final_approval_v1',
    };
  }

  if (!writeRequested) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      approval_id: id,
      action: validation.action,
      updated: false,
      blocked: false,
      blockers: [],
      before_approval: currentApproval,
      after_preview: normalizePhase13TPromotedApprovalRow({ ...approvalRow, status: nextApprovalStatus === 'approved' ? 'approval_approved' : 'approval_rejected', metadata: nextMetadata, updated_at: actedAt }),
      action_preview: actionSnapshot,
      verification: {
        approval_exists: true,
        source_type_valid: approvalRow.source_type === 'phase_13t_promoted_approval_request',
        approval_status_pending: currentApproval.approval_status === 'pending',
        packet_artifact_id: packetArtifactId,
        packet_exists: Boolean(packetRow),
        packet_confirmation_status: normalizedPacket.confirmation_status,
        packet_remains_confirmed: normalizedPacket.confirmation_status === 'confirmed',
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields_absent: validation.forbidden_fields.length === 0,
        target_item_id: currentApproval.target_item_id,
        target_item_id_valid: currentApproval.target_item_id === '206315990948',
        execution_request_count_for_source_opportunity_before: beforeRequests.length,
        execution_request_count_for_source_opportunity_after: beforeRequests.length,
      },
      safety: phase13TPromotedApprovalSafety({ databaseWrite: false }),
      recommended_next_action: 'Dry-run only. Re-run with --write to update the internal approval artifact; do not create execution requests or marketplace writes.',
      source: 'phase_13u_promoted_final_approval_v1',
    };
  }

  const db = getClient();
  const { data: updated, error } = await db
    .from(OPPORTUNITY_TABLE)
    .update({ status: nextApprovalStatus === 'approved' ? 'approval_approved' : 'approval_rejected', metadata: nextMetadata, updated_at: actedAt })
    .eq('id', id)
    .eq('opportunity_type', 'listing_quality_update_approval_request')
    .eq('source_type', 'phase_13t_promoted_approval_request')
    .select('id,opportunity_type,source_type,title,status,notes,metadata,created_at,updated_at')
    .single();
  if (error) throw error;
  const after = normalizePhase13TPromotedApprovalRow(updated);
  const afterRequests = sourceOpportunityId != null
    ? await safeSelectRows(REQUEST_TABLE, 'id,opportunity_id,status,execution_type,final_approval_status,executed_at,execution_result,created_at', q => q.eq('opportunity_id', sourceOpportunityId).limit(50))
    : [];
  return {
    read_only: false,
    dry_run: false,
    write_requested: true,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    approval_id: id,
    action: validation.action,
    updated: true,
    blocked: false,
    blockers: [],
    before_approval: currentApproval,
    after_approval: after,
    action_snapshot: actionSnapshot,
    verification: {
      approval_id: after.id,
      approval_status: after.approval_status,
      approved_by_actor: after.approved_by_actor,
      approval_reason: after.approval_reason,
      approved_at: after.approved_at,
      final_operator_approval: after.final_operator_approval === true,
      still_not_execution_candidate: after.still_not_execution_candidate === true,
      not_execution_candidate: after.not_execution_candidate === true,
      packet_artifact_id: after.packet_artifact_id,
      packet_remains_confirmed: normalizedPacket.confirmation_status === 'confirmed',
      planned_mutation_fields: after.planned_mutation_fields,
      planned_mutation_item_specifics_only: JSON.stringify(after.planned_mutation_fields || []) === JSON.stringify(['item_specifics']),
      execution_request_count_for_source_opportunity_before: beforeRequests.length,
      execution_request_count_for_source_opportunity_after: afterRequests.length,
      execution_request_created: afterRequests.length > beforeRequests.length,
      execution_state_updated: false,
    },
    safety: phase13TPromotedApprovalSafety({ databaseWrite: true }),
    recommended_next_action: 'Internal promoted final approval recorded only. Do not create execution requests or marketplace writes until a later explicit phase.',
    source: 'phase_13u_promoted_final_approval_v1',
  };
}

function phase13VPromotedBridgeSafety({ databaseWrite = false } = {}) {
  return {
    cached_evidence_only: true,
    actual_ebay_call: false,
    get_item_called: false,
    actual_network_call: false,
    live_transport_called: false,
    actual_database_write: databaseWrite === true,
    database_write_scope: databaseWrite === true ? 'internal promoted execution bridge request/legacy packet records only' : null,
    marketplace_write_performed: false,
    revise_fixed_price_item_called: false,
    live_execution_performed: false,
    execution_request_created: false,
    execution_state_changed: false,
    executed_at_updated: false,
    execution_result_updated: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    title_changes: false,
    description_changes: false,
    listing_changed: false,
  };
}

function phase13VMarketplaceExecutionEventTypes() {
  return [
    'request_executed',
    'execution_started',
    'execution_completed',
    'execution_failed',
    'marketplace_execution_started',
    'marketplace_execution_completed',
    'marketplace_execution_failed',
  ];
}

function buildPhase13VPromotedBridgeRequestRecord({ approval, packet, createdAt } = {}) {
  const plannedMutation = approval?.planned_mutation || packet?.planned_mutation || {};
  const dryRunResult = {
    dry_run: true,
    execution_performed: false,
    external_action_executed: false,
    marketplace_api_calls: false,
    ebay_api_calls: false,
    marketplace_execution_approved: false,
    live_transport_called: false,
    operation: 'listing_quality_update',
    target_item_id: approval?.target_item_id || packet?.target_item_id || null,
    planned_mutation: plannedMutation,
    planned_mutation_fields: Object.keys(plannedMutation || {}),
    generated_at: createdAt,
    source: 'phase_13v_promoted_execution_bridge_dry_run_v1',
  };
  return {
    opportunity_id: approval.opportunity_id,
    sku: approval.target_item_id,
    execution_type: 'listing_quality_update',
    status: 'dry_run_ready',
    requested_action: {
      source: 'phase_13v_promoted_execution_bridge',
      source_phase: '13V',
      source_promoted_approval_artifact_id: approval.id,
      source_promoted_packet_artifact_id: approval.packet_artifact_id,
      source_promoted_opportunity_id: approval.opportunity_id,
      source_review_id: approval.source_review_id,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      target_item_id: approval.target_item_id,
      planned_mutation: plannedMutation,
      planned_mutation_fields: Object.keys(plannedMutation || {}),
      allowed_mutation_fields: ['item_specifics'],
      requires_human_approval: true,
      final_approval_derived_from_approval_artifact_id: approval.id,
      forbidden_actions: [
        'no_ebay_call_in_phase_13v',
        'no_get_item_call_in_phase_13v',
        'no_revise_fixed_price_item_call_in_phase_13v',
        'no_live_transport_call_in_phase_13v',
        'no_marketplace_write_in_phase_13v',
        'no_price_change',
        'no_inventory_change',
        'no_quantity_change',
        'no_title_change',
        'no_description_change',
      ],
      safety_boundary: {
        no_ebay_call: true,
        no_get_item_call: true,
        no_revise_fixed_price_item_call: true,
        no_live_transport_call: true,
        no_marketplace_write: true,
        price_changes: false,
        inventory_changes: false,
        quantity_changes: false,
        title_changes: false,
        description_changes: false,
        listing_changed: false,
      },
    },
    risk_level: 'medium',
    requires_approval: true,
    dry_run_result: dryRunResult,
    execution_result: null,
    final_approval_status: 'approved',
    final_approval_actor: approval.approved_by_actor || 'operator',
    final_approval_reason: `Derived from Phase 13U promoted approval artifact ${approval.id}`,
    final_approved_at: approval.approved_at || createdAt,
    final_approval_policy_version: 'phase-13v-promoted-execution-bridge-v1',
    final_approval_dry_run_hash: sha256Json(dryRunResult),
    final_approval_snapshot: {
      source: 'phase_13v_promoted_execution_bridge',
      approval_artifact_id: approval.id,
      packet_artifact_id: approval.packet_artifact_id,
      source_promoted_opportunity_id: approval.opportunity_id,
      target_item_id: approval.target_item_id,
      planned_mutation: plannedMutation,
      planned_mutation_fields: Object.keys(plannedMutation || {}),
      approval_status: approval.approval_status,
      final_operator_approval: approval.final_operator_approval === true,
      approved_by_actor: approval.approved_by_actor || null,
      approved_at: approval.approved_at || null,
      external_action_executed: false,
      marketplace_execution_approved: false,
      execution_performed: false,
      marketplace_write_performed: false,
    },
    metadata: {
      hermes_generated: true,
      hermes_phase: '13V',
      source: 'phase_13v_promoted_execution_bridge',
      promoted_execution_bridge: true,
      promoted_approval_artifact_id: approval.id,
      promoted_packet_artifact_id: approval.packet_artifact_id,
      source_promoted_opportunity_id: approval.opportunity_id,
      source_review_id: approval.source_review_id,
      target_item_id: approval.target_item_id,
      item_id: approval.target_item_id,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      planned_mutation: plannedMutation,
      planned_mutation_fields: Object.keys(plannedMutation || {}),
      external_action_executed: false,
      marketplace_execution_approved: false,
      marketplace_write_performed: false,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      live_transport_called: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
      listing_changed: false,
      bridge_created_at: createdAt,
    },
  };
}

function buildPhase13VPromotedLegacyPacketRecord({ request, approval, packet, createdAt } = {}) {
  const plannedMutation = approval?.planned_mutation || packet?.planned_mutation || {};
  const beforeSnapshot = {
    ...(packet?.cached_evidence_snapshot || {}),
    ...(packet?.metadata?.packet?.before_snapshot || {}),
    target_item_id: approval.target_item_id,
    item_id: approval.target_item_id,
    source: 'phase_13v_promoted_execution_bridge_cached_snapshot',
    source_promoted_packet_artifact_id: approval.packet_artifact_id,
    live_marketplace_state_fetched: false,
    ebay_api_call_made: false,
  };
  const rollbackSnapshot = packet?.rollback_snapshot || packet?.metadata?.packet?.rollback_snapshot || {};
  const packetHash = sha256Json({
    source: 'phase_13v_promoted_execution_bridge',
    request_id: request.id || null,
    approval_artifact_id: approval.id,
    packet_artifact_id: approval.packet_artifact_id,
    target_item_id: approval.target_item_id,
    planned_mutation: plannedMutation,
    before_snapshot_hash: sha256Json(beforeSnapshot),
    rollback_snapshot_hash: sha256Json(rollbackSnapshot),
  });
  const safetyFlags = {
    source: 'phase_13v_promoted_execution_bridge',
    promoted_execution_bridge: true,
    promoted_approval_artifact_id: approval.id,
    promoted_packet_artifact_id: approval.packet_artifact_id,
    source_promoted_opportunity_id: approval.opportunity_id,
    source_review_id: approval.source_review_id,
    target_item_id: approval.target_item_id,
    operation: 'listing_quality_update',
    planned_mutation_fields: Object.keys(plannedMutation || {}),
    no_ebay_call: true,
    no_get_item_call: true,
    no_revise_fixed_price_item_call: true,
    no_live_transport_call: true,
    no_marketplace_write: true,
    actual_ebay_call: false,
    marketplace_write_performed: false,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    title_changes: false,
    description_changes: false,
    listing_changed: false,
    created_at: createdAt,
  };
  return {
    request_id: request.id || null,
    item_id: approval.target_item_id,
    actor: approval.approved_by_actor || 'operator',
    reason: `Phase 13V bridge from promoted approval artifact ${approval.id}`,
    packet_hash: packetHash,
    planned_mutation: plannedMutation,
    before_snapshot: beforeSnapshot,
    rollback_snapshot: rollbackSnapshot,
    safety_flags: safetyFlags,
    status: 'packet_recorded',
    confirmation_status: 'confirmed',
    confirmed_by_actor: approval.approved_by_actor || 'operator',
    confirmation_reason: `Derived from Phase 13S confirmed promoted packet artifact ${approval.packet_artifact_id}`,
    confirmed_at: approval.approved_at || createdAt,
    confirmation_snapshot: {
      source: 'phase_13v_promoted_execution_bridge_confirmation_snapshot',
      approval_artifact_id: approval.id,
      packet_artifact_id: approval.packet_artifact_id,
      request_id: request.id || null,
      target_item_id: approval.target_item_id,
      planned_mutation: plannedMutation,
      planned_mutation_hash: sha256Json(plannedMutation),
      packet_hash: packetHash,
      external_action_executed: false,
      marketplace_execution_approved: false,
      marketplace_write_performed: false,
      actual_ebay_call: false,
      created_at: createdAt,
    },
  };
}

function validatePhase13VPromotedBridgeInputs({ approval, packet, existingRequests = [], existingLegacyPackets = [], marketplaceEventCount = 0 } = {}) {
  const blockers = [];
  const plannedMutation = approval?.planned_mutation || packet?.planned_mutation || {};
  const plannedFields = Object.keys(plannedMutation || {});
  const forbiddenFields = objectHasForbiddenMarketplaceMutationFields(plannedMutation);
  if (!approval) blockers.push('approval_artifact_missing');
  if (approval?.id !== 15) blockers.push('approval_artifact_id_not_15');
  if (approval?.approval_status !== 'approved') blockers.push('approval_status_not_approved');
  if (approval?.final_operator_approval !== true) blockers.push('final_operator_approval_not_true');
  if (approval?.packet_artifact_id !== 14) blockers.push('packet_artifact_id_not_14');
  if (approval?.target_item_id !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if (approval?.operation !== 'listing_quality_update') blockers.push('operation_not_listing_quality_update');
  if (!packet) blockers.push('promoted_packet_artifact_missing');
  if (packet?.confirmation_status !== 'confirmed') blockers.push('promoted_packet_not_confirmed');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');
  if ((approval?.execution_request_id || null) != null) blockers.push('approval_execution_request_id_present');
  if ((packet?.execution_request_id || null) != null) blockers.push('packet_execution_request_id_present');
  if (existingRequests.length > 1) blockers.push('duplicate_promoted_bridge_execution_requests_exist');
  if (existingLegacyPackets.length > 1) blockers.push('duplicate_promoted_bridge_legacy_packets_exist');
  if ((marketplaceEventCount || 0) > 0) blockers.push('previous_marketplace_execution_event_exists');
  return {
    blockers: [...new Set(blockers)],
    planned_mutation_fields: plannedFields,
    planned_mutation_item_specifics_only: plannedFields.length === 1 && plannedFields[0] === 'item_specifics',
    forbidden_fields: forbiddenFields,
  };
}

async function loadPhase13VPromotedBridgeContext({ approvalId } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const approvalDetail = await getEbayListingQualityPromotedApprovalDetail({ approvalId: id });
  const approval = approvalDetail.promoted_approval || null;
  const packetDetail = approval?.packet_artifact_id != null
    ? await getEbayListingQualityPromotedPacketDetail({ packetId: approval.packet_artifact_id })
    : { promoted_packet: null };
  const packet = packetDetail.promoted_packet || null;
  const existingRequests = await safeSelectRows(
    REQUEST_TABLE,
    '*',
    q => q.contains('metadata', { promoted_execution_bridge: true, promoted_approval_artifact_id: id }).order('id', { ascending: true }).limit(20)
  );
  const requestIds = existingRequests.map(r => r.id).filter(v => v != null);
  const existingLegacyPackets = requestIds.length
    ? await safeSelectRows(
      EBAY_LISTING_QUALITY_PACKET_TABLE,
      '*',
      q => q.in('request_id', requestIds).order('id', { ascending: true }).limit(20)
    )
    : [];
  const marketplaceEventCount = requestIds.length
    ? await Promise.all(requestIds.map(requestId => countMarketplaceExecutionEvents(requestId))).then(values => values.reduce((a, b) => a + b, 0))
    : 0;
  return { approvalDetail, approval, packetDetail, packet, existingRequests, existingLegacyPackets, marketplaceEventCount };
}

async function createEbayListingQualityPromotedExecutionBridge({ approvalId, dryRun = true, write = false } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const writeRequested = write === true || dryRun === false;
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const { approval, packet, existingRequests, existingLegacyPackets, marketplaceEventCount } = context;
  const createdAt = new Date().toISOString();
  const validation = validatePhase13VPromotedBridgeInputs({ approval, packet, existingRequests, existingLegacyPackets, marketplaceEventCount });
  const existingRequest = existingRequests[0] || null;
  const existingLegacyPacket = existingLegacyPackets[0] || null;
  const requestPreview = approval && packet ? buildPhase13VPromotedBridgeRequestRecord({ approval, packet, createdAt }) : null;
  const packetPreview = requestPreview ? buildPhase13VPromotedLegacyPacketRecord({ request: existingRequest || { id: null }, approval, packet, createdAt }) : null;

  if (validation.blockers.length) {
    if (writeRequested && !existingRequest) throw new Error(`promoted execution bridge blocked: ${validation.blockers.join(', ')}`);
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      approval_id: id,
      created: false,
      idempotent_existing: Boolean(existingRequest),
      blocked: true,
      blockers: validation.blockers,
      existing_request: existingRequest,
      existing_legacy_packet: existingLegacyPacket,
      request_preview: requestPreview,
      legacy_packet_preview: packetPreview,
      verification: {
        approval_status: approval?.approval_status || null,
        final_operator_approval: approval?.final_operator_approval === true,
        target_item_id: approval?.target_item_id || null,
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        forbidden_fields: validation.forbidden_fields,
        existing_bridge_request_count: existingRequests.length,
        existing_legacy_packet_count: existingLegacyPackets.length,
        previous_marketplace_execution_event_count: marketplaceEventCount,
      },
      safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
      source: 'phase_13v_promoted_execution_bridge_v1',
    };
  }

  if (!writeRequested) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      approval_id: id,
      created: false,
      idempotent_existing: Boolean(existingRequest && existingLegacyPacket),
      blocked: false,
      blockers: [],
      existing_request: existingRequest,
      existing_legacy_packet: existingLegacyPacket,
      request_preview: requestPreview,
      legacy_packet_preview: packetPreview,
      verification: {
        target_item_id_exact: approval.target_item_id === '206315990948',
        operation: approval.operation,
        planned_mutation_fields: validation.planned_mutation_fields,
        planned_mutation_item_specifics_only: validation.planned_mutation_item_specifics_only,
        request_final_approval_status: requestPreview.final_approval_status,
        request_executed_at: null,
        request_execution_result: null,
        metadata_external_action_executed: false,
        metadata_marketplace_execution_approved: false,
        previous_marketplace_execution_event_count: marketplaceEventCount,
      },
      safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
      recommended_next_action: 'Dry-run only. Re-run with --write to create idempotent internal bridge records; this still does not call eBay.',
      source: 'phase_13v_promoted_execution_bridge_v1',
    };
  }

  const db = getClient();
  let request = existingRequest;
  let requestCreated = false;
  if (!request) {
    const { data, error } = await db.from(REQUEST_TABLE).insert(requestPreview).select('*').single();
    if (error) throw error;
    request = data;
    requestCreated = true;
  }

  let legacyPacketRows = existingLegacyPackets;
  if (!legacyPacketRows.length && request?.id != null) {
    legacyPacketRows = await safeSelectRows(
      EBAY_LISTING_QUALITY_PACKET_TABLE,
      '*',
      q => q.eq('request_id', request.id).order('id', { ascending: true }).limit(20)
    );
  }
  let legacyPacket = legacyPacketRows[0] || null;
  let legacyPacketCreated = false;
  if (!legacyPacket) {
    const legacyRecord = buildPhase13VPromotedLegacyPacketRecord({ request, approval, packet, createdAt });
    const { data, error } = await db.from(EBAY_LISTING_QUALITY_PACKET_TABLE).insert(legacyRecord).select('*').single();
    if (error) throw error;
    legacyPacket = data;
    legacyPacketCreated = true;
  }

  const afterEventCount = request?.id != null ? await countMarketplaceExecutionEvents(request.id) : 0;
  return {
    read_only: false,
    dry_run: false,
    write_requested: true,
    approval_id: id,
    created: requestCreated || legacyPacketCreated,
    request_created: requestCreated,
    legacy_packet_created: legacyPacketCreated,
    idempotent_existing: !requestCreated && !legacyPacketCreated,
    blocked: false,
    blockers: [],
    request,
    legacy_packet: legacyPacket,
    verification: {
      request_id: request.id,
      legacy_packet_id: legacyPacket.id,
      target_item_id: legacyPacket.item_id,
      target_item_id_exact: legacyPacket.item_id === '206315990948',
      operation: request.metadata?.operation || request.requested_action?.operation || null,
      operation_valid: (request.metadata?.operation || request.requested_action?.operation) === 'listing_quality_update',
      planned_mutation_fields: Object.keys(legacyPacket.planned_mutation || {}),
      planned_mutation_item_specifics_only: JSON.stringify(Object.keys(legacyPacket.planned_mutation || {})) === JSON.stringify(['item_specifics']),
      request_final_approval_status: request.final_approval_status || null,
      request_final_approval_status_approved: request.final_approval_status === 'approved',
      request_executed_at: request.executed_at || null,
      request_execution_result: request.execution_result || null,
      metadata_external_action_executed: request.metadata?.external_action_executed === true,
      metadata_marketplace_execution_approved: request.metadata?.marketplace_execution_approved === true,
      marketplace_execution_event_count_for_request: afterEventCount,
      no_prior_marketplace_execution_event_for_new_request: afterEventCount === 0,
      approval_artifact_id: request.metadata?.promoted_approval_artifact_id || null,
      packet_artifact_id: request.metadata?.promoted_packet_artifact_id || null,
    },
    safety: {
      ...phase13VPromotedBridgeSafety({ databaseWrite: true }),
      execution_request_created: requestCreated,
      legacy_packet_created: legacyPacketCreated,
      actual_ebay_call: false,
      marketplace_write_performed: false,
      live_transport_called: false,
    },
    recommended_next_action: 'Internal bridge records are ready for promoted readiness/runbook inspection only. Do not execute eBay in Phase 13V.',
    source: 'phase_13v_promoted_execution_bridge_v1',
  };
}


const PHASE13X_PLACEHOLDER_ITEM_SPECIFIC_KEYS = [
  'required_human_review',
  'internal_review',
  'human_review',
  'placeholder',
  'todo',
];

function normalizeItemSpecificToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function auditPhase13XItemSpecificsValue(itemSpecifics = {}) {
  const blockers = [];
  const findings = [];
  const source = itemSpecifics && typeof itemSpecifics === 'object' && !Array.isArray(itemSpecifics) ? itemSpecifics : {};
  const entries = Object.entries(source);
  if (!entries.length) {
    blockers.push('item_specifics_empty');
    findings.push({ type: 'empty_item_specifics', field: null, reason: 'operator_final_item_specifics_required' });
  }
  for (const [key, value] of entries) {
    const rawKey = String(key || '').trim();
    const normalizedKey = normalizeItemSpecificToken(rawKey);
    const rawValue = Array.isArray(value) ? value.map(v => String(v ?? '').trim()).filter(Boolean).join(', ') : String(value ?? '').trim();
    const normalizedValue = normalizeItemSpecificToken(rawValue);
    const placeholderKey = PHASE13X_PLACEHOLDER_ITEM_SPECIFIC_KEYS.find(k => normalizedKey === normalizeItemSpecificToken(k) || normalizedKey.includes(normalizeItemSpecificToken(k)));
    const placeholderValue = PHASE13X_PLACEHOLDER_ITEM_SPECIFIC_KEYS.find(k => normalizedValue === normalizeItemSpecificToken(k) || normalizedValue.includes(normalizeItemSpecificToken(k)));
    const valueIsEmpty = value == null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.filter(v => v != null && String(v).trim()).length === 0)
      || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value || {}).length === 0);
    const valueIsBooleanOnly = typeof value === 'boolean' || /^(true|false)$/i.test(rawValue);
    if (!rawKey) {
      blockers.push('item_specifics_empty_field_name');
      findings.push({ type: 'empty_field_name', field: rawKey, value: rawValue });
    }
    if (placeholderKey) {
      blockers.push('placeholder_item_specifics_present');
      findings.push({ type: 'placeholder_field_name', field: rawKey, value: rawValue, matched: placeholderKey });
    }
    if (placeholderValue) {
      blockers.push('placeholder_item_specifics_present');
      findings.push({ type: 'placeholder_field_value', field: rawKey, value: rawValue, matched: placeholderValue });
    }
    if (valueIsEmpty) {
      blockers.push('item_specifics_empty_values_present');
      findings.push({ type: 'empty_value', field: rawKey, value: rawValue });
    }
    if (valueIsBooleanOnly) {
      blockers.push('boolean_only_fake_item_specifics_present');
      findings.push({ type: 'boolean_only_fake_field', field: rawKey, value: rawValue });
    }
  }
  return {
    blocked: blockers.length > 0,
    blockers: [...new Set(blockers)],
    findings,
    item_specifics_field_count: entries.length,
    placeholder_terms: PHASE13X_PLACEHOLDER_ITEM_SPECIFIC_KEYS,
  };
}

async function auditEbayListingQualityPromotedItemSpecifics({ approvalId } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const approval = context.approval || null;
  const request = context.existingRequests[0] || null;
  const legacyPacket = context.existingLegacyPackets[0] || null;
  const itemSpecifics = legacyPacket?.planned_mutation?.item_specifics || approval?.planned_mutation?.item_specifics || {};
  const audit = auditPhase13XItemSpecificsValue(itemSpecifics);
  const blockers = [...audit.blockers];
  if (approval?.id !== 15) blockers.push('approval_id_not_15');
  if (request?.id !== 3) blockers.push('request_id_not_3');
  if (legacyPacket?.id !== 2) blockers.push('packet_id_not_2');
  return {
    read_only: true,
    approval_id: id,
    request_id: request?.id || null,
    packet_id: legacyPacket?.id || null,
    target_item_id: legacyPacket?.item_id || approval?.target_item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    blocked: blockers.length > 0,
    blockers: [...new Set(blockers)],
    item_specifics: itemSpecifics,
    item_specifics_audit: audit,
    requires_operator_supplied_json: true,
    guesses_from_title: false,
    recommended_next_action: audit.blocked
      ? 'Current confirmed bridge packet contains placeholder/internal item_specifics. Use the preview command with operator-supplied final JSON; a later write phase should create a superseding packet and reconfirm approval instead of mutating packet_id=2 silently.'
      : 'Item specifics do not contain Phase 13X placeholder blockers. Continue with dedicated readiness checks; do not execute eBay in Phase 13X.',
    safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
    source: 'phase_13x_promoted_item_specifics_audit_v1',
  };
}

async function previewEbayListingQualityPromotedItemSpecifics({ approvalId, itemSpecificsJson = '{}' } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const operatorItemSpecifics = parseOperatorItemSpecifics(itemSpecificsJson);
  const mutation = buildOperatorListingQualityMutation({ itemSpecifics: operatorItemSpecifics });
  const finalItemSpecifics = mutation.item_specifics || {};
  const itemSpecificsAudit = auditPhase13XItemSpecificsValue(finalItemSpecifics);
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const approval = context.approval || null;
  const request = context.existingRequests[0] || null;
  const legacyPacket = context.existingLegacyPackets[0] || null;
  const previewPacket = legacyPacket ? {
    ...legacyPacket,
    planned_mutation: { item_specifics: finalItemSpecifics },
  } : null;
  const intent = previewPacket && request
    ? buildEbayListingQualityExecutionIntent({ packet: previewPacket, request, dryRun: true })
    : null;
  const payload = previewPacket && request
    ? buildEbayListingQualityRevisePayload({ packet: previewPacket, request, intent })
    : null;
  const blockers = [...itemSpecificsAudit.blockers];
  if (!Object.keys(finalItemSpecifics).length) blockers.push('operator_item_specifics_json_empty');
  if (!request) blockers.push('promoted_bridge_execution_request_missing');
  if (!legacyPacket) blockers.push('promoted_bridge_legacy_packet_missing');
  if (approval?.id !== 15) blockers.push('approval_id_not_15');
  if (request?.id !== 3) blockers.push('request_id_not_3');
  if (legacyPacket?.id !== 2) blockers.push('packet_id_not_2');
  return {
    read_only: true,
    dry_run: true,
    approval_id: id,
    request_id: request?.id || null,
    source_packet_id: legacyPacket?.id || null,
    target_item_id: legacyPacket?.item_id || approval?.target_item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    operator_supplied_json_only: true,
    guesses_from_title: false,
    blocked: blockers.length > 0,
    blockers: [...new Set(blockers)],
    final_item_specifics_preview: finalItemSpecifics,
    item_specifics_audit: itemSpecificsAudit,
    payload: payload?.payload || null,
    payload_summary: payload?.payload_summary || null,
    superseding_packet_required_for_write: true,
    would_mutate_confirmed_packet_id_2: false,
    approval_reconfirmation_required_for_future_write: true,
    actual_database_write: false,
    actual_ebay_call: false,
    get_item_called: false,
    revise_fixed_price_item_called: false,
    marketplace_write_performed: false,
    safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
    source: 'phase_13x_promoted_item_specifics_preview_v1',
  };
}


function phase13YFinalItemSpecificsHash(itemSpecifics = {}) {
  return sha256Json({ source: 'phase_13y_promoted_final_item_specifics', item_specifics: itemSpecifics });
}

async function listPhase13YFinalItemSpecificsRows({ approvalId, itemSpecificsHash = null } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) return { requests: [], packets: [] };
  const requestFilters = { phase13y_promoted_final_item_specifics_packet: true, promoted_approval_artifact_id: id };
  if (itemSpecificsHash) requestFilters.final_item_specifics_hash = itemSpecificsHash;
  const requests = await safeSelectRows(
    REQUEST_TABLE,
    '*',
    q => q.contains('metadata', requestFilters).order('id', { ascending: true }).limit(20)
  );
  const requestIds = requests.map(r => r.id).filter(v => v != null);
  const packets = requestIds.length
    ? await safeSelectRows(
      EBAY_LISTING_QUALITY_PACKET_TABLE,
      '*',
      q => q.in('request_id', requestIds).order('id', { ascending: true }).limit(20)
    )
    : [];
  return { requests, packets };
}

function buildPhase13YFinalRequestRecord({ approval, sourceRequest, sourcePacket, itemSpecifics, itemSpecificsHash, actor, reason, createdAt } = {}) {
  const plannedMutation = { item_specifics: itemSpecifics };
  const dryRunResult = {
    dry_run: true,
    execution_performed: false,
    external_action_executed: false,
    marketplace_api_calls: false,
    ebay_api_calls: false,
    marketplace_execution_approved: false,
    live_transport_called: false,
    operation: 'listing_quality_update',
    target_item_id: approval?.target_item_id || sourcePacket?.item_id || null,
    planned_mutation: plannedMutation,
    planned_mutation_fields: ['item_specifics'],
    final_item_specifics_hash: itemSpecificsHash,
    generated_at: createdAt,
    source: 'phase_13y_promoted_final_item_specifics_packet_dry_run_v1',
  };
  return {
    opportunity_id: approval.opportunity_id,
    sku: approval.target_item_id,
    execution_type: 'listing_quality_update',
    status: 'dry_run_ready',
    requested_action: {
      source: 'phase_13y_promoted_final_item_specifics_packet',
      source_phase: '13Y',
      supersedes_request_id: sourceRequest?.id || null,
      supersedes_packet_id: sourcePacket?.id || null,
      source_promoted_approval_artifact_id: approval.id,
      source_promoted_packet_artifact_id: approval.packet_artifact_id,
      source_promoted_opportunity_id: approval.opportunity_id,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      target_item_id: approval.target_item_id,
      planned_mutation: plannedMutation,
      planned_mutation_fields: ['item_specifics'],
      allowed_mutation_fields: ['item_specifics'],
      operator_supplied_json_only: true,
      guesses_from_title: false,
      actor: actor || null,
      reason: reason || null,
      final_item_specifics_hash: itemSpecificsHash,
    },
    risk_level: 'medium',
    requires_approval: true,
    dry_run_result: dryRunResult,
    execution_result: null,
    final_approval_status: 'approved',
    final_approval_actor: actor || approval.approved_by_actor || 'operator',
    final_approval_reason: reason || `Final item specifics supplied for Phase 13Y approval artifact ${approval.id}`,
    final_approved_at: createdAt,
    final_approval_policy_version: 'phase-13y-promoted-final-item-specifics-packet-v1',
    final_approval_dry_run_hash: sha256Json(dryRunResult),
    final_approval_snapshot: {
      source: 'phase_13y_promoted_final_item_specifics_packet',
      approval_artifact_id: approval.id,
      source_packet_id: sourcePacket?.id || null,
      supersedes_request_id: sourceRequest?.id || null,
      target_item_id: approval.target_item_id,
      planned_mutation: plannedMutation,
      planned_mutation_fields: ['item_specifics'],
      final_item_specifics_hash: itemSpecificsHash,
      operator_supplied_json_only: true,
      guesses_from_title: false,
      external_action_executed: false,
      marketplace_execution_approved: false,
      execution_performed: false,
      marketplace_write_performed: false,
    },
    metadata: {
      hermes_generated: true,
      hermes_phase: '13Y',
      source: 'phase_13y_promoted_final_item_specifics_packet',
      phase13y_promoted_final_item_specifics_packet: true,
      promoted_execution_bridge: true,
      promoted_approval_artifact_id: approval.id,
      promoted_packet_artifact_id: approval.packet_artifact_id,
      source_promoted_opportunity_id: approval.opportunity_id,
      supersedes_request_id: sourceRequest?.id || null,
      supersedes_packet_id: sourcePacket?.id || null,
      target_item_id: approval.target_item_id,
      item_id: approval.target_item_id,
      marketplace: 'ebay',
      operation: 'listing_quality_update',
      planned_mutation: plannedMutation,
      planned_mutation_fields: ['item_specifics'],
      final_item_specifics: itemSpecifics,
      final_item_specifics_hash: itemSpecificsHash,
      operator_supplied_json_only: true,
      guesses_from_title: false,
      external_action_executed: false,
      marketplace_execution_approved: false,
      marketplace_write_performed: false,
      actual_ebay_call: false,
      get_item_called: false,
      revise_fixed_price_item_called: false,
      live_transport_called: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
      listing_changed: false,
      created_at: createdAt,
    },
  };
}

function buildPhase13YFinalLegacyPacketRecord({ request, approval, sourcePacket, itemSpecifics, itemSpecificsHash, actor, reason, createdAt } = {}) {
  const plannedMutation = { item_specifics: itemSpecifics };
  const beforeSnapshot = {
    ...(sourcePacket?.before_snapshot || {}),
    target_item_id: approval.target_item_id,
    item_id: approval.target_item_id,
    source: 'phase_13y_promoted_final_item_specifics_packet_cached_snapshot',
    supersedes_packet_id: sourcePacket?.id || null,
    live_marketplace_state_fetched: false,
    ebay_api_call_made: false,
  };
  const rollbackSnapshot = sourcePacket?.rollback_snapshot || {};
  const packetHash = sha256Json({
    source: 'phase_13y_promoted_final_item_specifics_packet',
    request_id: request.id || null,
    approval_artifact_id: approval.id,
    supersedes_packet_id: sourcePacket?.id || null,
    target_item_id: approval.target_item_id,
    planned_mutation: plannedMutation,
    final_item_specifics_hash: itemSpecificsHash,
    before_snapshot_hash: sha256Json(beforeSnapshot),
    rollback_snapshot_hash: sha256Json(rollbackSnapshot),
  });
  return {
    request_id: request.id || null,
    item_id: approval.target_item_id,
    actor: actor || 'operator',
    reason: reason || `Phase 13Y final item specifics supplied for approval artifact ${approval.id}`,
    packet_hash: packetHash,
    planned_mutation: plannedMutation,
    before_snapshot: beforeSnapshot,
    rollback_snapshot: rollbackSnapshot,
    safety_flags: {
      source: 'phase_13y_promoted_final_item_specifics_packet',
      phase13y_promoted_final_item_specifics_packet: true,
      promoted_approval_artifact_id: approval.id,
      source_packet_id: sourcePacket?.id || null,
      supersedes_packet_id: sourcePacket?.id || null,
      target_item_id: approval.target_item_id,
      operation: 'listing_quality_update',
      planned_mutation_fields: ['item_specifics'],
      final_item_specifics_hash: itemSpecificsHash,
      operator_supplied_json_only: true,
      guesses_from_title: false,
      no_ebay_call: true,
      no_get_item_call: true,
      no_revise_fixed_price_item_call: true,
      no_live_transport_call: true,
      no_marketplace_write: true,
      actual_ebay_call: false,
      marketplace_write_performed: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
      listing_changed: false,
      created_at: createdAt,
    },
    status: 'packet_recorded',
    confirmation_status: 'confirmed',
    confirmed_by_actor: actor || 'operator',
    confirmation_reason: reason || `Phase 13Y final item specifics supplied for approval artifact ${approval.id}`,
    confirmed_at: createdAt,
    confirmation_snapshot: {
      source: 'phase_13y_promoted_final_item_specifics_packet_confirmation_snapshot',
      approval_artifact_id: approval.id,
      source_packet_id: sourcePacket?.id || null,
      request_id: request.id || null,
      target_item_id: approval.target_item_id,
      planned_mutation: plannedMutation,
      planned_mutation_hash: sha256Json(plannedMutation),
      final_item_specifics_hash: itemSpecificsHash,
      packet_hash: packetHash,
      external_action_executed: false,
      marketplace_execution_approved: false,
      marketplace_write_performed: false,
      actual_ebay_call: false,
      created_at: createdAt,
    },
  };
}

async function getEbayListingQualityPromotedFinalItemSpecificsDetail({ approvalId } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const finalRows = await listPhase13YFinalItemSpecificsRows({ approvalId: id });
  const finalRequest = finalRows.requests[0] || null;
  const finalPacket = finalRows.packets[0] || null;
  const eventCount = finalRequest?.id != null ? await countMarketplaceExecutionEvents(finalRequest.id) : 0;
  const intent = finalRequest && finalPacket ? buildEbayListingQualityExecutionIntent({ packet: finalPacket, request: finalRequest, dryRun: true }) : null;
  const payload = finalRequest && finalPacket ? buildEbayListingQualityRevisePayload({ packet: finalPacket, request: finalRequest, intent }) : null;
  const itemSpecificsAudit = auditPhase13XItemSpecificsValue(finalPacket?.planned_mutation?.item_specifics || {});
  return {
    read_only: true,
    approval_id: id,
    source_request_id: context.existingRequests[0]?.id || null,
    source_packet_id: context.existingLegacyPackets[0]?.id || null,
    final_request_id: finalRequest?.id || null,
    final_packet_id: finalPacket?.id || null,
    target_item_id: finalPacket?.item_id || context.approval?.target_item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    final_request: finalRequest,
    final_packet: finalPacket,
    final_item_specifics: finalPacket?.planned_mutation?.item_specifics || null,
    item_specifics_audit: itemSpecificsAudit,
    payload_summary: payload?.payload_summary || null,
    validation: {
      target_item_id_exact: (finalPacket?.item_id || context.approval?.target_item_id) === '206315990948',
      operation_listing_quality_update: (finalRequest?.metadata?.operation || context.approval?.operation) === 'listing_quality_update',
      payload_fields: payload?.payload_summary?.payload_fields || [],
      payload_item_specifics_only: JSON.stringify(payload?.payload_summary?.payload_fields || []) === JSON.stringify(['ItemSpecifics']),
      no_title_mutation: payload?.payload_summary?.updates_title === false,
      no_description_mutation: payload?.payload_summary?.updates_description === false,
      no_price_inventory_quantity_mutation: payload?.payload_summary?.forbidden_fields_present === false,
      request_executed_at_is_null: finalRequest ? finalRequest.executed_at == null : null,
      request_execution_result_is_null: finalRequest ? finalRequest.execution_result == null : null,
      marketplace_execution_event_count: eventCount,
      no_marketplace_execution_events: eventCount === 0,
      source_packet_2_not_mutated: true,
    },
    safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
    source: 'phase_13y_promoted_final_item_specifics_detail_v1',
  };
}

async function createEbayListingQualityPromotedFinalItemSpecificsPacket({ approvalId, itemSpecificsJson = '{}', actor = null, reason = null, dryRun = true, write = false } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const writeRequested = write === true || dryRun === false;
  const cleanActor = trimOrNull(actor, 120) || 'operator';
  const cleanReason = trimOrNull(reason, 500) || 'final item specifics supplied';
  const operatorItemSpecifics = parseOperatorItemSpecifics(itemSpecificsJson);
  const mutation = buildOperatorListingQualityMutation({ itemSpecifics: operatorItemSpecifics });
  const finalItemSpecifics = mutation.item_specifics || {};
  const itemSpecificsAudit = auditPhase13XItemSpecificsValue(finalItemSpecifics);
  const itemSpecificsHash = phase13YFinalItemSpecificsHash(finalItemSpecifics);
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const approval = context.approval || null;
  const sourceRequest = context.existingRequests[0] || null;
  const sourcePacket = context.existingLegacyPackets[0] || null;
  const existing = await listPhase13YFinalItemSpecificsRows({ approvalId: id, itemSpecificsHash });
  const existingRequest = existing.requests[0] || null;
  const existingPacket = existing.packets[0] || null;
  const createdAt = new Date().toISOString();
  const blockers = [...itemSpecificsAudit.blockers];
  if (!Object.keys(finalItemSpecifics).length) blockers.push('operator_item_specifics_json_empty');
  if (!approval) blockers.push('approval_artifact_missing');
  if (approval?.id !== 15) blockers.push('approval_id_not_15');
  if (approval?.target_item_id !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if (approval?.operation !== 'listing_quality_update') blockers.push('operation_not_listing_quality_update');
  if (!sourceRequest) blockers.push('source_request_3_missing');
  if (sourceRequest?.id !== 3) blockers.push('source_request_id_not_3');
  if (!sourcePacket) blockers.push('source_packet_2_missing');
  if (sourcePacket?.id !== 2) blockers.push('source_packet_id_not_2');
  const sourceEventCount = sourceRequest?.id != null ? await countMarketplaceExecutionEvents(sourceRequest.id) : 0;
  if (sourceEventCount > 0) blockers.push('source_request_marketplace_execution_event_exists');

  const previewRequest = approval && sourceRequest && sourcePacket
    ? buildPhase13YFinalRequestRecord({ approval, sourceRequest, sourcePacket, itemSpecifics: finalItemSpecifics, itemSpecificsHash, actor: cleanActor, reason: cleanReason, createdAt })
    : null;
  const previewPacket = previewRequest
    ? buildPhase13YFinalLegacyPacketRecord({ request: existingRequest || { id: null }, approval, sourcePacket, itemSpecifics: finalItemSpecifics, itemSpecificsHash, actor: cleanActor, reason: cleanReason, createdAt })
    : null;
  const previewPayload = previewPacket && previewRequest
    ? buildEbayListingQualityRevisePayload({ packet: previewPacket, request: previewRequest })
    : null;
  if (previewPayload && JSON.stringify(previewPayload.payload_summary.payload_fields || []) !== JSON.stringify(['ItemSpecifics'])) blockers.push('payload_not_item_specifics_only');
  if (previewPayload?.payload_summary?.updates_title === true) blockers.push('payload_updates_title');
  if (previewPayload?.payload_summary?.updates_description === true) blockers.push('payload_updates_description');
  if (previewPayload?.payload_summary?.forbidden_fields_present === true) blockers.push('payload_forbidden_fields_present');
  const uniqueBlockers = [...new Set(blockers)];

  const base = {
    approval_id: id,
    source_request_id: sourceRequest?.id || null,
    source_packet_id: sourcePacket?.id || null,
    target_item_id: approval?.target_item_id || sourcePacket?.item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    operator_supplied_json_only: true,
    guesses_from_title: false,
    final_item_specifics: finalItemSpecifics,
    final_item_specifics_hash: itemSpecificsHash,
    item_specifics_audit: itemSpecificsAudit,
    payload_summary: previewPayload?.payload_summary || null,
    source_packet_2_mutated: false,
    safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
    source: 'phase_13y_promoted_final_item_specifics_packet_v1',
  };

  if (uniqueBlockers.length) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      ...base,
      blocked: true,
      blockers: uniqueBlockers,
      existing_request: existingRequest,
      existing_packet: existingPacket,
      request_preview: previewRequest,
      packet_preview: previewPacket,
      actual_database_write: false,
      actual_ebay_call: false,
      marketplace_write_performed: false,
    };
  }

  if (!writeRequested) {
    return {
      read_only: true,
      dry_run: true,
      write_requested: false,
      ...base,
      blocked: false,
      blockers: [],
      idempotent_existing: Boolean(existingRequest && existingPacket),
      existing_request: existingRequest,
      existing_packet: existingPacket,
      request_preview: previewRequest,
      packet_preview: previewPacket,
      validation: {
        target_item_id_exact: base.target_item_id === '206315990948',
        operation_listing_quality_update: true,
        payload_fields: previewPayload?.payload_summary?.payload_fields || [],
        payload_item_specifics_only: JSON.stringify(previewPayload?.payload_summary?.payload_fields || []) === JSON.stringify(['ItemSpecifics']),
        no_title_mutation: previewPayload?.payload_summary?.updates_title === false,
        no_description_mutation: previewPayload?.payload_summary?.updates_description === false,
        no_price_inventory_quantity_mutation: previewPayload?.payload_summary?.forbidden_fields_present === false,
        request_executed_at: null,
        request_execution_result: null,
        source_request_marketplace_execution_event_count: sourceEventCount,
      },
      actual_database_write: false,
      actual_ebay_call: false,
      marketplace_write_performed: false,
    };
  }

  const db = getClient();
  let finalRequest = existingRequest;
  let requestCreated = false;
  if (!finalRequest) {
    const { data, error } = await db.from(REQUEST_TABLE).insert(previewRequest).select('*').single();
    if (error) throw error;
    finalRequest = data;
    requestCreated = true;
  }
  let packetRows = existing.packets;
  if (!packetRows.length && finalRequest?.id != null) {
    packetRows = await safeSelectRows(EBAY_LISTING_QUALITY_PACKET_TABLE, '*', q => q.eq('request_id', finalRequest.id).order('id', { ascending: true }).limit(20));
  }
  let finalPacket = packetRows[0] || null;
  let packetCreated = false;
  if (!finalPacket) {
    const packetRecord = buildPhase13YFinalLegacyPacketRecord({ request: finalRequest, approval, sourcePacket, itemSpecifics: finalItemSpecifics, itemSpecificsHash, actor: cleanActor, reason: cleanReason, createdAt });
    const { data, error } = await db.from(EBAY_LISTING_QUALITY_PACKET_TABLE).insert(packetRecord).select('*').single();
    if (error) throw error;
    finalPacket = data;
    packetCreated = true;
  }
  const finalEventCount = finalRequest?.id != null ? await countMarketplaceExecutionEvents(finalRequest.id) : 0;
  return {
    read_only: false,
    dry_run: false,
    write_requested: true,
    ...base,
    blocked: false,
    blockers: [],
    created: requestCreated || packetCreated,
    request_created: requestCreated,
    packet_created: packetCreated,
    idempotent_existing: !requestCreated && !packetCreated,
    final_request: finalRequest,
    final_packet: finalPacket,
    final_request_id: finalRequest?.id || null,
    final_packet_id: finalPacket?.id || null,
    validation: {
      target_item_id_exact: finalPacket?.item_id === '206315990948',
      operation_listing_quality_update: (finalRequest?.metadata?.operation || null) === 'listing_quality_update',
      payload_fields: buildEbayListingQualityRevisePayload({ packet: finalPacket, request: finalRequest }).payload_summary.payload_fields,
      payload_item_specifics_only: JSON.stringify(buildEbayListingQualityRevisePayload({ packet: finalPacket, request: finalRequest }).payload_summary.payload_fields) === JSON.stringify(['ItemSpecifics']),
      no_title_mutation: buildEbayListingQualityRevisePayload({ packet: finalPacket, request: finalRequest }).payload_summary.updates_title === false,
      no_description_mutation: buildEbayListingQualityRevisePayload({ packet: finalPacket, request: finalRequest }).payload_summary.updates_description === false,
      no_price_inventory_quantity_mutation: buildEbayListingQualityRevisePayload({ packet: finalPacket, request: finalRequest }).payload_summary.forbidden_fields_present === false,
      request_executed_at: finalRequest?.executed_at || null,
      request_execution_result: finalRequest?.execution_result || null,
      final_request_marketplace_execution_event_count: finalEventCount,
      source_request_marketplace_execution_event_count: sourceEventCount,
      source_packet_2_mutated: false,
    },
    safety: {
      ...phase13VPromotedBridgeSafety({ databaseWrite: true }),
      database_write_scope: 'internal Phase 13Y superseding final item_specifics request/packet records only',
      actual_ebay_call: false,
      marketplace_write_performed: false,
      live_transport_called: false,
    },
  };
}

async function buildEbayListingQualityPromotedLiveReadiness({ approvalId } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const { approval, packet, existingRequests, existingLegacyPackets, marketplaceEventCount } = context;
  const finalRows = await listPhase13YFinalItemSpecificsRows({ approvalId: id });
  const finalRequest = finalRows.requests[0] || null;
  const finalPacket = finalRows.packets[0] || null;
  const request = finalRequest || existingRequests[0] || null;
  const legacyPacket = finalPacket || existingLegacyPackets[0] || null;
  const usingFinalPacket = Boolean(finalRequest && finalPacket);
  const validation = usingFinalPacket
    ? { blockers: [], planned_mutation_fields: ['item_specifics'], planned_mutation_item_specifics_only: true }
    : validatePhase13VPromotedBridgeInputs({ approval, packet, existingRequests, existingLegacyPackets, marketplaceEventCount });
  let intent = null;
  let payload = null;
  let rollbackSnapshot = null;
  if (request && legacyPacket) {
    intent = buildEbayListingQualityExecutionIntent({ packet: legacyPacket, request, dryRun: true });
    payload = buildEbayListingQualityRevisePayload({ packet: legacyPacket, request, intent });
    rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet: legacyPacket });
  }
  const selectedMarketplaceEventCount = request?.id != null ? await countMarketplaceExecutionEvents(request.id) : marketplaceEventCount;
  const payloadFields = payload?.payload_summary?.payload_fields || [];
  const itemSpecificsAudit = auditPhase13XItemSpecificsValue(legacyPacket?.planned_mutation?.item_specifics || approval?.planned_mutation?.item_specifics || {});
  const readinessBlockers = [...validation.blockers];
  if (itemSpecificsAudit.blocked) readinessBlockers.push(...itemSpecificsAudit.blockers);
  if (!request) readinessBlockers.push('promoted_bridge_execution_request_missing');
  if (!legacyPacket) readinessBlockers.push('promoted_bridge_legacy_packet_missing');
  if (request && request.final_approval_status !== 'approved') readinessBlockers.push('request_final_approval_status_not_approved');
  if (request && request.executed_at != null) readinessBlockers.push('request_executed_at_present');
  if (request && request.execution_result != null) readinessBlockers.push('request_execution_result_present');
  if (request?.metadata?.external_action_executed === true) readinessBlockers.push('external_action_executed_true');
  if (request?.metadata?.marketplace_execution_approved === true) readinessBlockers.push('marketplace_execution_approved_true');
  if (legacyPacket && legacyPacket.item_id !== '206315990948') readinessBlockers.push('legacy_packet_target_item_id_not_206315990948');
  if (legacyPacket && legacyPacket.confirmation_status !== 'confirmed') readinessBlockers.push('legacy_packet_confirmation_status_not_confirmed');
  if (payload && (payloadFields.length !== 1 || payloadFields[0] !== 'ItemSpecifics')) readinessBlockers.push('payload_not_item_specifics_only');
  if (payload?.payload_summary?.updates_title === true) readinessBlockers.push('payload_updates_title');
  if (payload?.payload_summary?.updates_description === true) readinessBlockers.push('payload_updates_description');
  if (payload?.payload_summary?.updates_item_specifics !== true) readinessBlockers.push('payload_does_not_update_item_specifics');
  if (payload?.payload_summary?.forbidden_fields_present === true) readinessBlockers.push('payload_forbidden_fields_present');
  if (selectedMarketplaceEventCount > 0) readinessBlockers.push('previous_marketplace_execution_event_exists');
  if (rollbackSnapshot && rollbackSnapshot.available !== true) readinessBlockers.push('rollback_snapshot_missing');
  const uniqueBlockers = [...new Set(readinessBlockers)];
  return {
    read_only: true,
    approval_id: id,
    request_id: request?.id || null,
    legacy_packet_id: legacyPacket?.id || null,
    source_request_id: existingRequests[0]?.id || null,
    source_legacy_packet_id: existingLegacyPackets[0]?.id || null,
    using_final_item_specifics_packet: usingFinalPacket,
    target_item_id: legacyPacket?.item_id || approval?.target_item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    ready_for_promoted_live_path_review: uniqueBlockers.length === 0,
    ready_for_live_execution: false,
    phase_13v_does_not_execute_ebay: true,
    blockers: uniqueBlockers,
    checks: {
      bridge_request_exists: Boolean(request),
      legacy_packet_exists: Boolean(legacyPacket),
      target_item_id_exact: (legacyPacket?.item_id || approval?.target_item_id) === '206315990948',
      operation_listing_quality_update: (request?.metadata?.operation || approval?.operation) === 'listing_quality_update',
      planned_mutation_fields: legacyPacket ? Object.keys(legacyPacket.planned_mutation || {}) : validation.planned_mutation_fields,
      planned_mutation_item_specifics_only: legacyPacket ? JSON.stringify(Object.keys(legacyPacket.planned_mutation || {})) === JSON.stringify(['item_specifics']) : validation.planned_mutation_item_specifics_only,
      request_final_approval_status: request?.final_approval_status || null,
      request_executed_at_is_null: request ? request.executed_at == null : null,
      request_execution_result_is_null: request ? request.execution_result == null : null,
      metadata_external_action_executed_false: request ? request.metadata?.external_action_executed === false : null,
      metadata_marketplace_execution_approved_false: request ? request.metadata?.marketplace_execution_approved === false : null,
      no_previous_marketplace_execution_event: selectedMarketplaceEventCount === 0,
      previous_marketplace_execution_event_count: selectedMarketplaceEventCount,
      payload_builds: Boolean(payload),
      payload_fields: payloadFields,
      payload_item_specifics_only: payloadFields.length === 1 && payloadFields[0] === 'ItemSpecifics',
      item_specifics_audit_blocked: itemSpecificsAudit.blocked,
      item_specifics_audit_blockers: itemSpecificsAudit.blockers,
      rollback_snapshot_exists: rollbackSnapshot?.available === true,
      live_transport_called: false,
    },
    payload_summary: payload?.payload_summary || null,
    item_specifics_audit: itemSpecificsAudit,
    rollback_snapshot_summary: rollbackSnapshot ? {
      available: rollbackSnapshot.available === true,
      title_present: Boolean(rollbackSnapshot.title),
      description_present: Boolean(rollbackSnapshot.description),
      item_specifics_count: Object.keys(rollbackSnapshot.item_specifics || {}).length,
      source: rollbackSnapshot.source || null,
      packet_hash: rollbackSnapshot.packet_hash || null,
    } : null,
    safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
    source: 'phase_13v_promoted_live_readiness_v1',
  };
}


function validatePhase13WPromotedLiveTransportBoundary({ approval, request, legacyPacket, payload, marketplaceEventCount = 0 } = {}) {
  const blockers = [];
  const payloadFields = payload?.payload_summary?.payload_fields || [];
  const plannedFields = legacyPacket ? Object.keys(legacyPacket.planned_mutation || {}) : [];
  if (!approval) blockers.push('approval_artifact_missing');
  if (approval?.id !== 15) blockers.push('approval_id_not_15');
  const isFinalPhase13Y = request?.metadata?.phase13y_promoted_final_item_specifics_packet === true || legacyPacket?.safety_flags?.phase13y_promoted_final_item_specifics_packet === true;
  const expectedRequestId = isFinalPhase13Y ? 4 : 3;
  const expectedPacketId = isFinalPhase13Y ? 3 : 2;
  if (!request) blockers.push('bridge_request_missing');
  if (request && request.id !== expectedRequestId) blockers.push(`request_id_not_${expectedRequestId}`);
  if (!legacyPacket) blockers.push('legacy_packet_missing');
  if (legacyPacket && legacyPacket.id !== expectedPacketId) blockers.push(`packet_id_not_${expectedPacketId}`);
  if ((legacyPacket?.item_id || approval?.target_item_id) !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if ((request?.metadata?.operation || request?.requested_action?.operation || approval?.operation) !== 'listing_quality_update') blockers.push('operation_not_listing_quality_update');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (payloadFields.length !== 1 || payloadFields[0] !== 'ItemSpecifics') blockers.push('payload_fields_not_item_specifics_only');
  if (request?.final_approval_status !== 'approved') blockers.push('request_final_approval_status_not_approved');
  if (request?.executed_at != null) blockers.push('request_executed_at_present');
  if (request?.execution_result != null) blockers.push('request_execution_result_present');
  if (request?.metadata?.external_action_executed !== false) blockers.push('metadata_external_action_executed_not_false');
  if (request?.metadata?.marketplace_execution_approved !== false) blockers.push('metadata_marketplace_execution_approved_not_false');
  if ((marketplaceEventCount || 0) > 0) blockers.push('previous_marketplace_execution_event_exists');
  if (payload?.payload_summary?.updates_title === true) blockers.push('payload_updates_title');
  if (payload?.payload_summary?.updates_description === true) blockers.push('payload_updates_description');
  if (payload?.payload_summary?.updates_item_specifics !== true) blockers.push('payload_does_not_update_item_specifics');
  if (payload?.payload_summary?.forbidden_fields_present === true) blockers.push('payload_forbidden_fields_present');
  if (Array.isArray(payload?.payload_summary?.forbidden_fields) && payload.payload_summary.forbidden_fields.length) blockers.push('payload_forbidden_fields_present');
  if (Array.isArray(payload?.payload_summary?.non_allowed_fields) && payload.payload_summary.non_allowed_fields.length) blockers.push('payload_non_allowed_fields_present');
  if (objectHasForbiddenMarketplaceMutationFields(legacyPacket?.planned_mutation || {}).length) blockers.push('planned_mutation_forbidden_fields_present');
  const itemSpecificsAudit = auditPhase13XItemSpecificsValue(legacyPacket?.planned_mutation?.item_specifics || {});
  if (itemSpecificsAudit.blocked) blockers.push(...itemSpecificsAudit.blockers);
  return {
    blockers: [...new Set(blockers)],
    planned_mutation_fields: plannedFields,
    payload_fields: payloadFields,
    item_specifics_audit: itemSpecificsAudit,
  };
}


function buildPhase13YLiveExecutionBlockers({ approval, packet, request, payload, rollbackSnapshot, itemSpecificsAudit, previousMarketplaceExecutionEventCount } = {}) {
  const summary = payload?.payload_summary || {};
  const payloadFields = Array.isArray(summary.payload_fields) ? summary.payload_fields : [];
  const plannedFields = Object.keys(packet?.planned_mutation || {});
  const blockers = [];
  if (approval?.id !== 15) blockers.push('approval_id_not_15');
  if (request?.id !== 4) blockers.push('request_id_not_4');
  if (packet?.id !== 3) blockers.push('packet_id_not_3');
  if (String(packet?.item_id || '') !== '206315990948') blockers.push('target_item_id_not_206315990948');
  if ((request?.metadata?.operation || request?.requested_action?.operation || approval?.operation) !== 'listing_quality_update') blockers.push('operation_not_listing_quality_update');
  if (packet?.status !== 'packet_recorded') blockers.push('packet_status_not_packet_recorded');
  if (packet?.confirmation_status !== 'confirmed') blockers.push('packet_confirmation_status_not_confirmed');
  if (request?.final_approval_status !== 'approved') blockers.push('request_final_approval_not_approved');
  if (!rollbackSnapshot || rollbackSnapshot.available !== true) blockers.push('rollback_snapshot_missing');
  if (request?.executed_at != null) blockers.push('request_executed_at_present');
  if (request?.execution_result != null) blockers.push('request_execution_result_present');
  if (request?.metadata?.external_action_executed !== false) blockers.push('metadata_external_action_executed_not_false');
  if (request?.metadata?.marketplace_execution_approved !== false) blockers.push('metadata_marketplace_execution_approved_not_false');
  if ((previousMarketplaceExecutionEventCount || 0) > 0) blockers.push('previous_marketplace_execution_event_exists');
  if (plannedFields.length !== 1 || plannedFields[0] !== 'item_specifics') blockers.push('planned_mutation_not_item_specifics_only');
  if (payloadFields.length !== 1 || payloadFields[0] !== 'ItemSpecifics') blockers.push('payload_not_item_specifics_only');
  if (summary.updates_item_specifics !== true) blockers.push('payload_does_not_update_item_specifics');
  if (summary.updates_title === true) blockers.push('payload_updates_title_not_allowed');
  if (summary.updates_description === true) blockers.push('payload_updates_description_not_allowed');
  if (summary.forbidden_fields_present === true) blockers.push('payload_forbidden_fields_present');
  if (Array.isArray(summary.forbidden_fields) && summary.forbidden_fields.length) blockers.push('payload_forbidden_fields_present');
  if (Array.isArray(summary.non_allowed_fields) && summary.non_allowed_fields.length) blockers.push('payload_non_allowed_fields_present');
  if (itemSpecificsAudit?.blocked === true) blockers.push(...(itemSpecificsAudit.blockers || ['item_specifics_audit_blocked']));
  if (request?.metadata?.phase13y_promoted_final_item_specifics_packet !== true) blockers.push('request_not_phase13y_final_item_specifics_packet');
  if (packet?.safety_flags?.phase13y_promoted_final_item_specifics_packet !== true) blockers.push('packet_not_phase13y_final_item_specifics_packet');
  return [...new Set(blockers)];
}

async function persistPhase13YPromotedLiveExecutionResult({ packet, request, payload, transportResult } = {}) {
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
    listing_changed: transportResult.marketplace_write_performed === true,
    revise_fixed_price_item_called: transportResult.actual_ebay_call === true,
    live_transport_called: transportResult.actual_ebay_call === true,
    price_changes: false,
    inventory_changes: false,
    quantity_changes: false,
    title_changes: false,
    description_changes: false,
    item_specifics_changes: true,
    item_specifics_only: true,
    recorded_at: new Date().toISOString(),
    source: 'phase_13y_promoted_live_single_sku_item_specifics_execution_v1',
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
      marketplace_execution_scope: 'phase_13y_single_sku_item_specifics_only',
      actual_ebay_call: true,
      actual_network_call: true,
      live_transport_called: true,
      revise_fixed_price_item_called: true,
      marketplace_write_performed: true,
      listing_changed: true,
      marketplace_execution_price_changes: false,
      marketplace_execution_inventory_changes: false,
      marketplace_execution_quantity_changes: false,
      marketplace_execution_title_changes: false,
      marketplace_execution_description_changes: false,
      marketplace_execution_item_specifics_changes: true,
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
      ? 'eBay response parsed as success/warning; executed_at and execution_result were recorded after the confirmed promoted item_specifics response.'
      : 'eBay response was not success; marketplace failure event recorded, but executed_at was not set.',
  };
}

async function callEbayListingQualityPromotedLiveTransportBoundary({ approvalId, dryRun = true, write = false } = {}) {
  const id = intOrNull(approvalId);
  if (id == null) throw new Error('approval-id is required');
  const writeRequested = write === true || dryRun === false;
  const isDryRun = !writeRequested;
  const liveEnvEnabled = String(process.env[EBAY_LIVE_ENABLE_ENV_NAME] || '').toLowerCase() === 'true';
  const context = await loadPhase13VPromotedBridgeContext({ approvalId: id });
  const approval = context.approval || null;
  const finalRows = await listPhase13YFinalItemSpecificsRows({ approvalId: id });
  const request = finalRows.requests[0] || context.existingRequests[0] || null;
  const legacyPacket = finalRows.packets[0] || context.existingLegacyPackets[0] || null;
  const intent = legacyPacket && request
    ? buildEbayListingQualityExecutionIntent({ packet: legacyPacket, request, dryRun: true })
    : null;
  const payload = legacyPacket && request
    ? buildEbayListingQualityRevisePayload({ packet: legacyPacket, request, intent })
    : null;
  const rollbackSnapshot = legacyPacket ? prepareEbayListingQualityRollbackSnapshot({ packet: legacyPacket }) : null;
  const selectedMarketplaceEventCount = request?.id != null ? await countMarketplaceExecutionEvents(request.id) : context.marketplaceEventCount;
  const validation = validatePhase13WPromotedLiveTransportBoundary({
    approval,
    request,
    legacyPacket,
    payload,
    marketplaceEventCount: selectedMarketplaceEventCount,
  });
  const rollbackAvailable = rollbackSnapshot?.available === true;
  const itemSpecificsAudit = validation.item_specifics_audit || auditPhase13XItemSpecificsValue(legacyPacket?.planned_mutation?.item_specifics || {});
  const phase13YBlockers = buildPhase13YLiveExecutionBlockers({
    approval,
    request,
    packet: legacyPacket,
    payload,
    rollbackSnapshot,
    itemSpecificsAudit,
    previousMarketplaceExecutionEventCount: selectedMarketplaceEventCount,
  });
  const readinessBlockers = [...validation.blockers];
  const liveBlockers = [];
  const liveAttempt = writeRequested && liveEnvEnabled;
  if (writeRequested && !liveEnvEnabled) {
    liveBlockers.push('live_ebay_execution_disabled');
    liveBlockers.push('live_ebay_execution_env_disabled');
  }
  if (writeRequested && !liveAttempt) liveBlockers.push('live_execution_not_attempted');
  if (liveAttempt) liveBlockers.push(...phase13YBlockers);
  const blockers = isDryRun ? readinessBlockers : [...new Set([...readinessBlockers, ...liveBlockers])];
  const payloadReady = readinessBlockers.length === 0 && phase13YBlockers.length === 0 && rollbackAvailable && Boolean(payload?.payload?.Item?.ItemID);
  const blocked = blockers.length > 0;
  const ebayApiModulePath = resolveExistingEbayApiModulePath();
  const baseResult = {
    read_only: true,
    dry_run: isDryRun,
    write_requested: writeRequested,
    approval_id: id,
    request_id: request?.id || null,
    packet_id: legacyPacket?.id || null,
    target_item_id: legacyPacket?.item_id || approval?.target_item_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    api_operation: 'ReviseFixedPriceItem',
    promoted_guard: true,
    ready_for_live_call: payloadReady,
    would_call_ebay: payloadReady,
    blocked,
    blockers,
    live_blockers: isDryRun ? [] : liveBlockers,
    actual_ebay_call: false,
    actual_network_call: false,
    actual_database_write: false,
    marketplace_write_performed: false,
    get_item_called: false,
    revise_fixed_price_item_called: false,
    live_transport_called: false,
    executed_at_updated: false,
    execution_result_updated: false,
    payload_ready: payloadReady,
    payload: payload?.payload || null,
    payload_summary: payload?.payload_summary || null,
    item_specifics_audit: validation.item_specifics_audit || null,
    rollback_snapshot_summary: rollbackSnapshot ? {
      available: rollbackSnapshot.available === true,
      title_present: Boolean(rollbackSnapshot.title),
      description_present: Boolean(rollbackSnapshot.description),
      item_specifics_count: Object.keys(rollbackSnapshot.item_specifics || {}).length,
      packet_hash: rollbackSnapshot.packet_hash || null,
      source: rollbackSnapshot.source || null,
    } : null,
    validation: {
      approval_id_exact: approval?.id === 15,
      request_id_exact: request?.id === (request?.metadata?.phase13y_promoted_final_item_specifics_packet === true ? 4 : 3),
      packet_id_exact: legacyPacket?.id === (legacyPacket?.safety_flags?.phase13y_promoted_final_item_specifics_packet === true ? 3 : 2),
      target_item_id_exact: (legacyPacket?.item_id || approval?.target_item_id) === '206315990948',
      operation_listing_quality_update: (request?.metadata?.operation || request?.requested_action?.operation || approval?.operation) === 'listing_quality_update',
      planned_mutation_fields: validation.planned_mutation_fields,
      planned_mutation_item_specifics_only: JSON.stringify(validation.planned_mutation_fields) === JSON.stringify(['item_specifics']),
      payload_fields: validation.payload_fields,
      payload_item_specifics_only: JSON.stringify(validation.payload_fields) === JSON.stringify(['ItemSpecifics']),
      item_specifics_audit_blocked: validation.item_specifics_audit?.blocked === true,
      item_specifics_audit_blockers: validation.item_specifics_audit?.blockers || [],
      request_final_approval_status: request?.final_approval_status || null,
      request_executed_at_is_null: request ? request.executed_at == null : null,
      request_execution_result_is_null: request ? request.execution_result == null : null,
      metadata_external_action_executed_false: request ? request.metadata?.external_action_executed === false : null,
      metadata_marketplace_execution_approved_false: request ? request.metadata?.marketplace_execution_approved === false : null,
      no_previous_marketplace_execution_event: context.marketplaceEventCount === 0,
      previous_marketplace_execution_event_count: context.marketplaceEventCount,
      no_title_mutation: payload?.payload_summary?.updates_title === false,
      no_description_mutation: payload?.payload_summary?.updates_description === false,
      no_price_inventory_quantity_mutation: payload?.payload_summary?.forbidden_fields_present === false,
    },
    safety: {
      ...phase13VPromotedBridgeSafety({ databaseWrite: false }),
      read_only: true,
      actual_ebay_call: false,
      get_item_called: false,
      actual_network_call: false,
      live_transport_called: false,
      actual_database_write: false,
      marketplace_write_performed: false,
      revise_fixed_price_item_called: false,
      executed_at_updated: false,
      execution_result_updated: false,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
      listing_changed: false,
    },
    note: isDryRun
      ? 'Dry-run boundary validation only. Payload was built, but no eBay/GetItem/ReviseFixedPriceItem/live transport/database write occurred.'
      : 'Disabled write boundary validation only. Live execution is blocked in Phase 13W and no eBay/live transport/database write occurred.',
    phase13y_live_execution_blockers: phase13YBlockers,
    previous_marketplace_execution_event_count_before_call: selectedMarketplaceEventCount,
    existing_ebay_api_module_path: ebayApiModulePath ? 'src/api/ebayAPI.js' : null,
    source: 'phase_13w_promoted_live_transport_boundary_v1',
  };

  if (!liveAttempt || blocked || !payloadReady) return baseResult;

  const transportResult = await callEbayListingQualityLiveTransport({
    packet: legacyPacket,
    request,
    payload,
    dryRun: false,
    writeRequested: true,
    liveEnabled: true,
    ebayApiModulePath,
  });
  const liveBase = {
    ...baseResult,
    ...transportResult,
    actual_ebay_call: transportResult.actual_ebay_call === true,
    actual_network_call: transportResult.actual_network_call === true,
    marketplace_write_performed: transportResult.marketplace_write_performed === true,
    live_transport_called: transportResult.actual_ebay_call === true,
    revise_fixed_price_item_called: transportResult.actual_ebay_call === true,
    listing_changed: transportResult.marketplace_write_performed === true,
    note: transportResult.actual_ebay_call === true
      ? 'Promoted live transport executed approved packet 3/request 4 against eBay; only ItemSpecifics was included in the payload.'
      : baseResult.note,
    previous_marketplace_execution_event_count_before_call: selectedMarketplaceEventCount,
    existing_ebay_api_module_path: ebayApiModulePath ? 'src/api/ebayAPI.js' : null,
  };
  if (transportResult.blocked || transportResult.actual_ebay_call !== true) return liveBase;

  const persistence = await persistPhase13YPromotedLiveExecutionResult({
    packet: legacyPacket,
    request,
    payload,
    transportResult,
  });
  return {
    ...liveBase,
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
      ...(liveBase.safety || {}),
      database_writes: true,
      execution_result_updated: persistence.execution_result_updated,
      executed_at_updated: persistence.executed_at_updated,
      price_changes: false,
      inventory_changes: false,
      quantity_changes: false,
      title_changes: false,
      description_changes: false,
      item_specifics_changes: true,
    },
  };
}

async function buildEbayListingQualityPromotedLiveRunbook({ approvalId } = {}) {
  const readiness = await buildEbayListingQualityPromotedLiveReadiness({ approvalId });
  return {
    read_only: true,
    approval_id: readiness.approval_id,
    request_id: readiness.request_id,
    legacy_packet_id: readiness.legacy_packet_id,
    target_item_id: readiness.target_item_id,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    phase_warning: 'Phase 13V is bridge/readiness/runbook only. It must not execute eBay or call live transport.',
    operator_checklist: [
      'Confirm approval artifact id=15 is approved from Phase 13U.',
      'Confirm promoted packet artifact id=14 remains confirmed from Phase 13S.',
      'Confirm bridge request and legacy-compatible packet exist exactly once.',
      'Confirm target_item_id is exactly 206315990948.',
      'Confirm planned mutation fields are exactly item_specifics.',
      'Confirm request.final_approval_status is approved and derived from approval artifact id=15.',
      'Confirm request.executed_at and request.execution_result are null.',
      'Confirm metadata.external_action_executed=false and metadata.marketplace_execution_approved=false.',
      'Confirm no previous marketplace execution event exists for the bridged request.',
      'Do not run live transport or any eBay execute command in Phase 13V.',
    ],
    allowed_phase_13v_commands: {
      create_bridge_dry_run: 'npm run hermes:agent -- ebay-listing-quality-create-promoted-execution-bridge --approval-id=15 --dry-run',
      create_bridge_write: 'npm run hermes:agent -- ebay-listing-quality-create-promoted-execution-bridge --approval-id=15 --write',
      readiness: 'npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=15',
      runbook: 'npm run hermes:agent -- ebay-listing-quality-promoted-live-runbook --approval-id=15',
    },
    explicitly_disallowed_in_phase_13v: [
      'npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=<BRIDGE_PACKET_ID> --write',
      'HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=<BRIDGE_PACKET_ID> --write',
      'any GetItem verification call',
      'any ReviseFixedPriceItem call',
      'any marketplace write',
    ],
    readiness_summary: readiness,
    safety: phase13VPromotedBridgeSafety({ databaseWrite: false }),
    source: 'phase_13v_promoted_live_runbook_v1',
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
      get_item_called: false,
      actual_network_call: false,
      actual_database_write: false,
      blockers: boundary.blockers || [],
    },
    safety: {
      actual_ebay_call: false,
      get_item_called: false,
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
      get_item_called: false,
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
  buildEbayListingQualityControlledExpansionPlan,
  buildEbayListingQualityFreshCandidateSourcePlan,
  buildEbayListingQualityCandidateSeedPreview,
  buildEbayListingQualitySeedSignalDominanceAudit,
  buildEbayListingQualitySeedScoringPreview,
  auditEbayListingQualityCandidateSources,
  rescanEbayListingQualityCandidates,
  buildEbayListingQualityEvidenceRefreshPlan,
  previewEbayListingQualityEvidenceRefresh,
  sampleEbayListingQualityEvidenceRefresh,
  fetchEbayListingQualityEvidence,
  scoreEbayListingQualityEvidence,
  auditEbayListingQualityScore,
  previewEbayListingQualityOpportunities,
  previewEbayListingQualityBorderlineImprovements,
  writeEbayListingQualityBorderlineInbox,
  listEbayListingQualityBorderlineReviews,
  getEbayListingQualityBorderlineReviewDetail,
  actOnEbayListingQualityBorderlineReview,
  checkEbayListingQualityBorderlinePromotionEligibility,
  scanEbayListingQualityBorderlinePromotionCandidates,
  promoteEbayListingQualityBorderlineReview,
  listEbayListingQualityPromotedOpportunities,
  getEbayListingQualityPromotedOpportunityDetail,
  actOnEbayListingQualityPromotedOpportunity,
  buildEbayListingQualityPromotedPacketPreview,
  createEbayListingQualityPromotedPacket,
  getEbayListingQualityPromotedPacketDetail,
  confirmEbayListingQualityPromotedPacket,
  createEbayListingQualityPromotedApproval,
  getEbayListingQualityPromotedApprovalDetail,
  actOnEbayListingQualityPromotedApproval,
  createEbayListingQualityPromotedExecutionBridge,
  auditEbayListingQualityPromotedItemSpecifics,
  previewEbayListingQualityPromotedItemSpecifics,
  createEbayListingQualityPromotedFinalItemSpecificsPacket,
  getEbayListingQualityPromotedFinalItemSpecificsDetail,
  buildEbayListingQualityPromotedLiveReadiness,
  buildEbayListingQualityPromotedLiveRunbook,
  callEbayListingQualityPromotedLiveTransportBoundary,
  callEbayListingQualityLiveTransportBoundary,
  callEbayListingQualityBoundary,
  mockCallEbayListingQualityPacket,
  executeEbayListingQualityPacket,
  recordEbayListingQualityExecutionResult,
  reviewExecutionRequest,
  listExecutionEvents,
  recordExecutionEvent,
};
