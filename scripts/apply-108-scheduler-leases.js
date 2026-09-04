#!/usr/bin/env node
/**
 * scripts/apply-108-scheduler-leases.js — Apply migration 108 (Refactor R1-A).
 *
 * Owner Directive 2026-09-04 · Refactor R1-A · Scheduler distributed lease primitive.
 *
 * Migration 108 is fully additive:
 *   · CREATE TABLE IF NOT EXISTS scheduler_leases
 *   · CREATE INDEX IF NOT EXISTS idx_scheduler_leases_expires
 *   · CREATE OR REPLACE FUNCTION acquire_scheduler_lease(...)
 *   · CREATE OR REPLACE FUNCTION heartbeat_scheduler_lease(...)
 *   · CREATE OR REPLACE FUNCTION release_scheduler_lease(...)
 *
 * Zero effect on any existing table. Idempotent · safe to re-run.
 *
 * No scheduler wiring change happens with this migration alone — R1-A ships
 * the primitive; R1-B onward wraps individual jobs one at a time.
 *
 * Usage:
 *   node scripts/apply-108-scheduler-leases.js --dry-run   # print SQL only
 *   node scripts/apply-108-scheduler-leases.js             # apply against DB
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '108_scheduler_leases.sql';
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
    console.log('\nDRY-RUN 완료. 실제 apply: node scripts/apply-108-scheduler-leases.js');
    return;
  }

  const connectionString = resolveConnectionString();
  console.log('\nConnecting…');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const started = Date.now();
  try {
    console.log('\nExecuting migration…');
    await client.query(sql);
    const ms = Date.now() - started;
    console.log(`\n✓ Migration 108 executed in ${ms}ms`);
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
    { name: 'scheduler_leases 테이블 컬럼',
      sql: `select column_name, data_type, is_nullable
              from information_schema.columns
             where table_schema='public' and table_name='scheduler_leases'
             order by ordinal_position` },
    { name: 'PRIMARY KEY (lock_key) 확인',
      sql: `select conname, contype
              from pg_constraint
             where conrelid = 'public.scheduler_leases'::regclass
               and contype  = 'p'` },
    { name: '인덱스 확인',
      sql: `select indexname from pg_indexes
             where schemaname='public'
               and tablename='scheduler_leases'
             order by indexname` },
    { name: 'RPC 3종 등록 확인',
      sql: `select p.proname, pg_get_function_identity_arguments(p.oid) as args
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('acquire_scheduler_lease',
                                 'heartbeat_scheduler_lease',
                                 'release_scheduler_lease')
             order by p.proname` },
    { name: '초기 행 수 (0이어야 정상)',
      sql: `select count(*)::int as row_count from scheduler_leases` },
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
  console.log('Migration 108 완료 · Scheduler Lease Primitive (Refactor R1-A)');
  console.log('='.repeat(78));
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
