#!/usr/bin/env node
/**
 * scripts/apply-109-recurring-expense-atomic.js — Apply migration 109
 * (Refactor R1-D1-B · Recurring expense DB-level idempotency + atomic RPC).
 *
 * Owner Directive 2026-09-05 · Refactor R1-D1-B.
 *
 * Migration 109 is fully additive:
 *   · CREATE UNIQUE INDEX IF NOT EXISTS expenses_recurring_occurrence_uniq
 *   · CREATE OR REPLACE FUNCTION fire_recurring_expense_atomic(...)
 *   · REVOKE/GRANT permission hardening (same pattern as 108)
 *
 * Zero effect on any existing expense row. No backfill · no cleanup.
 * Idempotent · safe to re-run. Pre-audit shows 0 existing duplicates.
 *
 * Usage:
 *   node scripts/apply-109-recurring-expense-atomic.js --dry-run   # print SQL only
 *   node scripts/apply-109-recurring-expense-atomic.js             # apply against DB
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '109_recurring_expense_atomic.sql';
const migrationsDir  = path.join(__dirname, '../supabase/migrations');
const fullPath       = path.join(migrationsDir, MIGRATION_FILE);

function resolveConnectionString() {
  const raw = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!raw) throw new Error('SUPABASE_DB_URL (or DATABASE_URL / POSTGRES_URL) required in config/.env');
  return raw;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(fullPath)) throw new Error(`Migration file not found: ${fullPath}`);
  const sql = fs.readFileSync(fullPath, 'utf8');
  console.log('='.repeat(78));
  console.log(`Migration: ${MIGRATION_FILE}`);
  console.log(`File size:  ${sql.length} bytes`);
  console.log(`Mode:       ${dryRun ? 'DRY-RUN (SQL 출력만)' : 'APPLY (실제 실행)'}`);
  console.log('='.repeat(78));

  if (dryRun) {
    console.log('\n--- SQL (전체) ---\n');
    console.log(sql);
    console.log('\n--- END SQL ---');
    console.log('\nDRY-RUN 완료. 실제 apply: node scripts/apply-109-recurring-expense-atomic.js');
    return;
  }

  const connectionString = resolveConnectionString();
  console.log('\nConnecting…');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  //   Pre-apply safety check · abort if any duplicate exists.
  //   Prevents UNIQUE INDEX creation from failing mid-migration with a
  //   confusing error. Owner audit confirmed 0 duplicates but production
  //   state may have shifted by apply time.
  console.log('\nPre-check · scanning expenses for existing (recurring_id, paid_at) duplicates...');
  const dupCheck = await client.query(`
    select count(*)::int as groups
      from (select count(*) as n from expenses
             where source='recurring' and recurring_id is not null
             group by recurring_id, paid_at
            having count(*) > 1) g
  `);
  const dupGroups = dupCheck.rows[0].groups;
  if (dupGroups > 0) {
    console.error(`\n✗ Pre-check failed: ${dupGroups} duplicate occurrence group(s) exist in production.`);
    console.error('  UNIQUE INDEX creation would fail. Owner must review + dedupe first.');
    console.error('  Aborting apply.');
    await client.end();
    process.exit(2);
  }
  console.log(`  duplicate groups = ${dupGroups} · safe to proceed.`);

  const started = Date.now();
  try {
    console.log('\nExecuting migration…');
    await client.query(sql);
    const ms = Date.now() - started;
    console.log(`\n✓ Migration 109 executed in ${ms}ms`);
  } catch (e) {
    const ms = Date.now() - started;
    console.error(`\n✗ Migration failed after ${ms}ms`);
    console.error(`  code:    ${e.code || 'n/a'}`);
    console.error(`  message: ${e.message}`);
    if (e.hint)   console.error(`  hint:    ${e.hint}`);
    if (e.detail) console.error(`  detail:  ${e.detail}`);
    if (e.where)  console.error(`  where:   ${e.where.slice(0, 500)}`);
    throw e;
  }

  // ── Verify ─────────────────────────────────────────────────────────────
  console.log('\n' + '-'.repeat(78));
  console.log('POST-APPLY VERIFICATION');
  console.log('-'.repeat(78));

  const checks = [
    { name: 'expenses_recurring_occurrence_uniq index 존재 · partial predicate 확인',
      sql: `select indexname, indexdef
              from pg_indexes
             where schemaname='public'
               and tablename='expenses'
               and indexname='expenses_recurring_occurrence_uniq'` },
    { name: 'fire_recurring_expense_atomic RPC 등록 확인',
      sql: `select p.proname, pg_get_function_identity_arguments(p.oid) as args
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname = 'fire_recurring_expense_atomic'` },
    { name: 'RPC permission matrix · anon/authenticated/public denied · service_role allowed',
      sql: `with roles as (select unnest(array['anon','authenticated','service_role','public']) as r)
            select roles.r as role,
                   has_function_privilege(roles.r,
                     'fire_recurring_expense_atomic(integer, date, date, numeric, text, text, text, text, text, integer)',
                     'EXECUTE') as can_execute
              from roles order by roles.r` },
    { name: 'recurring occurrence groups (must remain 0)',
      sql: `select count(*)::int as duplicate_groups
              from (select count(*) as n from expenses
                     where source='recurring' and recurring_id is not null
                     group by recurring_id, paid_at
                    having count(*) > 1) g` },
  ];

  for (const { name, sql: q } of checks) {
    try {
      const r = await client.query(q);
      console.log(`\n  ${name}`);
      if (r.rows.length === 0) console.log('    (0 rows)');
      else r.rows.forEach(row => console.log(`    ${JSON.stringify(row)}`));
    } catch (e) {
      console.log(`\n  ${name}\n    ERR: ${e.message}`);
    }
  }

  await client.end();
  console.log('\n' + '='.repeat(78));
  console.log('Migration 109 완료 · Recurring Expense DB Idempotency (Refactor R1-D1-B)');
  console.log('='.repeat(78));
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
