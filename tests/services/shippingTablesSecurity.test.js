'use strict';

/**
 * tests/services/shippingTablesSecurity.test.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Owner directive (security hardening §2 · §4):
 *   Migration 116 must enable RLS on every new shipping table AND revoke
 *   anon/authenticated grants on both the tables and their sequences.
 *
 * This is a structural test — the runtime effect against Supabase is
 * separately verified by the anon-HTTP probe run against production
 * after `apply_migration`.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const MIG  = path.join(REPO, 'supabase/migrations/116_shipping_tables_security.sql');

const TABLES = [
  'shipping_rate_versions',
  'shipping_services',
  'shipping_countries',
  'shipping_rate_brackets',
  'shipping_surcharges',
  'shipping_policy_bands',
  'shipping_quote_shadow_results',
];

test('SEC-A · migration 116 file exists', () => {
  assert.ok(fs.existsSync(MIG), 'supabase/migrations/116_shipping_tables_security.sql must exist');
});

test('SEC-B · every shipping table has ENABLE ROW LEVEL SECURITY', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  for (const t of TABLES) {
    const re = new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security\\s*;`, 'i');
    assert.ok(re.test(sql), `${t}: enable row level security statement missing`);
  }
});

test('SEC-C · every shipping table has REVOKE ALL FROM anon, authenticated', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  for (const t of TABLES) {
    const re = new RegExp(`revoke\\s+all\\s+privileges\\s+on\\s+table\\s+public\\.${t}\\s+from\\s+anon,\\s*authenticated\\s*;`, 'i');
    assert.ok(re.test(sql), `${t}: REVOKE ALL from anon, authenticated missing`);
  }
});

test('SEC-D · every backing sequence has REVOKE ALL FROM anon, authenticated', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  for (const t of TABLES) {
    const re = new RegExp(`revoke\\s+all\\s+privileges\\s+on\\s+sequence\\s+public\\.${t}_id_seq\\s+from\\s+anon,\\s*authenticated\\s*;`, 'i');
    assert.ok(re.test(sql), `${t}_id_seq: REVOKE ALL from anon, authenticated missing`);
  }
});

test('SEC-E · migration does NOT touch other tables (contains no OTHER table names)', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  //   Any `alter table public.<name>` MUST match our 7 tables.
  const alterMatches = [...sql.matchAll(/alter\s+table\s+public\.(\w+)/gi)].map(m => m[1].toLowerCase());
  for (const name of alterMatches) {
    assert.ok(TABLES.includes(name), `unexpected ALTER TABLE public.${name} — out of scope`);
  }
  //   Any `revoke ... on table public.<name>` MUST match our 7 tables.
  const revokeMatches = [...sql.matchAll(/on\s+table\s+public\.(\w+)/gi)].map(m => m[1].toLowerCase());
  for (const name of revokeMatches) {
    assert.ok(TABLES.includes(name), `unexpected REVOKE ON TABLE public.${name} — out of scope`);
  }
  //   Any `revoke ... on sequence public.<name>` MUST match our 7 _id_seq names.
  const seqMatches = [...sql.matchAll(/on\s+sequence\s+public\.(\w+)/gi)].map(m => m[1].toLowerCase());
  for (const name of seqMatches) {
    const base = name.replace(/_id_seq$/, '');
    assert.ok(TABLES.includes(base), `unexpected REVOKE ON SEQUENCE public.${name} — out of scope`);
  }
});

test('SEC-F · migration does NOT create client-facing policies', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  //   Deliberately no CREATE POLICY — the tables become inaccessible to
  //   anon/authenticated (both grant-level and RLS-level).
  assert.ok(!/create\s+policy/i.test(sql),
    'migration MUST NOT create RLS policies for anon/authenticated');
});

test('SEC-G · migration does NOT grant anything to anon/authenticated', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  //   The whole point is to lock these down. Any GRANT to anon/authenticated
  //   would defeat the purpose.
  assert.ok(!/grant\s+.+\s+to\s+(anon|authenticated)/i.test(sql),
    'migration MUST NOT grant privileges back to anon/authenticated');
});

test('SEC-H · migration does NOT REVOKE from service_role (backend must keep working)', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  assert.ok(!/revoke\s+.+\s+from\s+.*service_role/i.test(sql),
    'migration MUST NOT revoke privileges from service_role');
});

test('SEC-I · exactly 7 tables and 7 sequences targeted (no more, no fewer)', () => {
  const sql = fs.readFileSync(MIG, 'utf8');
  const enableRls   = (sql.match(/enable\s+row\s+level\s+security/gi)  || []).length;
  const tableRevoke = (sql.match(/revoke\s+all\s+privileges\s+on\s+table/gi)   || []).length;
  const seqRevoke   = (sql.match(/revoke\s+all\s+privileges\s+on\s+sequence/gi)|| []).length;
  assert.equal(enableRls,   7, `expected 7 enable-RLS lines; got ${enableRls}`);
  assert.equal(tableRevoke, 7, `expected 7 table REVOKE lines; got ${tableRevoke}`);
  assert.equal(seqRevoke,   7, `expected 7 sequence REVOKE lines; got ${seqRevoke}`);
});
