#!/usr/bin/env node
'use strict';

/**
 * scripts/oms-physical-identity-recovery-audit.js — Phase 8P-2 CLI.
 *
 * READ-ONLY audit CLI · never writes DB · never repairs mappings · never
 * creates physical_products · never calls marketplace APIs · never sends
 * notifications · never applies migrations · never modifies scheduler.
 *
 * Usage:
 *   node scripts/oms-physical-identity-recovery-audit.js --usd-krw 1350
 *   node scripts/oms-physical-identity-recovery-audit.js --usd-krw 1350 --top-n 50
 *   node scripts/oms-physical-identity-recovery-audit.js --usd-krw 1350 --lookback 90
 */

const { runPhysicalIdentityCoverageRecoveryAudit } = require('../src/services/oms/physicalIdentityCoverageRecoveryAudit');
const { getClient } = require('../src/db/supabaseClient');

function parseArgs(argv) {
  const out = { usdKrw: null, krwJpyRate: null, krwCnyRate: null, topN: 100, lookback: 90, channels: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    if (a === '--usd-krw' && next) { out.usdKrw = Number(next); i++; }
    else if (a === '--krw-jpy' && next) { out.krwJpyRate = Number(next); i++; }
    else if (a === '--krw-cny' && next) { out.krwCnyRate = Number(next); i++; }
    else if (a === '--top-n' && next) { out.topN = Number(next); i++; }
    else if (a === '--lookback' && next) { out.lookback = Number(next); i++; }
    else if (a === '--channels' && next) { out.channels = String(next).split(','); i++; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`
Phase 8P-2 · Physical Identity Coverage Recovery Audit · READ-ONLY

Usage:
  node scripts/oms-physical-identity-recovery-audit.js --usd-krw <rate> [options]

Options:
  --usd-krw <n>     Required. Caller-supplied USD→KRW rate (Phase 2-2C).
  --krw-jpy <n>     Optional. KRW per JPY.
  --krw-cny <n>     Optional. KRW per CNY.
  --top-n <n>       Optional. Top-N unmapped SKUs to classify (default 100).
  --lookback <n>    Optional. Sales lookback days (default 90).
  --channels <list> Optional. Comma-separated (default: shopify,ebay).

Never writes DB / creates physicals / repairs mappings / calls marketplace /
notifies / applies migrations / modifies scheduler. NEVER uses title similarity
as authoritative mapping.
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
  const audit = await runPhysicalIdentityCoverageRecoveryAudit({
    db, fxRates, topN: args.topN, lookbackDays: args.lookback,
    channels: args.channels || undefined,
  });
  //   Brief report · omit full results[] unless top-n small; always include top_recovery_opportunities
  const brief = {
    generated_at: audit.generated_at,
    lookback_days: audit.lookback_days,
    channels: audit.channels,
    physicals_scanned: audit.physicals_scanned,
    total_excluded_sku_master_ids: audit.total_excluded_sku_master_ids,
    analyzed_top_n: audit.analyzed_top_n,
    counts_by_classification: audit.counts_by_classification,
    counts_by_proposed_action: audit.counts_by_proposed_action,
    top_recovery_opportunities: audit.top_recovery_opportunities,
    coverage_leverage_simulation: audit.coverage_leverage_simulation,
    bp_diagnostic: audit.bp_diagnostic,
    query_count: audit.query_count,
    fx_used: audit.fx_used,
    note: audit.note,
  };
  console.log(JSON.stringify(brief, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error('RECOVERY AUDIT FAILED:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
