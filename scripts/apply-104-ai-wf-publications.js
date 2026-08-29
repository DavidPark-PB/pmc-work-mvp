#!/usr/bin/env node
/**
 * scripts/apply-104-ai-wf-publications.js — Apply migration 104.
 *
 * Same convention as apply-098-b2c-inventory.js.
 * Additive · idempotent · re-runnable.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '104_ai_workflow_publications.sql';
const fullPath = path.join(__dirname, '../supabase/migrations', MIGRATION_FILE);

function resolveConnectionString() {
  return (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
    'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sql = fs.readFileSync(fullPath, 'utf8');
  console.log('='.repeat(78));
  console.log(`Migration: ${MIGRATION_FILE}`);
  console.log(`Size:      ${sql.length} bytes`);
  console.log(`Mode:      ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log('='.repeat(78));
  if (dryRun) { console.log(sql); return; }

  const client = new Client({ connectionString: resolveConnectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  const t0 = Date.now();
  try {
    await client.query(sql);
    console.log(`\n✓ Migration 104 executed in ${Date.now() - t0}ms`);
    const check = await client.query(`
      select column_name, data_type
        from information_schema.columns
       where table_schema='public' and table_name='ai_workflow_publications'
       order by ordinal_position`);
    console.log('\nai_workflow_publications columns:');
    check.rows.forEach(r => console.log(`  ${r.column_name.padEnd(30)} ${r.data_type}`));
    const idx = await client.query(`
      select indexname from pg_indexes
       where schemaname='public' and tablename='ai_workflow_publications'
       order by indexname`);
    console.log('\nindexes:');
    idx.rows.forEach(r => console.log(`  ${r.indexname}`));
  } catch (e) {
    console.error(`\n✗ Migration failed: ${e.code} ${e.message}`);
    if (e.detail) console.error('  detail:', e.detail);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
