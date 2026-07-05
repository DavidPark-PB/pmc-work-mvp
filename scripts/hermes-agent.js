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
    '  npm run hermes:agent -- ebay-listing-quality-controlled-expansion-plan [--limit=50]',
    '  npm run hermes:agent -- ebay-listing-quality-fresh-candidate-source-plan [--limit=100]',
    '  npm run hermes:agent -- ebay-listing-quality-candidate-seed-preview [--limit=100]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-signal-dominance-audit [--limit=100]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-scoring-preview [--limit=100] [--top=20]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-review-inbox [--limit=20] [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-review-list [--limit=20]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=<REVIEW_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=<REVIEW_ID> --action=<shortlist|reject> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=<REVIEW_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-promotion-candidates [--limit=20]',
    '  npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=<REVIEW_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunities [--limit=20]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-detail --id=<OPPORTUNITY_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-action --id=<OPPORTUNITY_ID> --action=<approve_for_packet|reject> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-promoted-packet-preview --opportunity-id=<OPPORTUNITY_ID>',
    "  npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-preview --opportunity-id=<OPPORTUNITY_ID> --final-mutation-json='{}'",
    "  npm run hermes:agent -- ebay-listing-quality-create-seed-final-mutation-packet --opportunity-id=<OPPORTUNITY_ID> --final-mutation-json='{}' --actor=<USER> --reason=... [--dry-run|--write]",
    '  npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-detail --opportunity-id=<OPPORTUNITY_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-create-seed-final-approval --packet-id=<PACKET_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --packet-id=<PACKET_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --approval-id=<APPROVAL_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=<APPROVAL_ID> --action=<approve|reject> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=<APPROVAL_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-live-runbook --approval-id=<APPROVAL_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=<APPROVAL_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-seed-live-approval-checklist --approval-id=<APPROVAL_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-seed-evidence-complete --id=<REVIEW_ID> [--dry-run|--write]',
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
    '  npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --packet-id=<PACKET_ARTIFACT_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-confirm-promoted-packet --packet-id=<PACKET_ARTIFACT_ID> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-create-promoted-approval --packet-id=<PACKET_ARTIFACT_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-approval-detail --packet-id=<PACKET_ARTIFACT_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-approval-detail --approval-id=<APPROVAL_ARTIFACT_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-approval-action --approval-id=<APPROVAL_ARTIFACT_ID> --action=<approve|reject> --actor=<USER> --reason=... [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-create-promoted-execution-bridge --approval-id=<APPROVAL_ARTIFACT_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-item-specifics-audit --approval-id=<APPROVAL_ARTIFACT_ID>',
    "  npm run hermes:agent -- ebay-listing-quality-promoted-item-specifics-preview --approval-id=<APPROVAL_ARTIFACT_ID> --item-specifics-json='{}'",
    "  npm run hermes:agent -- ebay-listing-quality-create-promoted-final-item-specifics-packet --approval-id=<APPROVAL_ARTIFACT_ID> --item-specifics-json='{}' --actor=<USER> --reason=... [--dry-run|--write]",
    '  npm run hermes:agent -- ebay-listing-quality-promoted-final-item-specifics-detail --approval-id=<APPROVAL_ARTIFACT_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=<APPROVAL_ARTIFACT_ID>',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-live-transport --approval-id=<APPROVAL_ARTIFACT_ID> [--dry-run|--write]',
    '  npm run hermes:agent -- ebay-listing-quality-promoted-live-runbook --approval-id=<APPROVAL_ARTIFACT_ID>',
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
    'Phase 13S Promoted Packet Confirmation: default dry-run; --write updates internal packet confirmation metadata/status only.',
    'Phase 13T Promoted Approval Request: default dry-run; --write creates one internal approval request only.',
    'Phase 13U Promoted Final Approval: default dry-run; --write updates internal approval metadata/status only.',
    'Phase 13V Promoted Execution Bridge Readiness: default dry-run; --write creates internal bridge request/packet only.',
    'Phase 13W Promoted Live Transport Boundary: validates promoted payload/boundary only; no eBay execution.',
    'Phase 13X Promoted Item Specifics Finalization Gate: blocks placeholder item_specifics and previews operator JSON only.',
    'Phase 13Y Promoted Final Item Specifics Packet: creates superseding internal request/packet from operator JSON only.',
    'Phase 14A Controlled Expansion Planner: read-only planner; excludes executed items and creates no packets, approvals, requests, DB writes, AI calls, or marketplace writes.',
    'Phase 14B Fresh Candidate Source Planner: read-only internal/local source discovery; no GetItem, AI, DB writes, candidates, packets, approvals, requests, or marketplace writes.',
    'Phase 14C Candidate Seed Preview: read-only deterministic seed preview from internal catalog/listing evidence; no DB writes, AI, GetItem, or marketplace writes.',
    'Phase 14D Seed Signal Dominance Audit: read-only audit separating listing-quality issues from price/inventory/stock context; no candidates or writes.',
    'Phase 14E Seed Scoring Preview: read-only deterministic listing-quality scoring/shortlist preview; no opportunities, packets, approvals, requests, DB writes, AI, or marketplace writes.',
    'Phase 14F Seed Human Review Inbox: dry-run by default; --write creates internal review inbox records only with idempotent fingerprints; no opportunities, packets, approvals, requests, live candidates, listing mutations, AI, or marketplace writes.',
    'Phase 14G Seed Review Decision Gate: read-only detail/action dry-run by default; --write updates existing internal seed review metadata/status only; no packets, approvals, requests, live candidates, listing mutations, AI, or marketplace writes.',
    'Phase 14H Seed Promotion Eligibility: read-only check/scan for shortlisted seed reviews; no opportunities, packets, approvals, requests, live candidates, DB writes, AI, or marketplace writes.',
    'Phase 14I Seed Evidence Completion: read-only GetItem plus optional --write internal evidence-cache upserts only; no listing mutation, opportunity, packet, approval, request, live candidate, AI, or marketplace write.',
    'Phase 14J Seed Review Promotion: dry-run by default; --write creates at most one normal internal human-review opportunity only; no eBay calls, packets, approvals, requests, live candidates, listing mutations, AI, or marketplace writes.',
    'Phase 14K Seed Promoted Opportunity Human Gate: dry-run by default; --write updates only existing internal seed-promoted opportunity metadata/status; no eBay calls, packets, approvals, requests, live candidates, listing mutations, AI, or marketplace writes.',
    'Phase 14L Seed Promoted Packet Preview: read-only packet-shaped preview only from cached evidence; no DB writes, eBay calls, packets, approvals, requests, live candidates, listing mutations, AI, or marketplace writes.',
    'Phase 14M Seed Final Mutation Preview Gate: read-only operator-supplied JSON preview only; blocks placeholders/forbidden fields and creates no packets, approvals, requests, DB writes, AI, or marketplace writes.',
    'Phase 14N Seed Final Mutation Packet: default dry-run; --write creates idempotent internal superseding request/packet artifacts only from operator JSON; no approvals, live candidates, AI, eBay calls, listing mutations, or marketplace writes.',
    'Phase 14O Seed Final Approval Request: default dry-run; --write creates exactly one internal opportunity_inbox approval request artifact only; not final approval, not execution request, no AI/eBay/marketplace/listing writes.',
    'Phase 14P Seed Final Approval: default dry-run; --write updates only the internal Phase 14O approval artifact metadata/status; no execution request, execution state update, AI, eBay call, listing mutation, or marketplace write.',
    'Phase 14Q Seed Live Readiness: read-only readiness/runbook for approval 37/request 5/packet 4; builds payload preview only, no DB writes, live transport, eBay calls, AI, or marketplace writes.',
    'Phase 14R Seed Live Transport Boundary: validates seed final payload and disabled live boundary only; no eBay execution, live transport, DB execution-state write, AI, or marketplace write.',
    'Phase 14S Seed Live Approval Checklist: read-only final operator approval text/checklist only; no eBay execution, live transport, DB write, AI, or marketplace write.',
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

  if (cmd === 'ebay-listing-quality-controlled-expansion-plan') {
    const { buildEbayListingQualityControlledExpansionPlan } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityControlledExpansionPlan({
      limit: intArg('limit', 50),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-fresh-candidate-source-plan') {
    const { buildEbayListingQualityFreshCandidateSourcePlan } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityFreshCandidateSourcePlan({
      limit: intArg('limit', 100),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-candidate-seed-preview') {
    const { buildEbayListingQualityCandidateSeedPreview } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualityCandidateSeedPreview({
      limit: intArg('limit', 100),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-signal-dominance-audit') {
    const { buildEbayListingQualitySeedSignalDominanceAudit } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualitySeedSignalDominanceAudit({
      limit: intArg('limit', 100),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-scoring-preview') {
    const { buildEbayListingQualitySeedScoringPreview } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayListingQualitySeedScoringPreview({
      limit: intArg('limit', 100),
      top: intArg('top', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-review-inbox') {
    const { writeEbayListingQualitySeedReviewInbox } = require('../src/services/hermesExecutionApproval');
    const write = hasFlag('write');
    const result = await writeEbayListingQualitySeedReviewInbox({
      limit: intArg('limit', 20),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-review-list') {
    const { listEbayListingQualitySeedReviewInbox } = require('../src/services/hermesExecutionApproval');
    const result = await listEbayListingQualitySeedReviewInbox({
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-review-detail') {
    const { getEbayListingQualitySeedReviewDetail } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const result = await getEbayListingQualitySeedReviewDetail({ id: reviewId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-review-action') {
    const { actOnEbayListingQualitySeedReview } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await actOnEbayListingQualitySeedReview({
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

  if (cmd === 'ebay-listing-quality-seed-promotion-check') {
    const { checkEbayListingQualitySeedPromotionEligibility } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const result = await checkEbayListingQualitySeedPromotionEligibility({ id: reviewId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-promotion-candidates') {
    const { scanEbayListingQualitySeedPromotionCandidates } = require('../src/services/hermesExecutionApproval');
    const result = await scanEbayListingQualitySeedPromotionCandidates({
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promote-seed-review') {
    const { promoteEbayListingQualitySeedReview } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await promoteEbayListingQualitySeedReview({
      id: reviewId,
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-promoted-opportunities') {
    const { listEbayListingQualitySeedPromotedOpportunities } = require('../src/services/hermesExecutionApproval');
    const result = await listEbayListingQualitySeedPromotedOpportunities({
      limit: intArg('limit', 20),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-promoted-opportunity-detail') {
    const { getEbayListingQualitySeedPromotedOpportunityDetail } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('id', null);
    if (opportunityId == null) throw new Error('id is required');
    const result = await getEbayListingQualitySeedPromotedOpportunityDetail({ id: opportunityId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-promoted-opportunity-action') {
    const { actOnEbayListingQualitySeedPromotedOpportunity } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('id', null);
    if (opportunityId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await actOnEbayListingQualitySeedPromotedOpportunity({
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

  if (cmd === 'ebay-listing-quality-seed-promoted-packet-preview') {
    const { buildEbayListingQualitySeedPromotedPacketPreview } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) throw new Error('opportunity-id is required');
    const result = await buildEbayListingQualitySeedPromotedPacketPreview({ opportunityId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-final-mutation-preview') {
    const { previewEbayListingQualitySeedFinalMutation } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) throw new Error('opportunity-id is required');
    const result = await previewEbayListingQualitySeedFinalMutation({
      opportunityId,
      finalMutationJson: arg('final-mutation-json', '{}'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-create-seed-final-mutation-packet') {
    const { createEbayListingQualitySeedFinalMutationPacket } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) throw new Error('opportunity-id is required');
    const write = hasFlag('write');
    const result = await createEbayListingQualitySeedFinalMutationPacket({
      opportunityId,
      finalMutationJson: arg('final-mutation-json', '{}'),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-final-mutation-detail') {
    const { getEbayListingQualitySeedFinalMutationDetail } = require('../src/services/hermesExecutionApproval');
    const opportunityId = intArg('opportunity-id', intArg('id', null));
    if (opportunityId == null) throw new Error('opportunity-id is required');
    const result = await getEbayListingQualitySeedFinalMutationDetail({ opportunityId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-create-seed-final-approval') {
    const { createEbayListingQualitySeedFinalApproval } = require('../src/services/hermesExecutionApproval');
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) throw new Error('packet-id is required');
    const write = hasFlag('write');
    const result = await createEbayListingQualitySeedFinalApproval({
      packetId,
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-final-approval-detail') {
    const { getEbayListingQualitySeedFinalApprovalDetail } = require('../src/services/hermesExecutionApproval');
    const packetId = intArg('packet-id', intArg('id', null));
    const approvalId = intArg('approval-id', null);
    if (packetId == null && approvalId == null) throw new Error('packet-id or approval-id is required');
    const result = await getEbayListingQualitySeedFinalApprovalDetail({ packetId, approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-final-approval-action') {
    const { actOnEbayListingQualitySeedFinalApproval } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const write = hasFlag('write');
    const result = await actOnEbayListingQualitySeedFinalApproval({
      approvalId,
      action: arg('action', null),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-live-readiness') {
    const { buildEbayListingQualitySeedLiveReadiness } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await buildEbayListingQualitySeedLiveReadiness({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-live-runbook') {
    const { buildEbayListingQualitySeedLiveRunbook } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await buildEbayListingQualitySeedLiveRunbook({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-live-transport') {
    const { callEbayListingQualitySeedLiveTransportBoundary } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const write = hasFlag('write');
    const result = await callEbayListingQualitySeedLiveTransportBoundary({
      approvalId,
      dryRun: !write,
      write,
      liveEnabled: String(process.env.HERMES_EBAY_LIVE_EXECUTION_ENABLED || '').toLowerCase() === 'true',
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-seed-live-failure-audit') {
    const { buildEbayListingQualitySeedLiveFailureAudit } = require('../src/services/hermesExecutionApproval');
    const requestId = intArg('request-id', intArg('id', null));
    if (requestId == null) throw new Error('request-id is required');
    const result = await buildEbayListingQualitySeedLiveFailureAudit({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-policy-remediation-plan') {
    const { buildEbayListingQualityImagePolicyRemediationPlan } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImagePolicyRemediationPlan({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-policy-evidence') {
    const { buildEbayListingQualityImagePolicyEvidence } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImagePolicyEvidence({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-remediation-readiness') {
    const { buildEbayListingQualityImageRemediationReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageRemediationReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-candidate-validate') {
    const { validateEbayListingQualityImageCandidate } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const imagePath = arg('image-path', null);
    if (!itemId) throw new Error('item-id is required');
    if (!imagePath) throw new Error('image-path is required');
    const result = await validateEbayListingQualityImageCandidate({ itemId, imagePath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-candidate-register') {
    const { registerEbayListingQualityImageCandidate } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const imagePath = arg('image-path', null);
    if (!itemId) throw new Error('item-id is required');
    if (!imagePath) throw new Error('image-path is required');
    const result = await registerEbayListingQualityImageCandidate({ itemId, imagePath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-candidate-readiness') {
    const { buildEbayListingQualityImageCandidateReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageCandidateReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }



  if (cmd === 'ebay-listing-quality-image-corruption-audit') {
    const { auditEbayListingQualityImageCorruption } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const imagePath = arg('image-path', null);
    if (!itemId) throw new Error('item-id is required');
    if (!imagePath) throw new Error('image-path is required');
    const result = await auditEbayListingQualityImageCorruption({ itemId, imagePath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-sanitize-local') {
    const { sanitizeEbayListingQualityImageLocal } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const imagePath = arg('image-path', null);
    if (!itemId) throw new Error('item-id is required');
    if (!imagePath) throw new Error('image-path is required');
    const result = await sanitizeEbayListingQualityImageLocal({ itemId, imagePath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-sanitized-candidate-readiness') {
    const { buildEbayListingQualityImageSanitizedCandidateReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageSanitizedCandidateReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-sanitized-upload-readiness') {
    const { buildEbayListingQualityImageSanitizedUploadReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageSanitizedUploadReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-sanitized-upload-approval-checklist') {
    const { buildEbayListingQualityImageSanitizedUploadApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageSanitizedUploadApprovalChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-aware-packet-plan') {
    const { buildEbayListingQualityImageAwarePacketPlan } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageAwarePacketPlan({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-aware-packet-preview') {
    const { buildEbayListingQualityImageAwarePacketPreview } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageAwarePacketPreview({ itemId, create: hasFlag('create') });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-transport-plan') {
    const { buildEbayListingQualityImageTransportPlan } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageTransportPlan({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-transport-dry-run') {
    const { buildEbayListingQualityImageTransportDryRun } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageTransportDryRun({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-upload-approval-checklist') {
    const { buildEbayListingQualityImageUploadApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadApprovalChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-upload-transport') {
    const { callEbayListingQualityImageUploadTransport } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await callEbayListingQualityImageUploadTransport({
      itemId,
      dryRun: !hasFlag('write'),
      write: hasFlag('write'),
      liveEnabled: String(process.env.HERMES_EBAY_IMAGE_UPLOAD_ENABLED || '').toLowerCase() === 'true',
      operatorApprovalText: arg('approval-text', null),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }




  if (cmd === 'ebay-listing-quality-image-generate-compatible-variants') {
    const { generateEbayListingQualityImageCompatibleVariants } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await generateEbayListingQualityImageCompatibleVariants({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-compatible-variant-audit') {
    const { buildEbayListingQualityImageCompatibleVariantAudit } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageCompatibleVariantAudit({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-compatible-upload-readiness') {
    const { buildEbayListingQualityImageCompatibleUploadReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageCompatibleUploadReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-compatible-upload-approval-checklist') {
    const { buildEbayListingQualityImageCompatibleUploadApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageCompatibleUploadApprovalChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-image-upload-payload-audit') {
    const { buildEbayImageUploadPayloadAudit } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayImageUploadPayloadAudit({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-image-upload-payload-roundtrip') {
    const { buildEbayImageUploadPayloadRoundtrip } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayImageUploadPayloadRoundtrip({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-upload-result') {
    const { buildEbayListingQualityImageUploadResult } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadResult({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }



  if (cmd === 'ebay-trading-token-readiness') {
    const { buildEbayTradingTokenReadiness } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayTradingTokenReadiness({
      operation: arg('operation', 'UploadSiteHostedPictures'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-upload-auth-failure-audit') {
    const { buildEbayListingQualityImageUploadAuthFailureAudit } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadAuthFailureAudit({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-token-source-audit') {
    const { buildEbayTokenSourceAudit } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayTokenSourceAudit({
      operation: arg('operation', 'UploadSiteHostedPictures'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-token-regression-audit') {
    const { buildEbayTokenRegressionAudit } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayTokenRegressionAudit({
      operation: arg('operation', 'UploadSiteHostedPictures'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-token-current-health') {
    const { buildEbayTokenCurrentHealth } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayTokenCurrentHealth({
      operation: arg('operation', 'UploadSiteHostedPictures'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-compatible-image-upload-token-stability-readiness') {
    const { buildEbayCompatibleImageUploadTokenStabilityReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayCompatibleImageUploadTokenStabilityReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-compatible-image-upload-token-stable-approval-checklist') {
    const { buildEbayCompatibleImageUploadTokenStableApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayCompatibleImageUploadTokenStableApprovalChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-picture-url-fallback-readiness') {
    const { buildEbayPictureUrlFallbackReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPictureUrlFallbackReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-picture-url-candidate-validate') {
    const { validateEbayPublicPictureUrlCandidate } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const pictureUrl = arg('picture-url', arg('url', null));
    if (!itemId) throw new Error('item-id is required');
    if (!pictureUrl) throw new Error('picture-url is required');
    const result = await validateEbayPublicPictureUrlCandidate({ itemId, pictureUrl });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-picture-url-candidate-readiness') {
    const { buildEbayPictureUrlCandidateReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPictureUrlCandidateReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-packet-readiness') {
    const { buildEbayPublicPictureUrlPacketReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPublicPictureUrlPacketReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-packet-preview') {
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const pictureUrl = arg('url', null);
    if (pictureUrl) {
      const { buildEbayPublicPictureUrlImagesOnlyPacketPreview } = require('../src/services/hermesExecutionApproval');
      const result = await buildEbayPublicPictureUrlImagesOnlyPacketPreview({ itemId, url: pictureUrl });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { buildEbayPublicPictureUrlPacketPreview } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlPacketPreview({ itemId, create: hasFlag('create') });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-create-packet') {
    const { createEbayPublicPictureUrlImagesOnlyPacket } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const pictureUrl = arg('url', null);
    if (!itemId) throw new Error('item-id is required');
    if (!pictureUrl) throw new Error('url is required');
    const result = await createEbayPublicPictureUrlImagesOnlyPacket({ itemId, url: pictureUrl });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-final-approval-readiness') {
    const { buildEbayPublicPictureUrlFinalApprovalReadiness } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlFinalApprovalReadiness({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-final-approval-checklist') {
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    if (String(requestId) === '7') {
      const { buildEbayPublicPictureUrlImagesOnlyFinalApprovalChecklist } = require('../src/services/hermesExecutionApproval');
      const result = await buildEbayPublicPictureUrlImagesOnlyFinalApprovalChecklist({ requestId });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const { buildEbayPublicPictureUrlFinalApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlFinalApprovalChecklist({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-approved-live-revise') {
    const { executeEbayPublicPictureUrlApprovedLiveRevise } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const write = hasFlag('write');
    const result = await executeEbayPublicPictureUrlApprovedLiveRevise({
      requestId,
      approvalText: arg('approval-text', null),
      dryRun: !write,
      write,
      liveEnabled: String(process.env.HERMES_EBAY_LIVE_EXECUTION_ENABLED || '').toLowerCase() === 'true',
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-post-live-audit') {
    const { buildEbayPublicPictureUrlPostLiveAudit } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlPostLiveAudit({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-record-reconciliation-readiness') {
    const { buildEbayPublicPictureUrlRecordReconciliationReadiness } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlRecordReconciliationReadiness({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-record-reconciliation-approval-checklist') {
    const { buildEbayPublicPictureUrlRecordReconciliationApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlRecordReconciliationApprovalChecklist({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-record-reconciliation') {
    const { executeEbayPublicPictureUrlRecordReconciliation } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const write = hasFlag('write');
    const result = await executeEbayPublicPictureUrlRecordReconciliation({
      requestId,
      approvalText: arg('approval-text', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-rollout-closeout') {
    const { buildEbayPublicPictureUrlRolloutCloseout } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlRolloutCloseout({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-final-closeout') {
    const { buildEbayPublicPictureUrlFinalCloseout } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlFinalCloseout({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-duplicate-guard') {
    const { buildEbayPublicPictureUrlDuplicateGuard } = require('../src/services/hermesExecutionApproval');
    const requestId = arg('request-id', arg('id', null));
    if (!requestId) throw new Error('request-id is required');
    const result = await buildEbayPublicPictureUrlDuplicateGuard({ requestId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-rollout-readiness') {
    const { buildEbayPublicPictureUrlRolloutReadiness } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlRolloutReadiness();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-next-candidate-plan') {
    const { buildEbayPublicPictureUrlNextCandidatePlan } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlNextCandidatePlan({
      limit: arg('limit', 10),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-plan') {
    const { buildEbayPublicPictureUrlMiniBatchPlan } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlMiniBatchPlan({
      limit: arg('limit', 5),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-image-intake-checklist') {
    const { buildEbayPublicPictureUrlMiniBatchImageIntakeChecklist } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlMiniBatchImageIntakeChecklist({
      limit: arg('limit', 5),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-url-template') {
    const { buildEbayPublicPictureUrlMiniBatchUrlTemplate } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlMiniBatchUrlTemplate({
      limit: arg('limit', 5),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-validate-urls') {
    const { validateEbayPublicPictureUrlMiniBatchUrls } = require('../src/services/hermesExecutionApproval');
    const result = await validateEbayPublicPictureUrlMiniBatchUrls({
      urlMap: arg('url-map', '{}'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-packet-preview') {
    const { buildEbayPublicPictureUrlMiniBatchPacketPreview } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlMiniBatchPacketPreview({
      urlMap: arg('url-map', '{}'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-create-packets') {
    const { createEbayPublicPictureUrlMiniBatchPackets } = require('../src/services/hermesExecutionApproval');
    const result = await createEbayPublicPictureUrlMiniBatchPackets({
      urlMap: arg('url-map', '{}'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-mini-batch-final-approval-checklist') {
    const { buildEbayPublicPictureUrlMiniBatchFinalApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlMiniBatchFinalApprovalChecklist({
      requestIds: arg('request-ids', ''),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-candidate-shortlist') {
    const { buildEbayPublicPictureUrlCandidateShortlist } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayPublicPictureUrlCandidateShortlist({
      limit: arg('limit', 10),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-candidate-detail') {
    const { buildEbayPublicPictureUrlCandidateDetail } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPublicPictureUrlCandidateDetail({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-candidate-review-checklist') {
    const { buildEbayPublicPictureUrlCandidateReviewChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPublicPictureUrlCandidateReviewChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-selected-candidate') {
    const { buildEbayPublicPictureUrlSelectedCandidate } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPublicPictureUrlSelectedCandidate({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-image-intake-checklist') {
    const { buildEbayPublicPictureUrlImageIntakeChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayPublicPictureUrlImageIntakeChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-public-picture-url-validate-candidate-url') {
    const { validateEbayPublicPictureUrlSelectedCandidateUrl } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    const url = arg('url', null);
    if (!itemId) throw new Error('item-id is required');
    if (!url) throw new Error('url is required');
    const result = await validateEbayPublicPictureUrlSelectedCandidateUrl({ itemId, url });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-token-refresh-readiness') {
    const { buildEbayTokenRefreshReadiness } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayTokenRefreshReadiness({
      operation: arg('operation', 'UploadSiteHostedPictures'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-token-refresh-approval-checklist') {
    const { buildEbayTokenRefreshApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const result = await buildEbayTokenRefreshApprovalChecklist({
      operation: arg('operation', 'UploadSiteHostedPictures'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-token-refresh-rotate') {
    const { executeEbayTokenRefreshRotation } = require('../src/services/hermesExecutionApproval');
    const write = hasFlag('write');
    const result = await executeEbayTokenRefreshRotation({
      operation: arg('operation', 'UploadSiteHostedPictures'),
      operatorApprovalText: arg('approval-text', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-image-upload-post-token-refresh-readiness') {
    const { buildEbayListingQualityImageUploadPostTokenRefreshReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadPostTokenRefreshReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-upload-post-token-refresh-approval-checklist') {
    const { buildEbayListingQualityImageUploadPostTokenRefreshApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadPostTokenRefreshApprovalChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-upload-corrected-readiness') {
    const { buildEbayListingQualityImageUploadCorrectedReadiness } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadCorrectedReadiness({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-image-upload-reapproval-checklist') {
    const { buildEbayListingQualityImageUploadReapprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const itemId = arg('item-id', arg('id', null));
    if (!itemId) throw new Error('item-id is required');
    const result = await buildEbayListingQualityImageUploadReapprovalChecklist({ itemId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-live-approval-checklist') {
    const { buildEbayListingQualitySeedLiveApprovalChecklist } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await buildEbayListingQualitySeedLiveApprovalChecklist({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-seed-evidence-complete') {
    const { completeEbayListingQualitySeedEvidence } = require('../src/services/hermesExecutionApproval');
    const reviewId = intArg('id', null);
    if (reviewId == null) throw new Error('id is required');
    const write = hasFlag('write');
    const result = await completeEbayListingQualitySeedEvidence({
      id: reviewId,
      dryRun: !write,
      write,
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


  if (cmd === 'ebay-listing-quality-confirm-promoted-packet') {
    const { confirmEbayListingQualityPromotedPacket } = require('../src/services/hermesExecutionApproval');
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) throw new Error('packet-id is required');
    const write = hasFlag('write');
    const result = await confirmEbayListingQualityPromotedPacket({
      packetId,
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (cmd === 'ebay-listing-quality-create-promoted-approval') {
    const { createEbayListingQualityPromotedApproval } = require('../src/services/hermesExecutionApproval');
    const packetId = intArg('packet-id', intArg('id', null));
    if (packetId == null) throw new Error('packet-id is required');
    const write = hasFlag('write');
    const result = await createEbayListingQualityPromotedApproval({
      packetId,
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-approval-detail') {
    const { getEbayListingQualityPromotedApprovalDetail } = require('../src/services/hermesExecutionApproval');
    const packetId = intArg('packet-id', null);
    const approvalId = intArg('approval-id', intArg('id', null));
    if (packetId == null && approvalId == null) throw new Error('packet-id or approval-id is required');
    const result = await getEbayListingQualityPromotedApprovalDetail({ packetId, approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-approval-action') {
    const { actOnEbayListingQualityPromotedApproval } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const write = hasFlag('write');
    const result = await actOnEbayListingQualityPromotedApproval({
      approvalId,
      action: arg('action', null),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-create-promoted-execution-bridge') {
    const { createEbayListingQualityPromotedExecutionBridge } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const write = hasFlag('write');
    const result = await createEbayListingQualityPromotedExecutionBridge({
      approvalId,
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-item-specifics-audit') {
    const { auditEbayListingQualityPromotedItemSpecifics } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await auditEbayListingQualityPromotedItemSpecifics({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-item-specifics-preview') {
    const { previewEbayListingQualityPromotedItemSpecifics } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await previewEbayListingQualityPromotedItemSpecifics({
      approvalId,
      itemSpecificsJson: arg('item-specifics-json', '{}'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-create-promoted-final-item-specifics-packet') {
    const { createEbayListingQualityPromotedFinalItemSpecificsPacket } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const write = hasFlag('write');
    const result = await createEbayListingQualityPromotedFinalItemSpecificsPacket({
      approvalId,
      itemSpecificsJson: arg('item-specifics-json', '{}'),
      actor: arg('actor', null),
      reason: arg('reason', null),
      dryRun: !write,
      write,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-final-item-specifics-detail') {
    const { getEbayListingQualityPromotedFinalItemSpecificsDetail } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await getEbayListingQualityPromotedFinalItemSpecificsDetail({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-live-readiness') {
    const { buildEbayListingQualityPromotedLiveReadiness } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await buildEbayListingQualityPromotedLiveReadiness({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-live-runbook') {
    const { buildEbayListingQualityPromotedLiveRunbook } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const result = await buildEbayListingQualityPromotedLiveRunbook({ approvalId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'ebay-listing-quality-promoted-live-transport') {
    const { callEbayListingQualityPromotedLiveTransportBoundary } = require('../src/services/hermesExecutionApproval');
    const approvalId = intArg('approval-id', intArg('id', null));
    if (approvalId == null) throw new Error('approval-id is required');
    const write = hasFlag('write');
    const result = await callEbayListingQualityPromotedLiveTransportBoundary({
      approvalId,
      dryRun: !write,
      write,
    });
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
