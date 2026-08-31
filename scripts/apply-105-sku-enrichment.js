#!/usr/bin/env node
/**
 * scripts/apply-105-sku-enrichment.js — Apply migration 105 (SKU Enrichment Loop).
 *
 * Owner Directive 2026-08-31 · SKU Enrichment Loop V1.
 *
 * Migration 105 은 완전 additive:
 *   · sku_master ADD COLUMN IF NOT EXISTS (9개 · NULLABLE · 기본값 없음)
 *   · CREATE TABLE IF NOT EXISTS (sku_cost_history · sku_supplier_history)
 *   · CREATE INDEX IF NOT EXISTS
 *   · CREATE OR REPLACE VIEW (v_sku_enrichment_status · 재실행 안전)
 *   · UPDATE ... WHERE ... IS NULL (backfill · 이미 값 있으면 skip)
 *
 * Usage:
 *   node scripts/apply-105-sku-enrichment.js --dry-run   # SQL 전체 출력만
 *   node scripts/apply-105-sku-enrichment.js             # 실제 apply
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '105_sku_enrichment_loop.sql';
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
    console.log('\nDRY-RUN 완료. 실제 apply: node scripts/apply-105-sku-enrichment.js');
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
    console.log(`\n✓ Migration 105 executed in ${ms}ms`);
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

  //   ── Verify ─────────────
  console.log('\n' + '-'.repeat(78));
  console.log('POST-APPLY VERIFICATION');
  console.log('-'.repeat(78));

  const checks = [
    { name: 'sku_master 신규 9개 컬럼',
      sql: `select column_name, data_type, is_nullable
              from information_schema.columns
             where table_schema='public' and table_name='sku_master'
               and column_name in ('weight_source','weight_source_ref','weight_measured_at',
                                   'dims_source','dims_source_ref','dims_measured_at',
                                   'cost_source','cost_source_ref','cost_updated_at')
             order by column_name` },
    { name: 'sku_cost_history 테이블 컬럼',
      sql: `select column_name, data_type
              from information_schema.columns
             where table_schema='public' and table_name='sku_cost_history'
             order by ordinal_position` },
    { name: 'sku_supplier_history 테이블 컬럼',
      sql: `select column_name, data_type
              from information_schema.columns
             where table_schema='public' and table_name='sku_supplier_history'
             order by ordinal_position` },
    { name: 'v_sku_enrichment_status 뷰 확인',
      sql: `select count(*)::int as sku_count,
                   sum(case when has_weight then 1 else 0 end)::int as with_weight,
                   sum(case when has_dims then 1 else 0 end)::int   as with_dims,
                   sum(case when has_cost then 1 else 0 end)::int   as with_cost,
                   sum(case when has_supplier then 1 else 0 end)::int as with_supplier,
                   avg(enrichment_score)::numeric(5,2)              as avg_score
              from v_sku_enrichment_status` },
    { name: 'Backfill · weight_source=legacy_import 카운트',
      sql: `select
              count(*) filter (where weight_source = 'legacy_import') as weight_backfilled,
              count(*) filter (where dims_source = 'legacy_import')   as dims_backfilled,
              count(*) filter (where cost_source = 'legacy_import')   as cost_backfilled
            from sku_master` },
    { name: '인덱스 확인',
      sql: `select indexname from pg_indexes
             where schemaname='public'
               and indexname in ('idx_sku_cost_history_sku_time',
                                 'idx_sku_supplier_history_sku_time',
                                 'idx_sku_supplier_history_supplier')
             order by indexname` },
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
  console.log('Migration 105 완료 · SKU Enrichment Loop V1');
  console.log('='.repeat(78));
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
