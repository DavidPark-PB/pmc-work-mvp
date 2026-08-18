#!/usr/bin/env node
/**
 * scripts/oms-owner-quote.js — Phase 8H · Owner Evidence Capture UX wrapper.
 *
 * Thin UX layer on top of Phase 8G `inventoryOwnerEvidenceIntakeService`.
 * ZERO parallel validation / business logic / write path.
 *
 * Modes (mutually exclusive):
 *   --supplier    → SUPPLIER_QUOTE
 *   --executable  → EXECUTABLE_QUOTE
 *   --secondary   → SECONDARY_MARKET_ASK (--market kream|bunjang|junggonara|karrot|other)
 *
 * Defaults: preview only. Never writes. Never mutates. Never notifies.
 *
 * To write: --record-evidence (canonical ingestor path).
 *   SUPPLIER_QUOTE / EXECUTABLE_QUOTE also require:
 *     --identity-confirmed
 *     --current-quote-confirmed
 *   SECONDARY_MARKET_ASK requires --identity-confirmed only (per canonical contract).
 *
 * Rejects: --apply --execute --purchase --hold --auto --auto-purchase --auto-hold
 * (Note: --executable is the mode flag; --execute is a forbidden mutation flag.)
 */
'use strict';

const path = require('path');
const { EVIDENCE_TYPES } = require('../src/services/oms/replacementEvidenceTypes');

const FORBIDDEN_FLAGS = new Set(['--apply', '--execute', '--purchase', '--hold', '--auto', '--auto-purchase', '--auto-hold']);
const SECONDARY_MARKETS = new Set(['kream', 'bunjang', 'junggonara', 'karrot', 'other']);

function parseArgs(argv) {
  const out = {
    physicalId: null,
    mode: null,               // 'supplier' | 'executable' | 'secondary'
    name: null,               // supplier / seller / (unused for secondary except as alias)
    market: null,             // secondary only
    sourceListingId: null,
    price: null,
    currency: 'KRW',
    qtyExact: null,
    qtyMin: null,
    qtyMax: null,
    observedAt: null,
    identityConfirmed: false,
    currentQuoteConfirmed: false,
    recordEvidence: false,
    reassess: false,
    json: false,
  };
  const modeErrors = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (FORBIDDEN_FLAGS.has(a)) {
      const err = new Error(`FORBIDDEN_FLAG:${a}`);
      err.forbidden = a;
      throw err;
    }
    switch (a) {
      case '--physical-id':               out.physicalId = _int(argv[++i], a); break;
      case '--supplier':                  if (out.mode) modeErrors.push('mode'); out.mode = 'supplier'; break;
      case '--executable':                if (out.mode) modeErrors.push('mode'); out.mode = 'executable'; break;
      case '--secondary':                 if (out.mode) modeErrors.push('mode'); out.mode = 'secondary'; break;
      case '--name':                      out.name = argv[++i]; break;
      case '--market':                    out.market = String(argv[++i] || '').toLowerCase(); break;
      case '--source-listing-id':         out.sourceListingId = argv[++i]; break;
      case '--price':
      case '--price-krw':                 out.price = _num(argv[++i], a); break;
      case '--currency':                  out.currency = String(argv[++i] || 'KRW').toUpperCase(); break;
      case '--qty':
      case '--qty-exact':                 out.qtyExact = _int(argv[++i], a); break;
      case '--qty-min':                   out.qtyMin = _int(argv[++i], a); break;
      case '--qty-max':                   out.qtyMax = _int(argv[++i], a); break;
      case '--observed-at':               out.observedAt = argv[++i]; break;
      case '--observed-now':              out.observedAt = new Date().toISOString(); break;
      case '--identity-confirmed':        out.identityConfirmed = true; break;
      case '--current-quote-confirmed':   out.currentQuoteConfirmed = true; break;
      case '--record-evidence':           out.recordEvidence = true; break;
      case '--reassess':                  out.reassess = true; break;
      case '--json':                      out.json = true; break;
      case '--help':
      case '-h':                          _printHelp(); process.exit(0);
      default: {
        const err = new Error(`UNKNOWN_FLAG:${a}`);
        err.unknown = a;
        throw err;
      }
    }
  }

  const errors = [];
  if (!out.physicalId) errors.push('--physical-id required (positive integer)');
  if (!out.mode) errors.push('one of --supplier / --executable / --secondary required');
  if (modeErrors.length > 0) errors.push('modes --supplier / --executable / --secondary are mutually exclusive');
  if (!out.price) errors.push('--price required (positive number)');
  if (!out.observedAt) errors.push('--observed-at or --observed-now required');

  if (out.mode === 'supplier' || out.mode === 'executable') {
    if (!out.name) errors.push('--name required for --supplier / --executable');
  }
  if (out.mode === 'secondary') {
    if (!out.market) errors.push('--market required for --secondary (kream|bunjang|junggonara|karrot|other)');
    else if (!SECONDARY_MARKETS.has(out.market)) errors.push(`--market must be one of ${[...SECONDARY_MARKETS].join('/')}`);
  }
  if (out.qtyExact != null && (out.qtyMin != null || out.qtyMax != null)) {
    errors.push('use either --qty exact OR --qty-min/--qty-max range · not both');
  }
  if (out.qtyMin != null && out.qtyMax != null && out.qtyMin > out.qtyMax) {
    errors.push('--qty-min must not exceed --qty-max');
  }
  if (out.reassess && !out.recordEvidence) {
    errors.push('--reassess requires --record-evidence');
  }

  return { args: out, errors };
}

function _int(v, flag) { const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 0) { throw new Error(`${flag} must be non-negative integer`); } return n; }
function _num(v, flag) { const n = Number(v); if (!Number.isFinite(n) || n <= 0) { throw new Error(`${flag} must be positive number`); } return n; }

/**
 * Explicit mapping — NEVER auto-promote between evidence types.
 * secondary + qty + price stays SECONDARY_MARKET_ASK.
 */
function mapArgsToIntakeInput(args) {
  const evidenceType = args.mode === 'supplier' ? EVIDENCE_TYPES.SUPPLIER_QUOTE
    : args.mode === 'executable' ? EVIDENCE_TYPES.EXECUTABLE_QUOTE
    : args.mode === 'secondary' ? EVIDENCE_TYPES.SECONDARY_MARKET_ASK
    : null;
  const isSecondary = args.mode === 'secondary';
  return {
    physicalId: args.physicalId,
    evidenceType,
    source: isSecondary ? args.market : args.name,
    supplierName: isSecondary ? null : args.name,
    supplierId: null,
    sourceListingId: args.sourceListingId,
    currency: args.currency || 'KRW',
    price: args.price,
    priceBasis: 'per_physical_unit',
    physicalUnitsPerOffer: 1,
    availableQuantityExact: args.qtyExact,
    availableQuantityMin: args.qtyMin,
    availableQuantityMax: args.qtyMax,
    observedAt: args.observedAt,
    sourceClass: isSecondary ? 'secondary_market'
      : (args.mode === 'supplier' || args.mode === 'executable') ? 'primary_distributor'
      : null,
    identityConfirmed: args.identityConfirmed,
    currentQuoteConfirmed: args.currentQuoteConfirmed,
  };
}

function _printHelp() {
  console.log('Usage:');
  console.log('  node scripts/oms-owner-quote.js --physical-id N (--supplier | --executable | --secondary) [flags]');
  console.log('');
  console.log('Modes (mutually exclusive · no auto-promotion between types):');
  console.log('  --supplier              SUPPLIER_QUOTE — --name <REAL_SUPPLIER> required');
  console.log('  --executable            EXECUTABLE_QUOTE — --name <REAL_SUPPLIER> required (seller-confirmed price + qty + availability)');
  console.log('  --secondary --market X  SECONDARY_MARKET_ASK — X ∈ kream|bunjang|junggonara|karrot|other');
  console.log('');
  console.log('Flags:');
  console.log('  --price <REAL_PRICE_KRW>              default currency KRW · pass --currency to change');
  console.log('  --qty <REAL_QTY> | --qty-min N --qty-max N   exact OR range · omit → UNKNOWN');
  console.log('  --observed-at <iso> | --observed-now');
  console.log('  --source-listing-id <str>             recommended for deterministic idempotency');
  console.log('  --json');
  console.log('');
  console.log('Record gates (default = preview only):');
  console.log('  --record-evidence                     writes via canonical ingestor');
  console.log('    + --identity-confirmed              (always required with --record-evidence)');
  console.log('    + --current-quote-confirmed         (required with SUPPLIER_QUOTE / EXECUTABLE_QUOTE)');
  console.log('  --reassess                            after successful record, print BEFORE/AFTER using assessInventoryDecision');
  console.log('');
  console.log('Forbidden: --apply --execute --purchase --hold --auto* (rejected)');
  console.log('');
  console.log('Examples (placeholders — never fabricate real BP quotes):');
  console.log('  node scripts/oms-owner-quote.js --physical-id 1 --supplier --name "<REAL_SUPPLIER>" --price <REAL_PRICE_KRW> --qty <REAL_QTY> --observed-now');
  console.log('  node scripts/oms-owner-quote.js --physical-id 1 --executable --name "<REAL_SUPPLIER>" --price <REAL_PRICE_KRW> --qty <REAL_QTY> --observed-now');
  console.log('  node scripts/oms-owner-quote.js --physical-id 1 --secondary --market kream --price <REAL_PRICE_KRW> --qty <REAL_QTY> --observed-now');
}

/**
 * Owner Confirmation Summary — printed BEFORE any write.
 * Never contains BP-real fabricated quotes; only whatever Owner just typed.
 */
function renderConfirmation({ input, physical, args }) {
  const L = [''];
  L.push('══════════════ OWNER EVIDENCE CONFIRMATION ══════════════');
  L.push('');
  L.push('  Product:');
  L.push(`    ${physical?.canonical_title || '(name pending lookup)'} · physical#${input.physicalId}`);
  L.push('');
  L.push(`  Type:  ${input.evidenceType}`);
  L.push(`  Source: ${input.source || '(secondary marketplace)'}${input.supplierName ? ' · supplier=' + input.supplierName : ''}`);
  L.push(`  Price:  ${Number(input.price).toLocaleString('en-US')} ${input.currency} / physical`);
  const qtyLine = input.availableQuantityExact != null ? `exact ${input.availableQuantityExact}`
    : (input.availableQuantityMin != null || input.availableQuantityMax != null)
      ? `${input.availableQuantityMin ?? '?'}–${input.availableQuantityMax ?? '?'}`
      : 'UNKNOWN';
  L.push(`  Quantity: ${qtyLine}`);
  L.push(`  Observed: ${input.observedAt}`);
  L.push('');
  L.push('  This WILL:');
  L.push(args.recordEvidence ? '    · write 1 canonical evidence observation (physical_market_observations)' : '    · print preview only (no persistence)');
  L.push('');
  L.push('  This WILL NOT:');
  L.push('    · purchase');
  L.push('    · reserve');
  L.push('    · strategic hold');
  L.push('    · change marketplace');
  L.push('    · change inventory');
  L.push('    · send notification');
  L.push('');
  return L.join('\n');
}

function renderResult({ input, args, result, reassessment }) {
  const L = [];
  L.push('  Validation');
  const v = result.validation || {};
  L.push(`    ok=${v.ok}`);
  for (const err of v.errors || []) L.push(`    ERROR: ${err}`);
  for (const w of v.warnings || []) L.push(`    warn:  ${w}`);
  if (result.gate_errors && result.gate_errors.length > 0) {
    L.push('  Record gate errors:');
    for (const g of result.gate_errors) L.push(`    REJECT: ${g}`);
  }
  L.push('');
  const gp = v.action_gap_projection || {};
  L.push('  Would close');
  L.push(`    CHECK_PRIMARY_SUPPLIER:   ${gp.would_close_CHECK_PRIMARY_SUPPLIER ? 'yes' : 'no'}`);
  L.push(`    CONFIRM_EXECUTABLE_QUOTE: ${gp.would_close_CONFIRM_EXECUTABLE_QUOTE ? 'yes' : 'no'}`);
  L.push(`    CHECK_SECONDARY_MARKET:   ${gp.would_close_CHECK_SECONDARY_MARKET ? 'yes' : 'no'}`);
  for (const fp of (gp.forbidden_promotion || [])) L.push(`    ✗ ${fp}`);
  L.push('');
  L.push('  Persistence');
  L.push(`    ${result.persistence || 'NOT_WRITTEN_PREVIEW_ONLY'}`);
  if (result.plan?.status) L.push(`    ingestor_status=${result.plan.status}`);
  if (result.plan?.inserted?.length) L.push(`    inserted=${result.plan.inserted.length}`);
  if (result.plan?.skipped_idempotent?.length) L.push(`    skipped_idempotent=${result.plan.skipped_idempotent.length}`);
  if (result.plan?.failed?.length) L.push(`    failed=${result.plan.failed.length}`);
  if (result.plan?.rejected?.length) L.push(`    identity_rejected=${result.plan.rejected.length}`);
  L.push('');
  if (reassessment) {
    L.push('  Reassessment');
    L.push(`    status=${reassessment.status}`);
    if (reassessment.before && reassessment.after) {
      L.push('    BEFORE');
      L.push(`      decision=${reassessment.before.decision_status} · priority=${reassessment.before.priority_score} · quality=${reassessment.before.supply_current_quality}`);
      L.push('    AFTER');
      L.push(`      decision=${reassessment.after.decision_status} · priority=${reassessment.after.priority_score} · quality=${reassessment.after.supply_current_quality}`);
      const closed = _closedActions(reassessment);
      const stillOpen = _stillOpenActions(reassessment);
      L.push(`    CLOSED ACTIONS: ${closed.length ? closed.join(', ') : '(none)'}`);
      L.push(`    STILL OPEN:     ${stillOpen.length ? stillOpen.join(', ') : '(none)'}`);
    } else if (reassessment.note) {
      L.push(`    ${reassessment.note}`);
    }
    L.push('');
  }
  L.push('  Policy');
  L.push('    · No auto purchase · No auto strategic hold · No marketplace mutation');
  L.push('    · SUPPLIER_QUOTE never promoted to EXECUTABLE_QUOTE');
  L.push('    · SECONDARY_MARKET_ASK never promoted to EXECUTABLE_QUOTE');
  L.push('    · Historical typical / accounting cost never satisfies current quote');
  L.push('    · UNKNOWN stays UNKNOWN — no fabrication');
  return L.join('\n');
}

function _closedActions(reassessment) {
  const before = new Map((reassessment.before?.owner_action_statuses || []).map(s => [s.code, s.status]));
  const after = new Map((reassessment.after?.owner_action_statuses || []).map(s => [s.code, s.status]));
  const closed = [];
  for (const [code, prev] of before) {
    const now = after.get(code);
    if (prev === 'OPEN' && (now === 'EVIDENCE_READY' || now === 'CLOSED_NO_ACTION' || now === 'OWNER_REVIEW_REQUIRED')) closed.push(code);
  }
  return closed;
}
function _stillOpenActions(reassessment) {
  const after = reassessment.after?.owner_action_statuses || [];
  return after.filter(s => s.status === 'OPEN' || s.status === 'EVIDENCE_PARTIAL').map(s => s.code);
}

/**
 * @param {Object[]} argv                      normally process.argv
 * @param {Object}   deps
 * @param {Function} deps.previewFn            (input) → previewResult
 * @param {Function} deps.recordFn             (input, opts) → recordResult
 * @param {Function} deps.reassessFn           ({physicalProductId, beforeSnapshot, mode, assessFn}) → reassessResult
 * @param {Function} deps.buildOwnerDecisionFn ({physicalProductId, assessFn?}) → ownerDecision
 * @param {Function} deps.buildOwnerActionWorkflowFn (ownerDecision) → workflow
 * @param {Function} [deps.log=console.log]
 * @param {Function} [deps.err=console.error]
 */
async function main(argv, deps) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e.forbidden) {
      err(`ERROR: ${e.forbidden} is intentionally NOT supported.`);
      err('  · No auto purchase · No auto strategic hold · No marketplace mutation');
      err('  · Use --record-evidence (with --identity-confirmed and, for SUPPLIER_QUOTE/EXECUTABLE_QUOTE, --current-quote-confirmed) to write via canonical ingestor.');
      return 2;
    }
    if (e.unknown) { err(`ERROR: unknown flag: ${e.unknown}`); return 2; }
    err(`ERROR: ${e.message}`); return 2;
  }
  const { args, errors } = parsed;
  if (errors.length > 0) { for (const m of errors) err(`ERROR: ${m}`); return 2; }

  const input = mapArgsToIntakeInput(args);

  // Capture BEFORE snapshot for --reassess (only when we plan to record).
  let beforeSnapshot = null;
  if (args.reassess && args.recordEvidence) {
    try {
      const ownerBefore = await deps.buildOwnerDecisionFn({ physicalProductId: args.physicalId });
      if (!ownerBefore.error) {
        const wfBefore = deps.buildOwnerActionWorkflowFn(ownerBefore);
        beforeSnapshot = { owner_decision: ownerBefore, workflow: wfBefore };
      }
    } catch (_) { /* non-fatal */ }
  }

  const result = args.recordEvidence
    ? await deps.recordFn(input, { identityConfirmed: args.identityConfirmed, currentQuoteConfirmed: args.currentQuoteConfirmed })
    : await deps.previewFn(input);

  // Reassess only after successful canonical persistence.
  let reassessment = null;
  const persistedOk = args.recordEvidence && result?.plan?.status && (result.plan.status === 'ingested' || result.plan.status === 'partial');
  if (args.reassess && args.recordEvidence) {
    if (!persistedOk) {
      err('WARNING: --reassess skipped — record did not succeed.');
    } else if (beforeSnapshot) {
      reassessment = await deps.reassessFn({ physicalProductId: args.physicalId, beforeSnapshot, mode: 'around_record' });
    }
  }

  if (args.json) {
    log(JSON.stringify({ input, result, reassessment }, null, 2));
  } else {
    log(renderConfirmation({ input, physical: result.physical, args }));
    log(renderResult({ input, args, result, reassessment }));
  }

  const failed = !!result.error || (result.plan?.status === 'failed') || (result.gate_errors && result.gate_errors.length > 0);
  return failed ? 1 : 0;
}

module.exports = { parseArgs, mapArgsToIntakeInput, renderConfirmation, renderResult, main, FORBIDDEN_FLAGS, SECONDARY_MARKETS };

// ─── entrypoint (not run when required by tests) ────────
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../config/.env') });
  const { previewOwnerEvidence, recordOwnerEvidence, previewOwnerEvidenceReassessment } = require('../src/services/oms/inventoryOwnerEvidenceIntakeService');
  const { buildOwnerDecision } = require('../src/services/oms/inventoryOwnerDecisionService');
  const { buildOwnerActionWorkflow } = require('../src/services/oms/inventoryOwnerActionWorkflowService');
  main(process.argv, {
    previewFn: previewOwnerEvidence,
    recordFn: recordOwnerEvidence,
    reassessFn: previewOwnerEvidenceReassessment,
    buildOwnerDecisionFn: buildOwnerDecision,
    buildOwnerActionWorkflowFn: buildOwnerActionWorkflow,
  }).then(code => process.exit(code)).catch(e => { console.error('[oms-owner-quote] FATAL:', e && e.message ? e.message : e); process.exit(1); });
}
