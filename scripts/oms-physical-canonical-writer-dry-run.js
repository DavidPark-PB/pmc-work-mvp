#!/usr/bin/env node
'use strict';

/**
 * scripts/oms-physical-canonical-writer-dry-run.js — Phase 8P-5 CLI.
 *
 * DRY-RUN ONLY. This CLI has NO --apply / --commit / --execute flag.
 * Producing an execution flag requires a separate Phase 8P-6 after
 * Owner explicitly approves migration 095 apply + writer path apply.
 *
 * Reads a JSON file containing Owner decisions (each with a
 * decision_template + candidate_context) and prints the validated
 * transaction plan. Zero DB writes. Zero marketplace / notification /
 * scheduler contact. Zero migration apply.
 *
 * Usage:
 *   node scripts/oms-physical-canonical-writer-dry-run.js --input <file.json>
 *   node scripts/oms-physical-canonical-writer-dry-run.js --input <file.json> --json
 */

const fs = require('fs');
const path = require('path');
const { planBatch, WRITER_INTERFACE_VERSION } = require('../src/services/oms/physicalCanonicalWriter');

function parseArgs(argv) {
  const out = { input: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '--input' && next) { out.input = next; i++; }
    else if (a === '--json') { out.json = true; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    //   Explicit reject of any apply-like flag
    else if (/^--(apply|commit|execute|force|do-it)$/i.test(a)) {
      console.error(`ERROR: '${a}' is NOT supported in Phase 8P-5 · this CLI is dry-run only`);
      process.exit(3);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
Phase 8P-5 · Canonical Physical Writer · DRY-RUN ONLY

Usage:
  node scripts/oms-physical-canonical-writer-dry-run.js --input <file.json>

Options:
  --input <file>  Required. Path to a JSON file with the Owner decision batch.
                  Shape: { "decisions": [ { "decision": {...}, "candidateContext": {...}, "ownerConfirmationId": "..." } ] }
                  OR the phase-8p5-owner-top5-payload-draft.json shape (top_5_candidates[]).
  --json          Emit raw JSON output.

Never writes DB · never calls RPC · never applies migration · never
contacts marketplace / notification / scheduler / cron.
`);
}

function _briefRow(plan) {
  const status = plan.status.padEnd(9);
  const op = (plan.operation || '(none)').padEnd(28);
  const decisionSkus = (plan.decision?.confirmed_sku_master_ids || plan.decision?.sku_master_ids || []).join(',');
  const cand = plan.candidate_context?.creation_candidate_id ?? '(no candidate)';
  const target = plan.decision?.target_physical_product_id ?? '';
  const errs = (plan.errors || []).slice(0, 2).join(' · ');
  return `[${status}] ${op} sku=[${decisionSkus}] cand=${cand} target=${target}  ${errs}`;
}

function printText(batch, inputPath) {
  console.log('');
  console.log('══════ Phase 8P-5 · Canonical Writer · DRY-RUN ══════');
  console.log(`input:                  ${inputPath}`);
  console.log(`writer_interface_ver:   ${batch.writer_interface_version}`);
  console.log(`dry_run:                ${batch.dry_run}`);
  console.log(`total_decisions:        ${batch.summary.total}`);
  console.log(`validated:              ${batch.summary.validated}`);
  console.log(`rejected:               ${batch.summary.rejected}`);
  console.log(`audit_only:             ${batch.summary.audit_only}`);
  console.log(`no_write:               ${batch.summary.no_write}`);
  console.log(`duplicate_idempotency:  ${batch.duplicate_idempotency_keys_in_batch.length}`);
  console.log('');
  console.log('── PER-DECISION PLAN ──────────────────────────────────');
  for (const p of batch.plans) {
    console.log(_briefRow(p));
  }
  console.log('');
  console.log('── SAFETY ─────────────────────────────────────────────');
  console.log('• zero DB write in this phase');
  console.log('• no --apply / --commit / --execute flag exists');
  console.log('• migration 095_physical_write_audit_and_rpc.sql NOT applied');
  console.log('• BP invariant enforced at both app-side (planDecision) AND DB-side (RPC)');
  console.log('');
}

function _normalizeBatchInput(raw) {
  //   Accept two shapes:
  //   (A) { decisions: [ { decision, candidateContext, ownerConfirmationId } ] }  · direct
  //   (B) { top_5_candidates: [ { decision_template, sku_master_id, ... } ] }     · draft file
  if (Array.isArray(raw?.decisions)) return raw.decisions;
  if (Array.isArray(raw?.top_5_candidates)) {
    return raw.top_5_candidates.map(entry => {
      const dt = entry.decision_template || {};
      return {
        decision: {
          owner_decision: dt.owner_decision,
          confirmed_sku_master_ids: dt.confirmed_sku_master_ids,
          target_physical_product_id: dt.target_physical_product_id,
          proposed_display_name: dt.proposed_display_name,
          owner_authoritative_bridge: dt.owner_authoritative_bridge,
          owner_confirmed: dt.owner_confirmed === true,
          note: dt.note ?? null,
        },
        candidateContext: {
          creation_candidate_id: dt.creation_candidate_id,
          sku_master_ids: Array.isArray(dt.sku_master_ids) ? dt.sku_master_ids : (entry.sku_master_id != null ? [entry.sku_master_id] : []),
          cohort_bridge: entry.cohort_bridge ?? null,
          listing_ids: entry.listing_ids ?? [],
          product_ids: entry.product_ids ?? [],
          source_review_generated_at: entry.source_review_generated_at ?? null,
        },
        ownerConfirmationId: dt.owner_confirmation_id ?? null,
      };
    });
  }
  throw new Error('input shape not recognized · expected { decisions: [...] } or { top_5_candidates: [...] }');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error('ERROR: --input <file.json> required');
    printHelp();
    process.exit(2);
  }
  const absPath = path.resolve(args.input);
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const decisions = _normalizeBatchInput(raw);
  const batch = planBatch({ decisions });
  if (args.json) console.log(JSON.stringify(batch, null, 2));
  else printText(batch, absPath);
}

if (require.main === module) {
  main().catch(err => {
    console.error('DRY-RUN FAILED:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
