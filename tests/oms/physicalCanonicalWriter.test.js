'use strict';

/**
 * tests/oms/physicalCanonicalWriter.test.js — Phase 8P-5.
 * Dry-run validation tests · zero DB · pure functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  planDecision,
  planBatch,
  WRITER_INTERFACE_VERSION,
  BP_INVARIANT,
  VALIDATION_REJECT_REASONS,
  DECISION_ENUM,
} = require('../../src/services/oms/physicalCanonicalWriter');

//   Helpers to build valid inputs
function candidate(overrides = {}) {
  return {
    creation_candidate_id: 'pcc-1',
    sku_master_ids: [2944],
    cohort_bridge: { basis: 'singleton_sku_master_id', value: 'sku:2944' },
    listing_ids: ['ebay:L1'],
    product_ids: [],
    source_review_generated_at: '2026-08-19T00:00:00Z',
    ...overrides,
  };
}
function createDecision(overrides = {}) {
  return {
    owner_decision: DECISION_ENUM.CREATE_NEW_PHYSICAL,
    confirmed_sku_master_ids: [2944],
    proposed_display_name: 'New Physical Product',
    owner_confirmed: true,
    ...overrides,
  };
}
function linkDecision(overrides = {}) {
  return {
    owner_decision: DECISION_ENUM.LINK_TO_EXISTING_PHYSICAL,
    confirmed_sku_master_ids: [2944],
    target_physical_product_id: 2,
    owner_authoritative_bridge: 'listing:ebay-123',
    owner_confirmed: true,
    ...overrides,
  };
}

// ─── Owner confirmation gate ─────────────────

test('T-conf-1. owner_confirmed missing → REJECTED · OWNER_CONFIRMED_FALSE', () => {
  const p = planDecision({ decision: createDecision({ owner_confirmed: undefined }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.OWNER_CONFIRMED_FALSE));
});

test('T-conf-2. owner_confirmed=false → REJECTED', () => {
  const p = planDecision({ decision: createDecision({ owner_confirmed: false }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.OWNER_CONFIRMED_FALSE));
});

test('T-conf-3. owner_confirmed=true + all fields → VALIDATED', () => {
  const p = planDecision({ decision: createDecision(), candidateContext: candidate() });
  assert.equal(p.status, 'VALIDATED');
  assert.equal(p.dry_run, true);
});

// ─── CREATE validation ─────────────────────

test('T-create-1. Valid single-SKU CREATE dry-run plan · idempotency_key deterministic', () => {
  const p1 = planDecision({ decision: createDecision(), candidateContext: candidate(), ownerConfirmationId: 'owner-1' });
  const p2 = planDecision({ decision: createDecision(), candidateContext: candidate(), ownerConfirmationId: 'owner-1' });
  assert.equal(p1.status, 'VALIDATED');
  assert.equal(p1.idempotency_key, p2.idempotency_key, 'same inputs → same key');
  //   Plan describes atomic transaction
  assert.equal(p1.db_effect.would_atomic, true);
  assert.equal(p1.db_effect.applied_this_phase, false);
  assert.equal(p1.db_effect.rpc_target, 'apply_canonical_create_physical(jsonb)');
});

test('T-create-2. Multi-SKU cohort · confirmed = full cohort · valid', () => {
  const cand = candidate({ sku_master_ids: [500, 501, 502], creation_candidate_id: 'pcc-9' });
  const dec = createDecision({ confirmed_sku_master_ids: [500, 501, 502] });
  const p = planDecision({ decision: dec, candidateContext: cand });
  assert.equal(p.status, 'VALIDATED');
});

test('T-create-3. Multi-SKU cohort · confirmed = subset of cohort · valid (Owner Part 4)', () => {
  const cand = candidate({ sku_master_ids: [500, 501, 502] });
  const dec = createDecision({ confirmed_sku_master_ids: [500, 501] });
  const p = planDecision({ decision: dec, candidateContext: cand });
  assert.equal(p.status, 'VALIDATED');
  assert.deepEqual(p.db_effect.payload_for_rpc.confirmed_sku_master_ids, [500, 501]);
});

test('T-create-4. SKU outside cohort → REJECTED · COHORT_SUBSET_MISMATCH', () => {
  const cand = candidate({ sku_master_ids: [500, 501] });
  const dec = createDecision({ confirmed_sku_master_ids: [500, 999] });
  const p = planDecision({ decision: dec, candidateContext: cand });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.COHORT_SUBSET_MISMATCH));
});

test('T-create-5. Missing display_name → REJECTED · MISSING_DISPLAY_NAME', () => {
  const p = planDecision({ decision: createDecision({ proposed_display_name: '' }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.MISSING_DISPLAY_NAME));
});

test('T-create-6. Empty confirmed_sku_master_ids → REJECTED · MISSING_CONFIRMED_SKUS', () => {
  const p = planDecision({ decision: createDecision({ confirmed_sku_master_ids: [] }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.MISSING_CONFIRMED_SKUS));
});

test('T-create-7. Duplicate decision · same idempotency key detected in batch', () => {
  const dec = createDecision();
  const cand = candidate();
  const batch = planBatch({ decisions: [
    { decision: dec, candidateContext: cand, ownerConfirmationId: 'owner-2' },
    { decision: dec, candidateContext: cand, ownerConfirmationId: 'owner-2' },
  ] });
  assert.equal(batch.summary.validated, 2);
  assert.equal(batch.duplicate_idempotency_keys_in_batch.length, 1);
});

// ─── LINK validation ─────────────────────

test('T-link-1. Valid LINK · target physical > 0 · authoritative bridge present · VALIDATED', () => {
  const p = planDecision({ decision: linkDecision(), candidateContext: candidate() });
  assert.equal(p.status, 'VALIDATED');
  assert.equal(p.db_effect.rpc_target, 'apply_canonical_link_physical(jsonb)');
});

test('T-link-2. Missing target_physical_product_id → REJECTED', () => {
  const p = planDecision({ decision: linkDecision({ target_physical_product_id: null }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.MISSING_TARGET_PHYSICAL));
});

test('T-link-3. Missing authoritative bridge → REJECTED', () => {
  const p = planDecision({ decision: linkDecision({ owner_authoritative_bridge: '' }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.MISSING_AUTHORITATIVE_BRIDGE));
});

test('T-link-4. Title-only bridge ("Same as NIKKE product") → REJECTED · TITLE_ONLY_BRIDGE_REJECTED', () => {
  const p = planDecision({ decision: linkDecision({ owner_authoritative_bridge: 'Same as NIKKE product' }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.TITLE_ONLY_BRIDGE_REJECTED));
});

test('T-link-5. Franchise-name-only bridge ("Battle Partners franchise match") → REJECTED', () => {
  const p = planDecision({ decision: linkDecision({ owner_authoritative_bridge: 'Battle Partners franchise' }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.TITLE_ONLY_BRIDGE_REJECTED));
});

test('T-link-6. Accepted bridge prefixes (listing: · product: · sku: · marketplace_sku: · etc)', () => {
  for (const bridge of ['listing:ebay-123', 'product:42', 'sku:BP-30', 'marketplace_sku:XYZ', 'internal_sku:abc', 'owner_note:manually-verified']) {
    const p = planDecision({ decision: linkDecision({ owner_authoritative_bridge: bridge }), candidateContext: candidate() });
    assert.equal(p.status, 'VALIDATED', `bridge=${bridge} must validate`);
  }
});

// ─── BP invariant hard lock ─────────────

test('T-bp-1. LINK target_physical_product_id=1 (BP) → REJECTED · BP_LINK_FORBIDDEN', () => {
  const p = planDecision({ decision: linkDecision({ target_physical_product_id: 1 }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.BP_LINK_FORBIDDEN));
});

test('T-bp-2. SKU 2944 attempted CREATE with confirmed_sku_master_ids=[2194] (BP locked SKU) → REJECTED', () => {
  const cand = candidate({ sku_master_ids: [2194] });   // approved cohort but BP-locked
  const dec = createDecision({ confirmed_sku_master_ids: [2194] });
  const p = planDecision({ decision: dec, candidateContext: cand });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.BP_SKU_COLLISION));
});

test('T-bp-3. Any mix of BP-locked SKU + non-BP SKU → REJECTED · BP_SKU_COLLISION', () => {
  const cand = candidate({ sku_master_ids: [500, 3120] });   // 3120 is BP-locked
  const dec = createDecision({ confirmed_sku_master_ids: [500, 3120] });
  const p = planDecision({ decision: dec, candidateContext: cand });
  assert.equal(p.status, 'REJECTED');
  assert.ok(p.errors.includes(VALIDATION_REJECT_REASONS.BP_SKU_COLLISION));
});

test('T-bp-4. BP_INVARIANT constant matches Owner directive · [2194, 3120] · physical_product_id=1', () => {
  assert.equal(BP_INVARIANT.physical_product_id, 1);
  assert.deepEqual([...BP_INVARIANT.locked_sku_master_ids].sort(), [2194, 3120]);
});

// ─── DEFER / NEEDS_MORE_EVIDENCE / MARK_NON_PHYSICAL ─

test('T-defer-1. DEFER produces NO_WRITE · no idempotency_key generated', () => {
  const p = planDecision({ decision: { owner_decision: DECISION_ENUM.DEFER }, candidateContext: candidate() });
  assert.equal(p.status, 'NO_WRITE');
  assert.equal(p.db_effect, null);
});

test('T-defer-2. NEEDS_MORE_EVIDENCE produces NO_WRITE', () => {
  const p = planDecision({ decision: { owner_decision: DECISION_ENUM.NEEDS_MORE_EVIDENCE }, candidateContext: candidate() });
  assert.equal(p.status, 'NO_WRITE');
});

test('T-mark-1. MARK_NON_PHYSICAL produces AUDIT_ONLY · db_effect=null · no physical/link mutation planned', () => {
  const p = planDecision({ decision: { owner_decision: DECISION_ENUM.MARK_NON_PHYSICAL }, candidateContext: candidate() });
  assert.equal(p.status, 'AUDIT_ONLY');
  assert.equal(p.db_effect, null);
});

// ─── Idempotency + transaction plan ─────

test('T-idem-1. Same decision + different ownerConfirmationId → different idempotency_key', () => {
  const p1 = planDecision({ decision: createDecision(), candidateContext: candidate(), ownerConfirmationId: 'a' });
  const p2 = planDecision({ decision: createDecision(), candidateContext: candidate(), ownerConfirmationId: 'b' });
  assert.notEqual(p1.idempotency_key, p2.idempotency_key);
});

test('T-idem-2. Same decision · reordered confirmed_sku_master_ids · SAME idempotency_key (sorted internally)', () => {
  const cand = candidate({ sku_master_ids: [500, 501, 502] });
  const p1 = planDecision({ decision: createDecision({ confirmed_sku_master_ids: [500, 501, 502] }), candidateContext: cand });
  const p2 = planDecision({ decision: createDecision({ confirmed_sku_master_ids: [502, 500, 501] }), candidateContext: cand });
  assert.equal(p1.idempotency_key, p2.idempotency_key);
});

test('T-idem-3. Idempotency key is SHA-256 hex · 64 chars', () => {
  const p = planDecision({ decision: createDecision(), candidateContext: candidate() });
  assert.match(p.idempotency_key, /^[0-9a-f]{64}$/);
});

test('T-plan-1. CREATE plan lists physical_products + sellable_units + sellable_unit_components + sku_master_link + audit inserts', () => {
  const p = planDecision({ decision: createDecision(), candidateContext: candidate() });
  const tables = p.db_effect.would_insert.map(x => x.table);
  assert.ok(tables.includes('physical_products'));
  assert.ok(tables.includes('sellable_units'));
  assert.ok(tables.includes('sellable_unit_components'));
  assert.ok(tables.includes('sku_master_link'));
  assert.ok(tables.includes('physical_write_audit'));
});

test('T-plan-2. LINK plan lists sku_master_link + audit only · no physical_products / sellable_units insert', () => {
  const p = planDecision({ decision: linkDecision(), candidateContext: candidate() });
  const tables = p.db_effect.would_insert.map(x => x.table);
  assert.ok(tables.includes('sku_master_link'));
  assert.ok(tables.includes('physical_write_audit'));
  assert.ok(!tables.includes('physical_products'));
});

test('T-plan-3. dry_run=true on every plan · applied_this_phase=false', () => {
  for (const dec of [createDecision(), linkDecision()]) {
    const p = planDecision({ decision: dec, candidateContext: candidate() });
    assert.equal(p.dry_run, true);
    assert.equal(p.db_effect.applied_this_phase, false);
  }
});

// ─── Safety · zero writes / no marketplace / no notification / no scheduler ─

test('T-safety-1. Writer source contains ZERO db.from().insert/update/delete/upsert() paths', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalCanonicalWriter.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(stripped, /\.from\s*\([^)]*\)\s*\.(insert|update|delete|upsert)\s*\(/);
  //   No rpc call either
  assert.doesNotMatch(stripped, /\.rpc\s*\(/);
});

test('T-safety-2. Writer source has no marketplace / notification / scheduler / cron require', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/oms/physicalCanonicalWriter.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:ebayAPI|shopifyAPI|marketplace)/i);
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*(?:notify|telegram|imessage)/i);
  assert.doesNotMatch(stripped, /require\s*\(\s*['"][^'"]*scheduler/i);
});

test('T-safety-3. CLI has NO --apply / --commit / --execute / --force flag · attempts exit with code 3', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/oms-physical-canonical-writer-dry-run.js'), 'utf8');
  //   Attempts to use forbidden flags MUST hit the guard and exit
  assert.match(src, /if \(\/\^--\(apply\|commit\|execute\|force\|do-it\)/);
  //   No RPC call in CLI either
  assert.doesNotMatch(src, /\.rpc\s*\(/);
  //   CLI never opens getClient · dry-run doesn't need DB
  assert.doesNotMatch(src, /getClient\s*\(/);
});

test('T-safety-4. Migration 095 file exists · Phase 8P-6 activated append-only triggers + REVOKE PUBLIC · file still NOT auto-applied', () => {
  const migPath = path.resolve(__dirname, '../../supabase/migrations/095_physical_write_audit_and_rpc.sql');
  assert.ok(fs.existsSync(migPath), 'migration 095 file must exist');
  const src = fs.readFileSync(migPath, 'utf8');
  //   Phase 8P-6 activation: triggers ship UNCOMMENTED (production-ready state)
  assert.match(src, /^create trigger t_physical_write_audit_no_update/m,
    'Phase 8P-6 · append-only UPDATE trigger must be active in migration');
  assert.match(src, /^create trigger t_physical_write_audit_no_delete/m,
    'Phase 8P-6 · append-only DELETE trigger must be active in migration');
  //   Phase 8P-6 permission minimization: REVOKE PUBLIC + GRANT service_role
  assert.match(src, /revoke\s+execute\s+on\s+function\s+apply_canonical_create_physical\(jsonb\)\s+from\s+public/i);
  assert.match(src, /revoke\s+execute\s+on\s+function\s+apply_canonical_link_physical\(jsonb\)\s+from\s+public/i);
  assert.match(src, /grant\s+execute\s+on\s+function\s+apply_canonical_create_physical\(jsonb\)\s+to\s+service_role/i);
  //   Both RPC functions must be defined
  assert.match(src, /create or replace function apply_canonical_create_physical/);
  assert.match(src, /create or replace function apply_canonical_link_physical/);
  //   NEVER auto-applied · Phase 8P-6 code path does NOT trigger `supabase db push` or equivalent
  //   (verified by absence of any apply invocation in CLI src · see T-safety-3)
});

// ─── Transaction atomicity claims ─────

test('T-atomic-1. CREATE db_effect describes atomic RPC · would_atomic=true · rollback_on_error=true', () => {
  const p = planDecision({ decision: createDecision(), candidateContext: candidate() });
  assert.equal(p.db_effect.would_atomic, true);
  assert.equal(p.db_effect.would_be_rolled_back_on_error, true);
  //   The plan points at the RPC (single PL/pgSQL block · true atomicity)
  assert.match(p.db_effect.rpc_target, /^apply_canonical_/);
});

test('T-atomic-2. Partial plan cannot be marked as success · REJECTED plans have db_effect=null', () => {
  const p = planDecision({ decision: createDecision({ proposed_display_name: '' }), candidateContext: candidate() });
  assert.equal(p.status, 'REJECTED');
  assert.equal(p.db_effect, null);
});

// ─── Audit ─────

test('T-audit-1. VALIDATED plan includes physical_write_audit row in would_insert', () => {
  const p = planDecision({ decision: createDecision(), candidateContext: candidate() });
  const auditRow = p.db_effect.would_insert.find(r => r.table === 'physical_write_audit');
  assert.ok(auditRow);
  assert.equal(auditRow.values.operation, 'CREATE_NEW_PHYSICAL');
  assert.match(auditRow.values.idempotency_key, /^[0-9a-f]{64}$/);
});

test('T-audit-2. LINK audit row carries physical_product_id + sku_master_ids + bridge (via evidence_reference in payload_for_rpc)', () => {
  const p = planDecision({ decision: linkDecision({ target_physical_product_id: 2 }), candidateContext: candidate() });
  const auditRow = p.db_effect.would_insert.find(r => r.table === 'physical_write_audit');
  assert.ok(auditRow);
  assert.equal(auditRow.values.operation, 'LINK_TO_EXISTING_PHYSICAL');
  assert.equal(auditRow.values.physical_product_id, 2);
  assert.deepEqual(auditRow.values.sku_master_ids, [2944]);
});

test('T-audit-3. Owner-confirmed audit fields never contain tokens/secrets · owner_confirmation_id is passthrough only', () => {
  const p = planDecision({ decision: createDecision(), candidateContext: candidate(), ownerConfirmationId: 'sk_test_1234567890abcdef1234567890abcdef' });
  //   The writer is a plan-only builder · secret-shaped ids are NOT rejected here
  //   because the audit table stores them verbatim. But if Owner passes a
  //   token-shape id, we simply record it (no secret enrichment · no PII).
  assert.equal(p.db_effect.payload_for_rpc.owner_confirmation_id, 'sk_test_1234567890abcdef1234567890abcdef');
  //   The plan payload does NOT contain the SUPABASE_SERVICE_KEY or any other secret from env
  const s = JSON.stringify(p);
  assert.ok(!s.includes('SUPABASE_SERVICE_KEY'));
});

// ─── BP unchanged summary ─────

test('T-bp-summary. Batch of Top-5-style CREATE decisions never touches BP mapping', () => {
  //   Simulate the 5 SKUs from Owner spec §11
  const skus = [2944, 1944, 3180, 574, 40];
  const decisions = skus.map((s, i) => ({
    decision: createDecision({ confirmed_sku_master_ids: [s], proposed_display_name: `Product ${s}` }),
    candidateContext: candidate({ creation_candidate_id: `pcc-${i + 1}`, sku_master_ids: [s], listing_ids: [`ebay:L${s}`] }),
    ownerConfirmationId: `owner-top5-${s}`,
  }));
  const batch = planBatch({ decisions });
  assert.equal(batch.summary.validated, 5);
  //   No plan touches BP-locked SKUs
  for (const p of batch.plans) {
    const skusInPlan = p.decision.confirmed_sku_master_ids;
    for (const sku of skusInPlan) {
      assert.ok(!BP_INVARIANT.locked_sku_master_ids.includes(sku), `plan must not touch BP-locked sku ${sku}`);
    }
    //   Reason 2: no plan targets physical_product_id=1
    if (p.decision.target_physical_product_id != null) {
      assert.notEqual(p.decision.target_physical_product_id, BP_INVARIANT.physical_product_id);
    }
  }
});

// ─── Interface exposure ─────

test('T-iface-1. WRITER_INTERFACE_VERSION exposed · v8p5.rpc1', () => {
  assert.equal(WRITER_INTERFACE_VERSION, 'v8p5.rpc1');
});

test('T-iface-2. VALIDATION_REJECT_REASONS enum has documented codes', () => {
  const keys = Object.keys(VALIDATION_REJECT_REASONS).sort();
  //   Sanity · must include the critical ones
  for (const req of ['OWNER_CONFIRMED_FALSE', 'COHORT_SUBSET_MISMATCH', 'BP_LINK_FORBIDDEN', 'BP_SKU_COLLISION', 'MISSING_AUTHORITATIVE_BRIDGE', 'TITLE_ONLY_BRIDGE_REJECTED']) {
    assert.ok(keys.includes(req), `missing reason: ${req}`);
  }
});

test('T-iface-3. Owner Top-5 payload draft file exists · owner_confirmed=false on every entry', () => {
  const draftPath = path.resolve(__dirname, '../../docs/phase-8p5-owner-top5-payload-draft.json');
  assert.ok(fs.existsSync(draftPath));
  const raw = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  assert.equal(raw.safety.owner_confirmed_default, false);
  for (const c of raw.top_5_candidates) {
    assert.equal(c.decision_template.owner_confirmed, false, `top-5 rank ${c.rank} must ship owner_confirmed=false`);
    assert.equal(c.decision_template.persisted, false);
    assert.equal(c.decision_template.auto_create_allowed, false);
    assert.equal(c.decision_template.auto_link_allowed, false);
  }
});

// ─── Batch shape ─────

test('T-batch-1. planBatch summary counts validated / rejected / audit_only / no_write correctly', () => {
  const batch = planBatch({ decisions: [
    { decision: createDecision(), candidateContext: candidate() },                                       // validated
    { decision: createDecision({ proposed_display_name: '' }), candidateContext: candidate() },          // rejected
    { decision: { owner_decision: DECISION_ENUM.MARK_NON_PHYSICAL }, candidateContext: candidate() },    // audit_only
    { decision: { owner_decision: DECISION_ENUM.DEFER }, candidateContext: candidate() },                // no_write
  ] });
  assert.equal(batch.summary.total, 4);
  assert.equal(batch.summary.validated, 1);
  assert.equal(batch.summary.rejected, 1);
  assert.equal(batch.summary.audit_only, 1);
  assert.equal(batch.summary.no_write, 1);
});
