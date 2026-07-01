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
