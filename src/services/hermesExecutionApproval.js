'use strict';

/**
 * Hermes Phase 5A — Approval-gated execution foundation.
 *
 * Internal request/event records only. This module must not call marketplace APIs,
 * change price, change inventory, change listing content, execute actions, or call AI.
 */

const { getClient } = require('../db/supabaseClient');
const { buildHermesOpportunityActionPlan } = require('./opportunityInbox');

const REQUEST_TABLE = 'hermes_execution_requests';
const EVENT_TABLE = 'hermes_execution_events';

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

module.exports = {
  STATUSES,
  EXECUTION_TYPES,
  RISK_LEVELS,
  PHASE5_FORBIDDEN_ACTIONS,
  buildExecutionRequestFromOpportunity,
  validateExecutionRequest,
  createExecutionRequest,
  listExecutionRequests,
  recordExecutionEvent,
};
