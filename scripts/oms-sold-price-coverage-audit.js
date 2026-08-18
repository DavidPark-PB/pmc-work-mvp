#!/usr/bin/env node
'use strict';

/**
 * scripts/oms-sold-price-coverage-audit.js — Phase 8P-1 CLI.
 *
 * READ-ONLY sold-price coverage audit CLI. Prints aggregate summary by
 * default; per-physical diagnostic when --physical-id is supplied.
 *
 * NEVER writes DB, calls marketplace APIs, sends notifications, or
 * modifies scheduler. NEVER changes recentSoldPriceService defaults.
 *
 * Usage:
 *   node scripts/oms-sold-price-coverage-audit.js --usd-krw 1350
 *   node scripts/oms-sold-price-coverage-audit.js --usd-krw 1350 --physical-id 1
 *   node scripts/oms-sold-price-coverage-audit.js --usd-krw 1350 --scan-limit 200
 */

const { runSoldPriceCoverageAudit, diagnosePhysical } = require('../src/services/oms/soldPriceCoverageAudit');
const { getClient } = require('../src/db/supabaseClient');

function parseArgs(argv) {
  const out = { usdKrw: null, krwJpyRate: null, krwCnyRate: null, physicalId: null, scanLimit: 500, channels: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '--usd-krw' && next) { out.usdKrw = Number(next); i++; }
    else if (a === '--krw-jpy' && next) { out.krwJpyRate = Number(next); i++; }
    else if (a === '--krw-cny' && next) { out.krwCnyRate = Number(next); i++; }
    else if (a === '--physical-id' && next) { out.physicalId = Number(next); i++; }
    else if (a === '--scan-limit' && next) { out.scanLimit = Number(next); i++; }
    else if (a === '--channels' && next) { out.channels = String(next).split(','); i++; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`
Phase 8P-1 · Sold-Price Coverage Audit · READ-ONLY

Usage:
  node scripts/oms-sold-price-coverage-audit.js --usd-krw <rate> [options]

Options:
  --usd-krw <n>           Required. Caller-supplied USD→KRW rate (Phase 2-2C).
  --krw-jpy <n>           Optional. KRW per JPY.
  --krw-cny <n>           Optional. KRW per CNY.
  --physical-id <n>       Optional. Per-physical diagnostic (BP=1).
  --scan-limit <n>        Optional. Bound on physicals scanned (default 500).
  --channels <list>       Optional. Comma-separated (default: shopify,ebay).

Never writes DB, calls marketplace APIs, sends notifications, or applies
migrations. NEVER changes recentSoldPriceService.minSamples default.
`);
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

  if (Number.isInteger(args.physicalId) && args.physicalId > 0) {
    const diag = await diagnosePhysical({
      physicalProductId: args.physicalId, db, fxRates,
      channels: args.channels || undefined,
    });
    console.log(JSON.stringify(diag, null, 2));
    return;
  }
  const audit = await runSoldPriceCoverageAudit({
    db, fxRates, physicalScanLimit: args.scanLimit,
    channels: args.channels || undefined,
    usdKrwSource: 'cli:--usd-krw',
  });
  //   Aggregate print · omit per_physical detail unless small enough
  const brief = {
    generated_at: audit.generated_at,
    physical_products_scanned: audit.physical_products_scanned,
    windows_days: audit.windows_days,
    thresholds: audit.thresholds,
    channels: audit.channels,
    fx_used: audit.fx_used,
    coverage: audit.coverage_matrix.coverage,
    policy_simulation: audit.policy_simulation,
    price_stability_summary: {
      windows_compared: audit.price_stability.windows_compared,
      comparable_physicals: audit.price_stability.comparable_physicals,
      materially_different_count: audit.price_stability.materially_different_count,
    },
    identity_exclusions: {
      distinct_excluded_sku_master_ids: audit.identity_exclusions.distinct_excluded_sku_master_ids,
      affected_items_total: audit.identity_exclusions.affected_items_total,
      affected_orders_total: audit.identity_exclusions.affected_orders_total,
      channels: audit.identity_exclusions.channels,
      by_classification: audit.identity_exclusions.by_classification,
      top_excluded_ids: audit.identity_exclusions.top_excluded_ids,
    },
    query_count: audit.query_count,
    note: audit.note,
  };
  console.log(JSON.stringify(brief, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error('AUDIT FAILED:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
