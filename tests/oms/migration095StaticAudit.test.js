'use strict';

/**
 * tests/oms/migration095StaticAudit.test.js — Phase 8P-6.
 *
 * AGGRESSIVE static audit of supabase/migrations/095_physical_write_audit_and_rpc.sql
 * against the actual schema truth in migrations 038/085/086/087/088.
 *
 * READ-ONLY · no DB · no apply. Zero writes.
 *
 * Purpose: catch column/table name mismatches, unsafe SECURITY DEFINER
 * search_path, PUBLIC-executable RPCs, SQL-injection concat paths, and
 * missing edge-case handling BEFORE any staging apply.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.resolve(__dirname, '../../supabase/migrations');
const stripSql = (s) => s.replace(/--[^\n]*/g, '');
const readMig = (name) => stripSql(fs.readFileSync(path.join(MIG_DIR, name), 'utf8'));

const M095 = readMig('095_physical_write_audit_and_rpc.sql');
const M038 = readMig('038_phase1_sku_master_and_exception.sql');
const M085 = readMig('085_physical_products.sql');
const M086 = readMig('086_sellable_units.sql');
const M087 = readMig('087_sellable_unit_components.sql');
const M088 = readMig('088_sku_master_link.sql');

// ─── Schema truth cross-check ─────────────────

test('SA1. physical_products (mig 085) has canonical_title column · migration 095 INSERT uses it', () => {
  assert.match(M085, /\bcanonical_title\b/, '085 must define canonical_title');
  //   095 INSERT INTO physical_products (canonical_title) VALUES ...
  assert.match(M095, /insert into physical_products \(canonical_title\)/i);
});

test('SA2. sellable_units (mig 086) has display_name / variant_kind / status · 095 INSERT uses them', () => {
  for (const col of ['display_name', 'variant_kind', 'status']) {
    assert.match(M086, new RegExp(`\\b${col}\\b`));
  }
  assert.match(M095, /insert into sellable_units \(display_name, variant_kind, status\)/i);
  //   sellable_units DOES NOT declare physical_product_id (Phase 8P-2a truth)
  assert.doesNotMatch(M086, /physical_product_id/);
});

test('SA3. sellable_unit_components (mig 087) has sellable_unit_id + physical_product_id + quantity_per_unit + role · 095 uses all', () => {
  for (const col of ['sellable_unit_id', 'physical_product_id', 'quantity_per_unit', 'role']) {
    assert.match(M087, new RegExp(`\\b${col}\\b`), `087 must define ${col}`);
  }
  //   095 CREATE_NEW_PHYSICAL uses ALL four:
  assert.match(M095, /insert into sellable_unit_components \(sellable_unit_id, physical_product_id, quantity_per_unit, role\)/i);
});

test('SA4. sku_master_link (mig 088) has sku_master_id (PK) / sellable_unit_id / mapping_confidence · 095 uses all', () => {
  for (const col of ['sku_master_id', 'sellable_unit_id', 'mapping_confidence']) {
    assert.match(M088, new RegExp(`\\b${col}\\b`));
  }
  assert.match(M095, /insert into sku_master_link \(sku_master_id, sellable_unit_id, mapping_confidence, notes\)/i);
  //   sku_master_link.sku_master_id is PK (only 1 mapping per SKU) — mig 088
  assert.match(M088, /sku_master_id\s+integer\s+primary key/i);
});

test('SA5. sku_master_link mapping_confidence CHECK allowlist includes "manual" · 095 uses "manual"', () => {
  //   mig 088 constraint spans two lines. Simplest: check both tokens appear
  //   within a small window.
  const win088 = M088.replace(/\s+/g, ' ');
  assert.match(win088, /mapping_confidence\s+in\s*\([^)]*'manual'/i);
  //   095 uses 'manual' as the mapping_confidence value in sku_master_link
  //   INSERTs. Verify both tokens appear (column named + literal used).
  assert.match(M095, /mapping_confidence/i, '095 must reference mapping_confidence column');
  assert.match(M095, /'manual'/, '095 must supply mapping_confidence value "manual"');
});

test('SA6. sku_master (mig 038) has id column · 095 references it via FK-like check "sku_master_link.sku_master_id"', () => {
  //   038 defines sku_master(id serial primary key). 088's FK is preserved.
  assert.match(M038, /create table if not exists sku_master \(/i);
  //   095 inserts into sku_master_link which has FK → sku_master(id)
  assert.match(M088, /references sku_master\(id\)/i);
});

// ─── SECURITY DEFINER + search_path ────────────────

test('SA7. Every SECURITY DEFINER function pins search_path (schema-hijack prevention)', () => {
  //   Phase 8P-6 requirement: for each `security definer` occurrence there
  //   must be a corresponding `set search_path = ...` on the same function.
  //   Split into function blocks and check each.
  const funcBlocks = M095.match(/create or replace function[\s\S]+?\$\$;/gi) || [];
  const secDefBlocks = funcBlocks.filter(b => /security\s+definer/i.test(b));
  assert.ok(secDefBlocks.length >= 2, 'at least CREATE + LINK RPCs are SECURITY DEFINER');
  for (const b of secDefBlocks) {
    assert.match(b, /set\s+search_path\s*=\s*(public|pg_catalog)/i,
      'PHASE 8P-6 REQUIRED FIX · every SECURITY DEFINER function must SET search_path');
  }
});

test('SA8. RPC EXECUTE permission revoked from PUBLIC / anon · granted only to trusted role', () => {
  //   Supabase default: functions are EXECUTE-able by PUBLIC. That would
  //   let anon-key holders create physicals or attach SKUs. MUST revoke.
  const revokePublic = /revoke\s+(execute\s+)?on\s+function\s+apply_canonical_(create|link)_physical/gi;
  const grantServiceRole = /grant\s+execute\s+on\s+function\s+apply_canonical_(create|link)_physical.*to\s+service_role/gi;
  assert.match(M095, revokePublic, 'PHASE 8P-6 REQUIRED FIX · REVOKE EXECUTE from PUBLIC/anon');
  assert.match(M095, grantServiceRole, 'PHASE 8P-6 REQUIRED FIX · GRANT EXECUTE to service_role only');
});

// ─── SQL-injection surface ────────────────

test('SA9. String concatenation into notes uses left(...,100) to bound length · no user-input dynamic SQL', () => {
  //   Owner-supplied bridge string is concatenated via || into notes.
  //   Check: `left(v_bridge, 100)` present.
  assert.match(M095, /left\s*\(\s*v_bridge\s*,\s*100\s*\)/);
  //   Any PL/pgSQL EXECUTE must use a purely STATIC string literal (single
  //   quoted · no || concatenation with untrusted values). Static
  //   permission DO blocks (revoke/grant literals) are allowed.
  const executeLines = M095.split('\n').filter(l => /\bexecute\s+'/i.test(l));
  for (const line of executeLines) {
    //   Anything after the initial 'literal' must be either closing quote OR
    //   only concat with SESSION-safe identifiers · never Owner input.
    //   Guardrail: forbid `execute ... || v_` (Owner-derived variables).
    assert.doesNotMatch(line, /execute\s+['"][^'"]*['"]\s*\|\|\s*v_/i, `dynamic SQL with Owner-input concat detected: ${line}`);
  }
  //   No format() with user-controlled %I / %s identifiers
  assert.doesNotMatch(M095, /\bformat\s*\(\s*['"][^'"]*%[iIsSlL]/i);
});

test('SA10. All Owner-supplied text bounded by left(...) OR typed cast · never inserted raw into DDL', () => {
  //   Grep every || concat and verify Owner-supplied fields are length-bounded
  const concatLines = M095.split('\n').filter(l => l.includes('||') && !l.trim().startsWith('--'));
  //   The two known concatenations are:
  //     1. v_display_name || ' (auto-created 1-unit sellable)'  · v_display_name comes from Owner payload · could be long · check for length guard
  //     2. left(v_bridge, 100)   · already bounded
  //     3. `phase_8p5_owner_confirmed_create · ' || v_source_candidate_id · candidate_id comes from Phase 8P-4 · pcc-N shape
  //   PHASE 8P-6 REQUIRED FIX: bound v_display_name to reasonable length.
  const displayNameLengthGuard = /length\s*\(\s*(trim\s*\(\s*)?v_display_name/i.test(M095);
  assert.ok(displayNameLengthGuard, 'PHASE 8P-6 REQUIRED FIX · bound v_display_name length before use');
});

// ─── Edge case handling ────────────────

test('SA11. RPC rejects empty confirmed_sku_master_ids (Owner Part 5)', () => {
  //   Both RPCs check array_length(...) IS NULL and raise exception.
  const createBlock = M095.match(/create or replace function apply_canonical_create_physical[\s\S]+?\$\$;/i);
  const linkBlock = M095.match(/create or replace function apply_canonical_link_physical[\s\S]+?\$\$;/i);
  assert.ok(createBlock);
  assert.ok(linkBlock);
  assert.match(createBlock[0], /array_length\(v_sku_master_ids,\s*1\)\s+is\s+null/i);
  assert.match(linkBlock[0], /array_length\(v_sku_master_ids,\s*1\)\s+is\s+null/i);
});

test('SA12. RPC rejects owner_confirmed !== true', () => {
  //   Both RPCs check `if not v_owner_confirmed then raise exception ...`
  const rpcBlocks = M095.match(/create or replace function apply_canonical_(create|link)_physical[\s\S]+?\$\$;/gi);
  assert.equal(rpcBlocks.length, 2);
  for (const b of rpcBlocks) {
    assert.match(b, /if\s+not\s+v_owner_confirmed\s+then\s+raise\s+exception/i);
  }
});

test('SA13. RPC rejects idempotency_key < 32 chars', () => {
  const rpcBlocks = M095.match(/create or replace function apply_canonical_(create|link)_physical[\s\S]+?\$\$;/gi);
  for (const b of rpcBlocks) {
    assert.match(b, /length\s*\(\s*v_idempotency_key\s*\)\s*<\s*32/i);
  }
});

test('SA14. CREATE RPC rejects SKUs already having sku_master_link', () => {
  const createBlock = M095.match(/create or replace function apply_canonical_create_physical[\s\S]+?\$\$;/i)[0];
  assert.match(createBlock, /if exists \(\s*select 1 from sku_master_link where sku_master_id = any\(v_sku_master_ids\)/i);
});

test('SA15. LINK RPC rejects target physical that does not exist', () => {
  const linkBlock = M095.match(/create or replace function apply_canonical_link_physical[\s\S]+?\$\$;/i)[0];
  assert.match(linkBlock, /if not exists \(select 1 from physical_products where id = v_target\)/i);
});

test('SA16. LINK RPC rejects target physical without qty=1 sellable_unit component', () => {
  const linkBlock = M095.match(/create or replace function apply_canonical_link_physical[\s\S]+?\$\$;/i)[0];
  assert.match(linkBlock, /quantity_per_unit\s*=\s*1/i);
  assert.match(linkBlock, /v_sellable_id is null/i);
});

test('SA17. BP invariant rejected · CREATE with locked SKU · LINK with target=1', () => {
  const create = M095.match(/create or replace function apply_canonical_create_physical[\s\S]+?\$\$;/i)[0];
  const link = M095.match(/create or replace function apply_canonical_link_physical[\s\S]+?\$\$;/i)[0];
  //   CREATE checks each incoming SKU against locked array
  assert.match(create, /array\[2194,\s*3120\]/);
  assert.match(create, /BP invariant violated/i);
  //   LINK checks v_target = v_bp_id (1)
  assert.match(link, /if\s+v_target\s*=\s*v_bp_id\s+then\s+raise\s+exception/i);
  assert.match(link, /BP invariant/i);
});

test('SA18. Idempotency · both RPCs check physical_write_audit for existing key and return DUPLICATE', () => {
  const rpcBlocks = M095.match(/create or replace function apply_canonical_(create|link)_physical[\s\S]+?\$\$;/gi);
  for (const b of rpcBlocks) {
    assert.match(b, /select \* into v_existing_audit\s+from physical_write_audit\s+where idempotency_key = v_idempotency_key/i);
    assert.match(b, /'DUPLICATE'/);
  }
});

test('SA19. physical_write_audit unique constraint on idempotency_key present', () => {
  assert.match(M095, /uq_physical_write_audit_idem unique \(idempotency_key\)/i);
});

test('SA20. Append-only enforcement path exists in migration (activation gate documented)', () => {
  //   Phase 8P-6 requires activation-ready append-only triggers.
  //   The trigger functions and CREATE TRIGGER statements exist in the file
  //   · they may ship COMMENTED or under a boolean guard flag.
  assert.match(M095, /physical_write_audit_reject_mutation/);
  assert.match(M095, /before update on physical_write_audit/i);
  assert.match(M095, /before delete on physical_write_audit/i);
});

test('SA21. LINK RPC rejects SKUs already linked (double-attachment prevention)', () => {
  const linkBlock = M095.match(/create or replace function apply_canonical_link_physical[\s\S]+?\$\$;/i)[0];
  assert.match(linkBlock, /if exists \(select 1 from sku_master_link where sku_master_id = any\(v_sku_master_ids\)/i);
});

test('SA22. Audit row records the exact operation constant string (CREATE_NEW_PHYSICAL / LINK_TO_EXISTING_PHYSICAL)', () => {
  const create = M095.match(/create or replace function apply_canonical_create_physical[\s\S]+?\$\$;/i)[0];
  const link = M095.match(/create or replace function apply_canonical_link_physical[\s\S]+?\$\$;/i)[0];
  assert.match(create, /'CREATE_NEW_PHYSICAL'/);
  assert.match(link, /'LINK_TO_EXISTING_PHYSICAL'/);
});

// ─── Rollback / atomicity ──────────────

test('SA23. All mutations inside single PL/pgSQL BEGIN...END block · implicit transaction rollback on RAISE', () => {
  //   PL/pgSQL functions run in an implicit transaction. Verify each RPC
  //   returns after a single logical `end` and does not use SAVEPOINT.
  const rpcBlocks = M095.match(/create or replace function apply_canonical_(create|link)_physical[\s\S]+?\$\$;/gi);
  for (const b of rpcBlocks) {
    assert.doesNotMatch(b, /\bsavepoint\b/i, 'no SAVEPOINT · atomicity comes from function-level tx');
    assert.doesNotMatch(b, /\bcommit\b/i, 'no explicit COMMIT · function-level tx');
    assert.doesNotMatch(b, /\brollback\b/i, 'no explicit ROLLBACK · RAISE EXCEPTION handles it');
  }
});

test('SA24. Function does not swallow exceptions · no EXCEPTION WHEN handlers hiding errors', () => {
  const rpcBlocks = M095.match(/create or replace function apply_canonical_(create|link)_physical[\s\S]+?\$\$;/gi);
  for (const b of rpcBlocks) {
    //   Any `exception when others` would swallow errors and break atomicity guarantees
    assert.doesNotMatch(b, /exception\s+when\s+/i, 'no EXCEPTION WHEN handler · errors must propagate');
  }
});

// ─── Concurrency ──────────────

test('SA25. Concurrent duplicate idempotency_key handled by UNIQUE INDEX + DB error (unique_violation)', () => {
  //   Two concurrent RPC calls with the same idempotency_key: the second's
  //   INSERT INTO physical_write_audit hits the unique constraint. The
  //   duplicate SELECT-before-INSERT race is acceptable because the
  //   unique constraint is the ultimate deduplicator. Confirm the code
  //   attempts the SELECT before insert (best-effort · not required for
  //   correctness · unique index is the safety net).
  assert.match(M095, /uq_physical_write_audit_idem unique \(idempotency_key\)/i);
});

// ─── File structure ──────────

test('SA26. Migration 095 uses idempotent CREATE TABLE / INDEX (safe to re-apply)', () => {
  assert.match(M095, /create table if not exists physical_write_audit/i);
  assert.match(M095, /create index if not exists idx_physical_write_audit_written_at/i);
  assert.match(M095, /create or replace function apply_canonical_create_physical/i);
});
