#!/usr/bin/env node
'use strict';

/**
 * Hermes Phase 4F — Safe listing enrichment operations wrapper.
 *
 * This script is intentionally conservative:
 * - status/validate are read-only
 * - daily defaults to dry-run
 * - cache writes require --execute
 * - validate uses buildListingIntelligenceReport({ days: 30, save: false })
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const { getClient } = require('../src/db/supabaseClient');
const listingEnrichment = require('../src/services/hermesListingEnrichment');
const listingIntel = require('../src/services/hermesListingIntelligence');

const CACHE_TABLES = [
  'listing_details',
  'listing_images',
  'listing_item_specifics',
  'listing_policies',
  'listing_enrichment_errors',
];

const ENRICHMENT_SENSITIVE_SCORES = [
  'image_count_score',
  'item_specifics_score',
  'shipping_score',
  'return_policy_score',
  'category_score',
];

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function has(flag) { return process.argv.includes(`--${flag}`); }
function intArg(name, fallback) {
  const n = parseInt(arg(name, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function printJson(value) { console.log(JSON.stringify(value, null, 2)); }

function classifyFailure(message) {
  const text = String(message || '').toLowerCase();
  if (/auth|token|credential|unauthori[sz]ed|invalid access|access denied|ebay auth/.test(text)) return 'ebay_auth';
  if (/rate|limit|quota|throttle|too many requests|call limit/.test(text)) return 'ebay_rate_limit';
  if (/api|ack=|getitem|trading|ebay/.test(text)) return 'ebay_api';
  return 'unknown';
}

function distribution(rows, selector) {
  const out = {};
  for (const row of rows || []) {
    const key = String(selector(row));
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
}

async function tableCount(table) {
  const db = getClient();
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) return { ok: false, error: error.message, code: error.code || null };
  return { ok: true, count };
}

async function getStatus() {
  const db = getClient();
  const counts = {};
  for (const table of CACHE_TABLES) counts[table] = await tableCount(table);

  const newest = await db
    .from('listing_details')
    .select('sku,item_id,last_enriched_at')
    .not('last_enriched_at', 'is', null)
    .order('last_enriched_at', { ascending: false })
    .limit(1);

  const oldest = await db
    .from('listing_details')
    .select('sku,item_id,last_enriched_at')
    .not('last_enriched_at', 'is', null)
    .order('last_enriched_at', { ascending: true })
    .limit(1);

  const errors = await db
    .from('listing_enrichment_errors')
    .select('id,sku,item_id,error_message,source_api,created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  return {
    mode: 'status',
    read_only: true,
    generated_at: new Date().toISOString(),
    counts,
    newest_last_enriched_at: newest.error ? { error: newest.error.message } : (newest.data?.[0] || null),
    oldest_last_enriched_at: oldest.error ? { error: oldest.error.message } : (oldest.data?.[0] || null),
    recent_errors: errors.error ? { error: errors.error.message } : (errors.data || []),
    safety: {
      marketplace_writes: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      ai_calls: false,
    },
  };
}

async function runDaily() {
  const limit = intArg('limit', 100);
  const execute = has('execute');
  const dryRun = !execute || has('dry-run');
  const missingOnly = has('all') ? false : true;
  const sku = arg('sku', null);

  if (execute && has('dry-run')) {
    return {
      mode: 'daily',
      dry_run: true,
      executed: false,
      blocked: true,
      reason: 'Refusing to execute because both --execute and --dry-run were provided.',
    };
  }

  if (dryRun) {
    const candidates = await listingEnrichment.getCandidateListings({ limit, sku, missingOnly });
    return {
      mode: 'daily',
      dry_run: true,
      executed: false,
      requested_limit: limit,
      missing_only: missingOnly,
      candidate_count: candidates.length,
      sample: candidates.slice(0, 10).map(r => ({ sku: r.sku, item_id: r.item_id, title: r.title })),
      note: 'Dry-run only: no GetItem calls and no DB writes were performed.',
      safety: {
        marketplace_writes: false,
        price_changes: false,
        inventory_changes: false,
        listing_revisions: false,
        ai_calls: false,
      },
    };
  }

  const startedAt = new Date().toISOString();
  const result = await listingEnrichment.enrichListings({
    limit,
    sku,
    missingOnly,
    stopOnFailure: true,
  });
  const failureTypes = [...new Set((result.errors || []).map(e => classifyFailure(e.error)))];
  return {
    mode: 'daily',
    dry_run: false,
    executed: true,
    requested_limit: limit,
    missing_only: missingOnly,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    requested: result.requested,
    enriched: result.enriched,
    failed: result.failed,
    stopped: Boolean(result.stopped),
    stop_reason: result.stop_reason || null,
    failure_types: failureTypes,
    errors: result.errors || [],
    enriched_item_ids: (result.items || []).map(item => item.itemId),
    items: result.items || [],
    safety: {
      marketplace_writes: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      ai_calls: false,
      writes_limited_to_internal_enrichment_cache: true,
    },
  };
}

async function validate() {
  const { report, rows } = await listingIntel.buildListingIntelligenceReport({ days: 30, save: false });
  const scoreStatusDistribution = {};
  for (const score of ENRICHMENT_SENSITIVE_SCORES) {
    scoreStatusDistribution[score] = distribution(rows, row => row.quality?.scores?.[score]?.status || 'missing');
  }

  return {
    mode: 'validate',
    read_only: true,
    daily_reports_write: false,
    generated_at: new Date().toISOString(),
    total_rows: rows.length,
    enrichedListings: report.data?.summary?.enrichedListings ?? rows.filter(r => !!r.enrichment?.detail).length,
    needs_data_distribution: distribution(rows, row => row.quality?.needsData ?? 'null'),
    enrichment_sensitive_score_status_distribution: scoreStatusDistribution,
    summary: report.data?.summary || null,
    safety: {
      marketplace_writes: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      ai_calls: false,
    },
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'status') return printJson(await getStatus());
  if (command === 'daily') return printJson(await runDaily());
  if (command === 'validate') return printJson(await validate());
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch(error => {
  const failureType = classifyFailure(error.message);
  printJson({
    ok: false,
    error: error.message,
    failure_type: failureType,
    stop: ['ebay_auth', 'ebay_rate_limit', 'ebay_api'].includes(failureType),
    safety: {
      marketplace_writes: false,
      price_changes: false,
      inventory_changes: false,
      listing_revisions: false,
      ai_calls: false,
    },
  });
  process.exit(1);
});
