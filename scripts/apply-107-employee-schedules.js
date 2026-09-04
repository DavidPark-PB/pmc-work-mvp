#!/usr/bin/env node
/**
 * Migration 107 apply · employee_schedules 테이블.
 * Owner Directive 2026-09-04 · Phase 1 (직원 일정 시스템).
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '107_employee_schedules.sql';
const fullPath = path.join(__dirname, '../supabase/migrations', MIGRATION_FILE);

function resolveConnectionString() {
  return (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
    'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(fullPath)) throw new Error(`Migration not found: ${fullPath}`);
  const sql = fs.readFileSync(fullPath, 'utf8');
  console.log('='.repeat(78));
  console.log(`Migration: ${MIGRATION_FILE} · ${sql.length} bytes · ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log('='.repeat(78));
  if (dryRun) { console.log(sql); return; }

  const client = new Client({ connectionString: resolveConnectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log('✓ applied');
    const cols = await client.query(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='employee_schedules' order by ordinal_position`);
    console.log(`employee_schedules columns (${cols.rows.length}):`);
    cols.rows.forEach(r => console.log(`  · ${r.column_name} : ${r.data_type}`));
    const idx = await client.query(`select indexname from pg_indexes where tablename='employee_schedules'`);
    console.log(`indexes: ${idx.rows.map(r=>r.indexname).join(', ')}`);
  } finally { await client.end(); }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
