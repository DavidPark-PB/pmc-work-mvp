#!/usr/bin/env node
/**
 * scripts/apply-099-channel-matrix-dedup.js — Apply migration 099 (view redefine).
 *
 * Migration 099 은 CREATE OR REPLACE VIEW 한 개 뿐 · 완전 idempotent · re-runnable.
 *
 * Usage:
 *   node scripts/apply-099-channel-matrix-dedup.js --dry-run
 *   node scripts/apply-099-channel-matrix-dedup.js
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = '099_b2c_channel_matrix_dedup.sql';
const fullPath = path.join(__dirname, '../supabase/migrations', MIGRATION_FILE);

function resolveConnectionString() {
  return (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim() ||
    'postgresql://postgres.tsqposttkfrvgkyhwade:2r8O74xrWc7bUICJ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sql = fs.readFileSync(fullPath, 'utf8');

  console.log('='.repeat(78));
  console.log(`Migration: ${MIGRATION_FILE}  · ${sql.length} bytes  · ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log('='.repeat(78));

  if (dryRun) {
    console.log('\n' + sql);
    return;
  }

  const client = new Client({ connectionString: resolveConnectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  const started = Date.now();
  try {
    await client.query(sql);
    console.log(`\n✓ Migration 099 executed in ${Date.now() - started}ms`);
  } catch (e) {
    console.error(`\n✗ Migration failed: ${e.code || 'n/a'} · ${e.message}`);
    if (e.where) console.error(`  where: ${e.where.slice(0, 500)}`);
    throw e;
  }

  //   ── Verify dedup 실효 ─────────────────────────────────────
  console.log('\n' + '-'.repeat(78));
  console.log('POST-APPLY VERIFICATION');
  console.log('-'.repeat(78));

  const checks = [
    { name: 'v_sku_channel_matrix 총 rows',
      sql: `select count(*)::int as n from v_sku_channel_matrix` },
    { name: '(sku_master_id, channel) 조합의 unique 여부 · 중복이면 여러 row',
      sql: `select count(*) - count(distinct (sku_master_id, coalesce(channel,''))) as dupe_rows from v_sku_channel_matrix` },
    { name: '다채널 SKU (channel 2개 이상)',
      sql: `select count(*)::int as sku_count, sum(cnt - 1)::int as extra_rows from
              (select sku_master_id, count(*) as cnt from v_sku_channel_matrix group by sku_master_id having count(*) > 1) t` },
    { name: 'v_sku_b2c_scorecard 총 rows (2792 unchanged 기대)',
      sql: `select count(*)::int as n from v_sku_b2c_scorecard` },
    { name: 'live_channels · registered_channels · observed_channels aggregate',
      sql: `select
              sum(live_channels)::int          as sum_live,
              sum(registered_channels)::int    as sum_registered,
              sum(observed_channels)::int      as sum_observed,
              count(*) filter (where live_channels > 0) as skus_with_live
            from v_sku_b2c_scorecard` },
    { name: '샘플: 다채널 SKU dedup 결과 (sku_id=142 · 4채널 예상)',
      sql: `select channel, channel_status, listing_id, selling_price
              from v_sku_channel_matrix where sku_master_id = 142 order by channel` },
  ];

  for (const { name, sql: q } of checks) {
    const r = await client.query(q);
    console.log(`\n  ${name}`);
    r.rows.forEach(row => console.log(`    ${JSON.stringify(row)}`));
  }

  await client.end();
  console.log('\n' + '='.repeat(78));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
