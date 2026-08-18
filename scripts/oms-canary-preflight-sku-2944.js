#!/usr/bin/env node
'use strict';

/**
 * scripts/oms-canary-preflight-sku-2944.js — Phase 8P-6 canary preflight CLI.
 *
 * READ-ONLY · single-candidate canary preflight. Owner reads the report,
 * decides whether to fill in owner_confirmed=true, re-runs to see READY,
 * and only then a SEPARATE future phase enables execution.
 *
 * This CLI has NO --apply / --commit / --execute / --force flag.
 *
 * Usage:
 *   node scripts/oms-canary-preflight-sku-2944.js --input <owner-decision.json>
 *   node scripts/oms-canary-preflight-sku-2944.js --input <owner-decision.json> --json
 */

const fs = require('fs');
const path = require('path');
const { buildCanaryPreflight, PREFLIGHT_STATUS } = require('../src/services/oms/physicalCanonicalWriterPreflight');

function parseArgs(argv) {
  const out = { input: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '--input' && next) { out.input = next; i++; }
    else if (a === '--json') { out.json = true; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (/^--(apply|commit|execute|force|do-it|run)$/i.test(a)) {
      console.error(`ERROR: '${a}' is NOT supported in Phase 8P-6 · canary preflight is dry-run only`);
      process.exit(3);
    }
  }
  return out;
}

function printHelp() {
  console.log(`
Phase 8P-6 · Canary Preflight (SKU 2944) · READ-ONLY

Usage:
  node scripts/oms-canary-preflight-sku-2944.js --input <owner-decision.json>

Input JSON shape:
  {
    "decision": { ... decision_template ... , "owner_confirmed": true|false },
    "candidateContext": { creation_candidate_id, sku_master_ids, cohort_bridge, listing_ids, product_ids, ... },
    "ownerConfirmationId": "owner-YYYY-MM-DD-...",
    "expectedCandidate": { creation_candidate_id, sku_master_ids, completed_sale_items }
  }

Options:
  --input <file>  Required. Path to Owner-completed canary decision JSON.
  --json          Emit raw JSON payload (still no PII, still no writes).

NEVER writes DB · NEVER applies migration · NEVER calls RPC · NEVER
contacts marketplace / notification / scheduler / cron.
`);
}

function printText(pf, inputPath) {
  const badge = pf.preflight_status === PREFLIGHT_STATUS.READY ? '✅ READY' : '⛔ BLOCKED';
  console.log('');
  console.log('══════ Phase 8P-6 · Canary Preflight (SKU 2944) ══════');
  console.log(`input:                     ${inputPath}`);
  console.log(`writer_interface_version:  ${pf.writer_interface_version}`);
  console.log(`canary_only:               ${pf.canary_only}`);
  console.log(`max_decisions_per_run:     ${pf.max_decisions_per_run}`);
  console.log(`preflight_status:          ${badge}`);
  if (pf.block_reasons.length) {
    console.log(`block_reasons:             ${pf.block_reasons.join(' · ')}`);
  }
  console.log('');
  console.log('── CANDIDATE IDENTITY ─────────────────────────────────');
  const c = pf.candidate_identity;
  console.log(`creation_candidate_id:     ${c.creation_candidate_id ?? '(none)'}`);
  console.log(`sku_master_ids:            [${c.sku_master_ids.join(', ')}]`);
  console.log(`cohort_bridge:             ${c.cohort_bridge ? c.cohort_bridge.basis + ' · ' + c.cohort_bridge.value : '(none)'}`);
  console.log(`listing_ids:               [${c.listing_ids.slice(0, 3).join(', ')}]${c.listing_ids.length > 3 ? ' …' : ''}`);
  console.log(`product_ids:               [${c.product_ids.slice(0, 3).join(', ')}]${c.product_ids.length > 3 ? ' …' : ''}`);
  console.log(`completed_sale_items:      ${c.completed_sale_items ?? '(unknown)'}`);
  console.log('');
  console.log('── OWNER CONFIRMATION ─────────────────────────────────');
  const o = pf.owner_confirmation;
  console.log(`owner_confirmed:           ${o.owner_confirmed}`);
  console.log(`owner_confirmation_id:     ${o.owner_confirmation_id ?? '(missing)'}`);
  console.log(`owner_decision:            ${o.owner_decision ?? '(missing)'}`);
  console.log(`confirmed_sku_master_ids:  [${o.confirmed_sku_master_ids.join(', ')}]`);
  console.log(`proposed_display_name:     ${o.proposed_display_name ?? '(missing)'}`);
  console.log(`target_physical_product_id: ${o.target_physical_product_id ?? '(none · CREATE path)'}`);
  console.log(`owner_authoritative_bridge: ${o.owner_authoritative_bridge ?? '(none · CREATE path)'}`);
  console.log('');
  console.log('── PAYLOAD DRIFT vs live 8P-4 snapshot ────────────────');
  console.log(`checked:                   ${pf.payload_drift.checked}`);
  if (pf.payload_drift.findings.length) {
    for (const f of pf.payload_drift.findings) console.log(`  ⚠ ${f.field}: expected=${JSON.stringify(f.expected)} · actual=${JSON.stringify(f.actual)}`);
  } else {
    console.log('  no drift');
  }
  console.log('');
  console.log('── BP INVARIANT ────────────────────────────────────────');
  const bp = pf.bp_invariant_status;
  console.log(`status:                    ${bp.status}`);
  console.log(`locked physical:           physical#${bp.physical_product_id} · locked skus [${bp.locked_sku_master_ids.join(', ')}]`);
  console.log(`collide_confirmed_skus:    [${bp.collide_confirmed_skus.join(', ')}]`);
  console.log(`target_physical_is_bp:     ${bp.target_physical_is_bp}`);
  console.log('');
  console.log('── EXISTING LINK CONFLICT (app-side only · RPC re-checks) ─');
  console.log(`checked:                   ${pf.existing_link_conflict_status.checked}`);
  if (pf.existing_link_conflict_status.would_be_rejected_reasons?.length) {
    console.log(`would_be_rejected:         ${pf.existing_link_conflict_status.would_be_rejected_reasons.join(' · ')}`);
  }
  console.log('');
  console.log('── EXACT TRANSACTION OPERATIONS ────────────────────────');
  console.log(`target_rpc:                ${pf.target_rpc ?? '(none · preflight did not validate)'}`);
  console.log(`idempotency_key:           ${pf.idempotency_key ?? '(none)'}`);
  if (pf.exact_transaction_operations && pf.exact_transaction_operations.length) {
    for (const op of pf.exact_transaction_operations) {
      console.log(`  · INSERT INTO ${op.table}  ${JSON.stringify(op.values)}`);
    }
  } else {
    console.log('  (no operations · preflight did not validate)');
  }
  console.log('');
  console.log('── ROLLBACK GUARANTEE ──────────────────────────────────');
  console.log(pf.rollback_guarantee);
  console.log('');
  console.log('── SAFETY ──────────────────────────────────────────────');
  console.log('• zero DB write in this phase');
  console.log('• no --apply / --commit / --execute / --force flag exists');
  console.log('• migration 095 apply is a separate future phase');
  console.log('• BP invariant enforced at app-side AND RPC (defense-in-depth)');
  console.log('');
  console.log(pf.note);
  console.log('');
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
  //   Canary rule: exactly ONE decision per run. If input is a batch shape,
  //   reject.
  if (Array.isArray(raw?.decisions) && raw.decisions.length > 1) {
    console.error(`ERROR: canary preflight allows exactly 1 decision · input has ${raw.decisions.length}`);
    process.exit(4);
  }
  const single = Array.isArray(raw?.decisions) ? raw.decisions[0] : raw;
  const pf = buildCanaryPreflight({
    decision: single.decision,
    candidateContext: single.candidateContext,
    ownerConfirmationId: single.ownerConfirmationId,
    expectedCandidate: single.expectedCandidate,
  });
  if (args.json) console.log(JSON.stringify(pf, null, 2));
  else printText(pf, absPath);
}

if (require.main === module) {
  main().catch(err => {
    console.error('CANARY PREFLIGHT FAILED:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
