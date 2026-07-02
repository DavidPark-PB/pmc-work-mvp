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
  /sku(_?remap|_?mapping)?/i,
  /shipping/i,
  /payment/i,
  /returns?/i,
  /return_?policy/i,
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



function prepareEbayListingQualityRollbackSnapshot({ packet } = {}) {
  const before = isPlainObject(packet?.before_snapshot) ? packet.before_snapshot : {};
  const rollback = isPlainObject(packet?.rollback_snapshot) ? packet.rollback_snapshot : {};
  const confirmation = isPlainObject(packet?.confirmation_snapshot) ? packet.confirmation_snapshot : null;

  return {
    title: before.title ?? rollback.title ?? rollback.before?.title ?? null,
    description: before.description ?? rollback.description ?? rollback.before?.description ?? null,
    item_specifics: before.item_specifics || rollback.item_specifics || rollback.before?.item_specifics || {},
    source_fields: {
      before_snapshot_keys: Object.keys(before),
      rollback_snapshot_keys: Object.keys(rollback),
      packet_table_fields: ['before_snapshot', 'rollback_snapshot', 'planned_mutation', 'packet_hash', 'confirmation_snapshot'],
    },
    packet_hash: packet?.packet_hash || null,
    confirmation_snapshot_reference: confirmation ? {
      packet_id: confirmation.packet_id || packet?.id || null,
      request_id: confirmation.request_id || packet?.request_id || null,
      confirmed_at: confirmation.confirmed_at || packet?.confirmed_at || null,
      planned_mutation_hash: confirmation.planned_mutation_hash || null,
      rollback_snapshot_hash: confirmation.rollback_snapshot_hash || null,
      policy_version: confirmation.policy_version || null,
    } : null,
    available: true,
    source: 'packet_internal_snapshots',
  };
}

function buildEbayListingQualityResultRecord({ packet, request, intent, executionMode = 'dry_run', executionStatus = 'ready_to_execute', marketplaceResponse = null, error = null, recordedAt = null } = {}) {
  const timestamp = recordedAt || new Date().toISOString();
  const preExecutionSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });

  return {
    packet_id: packet?.id || intent?.packet_id || null,
    request_id: request?.id || packet?.request_id || intent?.request_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    target_item_id: packet?.item_id || intent?.target?.item_id || null,
    planned_mutation: intent?.planned_mutation || normalizeListingQualityMutation(packet?.planned_mutation || {}),
    pre_execution_snapshot: preExecutionSnapshot,
    execution_mode: executionMode,
    execution_status: executionStatus,
    marketplace_response: marketplaceResponse,
    error,
    recorded_at: timestamp,
    actual_ebay_call: false,
    marketplace_write_performed: false,
    listing_changed: false,
    price_changes: false,
    inventory_changes: false,
    false_success_marking: false,
  };
}



function itemSpecificsToNameValueList(itemSpecifics) {
  if (!isPlainObject(itemSpecifics)) return [];
  return Object.entries(itemSpecifics)
    .filter(([key, value]) => String(key || '').trim() && value != null && !(typeof value === 'string' && !value.trim()))
    .map(([key, value]) => ({
      Name: String(key).trim(),
      Value: Array.isArray(value) ? value.map(v => String(v)) : String(value),
    }));
}

function buildEbayListingQualityRevisePayload({ packet, request, intent } = {}) {
  const executionIntent = intent || buildEbayListingQualityExecutionIntent({ packet, request, dryRun: true });
  const plannedMutation = normalizeListingQualityMutation(packet?.planned_mutation || executionIntent.planned_mutation || {});
  const rawMutation = isPlainObject(packet?.planned_mutation) ? packet.planned_mutation : plannedMutation;
  const forbiddenFields = findForbiddenMutationFields(rawMutation);
  const nonAllowedFields = Object.keys(rawMutation).filter(key => !ALLOWED_LISTING_QUALITY_FIELDS.includes(key));
  const targetItemId = packet?.item_id || executionIntent.target?.item_id || null;
  const payload = {
    Item: {
      ItemID: targetItemId,
    },
  };

  if (plannedMutation.title) payload.Item.Title = plannedMutation.title;
  if (plannedMutation.description) payload.Item.Description = plannedMutation.description;
  const nameValueList = itemSpecificsToNameValueList(plannedMutation.item_specifics);
  if (nameValueList.length) payload.Item.ItemSpecifics = { NameValueList: nameValueList };

  const updatesTitle = Boolean(plannedMutation.title);
  const updatesDescription = Boolean(plannedMutation.description);
  const updatesItemSpecifics = nameValueList.length > 0;
  const blockers = [];
  if (!packet) blockers.push('packet_required');
  if (!request) blockers.push('request_required');
  if (!targetItemId) blockers.push('target_item_id_missing');
  if (packet && packet.status !== 'packet_recorded') blockers.push('packet_status_not_packet_recorded');
  if (packet && packet.confirmation_status !== 'confirmed') blockers.push('packet_confirmation_status_not_confirmed');
  if (request && request.final_approval_status !== 'approved') blockers.push('request_final_approval_not_approved');
  if (request && request.executed_at != null) blockers.push('request_executed_at_present');
  if (request && request.execution_result != null) blockers.push('request_execution_result_present');
  if (request?.metadata?.external_action_executed === true) blockers.push('external_action_executed_true');
  if (request?.metadata?.marketplace_execution_approved === true) blockers.push('marketplace_execution_approved_true');
  if (nonAllowedFields.length) blockers.push('planned_mutation_has_non_allowed_fields');
  if (forbiddenFields.length) blockers.push('forbidden_marketplace_mutation_fields_present');
  if (!updatesTitle && !updatesDescription && !updatesItemSpecifics) blockers.push('planned_mutation_empty');

  return {
    packet_id: packet?.id || executionIntent.packet_id || null,
    request_id: request?.id || packet?.request_id || executionIntent.request_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    api_operation: 'ReviseFixedPriceItem',
    target_item_id: targetItemId,
    target_listing_id: targetItemId,
    payload,
    payload_summary: {
      updates_title: updatesTitle,
      updates_description: updatesDescription,
      updates_item_specifics: updatesItemSpecifics,
      allowed_fields: ALLOWED_LISTING_QUALITY_FIELDS,
      payload_fields: Object.keys(payload.Item).filter(key => key !== 'ItemID'),
      forbidden_fields_present: forbiddenFields.length > 0 || nonAllowedFields.length > 0,
      forbidden_fields: forbiddenFields,
      non_allowed_fields: nonAllowedFields,
    },
    blockers: [...new Set(blockers)],
    actual_ebay_call: false,
    actual_database_write: false,
    marketplace_write_performed: false,
    source: 'confirmed_packet_payload_builder_v1',
  };
}



function envLiveEbayExecutionEnabled(env = process.env) {
  return String(env.HERMES_EBAY_LIVE_EXECUTION_ENABLED || '').toLowerCase() === 'true';
}

function callEbayListingQualityRevise({ packet, request, payload, dryRun = true, liveEnabled = false, writeRequested = false } = {}) {
  const payloadObject = isPlainObject(payload) ? payload : {};
  const payloadSummary = isPlainObject(payloadObject.payload_summary) ? payloadObject.payload_summary : {};
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });
  const baseBlockers = Array.isArray(payloadObject.blockers) ? payloadObject.blockers : [];
  const liveBlockers = [];
  const isDryRun = dryRun !== false;
  const envLiveEnabled = envLiveEbayExecutionEnabled();
  const targetItemId = payloadObject.target_item_id || packet?.item_id || null;

  if (!writeRequested && !isDryRun) liveBlockers.push('explicit_cli_write_required');
  if (!liveEnabled) liveBlockers.push('live_ebay_execution_disabled');
  if (!envLiveEnabled) liveBlockers.push('live_ebay_execution_env_disabled');
  if (packet?.confirmation_status !== 'confirmed') liveBlockers.push('packet_confirmation_status_not_confirmed');
  if (request?.final_approval_status !== 'approved') liveBlockers.push('request_final_approval_not_approved');
  if (!targetItemId) liveBlockers.push('target_item_id_missing');
  if (!rollbackSnapshot || rollbackSnapshot.available !== true) liveBlockers.push('rollback_snapshot_missing');
  if (payloadSummary.forbidden_fields_present === true) liveBlockers.push('forbidden_marketplace_mutation_fields_present');
  if (Array.isArray(payloadSummary.non_allowed_fields) && payloadSummary.non_allowed_fields.length) liveBlockers.push('payload_has_non_allowed_fields');
  if (Array.isArray(payloadSummary.forbidden_fields) && payloadSummary.forbidden_fields.length) liveBlockers.push('payload_has_forbidden_fields');

  const readinessBlockers = [...new Set(baseBlockers)];
  const readyForLiveCall = readinessBlockers.length === 0;
  const blockers = isDryRun ? readinessBlockers : [...new Set([...readinessBlockers, ...liveBlockers])];
  const blocked = isDryRun ? false : blockers.length > 0;

  return {
    packet_id: packet?.id || payloadObject.packet_id || null,
    request_id: request?.id || packet?.request_id || payloadObject.request_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    api_operation: payloadObject.api_operation || 'ReviseFixedPriceItem',
    target_item_id: targetItemId,
    target_listing_id: payloadObject.target_listing_id || targetItemId,
    ready_for_live_call: readyForLiveCall,
    dry_run: isDryRun,
    live_enabled: liveEnabled === true,
    env_live_enabled: envLiveEnabled,
    explicit_write_requested: writeRequested === true,
    blocked,
    would_call_ebay: readyForLiveCall,
    actual_ebay_call: false,
    actual_network_call: false,
    actual_database_write: false,
    marketplace_write_performed: false,
    listing_changed: false,
    price_changes: false,
    inventory_changes: false,
    executed_at_updated: false,
    execution_result_updated: false,
    blockers,
    live_blockers: isDryRun ? [] : [...new Set(liveBlockers)],
    payload: payloadObject.payload || null,
    payload_summary: payloadSummary,
    rollback_snapshot_present: rollbackSnapshot?.available === true,
    rollback_snapshot_reference: {
      packet_hash: rollbackSnapshot?.packet_hash || packet?.packet_hash || null,
      confirmation_snapshot_reference: rollbackSnapshot?.confirmation_snapshot_reference || null,
      source: rollbackSnapshot?.source || null,
    },
    safety: {
      marketplace_api_calls: false,
      ebay_api_calls: false,
      network_calls: false,
      marketplace_write_performed: false,
      live_execution_performed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      execution_result_updated: false,
      executed_at_updated: false,
      database_writes: false,
    },
    source: 'phase_12d_live_call_boundary_v1',
  };
}



function normalizeEbayMessages(value) {
  const input = Array.isArray(value) ? value : (value ? [value] : []);
  return input.map((entry, index) => {
    if (typeof entry === 'string') return { code: null, severity: null, message: entry, index };
    if (!isPlainObject(entry)) return { code: null, severity: null, message: String(entry), index };
    return {
      code: entry.ErrorCode || entry.code || null,
      severity: entry.SeverityCode || entry.severity || null,
      short_message: entry.ShortMessage || entry.short_message || null,
      long_message: entry.LongMessage || entry.long_message || entry.message || null,
      message: entry.LongMessage || entry.ShortMessage || entry.message || null,
      index,
    };
  });
}


function firstXmlTag(xml, tagName) {
  if (typeof xml !== 'string') return null;
  const match = xml.match(new RegExp(`<(?:[^:>]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tagName}>`, 'i'));
  return match ? match[1] : null;
}

function allXmlTagBlocks(xml, tagName) {
  if (typeof xml !== 'string') return [];
  const regex = new RegExp(`<(?:[^:>]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tagName}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = regex.exec(xml)) !== null) blocks.push(match[1]);
  return blocks;
}

function stripXmlCdata(value) {
  if (value == null) return value;
  return String(value).replace(/^<!\\[CDATA\\[/, '').replace(/\\]\\]>$/, '');
}

function parseEbayXmlErrors(xml) {
  return allXmlTagBlocks(xml, 'Errors').map((block, index) => ({
    ErrorCode: stripXmlCdata(firstXmlTag(block, 'ErrorCode')),
    SeverityCode: stripXmlCdata(firstXmlTag(block, 'SeverityCode')),
    ShortMessage: stripXmlCdata(firstXmlTag(block, 'ShortMessage')),
    LongMessage: stripXmlCdata(firstXmlTag(block, 'LongMessage')),
    index,
  }));
}

function parseEbayXmlResponse(xml) {
  return {
    Ack: stripXmlCdata(firstXmlTag(xml, 'Ack')) || 'Unknown',
    ItemID: stripXmlCdata(firstXmlTag(xml, 'ItemID')),
    CorrelationID: stripXmlCdata(firstXmlTag(xml, 'CorrelationID')),
    Timestamp: stripXmlCdata(firstXmlTag(xml, 'Timestamp')),
    Version: stripXmlCdata(firstXmlTag(xml, 'Version')),
    Build: stripXmlCdata(firstXmlTag(xml, 'Build')),
    Errors: parseEbayXmlErrors(xml),
    raw_xml: xml,
  };
}

function parseEbayReviseFixedPriceItemResponse(rawResponse = {}) {
  const response = typeof rawResponse === 'string'
    ? parseEbayXmlResponse(rawResponse)
    : (isPlainObject(rawResponse) ? rawResponse : {});
  const ack = response.Ack || response.ack || 'Unknown';
  const errors = normalizeEbayMessages(response.Errors || response.errors)
    .filter(error => !/warning/i.test(String(error.severity || '')));
  const warnings = normalizeEbayMessages(response.Warnings || response.warnings)
    .concat(normalizeEbayMessages(response.Errors || response.errors).filter(error => /warning/i.test(String(error.severity || ''))));
  const itemId = response.ItemID || response.item_id || response.Item?.ItemID || null;
  const correlationId = response.CorrelationID || response.correlation_id || response.correlationId || null;
  const timestamp = response.Timestamp || response.timestamp || new Date().toISOString();
  const success = /^(success|warning)$/i.test(String(ack)) && errors.length === 0;

  return {
    success,
    ack,
    item_id: itemId,
    correlation_id: correlationId,
    timestamp,
    warnings,
    errors,
    raw_response: response,
  };
}

function mockEbayListingQualityReviseTransport({ payload, scenario = 'success', correlationId = null, timestamp = null } = {}) {
  const normalizedScenario = ['success', 'warning', 'failure'].includes(String(scenario).toLowerCase())
    ? String(scenario).toLowerCase()
    : 'success';
  const now = timestamp || new Date().toISOString();
  const itemId = payload?.Item?.ItemID || null;
  const id = correlationId || `mock-ebay-listing-quality-${normalizedScenario}-${itemId || 'unknown'}`;
  const base = {
    Timestamp: now,
    CorrelationID: id,
    Version: 'mock-phase-12e-v1',
    Build: 'mock-transport',
    ItemID: itemId,
  };

  if (normalizedScenario === 'warning') {
    return {
      ...base,
      Ack: 'Warning',
      Warnings: [{
        SeverityCode: 'Warning',
        ErrorCode: '21919456',
        ShortMessage: 'Mock warning',
        LongMessage: 'Mock transport warning: eBay accepted the revise payload with a non-blocking listing quality warning.',
      }],
    };
  }

  if (normalizedScenario === 'failure') {
    return {
      ...base,
      Ack: 'Failure',
      Errors: [{
        SeverityCode: 'Error',
        ErrorCode: '21919188',
        ShortMessage: 'Mock failure',
        LongMessage: 'Mock transport failure: eBay rejected the revise payload for validation testing.',
      }],
    };
  }

  return {
    ...base,
    Ack: 'Success',
  };
}

function mockCallEbayListingQualityRevise({ packet, request, payload, scenario = 'success' } = {}) {
  const payloadObject = isPlainObject(payload) ? payload : {};
  const rawResponse = mockEbayListingQualityReviseTransport({
    payload: payloadObject.payload || payloadObject,
    scenario,
  });
  const parsed_response = parseEbayReviseFixedPriceItemResponse(rawResponse);
  return {
    packet_id: packet?.id || payloadObject.packet_id || null,
    request_id: request?.id || packet?.request_id || payloadObject.request_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    api_operation: payloadObject.api_operation || 'ReviseFixedPriceItem',
    scenario: ['success', 'warning', 'failure'].includes(String(scenario).toLowerCase()) ? String(scenario).toLowerCase() : 'success',
    target_item_id: payloadObject.target_item_id || packet?.item_id || null,
    payload: payloadObject.payload || payloadObject,
    mock_transport: true,
    actual_ebay_call: false,
    actual_network_call: false,
    actual_database_write: false,
    marketplace_write_performed: false,
    raw_response: rawResponse,
    parsed_response,
    safety: {
      marketplace_api_calls: false,
      ebay_api_calls: false,
      network_calls: false,
      mock_transport: true,
      marketplace_write_performed: false,
      live_execution_performed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      execution_result_updated: false,
      executed_at_updated: false,
      database_writes: false,
    },
    source: 'phase_12e_mock_transport_v1',
  };
}



function escapeXmlValue(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ebayRevisePayloadToTradingXml(payload = {}) {
  const item = isPlainObject(payload?.Item) ? payload.Item : {};
  const parts = ['<Item>'];
  if (item.ItemID) parts.push(`<ItemID>${escapeXmlValue(item.ItemID)}</ItemID>`);
  if (item.Title) parts.push(`<Title>${escapeXmlValue(item.Title)}</Title>`);
  if (item.Description) parts.push(`<Description>${escapeXmlValue(item.Description)}</Description>`);
  const specifics = item.ItemSpecifics?.NameValueList;
  const list = Array.isArray(specifics) ? specifics : (specifics ? [specifics] : []);
  if (list.length) {
    parts.push('<ItemSpecifics>');
    for (const entry of list) {
      if (!entry?.Name) continue;
      const values = Array.isArray(entry.Value) ? entry.Value : [entry.Value];
      parts.push('<NameValueList>');
      parts.push(`<Name>${escapeXmlValue(entry.Name)}</Name>`);
      for (const value of values) {
        if (value == null) continue;
        parts.push(`<Value>${escapeXmlValue(value)}</Value>`);
      }
      parts.push('</NameValueList>');
    }
    parts.push('</ItemSpecifics>');
  }
  parts.push('</Item>');
  return parts.join('');
}

async function callEbayListingQualityLiveTransport({ packet, request, payload, dryRun = true, writeRequested = false, liveEnabled = false, ebayApiModulePath = null } = {}) {
  const payloadObject = isPlainObject(payload) ? payload : {};
  const payloadSummary = isPlainObject(payloadObject.payload_summary) ? payloadObject.payload_summary : {};
  const rollbackSnapshot = prepareEbayListingQualityRollbackSnapshot({ packet });
  const isDryRun = dryRun !== false;
  const envLiveEnabled = envLiveEbayExecutionEnabled();
  const targetItemId = payloadObject.target_item_id || packet?.item_id || null;
  const readinessBlockers = Array.isArray(payloadObject.blockers) ? payloadObject.blockers : [];
  const liveBlockers = [];

  if (!writeRequested && !isDryRun) liveBlockers.push('explicit_cli_write_required');
  if (!liveEnabled) liveBlockers.push('live_ebay_execution_disabled');
  if (!envLiveEnabled) liveBlockers.push('live_ebay_execution_env_disabled');
  if (packet?.status !== 'packet_recorded') liveBlockers.push('packet_status_not_packet_recorded');
  if (packet?.confirmation_status !== 'confirmed') liveBlockers.push('packet_confirmation_status_not_confirmed');
  if (request?.final_approval_status !== 'approved') liveBlockers.push('request_final_approval_not_approved');
  if (request?.executed_at != null) liveBlockers.push('request_executed_at_present');
  if (request?.execution_result != null) liveBlockers.push('request_execution_result_present');
  if (request?.metadata?.external_action_executed === true) liveBlockers.push('external_action_executed_true');
  if (request?.metadata?.marketplace_execution_approved === true) liveBlockers.push('marketplace_execution_approved_true');
  if (!targetItemId) liveBlockers.push('target_item_id_missing');
  if (!rollbackSnapshot || rollbackSnapshot.available !== true) liveBlockers.push('rollback_snapshot_missing');
  if (payloadSummary.forbidden_fields_present === true) liveBlockers.push('forbidden_marketplace_mutation_fields_present');
  if (Array.isArray(payloadSummary.non_allowed_fields) && payloadSummary.non_allowed_fields.length) liveBlockers.push('payload_has_non_allowed_fields');
  if (Array.isArray(payloadSummary.forbidden_fields) && payloadSummary.forbidden_fields.length) liveBlockers.push('payload_has_forbidden_fields');
  if (!ebayApiModulePath) liveBlockers.push('existing_ebay_api_module_missing');

  const payloadReady = readinessBlockers.length === 0 && Boolean(payloadObject.payload?.Item?.ItemID);
  const blockers = isDryRun
    ? [...new Set(readinessBlockers)]
    : [...new Set([...readinessBlockers, ...liveBlockers])];
  const blocked = isDryRun ? false : blockers.length > 0;
  const transportXml = ebayRevisePayloadToTradingXml(payloadObject.payload || {});
  const baseResult = {
    packet_id: packet?.id || payloadObject.packet_id || null,
    request_id: request?.id || packet?.request_id || payloadObject.request_id || null,
    marketplace: 'ebay',
    operation: 'listing_quality_update',
    api_operation: 'ReviseFixedPriceItem',
    target_item_id: targetItemId,
    payload_ready: payloadReady,
    existing_ebay_api_module_detected: Boolean(ebayApiModulePath),
    existing_ebay_api_call_pattern: 'new EbayAPI().callTradingAPI(callName, requestBody)',
    live_transport_wired: Boolean(ebayApiModulePath),
    dry_run: isDryRun,
    explicit_write_requested: writeRequested === true,
    live_enabled: liveEnabled === true && envLiveEnabled,
    env_live_enabled: envLiveEnabled,
    blocked,
    blockers,
    live_blockers: isDryRun ? [] : [...new Set(liveBlockers)],
    would_call_ebay: payloadReady,
    actual_ebay_call: false,
    actual_network_call: false,
    actual_database_write: false,
    marketplace_write_performed: false,
    listing_changed: false,
    price_changes: false,
    inventory_changes: false,
    executed_at_updated: false,
    execution_result_updated: false,
    payload: payloadObject.payload || null,
    payload_summary: payloadSummary,
    transport_request: {
      call_name: 'ReviseFixedPriceItem',
      request_body_xml_preview: transportXml,
      generated_from_payload: true,
    },
    safety: {
      marketplace_api_calls: false,
      ebay_api_calls: false,
      network_calls: false,
      marketplace_write_performed: false,
      live_execution_performed: false,
      listing_changed: false,
      price_changes: false,
      inventory_changes: false,
      execution_result_updated: false,
      executed_at_updated: false,
      database_writes: false,
    },
    source: 'phase_12g_ebay_live_transport_wiring_v1',
  };

  if (isDryRun || blocked) return baseResult;

  // Future live path: only reachable after all live gates above pass. Validation for Phase 12G
  // does not set the live env, so this branch is intentionally not exercised in this phase.
  const EbayAPI = require(ebayApiModulePath);
  const ebay = new EbayAPI();
  const rawResponse = await ebay.callTradingAPI('ReviseFixedPriceItem', transportXml);
  const parsedResponse = parseEbayReviseFixedPriceItemResponse(rawResponse);
  return {
    ...baseResult,
    blocked: false,
    actual_ebay_call: true,
    actual_network_call: true,
    marketplace_write_performed: true,
    raw_response: rawResponse,
    parsed_response: parsedResponse,
    safety: {
      ...baseResult.safety,
      marketplace_api_calls: true,
      ebay_api_calls: true,
      network_calls: true,
      marketplace_write_performed: true,
      live_execution_performed: true,
    },
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
  prepareEbayListingQualityRollbackSnapshot,
  buildEbayListingQualityResultRecord,
  buildEbayListingQualityRevisePayload,
  callEbayListingQualityRevise,
  parseEbayReviseFixedPriceItemResponse,
  mockEbayListingQualityReviseTransport,
  mockCallEbayListingQualityRevise,
  ebayRevisePayloadToTradingXml,
  callEbayListingQualityLiveTransport,
  buildEbayListingQualityExecutionIntent,
  executeEbayListingQualityRevision,
};
