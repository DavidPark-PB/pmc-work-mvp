'use strict';

/**
 * tests/oms/physicalCanonicalWriterPreflight.test.js — Phase 8P-6.
 * Canary preflight tests · zero DB · pure functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildCanaryPreflight, PREFLIGHT_STATUS } = require('../../src/services/oms/physicalCanonicalWriterPreflight');
const { DECISION_ENUM, BP_INVARIANT } = require('../../src/services/oms/physicalCanonicalWriter');

function candidate(overrides = {}) {
  return {
    creation_candidate_id: 'pcc-1',
    sku_master_ids: [2944],
    cohort_bridge: { basis: 'singleton_sku_master_id', value: 'sku:2944' },
    listing_ids: ['ebay:L2944'],
    product_ids: [],
    completed_sale_items: 128,
    source_review_generated_at: '2026-08-19T00:00:00Z',
    ...overrides,
  };
}
function createDecision(overrides = {}) {
  return {
    owner_decision: DECISION_ENUM.CREATE_NEW_PHYSICAL,
    confirmed_sku_master_ids: [2944],
    proposed_display_name: 'Test Physical Product',
    owner_confirmed: true,
    ...overrides,
  };
}

// ─── READY path ─────────────────

test('CP1. Valid CREATE with owner_confirmed=true + owner_confirmation_id → READY', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'owner-2026-08-19-canary-01',
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.READY);
  assert.equal(pf.canary_only, true);
  assert.equal(pf.max_decisions_per_run, 1);
  assert.equal(pf.bp_invariant_status.status, 'INTACT');
  assert.match(pf.rollback_guarantee, /ATOMIC/);
  assert.ok(pf.exact_transaction_operations.length > 0);
  assert.match(pf.target_rpc, /apply_canonical_create_physical/);
  assert.match(pf.idempotency_key, /^[0-9a-f]{64}$/);
});

// ─── BLOCKED · owner_confirmed=false ─

test('CP2. owner_confirmed=false → BLOCKED · owner_confirmed_must_be_true reason', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision({ owner_confirmed: false }), candidateContext: candidate(),
    ownerConfirmationId: 'owner-x',
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  assert.ok(pf.block_reasons.includes('owner_confirmed_must_be_true'));
});

test('CP3. owner_confirmation_id missing → BLOCKED', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    /* no ownerConfirmationId */
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  assert.ok(pf.block_reasons.includes('owner_confirmation_id_missing_or_too_short'));
});

test('CP4. owner_confirmation_id too short → BLOCKED', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'x',
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  assert.ok(pf.block_reasons.includes('owner_confirmation_id_missing_or_too_short'));
});

// ─── BP invariant checks ─

test('CP5. BP-locked sku in confirmed_sku_master_ids → BP status VIOLATED + BLOCKED', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision({ confirmed_sku_master_ids: [2194] }),
    candidateContext: candidate({ sku_master_ids: [2194] }),
    ownerConfirmationId: 'owner-x',
  });
  assert.equal(pf.bp_invariant_status.status, 'VIOLATED');
  assert.deepEqual(pf.bp_invariant_status.collide_confirmed_skus, [2194]);
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
});

test('CP6. LINK target=1 (BP) → BP status VIOLATED + BLOCKED', () => {
  const pf = buildCanaryPreflight({
    decision: {
      owner_decision: DECISION_ENUM.LINK_TO_EXISTING_PHYSICAL,
      confirmed_sku_master_ids: [2944],
      target_physical_product_id: 1,
      owner_authoritative_bridge: 'listing:ebay:xyz',
      owner_confirmed: true,
    },
    candidateContext: candidate(),
    ownerConfirmationId: 'owner-canary',
  });
  assert.equal(pf.bp_invariant_status.status, 'VIOLATED');
  assert.equal(pf.bp_invariant_status.target_physical_is_bp, true);
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
});

test('CP7. Normal candidate (SKU 2944 not in BP-locked list) → BP status INTACT', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'owner-canary-v1',
  });
  assert.equal(pf.bp_invariant_status.status, 'INTACT');
  assert.equal(pf.bp_invariant_status.collide_confirmed_skus.length, 0);
});

// ─── Payload drift detection ─

test('CP8. Drift on creation_candidate_id → BLOCKED · payload_stale', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate({ creation_candidate_id: 'pcc-99' }),
    ownerConfirmationId: 'owner-x',
    expectedCandidate: { creation_candidate_id: 'pcc-1', sku_master_ids: [2944], completed_sale_items: 128 },
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  assert.ok(pf.block_reasons.includes('payload_stale_vs_expected_snapshot'));
  assert.ok(pf.payload_drift.findings.some(f => f.field === 'creation_candidate_id'));
});

test('CP9. Drift on sku_master_ids (missing / added) → BLOCKED · payload_stale', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate({ sku_master_ids: [2944, 999] }),
    ownerConfirmationId: 'owner-x',
    expectedCandidate: { creation_candidate_id: 'pcc-1', sku_master_ids: [2944], completed_sale_items: 128 },
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  const drift = pf.payload_drift.findings.find(f => f.field === 'sku_master_ids');
  assert.ok(drift);
  assert.deepEqual(drift.added, [999]);
});

test('CP10. Small sales delta (±5 items) tolerated · no drift', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate({ completed_sale_items: 130 }),
    ownerConfirmationId: 'owner-canary-01',
    expectedCandidate: { creation_candidate_id: 'pcc-1', sku_master_ids: [2944], completed_sale_items: 128 },
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.READY);
  assert.equal(pf.payload_drift.findings.length, 0);
});

test('CP11. Large sales delta (>5) → drift finding · BLOCKED', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate({ completed_sale_items: 200 }),
    ownerConfirmationId: 'owner-x',
    expectedCandidate: { creation_candidate_id: 'pcc-1', sku_master_ids: [2944], completed_sale_items: 128 },
  });
  assert.ok(pf.payload_drift.findings.some(f => f.field === 'completed_sale_items'));
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
});

// ─── Decision types that never write ─

test('CP12. DEFER decision → BLOCKED · decision_type_produces_no_write', () => {
  const pf = buildCanaryPreflight({
    decision: { owner_decision: DECISION_ENUM.DEFER },
    candidateContext: candidate(),
    ownerConfirmationId: 'owner-x',
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  assert.ok(pf.block_reasons.includes('decision_type_produces_no_write'));
});

test('CP13. MARK_NON_PHYSICAL → BLOCKED · decision_type_produces_audit_only_no_physical_or_link', () => {
  const pf = buildCanaryPreflight({
    decision: { owner_decision: DECISION_ENUM.MARK_NON_PHYSICAL },
    candidateContext: candidate(),
    ownerConfirmationId: 'owner-x',
  });
  assert.equal(pf.preflight_status, PREFLIGHT_STATUS.BLOCKED);
  assert.ok(pf.block_reasons.includes('decision_type_produces_audit_only_no_physical_or_link'));
});

// ─── Exact transaction operations mirror the plan ─

test('CP14. exact_transaction_operations includes physical_products INSERT · physical_write_audit INSERT · N × sku_master_link', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'owner-canary-x',
  });
  const tables = pf.exact_transaction_operations.map(op => op.table);
  assert.ok(tables.includes('physical_products'));
  assert.ok(tables.includes('sellable_units'));
  assert.ok(tables.includes('sellable_unit_components'));
  assert.ok(tables.includes('sku_master_link'));
  assert.ok(tables.includes('physical_write_audit'));
});

test('CP15. Expected audit row shape captures operation + idempotency_key + candidate_id', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'owner-canary-y',
  });
  const audit = pf.expected_audit_row;
  assert.ok(audit);
  assert.equal(audit.operation, 'CREATE_NEW_PHYSICAL');
  assert.match(audit.idempotency_key, /^[0-9a-f]{64}$/);
  assert.equal(audit.source_review_candidate_id, 'pcc-1');
});

// ─── Canary rules ─

test('CP16. writer_interface_version + canary_only + max_decisions_per_run exposed', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'owner-canary-z',
  });
  assert.equal(pf.canary_only, true);
  assert.equal(pf.max_decisions_per_run, 1);
  assert.equal(pf.writer_interface_version, 'v8p5.rpc1');
});

// ─── SKU 2944 review packet integrity ─

test('CP17. SKU 2944 Owner review packet ships owner_confirmed=false · auto flags false · REQUIRED placeholders', () => {
  const p = path.resolve(__dirname, '../../docs/phase-8p6-sku-2944-owner-review-packet.json');
  assert.ok(fs.existsSync(p));
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(raw.canary_only, true);
  assert.equal(raw.decision.owner_confirmed, false);
  assert.equal(raw.decision.auto_create_allowed, false);
  assert.equal(raw.decision.auto_link_allowed, false);
  assert.equal(raw.decision.persisted, false);
  //   Every <REQUIRED> placeholder still present (Claude did not fill them)
  const s = JSON.stringify(raw);
  assert.ok(s.includes('<REQUIRED'), 'REQUIRED placeholders must remain unfilled · Owner must complete');
  //   Confirmed SKU cohort = [2944] only (no auto expansion)
  assert.deepEqual(raw.decision.confirmed_sku_master_ids, [2944]);
  assert.equal(raw.decision.target_physical_product_id, null);
});

// ─── Staging checklist doc exists · content sanity ─

test('CP18. Staging environment checklist doc exists · lists REVOKE PUBLIC + append-only trigger verification steps', () => {
  const p = path.resolve(__dirname, '../../docs/phase-8p6-staging-environment-checklist.md');
  assert.ok(fs.existsSync(p));
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /staging URL ≠ production URL/i);
  assert.match(src, /REVOKE succeeded/i);
  assert.match(src, /append-only triggers exist/i);
  assert.match(src, /Owner approves production migration 095 apply/);
});

// ─── Preflight source safety ─

test('CP19. Preflight service source has NO DB write / marketplace / notification / RPC call', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalCanonicalWriterPreflight.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(stripped, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/);
  assert.doesNotMatch(stripped, /\.rpc\s*\(/);
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i);
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:notify|telegram|imessage)/i);
});

test('CP20. Preflight CLI rejects apply-shaped flags · exit code 3', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-canary-preflight-sku-2944.js'), 'utf8');
  //   Confirm the guard regex is present
  assert.match(src, /if \(\/\^--\(apply\|commit\|execute\|force\|do-it\|run\)/);
  //   No DB client
  assert.doesNotMatch(src, /getClient\s*\(/);
  //   No RPC
  assert.doesNotMatch(src, /\.rpc\s*\(/);
});

// ─── BP_INVARIANT constant echo ─

test('CP21. Preflight surfaces BP_INVARIANT constant verbatim · [2194, 3120] · physical#1', () => {
  const pf = buildCanaryPreflight({
    decision: createDecision(), candidateContext: candidate(),
    ownerConfirmationId: 'owner-canary-check',
  });
  assert.equal(pf.bp_invariant_status.physical_product_id, 1);
  assert.deepEqual(pf.bp_invariant_status.locked_sku_master_ids.slice().sort(), [2194, 3120]);
});

// ─── Canary CLI enforces 1-decision limit ─

test('CP22. Preflight CLI multi-decision input rejected · exit code 4 pattern in source', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-canary-preflight-sku-2944.js'), 'utf8');
  assert.match(src, /canary preflight allows exactly 1 decision/);
  assert.match(src, /process\.exit\(4\)/);
});

// ─── Owner Top-5 draft still has SKU 2944 as rank 1 ─

test('CP23. Owner Top-5 payload draft (from 8P-5) still has SKU 2944 as rank 1 · consistency across phases', () => {
  const p = path.resolve(__dirname, '../../docs/phase-8p5-owner-top5-payload-draft.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rank1 = raw.top_5_candidates.find(c => c.rank === 1);
  assert.ok(rank1);
  assert.equal(rank1.sku_master_id, 2944);
});
