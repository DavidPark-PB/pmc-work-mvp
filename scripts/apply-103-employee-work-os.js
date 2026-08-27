#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const F = '103_b2c_employee_work_os.sql';
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
    { name: 'team_tasks 신규 컬럼 6개', sql: `select column_name, data_type from information_schema.columns
        where table_name='team_tasks'
          and column_name in ('started_at','submitted_at','blocked_reason','blocked_at','qc_fail_reason','qc_resubmit_count')
        order by column_name` },
    { name: 'team_tasks CHECK 2개', sql: `select conname from pg_constraint
        where conrelid='public.team_tasks'::regclass
          and conname in ('chk_team_tasks_blocked_reason','chk_team_tasks_qc_fail_reason')` },
    { name: 'users.b2c_channels', sql: `select column_name, data_type, is_nullable from information_schema.columns
        where table_name='users' and column_name='b2c_channels'` },
    { name: '기존 team_tasks 데이터 무영향', sql: `select
        count(*) as total,
        count(*) filter (where started_at is not null) as started,
        count(*) filter (where submitted_at is not null) as submitted,
        count(*) filter (where blocked_reason is not null) as blocked,
        count(*) filter (where qc_fail_reason is not null) as qc_failed,
        count(*) filter (where qc_resubmit_count > 0) as resubmitted
        from team_tasks` },
    { name: 'users.b2c_channels 분포', sql: `select
        count(*) filter (where b2c_channels is null) as null_count,
        count(*) filter (where b2c_channels is not null) as non_null_count
        from users` },
  ]) {
    const r = await c.query(q);
    console.log(`\n  ${name}`);
    r.rows.forEach(row => console.log(`    ${JSON.stringify(row)}`));
  }
  await c.end();
  console.log('\n' + '='.repeat(78));
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
