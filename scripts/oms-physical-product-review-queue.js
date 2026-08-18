#!/usr/bin/env node
'use strict';

/**
 * scripts/oms-physical-product-review-queue.js — Phase 8P-3 CLI.
 *
 * READ-ONLY Owner review queue for PHYSICAL_PRODUCT_MISSING SKUs.
 * NEVER writes DB · NEVER attaches SKUs to physicals · NEVER creates
 * physicals · NEVER calls marketplace · NEVER sends notifications ·
 * NEVER applies migrations · NEVER modifies scheduler.
 *
 * Usage:
 *   node scripts/oms-physical-product-review-queue.js --usd-krw 1350
 *   node scripts/oms-physical-product-review-queue.js --usd-krw 1350 --review-limit 20
 *   node scripts/oms-physical-product-review-queue.js --usd-krw 1350 --json
 */

const { buildPhysicalProductReviewQueue } = require('../src/services/oms/physicalProductReviewQueue');
const { getClient } = require('../src/db/supabaseClient');

function parseArgs(argv) {
  const out = { usdKrw: null, krwJpyRate: null, krwCnyRate: null, topN: 100, lookback: 90, reviewLimit: 20, channels: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '--usd-krw' && next) { out.usdKrw = Number(next); i++; }
    else if (a === '--krw-jpy' && next) { out.krwJpyRate = Number(next); i++; }
    else if (a === '--krw-cny' && next) { out.krwCnyRate = Number(next); i++; }
    else if (a === '--top-n' && next) { out.topN = Number(next); i++; }
    else if (a === '--lookback' && next) { out.lookback = Number(next); i++; }
    else if (a === '--review-limit' && next) { out.reviewLimit = Number(next); i++; }
    else if (a === '--channels' && next) { out.channels = String(next).split(','); i++; }
    else if (a === '--json') { out.json = true; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`
Phase 8P-3 · Physical Product Review Queue · READ-ONLY

Usage:
  node scripts/oms-physical-product-review-queue.js --usd-krw <rate> [options]

Options:
  --usd-krw <n>       Required. Caller-supplied USD→KRW rate (Phase 2-2C).
  --krw-jpy <n>       Optional. KRW per JPY.
  --krw-cny <n>       Optional. KRW per CNY.
  --top-n <n>         Optional. Top-N excluded SKUs analyzed by audit (default 100).
  --lookback <n>      Optional. Sales lookback days (default 90).
  --review-limit <n>  Optional. Cap on top_review_queue rows (default 20).
  --channels <list>   Optional. Comma-separated (default: shopify,ebay).
  --json              Output raw JSON payload (still no PII).

NEVER writes DB · NEVER creates physicals · NEVER attaches SKUs. Owner reviews
the queue, decides via a future canonical writer (not this service).
`);
}

function _brief(v, n = 60) {
  if (v == null) return '';
  const s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function printText(payload) {
  const s = payload.summary;
  const cl = payload.cumulative_leverage;
  console.log('');
  console.log('══════ Phase 8P-3 · Physical Product Review Queue ══════');
  console.log(`generated_at:         ${payload.generated_at}`);
  console.log(`lookback_days:        ${payload.lookback_days}`);
  console.log(`channels:             ${payload.channels.join(', ')}`);
  console.log(`physicals_scanned:    ${payload.physicals_scanned}`);
  console.log('');
  console.log('── SUMMARY ────────────────────────────────────────────');
  console.log(`excluded_skus:                        ${s.excluded_skus}`);
  console.log(`analyzed_top_n:                       ${s.analyzed_top_n}`);
  console.log(`physical_missing_candidates:          ${s.physical_missing_candidates}`);
  console.log(`review_evidence_groups:               ${s.review_groups}  (double-counts SKUs w/ both listing+product evidence)`);
  console.log(`physical_creation_candidates:         ${s.physical_creation_candidates}  ← Owner creation targets (union-find)`);
  console.log(`  · singleton_creation_candidates:    ${s.singleton_creation_candidates}`);
  console.log(`  · multi_sku_creation_candidates:    ${s.multi_sku_creation_candidates}`);
  console.log(`ungrouped_candidates:                 ${s.ungrouped_candidates}`);
  console.log(`completed_sales_represented:          ${s.completed_sales_represented}`);
  console.log(`observations_30d_represented:         ${s.observations_30d_represented}`);
  console.log(`observations_90d_represented:         ${s.observations_90d_represented}`);
  if (payload.evidence_stats) {
    console.log('');
    console.log('── EVIDENCE STATS ─────────────────────────────────────');
    console.log(`unique_sku_master_ids:                ${payload.evidence_stats.unique_sku_master_ids}`);
    console.log(`unique_listing_ids:                   ${payload.evidence_stats.unique_listing_ids}`);
    console.log(`unique_product_ids:                   ${payload.evidence_stats.unique_product_ids}`);
    console.log(`skus_with_listing_evidence:           ${payload.evidence_stats.skus_with_listing_evidence}`);
    console.log(`skus_with_product_evidence:           ${payload.evidence_stats.skus_with_product_evidence}`);
    console.log(`skus_in_both_evidence:                ${payload.evidence_stats.skus_in_both_listing_and_product_evidence}`);
    console.log(`duplicated_sku_across_evidence_grps:  ${payload.evidence_stats.duplicated_sku_count_across_evidence_groups}`);
  }
  console.log('');
  console.log('── CUMULATIVE LEVERAGE ────────────────────────────────');
  for (const t of cl) {
    console.log(`${t.tier.padEnd(8)}  count=${String(t.candidate_count).padStart(4)}  items_covered=${String(t.completed_sale_items_covered).padStart(6)}  pct=${String(t.pct_of_reviewable_completed_sale_items).padStart(6)}%  obs_30d=${t.observations_30d_covered}`);
  }
  console.log('');
  console.log('── BP INVARIANTS ──────────────────────────────────────');
  console.log(`physical#1 exists:                    ${payload.bp_invariants.physical_exists}`);
  console.log(`physical#1 currently_linked:          [${payload.bp_invariants.currently_linked_sku_master_ids.join(', ')}]`);
  console.log(`zero_auto_attachments_this_phase:     ${payload.bp_invariants.zero_auto_attachments}`);
  console.log('');
  console.log(`── TOP REVIEW QUEUE (limit=${payload.top_review_queue.length}) ─────────────────────`);
  for (const item of payload.top_review_queue) {
    const title = (item.review_evidence.find(e => e.field === 'sku_master.title') || {}).value;
    const listings = item.listing_context.listing_ids.slice(0, 2).join(',');
    console.log(`#${String(item.review_rank).padStart(3)}  sku=${item.sku_master_id}  items=${item.completed_sale_items} · 30d_obs=${item.sales_observations_30d} · ch=${item.channels.join('+') || '—'} · listing=${listings || '—'}`);
    console.log(`      title(review-only): ${_brief(title, 80)}`);
    console.log(`      decision_template:  auto_create=false · auto_link=false · owner_decision=null (this phase NEVER writes)`);
  }
  console.log('');
  if (payload.creation_review_plan?.plan) {
    console.log('');
    console.log(`── CREATION REVIEW PLAN (limit=${payload.creation_review_plan.limit} · of ${payload.creation_review_plan.total_candidates_available} candidates) ──`);
    for (const p of payload.creation_review_plan.plan) {
      console.log(`#${String(p.review_rank).padStart(3)} [${p.creation_candidate_id.padEnd(8)}] cohort=${p.sku_master_ids.length} sku · items=${p.completed_sale_items} · 30d_obs=${p.observations_30d}`);
      console.log(`      cohort sku_ids:      [${p.sku_master_ids.join(', ')}]`);
      console.log(`      cohort_bridge:       ${p.cohort_bridge.basis} · ${p.cohort_bridge.value}`);
      console.log(`      listing_ids:         [${p.listing_ids.slice(0, 3).join(', ')}]${p.listing_ids.length > 3 ? ' …' : ''}`);
      console.log(`      product_ids:         [${p.product_ids.slice(0, 3).join(', ')}]${p.product_ids.length > 3 ? ' …' : ''}`);
      console.log(`      title(review-only):  ${_brief(p.title_review_only?.value, 80)}`);
      console.log(`      proposed_decision:   ${p.proposed_decision} · confidence=${p.confidence} · reason=${p.reason}`);
      if (p.franchise_caveat) console.log(`      ⚠ franchise_caveat:  ${p.franchise_caveat}`);
      console.log(`      proposed_display:    ${_brief(p.proposed_display_name, 80)}`);
      console.log(`      write_allowed=false · auto_create=false · auto_link=false · owner_confirmed=false`);
    }
    console.log('');
    console.log('── CANONICAL WRITER INTERFACE ─────────────────────────');
    console.log(`version:             ${payload.canonical_writer_interface.version}`);
    console.log(`execution_allowed:   ${payload.canonical_writer_interface.execution_allowed}`);
    console.log(`operations_supported: ${payload.canonical_writer_interface.operations_supported.join(', ')}`);
  }
  console.log('');
  console.log(`── REVIEW EVIDENCE GROUPS (${payload.review_groups.length}) ─────────────────────────`);
  for (const g of payload.review_groups.slice(0, 20)) {
    console.log(`[${g.group_basis.padEnd(24)}] ${g.review_group_id.padEnd(32)}  skus=${g.sku_master_ids.length} · items=${g.completed_sale_items} · 30d_obs=${g.observations_30d}`);
    console.log(`      Q: ${g.suggested_owner_question}`);
  }
  console.log('');
  console.log(`query_count: ${payload.query_count}`);
  console.log(`note: ${payload.note}`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Number.isFinite(args.usdKrw) || args.usdKrw <= 0) {
    console.error('ERROR: --usd-krw <positive rate> required (Phase 2-2C fail-closed)');
    printHelp();
    process.exit(2);
  }
  const db = getClient();
  const fxRates = { usdKrw: args.usdKrw, krwJpyRate: args.krwJpyRate, krwCnyRate: args.krwCnyRate };
  const payload = await buildPhysicalProductReviewQueue({
    db, fxRates, topN: args.topN, lookbackDays: args.lookback,
    reviewLimit: args.reviewLimit, channels: args.channels || undefined,
  });
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printText(payload);
}

if (require.main === module) {
  main().catch(err => {
    console.error('REVIEW QUEUE FAILED:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
