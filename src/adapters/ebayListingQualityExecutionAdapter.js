'use strict';

/**
 * Phase 12A — guarded eBay listing_quality_update execution adapter v1.
 *
 * This adapter builds the marketplace write intent, but the default path is dry-run only.
 * It does not import or call any eBay API client in Phase 12A.
 */

const ALLOWED_LISTING_QUALITY_FIELDS = ['title', 'description', 'item_specifics'];
const FORBIDDEN_FIELD_PATTERNS = [
  /price/i,
  /quantity/i,
  /qty/i,
  /inventory/i,
  /stock/i,
  /end(ing)?_?listing/i,
  /^end$/i,
  /create_?listing/i,
  /^create$/i,
  /relist/i,
  /revise/i,
];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mutationIsEmpty(mutation) {
  const payload = isPlainObject(mutation) ? mutation : {};
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const description = typeof payload.description === 'string' ? payload.description.trim() : '';
  const itemSpecifics = isPlainObject(payload.item_specifics) ? payload.item_specifics : {};
  return !title && !description && Object.keys(itemSpecifics).length === 0;
}

function findForbiddenMutationFields(value, path = []) {
  if (value == null || typeof value !== 'object') return [];
  const findings = [];
  const entries = Array.isArray(value) ? value.map((v, idx) => [String(idx), v]) : Object.entries(value);
  for (const [key, child] of entries) {
    const nextPath = [...path, key];
    const dotted = nextPath.join('.');
    if (FORBIDDEN_FIELD_PATTERNS.some(pattern => pattern.test(key) || pattern.test(dotted))) {
      findings.push(dotted);
    }
    findings.push(...findForbiddenMutationFields(child, nextPath));
  }
  return [...new Set(findings)];
}

function normalizeListingQualityMutation(mutation) {
  const payload = isPlainObject(mutation) ? mutation : {};
  const normalized = {
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title : null,
    description: typeof payload.description === 'string' && payload.description.trim() ? payload.description : null,
    item_specifics: {},
  };

  if (isPlainObject(payload.item_specifics)) {
    for (const [key, value] of Object.entries(payload.item_specifics)) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) continue;
      if (value == null) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      normalized.item_specifics[cleanKey] = value;
    }
  }

  return normalized;
}

function buildEbayListingQualityExecutionIntent({ packet, request, dryRun = true } = {}) {
  const plannedMutation = normalizeListingQualityMutation(packet?.planned_mutation || {});
  const forbiddenFields = findForbiddenMutationFields(plannedMutation);
  const nonAllowedFields = Object.keys(packet?.planned_mutation || {}).filter(key => !ALLOWED_LISTING_QUALITY_FIELDS.includes(key));
  const blockers = [];

  if (!packet) blockers.push('packet_required');
  if (!request) blockers.push('request_required');
  if (packet && packet.status !== 'packet_recorded') blockers.push('packet_status_not_packet_recorded');
  if (packet && packet.confirmation_status !== 'confirmed') blockers.push('packet_confirmation_status_not_confirmed');
  if (request && request.final_approval_status !== 'approved') blockers.push('request_final_approval_not_approved');
  if (request && request.executed_at != null) blockers.push('request_executed_at_present');
  if (request && request.execution_result != null) blockers.push('request_execution_result_present');
  if (request?.metadata?.external_action_executed === true) blockers.push('external_action_executed_true');
  if (request?.metadata?.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (!packet?.item_id) blockers.push('target_item_id_missing');
  if (mutationIsEmpty(plannedMutation)) blockers.push('planned_mutation_empty');
  if (nonAllowedFields.length) blockers.push('planned_mutation_has_non_allowed_fields');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');

  const uniqueBlockers = [...new Set(blockers)];
  const ready = uniqueBlockers.length === 0;
  const targetItemId = packet?.item_id || null;

  return {
    packet_id: packet?.id || null,
    request_id: request?.id || packet?.request_id || null,
    dry_run: dryRun !== false,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    target: {
      marketplace: 'ebay',
      item_id: targetItemId,
      listing_id: targetItemId,
    },
    planned_mutation: plannedMutation,
    planned_mutation_fields: Object.entries(plannedMutation)
      .filter(([, value]) => {
        if (value == null) return false;
        if (typeof value === 'string') return value.trim().length > 0;
        if (isPlainObject(value)) return Object.keys(value).length > 0;
        return true;
      })
      .map(([key]) => key),
    allowed_fields: ALLOWED_LISTING_QUALITY_FIELDS,
    forbidden_fields: forbiddenFields,
    non_allowed_fields: nonAllowedFields,
    confirmation: {
      status: packet?.confirmation_status || null,
      confirmed_by_actor: packet?.confirmed_by_actor || null,
      confirmed_at: packet?.confirmed_at || null,
      confirmation_reason: packet?.confirmation_reason || null,
      packet_hash: packet?.packet_hash || null,
    },
    approval: {
      final_approval_status: request?.final_approval_status || 'not_requested',
      final_approval_actor: request?.final_approval_actor || null,
      final_approved_at: request?.final_approved_at || null,
    },
    ready_for_marketplace_call: ready,
    blockers: uniqueBlockers,
    would_call_ebay: ready,
    actual_ebay_call: false,
    would_update_execution_result: ready,
    actual_database_write: false,
    safety: {
      marketplace_api_calls: false,
      ebay_api_calls: false,
      execution_performed: false,
      marketplace_write_performed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      listing_end_create_relist: false,
    },
    source: 'guarded_phase_12a_adapter',
  };
}

async function executeEbayListingQualityRevision(intent, { dryRun = true } = {}) {
  if (dryRun !== false) {
    return {
      ...intent,
      dry_run: true,
      actual_ebay_call: false,
      actual_database_write: false,
      execution_performed: false,
    };
  }

  // Phase 12A deliberately does not wire a live eBay API client. A later explicit phase
  // may replace this guarded stub after adding credentials, API implementation,
  // response persistence, and rollback handling.
  return {
    ...intent,
    dry_run: false,
    blocked: true,
    blockers: [...new Set([...(intent.blockers || []), 'phase_12a_live_ebay_revision_not_enabled'])],
    actual_ebay_call: false,
    actual_database_write: false,
    execution_performed: false,
    safety: {
      ...(intent.safety || {}),
      marketplace_api_calls: false,
      ebay_api_calls: false,
      execution_performed: false,
      marketplace_write_performed: false,
      listing_changed: false,
    },
  };
}

module.exports = {
  ALLOWED_LISTING_QUALITY_FIELDS,
  findForbiddenMutationFields,
  normalizeListingQualityMutation,
  mutationIsEmpty,
  buildEbayListingQualityExecutionIntent,
  executeEbayListingQualityRevision,
};
