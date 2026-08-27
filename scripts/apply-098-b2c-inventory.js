#!/usr/bin/env node
/**
 * scripts/apply-098-b2c-inventory.js — Apply migration 098 (B2C Inventory Distribution).
 *
 * Owner directive §2 · §23:
 *   기존 프로젝트 convention (scripts/apply-*.js) 을 따른다.
 *   SQL Editor 는 기본 수단이 아니다. Additive · idempotent · re-runnable.
 *
 * Migration 098 은 완전 additive:
 *   · CREATE OR REPLACE VIEW (뷰는 재실행 안전)
 *   · ADD COLUMN IF NOT EXISTS
 *   · CREATE INDEX IF NOT EXISTS
 *   · DO $$ ... EXCEPTION WHEN duplicate_object 로 constraint 재실행 안전
 *   · INSERT ... ON CONFLICT DO NOTHING (config seed)
 *
 * Usage:
 *   node scripts/apply-098-b2c-inventory.js --dry-run   # SQL 전체 출력만
 *   node scripts/apply-098-b2c-inventory.js             # 실제 apply
 *
 * DB 접속: config/.env 의 SUPABASE_DB_URL (또는 DATABASE_URL/POSTGRES_URL)
 *          없으면 프로젝트 표준 pooler URL (scripts/apply-073-unique.js:2 등에서 사용) fallback.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '098_b2c_inventory_distribution.sql';
const migrationsDir = path.join(__dirname, '../supabase/migrations');
const fullPath = path.join(migrationsDir, MIGRATION_FILE);

function resolveConnectionString() {
  return (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
    'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Migration file not found: ${fullPath}`);
  }
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
    console.log('\nDRY-RUN 완료. 실제 apply: node scripts/apply-098-b2c-inventory.js');
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
    console.log(`\n✓ Migration 098 executed in ${ms}ms`);
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

  //   ── Verify (post-apply · 실제 스키마 확인) ─────────────
  console.log('\n' + '-'.repeat(78));
  console.log('POST-APPLY VERIFICATION');
  console.log('-'.repeat(78));

  const checks = [
    { name: 'sku_master.channel_eligibility',
      sql: `select column_name, data_type, is_nullable
              from information_schema.columns
             where table_schema='public' and table_name='sku_master'
               and column_name='channel_eligibility'` },
    { name: 'team_tasks 새 컬럼 9개',
      sql: `select column_name, data_type
              from information_schema.columns
             where table_schema='public' and table_name='team_tasks'
               and column_name in ('priority_level','priority_score','channel',
                 'qc_status','qc_user_id','qc_at','listing_id','listing_url','selling_price')
             order by column_name` },
    { name: 'team_tasks 새 CHECK 제약 2개',
      sql: `select conname from pg_constraint
             where conrelid='public.team_tasks'::regclass
               and conname in ('chk_team_tasks_priority_level','chk_team_tasks_qc_status')` },
    { name: 'team_tasks 새 인덱스 3개',
      sql: `select indexname from pg_indexes
             where tablename='team_tasks'
               and indexname in ('idx_team_tasks_active_priority',
                                 'idx_team_tasks_assignee_active',
                                 'uq_team_tasks_b2c_active_dedupe')
             order by indexname` },
    { name: 'margin_settings b2c.* seed 7개',
      sql: `select setting_key, setting_value from margin_settings
             where category='b2c_inventory' order by setting_key` },
    { name: '뷰 3개 존재 확인',
      sql: `select viewname from pg_views
             where schemaname='public'
               and viewname in ('v_sku_channel_matrix','v_sku_b2c_scorecard','v_staff_b2c_kpi')
             order by viewname` },
    { name: 'v_sku_channel_matrix 샘플 카운트',
      sql: `select count(*)::int as n from v_sku_channel_matrix` },
    { name: 'v_sku_b2c_scorecard 샘플 카운트',
      sql: `select count(*)::int as n from v_sku_b2c_scorecard` },
    { name: 'v_staff_b2c_kpi 샘플 카운트',
      sql: `select count(*)::int as n from v_staff_b2c_kpi` },
    { name: '기존 team_tasks 데이터 미영향 확인 (총 rows · priority=normal · exception_type=SKU_MATCH_FAILED)',
      sql: `select
              count(*) as total,
              count(*) filter (where priority='normal') as priority_normal,
              count(*) filter (where exception_type='SKU_MATCH_FAILED') as legacy_pricing,
              count(*) filter (where priority_level is not null) as new_col_populated
            from team_tasks` },
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
  console.log('Migration 098 완료');
  console.log('='.repeat(78));
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
