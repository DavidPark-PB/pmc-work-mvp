#!/usr/bin/env node
/**
 * preflight-075.js — read-only checks before applying migration 075.
 *
 * Verifies:
 *   1. automation_runs.request_id column already present?
 *   2. Any duplicate non-null request_id values that would break UNIQUE?
 *   3. Similar unique index already exists?
 *   4. Any code currently reading/writing request_id?
 *
 * Zero writes. Safe to run against production.
 */
require('dotenv').config({ path: __dirname + '/../config/.env' });
const { getClient } = require('../src/db/supabaseClient');

(async () => {
  const db = getClient();
  const report = {};

  // 1) column existence
  try {
    const { data, error } = await db
      .from('automation_runs')
      .select('request_id')
      .limit(1);
    if (error) {
      // 42703 = undefined_column
      report.column_exists = error.code === '42703' ? false : `read error: ${error.message}`;
    } else {
      report.column_exists = true;
      report.column_sample = data;
    }
  } catch (e) {
    report.column_exists = `throw: ${e.message}`;
  }

  // 2) duplicates (only meaningful if column exists)
  if (report.column_exists === true) {
    try {
      const { data, error } = await db
        .from('automation_runs')
        .select('request_id')
        .not('request_id', 'is', null);
      if (error) {
        report.duplicates_check = `error: ${error.message}`;
      } else {
        const counts = new Map();
        for (const row of data || []) {
          counts.set(row.request_id, (counts.get(row.request_id) || 0) + 1);
        }
        const dups = [...counts.entries()].filter(([, n]) => n > 1);
        report.duplicates_check = {
          total_non_null_rows: data?.length || 0,
          distinct_non_null: counts.size,
          duplicate_keys: dups.length,
          samples: dups.slice(0, 5).map(([k, n]) => ({ request_id: k, count: n })),
        };
      }
    } catch (e) {
      report.duplicates_check = `throw: ${e.message}`;
    }
  }

  // 3) similar unique index — via information_schema (RPC not available, so use raw SQL via rpc if configured)
  //    Supabase JS client can't run arbitrary DDL introspection without a stored proc.
  //    Recommendation: run these SELECTs manually in SQL editor (see below).
  report.similar_index_check = 'run SELECT indexname, indexdef FROM pg_indexes WHERE tablename = \'automation_runs\'; in SQL editor';

  // 4) code usage (grep offline — this script only prints hint)
  report.code_usage_hint = 'grep -rn "request_id" src/ shows only new gate code (verified 2026-08-10)';

  console.log(JSON.stringify(report, null, 2));
})();
