#!/usr/bin/env node
/**
 * scripts/oms-owner-actions.js — Phase 8F · Owner Action Workflow CLI.
 *
 * READ-ONLY. Explicitly rejects --apply / --execute / --purchase / --hold.
 * Never writes. Never mutates. Never sends notifications.
 *
 * Usage:
 *   node scripts/oms-owner-actions.js --physical-id N
 *   node scripts/oms-owner-actions.js --physical-id N --json
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { buildOwnerDecision } = require('../src/services/oms/inventoryOwnerDecisionService');
const { buildOwnerActionWorkflow, WORKFLOW_STATUS } = require('../src/services/oms/inventoryOwnerActionWorkflowService');

const FORBIDDEN_FLAGS = new Set(['--apply', '--execute', '--purchase', '--hold']);

function parseArgs(argv) {
  const out = { physicalId: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (FORBIDDEN_FLAGS.has(a)) {
      console.error(`ERROR: ${a} is intentionally NOT supported. This CLI is READ-ONLY Owner Action Workflow.`);
      console.error('  · No auto purchase · No auto strategic hold · No marketplace mutation · No listing change');
      console.error('  · Use dedicated owner-approved paths for any operational change.');
      process.exit(2);
    }
    if (a === '--physical-id') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isInteger(n) || n <= 0) { console.error('ERROR: --physical-id must be a positive integer'); process.exit(2); }
      out.physicalId = n;
    } else if (a === '--json') { out.json = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/oms-owner-actions.js --physical-id N [--json]');
      console.log('  READ-ONLY Owner Action Workflow — evidence-closure projection.');
      console.log('  Rejects: --apply --execute --purchase --hold');
      process.exit(0);
    } else {
      console.error(`ERROR: unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function summarise(ownerDecision, workflow) {
  const L = [''];
  L.push('══════════════ Owner Action Workflow ══════════════');
  L.push('');

  L.push('  Product');
  L.push(`    ${ownerDecision.product?.title || '(no title)'}`);
  L.push(`    physical#${ownerDecision.physical_product_id} · ${ownerDecision.product?.set_code ?? '?'} · ${ownerDecision.product?.language ?? '?'}`);
  L.push('');

  L.push('  Decision / priority');
  L.push(`    ${ownerDecision.headline.decision_status} · priority=${ownerDecision.headline.priority_score} · confidence=${ownerDecision.headline.confidence_level || '?'}`);
  L.push('');

  // Split by status
  const openish = workflow.workflow_actions.filter(a => a.status === WORKFLOW_STATUS.OPEN || a.status === WORKFLOW_STATUS.EVIDENCE_PARTIAL || a.status === WORKFLOW_STATUS.OWNER_REVIEW_REQUIRED);
  const observations = workflow.workflow_actions.filter(a => a.action_code === 'WATCH_ONLY');
  const evidenceReady = workflow.workflow_actions.filter(a => a.status === WORKFLOW_STATUS.EVIDENCE_READY);
  const closed = workflow.workflow_actions.filter(a => a.status === WORKFLOW_STATUS.CLOSED_NO_ACTION);

  const openActions = openish.filter(a => a.action_code !== 'WATCH_ONLY');
  L.push('  OPEN ACTIONS');
  if (openActions.length === 0) L.push('    (none)');
  openActions.forEach((a, i) => {
    L.push('');
    L.push(`    [${i + 1}] ${a.action_code}   [${a.status}]`);
    if (a.why_now) L.push(`        why: ${a.why_now}`);
    if ((a.required_evidence || []).length > 0) {
      const rel = a.required_evidence_relation === 'ANY_OF' ? ' (any of)' : '';
      L.push(`        evidence required${rel}: ${a.required_evidence.join(', ')}`);
    }
    if ((a.current_evidence || []).length > 0) L.push(`        current evidence: ${a.current_evidence.join(', ')}`);
    if ((a.missing_evidence || []).length > 0) L.push(`        missing: ${a.missing_evidence.join(', ')}`);
    if ((a.not_accepted_as_closure || []).length > 0) L.push(`        NOT accepted as closure: ${a.not_accepted_as_closure.join(', ')}`);
    if ((a.semantic_notes || []).length > 0) {
      for (const n of a.semantic_notes) L.push(`        · ${n}`);
    }
    L.push(`        requires_owner_approval=${a.requires_owner_approval} · executable_by_system=${a.executable_by_system}`);
  });
  L.push('');

  if (evidenceReady.length > 0) {
    L.push('  EVIDENCE READY (re-evaluate decision · Owner reviews recommendation)');
    for (const a of evidenceReady) {
      L.push(`    · ${a.action_code} — evidence: ${(a.current_evidence || []).join(', ') || 'n/a'}`);
    }
    L.push('');
  }

  if (observations.length > 0) {
    L.push('  OBSERVATION');
    for (const a of observations) {
      L.push(`    · ${a.action_code} — ${a.why_now || 'watch only'}`);
    }
    L.push('');
  }

  if (closed.length > 0) {
    L.push('  CLOSED');
    for (const a of closed) L.push(`    · ${a.action_code}`);
    L.push('');
  }

  L.push('  AUTOMATIC EXECUTION');
  L.push('    NONE');
  for (const a of workflow.forbidden_automatic_actions) L.push(`    - forbidden: ${a}`);
  L.push('');
  L.push('  Re-evaluation hint');
  L.push(`    ${workflow.reevaluation_hint}`);
  L.push('');
  L.push('  Policy');
  L.push('    · No auto purchase · No auto strategic hold · No marketplace mutation');
  L.push('    · Historical typical / accounting cost NEVER treated as current supplier quote');
  L.push('    · Secondary-market ASK NEVER treated as executable quote');
  L.push('    · UNKNOWN stays UNKNOWN — no invented numbers');
  L.push('');
  return L.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.physicalId) { console.error('ERROR: --physical-id is required'); process.exit(2); }
  const ownerDecision = await buildOwnerDecision({ physicalProductId: args.physicalId });
  if (ownerDecision.error) {
    console.error(`ERROR: ${ownerDecision.error} for physical#${args.physicalId}`);
    process.exit(1);
  }
  const workflow = buildOwnerActionWorkflow(ownerDecision);
  if (args.json) console.log(JSON.stringify({ owner_decision: ownerDecision, workflow }, null, 2));
  else console.log(summarise(ownerDecision, workflow));
  process.exit(0);
})().catch(err => {
  console.error('[oms-owner-actions] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
