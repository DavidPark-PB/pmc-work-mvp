#!/usr/bin/env node
/**
 * scripts/oms-inventory-decision.js — Phase 8A · READ-ONLY.
 *
 * Human-readable inventory decision for one physical_product. Consumes
 * strategicHoldService (which itself consumes replacementSupplyCurveService,
 * replacementEvidenceService, channelSalesEvidence). No duplicated math.
 * No writes.
 *
 * Usage:
 *   node scripts/oms-inventory-decision.js --physical-id 1
 *   node scripts/oms-inventory-decision.js --physical-id 1 --json
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { assessInventoryDecision } = require('../src/services/oms/inventoryDecisionEngine');

function parseArgs(argv) {
  const out = { physicalId: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--physical-id') out.physicalId = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/oms-inventory-decision.js --physical-id N [--json]');
      process.exit(0);
    }
  }
  return out;
}

function fmt(n, d = 3) { return n == null ? 'UNKNOWN' : Number(n).toFixed(d); }
function fmtPct(f) { return f == null ? 'UNKNOWN' : (Number(f) * 100).toFixed(1) + '%'; }

function summarise(r) {
  const L = [''];
  L.push('══════════════ Inventory Decision — READ-ONLY (Phase 8A) ══════════════');
  if (r.error) { L.push(`  ✗ ${r.error}`); return L.join('\n'); }
  L.push('');
  L.push('  Physical');
  L.push(`    id / title           : ${r.physical_product_id} · ${r.physical.canonical_title}`);
  L.push(`    set_code / language  : ${r.physical.set_code} / ${r.physical.language} / ${r.physical.unit_type}`);
  L.push('');

  const d = r.decision;
  L.push('  Decision');
  L.push(`    status                            : ${d.status}`);
  L.push(`    confidence                        : ${d.confidence_level}`);
  L.push(`    upstream_hold_status              : ${d.upstream_hold_status ?? 'n/a'}`);
  L.push(`    upstream_supply_verdict           : ${d.upstream_supply_verdict ?? 'n/a'}`);
  L.push(`    strategic_hold_recommended_units  : ${d.strategic_hold_recommended_units == null ? 'null (UNKNOWN · NOT zero · Owner §9)' : d.strategic_hold_recommended_units}`);
  L.push(`    depth_gap (avail - evidenced)     : ${d.depth_gap ?? 'UNKNOWN'}`);
  L.push(`    reason_codes                      : [${d.reason_codes.join(', ')}]`);
  if (d.hold_quantity_blockers.length) L.push(`    hold_quantity_blockers            : [${d.hold_quantity_blockers.join(', ')}]`);
  L.push('');

  const inv = r.inventory_summary;
  L.push('  Inventory');
  L.push(`    on_hand    : ${inv.on_hand}`);
  L.push(`    reserved   : ${inv.reserved}`);
  L.push(`    available  : ${inv.available}`);
  if (inv.invariant) L.push(`    invariant  : ${inv.invariant}`);
  L.push('');

  const dm = r.demand_summary;
  L.push('  Demand (observed · Owner §3 preserved verbatim)');
  L.push(`    trusted                : ${dm.trusted}`);
  L.push(`    units_7d / units_30d   : ${dm.units_7d ?? 'UNKNOWN'} / ${dm.units_30d ?? 'UNKNOWN'}`);
  L.push(`    velocity_7d            : ${fmt(dm.velocity_7d)} phys/day`);
  L.push(`    velocity_30d           : ${fmt(dm.velocity_30d)} phys/day`);
  L.push(`    raw_days_of_supply     : ${dm.raw_days_of_supply == null ? 'UNKNOWN' : dm.raw_days_of_supply + ' days'}`);
  L.push(`    adjusted_velocity      : ${dm.adjusted_velocity ?? 'UNKNOWN (no defensible method)'}`);
  L.push(`    demand_pattern         : ${dm.demand_pattern}`);
  L.push(`    largest_shipment_30d   : ${dm.largest_shipment_units_30d}  (share=${fmtPct(dm.largest_shipment_share_30d)})`);
  L.push(`    total_shipments_30d    : ${dm.total_shipments_30d}`);
  L.push(`    trust_reason           : ${dm.trust_reason ?? 'n/a'}`);
  L.push('');

  const sp = r.supply_summary;
  L.push('  Supply (from replacementSupplyCurveService · single source of truth)');
  L.push(`    verdict                          : ${sp.verdict}`);
  L.push(`    current_supply_layers            : ${sp.current_supply_layers}`);
  L.push(`    current_supply_quality           : ${sp.current_supply_quality}   (ASK ≠ EXECUTABLE)`);
  L.push(`    supplier_diversity               : ${sp.supplier_diversity}`);
  L.push(`    has_current_supplier_or_exec     : ${sp.has_current_supplier_or_executable}`);
  L.push(`    replacement_difficulty           : ${sp.replacement_difficulty}`);
  L.push(`    evidenced_replacement_depth      : ${sp.evidenced_replacement_depth} phys`);
  L.push(`    largest_currently_coverable      : ${sp.largest_currently_coverable_target}`);
  L.push(`    uncovered_at_60 / _at_100        : ${sp.uncovered_at_60 ?? 'n/a'} / ${sp.uncovered_at_100 ?? 'n/a'}`);
  L.push('    coverage:');
  for (const t of [10, 30, 60, 100]) {
    const c = sp.replacement_coverage[t];
    const dep = sp.secondary_market_dependency_by_target?.[t];
    if (c) L.push(`      target=${String(t).padStart(3)}  covered=${c.covered}  uncovered=${c.uncovered}  total_krw=${c.total_krw ?? 'UNKNOWN'}  sec_dep=${dep != null ? fmtPct(dep) : 'n/a'}`);
  }
  if (sp.secondary_market_depth && sp.secondary_market_depth.length) {
    L.push('    secondary_market_depth (per source):');
    for (const m of sp.secondary_market_depth) L.push(`      · ${m.source_name}  listings=${m.observed_listings}  qty=${m.observed_quantity}  min=${m.min_ask} median=${m.median_ask} max=${m.max_ask}`);
  }
  L.push('');

  const cc = r.cost_context;
  L.push('  Cost context (semantic categories · engine does NOT compute automatic ratio)');
  L.push(`    historical_typical_supplier_cost_krw_median : ${cc.historical_typical_supplier_cost_krw_median ?? 'UNKNOWN'}`);
  L.push(`    historical_accounting_cost_krw              : ${cc.historical_accounting_cost_krw ?? 'UNKNOWN'}`);
  L.push(`    observed_secondary_market_ask_min_krw       : ${cc.observed_secondary_market_ask_min_krw ?? 'UNKNOWN'}`);
  L.push(`    note                                        : ${cc.note}`);
  L.push('');

  L.push('  Missing evidence');
  if (!r.missing_evidence.length) L.push('    (none)');
  else for (const m of r.missing_evidence) L.push(`    · ${m}`);
  L.push('');

  L.push('  Recommended human action');
  L.push(`    ${r.recommended_human_action}`);
  L.push('');
  L.push('  Safety: READ-ONLY · zero DB / marketplace / reservation / strategic hold writes.');
  L.push('');
  return L.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.physicalId || args.physicalId <= 0) { console.error('ERROR: --physical-id N required'); process.exit(2); }
  const r = await assessInventoryDecision({ physicalProductId: args.physicalId });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else console.log(summarise(r));
  process.exit(0);
})().catch((err) => {
  console.error('[oms-inventory-decision] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
