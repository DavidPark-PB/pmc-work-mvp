#!/usr/bin/env node
/**
 * scripts/oms-owner-evidence.js — Phase 8G.
 *
 * Owner Evidence Intake CLI.
 *
 *   DEFAULT: preview / read-only. Never writes.
 *   --record-evidence: explicit gate. Delegates to canonical Phase 7C-4/5
 *                      ingestor. Requires --identity-confirmed AND, for
 *                      SUPPLIER_QUOTE / EXECUTABLE_QUOTE,
 *                      --current-quote-confirmed. Never triggers purchase /
 *                      strategic hold / marketplace mutation / notification.
 *
 *   --preview-reassessment       preview-only reassessment (returns
 *                                REASSESSMENT_PREVIEW_UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE)
 *   --reassess-after-record      when combined with --record-evidence, captures
 *                                the AFTER decision via assessInventoryDecision
 *                                and prints BEFORE/AFTER.
 *
 *   REJECTS: --apply --execute --purchase --hold --auto --auto-purchase
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { validateOwnerSupplyEvidence, previewOwnerEvidence, recordOwnerEvidence, previewOwnerEvidenceReassessment } = require('../src/services/oms/inventoryOwnerEvidenceIntakeService');
const { buildOwnerDecision } = require('../src/services/oms/inventoryOwnerDecisionService');
const { buildOwnerActionWorkflow } = require('../src/services/oms/inventoryOwnerActionWorkflowService');
const { EVIDENCE_TYPES } = require('../src/services/oms/replacementEvidenceTypes');

const FORBIDDEN_FLAGS = new Set(['--apply', '--execute', '--purchase', '--hold', '--auto', '--auto-purchase', '--auto-hold']);

function parseArgs(argv) {
  const out = {
    physicalId: null,
    evidenceType: null,
    source: null,
    supplierName: null,
    supplierId: null,
    sourceListingId: null,
    currency: 'KRW',
    price: null,
    priceBasis: 'per_physical_unit',
    physicalUnitsPerOffer: 1,
    quantityMin: null,
    quantityMax: null,
    quantityExact: null,
    minimumOrderQuantity: null,
    availabilityStatus: null,
    leadTimeDays: null,
    observedAt: null,
    sourceClass: null,
    identityConfirmed: false,
    currentQuoteConfirmed: false,
    recordEvidence: false,
    previewReassessment: false,
    reassessAfterRecord: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (FORBIDDEN_FLAGS.has(a)) {
      console.error(`ERROR: ${a} is intentionally NOT supported.`);
      console.error('  · No auto purchase · No auto strategic hold · No marketplace mutation');
      console.error('  · Use --record-evidence (with --identity-confirmed and, for SUPPLIER_QUOTE/EXECUTABLE_QUOTE, --current-quote-confirmed) to record evidence via the canonical ingestor.');
      process.exit(2);
    }
    switch (a) {
      case '--physical-id':                out.physicalId = _int(argv[++i], a); break;
      case '--type':                       out.evidenceType = argv[++i]; break;
      case '--source':                     out.source = argv[++i]; break;
      case '--supplier':                   out.supplierName = argv[++i]; break;
      case '--supplier-id':                out.supplierId = argv[++i]; break;
      case '--source-listing-id':          out.sourceListingId = argv[++i]; break;
      case '--currency':                   out.currency = argv[++i]; break;
      case '--price':
      case '--price-krw':                  out.price = _num(argv[++i], a); break;
      case '--price-basis':                out.priceBasis = argv[++i]; break;
      case '--physical-units-per-offer':   out.physicalUnitsPerOffer = _int(argv[++i], a); break;
      case '--quantity':
      case '--quantity-exact':             out.quantityExact = _int(argv[++i], a); break;
      case '--quantity-min':               out.quantityMin = _int(argv[++i], a); break;
      case '--quantity-max':               out.quantityMax = _int(argv[++i], a); break;
      case '--moq':                        out.minimumOrderQuantity = _int(argv[++i], a); break;
      case '--availability':               out.availabilityStatus = argv[++i]; break;
      case '--lead-time-days':             out.leadTimeDays = _int(argv[++i], a); break;
      case '--observed-at':                out.observedAt = argv[++i]; break;
      case '--observed-now':               out.observedAt = new Date().toISOString(); break;
      case '--source-class':               out.sourceClass = argv[++i]; break;
      case '--identity-confirmed':         out.identityConfirmed = true; break;
      case '--current-quote-confirmed':    out.currentQuoteConfirmed = true; break;
      case '--record-evidence':            out.recordEvidence = true; break;
      case '--preview-reassessment':       out.previewReassessment = true; break;
      case '--reassess-after-record':      out.reassessAfterRecord = true; break;
      case '--json':                       out.json = true; break;
      case '--help':
      case '-h':
        _printHelp(); process.exit(0);
      default:
        console.error(`ERROR: unknown flag: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function _int(v, flag) { const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 0) { console.error(`ERROR: ${flag} must be non-negative integer`); process.exit(2); } return n; }
function _num(v, flag) { const n = Number(v); if (!Number.isFinite(n) || n <= 0) { console.error(`ERROR: ${flag} must be positive number`); process.exit(2); } return n; }

function _printHelp() {
  console.log('Usage:');
  console.log('  node scripts/oms-owner-evidence.js --physical-id N --type <EVIDENCE_TYPE> --source <str> --price N --observed-at <iso> [...]');
  console.log('');
  console.log('  Evidence types:', Object.values(EVIDENCE_TYPES).join(', '));
  console.log('  Common flags:');
  console.log('    --supplier <name>            required unless type=SECONDARY_MARKET_ASK');
  console.log('    --source-listing-id <str>    recommended for deterministic idempotency');
  console.log('    --price-basis <basis>        per_physical_unit / per_offer / per_box / per_case');
  console.log('    --quantity-min N / --quantity-max N / --quantity-exact N');
  console.log('    --observed-at <iso> | --observed-now');
  console.log('    --identity-confirmed         (required with --record-evidence)');
  console.log('    --current-quote-confirmed    (required with --record-evidence for SUPPLIER_QUOTE / EXECUTABLE_QUOTE)');
  console.log('  Gates:');
  console.log('    (default)                   preview only (never writes)');
  console.log('    --record-evidence           delegate to canonical ingestor (writes to physical_market_observations)');
  console.log('    --preview-reassessment      preview-only reassessment · reports UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE');
  console.log('    --reassess-after-record     when combined with --record-evidence, captures BEFORE / AFTER via assessInventoryDecision');
  console.log('  Forbidden: --apply --execute --purchase --hold --auto*');
}

function fmtKrw(v) { return v == null ? 'UNKNOWN' : `${Number(v).toLocaleString('en-US')} KRW`; }

async function main() {
  const args = parseArgs(process.argv);
  if (!args.physicalId) { console.error('ERROR: --physical-id is required'); process.exit(2); }
  if (!args.evidenceType) { console.error('ERROR: --type is required'); process.exit(2); }
  if (!args.source && args.evidenceType !== 'SECONDARY_MARKET_ASK') { console.error('ERROR: --source is required'); process.exit(2); }
  if (!args.price) { console.error('ERROR: --price is required'); process.exit(2); }
  if (!args.observedAt) { console.error('ERROR: --observed-at (or --observed-now) is required'); process.exit(2); }

  // Capture BEFORE snapshot (for around-record reassessment or context).
  let beforeSnapshot = null;
  try {
    const ownerBefore = await buildOwnerDecision({ physicalProductId: args.physicalId });
    if (!ownerBefore.error) {
      const wfBefore = buildOwnerActionWorkflow(ownerBefore);
      beforeSnapshot = { owner_decision: ownerBefore, workflow: wfBefore };
    }
  } catch (_) { /* non-fatal for preview */ }

  const input = {
    physicalId: args.physicalId,
    evidenceType: args.evidenceType,
    source: args.source || (args.evidenceType === 'SECONDARY_MARKET_ASK' ? 'secondary_market' : null),
    supplierName: args.supplierName,
    supplierId: args.supplierId,
    sourceListingId: args.sourceListingId,
    currency: args.currency,
    price: args.price,
    priceBasis: args.priceBasis,
    physicalUnitsPerOffer: args.physicalUnitsPerOffer,
    minimumOrderQuantity: args.minimumOrderQuantity,
    availabilityStatus: args.availabilityStatus,
    leadTimeDays: args.leadTimeDays,
    observedAt: args.observedAt,
    sourceClass: args.sourceClass,
    availableQuantityMin: args.quantityMin,
    availableQuantityMax: args.quantityMax,
    availableQuantityExact: args.quantityExact,
    identityConfirmed: args.identityConfirmed,
    currentQuoteConfirmed: args.currentQuoteConfirmed,
  };

  let result;
  if (args.recordEvidence) {
    result = await recordOwnerEvidence(input, {
      identityConfirmed: args.identityConfirmed,
      currentQuoteConfirmed: args.currentQuoteConfirmed,
    });
  } else {
    result = await previewOwnerEvidence(input);
  }

  let reassessment = null;
  if (args.previewReassessment && beforeSnapshot) {
    reassessment = await previewOwnerEvidenceReassessment({ physicalProductId: args.physicalId, beforeSnapshot, mode: 'preview' });
  } else if (args.reassessAfterRecord && args.recordEvidence && beforeSnapshot && result.plan?.status && /^ingested|^partial/.test(result.plan.status)) {
    reassessment = await previewOwnerEvidenceReassessment({ physicalProductId: args.physicalId, beforeSnapshot, mode: 'around_record' });
  } else if (args.reassessAfterRecord && !args.recordEvidence) {
    console.error('WARNING: --reassess-after-record requires --record-evidence (ignored).');
  }

  if (args.json) {
    console.log(JSON.stringify({ before: beforeSnapshot, result, reassessment }, null, 2));
    process.exit(result?.plan?.status === 'failed' || result?.error ? 1 : 0);
  }
  console.log(renderHuman(input, result, reassessment));
  process.exit(result?.plan?.status === 'failed' || result?.error ? 1 : 0);
}

function renderHuman(input, result, reassessment) {
  const L = [''];
  L.push('══════════════ OWNER EVIDENCE PREVIEW ══════════════');
  L.push('');
  const phy = result.physical;
  L.push('  Product');
  L.push(`    ${phy?.canonical_title || '(unknown)'}`);
  L.push(`    physical#${input.physicalId} · ${phy?.set_code ?? '?'} · ${phy?.language ?? '?'}`);
  L.push('');
  L.push('  Evidence type');
  L.push(`    ${input.evidenceType}`);
  L.push(`  Source: ${input.source || '(secondary marketplace)'}${input.supplierName ? ' · supplier=' + input.supplierName : ''}`);
  L.push(`  Observed at: ${input.observedAt}`);
  L.push('');

  L.push('  Normalized evidence');
  const v = result.validation;
  L.push(`    price:          ${fmtKrw(input.price)}`);
  L.push(`    price_basis:    ${input.priceBasis}`);
  L.push(`    units/offer:    ${input.physicalUnitsPerOffer}`);
  L.push(`    currency:       ${input.currency}`);
  L.push(`    availability:   ${input.availabilityStatus ?? 'UNKNOWN'}`);
  L.push(`    lead_time:      ${input.leadTimeDays ?? 'UNKNOWN'}`);
  L.push('');
  L.push('  Fields provided');
  const provided = Object.entries(input).filter(([k, val]) => val != null && val !== false && !['identityConfirmed', 'currentQuoteConfirmed'].includes(k));
  for (const [k] of provided) L.push(`    ✓ ${k}`);
  L.push('  Fields UNKNOWN');
  const unknownFields = [];
  if (input.availableQuantityMin == null && input.availableQuantityMax == null && input.availableQuantityExact == null) unknownFields.push('quantity_range');
  if (input.leadTimeDays == null) unknownFields.push('lead_time_days');
  if (input.availabilityStatus == null) unknownFields.push('availability_status');
  if (input.landedCostKrw == null) unknownFields.push('landed_cost');
  for (const f of unknownFields) L.push(`    ? ${f}`);
  L.push('');

  L.push('  Semantic classification');
  const gp = v?.action_gap_projection || {};
  L.push(`    would_close CHECK_PRIMARY_SUPPLIER:   ${gp.would_close_CHECK_PRIMARY_SUPPLIER ? 'yes' : 'no'}`);
  L.push(`    would_close CONFIRM_EXECUTABLE_QUOTE: ${gp.would_close_CONFIRM_EXECUTABLE_QUOTE ? 'yes' : 'no'}`);
  L.push(`    would_close CHECK_SECONDARY_MARKET:   ${gp.would_close_CHECK_SECONDARY_MARKET ? 'yes' : 'no'}`);
  if (gp.conditional_on_current_quote_confirmed) L.push('    (conditional on --current-quote-confirmed at record time)');
  for (const fp of (gp.forbidden_promotion || [])) L.push(`    ✗ ${fp}`);
  L.push('');

  L.push('  Validation');
  L.push(`    ok=${v?.ok}`);
  for (const err of v?.errors || []) L.push(`    ERROR: ${err}`);
  for (const w of v?.warnings || []) L.push(`    warn:  ${w}`);
  if (result.gate_errors && result.gate_errors.length > 0) {
    L.push('  Record gate errors:');
    for (const g of result.gate_errors) L.push(`    REJECT: ${g}`);
  }
  L.push('');

  L.push('  Would NOT execute');
  L.push('    · purchase');
  L.push('    · strategic hold');
  L.push('    · marketplace price change');
  L.push('    · listing change');
  L.push('    · inventory adjustment');
  L.push('    · notification');
  L.push('');

  L.push('  Persistence');
  L.push(`    ${result.persistence || 'NOT_WRITTEN_PREVIEW_ONLY'}`);
  if (result.plan?.status) L.push(`    ingestor_status=${result.plan.status}`);
  if (result.plan?.would_persist?.length) L.push(`    would_persist=${result.plan.would_persist.length}`);
  if (result.plan?.inserted?.length) L.push(`    inserted=${result.plan.inserted.length}`);
  if (result.plan?.skipped_idempotent?.length) L.push(`    skipped_idempotent=${result.plan.skipped_idempotent.length}`);
  if (result.plan?.failed?.length) L.push(`    failed=${result.plan.failed.length}`);
  if (result.idempotency_note) L.push(`    ${result.idempotency_note}`);
  L.push('');

  if (reassessment) {
    L.push('  Reassessment');
    L.push(`    status=${reassessment.status}`);
    if (reassessment.status === 'REASSESSMENT_PREVIEW_UNAVAILABLE_WITHOUT_CANONICAL_PERSISTENCE') {
      L.push(`    ${reassessment.note}`);
    } else if (reassessment.status === 'REASSESSMENT_COMPLETE_VIA_CANONICAL_ASSESS') {
      L.push('    BEFORE:');
      L.push(`      decision=${reassessment.before?.decision_status} · priority=${reassessment.before?.priority_score} · quality=${reassessment.before?.supply_current_quality}`);
      L.push('    AFTER:');
      L.push(`      decision=${reassessment.after?.decision_status} · priority=${reassessment.after?.priority_score} · quality=${reassessment.after?.supply_current_quality}`);
      const cks = Object.keys(reassessment.changed || {});
      L.push(`    CHANGED: ${cks.length ? cks.join(', ') : '(nothing)'}`);
      L.push(`    UNCHANGED: ${(reassessment.unchanged || []).length} fields preserved`);
      L.push('    (assessment reused assessInventoryDecision — no parallel logic)');
    }
    L.push('');
  }

  L.push('  Policy');
  L.push('    · No auto purchase · No auto strategic hold · No marketplace mutation');
  L.push('    · SUPPLIER_QUOTE never promoted to EXECUTABLE_QUOTE');
  L.push('    · SECONDARY_MARKET_ASK never promoted to EXECUTABLE_QUOTE');
  L.push('    · Historical typical / accounting cost never satisfies current supplier quote');
  L.push('    · UNKNOWN stays UNKNOWN');
  L.push('');
  return L.join('\n');
}

main().catch(err => {
  console.error('[oms-owner-evidence] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
