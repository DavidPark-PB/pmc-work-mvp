#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const F = '101_b2c_queue_config.sql';
const fullPath = path.join(__dirname, '../supabase/migrations', F);
const CONN = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
  'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sql = fs.readFileSync(fullPath, 'utf8');
  console.log('='.repeat(78));
  console.log(`Migration: ${F}  ${sql.length}b  ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log('='.repeat(78));
  if (dryRun) { console.log('\n' + sql); return; }
  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t0 = Date.now();
  try { await c.query(sql); console.log(`✓ ${Date.now()-t0}ms`); }
  catch (e) { console.error('✗', e.message, e.where?.slice(0,300)); throw e; }
  const checks = [
    { name: 'b2c config keys (5 new)',
      sql: `select setting_key, setting_value from margin_settings where setting_key in
              ('b2c.active_queue_target','b2c.active_queue_refill_threshold','b2c.max_tasks_per_refill',
               'b2c.cost_missing_sales_threshold','b2c.include_p3') order by setting_key` },
    { name: 'data_quality dedup index',
      sql: `select indexname from pg_indexes where tablename='team_tasks'
              and indexname='uq_team_tasks_b2c_data_quality_dedupe'` },
    { name: '기존 dedup index 무변경 확인',
      sql: `select indexname from pg_indexes where tablename='team_tasks'
              and indexname like 'uq_team_tasks_b2c%' order by indexname` },
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
