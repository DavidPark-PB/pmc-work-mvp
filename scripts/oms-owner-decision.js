#!/usr/bin/env node
/**
 * scripts/oms-owner-decision.js — Phase 8E · Owner Decision Console CLI.
 *
 * READ-ONLY only. Never writes. Never mutates inventory / marketplace /
 * mappings / strategic holds. Never sends notifications. No --apply flag.
 *
 * Usage:
 *   node scripts/oms-owner-decision.js --physical-id N
 *   node scripts/oms-owner-decision.js --physical-id N --json
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { buildOwnerDecision } = require('../src/services/oms/inventoryOwnerDecisionService');

function parseArgs(argv) {
  const out = { physicalId: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--physical-id') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isInteger(n) || n <= 0) { console.error('ERROR: --physical-id must be a positive integer'); process.exit(2); }
      out.physicalId = n;
    } else if (a === '--json') { out.json = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/oms-owner-decision.js --physical-id N [--json]');
      console.log('  READ-ONLY. Never writes. Never mutates. No --apply.');
      process.exit(0);
    } else if (a === '--apply') {
      console.error("ERROR: --apply is intentionally NOT supported. This CLI is READ-ONLY Owner Decision Console. Use dedicated owner-approved paths for any operational change.");
      process.exit(2);
    } else {
      console.error(`ERROR: unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function pad(v, width) { const s = v == null ? '?' : String(v); return s + ' '.repeat(Math.max(0, width - s.length)); }
function pct(v) { return v == null ? '?' : (Math.round(v * 1000) / 10) + '%'; }
function krw(v) { return v == null ? '?' : `${Number(v).toLocaleString('en-US')} KRW`; }
// Phase 8F Part 5 · display-only formatter for velocity / days-of-supply.
// UNDERLYING VALUES ARE NEVER CHANGED · only their string representation.
function fmtVelocity(v) {
  if (v == null) return '?';
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  return `${n.toFixed(2)}/day`;
}
function fmtDos(v) {
  if (v == null) return '?';
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  return n.toFixed(2);
}

function summarise(r) {
  const L = [''];
  L.push('══════════════ Owner Inventory Decision ══════════════');
  L.push('');

  if (r.error) {
    L.push(`  Error: ${r.error}`);
    L.push(`  physical#${r.physical_product_id}`);
    L.push('');
    return L.join('\n');
  }

  L.push('  Product');
  L.push(`    ${r.product.title || '(no title)'}`);
  L.push(`    physical#${r.physical_product_id} · ${r.product.set_code ?? '?'} · ${r.product.language ?? '?'}${r.product.unit_type ? ' · ' + r.product.unit_type : ''}`);
  L.push('');

  L.push('  Decision');
  L.push(`    ${r.headline.decision_status}`);
  L.push(`    priority=${r.headline.priority_score}${r.headline.urgency_label ? ' (' + r.headline.urgency_label + ')' : ''}`);
  L.push(`    confidence=${r.headline.confidence_level || '?'}`);
  L.push('');

  L.push('  Why');
  if ((r.reasons.reason_codes || []).length === 0) L.push('    · (no reason codes)');
  for (const c of r.reasons.reason_codes || []) L.push(`    · ${c}`);
  if ((r.reasons.hold_quantity_blockers || []).length > 0) {
    L.push('    hold_quantity_blockers:');
    for (const b of r.reasons.hold_quantity_blockers) L.push(`      · ${b}`);
  }
  if ((r.reasons.missing_evidence || []).length > 0) {
    L.push('    missing_evidence:');
    for (const m of r.reasons.missing_evidence) L.push(`      · ${m}`);
  }
  L.push('');

  L.push('  Inventory');
  L.push(`    on_hand=${pad(r.inventory.on_hand, 6)}reserved=${pad(r.inventory.reserved, 6)}available=${r.inventory.available}`);
  L.push('');

  L.push('  Demand');
  L.push(`    7d=${pad(r.demand.units_7d, 6)} 30d=${pad(r.demand.units_30d, 6)} v30=${pad(fmtVelocity(r.demand.velocity_30d), 12)} dos=${fmtDos(r.demand.raw_days_of_supply)}`);
  L.push(`    pattern=${r.demand.demand_pattern ?? '?'}`);
  if (r.demand.largest_shipment_units_30d != null || r.demand.largest_shipment_share_30d != null) {
    const sh = r.demand.largest_shipment_share_30d != null ? ` (${pct(r.demand.largest_shipment_share_30d)})` : '';
    L.push(`    largest_shipment=${r.demand.largest_shipment_units_30d ?? '?'}${sh}`);
  }
  L.push(`    trusted=${r.demand.trusted}`);
  L.push('');

  L.push('  Supply');
  L.push(`    quality=${r.supply.current_supply_quality ?? '?'}`);
  L.push(`    difficulty=${r.supply.replacement_difficulty ?? '?'}`);
  L.push(`    evidenced_depth=${r.supply.evidenced_replacement_depth ?? '?'} · depth_gap=${r.supply.depth_gap ?? '?'}`);
  L.push(`    uncovered_at_60=${r.supply.uncovered_at_60 ?? '?'} · uncovered_at_100=${r.supply.uncovered_at_100 ?? '?'}`);
  L.push(`    secondary_dependency_60=${pct(r.supply.secondary_market_dependency_at_60)}`);
  L.push(`    has_current_supplier_or_executable=${r.supply.has_current_supplier_or_executable}`);
  L.push(`    supplier_diversity=${r.supply.supplier_diversity ?? '?'}`);
  L.push('');

  L.push('  Cost context (semantics SEPARATED — do NOT combine)');
  L.push(`    typical_supplier_ref = ${krw(r.cost_context.historical_typical_supplier_cost_krw_median)}`);
  L.push(`    accounting_cost      = ${krw(r.cost_context.historical_accounting_cost_krw)}`);
  L.push(`    observed_secondary_ask = ${krw(r.cost_context.observed_secondary_market_ask_min_krw)}`);
  L.push('');

  L.push('  Recommended owner actions');
  if ((r.recommended_actions || []).length === 0) L.push('    (none)');
  r.recommended_actions.forEach((a, i) => {
    L.push(`    ${i + 1}. ${a.code}`);
    L.push(`       ${a.description}`);
    L.push(`       risk=${a.risk_level} · requires_owner_approval=${a.requires_owner_approval} · executable_by_system=${a.executable_by_system}`);
  });
  L.push('');

  L.push('  Automatic actions');
  L.push('    NONE');
  for (const a of r.forbidden_automatic_actions) L.push(`    - forbidden: ${a}`);
  L.push('');
  L.push('  Owner console policy:');
  L.push('    · No auto purchase · No auto strategic hold · No marketplace mutation');
  L.push('    · Recommendations are non-executing — Owner decides');
  L.push('    · UNKNOWN stays UNKNOWN — no invented numbers');
  L.push('');
  return L.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.physicalId) { console.error('ERROR: --physical-id is required'); process.exit(2); }
  const r = await buildOwnerDecision({ physicalProductId: args.physicalId });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else console.log(summarise(r));
  process.exit(r.error ? 1 : 0);
})().catch(err => {
  console.error('[oms-owner-decision] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
