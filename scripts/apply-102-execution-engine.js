#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const F = '102_b2c_execution_engine.sql';
const fp = path.join(__dirname, '../supabase/migrations', F);
const CONN = (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim() ||
  'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';

async function main() {
  const dry = process.argv.includes('--dry-run');
  const sql = fs.readFileSync(fp, 'utf8');
  console.log('='.repeat(78));
  console.log(`Migration: ${F}  ${sql.length}b  ${dry ? 'DRY-RUN' : 'APPLY'}`);
  if (dry) { console.log('\n' + sql); return; }
  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t0 = Date.now();
  try { await c.query(sql); console.log(`✓ ${Date.now()-t0}ms`); }
  catch (e) { console.error('✗', e.message); throw e; }
  for (const { name, sql: q } of [
    { name: 'users.b2c_operator', sql: `select column_name, data_type, column_default from information_schema.columns
        where table_name='users' and column_name='b2c_operator'` },
    { name: 'idx_users_b2c_operator', sql: `select indexname from pg_indexes where indexname='idx_users_b2c_operator'` },
    { name: 'b2c config (3 new · all 0=OFF)', sql: `select setting_key, setting_value from margin_settings
        where setting_key in ('b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled')
        order by setting_key` },
    { name: 'users.b2c_operator=true count', sql: `select count(*)::int as n from users where b2c_operator=true` },
    { name: 'active staff (auto assign target 후보 · b2c_operator 설정 대상)',
      sql: `select id, username, role, is_active from users where role='staff' and is_active=true order by id` },
  ]) {
    const r = await c.query(q);
    console.log(`\n  ${name}`);
    r.rows.forEach(row => console.log(`    ${JSON.stringify(row)}`));
  }
  await c.end();
  console.log('\n' + '='.repeat(78));
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
