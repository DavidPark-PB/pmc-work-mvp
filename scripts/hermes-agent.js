#!/usr/bin/env node
'use strict';

/**
 * Hermes Agent CLI.
 *
 * Examples:
 *   node scripts/hermes-agent.js market --sku=202551129453
 *   node scripts/hermes-agent.js opportunity --sku=202551129453
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function intArg(name, fallback = null) {
  const value = arg(name, null);
  if (value == null) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printUsage() {
  console.error([
    'Usage:',
    '  npm run hermes:agent -- market --sku=<SKU>',
    '  npm run hermes:agent -- opportunity --sku=<SKU> [--type=<TYPE>]',
    '  npm run hermes:agent -- opportunity-write --sku=<SKU> [--type=<TYPE>] --dry-run',
    '  npm run hermes:agent -- opportunity-write --sku=<SKU> [--type=<TYPE>] --write',
    '  npm run hermes:agent -- opportunity-list [--sku=<SKU>] [--status=new] [--opportunity_type=<TYPE>] [--limit=20]',
    '  npm run hermes:agent -- opportunity-review --id=<ID> --action=reviewing [--dry-run|--write]',
    '  npm run hermes:agent -- opportunity-review --id=<ID> --action=rejected --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- opportunity-plan --id=<APPROVED_ID>',
    '  npm run hermes:agent -- execution-request --opportunity-id=<APPROVED_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- execution-list [--status=pending_approval] [--sku=<SKU>] [--limit=20]',
    '  npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=approve --actor=<USER> [--dry-run|--write]',
    '  npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=reject --actor=<USER> --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=cancel --actor=<USER> --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- execution-detail --id=<REQUEST_ID>',
    '  npm run hermes:agent -- execution-summary [--limit=50]',
    '  npm run hermes:agent -- execution-dry-run --id=<REQUEST_ID> --actor=<USER> [--dry-run|--write]',
    '  npm run hermes:agent -- execution-readiness --id=<REQUEST_ID>',
    '  npm run hermes:agent -- execution-final-checklist --id=<REQUEST_ID>',
    '  npm run hermes:agent -- execution-final-approve --id=<REQUEST_ID> --actor=<USER> --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- execution-preflight --id=<REQUEST_ID>',
    '  npm run hermes:agent -- execution-record-internal-task --id=<REQUEST_ID> --actor=<USER> --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- marketplace-preflight --id=<REQUEST_ID> --marketplace=ebay --operation=listing_quality_update',
    '  npm run hermes:agent -- marketplace-preflight-record --id=<REQUEST_ID> --marketplace=ebay --operation=listing_quality_update --actor=<USER> --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-dry-run --id=<REQUEST_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-target-review --id=<REQUEST_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-execution-packet --id=<REQUEST_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-operator-packet --id=<REQUEST_ID> [--title="..."] [--description="..."] [--item-specifics-json="{}"]',
    '  npm run hermes:agent -- ebay-listing-quality-record-packet --id=<REQUEST_ID> --actor=<USER> --reason="..." [--title="..."] [--description="..."] [--item-specifics-json="{}"] [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-confirm-packet --packet-id=<PACKET_ID> --actor=<USER> --reason="..." [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-execute --packet-id=<PACKET_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-record-result --packet-id=<PACKET_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-build-payload --packet-id=<PACKET_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-call-boundary --packet-id=<PACKET_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=<PACKET_ID> --scenario=success|warning|failure [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=<PACKET_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=<PACKET_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-live-runbook --packet-id=<PACKET_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-next-candidate [--limit=10]',
    '  npm run hermes:agent -- ebay-listing-quality-candidate-source-audit [--limit=50]',
    '  npm run hermes:agent -- ebay-listing-quality-candidate-rescan [--limit=20] [--dry-run]',
    '  npm run hermes:agent -- ebay-listing-quality-evidence-refresh-plan [--limit=50]',
    '  npm run hermes:agent -- ebay-listing-quality-evidence-refresh-preview [--limit=20] [--dry-run]',
    '  npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample [--limit=5] [--dry-run]',
    '  npm run hermes:agent -- ebay-listing-quality-evidence-fetch [--limit=5|--item-ids=ID1,ID2] [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-score-evidence --item-ids=ID1,ID2 [--dry-run]',
    '  npm run hermes:agent -- ebay-listing-quality-score-audit --item-ids=ID1,ID2',
    '  npm run hermes:agent -- ebay-listing-quality-opportunity-preview [--limit=10] [--dry-run]',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-preview [--limit=20] [--dry-run]',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-inbox [--limit=20] [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-reviews [--limit=20]',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-review-detail --id=<REVIEW_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=<REVIEW_ID> --action=<shortlist|reject> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-promotion-check --id=<REVIEW_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-borderline-promotion-candidates [--limit=20]',
    '  npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=<REVIEW_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-opportunities [--limit=20]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=<OPPORTUNITY_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=<OPPORTUNITY_ID> --action=<approve_for_packet|reject> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-packet-preview --opportunity-id=<OPPORTUNITY_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=<OPPORTUNITY_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --opportunity-id=<OPPORTUNITY_ID>',
    '  npm run hermes:agent -- execution-events --id=<REQUEST_ID> [--limit=20]',
    '',
    'Hermes agents are read-only unless explicitly documented otherwise.',
    'Phase 2E Opportunity Review: default dry-run; updates only opportunity_inbox.status and review metadata with --write.',
    'Phase 5A Execution Request: default dry-run; --write creates only an internal request row, never external execution.',
    'Phase 5C Execution Review: default dry-run; --write updates only internal request status/review fields and audit events.',
    'Phase 5E Execution Visibility: detail/summary commands are read-only and never approve, reject, cancel, or execute.',
    'Phase 5H Execution Dry-Run: default dry-run; --write stores only internal dry_run_result/status/event and never executes externally.',
    'Phase 5I Execution Readiness: read-only; final approval readiness is not execution approval and never executes externally.',
    'Phase 5J Final Approval Checklist: read-only; final approval writes and execution remain unimplemented.',
    'Phase 6 Final Approval: default dry-run; --write records only internal final approval fields/events, never execution.',
    'Phase 7 Limited Executor: default dry-run; --write records only an internal manual_review_task result/event, never marketplace execution.',
    'Phase 8 Marketplace Preflight: default dry-run; --write records only internal preflight audit, never marketplace execution.',
    'Phase 9 eBay Listing Quality Dry-Run: read-only; no eBay API call and no listing revision.',
    'Phase 10 eBay Listing Quality Target Review: read-only; resolves cached target and rollback review only.',
    'Phase 11A eBay Listing Quality Execution Packet: read-only packet preview only; no eBay API call and no listing revision.',
    'Phase 11B eBay Operator Mutation Packet: read-only internal packet preview only; no eBay API call and no listing revision.',
    'Phase 11C eBay Packet Record: default dry-run; --write records only an internal immutable review artifact.',
    'Phase 11E eBay Packet Confirmation: default dry-run; --write updates only internal confirmation fields/events.',
    'Phase 12A eBay Listing Quality Execute: default dry-run; --write is guarded and must pass all safety gates.',
    'Phase 12B eBay Result Recorder: default dry-run; --write records internal result scaffolding only, never marketplace success.',
    'Phase 12C eBay Payload Builder: build payload only; no eBay call and no database write.',
    'Phase 12D eBay Live Call Boundary: default dry-run; --write remains blocked unless live env is explicitly enabled.',
    'Phase 12E eBay Mock Transport: mock response parser only; no eBay call and no DB write by default.',
    'Phase 12F eBay Live Readiness: read-only preflight; checks env presence only and prints no secret values.',
    'Phase 12G eBay Live Transport Wiring: existing eBay API module wired, but live calls remain disabled unless all gates pass.',
    'Phase 12H eBay Live Runbook: read-only operator checklist; does not execute live marketplace changes.',
    'Phase 13A eBay Next Candidate: read-only selector; no packet, approval, DB, or marketplace writes.',
    'Phase 13B Candidate Source Audit/Rescan: read-only by default; no opportunity, packet, approval, DB, or marketplace writes.',
    'Phase 13C Evidence Refresh Planner: read-only planner/preview; no eBay write, packet, approval, opportunity, DB, or execution-state writes.',
    'Phase 13D Evidence Refresh Eligibility: read-only planner/sample; inventory signals do not block evidence refresh; no DB or marketplace writes.',
    'Phase 13E Read-only Evidence Fetch: GetItem read-only only; dry-run fetches do not write DB, --write may cache evidence internally only.',
    'Phase 13G Listing Quality Evidence Scoring: cached evidence only; no eBay call, DB write, opportunity creation, packet, or approval.',
    'Phase 13H Listing Quality Score Audit: cached evidence only; audits description normalization and score gaps without writes.',
    'Phase 13J Borderline Improvement Preview: cached evidence only; previews minor human-review candidates without writes.',
    'Phase 13K Borderline Human Review Inbox: optional internal review-record write only; no opportunity/packet/approval/marketplace write.',
    'Phase 13L Borderline Review Decision Gate: read reviews and optionally update internal review metadata/status only.',
    'Phase 13M Borderline Promotion Eligibility: read-only check for future safe internal opportunity promotion; no creation.',
    'Phase 13O Borderline Review Promotion: default dry-run; --write creates one normal internal human-review opportunity only.',
    'Phase 13P Promoted Opportunity Human Gate: default dry-run; --write updates internal opportunity metadata/status only.',
    'Phase 13Q Promoted Packet Preview: read-only packet-shaped preview only; no packet/approval/execution creation.',
    'Phase 13R Promoted Packet Creation: default dry-run; --write creates one internal non-executable packet artifact only.',
  ].join('\n'));
}

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();

  if (cmd === 'market') {
    const sku = arg('sku', null);
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }

    const { runMarketAgent } = require('../src/agents/marketAgent');
    const result = await runMarketAgent({ sku });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity') {
    const sku = arg('sku', null);
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }

    const { runOpportunityAgent } = require('../src/agents/opportunityAgent');
    const result = await runOpportunityAgent({ sku }, {
      type: arg('type', arg('opportunity_type', null)),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity-write') {
    const sku = arg('sku', null);
    if (!sku) {
      printUsage();
      throw new Error('SKU is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');

    const { runOpportunityWriteAgent } = require('../src/agents/opportunityAgent');
    const result = await runOpportunityWriteAgent({ sku, dryRun }, {
      type: arg('type', arg('opportunity_type', null)),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity-list') {
    const { listHermesOpportunities } = require('../src/services/opportunityInbox');
    const result = await listHermesOpportunities({
      sku: arg('sku', null),
      status: arg('status', null),
      opportunity_type: arg('opportunity_type', arg('type', null)),
      limit: intArg('limit', 50),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity-review') {
    const id = intArg('id', null);
    const action = arg('action', null);
    if (id == null || !action) {
      printUsage();
      throw new Error('id and action are required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { reviewHermesOpportunity } = require('../src/services/opportunityInbox');
    const result = await reviewHermesOpportunity({
      id,
      action,
      reason: arg('reason', null),
      reviewed_by: arg('reviewed_by', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'opportunity-plan') {
    const id = intArg('id', null);
    if (id == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildHermesOpportunityActionPlan } = require('../src/services/opportunityInbox');
    const result = await buildHermesOpportunityActionPlan({ id });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-request') {
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) {
      printUsage();
      throw new Error('opportunity-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { createExecutionRequest } = require('../src/services/hermesExecutionApproval');
    const result = await createExecutionRequest({ opportunityId, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-list') {
    const { listExecutionRequests } = require('../src/services/hermesExecutionApproval');
    const result = await listExecutionRequests({
      status: arg('status', null),
      sku: arg('sku', null),
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-review') {
    const requestId = intArg('id', intArg('request-id', null));
    const action = arg('action', null);
    if (requestId == null || !action) {
      printUsage();
      throw new Error('id and action are required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { reviewExecutionRequest } = require('../src/services/hermesExecutionApproval');
    const result = await reviewExecutionRequest({
      requestId,
      action,
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-detail') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { getExecutionRequestDetail } = require('../src/services/hermesExecutionApproval');
    const result = await getExecutionRequestDetail({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-summary') {
    const { summarizeExecutionRequests } = require('../src/services/hermesExecutionApproval');
    const result = await summarizeExecutionRequests({
      limit: intArg('limit', 50),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-dry-run') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { generateExecutionDryRun } = require('../src/services/hermesExecutionApproval');
    const result = await generateExecutionDryRun({
      requestId,
      actor: arg('actor', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-readiness') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildExecutionReadiness } = require('../src/services/hermesExecutionApproval');
    const result = await buildExecutionReadiness({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-final-checklist') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildFinalApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const result = await buildFinalApprovalChecklist({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-final-approve') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { recordFinalApproval } = require('../src/services/hermesExecutionApproval');
    const result = await recordFinalApproval({
      requestId,
      actor: arg('actor', null),
      reason: arg('reason', null),
      confirmations: arg('confirmations', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-preflight') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildExecutorPreflight } = require('../src/services/hermesExecutionApproval');
    const result = await buildExecutorPreflight({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-record-internal-task') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { recordInternalManualReviewTask } = require('../src/services/hermesExecutionApproval');
    const result = await recordInternalManualReviewTask({
      requestId,
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'marketplace-preflight') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildMarketplacePreflight } = require('../src/services/hermesExecutionApproval');
    const result = await buildMarketplacePreflight({
      requestId,
      marketplace: arg('marketplace', 'ebay'),
      operation: arg('operation', 'listing_quality_update'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'marketplace-preflight-record') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { recordMarketplacePreflight } = require('../src/services/hermesExecutionApproval');
    const result = await recordMarketplacePreflight({
      requestId,
      marketplace: arg('marketplace', 'ebay'),
      operation: arg('operation', 'listing_quality_update'),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-dry-run') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildEbayListingQualityDryRun } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityDryRun({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-target-review') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildEbayListingQualityTargetReview } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityTargetReview({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-execution-packet') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildEbayListingQualityExecutionPacket } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityExecutionPacket({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-operator-packet') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { buildOperatorEbayListingQualityPacket } = require('../src/services/hermesExecutionApproval');
    const result = await buildOperatorEbayListingQualityPacket({
      requestId,
      title: arg('title', null),
      description: arg('description', null),
      itemSpecifics: arg('item-specifics-json', arg('item-specifics', '{}')),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-record-packet') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { recordEbayListingQualityPacket } = require('../src/services/hermesExecutionApproval');
    const result = await recordEbayListingQualityPacket({
      requestId,
      title: arg('title', null),
      description: arg('description', null),
      itemSpecifics: arg('item-specifics-json', arg('item-specifics', '{}')),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-confirm-packet') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { confirmEbayListingQualityPacket } = require('../src/services/hermesExecutionApproval');
    const result = await confirmEbayListingQualityPacket({
      packetId,
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-execute') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { executeEbayListingQualityPacket } = require('../src/services/hermesExecutionApproval');
    const result = await executeEbayListingQualityPacket({ packetId, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-record-result') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { recordEbayListingQualityExecutionResult } = require('../src/services/hermesExecutionApproval');
    const result = await recordEbayListingQualityExecutionResult({ packetId, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-build-payload') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const { buildEbayListingQualityPayload } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityPayload({ packetId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-call-boundary') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const liveEnabled = String(process.env.HERMES_EBAY_LIVE_EXECUTION_ENABLED || '').toLowerCase() === 'true';
    const { callEbayListingQualityBoundary } = require('../src/services/hermesExecutionApproval');
    const result = await callEbayListingQualityBoundary({
      packetId,
      dryRun,
      liveEnabled,
      writeRequested: hasFlag('write'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-mock-call') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const { mockCallEbayListingQualityPacket } = require('../src/services/hermesExecutionApproval');
    const result = await mockCallEbayListingQualityPacket({
      packetId,
      scenario: arg('scenario', 'success'),
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-live-readiness') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const { buildEbayListingQualityLiveReadiness } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityLiveReadiness({ packetId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-live-transport') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const dryRun = hasFlag('dry-run') || !hasFlag('write');
    const liveEnabled = String(process.env.HERMES_EBAY_LIVE_EXECUTION_ENABLED || '').toLowerCase() === 'true';
    const { callEbayListingQualityLiveTransportBoundary } = require('../src/services/hermesExecutionApproval');
    const result = await callEbayListingQualityLiveTransportBoundary({
      packetId,
      dryRun,
      writeRequested: hasFlag('write'),
      liveEnabled,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-live-runbook') {
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) {
      printUsage();
      throw new Error('packet-id is required');
    }
    const { buildEbayListingQualityLiveRunbook } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityLiveRunbook({ packetId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-next-candidate') {
    const { selectNextEbayListingQualityCandidate } = require('../src/services/hermesExecutionApproval');
    const result = await selectNextEbayListingQualityCandidate({
      limit: intArg('limit', 10),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-candidate-source-audit') {
    const { auditEbayListingQualityCandidateSources } = require('../src/services/hermesExecutionApproval');
    const result = await auditEbayListingQualityCandidateSources({
      limit: intArg('limit', 50),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-candidate-rescan') {
    const { rescanEbayListingQualityCandidates } = require('../src/services/hermesExecutionApproval');
    const result = await rescanEbayListingQualityCandidates({
      limit: intArg('limit', 20),
      dryRun: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-evidence-refresh-plan') {
    const { buildEbayListingQualityEvidenceRefreshPlan } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityEvidenceRefreshPlan({
      limit: intArg('limit', 50),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-evidence-refresh-preview') {
    const { previewEbayListingQualityEvidenceRefresh } = require('../src/services/hermesExecutionApproval');
    const result = await previewEbayListingQualityEvidenceRefresh({
      limit: intArg('limit', 20),
      dryRun: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-evidence-refresh-sample') {
    const { sampleEbayListingQualityEvidenceRefresh } = require('../src/services/hermesExecutionApproval');
    const result = await sampleEbayListingQualityEvidenceRefresh({
      limit: intArg('limit', 5),
      dryRun: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-evidence-fetch') {
    const { fetchEbayListingQualityEvidence } = require('../src/services/hermesExecutionApproval');
    const write = hasFlag('write');
    const result = await fetchEbayListingQualityEvidence({
      limit: intArg('limit', 5),
      itemIds: arg('item-ids', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-score-evidence') {
    const { scoreEbayListingQualityEvidence } = require('../src/services/hermesExecutionApproval');
    const result = await scoreEbayListingQualityEvidence({
      itemIds: arg('item-ids', null),
      limit: intArg('limit', 10),
      dryRun: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-score-audit') {
    const { auditEbayListingQualityScore } = require('../src/services/hermesExecutionApproval');
    const result = await auditEbayListingQualityScore({
      itemIds: arg('item-ids', null),
      limit: intArg('limit', 10),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-opportunity-preview') {
    const { previewEbayListingQualityOpportunities } = require('../src/services/hermesExecutionApproval');
    const result = await previewEbayListingQualityOpportunities({
      limit: intArg('limit', 10),
      dryRun: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-borderline-preview') {
    const { previewEbayListingQualityBorderlineImprovements } = require('../src/services/hermesExecutionApproval');
    const result = await previewEbayListingQualityBorderlineImprovements({
      limit: intArg('limit', 20),
      dryRun: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-borderline-inbox') {
    const { writeEbayListingQualityBorderlineInbox } = require('../src/services/hermesExecutionApproval');
    const write = hasFlag('write');
    const result = await writeEbayListingQualityBorderlineInbox({
      limit: intArg('limit', 20),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-borderline-reviews') {
    const { listEbayListingQualityBorderlineReviews } = require('../src/services/hermesExecutionApproval');
    const result = await listEbayListingQualityBorderlineReviews({
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-borderline-review-detail') {
    const { getEbayListingQualityBorderlineReviewDetail } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const result = await getEbayListingQualityBorderlineReviewDetail({ id: reviewId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-borderline-review-action') {
    const { actOnEbayListingQualityBorderlineReview } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await actOnEbayListingQualityBorderlineReview({
      id: reviewId,
      action: arg('action', null),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-borderline-promotion-check') {
    const { checkEbayListingQualityBorderlinePromotionEligibility } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const result = await checkEbayListingQualityBorderlinePromotionEligibility({ id: reviewId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-borderline-promotion-candidates') {
    const { scanEbayListingQualityBorderlinePromotionCandidates } = require('../src/services/hermesExecutionApproval');
    const result = await scanEbayListingQualityBorderlinePromotionCandidates({
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-promote-borderline-review') {
    const { promoteEbayListingQualityBorderlineReview } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await promoteEbayListingQualityBorderlineReview({
      id: reviewId,
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-promoted-opportunities') {
    const { listEbayListingQualityPromotedOpportunities } = require('../src/services/hermesExecutionApproval');
    const result = await listEbayListingQualityPromotedOpportunities({
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-opportunity-detail') {
    const { getEbayListingQualityPromotedOpportunityDetail } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('id', null);
    if (opportunityId == null) throw new Error('id is required');
    const result = await getEbayListingQualityPromotedOpportunityDetail({ id: opportunityId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-opportunity-action') {
    const { actOnEbayListingQualityPromotedOpportunity } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('id', null);
    if (opportunityId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await actOnEbayListingQualityPromotedOpportunity({
      id: opportunityId,
      action: arg('action', null),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-promoted-packet-preview') {
    const { buildEbayListingQualityPromotedPacketPreview } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) throw new Error('opportunity-id is required');
    const result = await buildEbayListingQualityPromotedPacketPreview({ opportunityId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-create-promoted-packet') {
    const { createEbayListingQualityPromotedPacket } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) throw new Error('opportunity-id is required');
    const write = hasFlag('write');
    const result = await createEbayListingQualityPromotedPacket({
      opportunityId,
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-packet-detail') {
    const { getEbayListingQualityPromotedPacketDetail } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', null);
    const packetId = intArg('packet-id', intArg('id', null));
    if (opportunityId == null && packetId == null) throw new Error('opportunity-id or packet-id is required');
    const result = await getEbayListingQualityPromotedPacketDetail({ opportunityId, packetId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'execution-events') {
    const requestId = intArg('id', intArg('request-id', null));
    if (requestId == null) {
      printUsage();
      throw new Error('id is required');
    }
    const { listExecutionEvents } = require('../src/services/hermesExecutionApproval');
    const result = await listExecutionEvents({
      requestId,
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
  throw new Error(`Unsupported command: ${cmd || '(missing)'}`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
