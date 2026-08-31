#!/usr/bin/env node
/**
 * scripts/apply-106-sku-enrichment-rpc.js — Apply migration 106.
 *
 * 106 = 105 위에 atomicity RPC 추가 (Owner Directive 2026-09-01).
 *   - update_sku_cost_atomic
 *   - update_sku_supplier_atomic
 * 두 함수는 sku_master + history INSERT/UPDATE 를 하나의 postgres transaction 으로 실행.
 *
 * Migration 106 은 완전 additive:
 *   · CREATE OR REPLACE FUNCTION (재실행 안전)
 *   · 기존 데이터 무손상 · DROP 없음 · destructive 없음
 *
 * Usage:
 *   node scripts/apply-106-sku-enrichment-rpc.js --dry-run
 *   node scripts/apply-106-sku-enrichment-rpc.js
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '106_sku_enrichment_atomic_rpc.sql';
const migrationsDir = path.join(__dirname, '../supabase/migrations');
const fullPath = path.join(migrationsDir, MIGRATION_FILE);

function resolveConnectionString() {
  return (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
    'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
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
    return;
  }

  const connectionString = resolveConnectionString();
  console.log(`\nConnecting…`);
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const started = Date.now();
  try {
    console.log('\nExecuting migration…');
    await client.query(sql);
    const ms = Date.now() - started;
    console.log(`\n✓ Migration 106 executed in ${ms}ms`);
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

  console.log('\n' + '-'.repeat(78));
  console.log('POST-APPLY VERIFICATION');
  console.log('-'.repeat(78));

  const checks = [
    { name: 'update_sku_cost_atomic 함수 존재',
      sql: `select proname, pronargs, proargtypes::regtype[] as arg_types
              from pg_proc where proname = 'update_sku_cost_atomic'` },
    { name: 'update_sku_supplier_atomic 함수 존재',
      sql: `select proname, pronargs, proargtypes::regtype[] as arg_types
              from pg_proc where proname = 'update_sku_supplier_atomic'` },
    { name: 'sku_master row count (변화 없어야 함)',
      sql: `select count(*)::int as n from sku_master` },
    { name: 'sku_cost_history row count (변화 없어야 함)',
      sql: `select count(*)::int as n from sku_cost_history` },
    { name: 'sku_supplier_history row count (변화 없어야 함)',
      sql: `select count(*)::int as n from sku_supplier_history` },
  ];

  for (const { name, sql: q } of checks) {
    try {
      const r = await client.query(q);
      console.log(`\n  ${name}`);
      if (r.rows.length === 0) console.log(`    (0 rows)`);
      else r.rows.forEach(row => console.log(`    ${JSON.stringify(row)}`));
    } catch (e) {
      console.log(`\n  ${name}\n    ERR: ${e.message}`);
    }
  }

  await client.end();
  console.log('\n' + '='.repeat(78));
  console.log('Migration 106 완료 · SKU Enrichment atomic RPC');
  console.log('='.repeat(78));
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
