#!/usr/bin/env node
/**
 * apply-100-stock-age-source.js — Apply migration 100 (view redefine · add stock_age_source column).
 * Idempotent (CREATE OR REPLACE VIEW).
 *
 * Usage:
 *   node scripts/apply-100-stock-age-source.js --dry-run
 *   node scripts/apply-100-stock-age-source.js
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '100_b2c_stock_age_source.sql';
const fullPath = path.join(__dirname, '../supabase/migrations', MIGRATION_FILE);

function resolveConnectionString() {
  return (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
    'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sql = fs.readFileSync(fullPath, 'utf8');
  console.log('='.repeat(78));
  console.log(`Migration: ${MIGRATION_FILE}  ${sql.length}b  ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log('='.repeat(78));
  if (dryRun) { console.log('\n' + sql); return; }

  const c = new Client({ connectionString: resolveConnectionString(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t0 = Date.now();
  try {
    await c.query(sql);
    console.log(`✓ ${Date.now() - t0}ms`);
  } catch (e) { console.error('✗', e.message); throw e; }

  //   verify: new column present · row count unchanged · sample
  const checks = [
    { name: 'view exists', sql: `select viewname from pg_views where schemaname='public' and viewname='v_sku_b2c_scorecard'` },
    { name: 'stock_age_source column present',
      sql: `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='v_sku_b2c_scorecard' and column_name='stock_age_source'` },
    { name: 'row count (2792 expected)',
      sql: `select count(*)::int as n from v_sku_b2c_scorecard` },
    { name: 'stock_age_source 분포',
      sql: `select stock_age_source, count(*)::int as n from v_sku_b2c_scorecard group by stock_age_source order by n desc` },
    { name: '샘플 · sku_id=142',
      sql: `select sku_master_id, stock_qty, inventory_value_krw, stock_age_days, stock_age_source, sales_90d from v_sku_b2c_scorecard where sku_master_id=142` },
  ];
  for (const { name, sql: q } of checks) {
    const r = await c.query(q);
    console.log(`\n  ${name}`);
    r.rows.forEach(row => console.log(`    ${JSON.stringify(row)}`));
  }
  await c.end();
  console.log('\n' + '='.repeat(78));
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
